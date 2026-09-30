import { mkdir, readdir, stat, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { inspectProcess } from './account-process-recovery.mjs';

/** 接收原包与规范化文件预留两份磁盘空间；已受理包按真实文件计费，unknown引用永不按时间删除。 */
export function createStagingBudget({ database, stagingDir, globalBytes = 256 * 1024 * 1024, accountBytes = 64 * 1024 * 1024 }) {
    const busy = code => Object.assign(Error(code), { status: 429, retryAfter: 15, code });
    const lock = connection => connection.query("INSERT INTO hub_queue_locks(id) VALUES('staging-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");

    /** 只回收OS证实原接收者已退出的预留；存活/身份不可读均保守保留。 */
    async function clean(connection) {
        const [reservations] = await connection.query('SELECT * FROM hub_staging_reservations');
        for (const reservation of reservations) {
            const owner = await inspectProcess(Number(reservation.owner_pid));
            const knownIdentity = /^[a-f0-9-]{36}:\d+$/.test(reservation.owner_identity);
            if (owner.state !== 'dead' && !(knownIdentity && owner.identity && owner.identity !== reservation.owner_identity)) continue;
            // 临时文件名只来自服务端UUID，禁止使用数据库里任意路径作删除目标。
            if (/^[a-f0-9-]{36}$/.test(reservation.id)) for (const prefix of ['receive', 'normalize']) {
                await rm(path.join(stagingDir, `.${prefix}-${reservation.id}.tmp`), { force: true });
            }
            await connection.query('DELETE FROM hub_staging_reservations WHERE id=?', [reservation.id]);
        }
        await mkdir(stagingDir, { recursive: true });
        const [refs] = await connection.query("SELECT DISTINCT source_ref FROM hub_account_work WHERE status NOT IN ('done','cancelled') UNION SELECT source_ref FROM hub_staging_reservations WHERE source_ref<>''");
        const retained = new Set(refs.map(row => row.source_ref));
        let bytes = 0;
        for (const entry of await readdir(stagingDir, { withFileTypes: true })) {
            if (!entry.isFile() || entry.name.startsWith('.')) continue;
            const full = path.join(stagingDir, entry.name), info = await stat(full);
            // 延迟清理兼容已落文件但尚未登记引用的旧路径；新接收由持久预留立即保护。
            if (/^[a-f0-9]{64}-[\w.-]+$/.test(entry.name) && !retained.has(`data/staging/${entry.name}`) && Date.now() - info.mtimeMs > 120000) {
                await rm(full); continue;
            }
            bytes += info.size;
        }
        return bytes;
    }

    async function usage(connection, accountId) {
        const [[pending]] = await connection.query('SELECT COALESCE(SUM(bytes),0) AS total,COALESCE(SUM(CASE WHEN account_id=? THEN bytes ELSE 0 END),0) AS owned FROM hub_staging_reservations', [accountId]);
        const [[owned]] = await connection.query("SELECT COALESCE(SUM(n),0) AS bytes FROM (SELECT MAX(expected_bytes) AS n FROM hub_account_work WHERE account_id=? AND status NOT IN ('done','cancelled') GROUP BY source_ref) x", [accountId]);
        return { totalReserved: Number(pending.total), owned: Number(pending.owned) + Number(owned.bytes) };
    }

    /** 短事务只登记预算，不在读取HTTP正文期间持有SQL锁；回执/取消不经过此预算。 */
    async function reserve(accountId, bytes) {
        if (bytes > accountBytes) throw Object.assign(Error('ingest_packet_too_large'), { status: 413 });
        const id = randomUUID(), owner = await inspectProcess(process.pid);
        await database.transaction('control', async connection => {
            await lock(connection);
            const disk = await clean(connection), current = await usage(connection, accountId);
            if (disk + 2 * (current.totalReserved + bytes) > globalBytes) throw busy('staging_global_quota');
            if (current.owned + bytes > accountBytes) throw busy('staging_account_quota');
            await connection.query('INSERT INTO hub_staging_reservations VALUES(?,?,?,?,?,?,?)',
                [id, accountId, process.pid, owner.identity || '', bytes, '', new Date().toISOString()]);
        });
        return id;
    }
    /** 文件公开到内容寻址目录前先绑定预留，防止清理器把暂时没有work引用的文件当孤儿。 */
    async function link(id, sourceRef) {
        await database.transaction('control', async connection => {
            await lock(connection);
            const [result] = await connection.query('UPDATE hub_staging_reservations SET source_ref=? WHERE id=?', [sourceRef, id]);
            if (result.affectedRows !== 1) throw Error('staging_reservation_missing');
        });
    }
    /** 新工作引用和GC共用锁；上架无接收预留，需要同时校验新增快照占用。 */
    async function admitSource(connection, accountId, sourceRef, bytes, reservationId = '') {
        await lock(connection);
        // 接收期间店铺可能换绑；只能消费原账户、原文件且足额的持久预留，不能把旧许可转给新账户。
        if (reservationId) {
            const [[reservation]] = await connection.query('SELECT account_id,source_ref,bytes FROM hub_staging_reservations WHERE id=? FOR UPDATE', [reservationId]);
            if (!reservation || reservation.account_id !== accountId || reservation.source_ref !== sourceRef || Number(reservation.bytes) < bytes) {
                throw Object.assign(Error('staging_reservation_mismatch'), { status: 409, code: 'staging_reservation_mismatch' });
            }
            return;
        }
        const disk = await clean(connection), current = await usage(connection, accountId);
        const [[existing]] = await connection.query("SELECT COUNT(*) AS n FROM hub_account_work WHERE account_id=? AND source_ref=? AND status NOT IN ('done','cancelled')", [accountId, sourceRef]);
        if (!Number(existing.n) && current.owned + bytes > accountBytes) throw busy('staging_account_quota');
        if (disk + 2 * current.totalReserved + bytes > globalBytes) throw busy('staging_global_quota');
    }
    async function release(id) { await database.query('control', 'DELETE FROM hub_staging_reservations WHERE id=?', [id]); }
    return { reserve, link, admitSource, release };
}
