/** 实拍图资质仅使用合成归档和内存平台；不写测试数据文件，不访问真实商城或执行打包。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { parseQualificationRecord } from '../lib/product-qualifications.mjs';

const pluginPath = name => new URL(`../../plugin/${name}.js`, import.meta.url);
const transferCode = await readFile(pluginPath('qualification-transfer'), 'utf8');
const executorCode = await readFile(pluginPath('qualification-executor'), 'utf8');
const ledgerCode = await readFile(pluginPath('attachment-ledger'), 'utf8');
const readerCode = await readFile(pluginPath('qualification-reader'), 'utf8');
const pageCode = await readFile(pluginPath('qualification-page'), 'utf8');
const sourceProductId = '45962715608', targetProductId = '9876543210';
const clone = value => structuredClone(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requirements = [
    { contentType: 4, required: true },
    { contentType: 2, required: true },
    { contentType: 5, required: true, needChooseCheckItems: false }
];

/** 合成附件带真实格式签名及独立哈希，归档解析和页面校验都使用这些内存字节。 */
function asset(name, mimeType, bytes) {
    return { url: `https://bstatic.kwcdn.com/qualification-real-pictures-${name}`,
        name, mimeType, bytes: bytes.length, sha256: hash(bytes), dataBase64: bytes.toString('base64') };
}
const imageAssets = [
    asset('one.jpg', 'image/jpeg', Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCfAAf/2Q==', 'base64')),
    asset('two.png', 'image/png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2qgAAAABJRU5ErkJggg==', 'base64')),
    asset('three.gif', 'image/gif', Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')),
    asset('four.webp', 'image/webp', Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'))
];
const reportAsset = asset('report.pdf', 'application/pdf', Buffer.from('%PDF-1.7\nsynthetic-qualification-report\n%%EOF'));
const allAssets = [...imageAssets, reportAsset];
const observedPictures = [1, 2].flatMap(position => imageAssets.map(file => ({ imageUrl: file.url, position })));
const destination = ref => `https://img.kwcdn.com/qualification-target-${ref.sha256}.${ref.name.split('.').at(-1)}`;

/** 构造同一 SPU 的真实原始字段形状；模板、示例和来源 SKU 不充当材料或目标 SKU 映射。 */
function fixture({ types = [1421, 15], needs = requirements, pictures = observedPictures, report = true } = {}) {
    const raw = { schemaVersion: 1, productId: sourceProductId, mallId: 'source-mall',
        capturedAt: '2026-10-10T08:00:00.000Z', status: 'complete', archive: { status: 'complete', errors: [] },
        items: types.map(certType => ({ certType, status: 'complete',
            summary: { certType, certName: certType === 1421 ? 'EU 包装 1421' : '英国包装 15', uploadStatus: 1 },
            detail: { certType, productId: sourceProductId, fileUploadType: 1,
                certNeedUpload: { certNeedUploadItems: clone(needs) },
                productCertFiles: [], inspectReportFiles: report ? [{ fileUrl: reportAsset.url, fileName: reportAsset.name }] : [],
                realPictures: clone(pictures), selectedCheckItems: null,
                multiLangProductCertFileMap: null, multiLangInspectReportMap: null,
                docPdfContentReq: {}, productDangerousIngredients: [], energyLabel: null } })) };
    const urls = new Set(raw.items.flatMap(item => [
        ...(item.detail.realPictures || []).map(picture => picture.imageUrl),
        ...item.detail.inspectReportFiles.map(file => file.fileUrl)
    ]));
    raw.assets = allAssets.filter(file => urls.has(file.url)).map(clone);
    const record = { dataType: 'product-qualifications', identity: { productIds: [sourceProductId] },
        source: { requestUrl: 'https://agentseller.temu.com/mms/arbok/product_cert/query/list', pageProductId: sourceProductId },
        payload: { success: true, result: raw } };
    const source = parseQualificationRecord(record).qualifications;
    const target = { status: 'complete', items: raw.items.map(item => ({ certType: item.certType,
        summary: { certType: item.certType, uploadStatus: 1 },
        detail: { certType: item.certType, certNeedUpload: clone(item.detail.certNeedUpload) } })) };
    const uploaded = new Map(raw.assets.map(ref => [ref.sha256, destination(ref) + '?signature=synthetic']));
    return { raw, source, target, uploaded };
}

/** 决策模块在隔离 VM 内运行，输出转换回当前上下文以准确比较字段、顺序和数量。 */
function transferHarness() {
    const ctx = vm.createContext({});
    vm.runInContext(transferCode, ctx, { filename: 'qualification-transfer.js' });
    return (source, target, uploaded) => clone(ctx.TemuQualificationTransfer.requestFor(source, target, targetProductId, uploaded));
}
const prepare = transferHarness();

/** 冻结全部来源字段，任何原地替换链接或改写位置都会令被测代码立即失败。 */
function freezeSource(value) {
    if (!value || typeof value !== 'object') return value;
    Object.values(value).forEach(freezeSource);
    return Object.freeze(value);
}

/** 页面只连接内存客户端及合成 SDK；DOM、fetch 和未知接口均设为不可用以防测试意外越界。 */
function pageHarness(target, { rejectTypes = [], failedUploadHashes = [], missingSdkMethod, missingUploaderMethod } = {}) {
    const calls = [], uploads = [], chain = [], domReads = [], uploadMethods = [], files = [];
    const makeUploader = kind => {
        let file;
        const uploader = { build() {
            chain.push({ kind, method: 'build', args: [] });
            return (async () => {
                assert.ok(file instanceof File, 'SDK 必须收到内存 File，而非文件选择器或来源 URL');
                const bytes = Buffer.from(await file.arrayBuffer());
                const sha256 = hash(bytes);
                uploads.push({ kind, file, bytes, sha256 });
                if (failedUploadHashes.includes(sha256)) throw Error('合成图片上传失败');
                return { url: `https://img.kwcdn.com/qualification-target-${sha256}.${file.name.split('.').at(-1)}?signature=synthetic` };
            })();
        } };
        // 图片上传器没有 PDF 专用字段，未知方法必须缺失，不能用万能链式代理掩盖错误。
        const methods = ['setSignature', 'setUrlSign', 'setData', ...(kind === 'file' ? ['setContentType', 'setContentDisposition'] : [])];
        for (const method of methods) uploader[method] = (...args) => {
            chain.push({ kind, method, args });
            if (method === 'setData') file = args[0];
            return uploader;
        };
        if (missingUploaderMethod) delete uploader[missingUploaderMethod];
        return uploader;
    };
    class SDK {
        constructor() {
            this.config = { retryCount: 2 };
            if (missingSdkMethod) this[missingSdkMethod] = undefined;
        }
        setMaxRetryCount(count) { this.config.retryCount = count; chain.push({ kind: 'sdk', method: 'setMaxRetryCount', args: [count] }); return this; }
        init() { assert.equal(this.config.retryCount, 0); chain.push({ kind: 'sdk', method: 'init', args: [] }); return this; }
        uploadImage() { uploadMethods.push('uploadImage'); return makeUploader('image'); }
        uploadFile() { uploadMethods.push('uploadFile'); return makeUploader('file'); }
    }
    // 官方 SDK 的方法可由原型继承；仅按属性是否可调用判断，不要求方法在实例上直接定义。
    for (const method of ['setScene', 'isProduct', 'setTag', 'setUploadHost', 'setSignatureHost', 'setTimeout']) {
        SDK.prototype[method] = function (...args) { chain.push({ kind: 'sdk', method, args }); return this; };
    }
    assert.equal(typeof new SDK().setRetryCount, 'undefined');
    class MemoryFile extends File {
        constructor(parts, name, options) { super(parts, name, options); files.push(this); }
    }
    const client = { mallIdClient: { getMallIdAsync: async () => '123' }, post: async (address, body) => {
        calls.push({ address, body: clone(body) });
        if (address === '/ms/bg-flux-ms/compliance_property/signature') return { result: 'synthetic-signature' };
        if (address === '/bg-lich-mms/cert/product/upload') return rejectTypes.includes(body.productCatCertReqList[0].certType)
            ? { success: false, errorCode: 20001, errorMessage: '合成资质材料被拒绝' } : { success: true };
        throw Error(`测试禁止未声明的接口：${address}`);
    } };
    const runtime = id => id === 'client' ? client : { Ay: SDK, ju: { PUBLIC_C: 27 } };
    runtime.m = { client: 'getMallIdAsync .postWithoutMallId= .mallIdClient=',
        sdk: 'PUBLIC_C uploadFile=function setSignature=function' };
    const ctx = vm.createContext({ crypto: webcrypto, File: MemoryFile, Uint8Array, atob, Map, setTimeout, clearTimeout,
        fetch: () => { throw Error('测试禁止真实网络'); },
        document: new Proxy({}, { get: (_object, key) => { domReads.push(key); throw Error('测试禁止 DOM 文件选择'); } }),
        location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list', host: 'agentseller.temu.com' },
        TemuQualificationReader: { normalizeKeys: value => value,
            readSnapshot: async () => ({ snapshot: clone(target) }) },
        window: { __temuExecutionRound: { id: 'run', stopped: false },
            chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } } });
    vm.runInContext(pageCode, ctx, { filename: 'qualification-page.js' });
    return { calls, uploads, chain, domReads, uploadMethods, files,
        run: (operation, payload) => ctx.window.__temuQualificationPage.run(operation, payload) };
}

/** 执行器调用真实 VM 页面实现，附件读取仅从合成原包取字节，覆盖预检、去重和最终提交的完整链路。 */
function executorHarness(f, options = {}) {
    const page = pageHarness(f.target, options), writes = [], progress = [], logs = [], assetReads = [];
    const stored = {};
    const ctx = vm.createContext({ crypto: webcrypto, TextEncoder, URL, atob, btoa, Uint8Array,
        setTimeout: fn => setTimeout(fn, 0), clearTimeout,
        fetch: () => { throw Error('测试禁止真实网络'); },
        readDirectPause: async () => null, directStopRequested: new Set(),
        assertExecutionDocument: async () => {}, executionWithDeadline: fn => fn(),
        chrome: { scripting: { executeScript: async () => [] }, storage: { local: {
            get: async key => key === null ? clone(stored) : Array.isArray(key) ? Object.fromEntries(key.map(name => [name, clone(stored[name])])) : { [key]: clone(stored[key]) },
            set: async values => Object.assign(stored, clone(values)), remove: async key => { delete stored[key]; }
        } } }, withTargetTaskMutation: fn => fn(),
        writeDirectAttempt: async (_task, _key, value) => writes.push(clone(value)),
        rememberDirectProgress: async (_task, value) => progress.push(clone(value)),
        directErrorText: error => error.message || String(error),
        TemuOperationLog: { append: async entry => logs.push(clone(entry)) } });
    vm.runInContext(`${readerCode}\n${transferCode}\n${ledgerCode}\n${executorCode}`, ctx, { filename: 'qualification-executor-vm.js' });
    ctx.qualificationAsset = async (_task, file) => {
        assetReads.push(file.asset.sha256);
        const archived = f.raw.assets.find(ref => ref.url === file.url && ref.sha256 === file.asset.sha256);
        assert.ok(archived, '只可读取本商品原包引用的已归档材料');
        return clone(archived);
    };
    ctx.qualificationPage = (_tab, operation, identity, payload) => page.run(operation, {
        ...payload, mallId: identity.mallId, executionRunId: identity.executionRunId
    });
    const task = { jobId: 'synthetic-qualification-job', spuId: sourceProductId, sourceStoreId: 'temu:source',
        snapshot: { qualifications: clone(f.source), publicationData: { sourceProduct: {
            productId: sourceProductId, productSkcList: [{ productSkcId: 'SOURCE-SKC-ONLY',
                productSkuList: [{ productSkuId: 'SOURCE-SKU-ONLY' }] }] } } } };
    const identity = { mallId: '123', storeId: 'temu:123', documentId: 'doc', executionRunId: 'run' };
    const record = { stage: 'qualifying', mallId: '123', productId: targetProductId };
    return { page, writes, progress, logs, assetReads, task, record,
        run: () => ctx.runDirectQualifications(task, identity, 1, record, 'synthetic-key') };
}

/** 页面 SDK 上传异步完成后只读本次尝试的内存状态，既不轮询真实接口也不自动重发。 */
async function settle(page, payload) {
    for (let i = 0; i < 100; i++) {
        const result = await page.run('status', payload);
        if (result.state !== 'submitting') return result;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail('合成 SDK 未在限定轮数内完成');
}

test('历史原包仍可解析，报告提交不混入八条旧共用照片', () => {
    const f = fixture(), before = clone(f.source), originalRaw = clone(f.raw);
    assert.equal(f.source.archiveStatus, 'complete');
    assert.equal(new Set(observedPictures.map(picture => picture.imageUrl)).size, 4);
    assert.deepEqual(observedPictures.map(picture => picture.position), [1, 1, 1, 1, 2, 2, 2, 2]);
    freezeSource(f.source);
    for (const [index, source] of f.source.items.entries()) {
        assert.equal(source.files.filter(file => file.role === '检测报告').length, 1);
        assert.equal(source.files.filter(file => file.role === '资质实拍图').length, 4);
        assert.equal(source.files.length, 5, '位置重复不制造重复附件归档');
        assert.equal(source.content.productCertFiles.length, 0);
        assert.equal(source.content.selectedCheckItems, null);
        const request = prepare(source, f.target.items[index].detail, f.uploaded);
        assert.equal(request.productId, targetProductId);
        assert.equal(request.productCatCertReqList.length, 1);
        assert.equal(request.productCatCertReqList[0].certType, source.certType);
        assert.equal(request.productCatCertReqList[0].selectedCheckItems, null);
        assert.equal(request.productCatCertReqList[0].inspectReportFiles[0].fileUrl, destination(reportAsset));
        assert.equal(request.realPictures, undefined);
        assert.doesNotMatch(JSON.stringify(request), /SOURCE-SKU|SOURCE-SKC|dataBase64|bstatic\.kwcdn\.com|signature=/);
    }
    assert.deepEqual(f.source, before, '替换上传链接不能污染来源快照');
    assert.deepEqual(f.raw, originalRaw, '原始归档中的材料与位置同样不得被修改');
});

test('照片专用模板不生成资质文件请求，旧照片不充当可提交证书', () => {
    const f = fixture({ types: [1421], needs: [{ contentType: 4 }], report: false });
    assert.throws(() => prepare(f.source.items[0], f.target.items[0].detail, f.uploaded), /没有可提交/);
    for (const pictures of [[], null, undefined, {}]) {
        const source = clone(f.source.items[0]); source.content.realPictures = pictures;
        assert.throws(() => prepare(source, f.target.items[0].detail, f.uploaded), error => {
            assert.match(error.message, /没有可提交/);
            assert.doesNotMatch(error.message, /模板|特殊/);
            return true;
        });
    }
});

test('匹配本商品原始字段时证书0和报告0准确缺材料，不误报特殊模板或准备成功', () => {
    for (const [contentType, missing] of [[1, /缺少.*证书/], [2, /缺少.*报告/]]) {
        const f = fixture({ needs: [{ contentType: 4 }, { contentType }, requirements[2]], report: false });
        for (const [index, source] of f.source.items.entries()) {
            assert.throws(() => prepare(source, f.target.items[index].detail, f.uploaded), error => {
                assert.match(error.message, missing);
                assert.doesNotMatch(error.message, /特殊|尚未支持|模板不同/);
                return true;
            });
        }
    }
});

test('空多语言容器不能冒充实际证书或报告，照片有材料也不能掩盖必填缺失', async t => {
    for (const [contentType, field, missing] of [
        [1, 'multiLangProductCertFileMap', /缺少.*证书/],
        [2, 'multiLangInspectReportMap', /缺少.*报告/]
    ]) {
        for (const empty of [{}, []]) await t.test(`类型${contentType}空${Array.isArray(empty) ? '数组' : '对象'}`, () => {
            const f = fixture({ types: [1421], needs: [{ contentType: 4 }, { contentType }], report: false });
            f.source.items[0].content[field] = empty;
            assert.throws(() => prepare(f.source.items[0], f.target.items[0].detail, f.uploaded), missing);
        });
    }
});

test('类型5仅明确false免选项，未明确或要求选择仍按hasContent保守校验', () => {
    for (const needChooseCheckItems of [undefined, null, true]) {
        const need = { contentType: 5, required: true };
        if (needChooseCheckItems !== undefined) need.needChooseCheckItems = needChooseCheckItems;
        const f = fixture({ types: [1421], needs: [{ contentType: 4 }, need], report: false });
        for (const selected of [null, undefined, false, '', {}, []]) {
            const source = clone(f.source.items[0]); source.content.selectedCheckItems = selected;
            assert.throws(() => prepare(source, f.target.items[0].detail, f.uploaded), /选项/);
        }
        for (const selected of [[{ checkItemId: 7 }], { checkItemId: 7 }]) {
            const source = clone(f.source.items[0]); source.content.selectedCheckItems = selected;
            assert.deepEqual(prepare(source, f.target.items[0].detail, f.uploaded).productCatCertReqList[0].selectedCheckItems, selected);
        }
    }
    const f = fixture({ types: [1421], needs: [{ contentType: 4 }, requirements[2]], report: false });
    assert.throws(() => prepare(f.source.items[0], f.target.items[0].detail, f.uploaded), /没有可提交/);
});

test('旧共用照片的SKU或未知字段不再混入证书正文', () => {
    const f = fixture({ types: [1421] });
    for (const key of ['skuId', 'productSkuId', 'productSkcId', 'sourceSkuId', 'skuCode', 'imageId', 'fileName', 'url', 'unexpected']) {
        for (const value of ['source-only-id', null, {}]) {
            const source = clone(f.source.items[0]); source.content.realPictures[0][key] = value;
            assert.equal(prepare(source, f.target.items[0].detail, f.uploaded).realPictures, undefined);
        }
    }
    for (const invalid of [null, [], 'image', 1]) {
        const source = clone(f.source.items[0]); source.content.realPictures[0] = invalid;
        assert.equal(prepare(source, f.target.items[0].detail, f.uploaded).realPictures, undefined);
    }
});

test('旧照片位置不决定证书上传位置，未知值不进入正文', () => {
    const f = fixture({ types: [1421] });
    for (const position of [0, 1, 2, Number.MAX_SAFE_INTEGER]) {
        const source = clone(f.source.items[0]); source.content.realPictures[0].position = position;
        assert.equal(prepare(source, f.target.items[0].detail, f.uploaded).realPictures, undefined);
    }
    for (const position of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null, undefined, true, {}, 1n]) {
        const source = clone(f.source.items[0]); source.content.realPictures[0].position = position;
        assert.equal(prepare(source, f.target.items[0].detail, f.uploaded).realPictures, undefined);
    }
});

test('证书正文不取旧照片，照片附件MIME不能改变报告路由', () => {
    const f = fixture({ types: [1421] });
    assert.deepEqual(new Set(f.source.items[0].files.filter(file => file.role === '资质实拍图').map(file => file.asset.mimeType)),
        new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']));
    for (const mimeType of ['application/pdf', 'text/html', 'image/svg+xml', 'image/bmp', 'image/avif', 'image/tiff', 'image/jpg', 'image/', 'IMAGE/PNG', 'image/png; charset=utf-8', '', null]) {
        const source = clone(f.source.items[0]);
        source.files.find(file => file.url === imageAssets[0].url).asset.mimeType = mimeType;
        assert.equal(prepare(source, f.target.items[0].detail, f.uploaded).realPictures, undefined);
    }
    const pdfAsPhoto = clone(f.source.items[0]); pdfAsPhoto.content.realPictures[0].imageUrl = reportAsset.url;
    assert.equal(prepare(pdfAsPhoto, f.target.items[0].detail, f.uploaded).realPictures, undefined);
});

test('模板差异、报告未归档或未上传、主体声明及非空特殊模式继续拒绝', () => {
    const f = fixture({ types: [1421] });
    for (const change of [
        target => { target.certNeedUpload.certNeedUploadItems[0].templateId = 'different-template'; },
        target => { target.certNeedUpload.certNeedUploadItems[2].needChooseCheckItems = true; },
        target => { target.needUploadLanguages = ['de']; }
    ]) {
        const target = clone(f.target.items[0].detail); change(target);
        assert.throws(() => prepare(f.source.items[0], target, f.uploaded), /模板不同|语言材料/);
    }
    for (const change of [
        source => { delete source.files.find(file => file.url === reportAsset.url).asset; },
        source => { source.files = source.files.filter(file => file.url !== reportAsset.url); }
    ]) {
        const source = clone(f.source.items[0]); change(source);
        assert.throws(() => prepare(source, f.target.items[0].detail, f.uploaded), /实拍图|归档/);
    }
    const missingUpload = new Map(f.uploaded); missingUpload.delete(reportAsset.sha256);
    assert.throws(() => prepare(f.source.items[0], f.target.items[0].detail, missingUpload), /上传|归档/);
    for (const name of ['Small Business', '小微企业声明', '店铺主体声明']) {
        const source = clone(f.source.items[0]); source.name = name;
        assert.doesNotThrow(() => prepare(source, f.target.items[0].detail, f.uploaded));
        source.content.needAgreement = true;
        assert.throws(() => prepare(source, f.target.items[0].detail, f.uploaded), /声明|人工确认/);
    }
    for (const field of ['docPdfContentReq', 'productDangerousIngredients', 'energyLabel']) {
        for (const value of [{ filled: true }, [1], true, 'non-empty']) {
            const source = clone(f.source.items[0]); source.content[field] = value;
            assert.throws(() => prepare(source, f.target.items[0].detail, f.uploaded), /尚未支持|不支持/);
        }
    }
    const generated = clone(f.source.items[0]); generated.content.fileUploadType = 2;
    assert.throws(() => prepare(generated, f.target.items[0].detail, f.uploaded), /自动生成|不支持|尚未支持/);
    for (const field of ['needAgreement', 'needConfirm']) {
        const target = clone(f.target.items[0].detail); target[field] = true;
        assert.throws(() => prepare(f.source.items[0], target, f.uploaded), /声明|确认/);
    }
});

test('特殊字段单层空对象、空数组、false和null不误拒，且不会自动生成特殊内容', () => {
    const f = fixture({ types: [1421] });
    for (const field of ['docPdfContentReq', 'productDangerousIngredients', 'energyLabel']) {
        for (const value of [{}, [], false, null]) {
            const source = clone(f.source.items[0]); source.content[field] = value;
            const request = prepare(source, f.target.items[0].detail, f.uploaded);
            assert.equal(request.realPictures, undefined);
            assert.equal(Object.hasOwn(request.productCatCertReqList[0], field), false);
        }
    }
});

test('执行器只上传报告，跨类型每hash仅上传一次且不污染快照', { timeout: 10000 }, async () => {
    const f = fixture(), h = executorHarness(f), before = clone(h.task.snapshot);
    const result = await h.run();
    assert.equal(result.state, 'complete');
    assert.deepEqual(clone(result.items).map(item => [item.certType, item.state]), [[1421, 'submitted'], [15, 'submitted']]);
    const hashes = new Set([reportAsset.sha256]);
    assert.equal(h.page.uploads.length, hashes.size);
    assert.deepEqual(new Set(h.page.uploads.map(upload => upload.sha256)), hashes);
    assert.deepEqual(new Set(h.assetReads), hashes);
    assert.equal(h.assetReads.length, hashes.size);
    assert.equal(h.page.uploadMethods.filter(method => method === 'uploadImage').length, 0);
    assert.equal(h.page.uploadMethods.filter(method => method === 'uploadFile').length, 1);
    const submissions = h.page.calls.filter(call => call.address === '/bg-lich-mms/cert/product/upload');
    assert.equal(submissions.length, 2);
    for (const [index, call] of submissions.entries()) {
        assert.equal(call.body.productId, targetProductId);
        assert.equal(call.body.productCatCertReqList[0].certType, [1421, 15][index]);
        assert.equal(call.body.realPictures, undefined);
        assert.equal(call.body.productCatCertReqList[0].inspectReportFiles[0].fileUrl, destination(reportAsset));
        assert.equal(call.body.productCatCertReqList[0].selectedCheckItems, null);
        assert.doesNotMatch(JSON.stringify(call.body), /SOURCE-SKU|SOURCE-SKC|signature=/);
    }
    assert.deepEqual(h.task.snapshot, before);
    assert.deepEqual(h.page.domReads, []);
    assert.ok(h.writes.some(record => record.qualificationItems.some(item => item.state === 'submitting')));
    assert.doesNotMatch(JSON.stringify([h.writes, h.progress]), /dataBase64/);
    await h.run();
    assert.equal(h.page.uploads.length, hashes.size, '已提交条目重复运行不能重新上传');
    assert.equal(h.page.calls.filter(call => call.address === '/bg-lich-mms/cert/product/upload').length, 2);
});

test('来源声明已提交但报告丢失不能假成功，预检失败后仍继续下一资质类型', { timeout: 10000 }, async () => {
    const missing = fixture({ types: [1421], report: false });
    // 空白项目现在正常跳过；已提交记录却丢失材料才必须保留缺报告错误。
    missing.source.items[0].uploadStatus = 2;
    const failed = executorHarness(missing);
    const result = await failed.run();
    assert.equal(result.state, 'partial');
    assert.equal(result.items[0].state, 'failed');
    assert.match(result.items[0].reason, /缺少.*报告/);
    assert.equal(failed.assetReads.length, 0);
    assert.equal(failed.page.uploads.length, 0);
    assert.equal(failed.page.calls.length, 0, '缺报告时连签名请求也不能发送');
    const mixed = fixture(); mixed.source.items[0].content.inspectReportFiles = []; mixed.source.items[0].uploadStatus = 2;
    const h = executorHarness(mixed), continued = await h.run();
    assert.equal(continued.state, 'partial');
    assert.deepEqual(clone(continued.items).map(item => item.state), ['failed', 'submitted']);
    assert.match(continued.items[0].reason, /报告/);
    assert.deepEqual(h.page.calls.filter(call => call.address === '/bg-lich-mms/cert/product/upload')
        .map(call => call.body.productCatCertReqList[0].certType), [15]);
});

test('执行器首项提交被拒后继续下一类型，共享PDF不重复上传', { timeout: 10000 }, async () => {
    const f = fixture(), h = executorHarness(f, { rejectTypes: [1421] });
    const result = await h.run();
    assert.equal(result.state, 'partial');
    assert.deepEqual(clone(result.items).map(item => item.state), ['failed', 'submitted']);
    assert.equal(h.page.uploads.length, 1);
    assert.deepEqual(h.page.calls.filter(call => call.address === '/bg-lich-mms/cert/product/upload')
        .map(call => call.body.productCatCertReqList[0].certType), [1421, 15]);
    assert.equal(h.record.productId, targetProductId);
    assert.ok(h.logs.some(entry => entry.certType === 1421 && entry.status === 'failed'));
    assert.ok(h.logs.some(entry => entry.certType === 15 && entry.status === 'submitted'));
});

test('旧照片未知SKU不会影响独立报告，执行器只发送报告不发送图片', { timeout: 10000 }, async () => {
    const f = fixture({ types: [1421] });
    f.source.items[0].content.realPictures[0].productSkuId = 'SOURCE-SKU-ONLY';
    const h = executorHarness(f), result = await h.run();
    assert.equal(result.state, 'complete');
    assert.equal(result.items[0].state, 'submitted');
    assert.equal(h.assetReads.length, 1);
    assert.equal(h.page.uploads.length, 1);
    assert.equal(h.page.uploadMethods.includes('uploadImage'), false);
    assert.equal(h.page.calls.find(call => call.address === '/bg-lich-mms/cert/product/upload').body.realPictures, undefined);
});

test('页面合成SDK图片走uploadImage和内存File，PDF走uploadFile，全程不选DOM文件', { timeout: 10000 }, async () => {
    const f = fixture({ types: [1421] }), page = pageHarness(f.target);
    for (const ref of allAssets) {
        const payload = { mallId: '123', executionRunId: 'run', productId: targetProductId,
            attemptId: `upload-${ref.sha256}`, asset: clone(ref) };
        assert.equal((await page.run('upload', payload)).state, 'submitting');
        const result = await settle(page, payload);
        assert.equal(result.state, 'uploaded');
        assert.equal(result.url, destination(ref) + '?signature=synthetic');
        const upload = page.uploads.at(-1);
        assert.equal(upload.kind, ref.mimeType.startsWith('image/') ? 'image' : 'file');
        assert.equal(upload.file.type, ref.mimeType);
        assert.equal(upload.file.name, ref.name);
        assert.equal(upload.file.size, ref.bytes);
        assert.deepEqual(upload.bytes, Buffer.from(ref.dataBase64, 'base64'));
        await assert.rejects(page.run('upload', payload), /重复/);
    }
    assert.deepEqual(page.uploadMethods, ['uploadImage', 'uploadImage', 'uploadImage', 'uploadImage', 'uploadFile']);
    assert.deepEqual(page.domReads, []);
    assert.equal(page.files.length, 5);
    assert.equal(page.chain.filter(entry => entry.method === 'build').length, 5);
    assert.equal(page.calls.length, 5);
    assert.ok(page.calls.every(call => call.address === '/ms/bg-flux-ms/compliance_property/signature'));
    assert.equal(page.chain.filter(entry => entry.method === 'setMaxRetryCount' && entry.args[0] === 0).length, 5);
});

test('官方SDK方法缺失在签名前拒绝，不能退回默认重试或尝试另一上传器', async () => {
    const f = fixture({ types: [1421] });
    for (const missingSdkMethod of ['setMaxRetryCount', 'setTimeout', 'init', 'uploadImage', 'uploadFile']) {
        const page = pageHarness(f.target, { missingSdkMethod });
        const payload = { mallId: '123', executionRunId: 'run', productId: targetProductId,
            attemptId: `missing-${missingSdkMethod}`, asset: clone(reportAsset) };
        await assert.rejects(page.run('upload', payload), /SDK 上传方法变化/);
        assert.equal(page.calls.length, 0);
        assert.equal(page.uploadMethods.length, 0);
        assert.equal(page.uploads.length, 0);
        assert.equal((await page.run('status', payload)).state, 'unknown');
    }
});

test('图片和PDF上传器接口缺失在签名前拒绝，不执行build或资质提交', async () => {
    const f = fixture({ types: [1421] });
    for (const ref of [imageAssets[0], reportAsset]) {
        const methods = ['setSignature', 'setUrlSign', 'setData', 'build',
            ...(!ref.mimeType.startsWith('image/') ? ['setContentType', 'setContentDisposition'] : [])];
        for (const missingUploaderMethod of methods) {
            const page = pageHarness(f.target, { missingUploaderMethod });
            const payload = { mallId: '123', executionRunId: 'run', productId: targetProductId,
                attemptId: `missing-${ref.name}-${missingUploaderMethod}`, asset: clone(ref) };
            await assert.rejects(page.run('upload', payload), /SDK 附件方法变化/);
            assert.equal(page.calls.length, 0);
            assert.equal(page.uploads.length, 0);
            assert.equal(page.chain.filter(entry => entry.method === 'build').length, 0);
        }
    }
});
