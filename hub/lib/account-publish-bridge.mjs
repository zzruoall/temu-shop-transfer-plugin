import { createHash } from 'node:crypto';
import { createAccountWorkRepository } from './account-work-repository.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const terminal = new Set(['done', 'failed', 'cancelled']);
const itemTerminal = new Set(['uploaded', 'failed', 'cancelled', 'blocked', 'skipped']);

/**
 * 发布桥接只接受父端事务连接：job、工作、账户槽与平台许可必须一起提交或一起回滚。
 * 文件暂存允许先落盘，但不会因此产生执行权；只有工作入队事务提交后才参与运行器调度。
 */
export function createAccountPublishBridge({ database, staging, stagingBudget = null, maxUnsettledPublishes = 2, canStart = null, elastic = null } = {}) {
    if (!database || !staging?.stage || !staging?.read) throw fail('publish_bridge_dependencies_missing', 503);
    if (!Number.isInteger(maxUnsettledPublishes) || maxUnsettledPublishes < 1) throw fail('publish_permit_limit_invalid', 503);
    const repo = createAccountWorkRepository(database, { elastic });
    let jobRepository = null;

    /** 队列初始化时绑定同事务投影更新器；server 无须持有或暴露内部 SQL 仓库。 */
    function bindRepository(repository) { jobRepository = repository; }

    /** 与运行器共用首锁，平台许可计数及后续账户/店铺状态转换不允许并发穿透。 */
    async function lockAdmission(connection) {
        if (!connection?.query) throw fail('publish_transaction_required', 503);
        await connection.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
    }

    /** 目标归属必须从当前事务读取，不能相信网页传来的 accountId 或缓存归属。 */
    async function ownershipOn(connection, storeId) {
        const [[row]] = await connection.query("SELECT body FROM hub_map_entries WHERE domain='ownership' AND entry_key=? FOR SHARE", [storeId]);
        const assignment = parse(row?.body);
        if (!assignment?.ownerId || !assignment.claimedAt) throw fail('publish_ownership_unconfirmed', 403);
        return assignment;
    }

    /** 当前插件实例的真实轮次决定新增执行权；旧回执结算不调用此检查，避免撤销后丢失结果。 */
    async function assertRun(connection, binding) {
        const [rows] = await connection.query('SELECT body FROM hub_agents WHERE store_id=?', [binding.storeId]);
        const agent = rows.map(row => parse(row.body)).find(entry => entry.pluginInstanceId === binding.pluginInstanceId);
        const run = agent?.executionRun;
        if (!agent?.identityMatched || !agent.pluginDetected || !run?.active || run.id !== binding.runId
            || run.storeId !== binding.storeId || !(Date.parse(run.expiresAt) > Date.now())
            || (agent.runRevocations || []).some(entry => entry.id === binding.runId)) throw fail('publish_execution_run_inactive');
    }

    /** 一次创建冻结目标账户、操作者、归属代次和轮次；每件快照只通过相对文件引用交给 worker。 */
    async function enqueueJob({ connection, job, access, targetAgent }) {
        if (!job.directCreate) return;
        await lockAdmission(connection);
        const assignment = await ownershipOn(connection, job.targetStoreId);
        const actorId = String(access?.userId || access?.actorId || '');
        // privileged只来自服务端已核验会话；管理员是操作者，资源仍算在目标店认领账户名下。
        if (!actorId || (access?.privileged !== true && actorId !== assignment.ownerId)) throw fail('publish_actor_not_owner', 403);
        const binding = { accountId: assignment.ownerId, actorId, storeId: job.targetStoreId,
            ownershipGeneration: assignment.claimedAt, runId: job.executionRunId, pluginInstanceId: targetAgent?.pluginInstanceId || '' };
        if (!binding.runId || !binding.pluginInstanceId) throw fail('publish_execution_context_missing');
        await assertRun(connection, binding);
        await repo.assertQueueCapacity(connection, assignment.ownerId, job.items.filter(item => item.status === 'queued').length);
        for (const item of job.items) {
            if (item.status !== 'queued') continue;
            if (!item.snapshot) throw fail('publish_snapshot_missing', 422);
            const staged = await staging.stage({ body: item.snapshot, originalName: 'publish-snapshot.json',
                beforeWrite: stagingBudget ? source => stagingBudget.admitSource(connection, binding.accountId, source.sourceRef, source.expectedBytes) : null });
            const work = await repo.enqueueInTransaction(connection, {
                accountId: binding.accountId, actorId, ownershipGeneration: binding.ownershipGeneration,
                storeId: binding.storeId, direction: 'publish', jobId: job.id, spuId: item.spuId,
                runId: binding.runId, executionRunId: binding.runId, ...staged
            });
            item.accountWork = { ...binding, workId: work.work_id, preparedEpoch: null };
        }
    }

    /** 验证工作指向原 job/item；共享 SPU 或换轮次不能把旧工作借给新任务。 */
    async function validateWork(connection, work) {
        if (work.direction !== 'publish' || !work.run_id || work.execution_run_id !== work.run_id) throw fail('publish_work_context_invalid');
        const [[jobRow]] = await connection.query('SELECT body FROM hub_jobs WHERE id=? FOR UPDATE', [work.job_id]);
        const [[itemRow]] = await connection.query('SELECT body FROM hub_job_items WHERE job_id=? AND spu_id=? FOR UPDATE', [work.job_id, work.item_spu]);
        const job = parse(jobRow?.body), item = parse(itemRow?.body), bound = item?.accountWork;
        if (!job?.directCreate || job.status === 'cancelled' || !item || itemTerminal.has(item.status)
            || !bound || bound.workId !== work.work_id || bound.accountId !== work.account_id
            || bound.storeId !== work.store_id || job.targetStoreId !== work.store_id
            || bound.runId !== work.run_id || bound.actorId !== work.actor_id
            || bound.ownershipGeneration !== work.ownership_generation) throw fail('publish_work_revoked');
        const assignment = await ownershipOn(connection, work.store_id);
        if (assignment.ownerId !== work.account_id || assignment.claimedAt !== work.ownership_generation) throw fail('publish_ownership_changed', 403);
        await assertRun(connection, bound);
    }

    /** 只认运行器当前占槽工作及准备代次，数据库当前 epoch 不能替代原 prepared 身份。 */
    async function currentWork(connection, job, item) {
        const binding = item.accountWork;
        if (!binding?.workId || binding.preparedEpoch === null || binding.preparedEpoch === undefined) return null;
        const runtime = await repo.runtimeForWork(connection, binding.accountId, binding.workId);
        if (!runtime || runtime.current_work_id !== binding.workId || runtime.state !== 'running'
            || Number(runtime.worker_epoch) !== Number(binding.preparedEpoch) || runtime.run_id !== binding.runId) return null;
        const [[work]] = await connection.query('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [binding.workId]);
        if (!work || work.status !== 'running' || work.job_id !== job.id || work.item_spu !== item.spuId) return null;
        return work;
    }

    /** claim 仅读取已准备且仍授权的当前工作；失效授权表现为不可领，数据库故障必须向上抛出。 */
    async function canClaim({ connection, job, item }) {
        const work = await currentWork(connection, job, item);
        if (!work) return false;
        try { await validateWork(connection, work); }
        catch (error) { if (error.code?.startsWith('publish_')) return false; throw error; }
        return true;
    }

    /** SQL 领取先精确定位当前工作所属 job，避免旧的前200任务分页遮住真正获得运行器授权的工作。 */
    async function claimJobIds(connection, storeId) {
        // 弹性工作按原槽身份领取，不受同账户下一家店准备代次变化影响。
        const table = elastic ? 'hub_elastic_work_slots' : 'hub_account_runtime';
        const key = elastic ? 'work_id' : 'current_work_id';
        const [rows] = await connection.query(`SELECT DISTINCT w.job_id FROM ${table} r
            JOIN hub_account_work w ON w.work_id=r.${key} AND w.account_id=r.account_id
            WHERE w.store_id=? AND w.direction='publish' AND w.status='running' AND r.state='running'`, [storeId]);
        return rows.map(row => row.job_id);
    }

    /** worker 仅做准备；核对摘要后写小型身份标记，不结算工作、不释放业务槽或平台许可。 */
    async function onPrepared({ connection, work, result, workerEpoch }) {
        if (!result?.sourceRead || result.sourceRef !== work.source_ref || result.contentHash !== work.source_hash
            || Number(result.byteLength) !== Number(work.expected_bytes)) throw fail('publish_source_integrity_mismatch', 422);
        const bytes = await staging.read(work.source_ref);
        if (!bytes || bytes.length !== Number(work.expected_bytes)
            || createHash('sha256').update(bytes).digest('hex') !== work.source_hash) throw fail('publish_source_integrity_mismatch', 422);
        await lockAdmission(connection);
        const runtime = await repo.runtimeForWork(connection, work.account_id, work.work_id);
        if (!runtime || runtime.current_work_id !== work.work_id || runtime.state !== 'running'
            || Number(runtime.worker_epoch) !== Number(workerEpoch) || runtime.run_id !== work.run_id) throw fail('publish_stale_worker');
        await validateWork(connection, work);
        if (!jobRepository) throw fail('publish_queue_not_bound', 503);
        await jobRepository.updateWorkItem(connection, work, (_job, item) => {
            if (item.directAttemptId) throw fail('publish_attempt_already_started');
            item.accountWork.preparedEpoch = Number(workerEpoch);
            item.accountWork.preparedAt = new Date().toISOString();
        });
        await repo.detachPrepared(connection, { accountId: work.account_id, workId: work.work_id, runId: work.run_id, workerEpoch });
        return { prepared: true, keepRunning: true };
    }

    /** 准备失败只更新同一工作绑定的业务项；已有平台尝试不能被 worker 失败错误地释放。 */
    async function onFailure({ connection, work, reason }) {
        if (!jobRepository) throw fail('publish_queue_not_bound', 503);
        await jobRepository.updateWorkItem(connection, work, (_job, item) => {
            if (['creating', 'unknown'].includes(item.directState)) throw fail('publish_platform_result_pending');
            if (itemTerminal.has(item.status)) return;
            item.status = 'failed';
            item.reason = String(reason || 'publish_prepare_failed');
        });
    }

    /**
     * begin 在持久许可总额内签发原 attempt。held 包含超时/unknown，绝不按时间自动释放。
     * limit 可降低本轮预算，但不能突破桥接配置硬上限；平台请求本身仍由插件执行。
     */
    async function begin({ connection, job, item, attemptId, limit = maxUnsettledPublishes, paused = false }) {
        await lockAdmission(connection);
        const work = await currentWork(connection, job, item);
        if (!work) throw fail('publish_work_not_authorized');
        await validateWork(connection, work);
        const [existing] = await connection.query("SELECT * FROM hub_resource_leases WHERE kind='platform' AND work_id=? FOR UPDATE", [work.work_id]);
        if (existing.length) {
            const lease = existing.find(row => row.attempt_id === attemptId);
            if (!lease || lease.state !== 'held' || Number(lease.worker_epoch) !== Number(item.accountWork.preparedEpoch)) throw fail('publish_attempt_mismatch');
            return { granted: true, attemptId, resumed: true };
        }
        // 压力不可读或降载只拦截新attempt，不妨碍原attempt补报和查询。
        if (canStart && !await canStart()) return { granted: false, reason: 'resource_budget_wait' };
        const [[count]] = await connection.query("SELECT COUNT(*) AS n FROM hub_resource_leases WHERE kind='platform' AND state='held'");
        const cap = Math.min(maxUnsettledPublishes, Math.max(0, Number(limit) || 0), elastic ? elastic.snapshot().publishLimit : Infinity);
        if (paused || Number(count.n) >= cap) return { granted: false, reason: 'platform_permit_limit' };
        if (!attemptId) throw fail('publish_attempt_missing');
        const now = new Date().toISOString();
        await connection.query(`INSERT INTO hub_resource_leases
            (lease_id,kind,account_id,work_id,attempt_id,worker_epoch,state,expires_at,created_at,updated_at)
            VALUES(?,'platform',?,?,?,?,'held','',?,?)`,
        [`publish:${work.work_id}:${attemptId}`, work.account_id, work.work_id, attemptId, item.accountWork.preparedEpoch, now, now]);
        return { granted: true, attemptId };
    }

    /**
     * 队列持久化前同步确定结果或管理取消，仍在同一 SQL 事务内。
     * unknown 保留槽和许可；终态须核对原 attempt，旧 epoch 的回执不能释放新工作的资源。
     */
    async function syncJob({ connection, job, previous = null }) {
        for (const item of job.items || []) {
            if (!item.accountWork) continue;
            const before = previous?.items?.find(entry => entry.spuId === item.spuId);
            if (before && before.status === item.status && before.directState === item.directState) continue;
            const state = item.directState === 'unknown' ? 'unknown'
                : item.status === 'cancelled' ? 'cancelled'
                : ['uploaded', 'skipped'].includes(item.status) ? 'done'
                : ['failed', 'blocked'].includes(item.status) ? 'failed' : null;
            if (!state) continue;
            const bound = item.accountWork;
            await lockAdmission(connection);
            const runtime = await repo.runtimeForWork(connection, bound.accountId, bound.workId);
            const [[work]] = await connection.query('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [bound.workId]);
            if (!work || work.job_id !== job.id || work.item_spu !== item.spuId || work.account_id !== bound.accountId
                || work.run_id !== bound.runId) throw fail('publish_work_binding_mismatch');
            const [leases] = await connection.query("SELECT * FROM hub_resource_leases WHERE kind='platform' AND work_id=? FOR UPDATE", [work.work_id]);
            const held = leases.filter(lease => lease.state === 'held');
            if (held.length && (held.length !== 1 || held[0].attempt_id !== item.directAttemptId
                || Number(held[0].worker_epoch) !== Number(bound.preparedEpoch))) throw fail('publish_attempt_mismatch');
            // 删除入口可能同时携带cancelled和旧unknown；管理取消不能借状态优先级抹掉在途凭证。
            if (held.length && item.status === 'cancelled') throw fail('publish_platform_result_pending');
            if ((state === 'unknown' || item.directState === 'created' || item.directState === 'rejected') && !leases.some(lease => lease.attempt_id === item.directAttemptId)) {
                throw fail('publish_permit_missing');
            }
            if (terminal.has(work.status)) {
                if (work.status !== state || held.length) throw fail('publish_terminal_conflict');
                continue;
            }
            if (work.status === 'queued' && ['cancelled', 'failed'].includes(state)) {
                // 未开始工作没有业务槽，只可作废，不允许直接写 done 或伪造运行器上下文。
                await connection.query("UPDATE hub_account_work SET status=?,updated_at=? WHERE work_id=? AND status='queued'",
                    [state, new Date().toISOString(), work.work_id]);
                continue;
            }
            if (!runtime || runtime.current_work_id !== work.work_id) throw fail('publish_work_not_current');
            const epoch = held[0]?.worker_epoch ?? bound.preparedEpoch ?? runtime.worker_epoch;
            if (Number(runtime.worker_epoch) !== Number(epoch) || runtime.run_id !== bound.runId) throw fail('publish_stale_worker');
            if (work.status !== state) {
                const result = await repo.settleInTransaction(connection, { workId: work.work_id, state,
                    reason: item.reason || '', accountId: bound.accountId, runId: bound.runId, workerEpoch: epoch });
                if (!result.settled) throw fail(`publish_settle_${result.reason}`);
            }
            if (terminal.has(state) && held.length) {
                await connection.query("UPDATE hub_resource_leases SET state='released',updated_at=? WHERE lease_id=? AND attempt_id=? AND state='held'",
                    [new Date().toISOString(), held[0].lease_id, item.directAttemptId]);
            }
        }
    }

    return { bindRepository, enqueueJob, validateWork, canClaim, claimJobIds, onPrepared, onFailure, begin, syncJob };
}
