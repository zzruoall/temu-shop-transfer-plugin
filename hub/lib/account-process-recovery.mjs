import { readFile, readdir } from 'node:fs/promises';
import { createAccountWorkRepository } from './account-work-repository.mjs';

/** Linux以开机标识和启动tick识别进程；其他平台只能确认不存在，不能猜测PID身份。 */
export async function inspectProcess(pid) {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return { state: 'unknown' };
    try {
        if (process.platform !== 'linux') {
            process.kill(Number(pid), 0);
            return { state: 'alive', identity: '' };
        }
        const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
        const line = await readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = line.slice(line.lastIndexOf(')') + 2).trim().split(/\s+/);
        return { state: fields[0] === 'Z' ? 'dead' : 'alive', identity: `${boot}:${fields[19]}` };
    } catch (error) {
        return { state: ['ENOENT', 'ESRCH'].includes(error.code) ? 'dead' : 'unknown' };
    }
}

/** fork到登记PID之间可能崩溃，租约标识同时出现在子进程参数，恢复不能只看父进程消失。 */
export async function inspectReservedChildren(leaseId) {
    if (process.platform !== 'linux') return { state: 'unknown' };
    const expected = `--account-lease=${leaseId}`;
    try {
        const pids = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
        for (const pid of pids) {
            try {
                const args = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
                if (args.includes(expected)) return { state: 'alive', pid: Number(pid) };
            } catch (error) {
                if (!['ENOENT', 'ESRCH'].includes(error.code)) return { state: 'unknown' };
            }
        }
        return { state: 'dead' };
    } catch { return { state: 'unknown' }; }
}

/** 只有两端都具备Linux开机UUID与启动tick，身份差异才足以证明PID已重用。 */
function replacedProcessIdentity(before, after) {
    const format = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:\d+$/i;
    return format.test(before || '') && format.test(after || '') && before !== after;
}

/** 只有OS证实原进程不存在才能回收；租期过期、PID仍在但身份不可读都不是退出证据。 */
export async function leaseProcessGone(lease, probe = inspectProcess, children = inspectReservedChildren) {
    if (lease.state === 'reserved') {
        const match = /^parent:(\d+):(.*)$/.exec(lease.boot_id || '');
        if (!match) return false;
        const parent = await probe(Number(match[1]));
        const gone = parent.state === 'dead' || (parent.state === 'alive' && replacedProcessIdentity(match[2], parent.identity));
        return Boolean(gone && (await children(lease.lease_id)).state === 'dead');
    }
    const processState = await probe(Number(lease.pid));
    return processState.state === 'dead' || (processState.state === 'alive' && replacedProcessIdentity(lease.boot_id, processState.identity));
}

/** 新领导核对旧进程账本；只结束无平台副作用的准备任务，unknown及平台许可保留待核对。 */
export function createAccountProcessRecovery({ database, onFailure, validateWork = null, probe = inspectProcess, children = inspectReservedChildren, elastic = null }) {
    const repo = createAccountWorkRepository(database, { elastic });
    let cursor = '';
    return async function recover(supervisorEpoch) {
        const [leases] = await database.query('maintenance',
            `SELECT p.* FROM hub_process_leases p WHERE p.lease_id>? AND
             ((p.state IN ('reserved','live') AND p.supervisor_epoch<?) OR (p.state='exited' AND EXISTS
             (SELECT 1 FROM hub_account_runtime r WHERE r.account_id=p.account_id AND r.worker_epoch=p.worker_epoch AND r.state='running')))
             ORDER BY p.lease_id LIMIT 100`, [cursor, supervisorEpoch]);
        cursor = leases.length === 100 ? leases.at(-1).lease_id : '';
        let released = 0;
        for (const observed of leases) {
            if (observed.state !== 'exited' && !await leaseProcessGone(observed, probe, children)) continue;
            await database.transaction('control', async connection => {
                const [[leader]] = await connection.query('SELECT supervisor_epoch FROM hub_process_control WHERE id=1 FOR UPDATE');
                if (Number(leader?.supervisor_epoch) !== Number(supervisorEpoch)) return;
                await connection.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
                const [[lease]] = await connection.query('SELECT * FROM hub_process_leases WHERE lease_id=? FOR UPDATE', [observed.lease_id]);
                if (!lease || lease.state !== observed.state || lease.pid !== observed.pid || lease.boot_id !== observed.boot_id) return;
                const [[runtime]] = await connection.query('SELECT * FROM hub_account_runtime WHERE account_id=? FOR UPDATE', [lease.account_id]);
                if (runtime?.state === 'running' && Number(runtime.worker_epoch) === Number(lease.worker_epoch)) {
                    const [[work]] = await connection.query('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [runtime.current_work_id]);
                    const [[pending]] = await connection.query("SELECT COUNT(*) AS n FROM hub_resource_leases WHERE kind='platform' AND work_id=? AND state='held'", [runtime.current_work_id]);
                    if (work?.status === 'running' && !Number(pending.n)) {
                        // 发布准备完成后计算进程会正常退出；授权仍有效就等插件，不能把正常等待误判成崩溃。
                        if (work.direction === 'publish') {
                            const [[itemRow]] = await connection.query('SELECT body FROM hub_job_items WHERE job_id=? AND spu_id=?', [work.job_id, work.item_spu]);
                            const item = typeof itemRow?.body === 'string' ? JSON.parse(itemRow.body) : itemRow?.body;
                            if (item?.accountWork?.workId === work.work_id && Number(item.accountWork.preparedEpoch) === Number(runtime.worker_epoch)) {
                                try { if (validateWork) { await validateWork(connection, work); return; } }
                                catch (error) { if (![403, 409].includes(error.status)) throw error; }
                            }
                        }
                        const result = await repo.settleInTransaction(connection, { workId: work.work_id, accountId: work.account_id,
                            runId: work.run_id, workerEpoch: runtime.worker_epoch, state: 'failed', reason: 'previous_worker_exited' });
                        if (result.settled && !result.idempotent && onFailure) await onFailure({ connection, work, reason: 'previous_worker_exited' });
                    }
                }
                await connection.query("UPDATE hub_process_leases SET state='exited',updated_at=? WHERE lease_id=?", [new Date().toISOString(), lease.lease_id]);
                released++;
            });
        }
        // 弹性模式的prepared已脱离账户runtime，不能只扫描进程租约，否则撤权后业务槽会永久残留。
        // 只作废明确失去授权且未签发平台许可的工作；离线/未知结果不靠TTL猜测释放。
        if (elastic && validateWork) {
            const [detached] = await database.query('maintenance', `SELECT s.* FROM hub_elastic_work_slots s
                JOIN hub_account_work w ON w.work_id=s.work_id
                WHERE s.state='running' AND w.direction='publish'
                AND NOT EXISTS(SELECT 1 FROM hub_account_runtime r WHERE r.account_id=s.account_id AND r.current_work_id=s.work_id)
                AND NOT EXISTS(SELECT 1 FROM hub_resource_leases l WHERE l.work_id=s.work_id AND l.kind='platform' AND l.state='held') LIMIT 100`);
            for (const slot of detached) await database.transaction('control', async connection => {
                const [[leader]] = await connection.query('SELECT supervisor_epoch FROM hub_process_control WHERE id=1 FOR UPDATE');
                if (Number(leader?.supervisor_epoch) !== Number(supervisorEpoch)) return;
                await connection.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
                const current = await repo.runtimeForWork(connection, slot.account_id, slot.work_id);
                if (!current || current.state !== 'running' || Number(current.worker_epoch) !== Number(slot.worker_epoch)) return;
                const [[work]] = await connection.query('SELECT * FROM hub_account_work WHERE work_id=? FOR UPDATE', [slot.work_id]);
                const [[pending]] = await connection.query("SELECT COUNT(*) AS n FROM hub_resource_leases WHERE work_id=? AND kind='platform' AND state='held'", [slot.work_id]);
                if (!work || work.status !== 'running' || Number(pending.n)) return;
                try { await validateWork(connection, work); return; }
                catch (error) { if (![403, 409].includes(error.status)) throw error; }
                const result = await repo.settleInTransaction(connection, { workId: work.work_id, accountId: slot.account_id,
                    runId: slot.run_id, workerEpoch: slot.worker_epoch, state: 'failed', reason: 'prepared_authorization_revoked' });
                if (result.settled && !result.idempotent && onFailure) await onFailure({ connection, work, reason: 'prepared_authorization_revoked' });
            });
        }
        return { inspected: leases.length, released };
    };
}
