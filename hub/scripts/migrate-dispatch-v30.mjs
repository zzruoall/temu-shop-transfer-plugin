import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { BULK_SCHEMA } from '../lib/bulk-dispatch.mjs';

// DDL由部署账号单独执行，正式应用账号只承担下方受锁保护的数据兼容迁移。
if (process.argv.includes('--schema-sql')) {
    console.log(BULK_SCHEMA[1] + ';');
} else {
    const db = await openMysqlDatabase();
    if (!db) throw Error('缺少迁移数据库配置');
    try {
        const [rows] = await db.query('maintenance', "SELECT id FROM hub_bulk_dispatch WHERE status IN ('paused','queued')");
        let resumed = 0;
        for (const { id } of rows) await db.transaction('maintenance', async conn => {
            const [[row]] = await conn.query('SELECT * FROM hub_bulk_dispatch WHERE id=? FOR UPDATE', [id]);
            const now = new Date().toISOString();
            if (!row || !['paused', 'queued'].includes(row.status) || row.lease_until > now) return;
            const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
            let changed = false;
            for (const target of state.targets) {
                // 只恢复旧版明确因离线而暂停的分发，不触碰取消、权限暂停或未知结果隔离。
                if (!target.done && target.paused && target.error === '目标店插件暂时离线，等待恢复连接') {
                    target.paused = false; target.attempts = 0; target.nextAt = '';
                    target.errorCode = 'target_offline'; changed = true;
                }
            }
            if (!changed) return;
            await conn.query("UPDATE hub_bulk_dispatch SET status='queued',state=?,updated_at=?,next_run_at=?,lease_id='',lease_until='' WHERE id=?", [JSON.stringify(state), now, now, id]);
            resumed++;
        });
        console.log(JSON.stringify({ resumedOfflineBatches: resumed }));
    } finally { await db.close(); }
}
