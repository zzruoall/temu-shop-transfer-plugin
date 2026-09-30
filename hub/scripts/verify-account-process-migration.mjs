/**
 * 步骤2 验收：账户执行账本的增量迁移。
 *
 * 断言方案要求的出口条件：
 * - 迁移可重复执行，第二次不重复改动；
 * - 归属与数量守恒（既有业务数据条数不变）；
 * - 新表/新列/索引确实可用于查询；
 * - 无法确定归属的任务进入待确认，不自动授权。
 *
 * 只连隔离 MySQL（33917），不连生产、不操作真实店铺。
 */
import assert from 'node:assert/strict';
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution, columnExists, indexExists } from '../lib/account-execution-schema.mjs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_mig', label: '迁移验证' });
const root = await mkdtemp(path.join(tmpdir(), 'temu-accproc-mig-'));
const config = path.join(root, 'mysql.json');
await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name }));
const database = await openMysqlDatabase(config);
try {
    // 先建出基线 schema（模拟线上现状）并放入两条任务，用于验证"迁移不动业务数据"。
    await initializeMysqlSchema(database);
    await database.query('maintenance', `INSERT INTO hub_jobs(id,source_store,target_store,created_at,updated_at,status,record_group,body,summary)
        VALUES('job-a','temu:111','temu:222','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','queued','active','{}','{}'),
              ('job-b','temu:111','temu:333','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z','queued','active','{}','{}')`);
    await database.query('maintenance', `INSERT INTO hub_job_items(job_id,spu_id,position,status,direct_state,updated_at,body)
        VALUES('job-a','spu-1',0,'queued','','2026-09-01T00:00:00Z','{}')`);

    const count = async sql => Number((await database.query('maintenance', sql))[0][0].n);
    const jobsBefore = await count('SELECT COUNT(*) AS n FROM hub_jobs');
    const itemsBefore = await count('SELECT COUNT(*) AS n FROM hub_job_items');

    // 第一次迁移：应执行全部步骤。
    const first = await migrateAccountExecution(database);
    assert.ok(first.some(step => step === 'column:hub_jobs.account_id'), '首次迁移应新增 account_id 列');
    assert.ok(first.some(step => step === 'index:hub_jobs.account_index'), '首次迁移应新增账户索引');
    // 断言**表名**而不是固定条数：新增进程租约/消息去重表不该让这条检查失败，
    // 但缺少任何一张核心表都必须被发现。
    const createdTables = new Set(first.filter(step => step.startsWith('table:')).map(step => step.slice('table:'.length)));
    for (const required of ['hub_account_runtime', 'hub_account_work', 'hub_resource_leases', 'hub_process_control']) {
        assert.ok(createdTables.has(required), `首次迁移必须建立 ${required}，实际建立 ${[...createdTables].join(',')}`);
    }

    // 第二次迁移：不应重复改动。
    const second = await migrateAccountExecution(database);
    assert.equal(second.filter(step => step.startsWith('column:')).length, 0, '重复迁移不应再次加列');
    assert.equal(second.filter(step => step.startsWith('index:')).length, 0, '重复迁移不应再次加索引');

    // 守恒：既有业务数据条数不变。
    assert.equal(await count('SELECT COUNT(*) AS n FROM hub_jobs'), jobsBefore, '迁移不得改动任务条数');
    assert.equal(await count('SELECT COUNT(*) AS n FROM hub_job_items'), itemsBefore, '迁移不得改动明细条数');

    // 新列默认空账户：迁移不臆测归属，未回填的任务就是"无归属"。
    const [[blank]] = await database.query('maintenance', "SELECT COUNT(*) AS n FROM hub_jobs WHERE account_id=''");
    assert.equal(Number(blank.n), jobsBefore, '新列默认值必须是空，不能自动绑定账户');

    // 索引与列确实可用。
    assert.equal(await columnExists(database, 'hub_jobs', 'account_id'), true, 'account_id 列应存在');
    assert.equal(await columnExists(database, 'hub_jobs', 'actor_id'), true, 'actor_id 列应存在');
    assert.equal(await indexExists(database, 'hub_jobs', 'account_index'), true, 'account_index 索引应存在');

    // 唯一幂等键：同一账户/方向/任务/轮次重复入队应被拒绝。
    // 幂等键是定长哈希（utf8mb4 下长字符串联合键会超 InnoDB 3072 字节上限）。
    const { createHash } = await import('node:crypto');
    const idemKey = createHash('sha256').update(JSON.stringify(['acct-01', 'publish', 'job-a', 'spu-1', 'run-1'])).digest('hex');
    const insertWork = (id) => database.query('maintenance', `INSERT INTO hub_account_work
        (work_id,account_id,store_id,direction,job_id,item_spu,request_id,run_id,idem_key,status,next_run_at,checkpoint_ref,created_at,updated_at)
        VALUES(?,'acct-01','temu:222','publish','job-a','spu-1','req-1','run-1',?,'queued','','',?,?)`,
        [id, idemKey, new Date().toISOString(), new Date().toISOString()]);
    await insertWork('w-1');
    let duplicateRejected = false;
    try { await insertWork('w-2'); } catch (error) { duplicateRejected = /Duplicate|uniq_work_idem/i.test(String(error.message || error)); }
    assert.equal(duplicateRejected, true, '同一幂等键的重复工作单元必须被拒绝');

    // 账户运行时主键只用账户：同账户不能有第二行（上传+上架各一条会绕过每账户1件）。
    const insertRuntime = (accountId, workId) => database.query('maintenance', `INSERT INTO hub_account_runtime
        (account_id,current_work_id,store_id,run_id,state,worker_epoch,worker_lease_until,updated_at)
        VALUES(?,?,'temu:222','run-1','running',1,'',?)`, [accountId, workId, new Date().toISOString()]);
    await insertRuntime('acct-01', 'w-1');
    let runtimeDuplicate = false;
    try { await insertRuntime('acct-01', 'w-9'); } catch (error) { runtimeDuplicate = /Duplicate/i.test(String(error.message || error)); }
    assert.equal(runtimeDuplicate, true, '同账户的第二个运行时行必须被拒绝（否则会允许同时执行两件）');

    /*
     * 旧库升级验收（计划任务2 明确要求）。
     *
     * "新库迁移两次"不能证明真实升级路径：`CREATE TABLE IF NOT EXISTS` 对已存在的表
     * 什么都不做，上一版建出的 hub_account_work 不会自动获得上下文列。
     * 这里在**隔离库中重建上一版 DDL**，再跑正式迁移，验证：
     * - 缺失列被补齐且可读写；
     * - 缺来源证据的旧 queued **不被自动激活**（进 needs_confirmation）；
     * - 已终态的行保持原状。
     */
    const legacyName = `${isolated.name}_legacy`;
    await database.query('maintenance', `CREATE DATABASE \`${legacyName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    const legacyPool = require('mysql2/promise').createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: legacyName, connectionLimit: 2 });
    const legacyDb = {
        query: (_lane, sql, params = []) => legacyPool.query(sql, params),
        async transaction(_lane, action) {
            const connection = await legacyPool.getConnection();
            try { await connection.beginTransaction(); const r = await action(connection); await connection.commit(); return r; }
            catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
        }
    };
    try {
        await initializeMysqlSchema(legacyDb);
        // 上一版 hub_account_work：没有 actor_id/source_ref/source_hash/expected_bytes 等列。
        await legacyPool.query(`CREATE TABLE hub_account_work (
            work_id VARCHAR(255) PRIMARY KEY, account_id VARCHAR(255) NOT NULL, store_id VARCHAR(255) NOT NULL,
            direction VARCHAR(20) NOT NULL, job_id VARCHAR(255) NOT NULL DEFAULT '', item_spu VARCHAR(255) NOT NULL DEFAULT '',
            request_id VARCHAR(255) NOT NULL DEFAULT '', run_id VARCHAR(255) NOT NULL DEFAULT '', idem_key CHAR(64) NOT NULL,
            input_fingerprint CHAR(64) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL, next_run_at VARCHAR(30) NOT NULL DEFAULT '',
            checkpoint_ref VARCHAR(255) NOT NULL DEFAULT '', created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL,
            UNIQUE KEY uniq_work_idem (idem_key)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
        await legacyPool.query(`INSERT INTO hub_account_work(work_id,account_id,store_id,direction,idem_key,status,created_at,updated_at)
            VALUES('w-legacy-queued','acct-legacy','temu:legacy','ingest',?,'queued','2026-01-01','2026-01-01')`, ['a'.repeat(64)]);
        await legacyPool.query(`INSERT INTO hub_account_work(work_id,account_id,store_id,direction,idem_key,status,created_at,updated_at)
            VALUES('w-legacy-done','acct-legacy','temu:legacy','ingest',?,'done','2026-01-01','2026-01-01')`, ['b'.repeat(64)]);

        const legacyApplied = await migrateAccountExecution(legacyDb);
        // 列必须补齐且可读写。
        await legacyPool.query('SELECT actor_id,ownership_generation,execution_run_id,source_ref,source_hash,source_hash_algorithm,expected_bytes FROM hub_account_work LIMIT 0');
        // 旧 queued 缺来源证据：不得被自动激活。
        const [[stale]] = await legacyPool.query("SELECT status FROM hub_account_work WHERE work_id='w-legacy-queued'");
        assert.equal(stale.status, 'needs_confirmation', `缺来源证据的旧 queued 必须进待确认，实际 ${stale.status}`);
        // 已终态行保持原状。
        const [[finished]] = await legacyPool.query("SELECT status FROM hub_account_work WHERE work_id='w-legacy-done'");
        assert.equal(finished.status, 'done', `已终态的行不得被改写，实际 ${finished.status}`);
        legacyApplied.legacyColumns = legacyApplied.filter(step => step.includes('hub_account_work') && step.startsWith('column:')).length;
    } finally {
        await legacyPool.end();
        await database.query('maintenance', `DROP DATABASE IF EXISTS \`${legacyName}\``);
    }

    console.log(JSON.stringify({
        passed: true,
        firstRunSteps: first.length,
        secondRunColumnSteps: second.filter(s => s.startsWith('column:')).length,
        jobsPreserved: jobsBefore,
        itemsPreserved: itemsBefore,
        uniqueWorkIdem: true,
        accountRuntimeSingleton: true,
        legacyUpgradeVerified: true,
        realPlatformCalls: 0
    }));
} finally {
    await database.close?.();
    await isolated.drop();
}
