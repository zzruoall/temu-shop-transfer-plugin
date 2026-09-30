import { createHash, randomUUID } from 'node:crypto';

export const INGEST_PROTOCOL_SCHEMA = `CREATE TABLE IF NOT EXISTS hub_ingest_requests (
 id CHAR(64) PRIMARY KEY,owner_id VARCHAR(255) NOT NULL,request_hash CHAR(64) NOT NULL,
 status VARCHAR(20) NOT NULL,updated_at VARCHAR(30) NOT NULL,receipt JSON,
 INDEX(status,updated_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`;
const fail = (message, status) => Object.assign(Error(message), { status, code: message });

/** 小请求先申请字节预算；上传回执持久化按实例隔离，正文未知是否落盘时只能查询，不能盲目重传。 */
export function createIngestProtocol({ database, admission, resolveAccount = null, reserveStorage = null, releaseStorage = null, elastic = null }) {
    const leases = new Map(), sources = new Set();
    const key = (owner, id) => createHash('sha256').update(JSON.stringify([owner, id])).digest('hex');

    /**
     * 调度身份取"店铺被认领的网站账号"，而不是插件实例：
     * 一个账号多开插件、或同一账号认领多家店，都不应该因此获得更多份额。
     * 店铺尚未被认领时退回实例标识，保证未认领的店铺仍能被调度（不会被拒收）。
     */
    async function schedulingAccount(owner, storeId) {
        if (typeof resolveAccount !== 'function') return owner;
        try {
            const accountId = await resolveAccount(storeId);
            return accountId || owner;
        } catch { return owner; }
    }

    async function prepare(owner, input) {
        if (!database) throw fail('ingest_protocol_requires_mysql', 503);
        if (!owner || !/^temu:\d+$/.test(input.storeId || '') || !/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '') || !/^[a-f0-9]{64}$/.test(input.sha256 || '')
            || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > 64 * 1024 * 1024) throw fail('ingest_packet_invalid', 413);
        const id = key(owner, input.requestId), now = new Date().toISOString();
        await database.transaction('ingest', async conn => {
            await conn.query("INSERT INTO hub_queue_locks(id) VALUES('ingest-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            // 未消费许可最长30秒；两分钟后仅退休prepared，处理中或已入队的事实绝不按TTL重放。
            await conn.query("UPDATE hub_ingest_requests SET status='cancelled',updated_at=? WHERE status='prepared' AND updated_at<?",
                [now, new Date(Date.now() - 120000).toISOString()]);
            const [[old]] = await conn.query('SELECT id FROM hub_ingest_requests WHERE id=?', [id]);
            if (old) return;
            const [[count]] = await conn.query("SELECT COUNT(*) AS n,COALESCE(SUM(owner_id=?),0) AS owned FROM hub_ingest_requests WHERE status IN ('prepared','processing','queued')", [owner]);
            if (Number(count.n) >= 512 || Number(count.owned) >= 10) throw fail('ingest_capacity_wait', 429);
            await conn.query("INSERT INTO hub_ingest_requests VALUES(?,?,?,'prepared',?,NULL)", [id, owner, input.sha256, now]);
        });
        const [[row]] = await database.query('ingest', 'SELECT * FROM hub_ingest_requests WHERE id=?', [id]);
        if (row.request_hash !== input.sha256) throw fail('ingest_request_conflict', 409);
        if (row.status === 'completed') return { state: 'completed', receipt: typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt };
        // 账户队列已受理就不再签发上传许可，响应丢失后只能查询原请求，不能重复传正文。
        if (['queued', 'failed', 'cancelled'].includes(row.status)) return { state: row.status, requestId: input.requestId };
        if (row.status === 'processing') {
            // 本实例没有内存许可不代表另一实例已退出；未知接收只能查询/明确取消，不能重置重传。
            return { state: 'reconciling', scheduling: { protocol: 1, action: 'reconcile', reasonCode: 'ingest_result_pending', retryAfterMs: 30000 } };
        }
        const source = input.storeId || owner;
        if (sources.has(source)) throw fail('ingest_capacity_wait', 429);
        sources.add(source);
        let release;
        // 入库额度按"店铺认领账号"公平分配，而不是按插件实例先到先服务。
        const account = await schedulingAccount(owner, input.storeId);
        try { release = await admission.acquire(input.bytes, null, account); }
        catch (error) { sources.delete(source); throw error; }
        let storageId = '', accountContext = null;
        try {
            if (reserveStorage) {
                const reserved = await reserveStorage(source, input.bytes);
                storageId = typeof reserved === 'string' ? reserved : reserved.storageId;
                accountContext = typeof reserved === 'object' ? reserved.accountContext : null;
            }
        }
        catch (error) { sources.delete(source); release(); throw error; }
        const token = randomUUID();
        let finished = false;
        const finish = () => { if (finished) return; finished = true; clearTimeout(leases.get(token)?.timer); leases.delete(token); sources.delete(source); release();
            return storageId && releaseStorage ? releaseStorage(storageId) : undefined; };
        const timer = setTimeout(() => { Promise.resolve(finish()).catch(() => {}); }, 30000); timer.unref();
        leases.set(token, { id, requestId: input.requestId, storageId, accountContext, owner, storeId: source, sha256: input.sha256, bytes: input.bytes, timer, finish, used: false });
        return { state: 'ready', token, expiresInMs: 30000 };
    }
    /** 许可必须属于认证实例且只消费一次；旧令牌不能在超时后绕过容量限制。 */
    async function consume(owner, token, size) {
        const lease = leases.get(token);
        if (!lease || lease.owner !== owner || lease.used) throw fail('ingest_permit_expired', 409);
        if (!Number.isFinite(size) || size > lease.bytes) throw fail('ingest_packet_invalid', 413);
        lease.used = true; clearTimeout(lease.timer);
        return lease;
    }
    async function begin(lease, sha256) {
        if (lease.sha256 !== sha256) throw fail('ingest_request_conflict', 409);
        const [result] = await database.query('ingest', "UPDATE hub_ingest_requests SET status='processing',updated_at=? WHERE id=? AND status='prepared'", [new Date().toISOString(), lease.id]);
        if (result.affectedRows !== 1) throw fail('ingest_result_pending', 409);
    }
    /** 等待库存事务释放行锁后才决定是否恢复；若事务实际提交成功，completed回执不会被覆盖。 */
    async function failed(lease) {
        await database.query('ingest', "UPDATE hub_ingest_requests SET status='prepared',updated_at=? WHERE id=? AND status='processing'", [new Date().toISOString(), lease.id]);
    }
    /** 请求查询按认证实例隔离；外部requestId不是数据库主键，不能借猜测编号读其他实例结果。 */
    async function status(owner, requestId) {
        const [[row]] = await database.query('feedback', 'SELECT * FROM hub_ingest_requests WHERE id=? AND owner_id=?', [key(owner, requestId), owner]);
        if (!row) throw fail('ingest_request_not_found', 404);
        const receipt = typeof row.receipt === 'string' ? JSON.parse(row.receipt) : row.receipt;
        let state = row.status;
        if (state === 'queued') {
            const [[count]] = await database.query('feedback', "SELECT SUM(status='failed') AS failed,SUM(status='running') AS running FROM hub_account_work WHERE request_id=?", [row.id]);
            if (Number(count.failed)) state = 'failed';
            else if (Number(count.running)) state = 'running';
        }
        const { accountContext: _private, ...publicReceipt } = receipt || {};
        return { state, requestId, receipt: publicReceipt };
    }
    /** 取消只撤销原请求；未提交工作取消，已完成结果保留，未知副作用证据不可删除。 */
    async function cancel(owner, requestId) {
        const id = key(owner, requestId);
        return database.transaction('control', async conn => {
            await conn.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            // 与prepare的首次插入共用锁，取消先到不能覆盖并发已完成请求，也不能漏掉迟到受理。
            await conn.query("INSERT INTO hub_queue_locks(id) VALUES('ingest-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            const [works] = await conn.query('SELECT account_id,work_id FROM hub_account_work WHERE request_id=? ORDER BY account_id,work_id', [id]);
            for (const accountId of [...new Set(works.map(work => work.account_id))]) {
                await conn.query('SELECT account_id FROM hub_account_runtime WHERE account_id=? FOR UPDATE', [accountId]);
            }
            const [[row]] = await conn.query('SELECT * FROM hub_ingest_requests WHERE id=? AND owner_id=? FOR UPDATE', [id, owner]);
            if (!row) {
                // 停止可能先于prepare到达，保留取消墓碑，迟到受理不能重开已结束请求。
                await conn.query("INSERT INTO hub_ingest_requests VALUES(?,?,?,'cancelled',?,NULL)",
                    [id, owner, '', new Date().toISOString()]);
                return { state: 'cancelled', requestId };
            }
            if (row.status === 'completed') return { state: 'completed', requestId };
            await conn.query("UPDATE hub_ingest_requests SET status='cancelled',updated_at=? WHERE id=?", [new Date().toISOString(), id]);
            await conn.query("UPDATE hub_account_work SET status='cancelled',updated_at=? WHERE request_id=? AND direction='ingest' AND status IN ('queued','running','waiting')", [new Date().toISOString(), id]);
            for (const work of works) await conn.query("UPDATE hub_account_runtime r JOIN hub_account_work w ON w.work_id=r.current_work_id SET r.current_work_id='',r.run_id='',r.store_id='',r.state='idle',r.worker_epoch=r.worker_epoch+1 WHERE r.account_id=? AND w.work_id=? AND w.status='cancelled' AND r.state<>'unknown'", [work.account_id, work.work_id]);
            // 只回收本次已确认取消的上传工作槽；unknown与发布许可不在这个删除范围内。
            if (elastic) await conn.query(`DELETE s FROM hub_elastic_work_slots s JOIN hub_account_work w ON w.work_id=s.work_id
                WHERE w.request_id=? AND w.direction='ingest' AND w.status='cancelled'`, [id]);
            return { state: 'cancelled', requestId };
        });
    }
    return { prepare, consume, begin, failed, status, cancel };
}
