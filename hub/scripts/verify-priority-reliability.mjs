/** 临时仓库与模拟扩展验证关键恢复边界；不连接生产数据库或 TEMU。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createJobQueue } from '../lib/job-queue.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'temu-priority-reliability-'));
const products = ['1234567890', '1234567891', '1234567892'].map(spuId => ({ spuId, ready: false, publicationData: { sourceProduct: { productId: spuId } } }));
let blockedWrites = 0;
const store = { getBatch: async () => ({ sourceStoreId: 'temu:111', products }),
    listOverview: async () => ({ products: products.map(p => ({ ...p, blocked: true })) }),
    verifyBatchTransfer: async (_batch, list) => list, markProductBlocked: async () => { blockedWrites++; } };
const queue = createJobQueue(root, store);
const identity = { storeId: 'temu:222', storeName: 'target', pageStoreName: 'target', pluginInstanceId: 'reliability-test', pluginVersion: '10.10.56', pluginDetected: true, identityMatched: true, executionMode: 'plugin-api', mallId: '222' };
await queue.registerAgent(identity);
const input = { sourceStoreId: 'temu:111', targetStoreId: identity.storeId, targetStoreName: 'target', sourceBatchId: 'batch', requireOnline: true, directCreate: true, complianceVersion: 'V2.0' };
/** 每个场景领取独立商品，来源红标不能再禁止发给目标店。 */
async function receive(spuId) {
    const job = await queue.createJob({ ...input, spuIds: [spuId] });
    const { claimed } = await queue.claimJobs({ ...identity, claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: 0, pendingUploadBytes: 0 });
    const task = claimed.find(item => item.jobId === job.id);
    assert.ok(task);
    const base = { ...identity, jobId: job.id, spuId, claimToken: task.claimToken, directRetrySequence: 0 };
    await queue.reportProgress({ ...base, status: 'received', snapshotSha256: task.transferIntegrity.sha256 });
    return { base, begin: { ...base, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: crypto.randomUUID() } };
}
const first = await receive(products[0].spuId);
const attempt = await queue.directProgress(first.begin);
await queue.directProgress({ ...first.base, phase: 'transient', attemptId: attempt.attemptId, reason: '网络超时' });
assert.equal((await queue.getJob(first.base.jobId)).items[0].directState, 'unknown');
assert.equal((await queue.directProgress(first.begin)).resumed, true);
const second = await receive(products[1].spuId);
await assert.rejects(queue.directProgress(second.begin), /direct_capacity_wait/);
// 复现旧版本取消后仍带 unknown 的历史记录，仅修改本脚本创建的临时仓库。
const statePath = path.join(root, 'data', 'jobs.json');
const state = JSON.parse(await readFile(statePath, 'utf8'));
const old = state.jobs.find(job => job.id === first.base.jobId);
old.status = 'cancelled'; old.items[0].status = 'cancelled';
await writeFile(statePath, JSON.stringify(state));
await assert.rejects(queue.directProgress({ ...first.base, phase: 'created', attemptId: attempt.attemptId, productId: '9000000001', verified: true }), /取消/);
const secondAttempt = await queue.directProgress(second.begin);
const rejected = { ...second.base, phase: 'preflight_failed', attemptId: secondAttempt.attemptId, reason: '该目标店不接受属性', receiptId: crypto.randomUUID() };
await queue.directProgress(rejected);
assert.equal((await queue.directProgress(rejected)).acknowledged, true);
await assert.rejects(queue.directProgress({ ...rejected, reason: '改变回执内容' }), /绑定其他结果/);
assert.equal(blockedWrites, 0);
// 执行前失败也必须能在响应丢失后补报，不能因服务端已经进入终态而卡死。
const third = await receive(products[2].spuId);
const failed = { ...third.base, phase: 'preflight_failed', reason: '来源字段转换丢失', receiptId: crypto.randomUUID() };
await queue.directProgress(failed);
assert.equal((await queue.directProgress(failed)).acknowledged, true);

const memory = {}, requests = [], logs = [];
let online = false, dropResponse = true, now = Date.now();
const outbox = await readFile(new URL('../../plugin/direct-receipts.js', import.meta.url), 'utf8');
/** 模拟重启时保留 storage，丢弃内存队列；模拟网络请求仅调用上面的临时仓库。 */
function boot() {
    const context = vm.createContext({ crypto, Date: class extends Date { static now() { return now; } },
        chrome: { alarms: { create: async () => {} }, storage: { local: {
            get: async key => structuredClone(key === null ? memory : { [key]: memory[key] }),
            set: async values => Object.assign(memory, structuredClone(values)), remove: async key => { delete memory[key]; }
        } } }, TemuOperationLog: { append: async value => { logs.push(value); } },
        hubJson: async (_url, body) => {
            requests.push(body); if (!online) throw Error('offline');
            const reply = await queue.directProgress(body);
            if (dropResponse) { dropResponse = false; throw Error('response_lost'); }
            return reply;
        } });
    vm.runInContext(outbox, context);
    return context.TemuDirectReceipts;
}
let receipts = boot();
const fourth = await receive(products[0].spuId);
const pending = await receipts.send({ ...fourth.base, phase: 'preflight_failed', reason: '转换失败' });
assert.equal(pending.pending, true);
assert.equal(Object.keys(memory).length, 1);
const receiptId = Object.values(memory)[0].body.receiptId;
receipts = boot(); online = true; now += 41000;
await receipts.flush();
assert.equal(Object.keys(memory).length, 1, '服务端已提交但响应丢失，必须保留原回执');
assert.equal(Object.values(memory)[0].body.receiptId, receiptId);
receipts = boot(); now += 71000;
await receipts.flush();
assert.equal(Object.keys(memory).length, 0);
assert.ok(receiptId);
await assert.rejects(receipts.send({ phase: 'begin' }), /不允许/);

const context = vm.createContext({ window: {} });
vm.runInContext(await readFile(new URL('../../plugin/direct-source-preservation.js', import.meta.url), 'utf8'), context);
const preserve = context.window.__temuSourcePreservation;
assert.equal(preserve({ productId: '1', custom: {} }, {}), true, '不把缺标题、SKU的结构当成固定门槛');
const source = { productName: 'test', carouselImageUrls: ['a'], productSkcList: [{ extCode: 'P', productSkuList: [{ extCode: 'S', supplierPrice: 0, thumbUrl: 'x', productSkuSpecList: [{ specId: 1 }], productSkuMultiPack: { productSkuNetContent: { netContentNumber: 10, netContentUnitCode: 2 } } }] }] };
const request = { productName: 'test', carouselImageUrls: ['a'], productSkcReqs: [{ extCode: 'P', productSkuReqs: [{ extCode: 'S', supplierPrice: '0', thumbUrl: 'x', productSkuSpecReqs: [{ specId: 1 }], productSkuMultiPackReq: { productSkuNetContentReq: { netContentNumber: 10, netContentUnitCode: 2 } } }] }] };
assert.equal(preserve(source, request), true);
for (const mutate of [r => { r.productSkcReqs[0].extCode = ''; }, r => { r.carouselImageUrls = []; }, r => { delete r.productSkcReqs[0].productSkuReqs[0].supplierPrice; }, r => { delete r.productSkcReqs[0].productSkuReqs[0].productSkuMultiPackReq; }]) {
    const broken = structuredClone(request); mutate(broken); assert.throws(() => preserve(source, broken), /丢失或改变/);
}
console.log(JSON.stringify({ passed: true, cancelledDoesNotOccupy: true, unknownNeverResubmitted: true, receiptsIdempotent: true, noGlobalBlock: true, preservesPresentFields: true, realPlatformRequests: 0, temporaryRoot: root }));
