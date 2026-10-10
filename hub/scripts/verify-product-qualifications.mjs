/** 资质读取、归属、资料包与仓库回归只使用离线响应和临时目录，绝不调用平台创建或正式入库。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { parseImportedFiles, createSingleProductCapture } from '../lib/parse-capture.mjs';
import { createStore } from '../lib/store.mjs';
import { inventoryListSummary } from '../lib/mysql-inventory.mjs';
import { parseQualificationRecord, mergeQualificationCapture } from '../lib/product-qualifications.mjs';
import { qualificationSnapshot, qualificationRecord, productRecord, packet, spuId } from './qualification-fixture.mjs';
const require = createRequire(import.meta.url);
const reader = require('../../plugin/qualification-reader.js');
const parse = value => parseImportedFiles([{ originalName: 'temu-full-capture-qualifications.json', payload: value }]);

/** 主世界调用的模拟客户端记录真实 URL 和参数，禁止出现上传/提交路径。 */
function clientHarness(overrides = {}) {
    const calls = [], snap = qualificationSnapshot();
    const defaults = async (url, input) => {
        calls.push({ url, input });
        assert.match(url, /\/product_cert\/query\/(?:list|detail)$/);
        if (url.endsWith('/list')) return { if_semi_managed: false, total: 1, product_with_cert_list: [{ product_base_info: { product_id: spuId }, product_cert_info_list: [snap.items[0].summary] }] };
        return { product_cert_info: snap.items[0].detail };
    };
    return { calls, run: () => reader.readSnapshot({}, { spuId, mallId: 'mall-fixture', assertCurrent: overrides.assertCurrent || (async () => {}), post: overrides.post || defaults }) };
}

test('只读清单和详情同步采集，不点击页面也不提交', async () => {
    const h = clientHarness(), result = await h.run();
    assert.equal(result.snapshot.status, 'complete');
    assert.equal(result.snapshot.items[0].detail.authCode, 'TEST-CERT-2026');
    assert.equal(h.calls.length, 2);
    assert.deepEqual(h.calls[0].input.product_ids, [spuId]);
    assert.equal(h.calls[1].input.cert_type, 1421);
    assert.equal(reader.validateSnapshot(result.snapshot, spuId), result.snapshot);
});
test('完整空结果与读取失败分开；单项错误保留对应原因', async () => {
    const empty = await clientHarness({ post: async () => ({ if_semi_managed: false, total: 0, product_with_cert_list: [] }) }).run();
    assert.equal(empty.snapshot.status, 'complete'); assert.equal(empty.snapshot.items.length, 0);
    const failed = await clientHarness({ post: async () => ({ success: false, errorCode: 429, errorMsg: '限流' }) }).run();
    assert.equal(failed.snapshot.status, 'failed'); assert.equal(failed.stopBatch, true);
    const snap = qualificationSnapshot();
    const partial = await clientHarness({ post: async url => url.endsWith('/list') ? { ifSemiManaged: false, total: 1,
        productWithCertList: [{ productBaseInfo: { productId: spuId }, productCertInfoList: [snap.items[0].summary] }] } : { success: false, errorMsg: '附件暂不可读取' } }).run();
    assert.equal(partial.snapshot.status, 'partial'); assert.equal(partial.stopBatch, false); assert.match(partial.snapshot.items[0].reason, /附件/);
});
test('错商品、详情类型冲突和切店拒绝；分页提前结束不当作完整', async () => {
    const wrong = await clientHarness({ post: async () => ({ ifSemiManaged: false, total: 1, productWithCertList: [{ productBaseInfo: { productId: '99999999999' }, productCertInfoList: [] }] }) }).run();
    assert.equal(wrong.stopBatch, true); assert.equal(wrong.snapshot.status, 'failed');
    const missing = await clientHarness({ post: async () => ({ ifSemiManaged: false, total: 2, productWithCertList: [] }) }).run();
    assert.match(missing.snapshot.reason, /提前结束/);
    const switched = await clientHarness({ assertCurrent: async () => { throw Object.assign(new Error('切店'), { stopBatch: true }); } }).run();
    assert.equal(switched.stopBatch, true);
    assert.throws(() => reader.normalizeKeys(JSON.parse('{"__proto__":{"x":1}}')), /结构冲突/);
    assert.throws(() => reader.productId(1e20), /安全数字/);
});
test('专用资质解析：附件/示例隔离，填写内容完整，发布资料不污染', () => {
    const value = parse(packet()).products[0];
    assert.equal(value.qualifications.items[0].files.length, 4);
    assert.equal(value.qualifications.items[0].content.uploadedContents.note, '已填写的商品说明');
    assert.ok(value.qualifications.items[0].requirements.some(s => s.includes('100 mg/kg')));
    assert.ok(value.qualifications.items[0].saleEffects.some(s => s.includes('无法上架')));
    assert.ok(!value.images.some(url => /report|example|history|cert\.pdf/.test(url)));
    assert.equal(value.publicationData.sourceProduct.productId, spuId);
    assert.equal(value.publicationData.sourceProduct.qualifications, undefined);
    const raw = qualificationRecord(); raw.dataType = 'unknown';
    assert.equal(parse({ ...packet(), records: [raw] }).products.length, 0);
    const spoofed = packet(); spoofed.products = [{ spuId, qualifications: qualificationSnapshot() }]; spoofed.records = [productRecord()];
    assert.equal(parse(spoofed).products[0].qualifications, undefined);
    const broken = qualificationRecord(); broken.identity.productIds = ['99999999999'];
    assert.throws(() => parseQualificationRecord(broken), /归属/);
    const wrongOrigin = qualificationRecord(); wrongOrigin.source.requestUrl = 'https://evil.invalid/mms/arbok/product_cert/query/list';
    assert.throws(() => parseQualificationRecord(wrongOrigin), /来源/);
    const unsafe = qualificationRecord(); unsafe.payload.result.items[0].detail.productCertFiles.push({ fileName: '未验证附件.pdf', fileUrl: 'https://external.invalid/cert.pdf' });
    const rejectedFile = parseQualificationRecord(unsafe).qualifications.items[0].files.find(file => file.name === '未验证附件.pdf');
    assert.equal(rejectedFile.url, ''); assert.match(rejectedFile.reason, /未开放链接/);
});

test('MySQL商品列表投影不携带资质大正文，原始详情对象不丢文件或内容',()=>{
    const product=parse(packet()).products[0];
    product.qualificationCaptures=[product.qualifications];product.publicationData.sourceBatchId='fixture-batch';
    const before=structuredClone(product),summary=inventoryListSummary(product);
    assert.equal(summary.qualifications,undefined);assert.equal(summary.qualificationCaptures,undefined);assert.equal(summary.detail,undefined);
    assert.deepEqual(summary.publicationData,{sourceBatchId:'fixture-batch'});assert.deepEqual(product,before);
    assert.equal(product.qualificationCaptures[0].items[0].files.length,4);
});

test('附件归档失败原因只映射本快照对应文件，已归档文件不携带失败提示', () => {
    const record = qualificationRecord();
    record.payload.result.archive = { status: 'failed', errors: [
        { url: 'https://bstatic.kwcdn.com/cert.pdf', name: '证书.pdf', reason: '附件下载失败（HTTP 403）' },
        { url: 'https://bstatic.kwcdn.com/other.pdf', name: '其他.pdf', reason: '其他附件失败' }
    ] };
    record.payload.result.assets = [];
    const value = parseQualificationRecord(record).qualifications;
    const failed = value.items[0].files.find(file => file.url === 'https://bstatic.kwcdn.com/cert.pdf');
    assert.equal(failed.reason, '附件下载失败（HTTP 403）');
    assert.equal(value.items[0].files.some(file => file.reason === '其他附件失败'), false);
    assert.equal(value.archiveStatus, 'partial');
    const bytes = Buffer.from('%PDF-test');
    record.payload.result.assets = [{ url: failed.url, name: '证书.pdf', mimeType: 'application/pdf', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') }];
    const archived = parseQualificationRecord(record).qualifications.items[0].files.find(file => file.url === failed.url);
    assert.equal(archived.archiveStatus, 'archived'); assert.equal(archived.reason, undefined);
});
test('单商品流式聚合同样保留资质，不接受包摘要伪造', () => {
    const aggregate = createSingleProductCapture({ ...packet(), records: [] }, spuId);
    aggregate.seed({ spuId, qualifications: qualificationSnapshot({status:'failed'}) });
    aggregate.record(productRecord()); aggregate.record(qualificationRecord());
    assert.equal(aggregate.finish().products[0].qualifications.status, 'complete');
});

test('多个资质类型普通失败后继续读取，类型冲突停止；响应不因字段重复或模式未知假成功',async()=>{
    const snap=qualificationSnapshot(),first=snap.items[0];
    const list={ifSemiManaged:false,total:1,productWithCertList:[{productBaseInfo:{productId:spuId},
        productCertInfoList:[first.summary,{...first.summary,certType:56}]}]};
    const calls=[];
    const partial=await clientHarness({post:async(url,input)=>{
        if(url.endsWith('/list'))return list;
        calls.push(input.cert_type);
        return input.cert_type===1421?{success:false,errorMsg:'材料读取失败'}:{productCertInfo:{...first.detail,certType:56}};
    }}).run();
    assert.deepEqual(calls,[1421,56]);assert.equal(partial.snapshot.items[1].status,'complete');assert.equal(partial.stopBatch,false);
    const mismatch=await clientHarness({post:async url=>url.endsWith('/list')?list:{productCertInfo:{certType:999}}}).run();
    assert.equal(mismatch.stopBatch,true);assert.equal(mismatch.snapshot.items[1].detail,null);
    const unsupported=await clientHarness({post:async()=>({...list,ifSemiManaged:true})}).run();assert.equal(unsupported.snapshot.status,'failed');
    assert.throws(()=>reader.normalizeKeys({product_id:spuId,productId:spuId}),/结构冲突/);
    const duplicate=await clientHarness({post:async()=>({...list,total:2,productWithCertList:[list.productWithCertList[0],list.productWithCertList[0],list.productWithCertList[0]]})}).run();
    assert.match(duplicate.snapshot.reason,/重复|总数/);
});

test('相同SPU在不同来源店的资质不得互相复用',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'temu-qualifications-'));
    assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('temu-qualifications-'));
    try{
        const store=createStore(root),first=qualificationSnapshot(),second=qualificationSnapshot();
        second.items[0].detail.authCode='SECOND-STORE';
        const upload=(snapshot,id)=>store.importFiles([{originalName:`temu-full-capture-${id}.json`,payload:packet(snapshot,id)}]);
        await upload(first,'store-one');
        // 现有仓库同 SPU 只认一个来源店；资质功能必须保留这道边界，而不是放宽既有混店保护。
        await assert.rejects(()=>upload(second,'store-two'),/来源店冲突/);
        second.productId='45962715609';
        await upload(second,'store-two');
        const rows=(await store.listOverview()).products;
        assert.equal(rows.length,2);
        assert.equal(rows.find(row=>row.sourceStoreIds.includes('store-one')).qualificationCaptures[0].items[0].content.authCode,'TEST-CERT-2026');
        assert.equal(rows.find(row=>row.sourceStoreIds.includes('store-two')).qualificationCaptures[0].items[0].content.authCode,'SECOND-STORE');
    }finally{await rm(root,{recursive:true,force:true});}
});
test('新批次先遍历也保留旧成功及最新失败，成功清空可替换旧材料', () => {
    const old = parseQualificationRecord(qualificationRecord()).qualifications;
    const failed = { ...old, capturedAt: '2026-10-08T11:00:00.000Z', status: 'failed', reason: '限流', items: [] };
    const combined = mergeQualificationCapture(failed, old);
    assert.equal(combined.status, 'complete'); assert.equal(combined.items.length, 1); assert.equal(combined.lastAttempt.reason, '限流');
    const cleared = mergeQualificationCapture(combined, { ...old, capturedAt: '2026-10-08T12:00:00.000Z', items: [] });
    assert.equal(cleared.items.length, 0); assert.equal(cleared.lastAttempt, undefined);
});
test('仓库新资质不被SKU复用吞掉，同货号不同SPU保持归属，物理删除清除资质', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'temu-qualifications-'));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('temu-qualifications-'));
    try {
        const store = createStore(root);
        const upload = value => store.importFiles([{ originalName: `temu-full-capture-${Date.now()}.json`, payload: value }]);
        await upload(packet());
        const secondId = '45962715609'; await upload(packet(qualificationSnapshot({ id: secondId })));
        let overview = await store.listOverview();
        assert.equal(overview.products.length, 1); assert.equal(overview.products[0].qualificationCaptures.length, 2);
        const updated = qualificationSnapshot({at:'2026-10-08T11:00:00.000Z'}); updated.items[0].detail.authCode = 'UPDATED-CERT';
        const result = await upload(packet(updated)); assert.notEqual(result.reused, true);
        const failed = qualificationSnapshot({at:'2026-10-08T12:00:00.000Z',status:'failed'}); await upload(packet(failed));
        overview = await store.listOverview();
        const cap = overview.products[0].qualificationCaptures.find(c => c.spuId === spuId);
        assert.equal(cap.items[0].content.authCode, 'UPDATED-CERT'); assert.equal(cap.lastAttempt.status, 'failed');
        assert.equal(overview.products[0].blocked, undefined);
        await store.deleteProducts([spuId]);
        assert.equal((await store.listOverview()).products.length, 0);
        await upload(packet()); assert.equal((await store.listOverview()).products[0].qualificationCaptures[0].lastAttempt, undefined);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('主世界消息集成同件资质回执；超时后禁止继续查询', async () => {
    const helper = await readFile(new URL('../../plugin/qualification-reader.js', import.meta.url), 'utf8');
    const code = await readFile(new URL('../../plugin/api-reader.js', import.meta.url), 'utf8');
    const replies = []; let listener; let stalled = false;
    const snap = qualificationSnapshot();
    const runtime = () => ({ mallIdClient: { getMallIdAsync: async () => 'mall-fixture' }, post: async (url) => {
        if (url.includes('/product/query')) return { productId: spuId, productName: '测试', productSkcList: [] };
        if (stalled) return new Promise(() => {});
        if (url.endsWith('/list')) return { ifSemiManaged:false,total:1,productWithCertList:[{productBaseInfo:{productId:spuId},productCertInfoList:[snap.items[0].summary]}] };
        return { productCertInfo: snap.items[0].detail };
    } });
    runtime.m = { 99: function(e) { e.postWithoutMallId = null; e.mallIdClient = { getMallIdAsync() {} }; } };
    const chunks = []; chunks.push = chunk => chunk[2](runtime);
    const location = { hostname:'agentseller.temu.com',pathname:'/goods/list',origin:'https://agentseller.temu.com',href:'https://agentseller.temu.com/goods/list' };
    const window = { chunkLoadingGlobal_temu_sca_goods:chunks,addEventListener:(_,fn)=>{listener=fn;},postMessage:v=>replies.push(v) };
    const ctx = vm.createContext({ window,location,crypto:webcrypto,TextEncoder,URL,setTimeout:(fn,ms)=>setTimeout(fn, ms===15000?30:ms),clearTimeout });
    vm.runInContext(helper,ctx); vm.runInContext(code,ctx);
    const query = () => listener({source:window,origin:location.origin,data:{source:'temu-shop-transfer-api-v1',kind:'query',requestId:webcrypto.randomUUID(),runId:'run-1',spuId}});
    await query(); assert.equal(replies.at(-1).qualifications.status, 'complete');
    stalled = true; await query(); assert.equal(replies.at(-1).stopBatch, true); assert.equal(replies.at(-1).qualifications.status, 'failed');
    await query(); assert.match(replies.at(-1).error, /刷新/);
});
