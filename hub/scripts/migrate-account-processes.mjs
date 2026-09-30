/**
 * 账户执行账本的增量迁移脚本。
 *
 * 用法（必须先停发新授权，再执行）：
 *   TEMU_MYSQL_CONFIG=<配置> node scripts/migrate-account-processes.mjs --confirm-offline
 *
 * 只做本方案第 4 节要求的增量：4 张新表 + hub_jobs 账户列。
 * 不重建商品库、不改既有任务正文、不删除任何证据。
 * 可重复执行：已存在的表/列/索引会跳过并如实报告。
 */
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { migrateAccountExecution, ACCOUNT_EXECUTION_SCHEMA } from '../lib/account-execution-schema.mjs';

const args = process.argv.slice(2);
const has = name => args.includes(name);
if (!has('--confirm-offline')) {
    console.error('迁移会改动生产库结构，必须显式确认：--confirm-offline');
    process.exit(2);
}
const database = await openMysqlDatabase();
if (!database) {
    console.error('未配置 TEMU_MYSQL_CONFIG，无法迁移');
    process.exit(2);
}
console.log(`[migrate] 目标库：${database.name}`);

try {
    // 迁移前记录既有规模，供迁移后对账"没有动到业务数据"。
    const before = {};
    for (const [label, sql] of [['jobs', 'SELECT COUNT(*) AS n FROM hub_jobs'], ['items', 'SELECT COUNT(*) AS n FROM hub_job_items'],
        ['agents', 'SELECT COUNT(*) AS n FROM hub_agents']]) {
        const [[row]] = await database.query('maintenance', sql);
        before[label] = Number(row.n);
    }
    console.log(`[migrate] 迁移前：${JSON.stringify(before)}`);

    const applied = await migrateAccountExecution(database);
    console.log(`[migrate] 本次执行：${applied.join(', ')}`);

    // 迁移后对账：既有业务数据条数必须完全不变。
    const after = {};
    for (const [label, sql] of [['jobs', 'SELECT COUNT(*) AS n FROM hub_jobs'], ['items', 'SELECT COUNT(*) AS n FROM hub_job_items'],
        ['agents', 'SELECT COUNT(*) AS n FROM hub_agents']]) {
        const [[row]] = await database.query('maintenance', sql);
        after[label] = Number(row.n);
    }
    const same = JSON.stringify(before) === JSON.stringify(after);
    console.log(`[migrate] 迁移后：${JSON.stringify(after)}`);
    if (!same) {
        console.error('[migrate] 既有业务数据条数发生变化，迁移不允许改动业务数据');
        process.exit(1);
    }

    // 核对新表与新列确实可用。
    await database.query('maintenance', 'SELECT account_id FROM hub_jobs LIMIT 0');
    await database.query('maintenance', 'SELECT account_id,current_work_id FROM hub_account_runtime LIMIT 0');
    await database.query('maintenance', 'SELECT work_id,status FROM hub_account_work LIMIT 0');
    await database.query('maintenance', 'SELECT lease_id,kind FROM hub_resource_leases LIMIT 0');
    await database.query('maintenance', 'SELECT supervisor_epoch,mode FROM hub_process_control LIMIT 0');
    const [[control]] = await database.query('maintenance', 'SELECT supervisor_epoch,mode FROM hub_process_control WHERE id=1');
    console.log(JSON.stringify({
        migrated: true, applied, unchanged: same,
        supervisorEpoch: Number(control.supervisor_epoch), mode: control.mode,
        tables: ACCOUNT_EXECUTION_SCHEMA.length
    }, null, 2));
} finally {
    await database.close?.();
}
