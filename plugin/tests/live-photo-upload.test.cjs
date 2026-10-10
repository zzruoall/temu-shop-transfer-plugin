/** 上传只连接内存平台：覆盖采集位置路由、重复投递和暂停恢复，不调用真实店铺写接口。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto, createHash } = require('node:crypto');
const dir = path.join(__dirname, '..');
const sourceId = '54775564555', sourceSku = '502495462444', targetId = '48318458968', targetSku = '504944115999';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const clone = value => structuredClone(value);

/** 每张合成原图都有不同的哈希；两级位置、四种视角与商品货号保持独立。 */
function fixture() {
    const assets = [], groups = [1, 2].map(position => ({ position, label: position === 1 ? '商品主体实拍图' : '商品外包装实拍图',
        isSameSku: true, skuIds: [sourceSku], images: [0, 1, 2, 3].map(positionType => {
            const bytes = Buffer.from([255, 216, 255, position, positionType]);
            const url = `https://pos.file.temu.com/flash-tag/${position}-${positionType}.jpeg`;
            assets.push({ url, name: `${position}-${positionType}.jpeg`, bytes: bytes.length, mimeType: 'image/jpeg', sha256: hash(bytes), dataBase64: bytes.toString('base64') });
            return { skuId: '0', positionType, typeLabel: ['正视图', '侧视图', '标签图', '其他'][positionType], url, name: `${position}-${positionType}.jpeg` };
        }) }));
    const source = { schemaVersion: 1, productId: sourceId, mallId: '634418214794015', capturedAt: new Date().toISOString(),
        status: 'complete', captureState: 'captured', reason: '', goodsId: '607030089729277',
        skus: [{ skuId: sourceSku, skuExtCode: 'M1566', productExtCode: 'M1566' }], groups, assets, archive: { status: 'complete', errors: [] } };
    const target = { productId: targetId, goodsId: '607555686365328',
        skus: [{ skuId: targetSku, skuExtCode: 'M1566' }],
        detail: { spuId: targetId, goodsId: '607555686365328', skuInfo: [{ skuId: targetSku }],
            positionDetail: [1, 2].map(position => ({ position, isSameSku: true, skuInfo: [{ skuId: targetSku }], skuPhotoInfoList: [{ skuId: 0, imageList: [] }] })) },
        config: { positionInfoList: [1, 2].map(position => ({ position,
            positionTypeInfo: [0, 1, 2, 3].map(type => ({ type, limitNums: type === 0 ? 1 : 20 })) })) } };
    return { source, target };
}

/** SDK、存储和页面客户端均为内存替身，任何未列入白名单的路径会立即让测试失败。 */
function harness(options = {}) {
    const f = fixture(), calls = [], sdkCalls = [], writes = [], stored = {}, progress = [];
    const originalAssets = clone(f.source.assets), archivedReads = [];
    if (options.references) f.source.assets = f.source.assets.map(({ dataBase64, ...ref }) => ref);
    let paused = false, tail = Promise.resolve();
    const client = { mallIdClient: { getMallIdAsync: async () => options.mallChanged ? 'WRONG' : '634418214794848' },
        post: async (url, input) => {
            calls.push({ url, input: clone(input) });
            if (url.endsWith('/real_picture/list')) return { total: 1, is_semi_managed_mall: false,
                items: [{ spu_id: targetId, goods_id: f.target.goodsId, new_pop_up_gray: true }] };
            if (url.endsWith('/real_picture/detail')) return clone(f.target.detail);
            if (url.endsWith('/query_upload_param')) return clone(f.target.config);
            if (url === '/visage-agent-seller/product/query') return { productId: targetId,
                productSkcList: [{ extCode: 'M1566', productSkuList: f.target.skus.map(sku => ({ productSkuId: sku.skuId, extCode: sku.skuExtCode })) }] };
            if (url.endsWith('/compliance_property/signature')) return 'synthetic-signature';
            if (url === '/api/flash/real_picture/pre_verification') {
                if (options.writeFailure) throw Error('模拟网络丢失响应');
                if (options.unconfirmed) return { check_result: false };
                // 模拟平台落库；第二次投递必须根据真实槽位跳过，而不是仅依据旧任务状态。
                for (const group of input.real_picture_info_list) {
                    const target = f.target.detail.positionDetail.find(row => row.position === group.position);
                    target.isSameSku = group.is_same_sku;
                    target.skuPhotoInfoList = group.is_same_sku ? [{ skuId: 0, imageList: group.sku_photo_info_list[0].image_list.map(image => ({ imageUrl: image.image_url, positionType: image.position_type })) }]
                        : group.sku_photo_info_list.map(row => ({ skuId: row.sku_id, imageList: row.image_list.map(image => ({ imageUrl: image.image_url, positionType: image.position_type })) }));
                }
                return { check_result: true };
            }
            throw Error(`禁止未知接口 ${url}`);
        } };
    class SDK {
        setScene(value) { sdkCalls.push(['scene', value]); return this; }
        setTag(value) { sdkCalls.push(['tag', value]); return this; }
        isProduct() { return this; }
        setUploadHost() { return this; }
        setSignatureHost() { return this; }
        setTimeout(value) { sdkCalls.push(['timeout', value]); return this; }
        setMaxRetryCount(value) { assert.equal(value, 0); return this; }
        init() { return this; }
        uploadFile() { throw Error('实拍图不能用文件上传器'); }
        uploadImage() {
            let file;
            return { setSignature() { return this; }, setUrlSign() { throw Error('实拍图不沿用证书私有 URL 签名'); },
                setData(value) { file = value; return this; }, async build() {
                    const sha256 = hash(Buffer.from(await file.arrayBuffer()));
                    sdkCalls.push(['upload', sha256]);
                    if (options.uploadFailure && sha256 === f.source.assets[0].sha256) throw Error('模拟附件结果丢失');
                    if (options.pauseAfterUpload) paused = true;
                    if (options.changeAfterUpload) f.target.config.positionInfoList[0].positionTypeInfo[0].limitNums = 2;
                    if (options.changeOrderAfterUpload) {
                        f.target.config.positionInfoList.reverse(); f.target.detail.positionDetail.reverse();
                        f.target.config.positionInfoList.forEach(position => position.positionTypeInfo.reverse());
                        options.changeOrderAfterUpload = false;
                    }
                    return { url: `https://pos.file.temu.com/flash-tag/target-${sha256}.jpeg`, imageInfo: { width: 3072, height: 4096 } };
                } };
        }
    }
    const runtime = name => name === 'client' ? client : { Ay: SDK, ju: { PUBLIC_C: 27, PUBLIC_C_US: 1 } };
    runtime.m = { client: 'getMallIdAsync .postWithoutMallId= .mallIdClient=', sdk: 'PUBLIC_C uploadFile=function setSignature=function' };
    const ctx = vm.createContext({ URL, TextEncoder, Uint8Array, DataView, AbortController, atob, btoa, Map, File, crypto: webcrypto,
        setTimeout: (fn, ms) => setTimeout(fn, ms >= 15000 ? ms : 0), clearTimeout,
        fetch: () => { throw Error('测试禁止真实网络'); },
        location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list', host: 'agentseller.temu.com' },
        window: { __temuExecutionRound: { id: 'run', stopped: false }, chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } },
        chrome: { scripting: { executeScript: async () => [] }, storage: { local: {
            get: async key => key == null ? clone(stored) : Array.isArray(key) ? Object.fromEntries(key.map(name => [name, clone(stored[name])])) : { [key]: clone(stored[key]) },
            set: async values => Object.assign(stored, clone(values)), remove: async key => { delete stored[key]; }
        } } },
        readDirectPause: async () => paused ? { paused: true } : null, directStopRequested: new Set(),
        assertExecutionDocument: async () => {}, executionWithDeadline: fn => fn(),
        withTargetTaskMutation: fn => { const result = tail.then(fn); tail = result.catch(() => {}); return result; },
        writeDirectAttempt: async (_task, _key, record) => writes.push(clone(record)),
        rememberDirectProgress: async (_task, patch) => progress.push(clone(patch)),
        directErrorText: error => error.message || String(error), TemuOperationLog: { append: async () => {} }, closeLivePhotoPanel: async () => {} });
    for (const name of ['qualification-reader', 'live-photo-reader', 'live-photo-transfer', 'attachment-ledger', 'qualification-page', 'qualification-executor', 'live-photo-executor']) {
        vm.runInContext(fs.readFileSync(path.join(dir, `${name}.js`), 'utf8'), ctx, { filename: `${name}.js` });
    }
    const governRuntime = name => name === 'client' ? { Z: client } : name === 'identity' ? { vx: () => options.mallChanged ? 'WRONG' : '634418214794848' } : { ZP: SDK, cJ: { PUBLIC_C_US: 1 } };
    governRuntime.m = { client: 'govern_verify_auth_token anti-content Mallid', identity: 'agentseller-mall-info-id getItem vx:',
        sdk: 'PUBLIC_C_US uploadImage=function setSignature=function' };
    const govern = vm.createContext({ crypto: webcrypto, Uint8Array, atob, File, setTimeout, clearTimeout,
        location: { origin: 'https://agentseller.temu.com', pathname: '/govern/compliant-live-photos', host: 'agentseller.temu.com' },
        window: { __temuLivePhotoUploadBinding: { token: 'photo-token', mallId: '634418214794848', stopped: false },
            webpackChunkbgb_sc_govern: { push: entry => entry[2](governRuntime) } } });
    vm.runInContext(fs.readFileSync(path.join(dir, 'live-photo-upload-page.js'), 'utf8'), govern);
    ctx.qualificationPage = (_tab, operation, identity, payload) => operation === 'photo-upload'
        || operation === 'status' && String(payload.attemptId).startsWith('photo:')
        ? govern.window.__temuLivePhotoUploadPage.run(operation, { ...payload, photoToken: 'photo-token', mallId: identity.mallId })
        : ctx.window.__temuQualificationPage.run(operation, { ...payload, mallId: identity.mallId, executionRunId: identity.executionRunId });
    const task = { jobId: 'photo-job', spuId: sourceId, sourceStoreId: `temu:${f.source.mallId}`, snapshot: { livePhotos: f.source } };
    const identity = { mallId: '634418214794848', storeId: 'temu:634418214794848', documentId: 'doc', executionRunId: 'run' };
    if (options.references) {
        // 实际下载器读取合成流，证明引用任务不会使用来源URL或把正文放入持久化任务。
        ctx.getIngestSettings = async () => ({ endpoint: 'https://warehouse.invalid/temu/api/ingest', token: 'fixture-token' });
        ctx.ensureIngestPermission = async () => true;
        ctx.getPluginInstanceId = async () => 'fixture-instance';
        ctx.hubApiUrl = (_endpoint, pathname) => 'https://warehouse.invalid/temu' + pathname;
        ctx.authenticatedIngestFetch = async (url, _settings, request) => {
            archivedReads.push({ url, headers: request.headers });
            const asset = originalAssets.find(asset => url.includes(asset.sha256));
            const data = Buffer.from(asset.dataBase64, 'base64');
            if (options.badArchive) data[data.length - 1] ^= 1;
            return new Response(data, { headers: { 'content-length': String(data.length), 'content-type': asset.mimeType } });
        };
    }
    const record = { stage: 'qualifying', mallId: identity.mallId, productId: targetId };
    return { ...f, ctx, govern, calls, sdkCalls, writes, stored, progress, archivedReads, task, identity, record,
        pause: value => { paused = value; }, run: (value = record) => ctx.runDirectLivePhotos(task, identity, 1, value, 'key') };
}

test('服务端引用任务按认证实拍图接口读取，正确分类上传且任务回执不含字节', async () => {
    const h = harness({ references: true });
    const result = await h.run();
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.equal(h.archivedReads.length, 8);
    assert.ok(h.archivedReads.every(read => read.url.startsWith(`https://warehouse.invalid/temu/api/live-photo-assets/${sourceId}/`)
        && new URL(read.url).searchParams.get('sourceStoreId') === h.task.sourceStoreId
        && read.headers['x-plugin-instance'] === 'fixture-instance'));
    assert.doesNotMatch(JSON.stringify(h.task), /dataBase64/);
    assert.doesNotMatch(JSON.stringify(h.stored), /dataBase64/);
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 8);
});

test('引用下载哈希不一致不得进入SDK、不得提交残缺槽位', async () => {
    const h = harness({ references: true, badArchive: true });
    assert.equal((await h.run()).state, 'partial');
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 0);
    assert.equal(h.calls.filter(call => call.url.endsWith('/pre_verification')).length, 0);
});

test('八张照片走独立实拍图接口和flash-tag，按位置与视角填入，重复任务不追加', async () => {
    const h = harness(), before = clone(h.source);
    h.source.groups.reverse(); h.source.groups.forEach(group => group.images.reverse());
    const result = await h.run();
    assert.equal(result.state, 'complete');
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 8);
    assert.ok(h.sdkCalls.filter(call => call[0] === 'scene').every(call => call[1] === 1));
    assert.ok(h.sdkCalls.filter(call => call[0] === 'tag').every(call => call[1] === 'flash-tag'));
    assert.ok(h.sdkCalls.filter(call => call[0] === 'timeout').every(call => call[1] === 60000));
    const write = h.calls.find(call => call.url.endsWith('/pre_verification'));
    assert.ok(write);
    assert.equal(write.input.spu_id, targetId);
    for (const group of write.input.real_picture_info_list) for (const image of group.sku_photo_info_list[0].image_list) {
        const original = before.assets.find(asset => asset.url.endsWith(`${group.position}-${image.position_type}.jpeg`));
        assert.ok(image.image_url.includes(original.sha256));
    }
    assert.ok(!h.calls.some(call => call.url.includes('/cert/product/upload') || call.url.includes('/upload_new')));
    assert.doesNotMatch(JSON.stringify([h.writes, h.stored, h.progress]), /dataBase64|synthetic-signature/);
    await h.run();
    await h.run({ stage: 'qualifying', mallId: h.identity.mallId, productId: targetId });
    assert.equal(h.calls.filter(call => call.url.endsWith('/pre_verification')).length, 1);
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 8);
});

test('相同字节跨位置只上传一次，但引用保留两处位置', async () => {
    const h = harness();
    h.source.groups[1].images[0].url = h.source.groups[0].images[0].url;
    h.source.assets = h.source.assets.filter(asset => asset.url !== 'https://pos.file.temu.com/flash-tag/2-0.jpeg');
    assert.equal((await h.run()).state, 'complete');
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 7);
    const write = h.calls.find(call => call.url.endsWith('/pre_verification')).input;
    assert.equal(write.real_picture_info_list[0].sku_photo_info_list[0].image_list[0].image_url,
        write.real_picture_info_list[1].sku_photo_info_list[0].image_list[0].image_url);
});

test('目标已有某一视角则只补缺失位置，不追加或替换已有图', async () => {
    const h = harness(), existing = 'https://pos.file.temu.com/flash-tag/existing.jpeg';
    h.target.detail.positionDetail[0].skuPhotoInfoList[0].imageList.push({ imageUrl: existing, positionType: 0 });
    assert.equal((await h.run()).state, 'complete');
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 7);
    const images = h.calls.find(call => call.url.endsWith('/pre_verification')).input.real_picture_info_list[0].sku_photo_info_list[0].image_list;
    assert.equal(images.filter(image => image.position_type === 0).length, 1);
    assert.equal(images.find(image => image.position_type === 0).image_url, existing);
});

test('附件上传后暂停，恢复复用回执而不是再次上传第一张', async () => {
    const options = { pauseAfterUpload: true }, h = harness(options);
    assert.equal((await h.run()).state, 'stopped');
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 1);
    assert.equal(h.calls.filter(call => call.url.endsWith('/pre_verification')).length, 0);
    options.pauseAfterUpload = false; h.pause(false);
    assert.equal((await h.run()).state, 'complete');
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 8);
});

test('识别未通过或响应丢失记为待核对，不确认、不重发', async () => {
    for (const options of [{ unconfirmed: true }, { writeFailure: true }]) {
        const h = harness(options);
        assert.equal((await h.run()).state, 'unknown');
        assert.equal((await h.run({ stage: 'qualifying', mallId: h.identity.mallId, productId: targetId })).state, 'unknown');
        assert.equal((await h.run()).state, 'unknown');
        assert.equal(h.calls.filter(call => call.url.endsWith('/pre_verification')).length, 1);
        assert.ok(!h.calls.some(call => call.url.includes('upload_new') || call.url.endsWith('/confirm')));
    }
});

test('单张附件结果未知不重传，其它位置继续；该槽不提交残缺图片', async () => {
    const options = { uploadFailure: true }, h = harness(options);
    const firstHash = h.source.assets[0].sha256;
    assert.equal((await h.run()).state, 'partial');
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload' && call[1] === firstHash).length, 1);
    assert.equal(h.calls.find(call => call.url.endsWith('/pre_verification')).input.real_picture_info_list[0].sku_photo_info_list[0].image_list.some(image => image.position_type === 0), false);
    options.uploadFailure = false;
    await h.run({ stage: 'qualifying', mallId: h.identity.mallId, productId: targetId });
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload' && call[1] === firstHash).length, 1);
});

test('发出前模板变化或商城变化均不提交正文', async () => {
    const changed = harness({ changeAfterUpload: true });
    assert.equal((await changed.run()).state, 'partial');
    assert.equal(changed.calls.filter(call => call.url.endsWith('/pre_verification')).length, 0);
    const mall = harness({ mallChanged: true });
    assert.equal((await mall.run()).state, 'stopped');
    assert.equal(mall.calls.length, 0);
});

test('发出前目标位置和视角只改变排列顺序，仍按标识提交且不误报模板变化', async () => {
    const h = harness({ changeOrderAfterUpload: true });
    assert.equal((await h.run()).state, 'complete');
    assert.equal(h.calls.filter(call => call.url.endsWith('/pre_verification')).length, 1);
});

test('不提供实拍图快照时不从证书、商品主图或历史数组推测', async () => {
    const h = harness(); delete h.task.snapshot.livePhotos;
    const result = await h.run();
    assert.equal(result.state, 'not-delivered');
    assert.match(result.reason, /仅处理资质文件/);
    assert.equal(h.calls.length, 0);
});

test('网站明确下发历史实拍图证据时提示重新采集，不误报没有图片也不猜上传槽', async () => {
    const h = harness(); delete h.task.snapshot.livePhotos;
    h.task.snapshot.livePhotoCompatibility = { state: 'legacy-unclassified', imageCount: 4, knownPositions: [1, 2], missingFields: ['sku', 'view'] };
    const result = await h.run();
    assert.equal(result.state, 'partial'); assert.match(result.reason, /已归档 4 张.*视角和SKU归属/);
    assert.equal(h.calls.length, 0); assert.equal(h.sdkCalls.length, 0);
});

test('旧网站仍以资质结构下发图片时识别真实归档，示例、主图和未归档链接不算实拍图', async () => {
    const h = harness(), assets = h.source.assets.slice(0, 2); delete h.task.snapshot.livePhotos;
    const item = { status: 'complete', content: { realPictures: assets.map(asset => ({ imageUrl: asset.url, position: 1 })) },
        files: assets.map(asset => ({ url: asset.url, asset, role: '资质实拍图', archiveStatus: 'archived' })) };
    h.task.snapshot.qualifications = { schemaVersion: 1, spuId: sourceId, items: [item, clone(item)] };
    assert.match((await h.run()).reason, /已归档 2 张/);
    delete item.files[0].asset; delete item.files[1].asset;
    h.task.snapshot.qualifications.items = [item];
    h.task.snapshot.images = assets.map(asset => asset.url);
    assert.equal((await h.run()).state, 'not-delivered');
    assert.equal(h.calls.length, 0);
});

test('旧资格图片字段缺失或结构未知只跳过诊断，不能抛异常中断已执行的证书任务', async () => {
    for (const realPictures of [null, {}, 'unknown', [null, {}]]) {
        const h = harness(); delete h.task.snapshot.livePhotos;
        h.task.snapshot.qualifications = { schemaVersion: 1, spuId: sourceId,
            items: [{ status: 'complete', content: { realPictures }, files: {} }] };
        assert.equal((await h.run()).state, 'not-delivered'); assert.equal(h.calls.length, 0);
    }
});

test('独立实拍图快照优先于历史诊断，正常图片仍按对应位置上传', async () => {
    const h = harness();
    h.task.snapshot.livePhotoCompatibility = { state: 'legacy-unclassified', imageCount: 4 };
    assert.equal((await h.run()).state, 'complete');
    assert.equal(h.calls.filter(call => call.url.endsWith('/pre_verification')).length, 1);
});

test('目标对应位置和视角已完整存在时直接跳过，不因共用模式不同报错或重复上传', async () => {
    const h = harness();
    for (const group of h.target.detail.positionDetail) {
        group.isSameSku = false;
        group.skuPhotoInfoList = [{ skuId: targetSku, imageList: [0, 1, 2, 3].map(positionType => ({
            positionType, imageUrl: `https://pos.file.temu.com/existing-${group.position}-${positionType}.jpeg`
        })) }];
    }
    const result = await h.run();
    assert.equal(result.state, 'complete'); assert.ok(result.items.every(item => item.state === 'existing'));
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 0);
    assert.equal(h.calls.filter(call => call.url.endsWith('/pre_verification')).length, 0);
});

test('来源归属、SKU货号不匹配或重复、未知位置和视角均禁止猜测', () => {
    const h = harness(), api = h.ctx.TemuLivePhotoTransfer;
    for (const mutate of [
        target => { target.skus[0].skuExtCode = 'OTHER'; },
        target => { target.detail.goodsId = '1111111111'; },
        target => { target.skus[0].skuExtCode = ''; }
    ]) {
        const target = clone(h.target); mutate(target);
        assert.throws(() => api.plan(h.source, target), /匹配|归属/);
    }
    const target = clone(h.target); target.config.positionInfoList[0].positionTypeInfo = target.config.positionInfoList[0].positionTypeInfo.filter(type => type.type !== 0);
    const plan = api.plan(h.source, target);
    assert.ok(plan.items.some(item => item.state === 'failed'));
    assert.ok(!plan.additions.some(row => row.position === 1 && row.positionType === 0));
});

test('独立SKU按货号映射，不按源SKU ID或数组顺序填写', () => {
    const h = harness(), source = clone(h.source), target = clone(h.target);
    const secondSource = '502495462445', secondTarget = '504944116000';
    source.skus.push({ skuId: secondSource, skuExtCode: 'SECOND', productExtCode: 'M1566' });
    target.skus.unshift({ skuId: secondTarget, skuExtCode: 'SECOND' });
    target.detail.skuInfo.unshift({ skuId: secondTarget });
    for (const group of source.groups) {
        group.isSameSku = false; group.skuIds.push(secondSource);
        group.images.forEach(image => { image.skuId = sourceSku; });
        group.images.push({ ...group.images[0], skuId: secondSource });
        group.images.reverse();
    }
    for (const group of target.detail.positionDetail) { group.isSameSku = false; group.skuInfo.unshift({ skuId: secondTarget }); group.skuPhotoInfoList = []; }
    const plan = h.ctx.TemuLivePhotoTransfer.plan(source, target);
    const uploaded = new Map(source.assets.map(asset => [asset.sha256, `https://pos.file.temu.com/flash-tag/${asset.sha256}.jpeg`]));
    const request = h.ctx.TemuLivePhotoTransfer.requestFor(plan, uploaded);
    for (const group of request.realPictureInfoList) {
        assert.equal(group.isSameSku, false);
        assert.equal(group.skuPhotoInfoList.find(sku => sku.skuId === secondTarget).imageList.length, 1);
        assert.equal(group.skuPhotoInfoList.find(sku => sku.skuId === targetSku).imageList.length, 4);
    }
});

test('位置和视角重复引用去重，超过目标数量上限整个槽跳过不截断', () => {
    const h = harness();
    h.source.groups[0].images.push(clone(h.source.groups[0].images[0]));
    let plan = h.ctx.TemuLivePhotoTransfer.plan(h.source, h.target);
    assert.equal(plan.additions.length, 8);
    h.source.groups[0].images.push({ ...h.source.groups[0].images[1], positionType: 0 });
    plan = h.ctx.TemuLivePhotoTransfer.plan(h.source, h.target);
    assert.ok(plan.items.find(item => item.key === '1:0:0').state === 'failed');
    assert.ok(!plan.additions.some(row => row.position === 1 && row.positionType === 0));
});

test('图片归档哈希错误、来源混入非图片、共用改独立有已有图均不强行提交', () => {
    const h = harness(), bad = clone(h.source);
    bad.assets[0].sha256 = 'a'.repeat(64);
    assert.throws(() => h.ctx.TemuLivePhotoTransfer.plan(bad, h.target), /SHA-256|哈希/);
    const nonImage = clone(h.source); nonImage.assets[0].mimeType = 'application/pdf';
    assert.throws(() => h.ctx.TemuLivePhotoTransfer.plan(nonImage, h.target), /MIME|非图片/);
    const target = clone(h.target);
    target.detail.positionDetail[0].isSameSku = false;
    target.detail.positionDetail[0].skuPhotoInfoList = [{ skuId: targetSku, imageList: [{ imageUrl: 'https://img.kwcdn.com/existing.jpeg', positionType: 0 }] }];
    const plan = h.ctx.TemuLivePhotoTransfer.plan(h.source, target);
    assert.equal(plan.items.find(item => item.key === '1:0:0').state, 'existing');
    assert.ok(plan.items.filter(item => item.key.startsWith('1:') && item.key !== '1:0:0').every(item => item.state === 'failed'));
    assert.ok(plan.additions.every(row => row.position !== 1));
});

test('附件回执按用途隔离且不存字节，重复并发申请只产生一次上传', async () => {
    const h = harness(), asset = h.source.assets[0], file = { asset };
    const stopped = async () => false;
    const first = h.ctx.uploadTargetAttachment(h.task, h.identity, 1, targetId, file, 'live-photo', async () => asset, stopped);
    const second = h.ctx.uploadTargetAttachment(h.task, h.identity, 1, targetId, file, 'live-photo', async () => asset, stopped);
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 1);
    assert.ok(Object.keys(h.stored)[0].includes(':live-photo:'));
    assert.doesNotMatch(JSON.stringify(h.stored), /dataBase64/);
});

test('过期已上传附件仅新人工批次可刷新，未知回执不会因时间经过而重发', async () => {
    const h = harness(), asset = h.source.assets[0], file = { asset }, stopped = async () => false;
    await h.ctx.uploadTargetAttachment(h.task, h.identity, 1, targetId, file, 'live-photo', async () => asset, stopped);
    const key = Object.keys(h.stored).find(key => key.startsWith('targetAttachment:'));
    h.stored[key].savedAt = Date.now() - 31 * 60 * 1000;
    await assert.rejects(h.ctx.uploadTargetAttachment(h.task, h.identity, 1, targetId, file, 'live-photo', async () => asset, stopped), /过有效/);
    h.task.jobId = 'new-manual-job';
    await h.ctx.uploadTargetAttachment(h.task, h.identity, 1, targetId, file, 'live-photo', async () => asset, stopped);
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 2);
    assert.equal(h.stored.targetAttachmentIndex.length, 1);
    h.stored[key].state = 'unknown'; h.stored[key].savedAt = Date.now() - 31 * 60 * 1000;
    h.task.jobId = 'another-manual-job';
    await assert.rejects(h.ctx.uploadTargetAttachment(h.task, h.identity, 1, targetId, file, 'live-photo', async () => asset, stopped), /未确认/);
    assert.equal(h.sdkCalls.filter(call => call[0] === 'upload').length, 2);
});

test('独立页面由插件创建并复用，暂停事件撤销写入但保留旧结果读取，退出只关闭自己的页面', async () => {
    const h = harness(), created = [], removed = [], changes = [];
    h.ctx.directPageError = entry => entry?.result?.__temuDirectPageError?.message || '';
    h.govern.MutationObserver = class { observe() {} disconnect() {} };
    h.govern.document = { documentElement: {} };
    h.ctx.chrome.storage.onChanged = { addListener: listener => changes.push(listener) };
    h.ctx.chrome.tabs = { create: async options => { created.push(options); return { id: 42 }; },
        get: async () => ({ status: 'complete' }), remove: async id => removed.push(id),
        onUpdated: { addListener() {}, removeListener() {} } };
    h.ctx.chrome.scripting.executeScript = async args => {
        assert.equal(args.target.tabId, 42);
        if (args.files) for (const file of args.files) vm.runInContext(fs.readFileSync(path.join(dir, file), 'utf8'), h.govern);
        const result = args.func ? await vm.runInContext(`(${args.func.toString()})(...${JSON.stringify(args.args || [])})`, h.govern) : null;
        return [{ documentId: 'photoDoc', result }];
    };
    vm.runInContext(fs.readFileSync(path.join(dir, 'live-photo-panel.js'), 'utf8'), h.ctx);
    const payload = { productId: targetId, attemptId: 'photo:panel-test', asset: h.source.assets[0] };
    assert.equal((await h.ctx.livePhotoUploadCall(h.identity, 1, 'photo-upload', payload)).state, 'submitting');
    let status;
    for (let i = 0; i < 30; i++) {
        status = await h.ctx.livePhotoUploadCall(h.identity, 1, 'status', { attemptId: payload.attemptId });
        if (status.state === 'uploaded') break;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.equal(status.state, 'uploaded');
    assert.equal(created.length, 1); assert.equal(created[0].active, false);
    assert.equal(created[0].url, 'https://agentseller.temu.com/govern/compliant-live-photos');
    h.ctx.directPauseKey = storeId => `directPause:${storeId}`;
    changes[0]({ [`directPause:${h.identity.storeId}`]: { newValue: { paused: true } } }, 'session');
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(h.govern.window.__temuLivePhotoUploadBinding.stopped, true);
    assert.equal((await h.ctx.livePhotoUploadCall(h.identity, 1, 'status', { attemptId: payload.attemptId })).state, 'uploaded');
    await assert.rejects(h.ctx.livePhotoUploadCall(h.identity, 1, 'photo-upload', { ...payload, attemptId: 'photo:new' }), /轮次/);
    await h.ctx.closeLivePhotoPanel(h.identity, 1);
    assert.deepEqual(removed, [42]);
});
