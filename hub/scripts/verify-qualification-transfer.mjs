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
const ledgerCode = await readFile(paths('attachment-ledger'), 'utf8');
const readerCode = await readFile(paths('qualification-reader'), 'utf8');
const photoExecutorCode = await readFile(paths('live-photo-executor'), 'utf8');
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
    const stored = {};
    const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, URL, atob, btoa, Uint8Array,
        setTimeout: fn => setTimeout(fn, 0), clearTimeout,
        readDirectPause: async () => paused ? { paused: true } : null, directStopRequested: new Set(),
        assertExecutionDocument: async () => {}, executionWithDeadline: fn => fn(),
        chrome: { scripting: { executeScript: async () => [] }, storage: { local: {
            get: async key => key === null ? structuredClone(stored) : Array.isArray(key) ? Object.fromEntries(key.map(name => [name, structuredClone(stored[name])])) : { [key]: structuredClone(stored[key]) },
            set: async values => Object.assign(stored, structuredClone(values)), remove: async key => { delete stored[key]; }
        } } }, withTargetTaskMutation: fn => fn(),
        writeDirectAttempt: async (_task, _key, value) => writes.push(structuredClone(value)),
        rememberDirectProgress: async (_task, value) => progress.push(structuredClone(value)),
        directErrorText: error => error.message || String(error), TemuOperationLog: { append: async entry => logs.push(entry) } });
    vm.runInContext(`${readerCode}\n${transferCode}\n${ledgerCode}\n${photoExecutorCode}\n${executorCode}`, ctx);
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
    const partial = await g.run(); assert.equal(partial.state, 'complete');
    assert.equal(partial.items[0].state, 'skipped'); assert.equal(partial.items[1].state, 'submitted');
});
test('附件上传后暂停不再提交；最新采集失败、模板变动与主体声明只留明确异常', async () => {
    const f = harness({ pauseAfterUpload: true }); assert.equal((await f.run()).state, 'stopped');
    assert.equal(f.platform.filter(call => call.operation === 'submit').length, 0);
    const g = harness(); g.task.snapshot.qualifications.lastAttempt = { status: 'failed' };
    assert.equal((await g.run()).state, 'partial');
    const h = harness(); h.task.snapshot.qualifications.items[0].content.certNeedUpload.certNeedUploadItems = [{ contentType: 9 }];
    assert.equal((await h.run()).state, 'partial');
    const i = harness(); i.task.snapshot.qualifications.items[0].content.needAgreement = true;
    const result = await i.run(); assert.equal(result.state, 'partial'); assert.match(result.items[0].reason, /声明|人工确认/);
});

test('Small Business 真实证明文件按模板搬运，不以名称代替主体声明判断', async () => {
    const f = harness(); f.task.snapshot.qualifications.items[0].name = 'FDA-Cosmetic(Small Business)';
    f.task.snapshot.qualifications.items[0].displayName = '美国化妆品小企业证明';
    assert.equal((await f.run()).state, 'complete');
    assert.equal(f.platform.filter(call => call.operation === 'submit').length, 1);
});

test('目标已有资质优先跳过，模板未读取、来源附件缺失和声明要求不产生错误或写入', async () => {
    for (const status of [2, 4]) {
        const target = snapshot([439], status);
        target.items[0].status = 'failed'; target.items[0].reason = '模拟详情不可读'; delete target.items[0].detail;
        target.status = 'partial'; target.selectionComplete = true;
        const f = harness({ target });
        f.task.snapshot.qualifications.items[0].name = 'Small Business';
        f.task.snapshot.qualifications.items[0].content.needAgreement = true;
        delete f.task.snapshot.qualifications.items[0].files[0].asset;
        const result = await f.run();
        assert.equal(result.state, 'complete'); assert.equal(result.items[0].state, 'existing');
        assert.equal(f.platform.filter(call => ['upload', 'submit'].includes(call.operation)).length, 0);
    }
});

test('目标补传只查缺失项详情，来源全量采集仍读取已有资质正文', async () => {
    const ctx = vm.createContext({ TextEncoder, Uint8Array, URL, AbortController, setTimeout, clearTimeout });
    vm.runInContext(readerCode, ctx);
    for (const targetRead of [true, false]) {
        const detailTypes = [];
        const result = await ctx.TemuQualificationReader.readSnapshot({}, {
            spuId, mallId: '634418214794015', assertCurrent: async () => {},
            ...(targetRead ? { certTypes: [439, 1421, 1422], skipExistingDetails: true } : {}),
            post: async (url, body) => {
                if (url.endsWith('/list')) return { ifSemiManaged: false, total: 1, productWithCertList: [{
                    productBaseInfo: { productId: spuId }, productCertInfoList: [
                        { certType: 439, uploadStatus: 4 }, { certType: 1421, uploadStatus: 2 }, { certType: 1422, uploadStatus: 1 }
                    ] }] };
                detailTypes.push(body.cert_type);
                return { productCertInfo: { certType: body.cert_type } };
            }
        });
        assert.equal(result.snapshot.status, 'complete');
        assert.deepEqual(detailTypes, targetRead ? [1422] : [439, 1421, 1422]);
    }
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
    const blocked = await ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'changed-template', expectedTargetDetail: { changed: true } });
    assert.equal(blocked.state, 'rejected'); assert.match(blocked.reason, /要求或填写内容已变化.*其他字段.*未提交/);
    ctx.window.__temuExecutionRound.stopped = true;
    await assert.rejects(ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'new' }), /停止/);
    assert.equal(calls.length, 1);
});

test('提交前仅顶层要求和对象键重排允许，规则、填写、空值及其他详情变化仍零提交', async () => {
    const calls = [];
    const original = { certType: 1421, certName: '包装资质', showName: '包装资质', showNameLang: { en: 'Packaging' },
        fileUploadType: null, needUploadLanguages: ['en'], needConfirm: false, needAgreement: false,
        certNeedUpload: { instruction: '报告及实拍图', certNeedUploadItems: [
            { contentType: 4, required: true },
            { contentType: 2, templateId: 12, templateConfigList: [{ values: ['first', 'second'] }] },
            { contentType: 5, needChooseCheckItems: false }
        ] }, productCertFiles: [], inspectReportFiles: [], realPictures: [],
        authCode: null, operatorName: '原操作人', auditedAt: null, historyPictures: [],
        auditStatusLanguageMap: {}, showAuditStatus: '未提交', unknownConstraint: null };
    let actual = structuredClone(original), uploadStatus = 1;
    const client = { mallIdClient: { getMallIdAsync: async () => '123' },
        post: async (path, body) => { calls.push({ path, body }); return { success: true }; } };
    const runtime = () => client; runtime.m = { client: 'getMallIdAsync .postWithoutMallId= .mallIdClient=' };
    const ctx = vm.createContext({ crypto: webcrypto, Map, location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list' },
        TemuQualificationReader: { normalizeKeys: value => value, readSnapshot: async () => ({ snapshot: {
            status: 'complete', items: [{ certType: 1421, summary: { uploadStatus }, detail: structuredClone(actual) }] } }) },
        window: { __temuExecutionRound: { id: 'run', stopped: false }, chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } } });
    vm.runInContext(pageCode, ctx);
    const payload = { mallId: '123', executionRunId: 'run', productId: '9876543210', attemptId: 'reorder',
        expectedTargetDetail: structuredClone(original), request: { productId: '9876543210', productCatCertReqList: [{ certType: 1421 }] } };
    actual.certNeedUpload.certNeedUploadItems.reverse();
    actual = Object.fromEntries(Object.entries(actual).reverse());
    const expectedBefore = JSON.stringify(payload.expectedTargetDetail), actualBefore = JSON.stringify(actual);
    assert.equal((await ctx.window.__temuQualificationPage.run('submit', payload)).state, 'submitting');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(calls.length, 1);
    assert.equal(JSON.stringify(payload.expectedTargetDetail), expectedBefore);
    assert.equal(JSON.stringify(actual), actualBefore);
    const changes = [
        ['required', value => { value.certNeedUpload.certNeedUploadItems[0].required = false; }],
        ['templateId', value => { value.certNeedUpload.certNeedUploadItems[1].templateId = 13; }],
        ['templateConfigList', value => { value.certNeedUpload.certNeedUploadItems[1].templateConfigList[0].values.reverse(); }],
        ['certNeedUploadItems', value => { value.certNeedUpload.certNeedUploadItems.push(structuredClone(value.certNeedUpload.certNeedUploadItems[0])); }],
        ['needChooseCheckItems', value => { value.certNeedUpload.certNeedUploadItems[2].needChooseCheckItems = true; }],
        ['needUploadLanguages', value => { value.needUploadLanguages.push('de'); }],
        ['fileUploadType', value => { value.fileUploadType = 2; }],
        ['needAgreement', value => { value.needAgreement = true; }],
        ['needConfirm', value => { value.needConfirm = true; }],
        ['productCertFiles', value => { value.productCertFiles.push({ fileUrl: 'https://img.kwcdn.com/SECRET-content.pdf' }); }],
        ['inspectReportFiles', value => { value.inspectReportFiles.push({ fileUrl: 'https://img.kwcdn.com/SECRET-report.pdf' }); }],
        ['realPictures', value => { value.realPictures.push({ imageUrl: 'https://img.kwcdn.com/SECRET-photo.jpg', position: 1 }); }],
        ['authCode', value => { value.authCode = 'SECRET-number'; }],
        ['unknownConstraint', value => { value.unknownConstraint = 'SECRET-new-rule'; }],
        ['privateMapKey', value => { value.unknownMap = { PRIVATE_ACCOUNT_IDENTIFIER: 'SECRET-value' }; }],
        ['missingNull', value => { delete value.fileUploadType; }],
        ['certName', value => { value.certName = '不同名称'; }],
        ['auditedAt', value => { value.auditedAt = '2026-10-10T03:00:00Z'; }],
        ['historyPictures', value => { value.historyPictures = [{ imageUrl: 'https://img.kwcdn.com/SECRET-history.jpg' }]; }],
        ['showAuditStatus', value => { value.showAuditStatus = '平台显示状态已变化'; }]
    ];
    for (const [field, mutate] of changes) {
        actual = structuredClone(original); mutate(actual);
        const rejected = await ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: `changed-${field}` });
        assert.equal(rejected.state, 'rejected', field);
        assert.match(rejected.reason, /未提交/, field);
        assert.doesNotMatch(rejected.reason, /SECRET|https:|PRIVATE_ACCOUNT_IDENTIFIER/, '日志不包含地址、正文或动态键');
        assert.equal(calls.length, 1, field);
    }
    uploadStatus = 2;
    assert.equal((await ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'existing' })).state, 'existing');
    uploadStatus = 3;
    await assert.rejects(ctx.window.__temuQualificationPage.run('submit', { ...payload, attemptId: 'rejected' }), /不是缺失/);
    assert.equal(calls.length, 1);
});

test('页面确认尚未提交的拒绝直接返回，不查询状态或变成结果未知', async () => {
    const operations = [];
    const ctx = vm.createContext({});
    vm.runInContext(executorCode, ctx);
    ctx.qualificationPage = async (_tab, operation) => { operations.push(operation); return { state: 'rejected', reason: '目标规则变化，未提交' }; };
    const result = await ctx.qualificationWrite(1, 'submit', {}, {}, async () => false);
    assert.equal(result.state, 'rejected');
    assert.deepEqual(operations, ['submit']);
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
    // 仅声明平台已核对的方法；任意方法代理会让不存在的 SDK 接口错误通过回归。
    const uploader = { build() {
        chain.push({ method: 'build', args: [] });
        return Promise.resolve({ url: 'https://img.kwcdn.com/target.pdf' });
    } };
    for (const method of ['setSignature', 'setUrlSign', 'setData', 'setContentType', 'setContentDisposition']) {
        uploader[method] = (...args) => { chain.push({ method, args }); return uploader; };
    }
    class SDK {
        constructor() { this.config = { retryCount: 2 }; }
        setMaxRetryCount(count) { this.config.retryCount = count; chain.push({ method: 'setMaxRetryCount', args: [count] }); return this; }
        init() { assert.equal(this.config.retryCount, 0); chain.push({ method: 'init', args: [] }); return this; }
        uploadFile() { return uploader; }
        uploadImage() { return uploader; }
    }
    for (const method of ['setScene', 'isProduct', 'setTag', 'setUploadHost', 'setSignatureHost', 'setTimeout']) {
        SDK.prototype[method] = function (...args) { chain.push({ method, args }); return this; };
    }
    assert.equal(typeof new SDK().setRetryCount, 'undefined');
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
    assert.ok(chain.some(entry => entry.method === 'setMaxRetryCount' && entry.args[0] === 0));
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

/** 共用照片属于商品而非每一种证书；四张合成图片在两个位置重复，所有附件仅存在内存。 */
function sharedPictureFixture(type = 1421, { report = true, purePhoto = false } = {}) {
    const images = Array.from({ length: 4 }, (_, index) => {
        const data = Buffer.from(`synthetic-image-${index}`);
        return { url: `https://img.kwcdn.com/synthetic-${index}.png`, data,
            asset: { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, mimeType: 'image/png' } };
    });
    const source = item(type);
    source.uploadStatus = 1;
    source.files = [...(report && !purePhoto ? source.files : []), ...images.map(({ url, asset }) => ({ url, asset }))];
    source.content = { certType: type, certNeedUpload: { certNeedUploadItems: purePhoto
        ? [{ contentType: 4 }, { contentType: 5, needChooseCheckItems: false }]
        : [{ contentType: 2 }, { contentType: 4 }, { contentType: 5, needChooseCheckItems: false }] },
        inspectReportFiles: report && !purePhoto ? [{ fileUrl: sourceUrl, fileName: 'fixture.pdf' }] : [],
        productCertFiles: [], selectedCheckItems: null,
        realPictures: [1, 2].flatMap(position => images.map(image => ({ imageUrl: image.url, position }))) };
    return { source, images };
}

/** 冻结整个来源，兼容比较和链接替换都不得修改归档快照或内部选项排列。 */
function freezeQualificationSource(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freezeQualificationSource);
        Object.freeze(value);
    }
    return value;
}

test('完整要求仅顶层重排允许，重复数和内部选项顺序或值变化仍拒绝且不改源', () => {
    const f = harness(), source = item();
    const needs = [
        { contentType: 1, templateId: 'certificate', useMultiTemplate: false,
            templateConfigList: [{ language: 'en', fields: ['a', 'b'] }], needUploadSubItems: false,
            certCheckItems: [{ name: '选项', refValues: [{ id: 1, value: 'A' }, { id: 2, value: 'B' }] }],
            supportMultiLanguage: true, needChooseCheckItems: false },
        { contentType: 2, templateId: 'report' },
        { contentType: 5, needChooseCheckItems: false }
    ];
    // 相同完整条目也保留两个，避免集合去重掩盖模板重复数量变化。
    needs.push(structuredClone(needs[0]));
    source.content.certNeedUpload.certNeedUploadItems = needs;
    source.content.inspectReportFiles = structuredClone(source.content.productCertFiles);
    const before = structuredClone(source);
    freezeQualificationSource(source);
    const uploaded = new Map([[sha256, 'https://img.kwcdn.com/target.pdf?sign=TEMP']]);
    const request = targetNeeds => f.ctx.TemuQualificationTransfer.requestFor(source,
        { certNeedUpload: { certNeedUploadItems: targetNeeds } }, '9876543210', uploaded);
    const reordered = structuredClone(needs).reverse();
    assert.equal(request(reordered).productCatCertReqList[0].inspectReportFiles[0].fileUrl, 'https://img.kwcdn.com/target.pdf');
    const variants = [
        ['减少重复条目', structuredClone(needs).slice(0, -1)],
        ['增加重复条目', [...structuredClone(needs), structuredClone(needs[0])]],
        ['内部选项顺序变化', structuredClone(needs)],
        ['内部选项值变化', structuredClone(needs)],
        ['完整选项附加字段变化', structuredClone(needs)]
    ];
    variants[2][1][0].certCheckItems[0].refValues.reverse();
    variants[3][1][0].certCheckItems[0].refValues[0].value = 'different';
    variants[4][1][0].certCheckItems[0].refValues[0].language = 'fr';
    for (const [name, targetNeeds] of variants) {
        assert.throws(() => request(targetNeeds), /模板/, name);
        assert.deepEqual(source, before, name);
    }
    // 八个兼容字段都必须参与比较，不能只比较内容类型或几个常见模板字段。
    const changedFields = { contentType: 2, templateId: 'other', useMultiTemplate: true,
        templateConfigList: [{ language: 'fr' }], needUploadSubItems: true,
        certCheckItems: [], supportMultiLanguage: false, needChooseCheckItems: true };
    for (const [field, value] of Object.entries(changedFields)) {
        const changed = structuredClone(needs);
        changed[0][field] = value;
        assert.throws(() => request(changed), /模板/, field);
        assert.deepEqual(source, before, field);
    }
    assert.deepEqual(source, before);
});

test('来源填写判定不把共用实拍图当证书或报告，实际独立材料才是证书填写证据', () => {
    const api = harness().ctx.TemuQualificationTransfer;
    for (const contentType of [1, 2]) {
        const { source } = sharedPictureFixture(1421, { report: false });
        source.content.certNeedUpload.certNeedUploadItems[0].contentType = contentType;
        assert.equal(api.sourceHasContent(source), false, `类型${contentType}仅有共用照片`);
        const field = contentType === 1 ? 'productCertFiles' : 'inspectReportFiles';
        source.content[field] = [{ fileUrl: sourceUrl }];
        assert.equal(api.sourceHasContent(source), true, field);
    }
    assert.equal(api.sourceHasContent(sharedPictureFixture(1421, { purePhoto: true }).source), false);
    const submittedPhoto = sharedPictureFixture(1421, { purePhoto: true }).source; submittedPhoto.uploadStatus = 2;
    assert.equal(api.sourceHasContent(submittedPhoto), false);
    for (const uploadStatus of [2, 3, 4, 5]) {
        const { source } = sharedPictureFixture(1421, { report: false });
        source.uploadStatus = uploadStatus;
        assert.equal(api.sourceHasContent(source), true, `来源状态${uploadStatus}不得掩盖材料丢失`);
    }
    assert.equal(api.sourceHasContent(undefined), false);
    for (const source of [{ status: 'failed' }, { status: 'partial', content: {} }, { status: 'complete' }]) {
        assert.equal(api.sourceHasContent(source), true, '采集失败或内容缺失不能当成正常空项');
    }
});

test('空多语言和特殊容器及空白不算填写，编号选择值或非空特殊内容仍算填写', () => {
    const api = harness().ctx.TemuQualificationTransfer;
    const ownFields = ['productCertFiles', 'inspectReportFiles', 'multiLangProductCertFileMap', 'multiLangInspectReportMap',
        'supplementaryMaterials', 'uploadedContents', 'groupUploadedContents', 'authCode', 'authCodes', 'selectedCheckItems',
        'docPdfContentReq', 'productDangerousIngredients', 'energyLabel', 'energyLabelFiles', 'eprelId'];
    const { source } = sharedPictureFixture(1421, { report: false });
    for (const empty of [{}, [], null, false, ' \t\n ', { en: [], zh: {}, nested: [null, false, '  '] }]) {
        for (const field of ownFields) source.content[field] = structuredClone(empty);
        assert.equal(api.sourceHasContent(source), false, JSON.stringify(empty));
    }
    for (const field of ownFields) {
        const filled = structuredClone(source);
        filled.content[field] = field.includes('Map') ? { en: [{ fileUrl: sourceUrl }] } : ['实际填写值'];
        assert.equal(api.sourceHasContent(filled), true, field);
    }
});

test('报告走证书入口，旧共用照片不上传；二十个空项和缺来源项目跳过', async () => {
    const emptyTypes = Array.from({ length: 20 }, (_, index) => 1500 + index);
    const absentTypes = [1600, 1601];
    const target = snapshot([...emptyTypes.slice(0, 10), 1421, ...emptyTypes.slice(10), ...absentTypes]);
    const successful = sharedPictureFixture();
    for (const entry of target.items) {
        entry.detail = { certType: entry.certType, certNeedUpload: structuredClone(successful.source.content.certNeedUpload) };
        // 未填写或未提供来源先跳过，目标驳回及未知状态不能导致任务失败。
        if (entry.certType !== 1421) entry.summary.uploadStatus = entry.certType % 2 ? 3 : 0;
    }
    const f = harness({ target });
    f.task.snapshot.qualifications.items = [successful.source,
        ...emptyTypes.map(type => sharedPictureFixture(type, { report: false }).source)];
    const before = structuredClone(f.task.snapshot);
    freezeQualificationSource(f.task.snapshot);
    f.ctx.qualificationAsset = async (_task, file) => {
        const image = successful.images.find(candidate => candidate.asset.sha256 === file.asset.sha256);
        return { ...file.asset, dataBase64: (image?.data || bytes).toString('base64') };
    };
    const result = await f.run();
    assert.equal(result.state, 'complete');
    assert.equal(result.items.filter(entry => entry.state === 'skipped').length, 22);
    assert.equal(result.items.filter(entry => entry.state === 'submitted').length, 1);
    assert.ok(result.items.filter(entry => absentTypes.includes(entry.certType)).every(entry => /未提供/.test(entry.reason)));
    const submissions = f.platform.filter(call => call.operation === 'submit');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].payload.request.productCatCertReqList[0].certType, 1421);
    assert.equal(submissions[0].payload.request.realPictures, undefined);
    assert.equal(f.platform.filter(call => call.operation === 'upload').length, 1);
    assert.deepEqual(f.task.snapshot, before);
    assert.equal(await f.ctx.finishDirectQualifications(f.task, f.identity, 1, f.record, 'key'), true);
    assert.equal(f.record.stage, 'qualification_complete');
    assert.equal(f.platform.filter(call => call.operation === 'submit').length, 1);
});

test('所有来源为空或未提供时整体完成且平台零写，结算明确没有内容需要补传', async () => {
    for (const absent of [false, true]) {
        const target = snapshot([1421, 1422]);
        target.items[0].summary.uploadStatus = 3;
        delete target.items[1].summary.uploadStatus;
        const f = harness({ target });
        f.task.snapshot.qualifications.items = absent ? [] : target.items.map(entry => {
            const { source } = sharedPictureFixture(entry.certType, { report: false });
            source.content.realPictures = [];
            source.content.multiLangProductCertFileMap = { en: [] };
            source.content.multiLangInspectReportMap = { en: {}, zh: [null, '  '] };
            source.content.docPdfContentReq = {};
            return source;
        });
        const result = await f.run();
        assert.equal(result.state, 'complete');
        assert.ok(result.items.every(entry => entry.state === 'skipped'));
        assert.match(result.reason, /没有需要补传|无.*内容/);
        assert.equal(f.platform.filter(call => ['upload', 'submit'].includes(call.operation)).length, 0);
        assert.equal(await f.ctx.finishDirectQualifications(f.task, f.identity, 1, f.record, 'key'), true);
        assert.equal(f.record.stage, 'qualification_complete');
        assert.equal(f.platform.filter(call => ['upload', 'submit'].includes(call.operation)).length, 0);
    }
});

test('纯照片模板不再触发证书写入，照片必须由独立入口处理', async () => {
    const photo = sharedPictureFixture(1421, { purePhoto: true });
    const target = snapshot();
    target.items[0].detail.certNeedUpload = structuredClone(photo.source.content.certNeedUpload);
    const f = harness({ target });
    f.task.snapshot.qualifications.items = [photo.source];
    f.ctx.qualificationAsset = async (_task, file) => ({ ...file.asset,
        dataBase64: photo.images.find(image => image.asset.sha256 === file.asset.sha256).data.toString('base64') });
    const result = await f.run();
    assert.equal(result.state, 'complete');
    assert.equal(result.items[0].state, 'skipped');
    assert.equal(f.platform.filter(call => call.operation === 'upload').length, 0);
    assert.equal(f.platform.filter(call => call.operation === 'submit').length, 0);
});

test('已填写但缺报告或模板不兼容仍明确失败，预检零上传且继续后续成功项', async () => {
    const variants = [
        ['提交状态但报告丢失', source => { source.uploadStatus = 4; source.content.inspectReportFiles = []; }, /报告/],
        ['另有证书但报告缺失', source => { source.content.inspectReportFiles = []; source.content.productCertFiles = [{ fileUrl: sourceUrl }]; }, /报告/],
        ['已填报告但模板不同', source => { source.content.certNeedUpload.certNeedUploadItems[0].templateId = 'other'; }, /模板/],
        ['已填主体声明', source => { source.content.needConfirm = true; }, /声明|人工确认/]
    ];
    for (const [name, mutate, reason] of variants) {
        const target = snapshot([1421, 1422]);
        const first = item();
        first.content.certNeedUpload.certNeedUploadItems = [{ contentType: 2 }];
        first.content.inspectReportFiles = first.content.productCertFiles;
        delete first.content.productCertFiles;
        target.items[0].detail.certNeedUpload.certNeedUploadItems = [{ contentType: 2 }];
        mutate(first);
        const f = harness({ target });
        f.task.snapshot.qualifications.items[0] = first;
        const save = f.ctx.writeDirectAttempt;
        let checkedPreflight = false;
        // 两项共用同一附件哈希；仅检查最终上传总数会被去重掩盖，须在首项失败落盘时检查零上传。
        f.ctx.writeDirectAttempt = async (...args) => {
            if (!checkedPreflight && args[2].qualificationItems[0]?.state === 'failed') {
                assert.equal(f.platform.filter(call => ['upload', 'submit'].includes(call.operation)).length, 0, name);
                checkedPreflight = true;
            }
            return save(...args);
        };
        const result = await f.run();
        assert.equal(checkedPreflight, true, name);
        assert.equal(result.state, 'partial', name);
        assert.equal(result.items[0].state, 'failed', name);
        assert.match(result.items[0].reason, reason, name);
        assert.equal(result.items[1].state, 'submitted', name);
        assert.equal(f.platform.filter(call => call.operation === 'upload').length, 1, name);
        const submissions = f.platform.filter(call => call.operation === 'submit');
        assert.equal(submissions.length, 1, name);
        assert.equal(submissions[0].payload.request.productCatCertReqList[0].certType, 1422, name);
    }
});

test('失败采集或缺失详情不能被来源空项分支隐藏，后续完整项目仍处理', async () => {
    for (const missingContent of [false, true]) {
        const f = harness({ target: snapshot([1421, 1422]) });
        const source = f.task.snapshot.qualifications.items[0];
        if (missingContent) delete source.content;
        else { source.status = 'failed'; source.content.productCertFiles = []; }
        const result = await f.run();
        assert.equal(result.state, 'partial');
        assert.equal(result.items[0].state, 'failed');
        assert.match(result.items[0].reason, /完整采集/);
        assert.equal(result.items[1].state, 'submitted');
        assert.equal(f.platform.filter(call => call.operation === 'submit').length, 1);
    }
});

test('空来源零目标查询；清单完整但单项详情失败不阻止下一资质', async () => {
    const empty = harness(); empty.task.snapshot.qualifications.items = [];
    assert.equal((await empty.run()).state, 'complete');
    assert.equal(empty.platform.length, 0);
    const target = snapshot([1421, 1422]);
    target.status = 'partial'; target.selectionComplete = true;
    target.items[0].status = 'failed'; target.items[0].detail = null; target.items[0].reason = '模拟详情未返回';
    const h = harness({ target });
    const result = await h.run();
    assert.equal(result.state, 'partial');
    assert.deepEqual(Array.from(result.items, item => item.state), ['failed', 'submitted']);
    assert.equal(h.platform.filter(call => call.operation === 'read').length, 1);
    assert.equal(h.platform.filter(call => call.operation === 'submit').length, 1);
});

test('重新投递的新批次不重复提交列表尚未更新的证书，未知回执不会自动重发', async () => {
    for (const state of ['submitted', 'unknown']) {
        const h = harness({ result: { state } });
        await h.run();
        h.record.qualificationItems = [];
        h.task.jobId = 'new-manual-job';
        const result = await h.run();
        assert.equal(result.state, state === 'submitted' ? 'complete' : 'unknown');
        assert.equal(h.platform.filter(call => call.operation === 'submit').length, 1);
        assert.equal(h.platform.filter(call => call.operation === 'upload').length, 1);
    }
});
