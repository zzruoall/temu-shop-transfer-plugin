/** 离线增量迁移：仅建立工作槽索引，不重放旧任务、不删除未决证据。 */
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeElasticWorkSlots } from '../lib/elastic-work-slots.mjs';

if (!process.argv.includes('--confirm-offline')) throw Error('需要停服并确认 --confirm-offline');
const database = await openMysqlDatabase();
if (!database) throw Error('需要显式 TEMU_MYSQL_CONFIG');
try {
    // 新模式允许带已完整记录的槽重启，但迁移时监督器必须停止，不能边执行边切换。
    const [[leader]] = await database.query('maintenance', 'SELECT heartbeat_at,mode FROM hub_process_control WHERE id=1');
    if (leader?.mode === 'on' && Date.now() - Date.parse(leader.heartbeat_at) < 30000) throw Error('监督器仍活跃，请停服后等待领导租期结束');
    const [[before]] = await database.query('maintenance', 'SELECT COUNT(*) AS n FROM hub_account_work');
    await initializeElasticWorkSlots(database);
    const [[after]] = await database.query('maintenance', 'SELECT COUNT(*) AS n FROM hub_account_work');
    if (String(before.n) !== String(after.n)) throw Error('迁移期间工作数变化，不能启用');
    console.log(JSON.stringify({ database: database.name, ready: true, unchanged: true, workCount: before.n }));
} finally { await database.close(); }
