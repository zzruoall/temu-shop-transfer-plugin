/**
 * 账户工作仓库：账户槽、检查点、结算的**事务性**职责。
 *
 * 核心约束（对应方案第 4 节）：
 * - 三种占用分开记账：账户进程名额、账户业务槽、平台未决许可。
 * - 领取遵循统一锁序：资源控制行 → 账户行 → 店铺行 → 任务行。
 * - 获取/释放业务槽、生成幂等授权、状态转换必须同事务完成。
 * - 平台未决许可不按租约到期自动释放：那会把"可能已提交"当成"未提交"。
 *
 * 状态机与身份校验（本版重点，修复复核发现的缺陷）：
 * - 终态（done/failed/cancelled）不可回退：迟到的 checkpoint/结算一律拒绝；
 * - 所有变更都接收可信执行上下文（accountId/runId/workerEpoch），不匹配即拒绝；
 * - 等待中的检查点可由**同一 work** 续接，不必重新抢自己的业务槽；
 * - 幂等键按方向定义业务身份，同键不同输入指纹报冲突，不静默吞并。
 */
import { createHash, randomUUID } from 'node:crypto';
import { reserveElasticSlot } from './elastic-work-slots.mjs';

/** 业务方向。上传与上架共享账户预算；旧模式单槽，弹性模式按工作独立占位。 */
export const DIRECTIONS = Object.freeze({ ingest: 'ingest', publish: 'publish' });

/** 工作状态。终态不可回退；unknown 保留业务占用等待可信回执或人工核对。 */
export const WORK_STATUS = Object.freeze({
    queued: 'queued',
    running: 'running',
    waiting: 'waiting',
    unknown: 'unknown',
    done: 'done',
    cancelled: 'cancelled',
    failed: 'failed'
});

/** 终态：不可再被任何迟到写入改变。 */
const TERMINAL_STATUSES = new Set([WORK_STATUS.done, WORK_STATUS.failed, WORK_STATUS.cancelled]);
/**
 * 允许的转换：只列可达状态，避免 done→unknown 这类矛盾组合。
 * 注意 waiting→running 只属于**续接**（claimAccountWork），不属于结算：
 * 结算若也能做这个转换，就等于绕开 next_run_at 退避把一件 waiting 直接推回执行。
 */
const ALLOWED_TRANSITIONS = new Map([
    [WORK_STATUS.queued, new Set([WORK_STATUS.running, WORK_STATUS.cancelled, WORK_STATUS.failed])],
    [WORK_STATUS.running, new Set([WORK_STATUS.waiting, WORK_STATUS.unknown, WORK_STATUS.done, WORK_STATUS.failed, WORK_STATUS.cancelled])],
    // waiting 可由 checkpoint 产生，之后可续接为 running，或转 unknown/终态。
    [WORK_STATUS.waiting, new Set([WORK_STATUS.running, WORK_STATUS.unknown, WORK_STATUS.failed, WORK_STATUS.cancelled])],
    // unknown 只能由人工核对后转终态（复核/重试走新 work，不复活本行）。
    [WORK_STATUS.unknown, new Set([WORK_STATUS.done, WORK_STATUS.failed, WORK_STATUS.cancelled])],
    [WORK_STATUS.done, new Set()],
    [WORK_STATUS.failed, new Set()],
    [WORK_STATUS.cancelled, new Set()]
]);
/**
 * 结算专属转换表：结算只负责"给一件正在执行的工作下结论"，不负责重新开始。
 * 因此 queued→running、waiting→running 这类**启动型**转换一律不在表内：
 * 续接只能经 claimAccountWork，由它统一校验轮次、代次与 next_run_at 退避。
 */
const SETTLE_TRANSITIONS = new Map([
    [WORK_STATUS.running, new Set([WORK_STATUS.waiting, WORK_STATUS.unknown, WORK_STATUS.done, WORK_STATUS.failed, WORK_STATUS.cancelled])],
    [WORK_STATUS.queued, new Set([WORK_STATUS.cancelled, WORK_STATUS.failed])],
    [WORK_STATUS.waiting, new Set([WORK_STATUS.unknown, WORK_STATUS.failed, WORK_STATUS.cancelled])],
    [WORK_STATUS.unknown, new Set([WORK_STATUS.done, WORK_STATUS.failed, WORK_STATUS.cancelled])]
]);

/**
 * 按方向定义稳定业务身份：这是幂等的基础。
 *
 * 上传常没有 jobId，必须绑定**原上传请求与来源/商品身份**，
 * 否则同一账户同轮次的两个独立上传请求会被误并成一个工作单元。
 * 上架绑定原 job/item/run。
 */
export function businessIdentity({ direction, jobId = '', spuId = '', requestId = '', storeId = '', runId = '' }) {
    if (direction === DIRECTIONS.ingest) {
        // 上传：requestId 是主身份；缺 requestId 时退回"来源店+商品"，但两者都缺则拒绝。
        const key = String(requestId || '');
        if (key) return { kind: 'ingest-request', parts: [key, String(storeId), String(spuId)] };
        if (!storeId || !spuId) throw Object.assign(new Error('上传工作单元缺少 requestId，且来源店/商品不足以识别'), { status: 400 });
        return { kind: 'ingest-item', parts: [String(storeId), String(spuId), String(runId)] };
    }
    // 上架：任务+商品+轮次。
    if (!jobId || !spuId) throw Object.assign(new Error('上架工作单元缺少任务或商品标识'), { status: 400 });
    return { kind: 'publish-item', parts: [String(jobId), String(spuId), String(runId)] };
}

/** 幂等键：定长哈希，避免 utf8mb4 下长字符串联合键超 InnoDB 上限。 */
export function workIdemKey(input) {
    const identity = businessIdentity(input);
    return createHash('sha256').update(JSON.stringify([String(input.accountId), String(input.direction), identity.kind, ...identity.parts])).digest('hex');
}

/** 输入指纹：同幂等键但业务输入不同（例如换了商品正文）时必须报冲突。 */
/**
 * 输入指纹。
 *
 * `sourceHash` 必须参与：只比较 jobId/spuId 无法区分"同一个 ID 换了正文"，
 * 而那正是幂等最需要拦住的情况——同键不同内容应当 409，而不是被当成重复请求合并。
 */
export function workInputFingerprint({ storeId = '', jobId = '', spuId = '', runId = '', requestId = '', sourceHash = '' }) {
    return createHash('sha256').update(JSON.stringify([
        String(storeId), String(jobId), String(spuId), String(runId), String(requestId), String(sourceHash)
    ])).digest('hex');
}

export function workIdOf(input) {
    return `w${workIdemKey(input).slice(0, 32)}`;
}

/**
 * @param {object} database openMysqlDatabase 返回的实例
 */
export function createAccountWorkRepository(database, { elastic = null } = {}) {
    /** 弹性回执查原工作槽，而非账户最新准备进程；旧模式保持原表语义。 */
    async function runtimeForWork(connection, accountId, workId, { lock = true } = {}) {
        const [rows] = elastic
            ? await connection.query(`SELECT *,work_id AS current_work_id FROM hub_elastic_work_slots WHERE account_id=? AND work_id=?${lock ? ' FOR UPDATE' : ''}`, [accountId, workId])
            : await connection.query(`SELECT * FROM hub_account_runtime WHERE account_id=?${lock ? ' FOR UPDATE' : ''}`, [accountId]);
        return rows[0] || null;
    }

    /** 已准备商品把CPU账户槽让出，业务槽及原代次仍持久保留给插件回执。 */
    async function detachPrepared(connection, { accountId, workId, runId, workerEpoch }) {
        if (!elastic) return { detached: false };
        await connection.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
        const slot = await runtimeForWork(connection, accountId, workId);
        const [[work]] = await connection.query('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [workId]);
        if (!slot || slot.run_id !== runId || Number(slot.worker_epoch) !== Number(workerEpoch)
            || slot.state !== 'running' || work?.direction !== 'publish' || work.status !== 'running') throw Error('elastic_prepared_context_mismatch');
        await connection.query("UPDATE hub_account_runtime SET current_work_id='',store_id='',run_id='',state='idle',updated_at=? WHERE account_id=? AND current_work_id=? AND worker_epoch=?",
            [now(), accountId, workId, workerEpoch]);
        return { detached: true };
    }
    const now = () => new Date().toISOString();
    const q = (sql, params = []) => database.query('maintenance', sql, params);

    /** 有界物化窗口由同一数据库锁保护；清单可很大，但不能一次把所有账户的商品展开入队。 */
    async function assertQueueCapacity(connection, accountId, count) {
        await connection.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
        const [[usage]] = await connection.query("SELECT COUNT(*) AS total,COALESCE(SUM(account_id=?),0) AS owned FROM hub_account_work WHERE status IN ('queued','running','waiting','unknown')", [accountId]);
        // 上传单包协议最多1000件，因此账户窗口至少容纳一整包；上架分发仍按50件分片。
        if (Number(usage.total) + count > 2000 || Number(usage.owned) + count > 1000) {
            throw Object.assign(Error('account_queue_capacity_wait'), { status: 429, code: 'account_queue_capacity_wait', retryAfter: 15 });
        }
    }

    /**
     * 入队一个工作单元。
     * - 同一幂等键且输入指纹相同：返回既有行（响应丢失重试）；
     * - 同一幂等键但指纹不同：报 409 冲突，不静默吞并；
     * - 不同业务身份（如不同 requestId）：各自独立的工作单元。
     */
    /**
     * 入队一件工作。
     *
     * 持久上下文（actorId/所有权代次/轮次/来源引用与摘要）随行保存：
     * 撤销与授权复核要靠它们，不能等到执行时再"猜"。
     * sourceHash 参与幂等指纹——只比较 ID 无法区分"同 ID 换了正文"。
     */
    async function enqueue({ accountId, storeId, direction, jobId = '', spuId = '', requestId = '', runId = '',
        nextRunAt = '', actorId = '', ownershipGeneration = '', executionRunId = '',
        sourceRef = '', sourceHash = '', sourceHashAlgorithm = '', expectedBytes = 0 }) {
        const idem = workIdemKey({ accountId, direction, jobId, spuId, requestId, storeId, runId });
        // 摘要进指纹：同键换正文必须报冲突，不能被当成重复请求合并。
        const fingerprint = workInputFingerprint({ storeId, jobId, spuId, runId, requestId, sourceHash });
        const workId = workIdOf({ accountId, direction, jobId, spuId, requestId, storeId, runId });
        const at = now();
        const [[existing]] = await q('SELECT * FROM hub_account_work WHERE idem_key=?', [idem]);
        if (existing) {
            if (existing.input_fingerprint && existing.input_fingerprint !== fingerprint) {
                throw Object.assign(new Error('同一幂等键对应不同业务输入，不能合并'), { status: 409, code: 'work_input_conflict' });
            }
            return existing;
        }
        // INSERT ... ON DUPLICATE KEY UPDATE 只更新 updated_at，不覆盖指纹：
        // 并发场景下两个请求可能都读不到旧行，其中一个插入失败转入 UPDATE。
        // 因此插入后**必须再读一次**并比对指纹——否则同键异内容会被静默合并
        // （复核 N4：两连接屏障下两个请求都 fulfilled，且都返回第一份输入）。
        await q(`INSERT INTO hub_account_work
            (work_id,account_id,store_id,direction,job_id,item_spu,request_id,run_id,idem_key,input_fingerprint,
             actor_id,ownership_generation,execution_run_id,source_ref,source_hash,source_hash_algorithm,expected_bytes,
             status,next_run_at,checkpoint_ref,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)`,
            [workId, accountId, storeId, direction, jobId, spuId, requestId, runId, idem, fingerprint,
                actorId, ownershipGeneration, executionRunId, sourceRef, sourceHash, sourceHashAlgorithm, Number(expectedBytes) || 0,
                WORK_STATUS.queued, nextRunAt, '', at, at]);
        const [[row]] = await q('SELECT * FROM hub_account_work WHERE idem_key=?', [idem]);
        // 获胜记录（无论是本次插入还是并发对手插入）的指纹必须与本请求一致。
        if (row && row.input_fingerprint && row.input_fingerprint !== fingerprint) {
            throw Object.assign(new Error('同一幂等键对应不同业务输入，不能合并'), { status: 409, code: 'work_input_conflict' });
        }
        return row;
    }

    async function runtimeOf(accountId) {
        const [[row]] = await q('SELECT * FROM hub_account_runtime WHERE account_id=?', [accountId]);
        return row || null;
    }

    async function workOf(workId) {
        const [[row]] = await q('SELECT * FROM hub_account_work WHERE work_id=?', [workId]);
        return row || null;
    }

    /** 权限失效作废待执行项；数据库故障仍抛出，不能伪装成用户取消。 */
    async function validateCandidate(conn, work, validateWork) {
        if (!validateWork) return true;
        try { await validateWork(conn, work); return true; }
        catch (error) {
            if (![403, 409].includes(error.status)) throw error;
            await conn.query("UPDATE hub_account_work SET status='cancelled',updated_at=? WHERE work_id=? AND status IN ('queued','waiting')", [now(), work.work_id]);
            await conn.query("UPDATE hub_account_runtime SET state='idle',current_work_id='',run_id='',store_id='' WHERE account_id=? AND current_work_id=? AND state='waiting'", [work.account_id, work.work_id]);
            // 续片前撤权也是明确取消，必须同步回收该工作槽，不能永久吞掉动态名额。
            if (elastic) await conn.query(`DELETE s FROM hub_elastic_work_slots s JOIN hub_account_work w ON w.work_id=s.work_id
                WHERE w.work_id=? AND w.status='cancelled'`, [work.work_id]);
            return false;
        }
    }

    /**
     * 校验执行上下文：调用者必须证明自己就是当前占用该账户槽的那个 worker。
     *
     * 区分两类调用（对应复核要求"不能靠调用方记得传"）：
     * - 受限执行者操作（领取/续接/检查点/结算）：**必须**提供完整上下文
     *   （账户 + 轮次 + 执行代次），缺一即拒绝——省略参数不能绕过校验；
     * - 限权管理操作（如运维强制释放）：单独走 `allowAdmin` 通道，同样要显式声明。
     */
    function assertContext(runtime, { accountId, runId, workerEpoch }, action, { allowAdmin = false } = {}) {
        if (!runtime) throw Object.assign(new Error(`${action} 失败：账户无运行时记录`), { status: 409, code: 'work_no_runtime' });
        if (allowAdmin) return;
        if (!accountId) throw Object.assign(new Error(`${action} 失败：缺少账户上下文`), { status: 403, code: 'work_missing_context' });
        if (!runId) throw Object.assign(new Error(`${action} 失败：缺少轮次上下文`), { status: 403, code: 'work_missing_context' });
        if (workerEpoch === undefined || workerEpoch === null) {
            throw Object.assign(new Error(`${action} 失败：缺少执行代次上下文`), { status: 403, code: 'work_missing_context' });
        }
        if (runtime.account_id !== accountId) {
            throw Object.assign(new Error(`${action} 失败：账户不匹配`), { status: 403, code: 'work_account_mismatch' });
        }
        if (Number(runtime.worker_epoch) !== Number(workerEpoch)) {
            throw Object.assign(new Error(`${action} 失败：执行代次已过期`), { status: 409, code: 'work_stale_epoch' });
        }
        // 运行时的轮次为空表示该账户刚被占用、还没绑定轮次；此时以请求轮次为准。
        if (runtime.run_id && runtime.run_id !== runId) {
            throw Object.assign(new Error(`${action} 失败：轮次不匹配`), { status: 409, code: 'work_run_mismatch' });
        }
    }

    /**
     * 领取账户业务槽并启动一件工作。
     *
     * 三种情形按方案要求分开处理：
     * 1. 账户已有 running/unknown：拒绝并说明原因；
     * 2. 账户有 waiting 且**已到期**的同一 work：续接，不重新抢槽（避免自锁）；
     *    waiting 未到期（退避中）时拒绝，尊重 next_run_at，不能绕过退避；
     * 3. 否则从 queued 里挑一件（next_run_at 到期才可领），并核验请求的轮次与代次。
     */
    async function claimAccountWork(accountId, { direction = '', storeId = '', runId = '', workerEpoch = undefined,
        workId = '', advanceEpoch = false, supervisorEpoch = null, validateWork = null, maxProcesses = null, processOwnerIdentity = '' } = {}) {
        return database.transaction('maintenance', async conn => {
            const cq = (sql, params = []) => conn.query(sql, params);
            // 新授权必须在同事务核对领导权，内存租期判断不能替代持久代次。
            if (supervisorEpoch !== null) {
                const [[control]] = await cq('SELECT * FROM hub_process_control WHERE id=1 FOR UPDATE');
                if (!control || Number(control.supervisor_epoch) !== Number(supervisorEpoch) || control.mode !== 'on'
                    || !(Date.now() - Date.parse(control.heartbeat_at) < 30000)) return { claimed: false, reason: 'stale_supervisor' };
            }
            await cq("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            // 等锁期间预算可能已收缩，必须在持久锁内重新读取，不沿用扫描时的旧额度。
            if (elastic) {
                const budget = elastic.snapshot();
                if (budget.processLimit < 1 || budget.businessLimit < 1) return { claimed: false, reason: 'elastic_capacity_wait' };
                if (maxProcesses !== null) maxProcesses = Math.min(maxProcesses, budget.processLimit);
            }
            if (maxProcesses !== null) {
                const [[count]] = await cq("SELECT COUNT(*) AS n FROM hub_process_leases WHERE state IN ('reserved','live')");
                if (Number(count.n) >= maxProcesses) return { claimed: false, reason: 'global_process_limit' };
            }
            // fork前持久占位，启动失败和OS确认退出才释放，不通过TTL猜测子进程已结束。
            const reserveProcess = async epoch => {
                if (maxProcesses === null) return '';
                const leaseId = `proc:${randomUUID()}`;
                await cq("INSERT INTO hub_process_leases(lease_id,account_id,worker_epoch,supervisor_epoch,pid,boot_id,state,heartbeat_at,created_at,updated_at) VALUES(?,?,?,?,0,?,'reserved',?,?,?)",
                    [leaseId, accountId, epoch, supervisorEpoch, `parent:${process.pid}:${processOwnerIdentity}`, now(), now(), now()]);
                return leaseId;
            };
            await cq(`INSERT INTO hub_account_runtime(account_id,current_work_id,store_id,run_id,state,worker_epoch,worker_lease_until,updated_at)
                VALUES(?, '', '', '', 'idle', 0, '', ?) ON DUPLICATE KEY UPDATE account_id=VALUES(account_id)`, [accountId, now()]);
            const [[runtime]] = await cq('SELECT * FROM hub_account_runtime WHERE account_id=? FOR UPDATE', [accountId]);
            const at = now();

            // 1) 已有占用：running 与 unknown 都表示"这件还没结束"。
            if (runtime?.current_work_id && ['running', 'unknown'].includes(runtime.state)) {
                return { claimed: false, reason: runtime.state === 'unknown' ? 'unknown_pending' : 'account_busy', currentWorkId: runtime.current_work_id };
            }
            // 2) 等待中的同一件可续接：只有该 work 仍属本账户、是 waiting、且已到期才允许。
            if (runtime?.current_work_id && runtime.state === 'waiting') {
                if (workId && runtime.current_work_id !== workId) return { claimed: false, reason: 'candidate_stale' };
                const [[waiting]] = await cq("SELECT * FROM hub_account_work WHERE work_id=? AND status='waiting' AND account_id=? FOR UPDATE",
                    [runtime.current_work_id, accountId]);
                if (waiting) {
                    if (storeId && waiting.store_id !== storeId || direction && waiting.direction !== direction) return { claimed: false, reason: 'candidate_stale' };
                    // 退避中（next_run_at 未到）不得续接：否则重试退避形同虚设。
                    if (waiting.next_run_at && waiting.next_run_at > at) {
                        return { claimed: false, reason: 'not_due', currentWorkId: waiting.work_id, nextRunAt: waiting.next_run_at };
                    }
                    assertContext(runtime, { accountId, runId, workerEpoch }, '续接');
                    if (!await validateCandidate(conn, waiting, validateWork)) return { claimed: false, reason: 'authorization_revoked' };
                    const nextEpoch = Number(workerEpoch) + Number(advanceEpoch);
                    if (elastic) {
                        const [changed] = await cq("UPDATE hub_elastic_work_slots SET worker_epoch=?,state='running',updated_at=? WHERE work_id=? AND account_id=? AND worker_epoch=? AND run_id=?",
                            [nextEpoch, at, waiting.work_id, accountId, workerEpoch, runId]);
                        if (Number(changed.affectedRows) !== 1) throw Error('elastic_resume_slot_missing');
                    }
                    await cq("UPDATE hub_account_work SET status='running',updated_at=? WHERE work_id=?", [at, waiting.work_id]);
                    await cq("UPDATE hub_account_runtime SET state='running',worker_epoch=?,updated_at=? WHERE account_id=?", [nextEpoch, at, accountId]);
                    return { claimed: true, resumed: true, workerEpoch: nextEpoch, processLeaseId: await reserveProcess(nextEpoch), work: { ...waiting, status: WORK_STATUS.running } };
                }
                // waiting 但工作不是 waiting：运行时与工作行的状态已经矛盾。
                // 不能直接清槽——矛盾状态下"槽是空的"这个前提本身不成立，
                // 清掉再挑一件就会让同一账户同时存在两条执行中的工作（复核 P1）。
                // 只允许在明确终态时释放；其余情况停在这里报告，交人工核对。
                const [[current]] = await cq('SELECT status FROM hub_account_work WHERE work_id=? AND account_id=?',
                    [runtime.current_work_id, accountId]);
                if (!current) {
                    // 工作行确实不存在（已被清理）：释放悬挂引用是安全的。
                    await cq("UPDATE hub_account_runtime SET current_work_id='',store_id='',run_id='',state='idle',updated_at=? WHERE account_id=?", [at, accountId]);
                } else if (TERMINAL_STATUSES.has(current.status)) {
                    await cq(`UPDATE hub_account_runtime SET current_work_id='',store_id='',run_id='',state='idle',updated_at=?
                        WHERE account_id=? AND current_work_id=?`, [at, accountId, runtime.current_work_id]);
                } else {
                    return { claimed: false, reason: 'state_conflict', currentWorkId: runtime.current_work_id,
                        workStatus: current.status, runtimeState: runtime.state,
                        detail: '账户槽与工作状态矛盾，已停止领取，需人工核对' };
                }
            }
            // 3) 常规挑选：到期（next_run_at 为空表示立即）且未终态。
            // 上下文在这里同样必填：省略参数不能绕过校验（复核 T1）。
            // 代次校验与账户是否空闲无关——空闲账户的 current_work_id 为空，
            // 用"有空闲才拒绝"的写法会让旧代次恰好绕过（复核 T2）。
            if (!accountId) return { claimed: false, reason: 'missing_context', detail: '缺少账户上下文' };
            if (!runId) return { claimed: false, reason: 'missing_context', detail: '缺少轮次上下文' };
            if (workerEpoch === undefined || workerEpoch === null) return { claimed: false, reason: 'missing_context', detail: '缺少执行代次上下文' };
            if (Number(runtime.worker_epoch) !== Number(workerEpoch)) {
                return { claimed: false, reason: 'stale_epoch', detail: `运行时代次 ${runtime.worker_epoch}，请求代次 ${workerEpoch}` };
            }
            const filters = ["account_id=?", "status='queued'", "(next_run_at='' OR next_run_at<=?)"];
            const params = [accountId, at];
            if (workId) { filters.push('work_id=?'); params.push(workId); }
            if (direction) { filters.push('direction=?'); params.push(direction); }
            if (storeId) { filters.push('store_id=?'); params.push(storeId); }
            const [rows] = await cq(`SELECT * FROM hub_account_work WHERE ${filters.join(' AND ')}
                ORDER BY created_at,work_id LIMIT 1 FOR UPDATE`, params);
            if (!rows.length) return { claimed: false, reason: 'no_work' };
            const work = rows[0];
            // 请求轮次必须与该工作单元一致；不一致说明调用者在操作别人的轮次。
            if (work.run_id && work.run_id !== runId) {
                return { claimed: false, reason: 'run_mismatch', detail: '请求轮次与该工作单元不一致' };
            }
            if (!await validateCandidate(conn, work, validateWork)) return { claimed: false, reason: 'authorization_revoked' };
            const nextEpoch = Number(workerEpoch) + Number(advanceEpoch);
            if (elastic) {
                const reason = await reserveElasticSlot(conn, work, nextEpoch, elastic.snapshot());
                if (reason) return { claimed: false, reason };
            }
            await cq(`UPDATE hub_account_runtime SET current_work_id=?,store_id=?,run_id=?,state='running',worker_epoch=?,updated_at=? WHERE account_id=?`,
                [work.work_id, work.store_id, work.run_id, nextEpoch, at, accountId]);
            await cq("UPDATE hub_account_work SET status='running',updated_at=? WHERE work_id=?", [at, work.work_id]);
            return { claimed: true, resumed: false, workerEpoch: nextEpoch, processLeaseId: await reserveProcess(nextEpoch), work: { ...work, status: WORK_STATUS.running } };
        });
    }

    /**
     * 保存检查点：把 current 置 waiting，允许同一 work 之后续接。
     *
     * 拒绝语义（用返回值表达，不抛异常，便于调用方统一处理"这次写入未被接受"）：
     * - 终态工作：返回 { changed:false, reason:'terminal_immutable' }，绝不回退；
     * - 目标状态不是 waiting：返回 { changed:false, reason:'bad_state' }；
     * - 身份不匹配（旧 epoch/旧 run/别的账户）：返回 { changed:false, reason:'stale_context' }。
     * 只有确实写入时才 changed:true。
     */
    async function checkpointWork(workId, { accountId = '', runId = '', workerEpoch = undefined, checkpointRef = '', state = WORK_STATUS.waiting, nextRunAt = '' } = {}) {
        if (state !== WORK_STATUS.waiting) return { changed: false, reason: 'bad_state' };
        return database.transaction('maintenance', async conn => {
            const cq = (sql, params = []) => conn.query(sql, params);
            // 统一锁序：资源控制行 → 账户行 → 工作行。
            // 先无锁定位账户，再按同一顺序加锁；与领取/续接一致，避免与结算交叉时死锁（复核 T5）。
            await cq("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            const [[located]] = await cq('SELECT account_id FROM hub_account_work WHERE work_id=?', [workId]);
            if (!located) return { changed: false, reason: 'work_not_found' };
            const runtime = await runtimeForWork(conn, located.account_id, workId);
            const [[work]] = await cq('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [workId]);
            if (!work) return { changed: false, reason: 'work_not_found' };
            // 终态不可回退：迟到的检查点只能被拒绝。
            // 拒绝时回传当前持久化值，调用方据此确认"没有被改写"。
            if (TERMINAL_STATUSES.has(work.status)) {
                return { changed: false, reason: 'terminal_immutable', status: work.status, checkpoint_ref: work.checkpoint_ref };
            }
            if (!ALLOWED_TRANSITIONS.get(work.status)?.has(WORK_STATUS.waiting)) {
                return { changed: false, reason: 'bad_transition', status: work.status, checkpoint_ref: work.checkpoint_ref };
            }
            try {
                assertContext(runtime, { accountId, runId, workerEpoch }, '保存检查点');
            } catch (error) {
                return { changed: false, reason: 'stale_context', detail: error.code || error.message,
                    status: work.status, checkpoint_ref: work.checkpoint_ref };
            }
            if (runtime.current_work_id !== workId) {
                return { changed: false, reason: 'work_not_current', status: work.status, checkpoint_ref: work.checkpoint_ref };
            }
            // 已准备并交给插件的工作不可再回到CPU续片队列，否则会把一次投递重新准备。
            if (elastic) {
                const [[preparation]] = await cq('SELECT current_work_id FROM hub_account_runtime WHERE account_id=? FOR UPDATE', [accountId]);
                if (preparation?.current_work_id !== workId) return { changed: false, reason: 'preparation_already_detached' };
            }
            await cq('UPDATE hub_account_work SET checkpoint_ref=?,status=?,next_run_at=?,updated_at=? WHERE work_id=?',
                [checkpointRef, WORK_STATUS.waiting, nextRunAt, now(), workId]);
            await cq("UPDATE hub_account_runtime SET state='waiting',updated_at=? WHERE account_id=? AND current_work_id=?", [now(), work.account_id, workId]);
            if (elastic) await cq("UPDATE hub_elastic_work_slots SET state='waiting',updated_at=? WHERE work_id=?", [now(), workId]);
            const [[row]] = await cq('SELECT * FROM hub_account_work WHERE work_id=?', [workId]);
            return { changed: true, work: row };
        });
    }

    /**
     * 结算一件工作。
     * - 终态幂等：已终态再结算返回原状态，不改写；
     * - 终态不可回退：done 不能变成 unknown；
     * - **必须是被结算的那一件**：旧模式核对账户runtime，弹性模式核对原工作槽，
     *   不能借用同账户后来工作的代次，也不能把queued直接当作已执行；
     * - unknown 保留业务占用（可能已在平台建成商品）；
     * - 身份不匹配拒绝。
     */
    async function settleWork(workId, { state, reason = '', accountId = '', runId = '', workerEpoch = undefined } = {}) {
        if (elastic) return database.transaction('maintenance', conn => settleInTransaction(conn, { workId, state, reason, accountId, runId, workerEpoch }));
        if (!Object.values(WORK_STATUS).includes(state)) {
            throw Object.assign(new Error(`未知的结算状态 ${state}`), { status: 400, code: 'work_bad_state' });
        }
        return database.transaction('maintenance', async conn => {
            const cq = (sql, params = []) => conn.query(sql, params);
            // 统一锁序：资源控制行 → 账户行 → 工作行（与领取/续接一致）。
            await cq("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            const [[located]] = await cq('SELECT account_id FROM hub_account_work WHERE work_id=?', [workId]);
            if (!located) return { settled: false, reason: 'work_not_found' };
            const [[runtime]] = await cq('SELECT * FROM hub_account_runtime WHERE account_id=? FOR UPDATE', [located.account_id]);
            const [[work]] = await cq('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [workId]);
            if (!work) return { settled: false, reason: 'work_not_found' };
            // 终态幂等且不可回退：这一条必须先于下面的状态校验。
            // 已终态的工作重放任何结算（含 running）都要得到原状态，重试路径依赖这个幂等性。
            if (TERMINAL_STATUSES.has(work.status)) {
                return { settled: true, released: false, state: work.status, idempotent: true, reason: 'terminal_immutable' };
            }
            // 结算不是启动入口：running 属于续接语义，只能经 claimAccountWork（含 next_run_at 退避校验）。
            // 用独立的结算转换表，而不是复用通用表——否则 waiting→running 会把退避中的工作直接推回执行。
            if (state === WORK_STATUS.running) {
                throw Object.assign(new Error('结算不能把工作置为 running，续接必须经领取入口'),
                    { status: 409, code: 'work_settle_cannot_start' });
            }
            // 只能结算"当前正被占用"的那一件：结算不是启动另一件工作的入口。
            if (!runtime || runtime.current_work_id !== workId) {
                return { settled: false, reason: 'work_not_current', detail: '该工作不是账户当前占用，不能结算' };
            }
            if (!SETTLE_TRANSITIONS.get(work.status)?.has(state)) {
                throw Object.assign(new Error(`不允许从 ${work.status} 结算为 ${state}`), { status: 409, code: 'work_bad_transition' });
            }
            assertContext(runtime, { accountId, runId, workerEpoch }, '结算');
            const at = now();
            // 工作状态与账户状态必须同事务一起变：work=running 而 runtime=waiting 这种矛盾
            // 会让下一次领取以为槽已释放，从而再领一件，同账户出现两条 running（复核 P1）。
            const nextRuntimeState = state === WORK_STATUS.unknown ? 'unknown'
                : (state === WORK_STATUS.waiting ? 'waiting' : '');
            const [updateResult] = await cq('UPDATE hub_account_work SET status=?,updated_at=? WHERE work_id=? AND account_id=? AND status=?',
                [state, at, workId, work.account_id, work.status]);
            if (Number(updateResult.affectedRows) !== 1) {
                // 条件 UPDATE 没命中说明期间状态已被改动：不能当成结算成功。
                return { settled: false, reason: 'concurrent_change', detail: `结算前的状态 ${work.status} 已变化` };
            }
            if (TERMINAL_STATUSES.has(state)) {
                await cq(`UPDATE hub_account_runtime SET current_work_id='',store_id='',run_id='',state='idle',updated_at=?
                    WHERE account_id=? AND current_work_id=?`, [at, work.account_id, workId]);
            } else {
                await cq("UPDATE hub_account_runtime SET state=?,updated_at=? WHERE account_id=? AND current_work_id=?",
                    [nextRuntimeState, at, work.account_id, workId]);
            }
            return { settled: true, released: TERMINAL_STATUSES.has(state), state, reason };
        });
    }

    /**
     * 登记平台未决许可。幂等：已释放的许可不会被重放重新占用；
     * 同一 lease_id 属于不同账户/工作/尝试时报冲突。
     */
    async function holdPlatformLease({ leaseId, accountId, workId, attemptId, workerEpoch = 0, ttlMs = 10 * 60 * 1000 }) {
        const at = now();
        const [[existing]] = await q('SELECT * FROM hub_resource_leases WHERE lease_id=?', [leaseId]);
        if (existing) {
            const sameOwner = existing.account_id === String(accountId) && existing.work_id === String(workId) && existing.attempt_id === String(attemptId);
            if (!sameOwner) throw Object.assign(new Error('许可编号已绑定其他账户或尝试'), { status: 409, code: 'lease_identity_conflict' });
            // 已释放/已核对：返回原状态，不重新占用——重放不能让旧许可复活。
            if (existing.state !== 'held') return existing;
            await q('UPDATE hub_resource_leases SET expires_at=?,updated_at=? WHERE lease_id=?', [new Date(Date.now() + ttlMs).toISOString(), at, leaseId]);
            const [[row]] = await q('SELECT * FROM hub_resource_leases WHERE lease_id=?', [leaseId]);
            return row;
        }
        await q(`INSERT INTO hub_resource_leases(lease_id,kind,account_id,work_id,attempt_id,worker_epoch,state,expires_at,created_at,updated_at)
            VALUES(?,'platform',?,?,?,?,'held',?,?,?)`,
            [leaseId, accountId, workId, attemptId, workerEpoch, new Date(Date.now() + ttlMs).toISOString(), at, at]);
        const [[row]] = await q('SELECT * FROM hub_resource_leases WHERE lease_id=?', [leaseId]);
        return row;
    }

    /** 只有在收到可信终态时才释放平台许可；超时不释放。 */
    async function releasePlatformLease(leaseId, { state = 'released' } = {}) {
        if (!['released', 'confirmed'].includes(state)) {
            throw Object.assign(new Error(`不允许的许可释放状态 ${state}`), { status: 400, code: 'lease_bad_state' });
        }
        await q("UPDATE hub_resource_leases SET state=?,updated_at=? WHERE lease_id=? AND kind='platform' AND state='held'", [state, now(), leaseId]);
        const [[row]] = await q('SELECT * FROM hub_resource_leases WHERE lease_id=?', [leaseId]);
        return row || null;
    }

    async function pendingPlatformLeases() {
        const [[row]] = await q("SELECT COUNT(*) AS n FROM hub_resource_leases WHERE kind='platform' AND state='held'");
        return Number(row.n);
    }

    /** 诊断与对账：账户维度的当前占用概览。 */
    async function snapshot(limit = 50) {
        const [runtimes] = await q(`SELECT account_id,current_work_id,store_id,state,worker_epoch,updated_at
            FROM hub_account_runtime ORDER BY updated_at DESC LIMIT ?`, [limit]);
        const [[counts]] = await q(`SELECT
            SUM(status='queued') AS queued, SUM(status='running') AS running,
            SUM(status='waiting') AS waiting, SUM(status='unknown') AS unknown, SUM(status='done') AS done
            FROM hub_account_work`);
        return { runtimes, work: {
            queued: Number(counts.queued || 0), running: Number(counts.running || 0),
            waiting: Number(counts.waiting || 0), unknown: Number(counts.unknown || 0), done: Number(counts.done || 0)
        }, pendingPlatform: await pendingPlatformLeases() };
    }

    /**
     * 供**上层事务复用连接**的内部操作（计划任务2）。
     *
     * 为什么必须存在：顶层用 `database.transaction` 开一次事务，回调内若再调用
     * `enqueue()` 这类顶层方法，它会走连接池另开一条连接与事务——那样
     * "业务权威结果 + 工作索引 + 账户槽"就不再是同一事务，任一点失败会留下半边成功。
     *
     * 这里的实现接受调用方传入的 conn，**不**自己开事务。
     * 身份与状态机校验与顶层一致，避免"内部接口"成为绕过保护的旁路。
     */
    async function enqueueInTransaction(conn, input) {
        if (!conn?.query) throw Object.assign(new Error('enqueueInTransaction 需要事务连接'), { code: 'work_missing_conn' });
        const { accountId, storeId, direction, jobId = '', spuId = '', requestId = '', runId = '',
            nextRunAt = '', actorId = '', ownershipGeneration = '', executionRunId = '',
            sourceRef = '', sourceHash = '', sourceHashAlgorithm = '', expectedBytes = 0 } = input || {};
        if (!accountId || !storeId || !direction) {
            throw Object.assign(new Error('入队缺少账户/店铺/方向'), { status: 400, code: 'work_missing_context' });
        }
        const idem = workIdemKey({ accountId, direction, jobId, spuId, requestId, storeId, runId });
        const fingerprint = workInputFingerprint({ storeId, jobId, spuId, runId, requestId, sourceHash });
        const workId = workIdOf({ accountId, direction, jobId, spuId, requestId, storeId, runId });
        const at = now();
        const [[existing]] = await conn.query('SELECT * FROM hub_account_work WHERE idem_key=?', [idem]);
        if (existing) {
            // 同键异内容必须报冲突：不能因为"键相同"就静默合并不同正文。
            if (existing.input_fingerprint && existing.input_fingerprint !== fingerprint) {
                throw Object.assign(new Error('同一幂等键对应不同业务输入，不能合并'), { status: 409, code: 'work_input_conflict' });
            }
            return existing;
        }
        await conn.query(`INSERT INTO hub_account_work
            (work_id,account_id,store_id,direction,job_id,item_spu,request_id,run_id,idem_key,input_fingerprint,
             actor_id,ownership_generation,execution_run_id,source_ref,source_hash,source_hash_algorithm,expected_bytes,
             status,next_run_at,checkpoint_ref,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at)`,
            [workId, accountId, storeId, direction, jobId, spuId, requestId, runId, idem, fingerprint,
                actorId, ownershipGeneration, executionRunId, sourceRef, sourceHash, sourceHashAlgorithm, Number(expectedBytes) || 0,
                WORK_STATUS.queued, nextRunAt, '', at, at]);
        const [[row]] = await conn.query('SELECT * FROM hub_account_work WHERE idem_key=?', [idem]);
        if (row && row.input_fingerprint && row.input_fingerprint !== fingerprint) {
            throw Object.assign(new Error('同一幂等键对应不同业务输入，不能合并'), { status: 409, code: 'work_input_conflict' });
        }
        return row;
    }

    /** 在调用方事务内读取工作行（加行锁），用于结算前后的同事务校验。 */
    async function lockWorkInTransaction(conn, workId) {
        if (!conn?.query) throw Object.assign(new Error('lockWorkInTransaction 需要事务连接'), { code: 'work_missing_conn' });
        const [[row]] = await conn.query('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [String(workId || '')]);
        return row || null;
    }

    /** 同连接结算仍完整校验账户、轮次、代次和状态机；库存/回执失败必须一起回滚。 */
    async function settleInTransaction(conn, { workId, state, reason = '', accountId, runId, workerEpoch }) {
        if (!conn?.query) throw Object.assign(new Error('settleInTransaction 需要事务连接'), { code: 'work_missing_conn' });
        if (!Object.values(WORK_STATUS).includes(state)) {
            throw Object.assign(new Error(`未知结算状态 ${state}`), { status: 400, code: 'work_bad_state' });
        }
        await conn.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
        const [[located]] = await conn.query('SELECT account_id FROM hub_account_work WHERE work_id=?', [workId]);
        if (!located) return { settled: false, reason: 'work_not_found' };
        const runtime = await runtimeForWork(conn, located.account_id, workId);
        const [[work]] = await conn.query('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [workId]);
        if (!accountId || accountId !== work.account_id || !runId || runId !== work.run_id || workerEpoch === undefined) {
            throw Object.assign(Error('work_missing_or_wrong_context'), { status: 403, code: 'work_missing_context' });
        }
        if (TERMINAL_STATUSES.has(work.status)) return { settled: true, released: false, state: work.status, idempotent: true };
        if (!runtime || runtime.current_work_id !== workId) return { settled: false, reason: 'work_not_current' };
        assertContext(runtime, { accountId, runId, workerEpoch }, '事务结算');
        if (!SETTLE_TRANSITIONS.get(work.status)?.has(state) || state === WORK_STATUS.running) {
            throw Object.assign(Error(`不允许从 ${work.status} 结算为 ${state}`), { status: 409, code: 'work_bad_transition' });
        }
        const at = now();
        const [updated] = await conn.query('UPDATE hub_account_work SET status=?,updated_at=? WHERE work_id=? AND status=?', [state, at, workId, work.status]);
        if (Number(updated.affectedRows) !== 1) return { settled: false, reason: 'concurrent_change' };
        if (TERMINAL_STATUSES.has(state)) {
            await conn.query(`UPDATE hub_account_runtime SET current_work_id='',store_id='',run_id='',state='idle',updated_at=?
                WHERE account_id=? AND current_work_id=?`, [at, work.account_id, workId]);
        } else {
            await conn.query('UPDATE hub_account_runtime SET state=?,updated_at=? WHERE account_id=? AND current_work_id=?',
                [state, at, work.account_id, workId]);
        }
        if (elastic) {
            if (TERMINAL_STATUSES.has(state)) await conn.query('DELETE FROM hub_elastic_work_slots WHERE work_id=? AND account_id=?', [workId, accountId]);
            else await conn.query('UPDATE hub_elastic_work_slots SET state=?,updated_at=? WHERE work_id=?', [state, at, workId]);
        }
        return { settled: true, released: TERMINAL_STATUSES.has(state), workId, state, reason };
    }

    return { enqueue, runtimeOf, runtimeForWork, detachPrepared, workOf, claimAccountWork, checkpointWork, settleWork,
        holdPlatformLease, releasePlatformLease, pendingPlatformLeases, snapshot,
        // 同事务内部接口：由上层事务传入 conn，避免另开连接造成半边成功。
        enqueueInTransaction, lockWorkInTransaction, settleInTransaction, assertQueueCapacity };
}
