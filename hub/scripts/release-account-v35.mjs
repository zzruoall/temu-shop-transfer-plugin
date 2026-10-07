/** v35发布辅助：精确清除用户授权的十条历史任务，迁移与备份恢复演练只在显式目标库执行。 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { assertAccountProcessMode } from '../lib/mysql-schema.mjs';

const [mode, name, root, configFile] = process.argv.slice(2);
assert.ok(['preview', 'production'].includes(mode));
assert.equal(name, mode === 'production' ? 'temu_transfer_v24' : 'temu_v35_restore_check');
assert.ok(root?.startsWith('/home/ylx/apps/temu-transfer/') || root?.startsWith('/tmp/temu-v35-'));
const pool = mysql.createPool({ user: 'root', socketPath: '/var/run/mysqld/mysqld.sock', database: name, connectionLimit: 2 });
const database = { name, query: (_lane, sql, values) => pool.query(sql, values) };
const ids = ['74ea2b1d-172','8bcf3f6a-5f9','8efc5943-e91','7e662c5a-cf3','93ac4c8d-c7e',
    '732592fe-244','c57d450f-71f','ca26ced0-202','e55f8478-cc4','9fc6af4f-15a'];
try {
    const [[before]] = await pool.query('SELECT (SELECT COUNT(*) FROM hub_jobs) jobs,(SELECT COUNT(*) FROM hub_job_items) items,(SELECT COUNT(*) FROM hub_products) products,(SELECT COUNT(*) FROM hub_batch_products) batchProducts');
    const c = await pool.getConnection();
    try {
        await c.beginTransaction();
        const [jobs] = await c.query('SELECT id,status,target_store FROM hub_jobs WHERE id IN (?) FOR UPDATE', [ids]);
        const [items] = await c.query('SELECT job_id,spu_id,status,direct_state FROM hub_job_items WHERE job_id IN (?) FOR UPDATE', [ids]);
        assert.equal(jobs.length, 10, '授权删除范围必须恰好十条，数据已变化时停止发布');
        assert.equal(items.length, 10);
        assert.ok(jobs.every(j => j.status === 'cancelled' && j.target_store === 'temu:634418210693849'));
        assert.ok(items.every(i => i.spu_id === '1160816649' && i.status === 'cancelled' && i.direct_state === 'unknown'));
        // 只删除已确认的任务及外键级联明细；商品、采集文件、店铺、账户和其他历史不动。
        await c.query('DELETE FROM hub_jobs WHERE id IN (?)', [ids]);
        await c.commit();
    } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
    const first = await migrateAccountExecution(database);
    await migrateAccountExecution(database);
    await assertAccountProcessMode(database, 'on');
    const [[after]] = await pool.query('SELECT (SELECT COUNT(*) FROM hub_jobs) jobs,(SELECT COUNT(*) FROM hub_job_items) items,(SELECT COUNT(*) FROM hub_products) products,(SELECT COUNT(*) FROM hub_batch_products) batchProducts');
    assert.equal(Number(after.jobs), Number(before.jobs) - 10);
    assert.equal(Number(after.items), Number(before.items) - 10);
    assert.equal(Number(after.products), Number(before.products));
    assert.equal(Number(after.batchProducts), Number(before.batchProducts));
    if (mode === 'preview') {
        // 副本仅把资料根改到独立目录；凭据仍留在服务器私有文件，禁止输出到发布日志。
        await pool.query('UPDATE hub_schema SET data_root=? WHERE id=1', [root]);
        await writeFile(configFile, JSON.stringify({ user: 'root', socketPath: '/var/run/mysqld/mysqld.sock', database: name }), { mode: 0o600 });
    }
    console.log(JSON.stringify({ mode, deletedJobs: ids, before, after, migration: first, accountModeReady: true }));
} finally { await pool.end(); }
