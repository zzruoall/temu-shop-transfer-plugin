/** 只读实拍图采集的离线边界测试：接口和原图均为夹具，不执行平台上传或识别。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const dir = path.join(__dirname, '..');
const spuId = '54775564555', skuId = '502495462444', goodsId = '607030089729277';

/** 两级图片位置和四类视角来自核对过的官方返回；主图与示例字段故意混入以验证排除。 */
function fixtures() {
    const sourceProduct = { productId: spuId, productSkcList: [{ extCode: 'M1566', productSkuList: [{ productSkuId: skuId, extCode: 'M1566' }] }] };
    const config = { positionInfoList: [1, 2].map(position => ({ position, desc: position === 1 ? '商品主体实拍图' : '商品外包装实拍图',
        positionTypeInfo: ['正视图', '侧视图', '标签图', '其他'].map((desc, type) => ({ type, desc })) })) };
    const detail = { spuId, goodsId, skuInfo: [{ skuId, skuImage: 'https://img.kwcdn.com/main.jpg' }],
        ruleCheckResultList: [{ exampleInfo: { examplePicList: ['https://img.kwcdn.com/example.jpg'] } }],
        positionDetail: [1, 2].map(position => ({ position, isSameSku: true, skuInfo: [{ skuId }], skuPhotoInfoList: [{ skuId: 0,
            imageList: [0, 1, 2, 3].map(positionType => ({ positionType, imageUrl: `https://pos.file.temu.com/flash-tag/${position}-${positionType}.jpeg?signature=private` })) }] })) };
    return { sourceProduct, config, detail, list: { total: 1, isSemiManagedMall: false, items: [{ spuId, goodsId }] } };
}

function setup(mutate = () => {}, download = null) {
    const f = fixtures(), calls = [], downloads = [];
    mutate(f);
    const context = vm.createContext({ console, URL, TextEncoder, Uint8Array, DataView, atob, btoa, AbortController, setTimeout, clearTimeout });
    for (const name of ['qualification-reader.js', 'live-photo-reader.js']) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), context);
    const captureContext = { spuId, mallId: '634418214794015', sourceProduct: f.sourceProduct, pageOrigin: 'https://agentseller.temu.com',
        assertCurrent: async () => {}, post: async (url, input) => {
            calls.push({ url, input });
            return url.endsWith('/list') ? f.list : url.endsWith('/detail') ? f.detail : f.config;
        }, fetch: async url => {
            downloads.push(url);
            if (download) return download(url);
            return { ok: true, url, headers: new Headers({ 'content-type': 'image/jpeg' }),
                body: new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([255, 216, 255, 0])); controller.close(); } }) };
        } };
    return { f, context, reader: context.TemuLivePhotoReader, calls, downloads, captureContext };
}

test('通过三种只读查询取八张原图，位置和视角独立，排除主图和示例', async () => {
    const h = setup();
    const result = await h.reader.readSnapshot({}, h.captureContext);
    assert.equal(result.snapshot.status, 'complete');
    assert.equal(result.snapshot.assets.length, 8);
    assert.equal(result.snapshot.groups.length, 2);
    assert.deepEqual(h.calls.map(x => x.url), [h.reader.LIST_PATH, h.reader.DETAIL_PATH, h.reader.CONFIG_PATH]);
    assert.deepEqual(Array.from(h.calls[0].input.spu_id_list), [spuId]);
    assert.equal(h.downloads.length, 8);
    assert.ok(h.downloads.every(url => url.includes('signature=private')));
    assert.ok(result.snapshot.assets.every(asset => !asset.url.includes('?')));
    assert.equal(result.snapshot.groups[0].images[2].typeLabel, '标签图');
    assert.equal(result.snapshot.skus[0].skuExtCode, 'M1566');
    assert.ok(!JSON.stringify(result.snapshot).includes('main.jpg'));
    assert.ok(!JSON.stringify(result.snapshot).includes('example.jpg'));
    h.reader.validateSnapshot(result.snapshot, spuId);
});

test('同图多位置只下载一次，但每处位置和用途都保留', async () => {
    const h = setup(f => { f.detail.positionDetail[1].skuPhotoInfoList[0].imageList[0].imageUrl = f.detail.positionDetail[0].skuPhotoInfoList[0].imageList[0].imageUrl; });
    const { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
    assert.equal(snapshot.status, 'complete'); assert.equal(snapshot.assets.length, 7);
    assert.equal(snapshot.groups.reduce((n, g) => n + g.images.length, 0), 8);
});

test('按实际 SKU 保存不共用照片，不因重排图片或位置改变映射', async () => {
    const second = '502495462445';
    const h = setup(f => {
        f.sourceProduct.productSkcList[0].productSkuList.push({ productSkuId: second, extCode: 'OTHER' });
        f.detail.skuInfo.push({ skuId: second });
        for (const group of f.detail.positionDetail) {
            group.isSameSku = false; group.skuInfo.push({ skuId: second });
            group.skuPhotoInfoList[0].skuId = skuId;
            group.skuPhotoInfoList.push({ skuId: second, imageList: [{ imageUrl: 'https://img.kwcdn.com/other.jpg', positionType: 2 }] });
            group.skuPhotoInfoList.reverse();
        }
        f.detail.positionDetail.reverse(); f.config.positionInfoList.reverse();
    });
    const { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
    assert.equal(snapshot.status, 'complete');
    assert.equal(snapshot.groups[0].position, 2);
    assert.equal(snapshot.groups[0].images[0].skuId, second);
    assert.equal(snapshot.groups[0].images[0].typeLabel, '标签图');
});

test('明确空槽与列表无商品是正常无图片，不用主图或示例补足', async () => {
    for (const absent of [false, true]) {
        const h = setup(f => {
            if (absent) { f.list.total = 0; f.list.items = []; }
            else for (const group of f.detail.positionDetail) group.skuPhotoInfoList = [];
        });
        const { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
        assert.equal(snapshot.status, 'complete'); assert.equal(snapshot.assets.length, 0);
        assert.equal(snapshot.captureState, absent ? 'not-found' : 'empty');
        assert.equal(h.downloads.length, 0);
    }
});

test('旧的空位置保留编号，不猜位置名或把位置编号解释为视角', async () => {
    const h = setup(f => f.detail.positionDetail.push({ position: 5, isSameSku: true, skuInfo: [{ skuId }], skuPhotoInfoList: [] }));
    const { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
    assert.equal(snapshot.status, 'complete'); assert.equal(snapshot.groups[2].label, '');
});

test('其他商品、其他SKU、未知分类、缺结构与未核验模式都不能保存为空图', async () => {
    for (const mutate of [
        f => { f.list.items[0].spuId = '99999999999'; },
        f => { f.detail.skuInfo[0].skuId = '99999999999'; },
        f => { f.detail.positionDetail[0].skuPhotoInfoList[0].imageList[0].positionType = 99; },
        f => { delete f.detail.positionDetail[0].skuPhotoInfoList; },
        f => { f.list.isSemiManagedMall = true; },
        f => { f.list.success = false; f.list.errorCode = 403; },
        f => { f.detail.positionDetail[0].isSameSku = false; }
    ]) {
        const h = setup(mutate), { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
        assert.equal(snapshot.status, 'failed'); assert.equal(snapshot.captureState, 'failed');
        assert.equal(h.downloads.length, 0);
    }
});

test('下载失败保留分类并明确部分归档，PDF不得冒充实拍图', async () => {
    for (const pdf of [false, true]) {
        const h = setup(() => {}, async url => {
            if (!pdf) throw Error(`失败含私有地址 ${url}`);
            return { ok: true, url, headers: new Headers({ 'content-type': 'application/pdf' }),
                body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('%PDF-1.7')); controller.close(); } }) };
        });
        const { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
        assert.equal(snapshot.status, 'partial'); assert.equal(snapshot.archive.status, 'failed');
        assert.equal(snapshot.assets.length, 0); assert.equal(snapshot.groups.length, 2);
        assert.ok(!JSON.stringify(snapshot).includes('signature='));
    }
});

test('切店或取消停止下一步请求，图片失败不污染商品和证书快照', async () => {
    const h = setup(); h.captureContext.assertCurrent = async () => { throw Object.assign(Error('切店'), { stopBatch: true }); };
    const r = await h.reader.readSnapshot({}, h.captureContext);
    assert.equal(r.stopBatch, true); assert.equal(r.snapshot.status, 'failed'); assert.equal(h.calls.length, 0);
});

test('证书已用满共用正文预算时只保留图片分类并报告未归档，不继续下载', async () => {
    const h = setup(); h.captureContext.assetBudgetBytes = 0;
    const { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
    assert.equal(snapshot.status, 'partial'); assert.equal(snapshot.captureState, 'captured');
    assert.equal(snapshot.groups.length, 2); assert.equal(h.downloads.length, 0);
    assert.match(snapshot.archive.errors[0].reason, /剩余归档预算/);
});

test('后台归档及完整包包含专用实拍图，原始旁路响应仍排除在线记录', async () => {
    const h = setup(), { snapshot } = await h.reader.readSnapshot({}, h.captureContext);
    const records = [], downloads = [];
    const ctx = h.context;
    Object.assign(ctx, { crypto: webcrypto, structuredClone, importScripts() {}, records, downloads,
        chrome: { runtime: { getManifest: () => ({ version: '11.0.8' }) }, storage: {
            local: { get: async () => ({}), set: async () => {}, remove: async () => {} },
            session: { get: async () => ({}), set: async () => {}, remove: async () => {} } } } });
    for (const name of ['packet.js', 'transfer-integrity.js']) vm.runInContext(fs.readFileSync(path.join(dir, name), 'utf8'), ctx);
    const background = fs.readFileSync(path.join(dir, 'background.js'), 'utf8');
    vm.runInContext(background.split('chrome.runtime.onMessage.addListener')[0], ctx);
    vm.runInContext(`runTransaction=async(_,fn)=>new Promise((resolve,reject)=>{
        const request=result=>{const req={result};setTimeout(()=>req.onsuccess(),0);return req;};
        fn({get:()=>request(null),add:value=>{records.push(value);return request();}},resolve,{abort:()=>reject(Error('事务失败'))});
    });getAllRecords=async()=>records;packetSourceOptions=async value=>({...value,sourceStoreId:'fixture'});
    chrome.downloads={download:async value=>{downloads.push(value);return 1;}};`, ctx);
    const saved = await ctx.saveCapture({ kind: 'network-json', requestUrl: `https://agentseller.temu.com${h.reader.DETAIL_PATH}`,
        responseStatus: 200, payload: { success: true, result: snapshot } }, { tab: { id: 7, url: 'https://agentseller.temu.com/goods/list' } });
    assert.equal(records[0].dataType, 'product-live-photos'); assert.deepEqual(Array.from(saved.productIds), [spuId]);
    assert.equal(records[0].identity.skuIds.length, 0);
    const native = await ctx.saveCapture({ kind: 'network-json', requestUrl: `https://agentseller.temu.com${h.reader.DETAIL_PATH}`,
        payload: { spuId, materialImgUrl: 'https://img.kwcdn.com/main.jpg', examplePicList: ['https://img.kwcdn.com/example.jpg'] } },
        { tab: { id: 7, url: 'https://agentseller.temu.com/goods/list' } });
    assert.equal(native.skipped, true); assert.equal(records.length, 1);
    await ctx.exportFullPacketToDownload({ eventIds: [saved.eventId], allowedSpuIds: [spuId] });
    const packet = JSON.parse(decodeURIComponent(downloads[0].url.split(',').slice(1).join(',')));
    assert.equal(packet.records.length, 1);
    assert.equal(packet.records[0].payload.result.assets.length, 8);
    assert.equal(packet.localOnlyRecords, undefined);
    // 新服务端支持专用快照，但历史旁路响应仍不可绕过位置分类进入records。
    records.push({ dataType: 'unknown', source: { requestUrl: 'https://agentseller.temu.com/api/flash/real_picture/list' } });
    const exported = ctx.makeFullCapturePacket(records);
    assert.equal(exported.records.length, 1);
    assert.equal(exported.localOnlyRecords.length, 1);
    const altered = structuredClone(snapshot); altered.assets[0].sha256 = '0'.repeat(64);
    assert.throws(() => h.reader.validateSnapshot(altered, spuId), /SHA-256/);
});

test('通用页面 Hook 不转发实拍图原始响应，其他商品响应保持原行为', async () => {
    for (const diagnostic of [false, true]) {
        const messages = [];
        class Xhr { open() {} send() {} }
        const window = { fetch: async () => new Response(JSON.stringify({ spuId, examplePicList: ['example.jpg'] })),
            postMessage: value => messages.push(value), addEventListener() {} };
        const context = vm.createContext({ window, XMLHttpRequest: Xhr, URL, TextEncoder,
            location: { origin: 'https://agentseller.temu.com', href: 'https://agentseller.temu.com/goods/list' },
            document: { documentElement: { getAttribute: () => diagnostic ? '1' : '0' } }, history: { pushState() {}, replaceState() {} } });
        vm.runInContext(fs.readFileSync(path.join(dir, 'page-hook.js'), 'utf8'), context);
        for (const url of ['https://agentseller.temu.com/api/flash/real_picture/detail', 'https://agentseller.temu.com/api/flash/hq/real_picture/list']) {
            await window.fetch(url); await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(messages.every(message => message.kind !== 'network-json'));
        assert.ok(messages.every(message => !JSON.stringify(message).includes('example.jpg')));
        await window.fetch('https://agentseller.temu.com/visage-agent-seller/product/query');
        await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(messages.filter(message => message.kind === 'network-json').length, 1);
    }
});
