/** 真实隔离库验证逐工作身份、借用与收回；不访问生产或真实平台。 */
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { initializeElasticWorkSlots, assertElasticWorkSlotsReady } from '../lib/elastic-work-slots.mjs';
import { createIngestProtocol, INGEST_PROTOCOL_SCHEMA } from '../lib/ingest-protocol.mjs';
import { createAccountWorkRepository } from '../lib/account-work-repository.mjs';
const isolated = await openIsolatedDatabase({ prefix: 'temu_elastic', label: '弹性槽' });
const pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name });
const database = { name: isolated.name, query: (_lane, sql, args) => pool.query(sql, args),
    transaction: async (_lane, fn) => { const c = await pool.getConnection(); try { await c.beginTransaction(); const result = await fn(c); await c.commit(); return result; } catch (e) { await c.rollback(); throw e; } finally { c.release(); } } };
let limit = 2;
const elastic = { snapshot: () => ({ businessLimit: limit, perAccountLimit: 2, processLimit: 1, publishLimit: limit }) };
try {
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    await initializeElasticWorkSlots(database);
    await initializeElasticWorkSlots(database);
    const repo = createAccountWorkRepository(database, { elastic });
    const add = (accountId, storeId, n) => repo.enqueue({ accountId, storeId, direction: 'publish', jobId: `job${n}`, spuId: `p${n}`, runId: `run${n}`,
        actorId: accountId, executionRunId: `run${n}`, ownershipGeneration: 'generation' });
    const claim = async work => repo.claimAccountWork(work.account_id, { workId: work.work_id, runId: work.run_id,
        workerEpoch: Number((await repo.runtimeOf(work.account_id))?.worker_epoch || 0), advanceEpoch: true });
    const detach = c => database.transaction('control', conn => repo.detachPrepared(conn, { accountId: c.work.account_id, workId: c.work.work_id, runId: c.work.run_id, workerEpoch: c.workerEpoch }));
    const settle = (c, state) => repo.settleWork(c.work.work_id, { accountId: c.work.account_id, runId: c.work.run_id, workerEpoch: c.workerEpoch, state });
    const a1 = await claim(await add('A', 'store1', 1));
    assert.equal(a1.claimed, true);
    await detach(a1);
    const a2 = await claim(await add('A', 'store2', 2));
    assert.equal(a2.claimed, true, '一个账户可借两个不同店铺的业务槽');
    await detach(a2);
    assert.notEqual(a1.workerEpoch, a2.workerEpoch);
    assert.equal((await settle(a1, 'unknown')).settled, true, '新店启动不能让旧店原代次回执失效');
    const b = await add('B', 'store3', 3), a3 = await add('A', 'store4', 4);
    assert.equal((await claim(b)).claimed, false, 'unknown仍占全局槽');
    await settle(a2, 'done');
    assert.equal((await claim(a3)).claimed, false, 'B等待时A不能续借');
    const b1 = await claim(b);
    assert.equal(b1.claimed, true);
    await detach(b1);
    limit = 1;
    assert.equal((await claim(a3)).claimed, false);
    assert.equal((await settle(a1, 'done')).settled, true, '降载不阻止旧回执');
    assert.equal((await settle(b1, 'done')).settled, true);
    limit = 2;
    const final = await claim(a3);
    await detach(final);
    const sameStore = await add('B', 'store4', 5);
    assert.equal((await claim(sameStore)).claimed, false, '跨账户同店互斥');
    await assert.rejects(repo.settleWork(final.work.work_id, { accountId: 'B', runId: final.work.run_id, workerEpoch: final.workerEpoch, state: 'done' }));
    await settle(final, 'done');
    const last = await claim(sameStore);
    assert.equal(last.claimed, true);
    await settle(last, 'done');
    // 并发领取共用持久首锁，一个空位不能被两个账户同时分走。
    limit = 1;
    const c = await add('C', 'store5', 6), d = await add('D', 'store6', 7);
    const competing = await Promise.all([claim(c), claim(d)]);
    assert.equal(competing.filter(result => result.claimed).length, 1);
    await settle(competing.find(result => result.claimed), 'done');
    limit = 2;
    const waiting = await claim(await add('W', 'store7', 8));
    await repo.checkpointWork(waiting.work.work_id, { accountId: 'W', runId: waiting.work.run_id, workerEpoch: waiting.workerEpoch });
    const revoked = await repo.claimAccountWork('W', { workId: waiting.work.work_id, runId: waiting.work.run_id,
        workerEpoch: waiting.workerEpoch, validateWork: () => { throw Object.assign(Error('revoked'), { status: 403 }); } });
    assert.equal(revoked.claimed, false);
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM hub_elastic_work_slots WHERE account_id=?', ['W']))[0][0].n, 0);
    await database.query('maintenance', INGEST_PROTOCOL_SCHEMA);
    const requestId = 'elastic-ingest-request-0000', owner = 'plugin-ingest';
    const id = createHash('sha256').update(JSON.stringify([owner, requestId])).digest('hex');
    await pool.query("INSERT INTO hub_ingest_requests VALUES(?,?,?,'queued',?,NULL)", [id, owner, 'a'.repeat(64), new Date().toISOString()]);
    const upload = await repo.enqueue({ accountId: 'I', storeId: 'store8', direction: 'ingest', spuId: 'p9', requestId: id,
        runId: requestId, executionRunId: requestId, actorId: owner, ownershipGeneration: 'generation' });
    assert.equal((await claim(upload)).claimed, true);
    await createIngestProtocol({ database, elastic }).cancel(owner, requestId);
    assert.equal((await repo.workOf(upload.work_id)).status, 'cancelled');
    assert.equal((await pool.query('SELECT COUNT(*) AS n FROM hub_elastic_work_slots WHERE account_id=?', ['I']))[0][0].n, 0);
    await assertElasticWorkSlotsReady(database);
    console.log('PASS 并发不超额、续片撤权释放、上传取消释放');
    console.log('PASS elastic slots: borrow/return/epochs/unknown/decrease/store-lock/account-isolation/migration');
} finally { await pool.end(); await isolated.drop(); }
