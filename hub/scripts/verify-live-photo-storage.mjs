/** 专用实拍图入库、引用下发和旧包兼容使用临时仓库，不连接线上。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { parseImportedFiles, createSingleProductCapture } from '../lib/parse-capture.mjs';
import { createStore } from '../lib/store.mjs';
import { canonicalProductSnapshot, makeProductVersion, createJobQueue } from '../lib/job-queue.mjs';
import { inventoryListSummary } from '../lib/mysql-inventory.mjs';
import { parseLivePhotoRecord, mergeLivePhotoCapture, readLivePhotoAsset, legacyLivePhotoCompatibility } from '../lib/product-live-photos.mjs';
import { verifyQualificationBatchTransfer } from '../lib/product-qualifications.mjs';
import { transferManifest, verifyTransferManifest } from '../lib/transfer-integrity.mjs';
import { livePhotoSnapshot, livePhotoRecord, livePhotoPacket, sourceStoreId } from './live-photo-fixture.mjs';
import { productRecord, spuId, qualificationSnapshot, packet as qualificationPacket } from './qualification-fixture.mjs';
const parse = payload => parseImportedFiles([{ originalName: 'photos.json', payload }]);

/** 复现旧包的四张已归档 JPEG，只提供明确的 position，不补造 SKU 或视角；全部字节为合成样本。 */
function legacyPhotoPacket() {
    const snapshot = qualificationSnapshot();
    snapshot.mallId = sourceStoreId.slice(5);
    snapshot.assets = [1, 2, 3, 4].map(index => {
        const data = Buffer.from([255, 216, 255, 224, index]);
        return { url: `https://pos.file.temu.com/legacy-${index}.jpeg`, name: `legacy-${index}.jpeg`,
            mimeType: 'image/jpeg', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'),
            dataBase64: data.toString('base64') };
    });
    snapshot.archive = { status: 'complete', errors: [] };
    const detail = snapshot.items[0].detail;
    detail.productCertFiles = []; detail.inspectReportFiles = []; detail.multiLangProductCertFileMap = null;
    detail.uploadedContents = { note: 'PRIVATE-CERT-CONTENT' };
    detail.realPictures = snapshot.assets.map((asset, index) => ({ imageUrl: asset.url, position: index < 2 ? 1 : 2 }));
    return qualificationPacket(snapshot, sourceStoreId);
}

test('旧包四张真实归档照片仅生成同源兼容诊断，不生成独立可上传图片或改写正文', () => {
    const input = legacyPhotoPacket(), before = structuredClone(input);
    const product = parse(input).products[0], original = structuredClone(product);
    const snapshot = canonicalProductSnapshot(product), marker = snapshot.livePhotoCompatibility;
    assert.deepEqual(marker, { state: 'legacy-unclassified', imageCount: 4, knownPositions: [1, 2], missingFields: ['sku', 'view'],
        reason: '旧资质图片缺少可核验的 SKU 归属和视角，需要来源店重新采集独立实拍图；不可直接上传或替换目标图片' });
    assert.deepEqual(marker, legacyLivePhotoCompatibility(snapshot));
    assert.equal(snapshot.livePhotos, undefined);
    assert.equal(snapshot.qualifications.items[0].content.realPictures.length, 4);
    assert.deepEqual(snapshot.qualifications, original.qualifications);
    assert.deepEqual(product, original); assert.deepEqual(input, before);
    assert.doesNotMatch(JSON.stringify(marker), /https:|sha256|dataBase64|PRIVATE|TEST-CERT|MODEL-A|certType|assets|groups/);
    assert.doesNotMatch(JSON.stringify(snapshot), /dataBase64/);
    assert.ok(Buffer.byteLength(JSON.stringify(marker)) < 4096);
});

test('重复条目和同字节不同链接去重，位置只能来自显式字段，顺序和 MIME 不充当视角或 SKU', () => {
    const input = legacyPhotoPacket(), raw = input.records[1].payload.result;
    const duplicate = structuredClone(raw.items[0]); duplicate.certType = duplicate.summary.certType = duplicate.detail.certType = 15;
    raw.items.push(duplicate);
    const aliased = { ...raw.assets[0], url: 'https://pos.file.temu.com/legacy-alias.jpeg' };
    raw.assets.push(aliased);
    raw.items[0].detail.realPictures.push({ imageUrl: aliased.url, position: 2 });
    let marker = canonicalProductSnapshot(parse(input).products[0]).livePhotoCompatibility;
    assert.equal(marker.imageCount, 4); assert.deepEqual(marker.knownPositions, [1, 2]);
    for (const item of raw.items) for (const [index, picture] of item.detail.realPictures.entries()) {
        picture.position = [undefined, null, '1', -1, 1.5][index % 5];
    }
    raw.items.reverse(); raw.items.forEach(item => item.detail.realPictures.reverse());
    const snapshot = canonicalProductSnapshot(parse(input).products[0]); marker = snapshot.livePhotoCompatibility;
    assert.deepEqual(marker.knownPositions, []); assert.deepEqual(marker.missingFields, ['sku', 'view', 'position']);
    assert.equal(marker.imageCount, 4); assert.equal(snapshot.livePhotos, undefined);
    assert.equal(marker.skuId, undefined); assert.equal(marker.positionType, undefined);
});

test('主图、示例、报告和孤立归档引用都不能污染旧实拍图诊断', () => {
    const product = parse(legacyPhotoPacket()).products[0];
    const photos = structuredClone(product.qualifications.items[0].content.realPictures);
    const item = product.qualifications.items[0];
    item.content.realPictures = [];
    item.content.certNeedUpload.certNeedUploadItems[0].newUploadExample.realPictures = photos;
    item.content.historyPictures = photos; item.content.productCertFiles = photos;
    item.content.inspectReportFiles = photos; product.images.push(...photos.map(picture => picture.imageUrl));
    assert.equal(canonicalProductSnapshot(product).livePhotoCompatibility, undefined);
    item.content.realPictures = { example: photos };
    assert.equal(legacyLivePhotoCompatibility(product), null, '不递归未知容器猜测实际图片');
    item.content.realPictures = photos;
    item.files.forEach(file => { file.role = '检测报告'; });
    assert.equal(legacyLivePhotoCompatibility(product), null);
    item.files = [];
    assert.equal(legacyLivePhotoCompatibility(product), null, '无归档引用不能只凭实际图片 URL 放行');
});

test('独立实拍快照包括空图、失败、部分读取都优先；不回退历史或其他来源资格', () => {
    const input = legacyPhotoPacket(); input.records.push(livePhotoRecord());
    for (const state of ['captured', 'empty', 'not-found', 'failed']) {
        const live = livePhotoSnapshot();
        if (state !== 'captured') {
            live.captureState = state; live.groups = []; live.assets = [];
            if (state === 'failed') { live.status = 'failed'; live.archive = { status: 'failed', errors: [{ url: '', name: '', reason: '离线查询失败' }] }; }
        }
        input.records[2] = livePhotoRecord(live);
        const snapshot = canonicalProductSnapshot(parse(input).products[0]);
        assert.equal(snapshot.livePhotoCompatibility, undefined, state);
        assert.equal(snapshot.livePhotos.captureState, state);
    }
    const product = parse(legacyPhotoPacket()).products[0];
    for (const livePhotos of [{}, { status: 'partial' }]) {
        assert.equal(canonicalProductSnapshot({ ...product, livePhotos }).livePhotoCompatibility, undefined);
    }
    const partial = livePhotoSnapshot(); partial.status = 'partial'; partial.archive.status = 'partial';
    partial.archive.errors = [{ url: partial.assets[0].url, name: 'fixture.jpeg', reason: '部分照片读取失败' }];
    input.records[2] = livePhotoRecord(partial);
    assert.equal(canonicalProductSnapshot(parse(input).products[0]).livePhotoCompatibility, undefined);
    assert.equal(legacyLivePhotoCompatibility({ ...product, qualifications: { ...product.qualifications, spuId: '999999' } }), null);
    const captures = { ...product, qualifications: undefined, qualificationCaptures: [product.qualifications] };
    assert.equal(canonicalProductSnapshot(captures).livePhotoCompatibility, undefined);
});

test('不可信标记、未归档或不合法图片引用不能升级为可上传实拍图，嵌套字节不进入任务', () => {
    const product = parse(legacyPhotoPacket()).products[0];
    const spoof = { state: 'ready', images: [{ dataBase64: 'PRIVATE-BYTES', skuId: '0', positionType: 0 }] };
    assert.deepEqual(canonicalProductSnapshot({ ...product, livePhotoCompatibility: spoof }).livePhotoCompatibility,
        canonicalProductSnapshot(product).livePhotoCompatibility);
    const mutations = [
        file => { delete file.asset; }, file => { delete file.asset.sha256; },
        file => { file.asset.url = 'https://pos.file.temu.com/unrelated.jpeg'; },
        file => { file.asset.sha256 = 'invalid'; }, file => { file.asset.sha256 = [file.asset.sha256]; },
        file => { file.asset.bytes = 0; }, file => { file.asset.bytes = 11 * 1024 * 1024; },
        file => { file.asset.mimeType = 'application/pdf'; },
        file => { file.url = file.asset.url = ''; },
        file => { file.url = file.asset.url = 'https://evil.invalid/image.jpeg'; }
    ];
    for (const [index, mutate] of mutations.entries()) {
        const bad = structuredClone(product); bad.livePhotoCompatibility = spoof;
        bad.qualifications.items[0].files.forEach(mutate);
        const snapshot = canonicalProductSnapshot(bad);
        assert.equal(snapshot.livePhotoCompatibility, undefined, `非法引用 ${index}`); assert.equal(snapshot.livePhotos, undefined);
    }
    const withBytes = structuredClone(product);
    withBytes.qualifications.items[0].files[0].asset.dataBase64 = 'PRIVATE-BYTES';
    const snapshot = canonicalProductSnapshot(withBytes);
    assert.equal(snapshot.livePhotoCompatibility.imageCount, 4);
    assert.doesNotMatch(JSON.stringify(snapshot), /dataBase64|PRIVATE-BYTES/);
});

test('诊断预算超限不产生截断计数，位置未知参与商品版本及完整传输清单', () => {
    const product = parse(legacyPhotoPacket()).products[0];
    const oversized = structuredClone(product);
    oversized.qualifications.items[0].content.realPictures = Array(40001).fill({ imageUrl: 'https://pos.file.temu.com/x.jpeg' });
    assert.equal(legacyLivePhotoCompatibility(oversized), null);
    oversized.qualifications.items = Array(201).fill(product.qualifications.items[0]);
    assert.equal(legacyLivePhotoCompatibility(oversized), null);
    const changed = structuredClone(product); delete changed.qualifications.items[0].content.realPictures[0].position;
    const snapshot = canonicalProductSnapshot(product), manifest = transferManifest(snapshot);
    assert.equal(verifyTransferManifest(snapshot, manifest), true);
    assert.notEqual(makeProductVersion(changed), makeProductVersion(product));
    const stripped = structuredClone(snapshot); delete stripped.livePhotoCompatibility;
    assert.throws(() => verifyTransferManifest(stripped, manifest), /摘要不一致/);
    assert.equal(makeProductVersion(product), createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16));
});

test('旧包诊断随真实队列交给旧插件并绑定原包清单，不绕过来源一致性核验', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-photo-legacy-delivery-'));
    try {
        const store = createStore(root), saved = await store.importFiles([{ originalName: 'legacy.json', payload: legacyPhotoPacket() }]);
        const queue = createJobQueue(root, store), identity = { storeId: 'temu:999999', mallId: '999999',
            storeName: '离线目标店', pageStoreName: '离线目标店', pluginInstanceId: 'legacy-photo-test',
            executionMode: 'plugin-api', pluginVersion: '11.0.8', pluginDetected: true, identityMatched: true };
        await queue.registerAgent(identity);
        const job = await queue.createJob({ sourceStoreId, targetStoreId: identity.storeId, sourceBatchId: saved.batch.id,
            targetStoreName: identity.storeName, spuIds: [spuId], requireOnline: true });
        const delivery = (await queue.claimJobs(identity)).claimed[0];
        assert.equal(delivery.jobId, job.id);
        assert.equal(delivery.snapshot.livePhotoCompatibility.imageCount, 4);
        assert.equal(delivery.snapshot.livePhotos, undefined);
        assert.equal(verifyTransferManifest(delivery.snapshot, delivery.transferIntegrity), true);
        assert.equal(delivery.productVersion, makeProductVersion(saved.batch.products[0]));
        assert.doesNotMatch(JSON.stringify(delivery), /dataBase64/);
        const altered = structuredClone(saved.batch.products);
        altered[0].qualifications.items[0].files[0].asset.sha256 = '0'.repeat(64);
        await assert.rejects(verifyQualificationBatchTransfer(store, saved.batch, altered), /原包不一致/);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('网站真实 canonical 标记被新版插件识别为需重采，平台查询、附件读取及上传均为零', async () => {
    const snapshot = canonicalProductSnapshot(parse(legacyPhotoPacket()).products[0]);
    const calls = [];
    // 诊断分支只能在本地结算；即使平台能力不可用，也应明确报告已有照片而非尝试上传。
    const forbidden = async () => { calls.push('平台调用'); throw Error('离线测试禁止访问平台'); };
    const ctx = vm.createContext({ qualificationPage: forbidden, qualificationAsset: forbidden,
        fetch: forbidden, chrome: { scripting: { executeScript: forbidden } } });
    vm.runInContext(await readFile(new URL('../../plugin/live-photo-executor.js', import.meta.url), 'utf8'), ctx);
    const result = await ctx.runDirectLivePhotos({ snapshot, spuId, sourceStoreId }, {}, 1, {}, 'offline-key');
    assert.equal(result.state, 'partial'); assert.equal(result.items[0].key, 'legacy-unclassified');
    assert.match(result.reason, /4.*历史实拍图/); assert.match(result.reason, /来源店.*升级.*刷新.*重新采集/);
    assert.deepEqual(calls, []);
    assert.doesNotMatch(JSON.stringify(result), /dataBase64|https:|PRIVATE-CERT-CONTENT/);
});

test('专用图片保留位置和视角，图文主图不污染；原始接口与伪造摘要拒绝', () => {
    const product = parse(livePhotoPacket()).products[0];
    assert.deepEqual(product.livePhotos.groups.map(group => group.position), [1, 2]);
    assert.equal(product.livePhotos.assets.length, 1);
    assert.doesNotMatch(JSON.stringify(product), /dataBase64/);
    assert.deepEqual(product.images, ['https://img.kwcdn.com/main.jpg']);
    const raw = livePhotoRecord(); raw.dataType = 'unknown';
    assert.equal(parse({ ...livePhotoPacket(), records: [raw] }).products.length, 0);
    const spoofed = livePhotoPacket(); spoofed.records = [productRecord()]; spoofed.products = [{ spuId, livePhotos: livePhotoSnapshot() }];
    assert.equal(parse(spoofed).products[0].livePhotos, undefined);
    assert.throws(() => parse({ ...livePhotoPacket(), source: { sourceStoreId: 'temu:999999' } }), /来源店/);
    const mismatch = livePhotoPacket(); mismatch.records[1].payload.result.skus[0].skuExtCode = 'WRONG-CODE';
    assert.throws(() => parse(mismatch), /SKU货号/);
});
test('错误哈希、非图片、错SPU/SKU、未知来源及孤立附件不能归档', () => {
    for (const mutate of [
        r => { r.payload.result.assets[0].sha256 = '0'.repeat(64); },
        r => { r.payload.result.assets[0].mimeType = 'application/pdf'; },
        r => { r.identity.productIds = ['999999']; },
        r => { r.payload.result.groups[0].images[0].skuId = '999999'; },
        r => { r.source.requestUrl = 'https://evil.invalid/api/flash/real_picture/detail'; },
        r => { r.payload.result.assets[0].url = 'https://pos.file.temu.com/other.jpeg'; },
        r => { r.payload.result.groups[0].images[0].url += '?token=secret'; }
    ]) { const record = livePhotoRecord(); mutate(record); assert.throws(() => parseLivePhotoRecord(record)); }
});
test('单商品聚合也保留图片；列表及任务只存引用，任务版本包含照片', () => {
    const input = livePhotoPacket();
    const aggregate = createSingleProductCapture({ ...input, records: undefined }, spuId);
    input.records.forEach(record => aggregate.record(record));
    const product = aggregate.finish().products[0];
    const summary = inventoryListSummary({ ...product, livePhotoCaptures: [product.livePhotos] });
    assert.equal(summary.livePhotos, undefined); assert.equal(summary.livePhotoCaptures, undefined);
    assert.equal(canonicalProductSnapshot(product).livePhotos.assets[0].sha256, product.livePhotos.assets[0].sha256);
});
test('成功资料不会被失败重采清空，显式完整空图才替换旧图', () => {
    const first = parseLivePhotoRecord(livePhotoRecord()).livePhotos;
    const failed = { ...first, capturedAt: '2026-10-10T08:00:00Z', status: 'failed', captureState: 'failed', groups: [], assets: [], reason: '查询失败' };
    const merged = mergeLivePhotoCapture(first, failed);
    assert.equal(merged.groups.length, 2); assert.equal(merged.lastAttempt.reason, '查询失败');
    const empty = { ...first, capturedAt: '2026-10-10T09:00:00Z', captureState: 'empty', groups: [], assets: [] };
    assert.equal(mergeLivePhotoCapture(merged, empty).groups.length, 0);
});
test('旧包无字段保留历史照片、重采去重与原包校验、删除及越权均保护附件', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-photo-storage-'));
    try {
        const store = createStore(root), input = livePhotoPacket();
        const saved = await store.importFiles([{ originalName: 'photos.json', payload: input }]);
        const hash = input.records[1].payload.result.assets[0].sha256;
        const options = { spuId, sha256: hash, sourceStoreId };
        assert.equal((await readLivePhotoAsset(store, options)).mimeType, 'image/jpeg');
        assert.equal(await readLivePhotoAsset(store, { ...options, scope: new Set(['another']) }), null);
        await verifyQualificationBatchTransfer(store, saved.batch, saved.batch.products);
        const corrupt = structuredClone(saved.batch.products); corrupt[0].livePhotos.groups[0].images[0].positionType = 1;
        await assert.rejects(verifyQualificationBatchTransfer(store, saved.batch, corrupt), /原包不一致/);
        const old = { ...input, records: [productRecord()] };
        await store.importFiles([{ originalName: 'old.json', payload: old }]);
        const product = await store.getProduct(spuId, null, sourceStoreId);
        assert.equal(product.product.livePhotoCaptures[0].assets[0].sha256, hash);
        assert.ok(await readLivePhotoAsset(store, options));
        const file = path.join(store.filesDir, saved.batch.files[0].storedName);
        const bytes = await readFile(file); await writeFile(file, 'tampered');
        await assert.rejects(readLivePhotoAsset(store, options), /校验/);
        await writeFile(file, bytes);
        await store.deleteProducts([spuId]);
        assert.equal(await readLivePhotoAsset(store, options), null);
    } finally { await rm(root, { recursive: true, force: true }); }
});
test('原包读取期间撤销照片引用，即使来源批次仍存在也不能发送旧字节', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-photo-revoke-'));
    try {
        const store = createStore(root), input = livePhotoPacket();
        await store.importFiles([{ originalName: 'photos.json', payload: input }]);
        const original = store.getProduct.bind(store); let reads = 0;
        // 模拟重采撤销照片，不修改磁盘原包或批次关联，精准复现读前与读后索引不一致。
        store.getProduct = async (...args) => {
            const view = await original(...args);
            if (++reads > 1) for (const capture of view.product.livePhotoCaptures) capture.assets = [];
            return view;
        };
        assert.equal(await readLivePhotoAsset(store, { spuId, sourceStoreId, sha256: input.records[1].payload.result.assets[0].sha256 }), null);
        assert.equal(reads, 2);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('图文与实拍图默认收起，独立图片下载只引用本站归档且文本安全', async () => {
    const context = vm.createContext({ window: {}, URL, URLSearchParams });
    vm.runInContext(await readFile(new URL('../public/product-detail.js', import.meta.url), 'utf8'), context);
    const snapshot = parseLivePhotoRecord(livePhotoRecord()).livePhotos;
    snapshot.groups[0].label = '<script>unsafe</script>';
    const html = context.window.ProductDetailView.render({ detail: { content: '正文' }, livePhotoCaptures: [{ ...snapshot, sourceStoreId }] });
    assert.equal((html.match(/<details class="detail-section detail-collapsible">/g) || []).length, 2);
    assert.doesNotMatch(html, /<details[^>]*\bopen\b|<script>|src="https:\/\/pos.file/);
    assert.match(html, /api\/live-photo-assets/); assert.match(html, /正视图/); assert.match(html, /共用/);
    assert.match(html, /&lt;script&gt;/);
});
