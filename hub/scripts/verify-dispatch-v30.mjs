/** 只连接隔离MySQL实例和合成资料，覆盖离线等待、坏商品隔离、恢复幂等与改名身份边界。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
import { createBulkDispatch } from '../lib/bulk-dispatch.mjs';
import { taskIdentityMatches } from '../lib/store-names.mjs';
import { createStore } from '../lib/store.mjs';

const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33917, user: 'root' });
const name = `temu_test_v30_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root = await mkdtemp(path.join(tmpdir(), 'temu-v30-'));
const config = path.join(root, 'mysql.json');
await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: name }));
const db = await openMysqlDatabase(config);
let success = false;
try {
    await initializeMysqlSchema(db);
    const products = Array.from({ length: 55 }, (_, n) => ({ spuId: String(8100000000 + n), publicationData: { sourceProduct: { productId: String(8100000000 + n) } } }));
    const badIds = new Set(products.slice(0, 21).map(product => product.spuId));
    let broken = false, denied = false, loseResponse = true;
    const store = {
        getBatch: async () => ({ sourceStoreId: 'source', products }), listOverview: async () => ({ products }),
        verifyBatchTransfer: async (_batch, items) => {
            if (broken && items.some(item => badIds.has(item.spuId))) throw Object.assign(Error('合成原包不一致'), { status: 422 });
            return items;
        }
    };
    const queue = createJobQueue(root, store, { database: db });
    const identity = { storeId: 'temu:700099', mallId: '700099', storeName: '原名称', pageStoreName: '原名称', executionMode: 'plugin-api', pluginInstanceId: 'fixture-instance', pluginVersion: '10.10.58', pluginDetected: true, identityMatched: true };
    const authorize = async () => { if (denied) throw Object.assign(Error('已撤销权限'), { status: 403 }); return null; };
    const makeWorker = () => createBulkDispatch({ database: db, store, authorize, queue: { createJob: async (...args) => {
        const result = await queue.createJob(...args);
        if (loseResponse) { loseResponse = false; throw Error('已提交但回执丢失'); }
        return result;
    },
    // 清单提交会核对目标店的页面轮次，桩必须转发到真实队列。
    listAgents: (...args) => queue.listAgents(...args) } });
    let bulk = makeWorker();
    const input = { requestId: crypto.randomUUID(), complianceVersion: 'V2.0', groups: [{ sourceStoreId: 'source', sourceBatchId: 'batch', spuIds: products.map(product => product.spuId) }], targets: [{ storeId: identity.storeId, storeName: identity.storeName }] };
    const plan = await bulk.submit(input, '');
    /** 测试中推进退避窗口，但不修改业务游标、分片、计数和租约。 */
    async function step(id) {
        const [[row]] = await db.query('query', 'SELECT state FROM hub_bulk_dispatch WHERE id=?', [id]);
        const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
        for (const target of state.targets) target.nextAt = '';
        await db.query('maintenance', "UPDATE hub_bulk_dispatch SET state=?,next_run_at='' WHERE id=?", [JSON.stringify(state), id]);
        await bulk.tick();
    }
    for (let n = 0; n < 12; n++) await step(plan.id);
    const waiting = await bulk.get(plan.id, '');
    assert.equal(waiting.status, 'queued'); assert.equal(waiting.targets[0].attempts, 0);
    assert.equal(waiting.targets[0].paused, false); assert.equal(waiting.sent, 0);
    assert.equal(waiting.targets[0].errorCode, 'target_offline');
    await queue.registerAgent(identity);
    broken = true;
    for (let n = 0; n < 130; n++) {
        await step(plan.id); bulk = makeWorker();
        if ((await bulk.get(plan.id, '')).status === 'completed_errors') break;
    }
    const final = await bulk.get(plan.id, '');
    assert.equal(final.status, 'completed_errors'); assert.equal(final.failed, 21); assert.equal(final.sent, 34);
    const [[count]] = await db.query('query', 'SELECT COUNT(*) AS n FROM hub_jobs');
    assert.equal(Number(count.n), final.jobs, '已提交分片丢回执并重启后不能重复建任务');
    assert.equal(final.failureSamples.length, 20);
    const page1 = await bulk.failures(plan.id, '', 0), page2 = await bulk.failures(plan.id, '', 20);
    assert.equal(page1.hasMore, true); assert.equal(page2.failures.length, 1); assert.equal(page2.hasMore, false);
    assert.equal(new Set([...page1.failures, ...page2.failures].map(item => item.spuId)).size, 21);
    await assert.rejects(bulk.failures(plan.id, 'other-owner'), /不存在/);
    await assert.rejects(bulk.control(plan.id, 'resume', ''), /已结束/);
    // 店名是展示信息；同商城改名能领取、恢复和执行，错误商城及实例仍不能获得创建许可。
    const renamed = { ...identity, storeName: '全新店铺名字', pageStoreName: '全新店铺名字' };
    await queue.registerAgent(renamed);
    const claimed = (await queue.claimJobs({ ...renamed, claimManualUploads: true, manualUploadsOnly: true, maxTasks: 1 })).claimed[0];
    assert.ok(claimed, '改名后仍应能领取历史名称的任务');
    const base = { ...renamed, jobId: claimed.jobId, spuId: claimed.spuId, claimToken: claimed.claimToken };
    await queue.reportProgress({ ...base, status: 'received', snapshotSha256: claimed.transferIntegrity.sha256 });
    const recovered = await queue.claimJobs({ ...renamed, pendingUploadCount: 30, receivedReceipts: [{ jobId: claimed.jobId, spuId: claimed.spuId, claimToken: claimed.claimToken, directRetrySequence: 0, snapshotSha256: claimed.transferIntegrity.sha256 }] });
    assert.ok(recovered.receivedReceipts.some(item => item.spuId === claimed.spuId), '已收件应可恢复');
    const begin = { ...base, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: crypto.randomUUID() };
    await assert.rejects(queue.directProgress({ ...begin, mallId: '700098' }), /身份|商城/);
    await assert.rejects(queue.directProgress({ ...begin, pluginInstanceId: 'wrong-instance' }), /身份|实例/);
    assert.ok((await queue.directProgress(begin)).attemptId);
    assert.equal(taskIdentityMatches({ targetStoreId: identity.storeId, targetStoreName: '原名称', directCreate: true }, renamed, { mallId: '0' }), false);
    assert.equal(taskIdentityMatches({ targetStoreId: identity.storeId, targetStoreName: '原名称', directCreate: false }, renamed), false);
    assert.equal(await queue.resolveIngestSource({ ...renamed, mallId: '0' }), null);
    assert.equal((await queue.resolveIngestSource(renamed)).sourceStoreId, identity.storeId);
    const forbidden = await bulk.submit({ ...input, requestId: crypto.randomUUID() }, '');
    denied = true; await step(forbidden.id); denied = false;
    const blocked = await bulk.get(forbidden.id, '');
    assert.equal(blocked.status, 'paused'); assert.equal(blocked.failed, 0);
    assert.equal(blocked.targets[0].parts, undefined, '权限错误不能以拆分商品方式绕过');
    // 收集异常模式必须保留同包的有效商品，严格创建模式则仍应遇错拒绝。
    const realStore = createStore(root, { database: db }); await realStore.ensure();
    await realStore.importFiles([{ originalName: 'detail.json', payload: { kind: 'full-capture-packet', schemaVersion: 5,
        source: { sourceStoreId: 'detail-source' }, products: [{ spuId: '6000000999' }], records: [{ dataType: 'product-detail',
            identity: { productIds: ['6000000999'] }, source: { pageProductId: '6000000999', requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
            payload: { success: true, result: { productId: '6000000999', productName: 'detail' } } }] } }], { sourceStoreId: 'detail-source' });
    const [[batchRow]] = await db.query('query', 'SELECT id FROM hub_batches WHERE store_id=? LIMIT 1', ['detail-source']);
    const saved = await realStore.getBatch(batchRow.id);
    const mixed = [...saved.products, { spuId: '9999999999' }];
    const checked = await realStore.verifyBatchTransfer(saved, mixed, { collectErrors: true });
    assert.equal(checked.products.length, 1); assert.equal(checked.errors.length, 1);
    await assert.rejects(realStore.verifyBatchTransfer(saved, mixed), /不在来源原包/);
    success = true;
    console.log(JSON.stringify({ passed: true, offlineRetries: 12, sent: 34, isolatedFailures: 21, restartIdempotency: true, renamedMall: true, realPlatformRequests: 0 }));
} finally {
    await db.close();
    if (success) await admin.query(`DROP DATABASE ${name}`);
    else console.error('保留隔离测试库', name);
    await admin.end();
}
