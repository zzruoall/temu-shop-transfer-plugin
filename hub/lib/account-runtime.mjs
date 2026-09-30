/**
 * 账户运行器：把持久队列 → 公平选择 → 精确领取 → 专属进程 → 结果结算串成闭环。
 *
 * 对应计划任务 4。它是**唯一**的账户执行入口：路由、定时器、插件轮询都不得
 * 各自签发第二份执行许可，否则同一件商品可能被两条链同时处理。
 *
 * 设计约束（逐条对应审核阻塞项）：
 * - **有界扫描**：按间隔发现就绪账户，不用事件总线也不刷新网页；
 * - **领导代次**：只有持久领导权持有者可以签发许可；数据库不可达即停止新授权；
 * - **精确领取**：领取 dispatcher 选中的那个 workId，绝不改领另一件；
 * - **进程生命周期**：名额由监督器原子登记，退出后才回收；
 * - **回执处理**：worker 的 prepared/failed 经 broker 去重后落到工作终态；
 * - **成功才记账**：失败领取不消耗账户的公平份额。
 */
import { createAccountScheduler } from './account-scheduler.mjs';
import { createAccountDispatcher } from './account-dispatcher.mjs';
import { createAccountWorkRepository, WORK_STATUS } from './account-work-repository.mjs';
import { createAccountProcessSupervisor } from './account-process-supervisor.mjs';
import { createAccountWorkerBroker, createSupervisorLeader, createProcessLeaseRegistry } from './account-worker-broker.mjs';
import { createAccountProcessRecovery, inspectProcess } from './account-process-recovery.mjs';

/** 有界扫描间隔：既不能空转，也不能让新工作等太久。 */
export const DEFAULT_SCAN_INTERVAL_MS = 2000;

export function createAccountRuntime({ database, workerPath, sourceRoot, mode = 'on',
    scanIntervalMs = DEFAULT_SCAN_INTERVAL_MS, maxAccountProcesses = 2, idleExitMs = 30000,
    workerOldSpaceMiB = 128, onTrace = () => {}, onCommit = null, onPrepared = null, onFailure = null, validateWork = null, canStart = null,
    elastic = null, now = () => new Date().toISOString() } = {}) {
    if (!database) throw Object.assign(new Error('账户运行器需要数据库'), { code: 'runtime_missing_db' });
    if (!workerPath) throw Object.assign(new Error('账户运行器需要 worker 入口'), { code: 'runtime_missing_worker' });

    const repo = createAccountWorkRepository(database, { elastic });
    const dispatcher = createAccountDispatcher({ database, scheduler: createAccountScheduler(), requireExecutionContext: true, elastic });
    const leader = createSupervisorLeader({ database, mode });
    const leases = createProcessLeaseRegistry({ database });
    const recoverProcesses = createAccountProcessRecovery({ database, onFailure, validateWork, elastic });
    const supervisor = createAccountProcessSupervisor({
        workerPath, maxAccountProcesses, idleExitMs, workerOldSpaceMiB,
        // 监督器显式声明源根：worker 只接受相对引用，绝对路径由它独立拦截。
        sourceRoot,
        onTrace: (type, fields) => onTrace(type, fields),
        // worker 的业务回执转给运行器结算；监督器自身不解释业务语义。
        onReply: reply => {
            const task = handleWorkerReply(reply).catch(error => onTrace('work:settle-failed', { workId: reply.workId, reason: String(error?.message || error) }));
            pendingReplies.add(task);
            void task.finally(() => pendingReplies.delete(task));
        },
        onExit: event => {
            const task = handleProcessExit(event).catch(error => onTrace('work:exit-settle-failed', { ...event, reason: String(error.message || error) }));
            pendingReplies.add(task);
            void task.finally(() => pendingReplies.delete(task));
        }
    });
    const broker = createAccountWorkerBroker({ database });

    let timer = null;
    let scanning = null;
    let stopped = false;
    // 代次取领取时的不可变绑定，禁止收到旧回复后读取当前代次替旧进程升级授权。
    const bindings = new Map();
    const pendingReplies = new Set();
    const stats = { scans: 0, claimed: 0, spawned: 0, settled: 0, failed: 0, skipped: 0, lastReason: '' };

    /**
     * 由候选推导执行上下文。
     *
     * 只接受持久化的真实轮次；缺轮次的历史行必须分类，不能生成兜底轮次自动重放。
     */
    function candidateContext(candidate, workRow = null) {
        const runId = String(workRow?.run_id || candidate.runId || '').trim();
        return { runId };
    }

    /** 结算一件工作并按终态维护账户槽（终态释放、unknown 保留，均由仓库实现保证）。 */
    async function settle(work, { state, reason = '' }, context) {
        const result = await database.transaction('feedback', async connection => {
            const outcome = await repo.settleInTransaction(connection, {
                workId: work.work_id, state, reason,
                accountId: context.accountId, runId: context.runId, workerEpoch: context.workerEpoch
            });
            if (outcome.settled && !outcome.idempotent && state === WORK_STATUS.failed && onFailure) {
                await onFailure({ connection, work, reason });
            }
            return outcome;
        });
        if (result?.settled) {
            stats.settled += 1;
            onTrace('work:settle', { accountId: context.accountId, workId: work.work_id, state, reason });
        }
        return result;
    }

    /**
     * 处理一个候选：领取它、启动专属进程、等待回执并结算。
     * 返回处理结果；任何一步失败都不推进其他账户的进度（各自独立）。
     */
    async function processCandidate(candidate, context) {
        // 代次取**该账户运行时行里的当前值**：workerEpoch 属于账户，不属于监督器。
        // 之前误用领导代次，被 `stale_epoch` 正确拒绝。
        const runtimeRow = await repo.runtimeOf(candidate.owner);
        const accountEpoch = Number(runtimeRow?.worker_epoch || 0);
        const claim = await repo.claimAccountWork(candidate.owner, {
            workId: candidate.workId,          // 精确领取：必须是被选中的那一件
            storeId: candidate.storeId,
            direction: candidate.direction,
            runId: context.runId,
            workerEpoch: accountEpoch,
            // 动态配额仅限制新fork；已投递工作仍按原槽身份接收回执。
            advanceEpoch: true, supervisorEpoch: leader.epoch(), validateWork,
            maxProcesses: Math.min(maxAccountProcesses, elastic ? elastic.snapshot().processLimit : Infinity),
            processOwnerIdentity: (await inspectProcess(process.pid)).identity || ''
        });
        if (!claim?.claimed) {
            // 候选失效/被占用都属正常竞争，不计失败也不记服务量。
            stats.skipped += 1;
            stats.lastReason = claim?.reason || 'claim_failed';
            onTrace('work:claim-miss', { accountId: candidate.owner, workId: candidate.workId, reason: claim?.reason || '' });
            return { handled: false, reason: claim?.reason || 'claim_failed' };
        }
        stats.claimed += 1;
        const work = claim.work;
        const boundContext = { accountId: candidate.owner, runId: work.run_id, workerEpoch: claim.workerEpoch };
        onTrace('work:start', { accountId: candidate.owner, workId: work.work_id, direction: work.direction });

        // 缺来源证据的工作**不得执行**：没有文件引用就无法证明读的是哪一份数据。
        if (!work.source_ref || !work.source_hash) {
            await leases.markExited({ leaseId: claim.processLeaseId });
            await settle(work, { state: WORK_STATUS.failed, reason: 'missing_source_evidence' },
                boundContext);
            stats.failed += 1;
            return { handled: true, reason: 'missing_source_evidence' };
        }

        let resolveBinding;
        const binding = { ...boundContext, leaseId: claim.processLeaseId, ready: new Promise(resolve => { resolveBinding = resolve; }) };
        bindings.set(work.work_id, binding);
        const spawn = await supervisor.spawnFor(candidate.owner, {
            operation: 'start', workId: work.work_id, messageId: `work:${work.work_id}`,
            processLeaseId: binding.leaseId,
            direction: work.direction, spuId: work.item_spu, storeId: work.store_id,
            sourceRef: work.source_ref, expectedBytes: Number(work.expected_bytes || 0),
            sourceHash: work.source_hash, sourceHashAlgorithm: work.source_hash_algorithm
        });
        if (!spawn?.started) {
            await leases.markExited({ leaseId: claim.processLeaseId });
            bindings.delete(work.work_id);
            resolveBinding(false);
            // 进程名额/退避等资源原因：**不**结算工作，留待下一轮；也不记服务量。
            stats.skipped += 1;
            stats.lastReason = spawn?.reason || 'spawn_failed';
            onTrace('work:spawn-miss', { accountId: candidate.owner, workId: work.work_id, reason: spawn?.reason || '' });
            // 进程起不来时账户槽仍被占着，必须让位，否则该账户永远卡住。
            await repo.checkpointWork(work.work_id, {
                ...boundContext,
                checkpointRef: '', state: WORK_STATUS.waiting,
                nextRunAt: new Date(Date.now() + 5000).toISOString()
            });
            return { handled: false, reason: spawn?.reason || 'spawn_failed' };
        }
        stats.spawned += 1;

        // 进程租约：保存 pid 与启动身份，PID 重用不会被误认作旧 worker。
        binding.epoch = spawn.epoch;
        try { await leases.register({
            leaseId: binding.leaseId, accountId: candidate.owner,
            workerEpoch: boundContext.workerEpoch, supervisorEpoch: leader.epoch(),
            pid: spawn.pid, bootId: (await inspectProcess(spawn.pid)).identity || ''
        }); resolveBinding(true); }
        catch (error) {
            // 租约登记失败会让绑定永久未就绪、正确回执被拒：必须留下原因。
            onTrace('work:lease-failed', { accountId: candidate.owner, workId: work.work_id,
                reason: String(error?.code || error?.message || error) });
            resolveBinding(false);
            await supervisor.requestYield(candidate.owner);
            await settle(work, { state: WORK_STATUS.failed, reason: 'process_lease_failed' }, boundContext);
            bindings.delete(work.work_id);
            throw error;
        }

        return { handled: true, workId: work.work_id, pid: spawn.pid };
    }

    /**
     * 消费子进程回执：上传prepared与入库同事务完成；上架prepared只登记准备结果，等待插件终态。
     * 经 broker 去重，重复回执不会重复结算。
     */
    async function handleWorkerReply({ accountId, workId, epoch, type, result, reason }) {
        const binding = bindings.get(workId);
        /**
         * 必须**等待**绑定就绪，不能"还没就绪就拒绝"。
         *
         * 进程租约登记要访问数据库，而 worker 读完小文件几乎立刻回执；
         * 实测 `started → prepared` 早于 `leases.register` 完成，
         * 于是每个回执都被判 `binding_not_ready`，工作全部结算失败。
         * 等待是有界的（spawnFor 已确认进程启动），因此不会无限挂住。
         */
        const ready = binding ? await binding.ready : false;
        if (!binding || binding.accountId !== accountId || !ready || binding.epoch !== epoch) {
            /**
             * 拒绝回执时必须说明**哪一项**不匹配。
             * 之前一律记 stale_worker_reply，排障时分不清是代次错、账户错还是绑定未就绪。
             */
            const detail = !binding ? 'no_binding'
                : binding.accountId !== accountId ? 'account_mismatch'
                    : !ready ? 'binding_not_ready'
                        : 'epoch_mismatch';
            onTrace('work:reply-rejected', { accountId, workId, detail,
                boundEpoch: binding?.epoch, replyEpoch: epoch, boundAccount: binding?.accountId });
            return { handled: false, reason: 'stale_worker_reply', detail };
        }
        const work = await repo.workOf(workId);
        if (!work) return { handled: false, reason: 'work_not_found' };
        binding.replyReceived = true;
        const action = broker.dispatch({ accountId, workerEpoch: binding.workerEpoch,
            message: { operation: 'settle', messageId: `result:${workId}`, workId, workerEpoch: binding.workerEpoch },
            execute: async () => {
                if (type !== 'prepared') return settle(work, { state: WORK_STATUS.failed, reason: String(reason || 'worker_failed') }, binding);
                if (result?.sourceRead !== true || result.sourceRef !== work.source_ref
                    || result.contentHash !== work.source_hash || Number(result.byteLength) !== Number(work.expected_bytes)) {
                    return settle(work, { state: WORK_STATUS.failed, reason: 'worker_evidence_mismatch' }, binding);
                }
                try {
                    // 上架准备不是平台成功：保留业务占用；弹性模式仅交还准备槽，允许另一店借用余量。
                    if (work.direction === 'publish') {
                        if (!onPrepared) throw Object.assign(Error('account_publish_not_connected'), { code: 'account_publish_not_connected' });
                        const prepared = await database.transaction('control', connection =>
                            onPrepared({ connection, work, result, workerEpoch: binding.workerEpoch }));
                        onTrace('work:prepared', { accountId, workId });
                        return prepared;
                    }
                    // 先在同事务内锁定并验证槽；重复终态不再执行业务，业务失败则整体回滚。
                    const settled = await database.transaction('ingest', async connection => {
                        const outcome = await repo.settleInTransaction(connection, { workId, ...binding, state: WORK_STATUS.done });
                        if (!outcome.settled || outcome.idempotent) return outcome;
                        if (validateWork) await validateWork(connection, work);
                        if (onCommit) await onCommit({ work, result, accountId, connection });
                        return outcome;
                    });
                    if (settled.settled && !settled.idempotent) {
                        stats.settled += 1;
                        onTrace('work:settle', { accountId, workId, state: settled.state });
                    }
                    return settled;
                } catch (error) {
                    return settle(work, { state: WORK_STATUS.failed, reason: `commit_failed:${error?.code || error?.message || error}` }, binding);
                }
            }
        });
        pendingReplies.add(action);
        try { return await action; }
        finally {
            pendingReplies.delete(action);
            // 工作结束即让位，不必空占进程30秒；进程名额仍由 exit 事件确认释放。
            const yielded = await supervisor.requestYield(accountId, { timeoutMs: 2000 });
            if (yielded.yielded) await leases.markExited({ leaseId: binding.leaseId });
            bindings.delete(workId);
        }
    }

    /** 准备阶段崩溃无平台副作用，明确失败并释放槽，不遗留永久running。 */
    async function handleProcessExit({ accountId, epoch, pid }) {
        const entry = [...bindings.entries()].find(([, binding]) => binding.accountId === accountId && binding.epoch === epoch);
        if (entry) {
            const [workId, binding] = entry;
            await binding.ready;
            const work = await repo.workOf(workId);
            if (work?.status === WORK_STATUS.running && !binding.replyReceived) {
                await settle(work, { state: WORK_STATUS.failed, reason: 'worker_exited_without_result' }, binding);
            }
            await leases.markExited({ leaseId: binding.leaseId });
            return;
        }
    }

    /** 一轮有界扫描：发现就绪账户 → 公平选择 → 处理候选。 */
    async function scanNow() {
        if (stopped) return { scanned: false, reason: 'stopped' };
        if (mode !== 'on') return { scanned: false, reason: 'mode_not_on' };
        stats.scans += 1;
        // 领导权：拿不到就不是新授权方，直接退出本轮（数据库不可达也在此抛出）。
        const campaign = await leader.campaign();
        if (!campaign.leader) {
            stats.lastReason = 'not_leader';
            return { scanned: false, reason: 'not_leader' };
        }
        if (!leader.canAuthorize()) {
            stats.lastReason = 'leader_lease_expired';
            return { scanned: false, reason: 'leader_lease_expired' };
        }
        // 恢复只核对旧领导留下的租约，不按时间释放仍可能产生平台副作用的业务槽。
        await recoverProcesses(leader.epoch());
        if (canStart && !await canStart()) return { scanned: false, reason: 'resource_budget_wait' };
        await dispatcher.refreshAccounts();
        const { candidate, reason } = await dispatcher.next();
        if (!candidate) {
            stats.lastReason = reason || 'no_candidates';
            return { scanned: true, handled: false, reason: stats.lastReason };
        }
        /**
         * 轮次必须取**该工作自己的 run_id**，不能传空串。
         *
         * 上一版传 `runId: ''`，领取因"缺少轮次上下文"被拒，任务永远停在 queued
         * ——这正是部署审核指出的"任务不会真正执行"。空 runId 同时意味着
         * 刷新撤销无法与工作绑定，所以修复不是放宽校验，而是把轮次接上。
         */
        const workRow = await repo.workOf(candidate.workId);
        const outcome = await processCandidate(candidate, candidateContext(candidate, workRow));
        // 只有真正取得成功服务才记账（失败领取不消耗公平份额）。
        if (outcome.handled && outcome.reason !== 'missing_source_evidence') {
            dispatcher.recordServed(candidate.owner, 1);
        }
        return { scanned: true, ...outcome };
    }

    /** 定时扫描和HTTP唤醒共用一次在途扫描，不能并发竞选或重复消费公平份额。 */
    function scanOnce() {
        if (!scanning) scanning = scanNow().finally(() => { scanning = null; });
        return scanning;
    }

    function start() {
        if (timer || stopped) return;
        timer = setInterval(() => {
            // 去重由 scanOnce 内部完成（同一时刻只保留一个扫描 promise）。
            scanOnce()
                .catch(error => { stats.lastReason = String(error?.code || error.message || error); });
        }, scanIntervalMs);
        // 不阻塞进程退出：服务关闭时由 stop() 明确清理。
        timer.unref?.();
        onTrace('runtime:start', { mode, scanIntervalMs });
    }

    async function stop() {
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
        await scanning?.catch(() => {});
        await Promise.allSettled([...pendingReplies]);
        await supervisor.stopAll({ timeoutMs: 8000 }).catch(() => {});
        // stopAll会触发最后一批exit回调，数据库关闭前必须等待这些结算退出。
        while (pendingReplies.size) await Promise.allSettled([...pendingReplies]);
        onTrace('runtime:stop', {});
    }

    /** 唤醒一次：供路由在入队后主动推进，避免等待下一个扫描周期。 */
    async function wake() {
        if (stopped) return { scanned: false, reason: 'stopped' };
        return scanOnce();
    }

    return {
        start, stop, wake, scanOnce, handleWorkerReply,
        /** 观测：队列与运行状态，供健康检查与排障。 */
        snapshot: async () => ({
            ...(await repo.snapshot()),
            leader: { epoch: leader.epoch(), canAuthorize: leader.canAuthorize() },
            processes: supervisor.snapshot(),
            stats: { ...stats }
        }),
        stats: () => ({ ...stats }),
        dispatcher, supervisor, repo, leader
    };
}
