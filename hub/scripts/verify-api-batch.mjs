/** 接口批采回归：模拟主世界客户端发现/ID校验，并验证完整包经真实解析器进入临时仓库。 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseImportedFiles } from '../lib/parse-capture.mjs';
import { createStore } from '../lib/store.mjs';
import os from 'node:os';
import path from 'node:path';

const code = await fs.readFile(new URL('../../plugin/api-reader.js', import.meta.url), 'utf8');
const replies = [];
let listener, calls = 0;
const product = { productId: '5372907865', productName: '测试多规格商品', carouselImageUrls: ['https://example.com/main.jpg'], outerPackageImages: [{ imageUrl: 'https://example.com/package.jpg' }], productPropertyList: [{ propName: '材质', propValue: '蜡' }], productSkcList: [{ productSkcId: '66847115779', productSkuList: [{ productSkuId: '58148545964', supplierPrice: 1600, productSkuSpecList: [{ parentSpecName: '数量', specName: '20pcs' }] }, { productSkuId: '36212696376', supplierPrice: 1800 }] }], goodsLayerDecorationVOList: null, goodsLayerDecorationCustomizeI18nVOList: [] };
// 模块号刻意与实测不同，保证实现依赖结构签名而不是硬编码编号。
const runtime = () => ({ post: async (url, input) => { calls++; assert.equal(url, '/visage-agent-seller/product/query'); assert.equal(typeof input.productId, 'string'); return product; }, mallIdClient: { getMallIdAsync: async () => 'test-mall' } });
runtime.m = { 987654: function(e) { e.postWithoutMallId = null; e.mallIdClient = { getMallIdAsync() {} }; } };
const chunks = [];
chunks.push = chunk => chunk[2](runtime);
const location = { hostname: 'agentseller.temu.com', pathname: '/goods/list', origin: 'https://agentseller.temu.com', href: 'https://agentseller.temu.com/goods/list' };
const window = { chunkLoadingGlobal_temu_sca_goods: chunks, addEventListener: (_, fn) => { listener = fn; }, postMessage: value => replies.push(value) };
vm.runInNewContext(code, { window, location, crypto: webcrypto, TextEncoder, setTimeout, clearTimeout, URL });
const query = id => listener({ source: window, origin: location.origin, data: { source: 'temu-shop-transfer-api-v1', kind: 'query', requestId: webcrypto.randomUUID(), runId: 'run-1', spuId: id } });
await query('5372907865');
assert.equal(replies.at(-1).payload.result.productId, '5372907865');
await query('3714507798');
assert.match(replies.at(-1).error, /不匹配/);
location.pathname = '/goods/edit';
await query('5372907865');
assert.match(replies.at(-1).error, /列表页/);
assert.equal(calls, 2);

const record = { dataType: 'product-detail', source: { requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query', pageUrl: location.href, pageProductId: '5372907865' }, identity: { productIds: ['5372907865'], goodsIds: [], skcIds: [], skuIds: [] }, payload: { success: true, result: product } };
const parse = records => parseImportedFiles([{ originalName: 'temu-full-capture-test.json', payload: { kind: 'full-capture-packet', exportMode: 'full-capture', source: { allowedSpuIds: ['5372907865'] }, records } }]);
const parsed = parse([record]);
assert.equal(parsed.products.length, 1);
assert.equal(parsed.products[0].skus.length, 2);
assert.equal(parsed.products[0].skcIds[0], '66847115779');
assert.equal(parsed.products[0].completeness.detailState, 'source-empty');
assert.equal(parsed.products[0].ready, true);
assert.equal(parsed.products[0].completeness.hasDetail, false);
const withBody = parse([{ ...record, payload: { success: true, result: { ...product, goodsLayerDecorationVOList: [{imgUrl:'https://example.com/detail.jpg'}] } } }]);
assert.equal(withBody.products[0].completeness.hasDetail, true);
assert.equal(withBody.products[0].completeness.detailState, 'present');
const absentBody = {...product};
delete absentBody.goodsLayerDecorationVOList;
delete absentBody.goodsLayerDecorationCustomizeI18nVOList;
assert.equal(parse([{...record,payload:{success:true,result:absentBody}}]).products[0].completeness.detailState, 'unverified');
assert.equal(parse([{ ...record, source: { ...record.source, requestUrl: '/product/skc/pageQuery' } }]).products[0].completeness.hasPrimaryDetail, false);
assert.equal(parse([{ ...record, payload: { success: false, result: product } }]).products[0].completeness.hasPrimaryDetail, false);
assert.equal(parse([{ ...record, payload: { success: true, result: { ...product, productId: '3714507798' } } }]).products.length, 0);
console.log('API批采：客户端动态发现、字符串ID、路由限制、错ID拒绝、空正文证据及双SKU解析通过');

// 临时仓库存储回归，绝不接触正式data目录；再次读取仍应保留核心详情已采证据。
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ziniao-api-batch-'));
const warehouse = createStore(tempRoot);
await warehouse.importFiles([{ originalName: 'temu-full-capture-api-test.json', payload: { kind: 'full-capture-packet', source: { shopName: '测试店', sourceStoreId: 'test-store', allowedSpuIds: ['5372907865'] }, records: [record] } }]);
const overview = await warehouse.listOverview();
assert.equal(overview.productCount, 1);
assert.equal(overview.missingDetailCount, 0);
assert.equal(overview.sourceEmptyDetailCount, 1);
assert.equal(overview.products[0].skus.length, 2);
console.log('临时仓库入库/持久化/空正文统计通过');

// 后台状态机使用内存存储与假落库，验证真实队列函数；不触及浏览器扩展或店铺数据。
const sessionData = {};
const background = await fs.readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
const bg = vm.createContext({ crypto: webcrypto, TextEncoder, URL, URLSearchParams, setTimeout, clearTimeout, console,
    importScripts() {}, chrome: { storage: { session: {
        async get(key) { return structuredClone({ [key]: sessionData[key] }); },
        async set(values) { Object.assign(sessionData, structuredClone(values)); },
        async remove(key) { delete sessionData[key]; }
    } }, tabs: { async update() { throw new Error('禁止导航'); } }, runtime: { getManifest: () => ({ version: '10.5.0' }) } }
});
vm.runInContext(background.split('chrome.runtime.onMessage.addListener')[0], bg);
vm.runInContext(`
    globalThis.logs = [];
    appendCaptureLog = async value => logs.push(value);
    exportFullPacketToDownload = async () => ({exported:true,fileName:'test.json'});
    saveCapture = async event => ({eventId:event.payload.result.productId, productRelated:true, detailCapture:summarizeDetailCapture(event.payload,event.requestUrl,'https://agentseller.temu.com/goods/list',200)});
`, bg);
const sender = { tab: { id: 7, url: 'https://agentseller.temu.com/goods/list' } };
sessionData['captureEnabledTab:7'] = true;
const queue = await bg.beginDetailSupplement({ spuIds: ['5372907865', '3714507798'], eventIds: ['list'], listUrl: sender.tab.url }, sender);
assert.equal(queue.mode, 'api');
assert.ok(queue.runId);
const input = { runId: queue.runId, spuId: '5372907865', payload: {success:true, result: product} };
const first = await bg.withDetailQueue(7, () => bg.captureApiDetail(input, sender));
assert.equal(first.queue.completed, 1);
assert.equal(first.queue.complete, 1);
assert.equal(first.queue.current.spuId, '3714507798');
await assert.rejects(() => bg.withDetailQueue(7, () => bg.captureApiDetail(input, sender)), /stale_detail_run/);
const failed = await bg.withDetailQueue(7, () => bg.advanceDetailSupplement({runId:queue.runId,spuId:'3714507798',status:'failed',reason:'测试403'}, sender));
assert.equal(failed.active, false);
assert.equal(failed.failed, 1);
// 采集完成不再自动下载，避免后台静默生成文件；导出由用户在导出页主动发起。
assert.equal(failed.finalization.download.status, 'skipped');
assert.match(failed.finalization.download.reason, /不自动下载/);
assert.ok(bg.logs.some(log => log.status === 'api-detail-failed'));
await bg.withDetailQueue(7, () => bg.clearDetailSupplement(sender));
await assert.rejects(() => bg.withDetailQueue(7, () => bg.captureApiDetail(input, sender)), /stale_detail_run/);
console.log('后台API队列：落库推进、空正文完成、重复回执拒绝、失败日志、停止失效及不导航通过');

// 实际详情渲染器校验三种正文状态，防止后端正确但网页仍输出误导性提示。
const uiCode = await fs.readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const element = { innerHTML: '', addEventListener() {} };
const ui = vm.createContext({ document: { getElementById: () => element, querySelectorAll: () => [] }, location: {hash:'#/products'}, window: {}, console });
vm.runInContext(uiCode.split('window.addEventListener("hashchange", route);')[0], ui);
ui.renderProduct({ product: parsed.products[0], batches: [] });
assert.match(element.innerHTML, /源正文为空/);
assert.doesNotMatch(element.innerHTML, /需要在 Temu 打开商品详情或编辑页/);
ui.renderProduct({ product: withBody.products[0], batches: [] });
assert.match(element.innerHTML, /detail.jpg/);
assert.doesNotMatch(element.innerHTML, /原商品没有详情正文/);
console.log('商品页面真实渲染器：已采空正文/非空图文展示通过');
