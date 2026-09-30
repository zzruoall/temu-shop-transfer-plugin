/** 隔离验证接收预算、断开释放、入库读写与发布许可；不连接真实平台。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIngestAdmission } from '../lib/ingest-admission.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
import { createStore } from '../lib/store.mjs';

const gate = createIngestAdmission({ limit: 2, maxBytes: 10, waitMs: 100 });
const one = await gate.acquire(6);
const abort = new AbortController();
const waiting = gate.acquire(6, abort.signal);
assert.equal(gate.snapshot().pending, 1);
abort.abort();
await assert.rejects(waiting, /upload_aborted/);
const two = await gate.acquire(4);
assert.equal(gate.snapshot().active, 2);
await assert.rejects(gate.acquire(1), /ingest_capacity_wait/);
await assert.rejects(gate.acquire(11), /too_large/);
one(); one(); two();
assert.equal(gate.snapshot().active, 0);
assert.equal(gate.snapshot().bytes, 0);

const root = await mkdtemp(path.join(tmpdir(), 'temu-concurrency-unit-'));
const store = createStore(root);
await Promise.all(Array.from({ length: 10 }, () => store.ensure()));
/** 并行查询必须只见完整版本；返回对象被调用方修改也不得污染缓存。 */
const upload = n => store.importFiles([{ originalName: `unit-${n}.json`, payload: {
    kind: 'full-capture-packet', source: { sourceStoreId: `source-${n}` },
    records: [{ payload: { result: { pageItems: [{ productId: 8000000000 + n, goodsId: 9000000000 + n, productName: `unit-${n}` }] } } }]
}}], { sourceStoreId: `source-${n}` });
await Promise.all([
    ...Array.from({ length: 15 }, (_, n) => upload(n)),
    ...Array.from({ length: 3 }, async () => {
        for (let n = 0; n < 25; n++) {
            const overview = await store.listOverview();
            assert.equal(overview.productCount, overview.products.length);
            overview.products.length = 0;
        }
    })
]);
assert.equal((await store.listOverview()).productCount, 15);

const products = Array.from({ length: 3 }, (_, n) => ({ spuId: String(9100000000 + n), ready: true, title: 'old-title', images: ['https://invalid/a'], skuIds: ['1'], skcIds: ['2'] }));
const queue = createJobQueue(root, { getBatch: async () => ({ sourceStoreId: 'source', products }), listOverview: async () => ({ products: [] }) });
const cases = [];
for (let n = 0; n < 4; n++) {
    const identity = { storeId: `temu:${700000 + n}`, mallId: String(700000 + n), executionMode: 'plugin-api',
        storeName: `Target ${n}`, pageStoreName: `Target ${n}`, pluginInstanceId: `test-instance-${n}`,
        pluginVersion: '10.10.53', pluginDetected: true, identityMatched: true };
    await queue.registerAgent(identity);
    const job = await queue.createJob({ sourceStoreId: 'source', sourceBatchId: 'batch', targetStoreId: identity.storeId,
        targetStoreName: identity.storeName, spuIds: products.map(p => p.spuId), requireOnline: true, directCreate: true, complianceVersion: 'V2.0' });
    const claimed = (await queue.claimJobs({ ...identity, claimManualUploads: true })).claimed;
    for (const item of claimed) await queue.reportProgress({ ...identity, jobId: job.id, spuId: item.spuId, claimToken: item.claimToken, status: 'received' });
    cases.push({ identity, job, claimed });
}
const begin = (entry, index = 0) => ({ ...entry.identity, jobId: entry.job.id, spuId: entry.claimed[index].spuId,
    claimToken: entry.claimed[index].claimToken, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: `authorization-${entry.identity.mallId}-${index}` });
const first = await Promise.all(cases.map(entry => queue.directProgress(begin(entry)).then(result => result, error => ({ error }))));
assert.equal(first.filter(result => result.attemptId).length, 3);
assert.equal(first.filter(result => result.error?.message === 'direct_capacity_wait').length, 1);
await assert.rejects(queue.directProgress(begin(cases[0], 1)), /direct_capacity_wait/);
await queue.directProgress({ ...begin(cases[0]), phase: 'unknown', attemptId: first[0].attemptId, reason: '模拟网络超时' });
await assert.rejects(queue.directProgress(begin(cases[3])), /direct_capacity_wait/);
await queue.directProgress({ ...begin(cases[0]), phase: 'created', attemptId: first[0].attemptId, productId: '8888888888', verified: true });
assert.ok((await queue.directProgress(begin(cases[3]))).attemptId);
// 后续入库版本变化不能改写已经排队的商品快照。
products[0].title = 'new-title';
const state = JSON.parse(await readFile(path.join(root, 'data', 'jobs.json'), 'utf8'));
assert.equal(state.jobs.find(job => job.id === cases[0].job.id).items[0].snapshot.title, 'old-title');
console.log('PASS: admission budget/abort/timeout, atomic index reads/cache isolation, global 3/store 1 publish, unknown hold, late receipt, immutable snapshots');
