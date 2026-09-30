/** 真实fork、SQL队列、插件领取与回执闭环；只使用33917随机库，不调用平台。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { initializeElasticWorkSlots, assertElasticWorkSlotsReady, assertElasticDisabledSafe } from '../lib/elastic-work-slots.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
import { createAccountRuntime } from '../lib/account-runtime.mjs';
import { createAccountPublishBridge } from '../lib/account-publish-bridge.mjs';
import { createIngestStaging } from '../lib/ingest-staging.mjs';
import { openIsolatedDatabase } from './account-process-harness.mjs';

const isolated = await openIsolatedDatabase({ prefix: 'temu_elastic_runtime', label: '弹性真实发布闭环' });
const pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 4 });
const root = await mkdtemp(path.join(tmpdir(), 'ziniao-elastic-runtime-'));
let runtime, failSql = '', limit = 2;
const trace = [];
const elastic = { snapshot: () => ({ businessLimit: limit, perAccountLimit: limit, processLimit: limit ? 1 : 0, publishLimit: limit }) };
const database = {
    query: (_lane, sql, params = []) => pool.query(sql, params),
    async withConnection(_lane, action) { const c = await pool.getConnection(); try { return await action(c); } finally { c.release(); } },
    async transaction(_lane, action) {
        const c = await pool.getConnection();
        try {
            await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED'); await c.beginTransaction();
            const result = await action({ query(sql, params = []) {
                if (failSql && sql.includes(failSql)) throw Error('injected_failure');
                return c.query(sql, params);
            } });
            await c.commit(); return result;
        } catch (error) { await c.rollback(); throw error; } finally { c.release(); }
    }
};
const hub = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
/** 只等待真实因果事件，不直接claim/settle代替运行器。 */
async function until(action, title) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    throw Error(`${title}: ${JSON.stringify(trace.slice(-12))}`);
}
try {
    await initializeMysqlSchema(database); await migrateAccountExecution(database);
    await initializeElasticWorkSlots(database);
    const staging = createIngestStaging({ dataRoot: root });
    const bridge = createAccountPublishBridge({ database, staging, elastic, maxUnsettledPublishes: 2 });
    const products = [{ spuId: '100001', title: 'test', ready: true, images: [], publicationData: { sourceProduct: { productId: '100001' } } }];
    const store = { getBatch: async id => ({ sourceStoreId: `temu:source-${id}`, products }), listOverview: async () => ({}), verifyBatchTransfer: async (_batch, items) => items };
    const queue = createJobQueue(root, store, { database, accountExecution: bridge });
    const identities = {}, owners = { A: 'owner-A', A2: 'owner-A', A3: 'owner-A', B: 'owner-B' };
    for (const [index, name] of ['A', 'A2', 'A3', 'B'].entries()) {
        const mall = String(123456 + index);
        for (const storeId of [`temu:${mall}`, `temu:source-${name}`]) await pool.query("INSERT INTO hub_map_entries(domain,entry_key,body) VALUES('ownership',?,?)",
            [storeId, JSON.stringify({ ownerId: owners[name], claimedAt: '2026-09-28T00:00:00.000Z' })]);
        const identity = { storeId: `temu:${mall}`, mallId: mall, storeName: name, pageStoreName: name,
            pluginInstanceId: `plugin-${name}`, pluginVersion: '10.10.68', pluginDetected: true, identityMatched: true,
            executionMode: 'plugin-api', executionRunProtocol: 1, schedulingProtocol: 1, executionRunId: `real-elastic-run-${name}-0000` };
        await queue.registerAgent(identity); await queue.controlExecutionRun({ ...identity, action: 'start', previousRunId: '' });
        identities[name] = identity;
    }
    const create = (name, suffix = '0000') => queue.createJob({ sourceStoreId: `temu:source-${name}`, targetStoreId: identities[name].storeId, targetStoreName: name,
        sourceBatchId: name, spuIds: ['100001'], requireOnline: true, directCreate: true, complianceVersion: 'V2.0', clientRequestId: `elastic-request-${name}-${suffix}` }, { userId: owners[name] });
    const work = async job => (await pool.query('SELECT * FROM hub_account_work WHERE job_id=?', [job.id]))[0][0];
    const slots = async () => (await pool.query('SELECT * FROM hub_elastic_work_slots'))[0];
    const runtimeOptions = { database, elastic, sourceRoot: root, workerPath: path.join(hub, 'workers/account-worker.mjs'), maxAccountProcesses: 1,
        validateWork: (c, w) => bridge.validateWork(c, w), onPrepared: args => bridge.onPrepared(args), onFailure: args => bridge.onFailure(args),
        onTrace: (type, fields) => trace.push({ type, ...fields }) };
    runtime = createAccountRuntime(runtimeOptions);
    async function prepare(job) {
        await until(async () => { await runtime.scanOnce(); return Number((await queue.getJob(job.id)).items[0].accountWork?.preparedEpoch) > 0; }, '未完成真实准备');
        await until(async () => Number((await pool.query("SELECT COUNT(*) AS n FROM hub_process_leases WHERE state IN ('reserved','live')"))[0][0].n) === 0, '准备进程没有退出');
    }
    async function receive(name, job) {
        const response = await queue.claimJobs({ ...identities[name], claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: 0, pendingUploadBytes: 0 });
        assert.equal(response.claimed.length, 1);
        const item = response.claimed[0], base = { ...identities[name], jobId: job.id, spuId: item.spuId, claimToken: item.claimToken };
        await queue.reportProgress({ ...base, status: 'received', snapshotSha256: item.transferIntegrity.sha256 });
        return base;
    }
    const begin = base => queue.directProgress({ ...base, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: `authorization-${base.mallId}-0000` });
    const finish = (base, attempt) => queue.directProgress({ ...base, phase: 'created', attemptId: attempt.attemptId, productId: '88888888', verified: true });
    const a = await create('A'); await prepare(a);
    const a2 = await create('A2'); await prepare(a2);
    assert.equal((await slots()).length, 2);
    assert.notEqual((await queue.getJob(a.id)).items[0].accountWork.preparedEpoch, (await queue.getJob(a2.id)).items[0].accountWork.preparedEpoch);
    const aBase = await receive('A', a), a2Base = await receive('A2', a2);
    const aAttempt = await begin(aBase), a2Attempt = await begin(a2Base);
    assert.ok(aAttempt.attemptId && a2Attempt.attemptId);
    console.log('PASS 同账户两店真实fork准备、退出、独立领取与平台许可');
    await queue.directProgress({ ...aBase, phase: 'unknown', attemptId: aAttempt.attemptId });
    await assertElasticWorkSlotsReady(database);
    // 仅测试库注入损坏代次：启动检查必须在收到旧店成功回执前发现冲突。
    const original = (await slots())[0];
    await pool.query('UPDATE hub_elastic_work_slots SET worker_epoch=worker_epoch+1 WHERE work_id=?', [original.work_id]);
    await assert.rejects(assertElasticWorkSlotsReady(database), /elastic_slot_epoch_conflict/);
    await pool.query('UPDATE hub_elastic_work_slots SET worker_epoch=? WHERE work_id=?', [original.worker_epoch, original.work_id]);
    await assert.rejects(assertElasticDisabledSafe(database), /drained_work/);
    // 新建桥接模拟服务对象重建；持久槽而非内存绑定保存原回执资格。
    const restarted = createAccountPublishBridge({ database, staging, elastic, maxUnsettledPublishes: 2 });
    const restoredQueue = createJobQueue(root, store, { database, accountExecution: restarted });
    assert.equal((await restoredQueue.getJob(a.id)).items[0].directState, 'unknown');
    await runtime.stop();
    // 仅测试库模拟原领导租期到期，新运行器没有之前的bindings内存。
    await pool.query("UPDATE hub_process_control SET heartbeat_at='2000-01-01T00:00:00.000Z' WHERE id=1");
    runtime = createAccountRuntime(runtimeOptions);
    const a3 = await create('A3'), b = await create('B');
    await runtime.scanOnce();
    assert.equal((await work(b)).status, 'queued');
    failSql = 'DELETE FROM hub_elastic_work_slots';
    try { await assert.rejects(finish(a2Base, a2Attempt), /injected_failure/); } finally { failSql = ''; }
    assert.equal((await slots()).length, 2);
    assert.equal((await work(a2)).status, 'running');
    await finish(a2Base, a2Attempt);
    await prepare(b);
    assert.equal((await work(a3)).status, 'queued', '新账户获得释放的名额，原账户不能续借');
    console.log('PASS unknown保留、终态整体回滚、新账户优先、旧代次不影响新店');
    const bBase = await receive('B', b), bAttempt = await begin(bBase);
    limit = 0;
    await runtime.scanOnce();
    assert.equal((await work(a3)).status, 'queued');
    await restoredQueue.directProgress({ ...aBase, phase: 'created', attemptId: aAttempt.attemptId, productId: '99999999', verified: true });
    await finish(bBase, bAttempt);
    assert.equal((await slots()).length, 0);
    await assertElasticDisabledSafe(database);
    limit = 2;
    await prepare(a3);
    await queue.cancelJob(a3.id, { userId: 'owner-A' });
    assert.equal((await slots()).length, 0);
    const revoked = await create('A3', 'newclick'); await prepare(revoked);
    await pool.query("UPDATE hub_map_entries SET body=? WHERE domain='ownership' AND entry_key=?",
        [JSON.stringify({ ownerId: 'other-owner', claimedAt: '2026-09-29T00:00:00.000Z' }), identities.A3.storeId]);
    await runtime.scanOnce();
    assert.equal((await work(revoked)).status, 'failed');
    assert.equal((await slots()).length, 0, '准备完成后撤权不能残留业务槽');
    assert.ok(trace.filter(e => e.type === 'process:fork').length >= 4);
    console.log('PASS 降载不打断原回执、运行器重建、恢复后继续、取消与撤权释放；真实平台调用0');
} finally { await runtime?.stop(); await pool.end(); await isolated.drop(); await rm(root, { recursive: true, force: true }); }
