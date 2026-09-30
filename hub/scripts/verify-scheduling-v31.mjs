/** 仅在33917随机新库验证200店排队和许可上限，不连接TEMU或生产服务。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
import { createSchedulingController } from '../lib/scheduling.mjs';
import { createIngestProtocol } from '../lib/ingest-protocol.mjs';
import { createIngestAdmission } from '../lib/ingest-admission.mjs';
import { createStore } from '../lib/store.mjs';
const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33917, user: 'root' });
const name = `temu_sched_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root = await mkdtemp(path.join(tmpdir(), 'temu-sched-'));
const config = path.join(root, 'mysql.json');
await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: name }));
const db = await openMysqlDatabase(config);
let success = false, now = 0;
const scheduler = createSchedulingController({ now: () => now });
try {
    await initializeMysqlSchema(db);
    const products = Array.from({ length: 12 }, (_, i) => ({ spuId: String(9000000000 + i), publicationData: { sourceProduct: { productId: String(9000000000 + i) } } }));
    const store = { getBatch: async () => ({ sourceStoreId: 'source', products }), listOverview: async () => ({ products }), verifyBatchTransfer: async (_b, p) => p };
    const queue = createJobQueue(root, store, { database: db, scheduler });
    const requests = [], identities = [];
    for (let i = 0; i < 200; i++) {
        const identity = { storeId: `temu:${100000 + i}`, mallId: String(100000 + i), pluginInstanceId: `instance-${i}`, storeName: `测试店${i}`, pageStoreName: `测试店${i}`, executionMode: 'plugin-api', pluginVersion: '10.10.59', schedulingProtocol: 1, identityMatched: true, pluginDetected: true };
        identities.push(identity); await queue.registerAgent(identity);
        await queue.createJob({ sourceStoreId: 'source', sourceBatchId: 'fixture', spuIds: products.map(p => p.spuId), targetStoreId: identity.storeId, targetStoreName: identity.storeName, directCreate: true, requireOnline: true, complianceVersion: 'V2.0' });
        let tasks = (await queue.claimJobs({ ...identity, manualUploadsOnly: true, pendingUploadCount: 0, inventoryComplete: true, heldTasks: [] })).claimed;
        assert.equal(tasks.length, 10);
        const task = tasks[0];
        await queue.reportProgress({ ...identity, jobId: task.jobId, spuId: task.spuId, claimToken: task.claimToken, status: 'received', snapshotSha256: task.transferIntegrity.sha256 });
        if (i === 0) {
            const replacement = (await queue.claimJobs({ ...identity, manualUploadsOnly: true, pendingUploadCount: 0, inventoryComplete: true, heldTasks: [] })).claimed.find(t => t.spuId === task.spuId);
            assert.ok(replacement); assert.notEqual(replacement.claimToken, task.claimToken);
            Object.assign(task, replacement);
            await queue.reportProgress({ ...identity, jobId: task.jobId, spuId: task.spuId, claimToken: task.claimToken, status: 'received', snapshotSha256: task.transferIntegrity.sha256 });
        }
        requests.push({ ...identity, jobId: task.jobId, spuId: task.spuId, claimToken: task.claimToken, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: crypto.randomUUID() });
    }
    // 建立数据后续心跳，测试构建耗时不能被误认为店铺离线。
    for (const identity of identities) await queue.registerAgent(identity);
    const results = [];
    for (let offset = 0; offset < requests.length; offset += 20) results.push(...await Promise.all(requests.slice(offset, offset + 20).map(input => queue.directProgress(input))));
    assert.equal(results.filter(r => r.attemptId).length, 4);
    assert.equal(results.filter(r => r.state === 'waiting').length, 196);
    const activeIndex = results.findIndex(r => r.attemptId), active = requests[activeIndex];
    const recovery = await queue.claimJobs({ ...identities[activeIndex], pendingUploadCount: 0, inventoryComplete: true, heldTasks: [] });
    assert.ok(!recovery.claimed.some(t => t.spuId === active.spuId && t.jobId === active.jobId), '发过许可后不能重新交付');
    for (let n = 0; n < 4; n++) { now += 61000; scheduler.demand(); scheduler.sample({}); }
    assert.equal(scheduler.snapshot().limit, 8);
    const [waiting] = await db.query('query', 'SELECT store_id FROM hub_execution_wait ORDER BY requested_at,store_id LIMIT 4');
    for (const row of waiting) assert.ok((await queue.directProgress(requests.find(r => r.storeId === row.store_id))).attemptId);
    const [[count]] = await db.query('query', "SELECT COUNT(*) AS n FROM hub_job_items WHERE direct_state='creating'");
    assert.equal(Number(count.n), 8);
    now += 31000; scheduler.sample({ feedbackPending: 20 });
    assert.equal(scheduler.snapshot().paused, true); assert.equal(scheduler.snapshot().limit, 4);
    assert.equal((await queue.directProgress(requests[199])).state, 'waiting');
    const admission = createIngestAdmission({ waitMs: 5 });
    const protocol = createIngestProtocol({ database: db, admission });
    const input = { requestId: crypto.randomUUID(), sha256: 'b'.repeat(64), bytes: 100, storeId: 'temu:100000' };
    const prepared = await protocol.prepare('fixture-owner', input);
    await assert.rejects(protocol.consume('stranger', prepared.token, 100), /expired/);
    const lease = await protocol.consume('fixture-owner', prepared.token, 100);
    await protocol.begin(lease, input.sha256);
    assert.equal((await protocol.prepare('fixture-owner', input)).scheduling.action, 'reconcile');
    // 真正库存事务的校验失败必须回滚商品和回执，成功提交则两者同时可见。
    const inventory = createStore(root, { database: db }); await inventory.ensure();
    const capture = [{ originalName: 'fixture.json', payload: { kind: 'full-capture-packet', source: { sourceStoreId: 'temu:100000' }, records: [{ payload: { result: { pageItems: [{ productId: '6000000001', productName: '合成商品', extCode: 'fixture' }] } } }] } }];
    await assert.rejects(inventory.importFiles(capture, { sourceStoreId: 'temu:100000', ingestRequestId: lease.id, confirmIngest: async () => { throw Error('核验失败'); } }), /核验失败/);
    const [[rolledBack]] = await db.query('query', 'SELECT COUNT(*) AS n FROM hub_products');
    assert.equal(Number(rolledBack.n), 0);
    const result = await inventory.importFiles(capture, { sourceStoreId: 'temu:100000', ingestRequestId: lease.id, confirmIngest: async result => ({ ok: true, batchId: result.batch.id }) });
    lease.finish();
    assert.equal((await protocol.prepare('fixture-owner', input)).receipt.batchId, result.batch.id);
    await assert.rejects(protocol.prepare('fixture-owner', { ...input, sha256: 'c'.repeat(64) }), /conflict/);
    const restartInput = { ...input, requestId: crypto.randomUUID() };
    const restartPermit = await protocol.prepare('fixture-owner', restartInput);
    const restartLease = await protocol.consume('fixture-owner', restartPermit.token, 100);
    await protocol.begin(restartLease, restartInput.sha256); restartLease.finish();
    const reboot = createIngestProtocol({ database: db, admission });
    assert.equal((await reboot.prepare('fixture-owner', restartInput)).state, 'reconciling');
    const reissued = await reboot.prepare('fixture-owner', restartInput);
    assert.equal(reissued.state, 'ready'); (await reboot.consume('fixture-owner', reissued.token, 100)).finish();
    success = true;
    console.log(JSON.stringify({ passed: true, stores: 200, initialActive: 4, waiting: 196, maxActive: 8, lostSnapshotRecovered: true, atomicIngestReceipt: true, realPlatformRequests: 0 }));
} finally {
    scheduler.stop(); await db.close();
    if (success) await admin.query(`DROP DATABASE ${name}`);
    else console.error('保留隔离测试库', name);
    await admin.end();
}
