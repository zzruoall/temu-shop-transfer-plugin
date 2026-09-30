/**
 * 账户 worker 的 IPC broker：持久领导代次、消息去重、白名单与字节上限。
 *
 * 对应方案步骤2。三条硬要求：
 * 1. **领导代次落库**：两个主服务同时启动时只有一个能签发许可；数据库失联即停止新授权。
 *    内存里的计数器做不到这一点——两个进程各自计数都以为自己是唯一。
 * 2. **消息去重**：会改变持久状态的消息按 `账户+worker代次+messageId` 去重，
 *    重复消息返回**相同结果**而不是重复执行副作用。
 * 3. **父端识别账户**：账户从父进程持有的绑定上下文推断，**不信任消息自报的 accountId**。
 *    路径引用只能由父端签发，拒绝绝对路径、目录穿越与任意 SQL。
 */
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** 允许的操作白名单：任何其他操作名一律拒绝（含任意 SQL 之类的注入尝试）。 */
export const BROKER_ALLOWED_OPERATIONS = new Set(['start', 'yield', 'ping', 'checkpoint', 'settle']);

/** 会改变持久状态的操作：必须去重。 */
export const STATEFUL_OPERATIONS = new Set(['checkpoint', 'settle']);

/** 单条 IPC 消息的字节上限（方案：单消息 64 KiB）。 */
export const IPC_MESSAGE_BYTES = 64 * 1024;

/** 明显不是路径、或试图越界的输入一律拒绝。 */
export function validatePathRef(ref, { allowedRoot } = {}) {
    const value = String(ref || '').trim();
    if (!value) return { ok: false, reason: 'empty_path' };
    // 绝对路径、盘符、UNC、协议前缀都不接受：路径由父端签发，子端不得自选位置。
    if (path.isAbsolute(value)) return { ok: false, reason: 'absolute_path' };
    if (/^[a-zA-Z]:/.test(value)) return { ok: false, reason: 'drive_path' };
    if (value.startsWith('\\\\') || value.startsWith('//')) return { ok: false, reason: 'unc_path' };
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { ok: false, reason: 'scheme_path' };
    const normalized = path.normalize(value);
    if (normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) return { ok: false, reason: 'path_traversal' };
    if (allowedRoot) {
        const resolved = path.resolve(allowedRoot, normalized);
        const rootResolved = path.resolve(allowedRoot);
        if (!resolved.startsWith(rootResolved)) return { ok: false, reason: 'outside_allowed_root' };
    }
    return { ok: true, relative: normalized };
}

/** 拒绝任意 SQL、脚本与不受控代码注入：这些字段根本不该出现在 IPC 消息里。 */
const FORBIDDEN_FIELDS = ['sql', 'query', 'script', 'code', 'eval', 'require', 'exec', 'command'];
export function validateMessageShape(message) {
    const payload = message || {};
    for (const field of FORBIDDEN_FIELDS) {
        if (payload[field] !== undefined) return { ok: false, reason: `forbidden_field:${field}` };
    }
    const bytes = Buffer.byteLength(JSON.stringify(payload, (_key, value) => typeof value === 'bigint' ? String(value) : value), 'utf8');
    if (bytes > IPC_MESSAGE_BYTES) return { ok: false, reason: 'message_too_large', bytes };
    return { ok: true, bytes };
}

/** 消息去重键：账户 + worker 代次 + messageId。缺 messageId 的有状态消息不允许执行。 */
export function messageDedupKey({ accountId, workerEpoch, messageId }) {
    const account = String(accountId || '').trim();
    const epoch = Number(workerEpoch || 0);
    const id = String(messageId || '').trim();
    if (!account || !id) return '';
    return createHash('sha256').update(`${account}\u0000${epoch}\u0000${id}`).digest('hex');
}

/**
 * 持久领导代次。
 *
 * 用 `hub_process_control` 单行做 CAS：只有把 epoch 从读到的值改成自己值的那一刻才算当选。
 * 心跳续租；超过 leaseMs 没有心跳的领导视为失效，可以被其他实例接管。
 */
export function createSupervisorLeader({ database, instanceId = randomUUID(), now = () => new Date().toISOString(),
    leaseMs = 30_000, mode = 'off', configVersion = 1 } = {}) {
    let leader = false;
    let myEpoch = 0;
    let lastHeartbeatAt = 0;
    let lastFailure = '';
    let lastFailureAt = 0;

    /** 尝试当选/续租。返回 {leader, epoch, reason}。 */
    async function campaign() {
        const at = now();
        let result;
        try {
            result = await database.transaction('control', async conn => {
                const cq = (sql, params = []) => conn.query(sql, params);
                // 先确保这一行存在；再锁行做 CAS。
                await cq("INSERT INTO hub_process_control(id,supervisor_epoch,heartbeat_at,mode,config_version,updated_at) VALUES(1,0,'',?,?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)",
                    [mode, configVersion, at]);
                const [[row]] = await cq('SELECT * FROM hub_process_control WHERE id=1 FOR UPDATE');
                const heartbeatAge = row.heartbeat_at ? Date.parse(at) - Date.parse(row.heartbeat_at) : Number.POSITIVE_INFINITY;
                const expired = !row.heartbeat_at || !Number.isFinite(heartbeatAge) || heartbeatAge > leaseMs;
                const mine = Number(row.supervisor_epoch) === myEpoch && myEpoch > 0;
                if (!mine && !expired) {
                    // 他人领导且未过期：不能抢。同时**确认自己已失权**：
                    // 别人接管后我们这里不能再以为自己还能签发许可。
                    return { leader: false, epoch: Number(row.supervisor_epoch), reason: 'held_by_other' };
                }
                if (mine) {
                    await cq('UPDATE hub_process_control SET heartbeat_at=?,updated_at=? WHERE id=1', [at, at]);
                    return { leader: true, epoch: myEpoch, reason: 'renewed' };
                }
                const nextEpoch = Number(row.supervisor_epoch) + 1;
                await cq('UPDATE hub_process_control SET supervisor_epoch=?,heartbeat_at=?,mode=?,config_version=?,updated_at=? WHERE id=1',
                    [nextEpoch, at, mode, configVersion, at]);
                myEpoch = nextEpoch;
                return { leader: true, epoch: nextEpoch, reason: 'elected' };
            });
        } catch (error) {
            // 续租/竞选失败（例如数据库失联）：必须**立即放弃**领导权。
            // 否则旧实例在一个已经不属于它的租期里继续签发许可，两个实例会同时授权。
            leader = false;
            lastFailure = String(error?.message || error);
            lastFailureAt = Date.parse(at);
            throw error;
        }
        leader = result.leader;
        if (leader) lastHeartbeatAt = Date.parse(at);
        return result;
    }

    /**
     * 是否仍可签发新许可。
     *
     * 必须是**每次查租期**的判定，不能只返回一个内存布尔值：
     * - 别人接管后，我们这里没再竞选过，标志位还是 true（实测两个实例同时认为可授权）；
     * - 自己心跳已经过期时，实际上已经没有资格了。
     * 因此以"领导标志 + 本地租期未过"共同判定；续租失败时上面的 catch 会清掉标志。
     */
    function canAuthorize() {
        if (!leader) return false;
        // 本地租期：超过 leaseMs 没有成功续租即视为失权。
        return (Date.parse(now()) - lastHeartbeatAt) <= leaseMs;
    }

    return {
        campaign,
        canAuthorize,
        epoch: () => myEpoch,
        instanceId,
        resign: () => { leader = false; },
        /** 观测：心跳是否已过租期（用于判断自己是否仍持有领导权）。 */
        heartbeatAgeMs: (at = Date.parse(now())) => at - lastHeartbeatAt,
        /** 观测：最近一次竞选/续租失败的原因（用于排障，不参与授权判定）。 */
        lastFailure: () => ({ reason: lastFailure, at: lastFailureAt })
    };
}

/**
 * IPC 消息代理：白名单 + 去重 + 结果重放。
 * 账户来自**绑定上下文**，不取消息里的 accountId。
 */
export function createAccountWorkerBroker({ database, now = () => new Date().toISOString(),
    messageLeaseMs = 30_000, messageWaitMs = 5_000 } = {}) {
    /**
     * 处理一条来自子进程的请求。
     * @param {object} args
     * @param {string} args.accountId 父端持有的绑定账户（**不是**消息里的值）
     * @param {number} args.workerEpoch 父端持有的 worker 代次
     * @param {object} args.message 子进程消息
     * @param {Function} args.execute 真正执行副作用的函数
     */
    async function dispatch({ accountId, workerEpoch, message, execute }) {
        const boundAccount = String(accountId || '').trim();
        if (!boundAccount) throw Object.assign(new Error('broker 缺少绑定账户，拒绝处理'), { code: 'broker_missing_binding' });
        const payload = message || {};
        const shape = validateMessageShape(payload);
        if (!shape.ok) {
            return { ok: false, reason: shape.reason, bytes: shape.bytes };
        }
        const operation = String(payload.operation || '');
        if (!BROKER_ALLOWED_OPERATIONS.has(operation)) {
            return { ok: false, reason: 'operation_not_allowed', operation };
        }
        // 父端绑定的代次优先：消息自报的代次不一致即拒绝（旧代次不能推动新任务）。
        if (payload.workerEpoch !== undefined && Number(payload.workerEpoch) !== Number(workerEpoch)) {
            return { ok: false, reason: 'epoch_mismatch', bound: Number(workerEpoch), claimed: Number(payload.workerEpoch) };
        }
        // 消息自报的账户与绑定不一致即拒绝；一致也不采信它，始终用绑定值。
        if (payload.accountId !== undefined && String(payload.accountId) !== boundAccount) {
            return { ok: false, reason: 'account_mismatch' };
        }
        // 路径引用只能相对且不得越界。
        if (payload.sourceRef !== undefined) {
            const check = validatePathRef(payload.sourceRef);
            if (!check.ok) return { ok: false, reason: `bad_source_ref:${check.reason}` };
        }

        const stateful = STATEFUL_OPERATIONS.has(operation);
        const messageId = String(payload.messageId || '');
        if (stateful && !messageId) {
            // 有状态消息缺 messageId 就无法去重：宁可拒绝，也不能冒重复执行的风险。
            return { ok: false, reason: 'missing_message_id' };
        }
        const key = stateful ? messageDedupKey({ accountId: boundAccount, workerEpoch, messageId }) : '';

        if (stateful) {
            // 去重必须**原子占位**，不能先 SELECT 再执行再 INSERT：
            // 同一条消息并发两次时，两边都会看到"没有记录"，于是副作用执行两次。
            // 用 INSERT IGNORE 抢占唯一键，抢到的才执行；抢不到的等待结果或接管过期占位。
            const outcome = await claimMessage({ key, accountId: boundAccount, workerEpoch, operation, message: payload });
            if (outcome.role === 'replay') {
                // 重复消息返回**相同结果**，不重复执行副作用。
                return { ok: true, deduplicated: true, result: outcome.result };
            }
            if (outcome.role === 'waited') {
                // 同消息的另一次分派已完成：直接重放它的结果。
                return { ok: true, deduplicated: true, result: outcome.result };
            }
            if (outcome.role === 'busy') {
                // 占位仍在有效期内且尚未出结果：让调用方稍后重试，不能重复执行。
                return { ok: false, reason: 'message_in_flight', retryAfterMs: outcome.retryAfterMs };
            }
            if (outcome.role === 'expired') {
                // 结果未知：不重做。返回可识别状态，由上游按自己的幂等证据核对。
                return { ok: false, reason: 'message_result_unknown', claimedAt: outcome.claimedAt };
            }
            // role === 'owner'：本次负责执行并落盘结果；回执必须带本次的 claim_token。
            const result = await execute({ accountId: boundAccount, workerEpoch, operation, message: payload });
            await completeMessage({ key, result, token: outcome.token });
            return { ok: true, deduplicated: false, result };
        }

        const result = await execute({ accountId: boundAccount, workerEpoch, operation, message: payload });
        return { ok: true, deduplicated: false, result };
    }

    /**
     * 原子抢占一条有状态消息。
     * - 抢到 → `owner`（调用方执行副作用后必须 completeMessage）；
     * - 已有 done 结果 → `replay`；
     * - 已被他人占用且未过期 → `busy`（不重复执行，让调用方退避重试）；
     * - 占用已过期 → `expired`：**绝不重新执行**。
     *
     * 为什么过期不能接管重做：租期到期只说明"我们没等到回执"，
     * 不能证明原执行没有产生副作用，甚至原执行可能仍在运行。
     * 直接重做会让同一消息的副作用执行两次（复核实测 2 次）。
     * 因此过期只把该条标为待核对，交给上游按自己的幂等证据处理。
     */
    async function claimMessage({ key, accountId, workerEpoch, operation, message }) {
        const at = now();
        const staleBefore = new Date(Date.parse(at) - messageLeaseMs).toISOString();
        const token = randomUUID();
        // INSERT IGNORE：唯一键冲突时 affectedRows 为 0，说明别人先占到了。
        const [insertResult] = await database.query('maintenance',
            `INSERT IGNORE INTO hub_worker_messages
             (message_id,account_id,worker_epoch,operation,work_id,state,claimed_at,claim_token,result_json,created_at)
             VALUES(?,?,?,?,?,'claimed',?,?,NULL,?)`,
            [key, accountId, Number(workerEpoch), operation, String(message.workId || ''), at, token, at]);
        if (Number(insertResult.affectedRows) === 1) return { role: 'owner', token };

        const readRow = async () => {
            const [[row]] = await database.query('maintenance',
                'SELECT state,result_json,claimed_at,claim_token FROM hub_worker_messages WHERE message_id=?', [key]);
            return row || null;
        };
        let row = await readRow();
        if (!row) {
            // 极少数情况：占位刚被清理。重试一次抢占，仍失败则交给调用方退避。
            const retryToken = randomUUID();
            const [retry] = await database.query('maintenance',
                `INSERT IGNORE INTO hub_worker_messages
                 (message_id,account_id,worker_epoch,operation,work_id,state,claimed_at,claim_token,result_json,created_at)
                 VALUES(?,?,?,?,?,'claimed',?,?,NULL,?)`,
                [key, accountId, Number(workerEpoch), operation, String(message.workId || ''), at, retryToken, at]);
            return Number(retry.affectedRows) === 1 ? { role: 'owner', token: retryToken } : { role: 'busy', retryAfterMs: 200 };
        }
        if (row.state === 'done') {
            let replayed = null;
            try { replayed = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json; }
            catch { replayed = null; }
            return { role: 'replay', result: replayed };
        }
        if (row.state === 'expired') {
            // 已判定为"结果未知"：不得重做，等上游核对。
            return { role: 'expired', claimedAt: row.claimed_at };
        }
        // state === 'claimed'：等它出结果。
        const deadline = Date.parse(at) + messageWaitMs;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 25));
            row = await readRow();
            if (!row) break;
            if (row.state === 'done') {
                let replayed = null;
                try { replayed = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json; }
                catch { replayed = null; }
                return { role: 'waited', result: replayed };
            }
            if (row.state === 'expired') return { role: 'expired', claimedAt: row.claimed_at };
            if (row.claimed_at && row.claimed_at <= staleBefore) {
                // 只把占位标成 expired（结果未知），**不重做**。
                // 用 claim_token 限定：只标记我们观察到的那一次持有，避免误标后来者。
                const [mark] = await database.query('maintenance',
                    `UPDATE hub_worker_messages SET state='expired'
                     WHERE message_id=? AND state='claimed' AND claimed_at<=? AND claim_token=?`,
                    [key, staleBefore, row.claim_token]);
                if (Number(mark.affectedRows) === 1) return { role: 'expired', claimedAt: row.claimed_at };
            }
        }
        return { role: 'busy', retryAfterMs: 200 };
    }

    /**
     * 记录执行结果并标记完成。
     * 必须用 claim_token 校验"当前持有人"：过期被标记后，原执行者**仍然**是
     * 那个产生副作用的持有人，它的回执是真结果，应当允许写回；
     * 但其他任何持有者都不能覆盖，否则会用别人的结果冒充本次执行。
     */
    async function completeMessage({ key, result, token }) {
        await database.query('maintenance',
            `UPDATE hub_worker_messages SET state='done',result_json=?,completed_at=?
             WHERE message_id=? AND claim_token=?`,
            [JSON.stringify(result ?? null), now(), key, String(token || '')]);
    }

    /**
     * 清理过期的去重记录。
     * **只删已完成**的记录：仍在 claimed 的占位是"可能已产生副作用"的证据，
     * 按时间删掉它会让重放的调用方误以为可以重新执行。
     */
    async function pruneMessages({ olderThanMs = 24 * 60 * 60 * 1000 } = {}) {
        const cutoff = new Date(Date.now() - olderThanMs).toISOString();
        const [result] = await database.query('maintenance',
            "DELETE FROM hub_worker_messages WHERE created_at < ? AND state='done' LIMIT 1000", [cutoff]);
        return { removed: Number(result?.affectedRows || 0) };
    }

    return { dispatch, pruneMessages, allowedOperations: [...BROKER_ALLOWED_OPERATIONS] };
}

/**
 * 进程租约登记：保存 pid 与启动身份，PID 重用不能误认作旧 worker。
 * bootId由调用方提供Linux开机UUID与启动tick；其他平台未知时留空，不猜测进程身份。
 */
export function createProcessLeaseRegistry({ database, now = () => new Date().toISOString() } = {}) {
    async function register({ leaseId, accountId, workerEpoch, supervisorEpoch, pid, bootId }) {
        const at = now();
        const id = String(leaseId || `${accountId}:${workerEpoch}:${pid}`);
        await database.query('maintenance',
            `INSERT INTO hub_process_leases(lease_id,account_id,worker_epoch,supervisor_epoch,pid,boot_id,state,heartbeat_at,created_at,updated_at)
             VALUES(?,?,?,?,?,?,'live',?,?,?)
             ON DUPLICATE KEY UPDATE worker_epoch=VALUES(worker_epoch),supervisor_epoch=VALUES(supervisor_epoch),
                 pid=VALUES(pid),boot_id=VALUES(boot_id),state='live',heartbeat_at=VALUES(heartbeat_at),updated_at=VALUES(updated_at)`,
            [id, String(accountId), Number(workerEpoch), Number(supervisorEpoch), Number(pid) || 0, String(bootId || ''), at, at, at]);
        return { leaseId: id };
    }

    async function heartbeat({ leaseId }) {
        const at = now();
        const [result] = await database.query('maintenance',
            "UPDATE hub_process_leases SET heartbeat_at=?,updated_at=? WHERE lease_id=? AND state='live'", [at, at, String(leaseId)]);
        return { updated: Number(result?.affectedRows || 0) };
    }

    async function markExited({ leaseId, reason = 'exited' }) {
        const at = now();
        await database.query('maintenance',
            "UPDATE hub_process_leases SET state='exited',updated_at=? WHERE lease_id=?", [at, String(leaseId)]);
        return { reason };
    }

    /**
     * 判断某个租约是否**仍可能对应活着的进程**：
     * 同一 bootId + 同一 pid 才算"可能还在"；开机标识不同说明是重启后的 PID 重用，不能当成旧 worker。
     */
    async function isPossiblyAlive({ leaseId, currentBootId }) {
        const [[row]] = await database.query('maintenance', 'SELECT * FROM hub_process_leases WHERE lease_id=?', [String(leaseId)]);
        if (!row) return { alive: false, reason: 'no_lease' };
        if (row.state !== 'live') return { alive: false, reason: 'released' };
        if (currentBootId && row.boot_id && row.boot_id !== currentBootId) {
            return { alive: false, reason: 'pid_reused_after_reboot', bootId: row.boot_id };
        }
        // 只做"可能还在"的保守判断：真正是否存活由 OS 侧核对（调用方负责）。
        return { alive: true, reason: 'lease_live', pid: row.pid };
    }

    /** 列出仍标记为 live 的租约：重启接管时要先核对它们，不能忽略后直接再开两个。 */
    async function liveLeases() {
        const [rows] = await database.query('maintenance', "SELECT * FROM hub_process_leases WHERE state='live' ORDER BY created_at");
        return rows;
    }

    return { register, heartbeat, markExited, isPossiblyAlive, liveLeases };
}
