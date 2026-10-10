/** 资质搬运全部使用合成材料与内存平台，禁止在真实店铺提交资质或创建商品。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { canonicalProductSnapshot } from '../lib/job-queue.mjs';
import { parseQualificationRecord, readQualificationAsset } from '../lib/product-qualifications.mjs';
import { qualificationRecord, qualificationSnapshot, spuId } from './qualification-fixture.mjs';
const paths = name => new URL(`../../plugin/${name}.js`, import.meta.url);
const transferCode = await readFile(paths('qualification-transfer'), 'utf8');
const executorCode = await readFile(paths('qualification-executor'), 'utf8');
const pageCode = await readFile(paths('qualification-page'), 'utf8');
const bytes = Buffer.from('%PDF-1.7\nqualification-fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sourceUrl = 'https://bstatic.kwcdn.com/qualification-fixture.pdf';
const ref = { url: sourceUrl, sha256, bytes: bytes.length, mimeType: 'application/pdf', name: 'fixture.pdf' };
const requirement = { contentType: 1 };
function item(type = 1421) {
    return { certType: type, name: `资质-${type}`, status: 'complete', files: [{ url: sourceUrl, asset: ref }],
        content: { certType: type, certNeedUpload: { certNeedUploadItems: [requirement] }, productCertFiles: [{ fileUrl: sourceUrl, fileName: 'fixture.pdf' }] } };
}
function snapshot(types = [1421], status = 1) {
    return { status: 'complete', items: types.map(type => ({ certType: type, summary: { certType: type, uploadStatus: status }, detail: { certType: type, certNeedUpload: { certNeedUploadItems: [requirement] } } })) };
}
function harness({ target = snapshot(), result = { state: 'submitted' }, pauseAfterUpload = false } = {}) {
    const writes = [], progress = [], platform = [], logs = [];
    let paused = false;
    const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, URL, atob, btoa, Uint8Array,
        setTimeout: fn => setTimeout(fn, 0), clearTimeout,
        readDirectPause: async () => paused ? { paused: true } : null, directStopRequested: new Set(),
        assertExecutionDocument: async () => {}, executionWithDeadline: fn => fn(),
        chrome: { scripting: { executeScript: async () => [] } },
        writeDirectAttempt: async (_task, _key, value) => writes.push(structuredClone(value)),
        rememberDirectProgress: async (_task, value) => progress.push(structuredClone(value)),
        directErrorText: error => error.message || String(error), TemuOperationLog: { append: async entry => logs.push(entry) } });
    vm.runInContext(`${transferCode}\n${executorCode}`, ctx);
    ctx.qualificationAsset = async () => ({ ...ref, dataBase64: bytes.toString('base64') });
    ctx.qualificationPage = async (_tab, operation, _identity, payload) => {
        platform.push({ operation, payload });
        if (operation === 'read') return structuredClone(target);
        if (operation === 'upload') { if (pauseAfterUpload) paused = true; return { state: 'submitting' }; }
        if (operation === 'submit') return { state: 'submitting' };
        if (operation === 'status') return payload.attemptId === platform.findLast(call => call.operation === 'upload')?.payload.attemptId
            ? { state: 'uploaded', url: 'https://img.kwcdn.com/target-private.pdf?sign=TEMP' } : result;
        throw Error(`未实现 ${operation}`);
    };
    const task = { jobId: 'job', spuId, sourceStoreId: 'temu:source', snapshot: { qualifications: { status: 'complete', items: target.items.map(entry => item(entry.certType)) } } };
    const identity = { mallId: '123', storeId: 'temu:123', documentId: 'doc', executionRunId: 'run' };
    const record = { stage: 'qualifying', mallId: '123', productId: '9876543210' };
    return { ctx, writes, progress, platform, logs, task, record, identity,
        run: () => ctx.runDirectQualifications(task, identity, 1, record, 'key') };
}
test('原始归档校验字节和真实材料关联；投递引用不包含附件正文', () => {
    const raw = qualificationSnapshot();
    raw.items[0].detail = item().content;
    raw.assets = [{ ...ref, dataBase64: bytes.toString('base64') }];
    raw.archive = { status: 'complete', errors: [] };
    const parsed = parseQualificationRecord(qualificationRecord(raw));
    assert.equal(parsed.qualifications.archiveStatus, 'complete');
    assert.equal(parsed.qualifications.items[0].files[0].asset.sha256, sha256);
    const canonical = canonicalProductSnapshot({ qualifications: parsed.qualifications });
    assert.doesNotMatch(JSON.stringify(canonical), /dataBase64/);
    const badHash = structuredClone(raw); badHash.assets[0].sha256 = 'a'.repeat(64);
    assert.throws(() => parseQualificationRecord(qualificationRecord(badHash)), /hash/);
    const badMime = structuredClone(raw); badMime.assets[0].mimeType = 'image/png';
    assert.throws(() => parseQualificationRecord(qualificationRecord(badMime)), /MIME/);
    const unrelated = structuredClone(raw); unrelated.assets[0].url = 'https://img.kwcdn.com/other.pdf';
    assert.throws(() => parseQualificationRecord(qualificationRecord(unrelated)), /引用/);
});
test('归档读取只认活跃商品/来源批次，删除或另一个商品不能按哈希读取', async () => {
    const raw = qualificationSnapshot(); raw.items[0].detail = item().content; raw.assets = [{ ...ref, dataBase64: bytes.toString('base64') }];
    const product = { sourceStoreIds: ['temu:source'], batchIds: ['batch'], qualifications: parseQualificationRecord(qualificationRecord(raw)).qualifications };
    const store = { getProduct: async id => id === spuId ? { product, batches: [{ id: 'batch' }] } : null,
        getBatch: async () => ({ id: 'batch', sourceStoreId: 'temu:source', products: [{ spuId }], files: [{ storedName: 'capture.json' }] }),
        readStoredFile: async () => ({ json: { source: { sourceStoreId: 'temu:source' }, records: [qualificationRecord(raw)] } }) };
    const request = { spuId, sha256, sourceStoreId: 'temu:source' };
    assert.deepEqual((await readQualificationAsset(store, request)).data, bytes);
    assert.equal(await readQualificationAsset(store, { ...request, spuId: '9876543211' }), null);
    assert.equal(await readQualificationAsset(store, { ...request, sourceStoreId: 'temu:other' }), null);
    product.batchIds = []; assert.equal(await readQualificationAsset(store, request), null);
});
test('商品已确认后上传目标附件再提交资质，来源链接不冒充目标材料', async () => {
    const f = harness(), result = await f.run();
    assert.equal(result.state, 'complete');
    const submit = f.platform.find(call => call.operation === 'submit');
    assert.equal(submit.payload.request.productId, '9876543210');
    assert.equal(submit.payload.request.productCatCertReqList[0].productCertFiles[0].fileUrl, 'https://img.kwcdn.com/target-private.pdf');
    assert.ok(f.writes.some(record => record.qualificationItems[0]?.state === 'submitting'));
    assert.ok(f.writes.every(record => !JSON.stringify(record).includes('dataBase64')));
});
test('审核中或通过的资质不覆盖、未归档材料不上传且不会冒充成功', async () => {
    for (const status of [2, 4]) {
        const f = harness({ target: snapshot([1421], status) });
        assert.equal((await f.run()).state, 'complete');
        assert.equal(f.platform.filter(call => ['upload', 'submit'].includes(call.operation)).length, 0);
    }
    const f = harness(); delete f.task.snapshot.qualifications.items[0].files[0].asset;
    assert.equal((await f.run()).state, 'partial');
    assert.equal(f.platform.filter(call => call.operation === 'upload').length, 0);
});
test('单项失败继续下一个类型、提交未知本轮不重发，商品编号保持不变', async () => {
    const f = harness({ target: snapshot([1421, 1422]), result: { state: 'unknown', reason: '网络结果待核对' } });
    const result = await f.run(); assert.equal(result.state, 'unknown');
    assert.equal(f.platform.filter(call => call.operation === 'submit').length, 2);
    await f.run(); assert.equal(f.platform.filter(call => call.operation === 'submit').length, 2);
    assert.equal(f.record.productId, '9876543210');
    const g = harness({ target: snapshot([1421, 1422]) }); g.task.snapshot.qualifications.items.shift();
    const partial = await g.run(); assert.equal(partial.state, 'partial');
    assert.equal(partial.items[0].state, 'failed'); assert.equal(partial.items[1].state, 'submitted');
});
test('附件上传后暂停不再提交；最新采集失败、模板变动与主体声明只留明确异常', async () => {
    const f = harness({ pauseAfterUpload: true }); assert.equal((await f.run()).state, 'stopped');
    assert.equal(f.platform.filter(call => call.operation === 'submit').length, 0);
    const g = harness(); g.task.snapshot.qualifications.lastAttempt = { status: 'failed' };
    assert.equal((await g.run()).state, 'partial');
    const h = harness(); h.task.snapshot.qualifications.items[0].content.certNeedUpload.certNeedUploadItems = [{ contentType: 9 }];
    assert.equal((await h.run()).state, 'partial');
    const i = harness(); i.task.snapshot.qualifications.items[0].name = 'Small Business';
    const result = await i.run(); assert.equal(result.state, 'partial'); assert.match(result.items[0].reason, /主体声明/);
});
test('错误通知不把资质故障当成商品全局数据错误', async () => {
    const ctx = vm.createContext({}); vm.runInContext(await readFile(paths('error-notice'), 'utf8'), ctx);
    for (const state of ['qualification_failed', 'qualification_unknown']) assert.equal(ctx.TemuErrorNotices.classify({ directState: state, reason: '目标店材料缺失', errorCode: 'PRODUCT_DATA_INVALID' }), null);
});
test('页面提交使用已观察的全托管接口、核验商城与轮次、重复尝试不再次发送', async () => {
    const calls = [];
    let uploadStatus = 1;
    const client = { mallIdClient: { getMallIdAsync: async () => '123' }, post: async (path, body) => { calls.push({ path, body }); return { success: true }; } };
    const runtime = () => client; runtime.m = { client: 'getMallIdAsync .postWithoutMallId= .mallIdClient=' };
    const ctx = vm.createContext({ crypto: webcrypto, Map, location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list' },
        TemuQualificationReader: { normalizeKeys: value => value, readSnapshot: async () => ({ snapshot: {
            status: 'complete', items: [{ certType: 1421, summary: { uploadStatus }, detail: {} }] } }) },
        window: { __temuExecutionRound: { id: 'run', stopped: false }, chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } } });
    vm.runInContext(pageCode, ctx);
    const payload = { mallId: '123', executionRunId: 'run', productId: '9876543210', attemptId: 'attempt', expectedTargetDetail: {}, request: { productId: '9876543210', productCatCertReqList: [{ certType: 1421 }] } };
    await ctx.window.__temuQualificationPage.run('submit', payload);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 1); assert.equal(calls[0].path, '/bg-lich-mms/cert/product/upload');
    assert.equal((await ctx.window.__temuQualificationPage.run('status', payload)).state, 'submitted');
    await assert.rejects(ctx.window.__temuQualificationPage.run('submit', payload), /重复/);
    await assert.rejects(ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'new', mallId: 'other' }), /商城身份/);
    uploadStatus = 2;
    assert.equal((await ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'concurrent' })).state, 'existing');
    uploadStatus = 3;
    await assert.rejects(ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'rejected-target' }), /不是缺失/);
    uploadStatus = 1;
    await assert.rejects(ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'changed-template', expectedTargetDetail: { changed: true } }), /模板已变化/);
    ctx.window.__temuExecutionRound.stopped = true;
    await assert.rejects(ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'new' }), /停止/);
    assert.equal(calls.length, 1);
});

test('已有商品的资质结果在暂停后保存，下一次提交与结束后迟到结果均拒绝', async () => {
    const code = await readFile(paths('direct-executor'), 'utf8');
    const body = code.slice(code.indexOf('async function writeDirectAttempt('), code.indexOf('/**', code.indexOf('async function writeDirectAttempt(')));
    const task = { targetStoreId: 'temu:123', jobId: 'job', spuId, relaySessionId: 'session', executionRunId: 'run' };
    const original = { stage: 'qualifying', mallId: '123', productId: '9876543210',
        qualificationItems: [{ certType: 1421, state: 'submitting', attemptId: 'qualification-attempt' }] };
    let live = { ...task, executionRunId: 'paused-run' }, stored = structuredClone(original);
    const ctx = vm.createContext({ withTargetTaskMutation: fn => fn(), getTargetUploadTasks: async () => live ? [live] : [],
        revokedExecutionRuns: new Set(['run']), pruneDirectAttempts: async () => {},
        directActionType: task => task.actionType || 'product_create',
        chrome: { storage: { session: { get: async key => ({ [key]: structuredClone(stored) }) } } },
        saveTargetUploadTasks: async (_tasks, values) => { stored = structuredClone(values.key); },
        setTargetSessionValues: async values => { stored = structuredClone(values.key); } });
    vm.runInContext(body, ctx);
    const result = { ...original, qualificationItems: [{ ...original.qualificationItems[0], state: 'submitted' }] };
    await ctx.writeDirectAttempt(task, 'key', result);
    assert.equal(stored.qualificationItems[0].state, 'submitted');
    await assert.rejects(ctx.writeDirectAttempt(task, 'key', { ...result, qualificationItems: [...result.qualificationItems,
        { certType: 1422, state: 'submitting', attemptId: 'next' }] }), /轮次已结束/);
    await assert.rejects(ctx.writeDirectAttempt(task, 'key', { ...result, productId: '9999999999' }), /轮次已结束/);
    live = { ...task, relaySessionId: 'new-session' };
    await assert.rejects(ctx.writeDirectAttempt(task, 'key', result), /轮次已结束/);
});

test('页面官方SDK签名与上传链只执行一次，空提交响应不能冒充成功', async () => {
    const calls = [], chain = [];
    let reply = {};
    const uploader = new Proxy({}, { get: (_target, method) => (...args) => {
        chain.push({ method, args });
        return method === 'build' ? Promise.resolve({ url: 'https://img.kwcdn.com/target.pdf' }) : uploader;
    } });
    class SDK {
        constructor() { const proxy = new Proxy(this, { get: (_target, method) => (...args) => {
            chain.push({ method, args });
            if (method === 'init') return { uploadFile: () => uploader, uploadImage: () => uploader };
            return proxy;
        } }); return proxy; }
    }
    const client = { mallIdClient: { getMallIdAsync: async () => '123' }, post: async (address, body) => {
        calls.push({ address, body }); return address.endsWith('/signature') ? { result: 'signed' } : reply;
    } };
    const runtime = id => id === 'client' ? client : { Ay: SDK, ju: { PUBLIC_C: 27 } };
    runtime.m = { client: 'getMallIdAsync .postWithoutMallId= .mallIdClient=', sdk: 'PUBLIC_C uploadFile=function setSignature=function' };
    const ctx = vm.createContext({ crypto: webcrypto, File, Uint8Array, atob, Map, location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list', host: 'agentseller.temu.com' },
        TemuQualificationReader: { normalizeKeys: value => value, readSnapshot: async () => ({ snapshot: {
            status: 'complete', items: [{ certType: 1421, summary: { uploadStatus: 1 }, detail: {} }] } }) },
        window: { __temuExecutionRound: { id: 'run', stopped: false }, chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } } });
    vm.runInContext(pageCode, ctx);
    const payload = { mallId: '123', executionRunId: 'run', productId: '9876543210', attemptId: 'upload', asset: { ...ref, dataBase64: bytes.toString('base64') } };
    await ctx.window.__temuQualificationPage.run('upload', payload);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await ctx.window.__temuQualificationPage.run('status', payload)).state, 'uploaded');
    assert.equal(calls[0].address, '/ms/bg-flux-ms/compliance_property/signature');
    assert.ok(chain.some(entry => entry.method === 'setRetryCount' && entry.args[0] === 0));
    assert.ok(chain.some(entry => entry.method === 'setUrlSign' && entry.args[0] === 1));
    assert.equal(chain.filter(entry => entry.method === 'build').length, 1);
    await assert.rejects(ctx.window.__temuQualificationPage.run('upload', payload), /重复/);
    const submit = { ...payload, attemptId: 'submit', expectedTargetDetail: {}, request: { productId: payload.productId, productCatCertReqList: [{ certType: 1421 }] } };
    await ctx.window.__temuQualificationPage.run('submit', submit);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal((await ctx.window.__temuQualificationPage.run('status', submit)).state, 'unknown');
    reply = { success: false, errorCode: 20001, errorMessage: '模板材料缺失' };
    const rejected = { ...submit, attemptId: 'rejected' };
    await ctx.window.__temuQualificationPage.run('submit', rejected);
    await new Promise(resolve => setTimeout(resolve, 0));
    const failure = await ctx.window.__temuQualificationPage.run('status', rejected);
    assert.equal(failure.state, 'rejected'); assert.match(failure.reason, /模板材料缺失/);
});
