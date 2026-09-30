/** 重启恢复反例仅在隔离库注入进程账本，不向真实平台发请求。 */
import assert from 'node:assert/strict';
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createAccountWorkRepository } from '../lib/account-work-repository.mjs';
import { createAccountProcessRecovery } from '../lib/account-process-recovery.mjs';
const isolated = await openIsolatedDatabase({ prefix: 'temu_recovery', label: '重启账本恢复' });
// 基座管理库连接不直接供业务使用，单独的小池保证测试不耗尽隔离MySQL。
const { default: mysql } = await import('mysql2/promise');
const observer = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 2 });
const database = { query: (_lane, sql, values) => observer.query(sql, values), transaction: async (_lane, fn) => {
    const c = await observer.getConnection();
    try { await c.beginTransaction(); const result = await fn(c); await c.commit(); return result; }
    catch (error) { await c.rollback(); throw error; } finally { c.release(); }
} };
try {
    await initializeMysqlSchema(database); await migrateAccountExecution(database);
    const repo = createAccountWorkRepository(database), now = new Date().toISOString();
    await observer.query("UPDATE hub_process_control SET supervisor_epoch=2,heartbeat_at=?,mode='on',updated_at=? WHERE id=1", [now, now]);
    const create = async (account, { state = 'running', leaseState = 'live', direction = 'ingest', platform = false } = {}) => {
        const work = await repo.enqueue({ accountId: account, storeId: 'temu:1', direction, requestId: account, jobId: account,
            spuId: '1', runId: account, executionRunId: account, actorId: account, ownershipGeneration: now });
        await observer.query('UPDATE hub_account_work SET status=? WHERE work_id=?', [state, work.work_id]);
        await observer.query('INSERT INTO hub_account_runtime VALUES(?,?,?,?,?,1,?,?)', [account, work.work_id, 'temu:1', account, state, '', now]);
        await observer.query('INSERT INTO hub_process_leases VALUES(?,?,1,1,999999,?,?, ?,?,?)', [account, account, '', leaseState, now, now, now]);
        if (platform) await repo.holdPlatformLease({ leaseId: account, accountId: account, workId: work.work_id, attemptId: account, workerEpoch: 1 });
        return work;
    };
    const dead = await create('dead'), held = await create('held', { platform: true });
    const unknown = await create('unknown', { state: 'unknown', platform: true });
    const unresolvedExit = await create('exited-before-settle', { leaseState: 'exited' });
    const preparing = await create('prepared', { direction: 'publish', leaseState: 'exited' });
    // 只需最小job项投影，验证正常已准备状态不会因子进程退出而失败。
    await observer.query("INSERT INTO hub_jobs(id,source_store,target_store,created_at,updated_at,status,record_group,body,summary) VALUES('prepared','temu:2','temu:1',?,?,'queued','active','{}','{}')", [now, now]);
    await observer.query("INSERT INTO hub_job_items(job_id,spu_id,position,status,direct_state,updated_at,body) VALUES('prepared','1',0,'queued','',?,?)", [now, JSON.stringify({ accountWork: { workId: preparing.work_id, preparedEpoch: 1 } })]);
    let allowed = true;
    const recovery = createAccountProcessRecovery({ database, probe: async () => ({ state: 'dead' }),
        validateWork: async () => { if (!allowed) throw Object.assign(Error('revoked'), { status: 409 }); } });
    await recovery(2);
    assert.equal((await repo.workOf(dead.work_id)).status, 'failed');
    assert.equal((await repo.workOf(unresolvedExit.work_id)).status, 'failed');
    assert.equal((await repo.workOf(held.work_id)).status, 'running');
    assert.equal((await repo.workOf(unknown.work_id)).status, 'unknown');
    assert.equal((await repo.workOf(preparing.work_id)).status, 'running');
    allowed = false; await recovery(2);
    assert.equal((await repo.workOf(preparing.work_id)).status, 'failed');
    const [[permits]] = await observer.query("SELECT COUNT(*) n FROM hub_resource_leases WHERE kind='platform' AND state='held'");
    assert.equal(Number(permits.n), 2);
    console.log('死亡准备恢复、退出未结算恢复、平台未知保留、正常发布等待、撤销准备退休7项通过');
} finally { await observer.end(); await isolated.drop(); }
