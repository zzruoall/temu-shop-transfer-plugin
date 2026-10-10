/** 附件归档使用真实插件代码与内存流；所有平台响应均离线构造，不访问店铺或执行写操作。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { qualificationSnapshot, spuId } from './qualification-fixture.mjs';

const source = await readFile(new URL('../../plugin/qualification-reader.js', import.meta.url), 'utf8');
const bridgeSource = await readFile(new URL('../../plugin/api-reader.js', import.meta.url), 'utf8');
const livePhotoSource = await readFile(new URL('../../plugin/live-photo-reader.js', import.meta.url), 'utf8');
const MiB = 1024 * 1024;
const pdf = size => { const bytes = new Uint8Array(size); bytes.set(new TextEncoder().encode('%PDF-')); return bytes; };
const url = name => `https://bstatic.kwcdn.com/${name}.pdf`;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const file = (name, extra = {}) => ({ fileUrl: url(name), fileName: `${name}.pdf`, ...extra });
const detail = files => ({ certType: 1421, productCertFiles: files });

/** 在独立主世界执行源码，快速超时只替换附件定时器，保留可检查的清理记录。 */
function loadReader({ fastTimers = false, clock } = {}) {
    const timers = new Set();
    const ctx = vm.createContext({ URL, TextEncoder, Uint8Array, DataView, AbortController, btoa, atob,
        Date: clock || Date,
        setTimeout: (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, fastTimers ? Math.min(ms, 20) : ms); timers.add(id); return id; },
        clearTimeout: id => { timers.delete(id); clearTimeout(id); } });
    vm.runInContext(source, ctx);
    return { reader: ctx.TemuQualificationReader, timers };
}

/** 模拟分块响应而非 arrayBuffer；计数器用于证明超限或不可信响应没有继续读取正文。 */
function response(bytes, { finalUrl = url('a'), mime = 'application/pdf', length, chunkSize = 64 * 1024, stall = false, type = 'cors', ok = true } = {}) {
    const stats = { reads: 0, cancels: 0 };
    let offset = 0;
    const body = { cancel: async () => { stats.cancels++; }, getReader: () => ({
        read: async () => {
            stats.reads++;
            if (stall) return new Promise(() => {});
            if (offset === bytes.length) return { done: true };
            const value = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
            offset += value.byteLength;
            return { value, done: false };
        }, cancel: async () => { stats.cancels++; }
    }) };
    return { url: finalUrl, ok, type, body, stats, headers: { get: key => key === 'content-type' ? mime : key === 'content-length' ? length ?? null : null } };
}

/** 仅允许资质 list/detail 两个已核对的只读路径，附件只能由传入的源页面 fetch 提供。 */
function harness({ details = [detail([file('a')])], fetch = async () => response(pdf(20)), assertCurrent = async () => {}, signal, pageOrigin, reader = loadReader().reader } = {}) {
    const calls = [], fetched = [];
    return { calls, fetched, reader, run: () => reader.readSnapshot({}, { spuId, mallId: 'offline-mall', signal, assertCurrent, pageOrigin,
        fetch: fetch && (async (address, options) => { fetched.push({ address, options }); return fetch(address, options); }),
        post: async (address, input) => {
            calls.push({ address, input });
            if (address === reader.LIST_PATH) return { ifSemiManaged: false, total: 1, productWithCertList: [{ productBaseInfo: { productId: spuId }, productCertInfoList: details.map(item => ({ certType: item.certType })) }] };
            assert.equal(address, reader.DETAIL_PATH);
            return { productCertInfo: details.find(item => item.certType === input.cert_type) };
        }
    }) };
}

test('实际材料容器、多语言、跨类型 URL 去重；模板/示例/历史不下载且凭证不导出', async () => {
    const current = structuredClone(qualificationSnapshot().items[0].detail);
    current.productCertFiles[0].fileUrl += '?token=URL-SECRET#fragment';
    current.inspectReportFiles = [file('report')];
    current.productCertFiles.push({ fileUrl: url('cert') + '?token=SECOND-SECRET', fileName: '重复.pdf' });
    current.cookie = 'COOKIE-SECRET'; current.accessToken = 'ACCESS-SECRET';
    current.realPictures = [url('real')]; current.energyLabelFiles = [file('energy')]; current.supplementaryMaterials = [file('extra')];
    current.multiLangInspectReportMap = { zh: [file('zh-report')] };
    current.groupUploadedContents = { documents: [file('group')], historyPictures: [url('nested-history')], template: { files: [file('nested-template')] } };
    const h = harness({ details: [current, { certType: 56, productCertFiles: [file('cert')] }] });
    const result = await h.run();
    assert.equal(result.snapshot.status, 'complete'); assert.equal(result.snapshot.archive.status, 'complete');
    assert.equal(result.snapshot.assets.length, 9); assert.equal(h.fetched.length, 9);
    assert.ok(h.fetched.every(call => !/example|history|template/.test(call.address)));
    assert.ok(h.fetched.some(call => call.address.includes('?token=URL-SECRET')));
    for (const call of h.fetched) {
        assert.equal(call.options.method, 'GET'); assert.equal(call.options.credentials, 'omit');
        assert.equal(call.options.referrerPolicy, 'no-referrer'); assert.equal(call.options.redirect, 'follow');
        assert.equal(call.options.headers, undefined); assert.ok(call.options.signal.aborted);
    }
    assert.doesNotMatch(JSON.stringify(result), /URL-SECRET|SECOND-SECRET|COOKIE-SECRET|ACCESS-SECRET/);
    assert.equal(result.snapshot.items[0].detail.authCode, 'TEST-CERT-2026');
    assert.equal(h.reader.validateSnapshot(result.snapshot, spuId), result.snapshot);
});

test('PDF/JPEG/PNG/GIF/WebP 魔数及 SHA-256 与 Node 标准实现一致', async () => {
    const samples = [
        [pdf(20), 'application/pdf'],
        [Uint8Array.of(255,216,255,224,0), 'image/jpeg'],
        [Uint8Array.of(137,80,78,71,13,10,26,10,0), 'image/png'],
        [new TextEncoder().encode('GIF89a-test'), 'image/gif'],
        [new TextEncoder().encode('RIFF0000WEBP-test'), 'image/webp']
    ];
    for (const size of [55,56,63,64,65,127,128,1024]) samples.push([pdf(size), 'application/pdf']);
    for (const [bytes, mime] of samples) {
        const h = harness({ fetch: async () => response(bytes, { mime: mime + '; charset=binary', chunkSize: 3 }) });
        const { snapshot } = await h.run(), asset = snapshot.assets[0];
        assert.equal(snapshot.archive.status, 'complete'); assert.equal(asset.sha256, sha(bytes));
        assert.equal(asset.mimeType, mime); assert.equal(asset.bytes, bytes.length);
        assert.deepEqual(Buffer.from(asset.dataBase64, 'base64'), Buffer.from(bytes));
        h.reader.validateSnapshot(snapshot, spuId);
    }
});

test('私有资质使用原签名及当前同源登录态，签名和凭据不进入归档包', async () => {
    const address = 'https://agentseller.temu.com/product-cert-private-tag/test/material.pdf?sign=PRIVATE-SECRET';
    const h = harness({ pageOrigin: 'https://agentseller.temu.com', details: [detail([{ fileUrl: address, fileName: '成分.pdf' }])],
        fetch: async (input, options) => {
            assert.equal(input, address); assert.equal(options.credentials, 'same-origin');
            assert.equal(options.mode, 'same-origin'); assert.equal(options.redirect, 'error');
            assert.equal(options.headers, undefined); assert.equal(options.referrerPolicy, 'no-referrer');
            return response(pdf(20), { finalUrl: input, type: 'basic' });
        } });
    const result = await h.run();
    assert.equal(result.snapshot.archive.status, 'complete');
    assert.equal(result.snapshot.assets[0].name, '成分.pdf');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE-SECRET|\?sign=/);
    h.reader.validateSnapshot(result.snapshot, spuId);
});

test('凭据只用于已确认的当前平台私有路径，CDN、其他子域及不明来源仍匿名', async () => {
    for (const [pageOrigin, address] of [
        ['https://agentseller.temu.com', url('public')],
        ['https://agentseller.temu.com', 'https://other.temu.com/product-cert-private-tag/a.pdf'],
        ['https://agentseller.temu.com', 'https://agentseller.temu.com/api/seller/auth/userInfo'],
        ['https://evil.invalid', 'https://agentseller.temu.com/product-cert-private-tag/a.pdf'],
        [undefined, 'https://agentseller.temu.com/product-cert-private-tag/a.pdf']
    ]) {
        const h = harness({ pageOrigin, details: [detail([{ fileUrl: address }])], fetch: async input => response(pdf(20), { finalUrl: input }) });
        await h.run(); assert.equal(h.fetched[0].options.credentials, 'omit');
    }
});

test('私有附件不接受跨域最终响应；HTTP 权限失败提供具体状态且不读取正文', async () => {
    const address = 'https://agentseller.temu.com/product-cert-private-tag/a.pdf?sign=SECRET';
    for (const status of [401, 403, 404, 500]) {
        const res = { ...response(pdf(20), { finalUrl: address, ok: false }), status };
        const h = harness({ pageOrigin: 'https://agentseller.temu.com', details: [detail([{ fileUrl: address }])], fetch: async () => res });
        const { snapshot } = await h.run();
        assert.match(snapshot.archive.errors[0].reason, new RegExp(`HTTP ${status}`));
        assert.equal(res.stats.reads, 0); assert.equal(res.stats.cancels, 1);
        assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
    }
    const res = response(pdf(20), { finalUrl: url('redirect') });
    const h = harness({ pageOrigin: 'https://agentseller.temu.com', details: [detail([{ fileUrl: address }])], fetch: async () => res });
    const { snapshot } = await h.run();
    assert.equal(snapshot.archive.status, 'failed'); assert.equal(res.stats.reads, 0);
});

test('不可信协议、主机、用户信息、端口拒绝，平台 HTTPS 子域允许', async () => {
    const bad = ['http://img.kwcdn.com/a', 'https://kwcdn.com.evil.invalid/a', 'https://evilkwcdn.com/a', 'https://user:pass@img.kwcdn.com/a',
        'https://img.kwcdn.com:444/a', 'https://127.0.0.1/a', 'https://evil.invalid/a', 'https://[::1]/a'];
    const h = harness({ details: [detail(bad.map(fileUrl => ({ fileUrl })))], fetch: async () => { throw Error('不能下载'); } });
    const { snapshot, stopBatch } = await h.run();
    assert.equal(h.fetched.length, 0); assert.equal(snapshot.archive.status, 'failed'); assert.equal(stopBatch, false);
    assert.equal(snapshot.archive.errors.length, bad.length); h.reader.validateSnapshot(snapshot, spuId);
    for (const host of ['kwcdn.com', 'img.kwcdn.com', 'temu.com', 'agentseller.temu.com', 'kuajingmaihuo.com', 'a.kuajingmaihuo.com']) {
        const valid = harness({ details: [detail([{ fileUrl: `https://${host}:443/a` }])], fetch: async address => response(pdf(10), { finalUrl: address }) });
        assert.equal((await valid.run()).snapshot.archive.status, 'complete');
    }
});

test('重定向后再验证 HTTPS 平台域；不可信最终地址、opaque、HTTP 失败均不读正文', async () => {
    for (const options of [{ finalUrl: 'https://evil.invalid/leak' }, { finalUrl: 'http://img.kwcdn.com/a' },
        { finalUrl: 'https://x:secret@img.kwcdn.com/a' }, { type: 'opaque' }, { type: 'opaqueredirect' }, { ok: false }]) {
        const res = response(pdf(20), options), h = harness({ fetch: async () => res });
        const { snapshot } = await h.run();
        assert.equal(snapshot.archive.status, 'failed'); assert.equal(res.stats.reads, 0); assert.equal(res.stats.cancels, 1);
        h.reader.validateSnapshot(snapshot, spuId);
    }
    const h = harness({ fetch: async () => response(pdf(20), { finalUrl: 'https://img.kwcdn.com/redirect.pdf' }) });
    const { snapshot } = await h.run(); assert.equal(snapshot.archive.status, 'complete');
    assert.equal(snapshot.assets[0].url, url('a'));
});

test('HTML/SVG/未知内容和 MIME 冲突拒绝，缺少声明及 octet-stream 按魔数识别', async () => {
    for (const [bytes, mime] of [[pdf(20), 'image/png'], [pdf(20), 'text/html'], [new TextEncoder().encode('<html>login</html>'), 'application/pdf'],
        [new TextEncoder().encode('<svg/>'), 'image/svg+xml'], [Uint8Array.of(0,1,2), 'application/octet-stream']]) {
        const h = harness({ fetch: async () => response(bytes, { mime }) });
        const { snapshot, stopBatch } = await h.run(); assert.equal(snapshot.archive.status, 'failed'); assert.equal(stopBatch, false);
        assert.match(snapshot.archive.errors[0].reason, /MIME/);
    }
    for (const mime of ['', 'application/octet-stream']) assert.equal((await harness({ fetch: async () => response(pdf(20), { mime }) }).run()).snapshot.archive.status, 'complete');
});

test('附件网络失败不输出异常里的 URL/认证信息，下一件附件仍读取', async () => {
    const h = harness({ details: [detail([file('a'), file('b')])], fetch: async address => {
        if (address === url('a')) throw Error('附件 failed token=SECRET cookie=COOKIE');
        return response(pdf(20), { finalUrl: address });
    } });
    const { snapshot, stopBatch } = await h.run();
    assert.equal(snapshot.archive.status, 'partial'); assert.equal(snapshot.assets.length, 1); assert.equal(stopBatch, false);
    assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|COOKIE/); h.reader.validateSnapshot(snapshot, spuId);
});

test('Content-Length 提前拒绝；缺少或伪造长度仍受单文件 10MiB 流上限约束', async () => {
    for (const length of [String(10 * MiB + 1), '-1', 'garbage']) {
        const res = response(pdf(20), { length }), h = harness({ fetch: async () => res });
        const { snapshot } = await h.run(); assert.equal(snapshot.archive.status, 'failed'); assert.equal(res.stats.reads, 0); assert.equal(res.stats.cancels, 1);
    }
    for (const length of [undefined, '1']) {
        const res = response(pdf(10 * MiB + 1), { length });
        const h = harness({ details: [detail([file('a'), file('b')])], fetch: async address => address === url('a') ? res : response(pdf(20), { finalUrl: address }) });
        const { snapshot, stopBatch } = await h.run(); assert.equal(snapshot.archive.status, 'partial'); assert.equal(snapshot.assets.length, 1);
        assert.equal(stopBatch, false); assert.equal(res.stats.cancels, 1); h.reader.validateSnapshot(snapshot, spuId);
    }
});

test('10MiB 边界附件的 Base64 超过旧 8MiB 预算仍能通过模块校验，元数据不豁免', async () => {
    const bytes = pdf(10 * MiB), h = harness({ fetch: async () => response(bytes) });
    const { snapshot } = await h.run(); assert.equal(snapshot.archive.status, 'complete');
    assert.ok(JSON.stringify(snapshot).length > 8 * MiB); assert.equal(snapshot.assets[0].sha256, sha(bytes));
    h.reader.validateSnapshot(snapshot, spuId);
    const tooLarge = structuredClone(snapshot); tooLarge.items[0].detail.note = 'x'.repeat(8 * MiB);
    assert.throws(() => h.reader.validateSnapshot(tooLarge, spuId), /大小/);
    const hidden = qualificationSnapshot(); hidden.items[0].detail.dataBase64 = 'x'.repeat(8 * MiB);
    assert.throws(() => h.reader.validateSnapshot(hidden, spuId), /大小/);
});

test('32MiB 累计边界保留四个 8MiB 附件；下一地址不发请求，验证器拒绝累计超限', async () => {
    const bytes = pdf(8 * MiB), h = harness({ details: [detail(['a','b','c','d','e'].map(name => file(name)))], fetch: async address => response(bytes, { finalUrl: address }) });
    const { snapshot, stopBatch } = await h.run(); assert.equal(snapshot.archive.status, 'partial'); assert.equal(snapshot.assets.length, 4);
    assert.equal(h.fetched.length, 4); assert.equal(stopBatch, false); assert.match(snapshot.archive.errors[0].reason, /32MiB/);
    h.reader.validateSnapshot(snapshot, spuId);
    const fifth = { ...snapshot.assets[0], url: url('e') }; snapshot.assets.push(fifth);
    assert.throws(() => h.reader.validateSnapshot(snapshot, spuId), /32MiB/);
});

test('未知长度累计溢出取消当前流，不保留截断正文，后续地址不请求', async () => {
    const sizes = [10,10,10,3,1], responses = sizes.map(size => response(pdf(size * MiB)));
    const h = harness({ details: [detail(['a','b','c','d','e'].map(name => file(name)))], fetch: async () => responses[h.fetched.length - 1] });
    const { snapshot } = await h.run(); assert.equal(snapshot.assets.length, 3); assert.equal(h.fetched.length, 4);
    assert.equal(snapshot.archive.status, 'partial'); assert.equal(responses[3].stats.cancels, 1);
    assert.match(snapshot.archive.errors[0].reason, /32MiB/); assert.match(snapshot.archive.errors[1].reason, /32MiB/);
});

test('40 件计数跨资质类型且 URL 去重；超限明确报告，不下载第 41 件', async () => {
    const files = Array.from({ length: 41 }, (_, i) => file(`f-${i}`));
    const h = harness({ details: [detail([...files.slice(0,20), files[0]]), { certType: 56, uploadedContents: { files: files.slice(20) } }], fetch: async address => response(pdf(20), { finalUrl: address }) });
    const { snapshot } = await h.run(); assert.equal(h.fetched.length, 40); assert.equal(snapshot.assets.length, 40);
    assert.equal(snapshot.archive.status, 'partial'); assert.match(snapshot.archive.errors[0].reason, /40/); h.reader.validateSnapshot(snapshot, spuId);
});

test('快照校验拒绝摘要篡改、字节数伪造、MIME 冲突、非规范 Base64、来源外附件和假完整', async () => {
    const h = harness(), { snapshot } = await h.run();
    for (const mutate of [s => { s.assets[0].sha256 = '0'.repeat(64); }, s => { s.assets[0].bytes++; },
        s => { s.assets[0].mimeType = 'image/png'; }, s => { s.assets[0].dataBase64 = '='.repeat(s.assets[0].dataBase64.length); },
        s => { s.assets[0].url = url('other'); }, s => { s.assets.push(s.assets[0]); }, s => { s.assets = []; },
        s => { s.archive.errors = [{ url: '', name: '', reason: '失败' }]; }, s => { s.assets[0].url += '?token=SECRET'; }]) {
        const bad = structuredClone(snapshot); mutate(bad); assert.throws(() => h.reader.validateSnapshot(bad, spuId), /附件/);
    }
    const empty = harness({ details: [detail([])] }); const result = await empty.run();
    result.snapshot.items[0].detail.productCertFiles = [{ fileUrl: 'https://evil.invalid/a' }];
    assert.throws(() => empty.reader.validateSnapshot(result.snapshot, spuId), /状态/);
    h.reader.validateSnapshot(qualificationSnapshot(), spuId);
});

test('旧客户端没有 fetch 明确 metadata-only；空材料在新客户端完整归档，元数据失败不冒充完整', async () => {
    const old = harness({ fetch: null }), first = await old.run();
    assert.equal(first.snapshot.archive.status, 'metadata-only'); assert.equal(first.snapshot.assets.length, 0); old.reader.validateSnapshot(first.snapshot, spuId);
    const empty = harness({ details: [detail([])] }), second = await empty.run();
    assert.equal(second.snapshot.archive.status, 'complete'); assert.equal(second.snapshot.assets.length, 0); empty.reader.validateSnapshot(second.snapshot, spuId);
    const loaded = loadReader();
    const failed = await loaded.reader.readSnapshot({}, { spuId, mallId: 'offline', assertCurrent: async () => {}, post: async () => { throw Error('接口失败'); }, fetch: async () => { throw Error('不应下载'); } });
    assert.equal(failed.snapshot.archive.status, 'failed'); assert.equal(failed.snapshot.status, 'failed'); loaded.reader.validateSnapshot(failed.snapshot, spuId);
});

test('fetch 和 stream 挂起均在期限内取消，不停止批次且无遗留定时器', async () => {
    for (const mode of ['fetch', 'stream']) {
        const loaded = loadReader({ fastTimers: true }), res = response(pdf(20), { stall: true });
        let signal;
        const h = harness({ reader: loaded.reader, fetch: async (_, options) => { signal = options.signal; return mode === 'fetch' ? new Promise(() => {}) : res; } });
        const { snapshot, stopBatch } = await h.run(); assert.equal(stopBatch, false); assert.equal(signal.aborted, true);
        assert.equal(snapshot.archive.status, 'failed'); assert.match(snapshot.archive.errors[0].reason, /超时/); assert.equal(loaded.timers.size, 0);
        if (mode === 'stream') assert.equal(res.stats.cancels, 1);
    }
});

test('取消信号、迟到 fetch 和单件归档总期限不让旧正文污染结果', async () => {
    const controller = new AbortController(), loaded = loadReader({ fastTimers: true });
    let resolveFetch;
    const h = harness({ reader: loaded.reader, signal: controller.signal, fetch: async () => { controller.abort(); return new Promise(resolve => { resolveFetch = resolve; }); } });
    const { snapshot } = await h.run(); assert.match(snapshot.archive.errors[0].reason, /取消/);
    const late = response(pdf(20)); resolveFetch(late); await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshot.assets.length, 0); assert.equal(late.stats.reads, 0); assert.equal(late.stats.cancels, 1); assert.equal(loaded.timers.size, 0);
    let now = Date.now(); class Clock extends Date { static now() { return now; } }
    const timed = harness({ reader: loadReader({ clock: Clock }).reader, details: [detail([file('a'),file('b'),file('c')])], fetch: async address => { now += 8000; return response(pdf(20), { finalUrl: address }); } });
    const result = await timed.run(); assert.equal(result.stopBatch, false); assert.equal(timed.fetched.length, 2);
    assert.match(result.snapshot.archive.errors[0].reason, /时间预算/);
});

test('下载期间切店或页面失效停止旧回合，已下载正文也不作为完整结果', async () => {
    let switched = false;
    const h = harness({ fetch: async () => { switched = true; return response(pdf(20)); }, assertCurrent: async () => {
        if (switched) throw Object.assign(Error('切店'), { stopBatch: true });
    } });
    const result = await h.run(); assert.equal(result.stopBatch, true); assert.equal(result.snapshot.assets.length, 0);
    assert.equal(result.snapshot.archive.status, 'failed'); assert.equal(result.snapshot.status, 'partial'); h.reader.validateSnapshot(result.snapshot, spuId);
});

/** 用真实页面消息协议模拟连续商品；删除、选择与后台安全边界仍由现有回归测试执行。 */
function bridgeHarness(fetch, files = [file('a')]) {
    const listeners = new Map(), replies = [], timers = new Set();
    const location = { hostname: 'agentseller.temu.com', pathname: '/goods/list', origin: 'https://agentseller.temu.com', href: 'https://agentseller.temu.com/goods/list' };
    let mallId = 'offline-mall';
    const client = { mallIdClient: { getMallIdAsync: async () => mallId }, post: async (address, input) => {
        if (address.endsWith('/product/query')) return { productId: input.productId,
            productSkcList: [{ productSkuList: [{ productSkuId: '464860473011', extCode: 'SKU-TEST' }] }] };
        // 本夹具只验证证书网络与取消边界；独立实拍图明确没有商品，不复用证书响应冒充空图。
        if (address === '/api/flash/real_picture/list') return { total: 0, items: [], isSemiManagedMall: false };
        if (address.endsWith('/list')) return { ifSemiManaged: false, total: 1, productWithCertList: [{ productBaseInfo: { productId: input.product_ids[0] }, productCertInfoList: [{ certType: 1421 }] }] };
        assert.ok(address.endsWith('/detail')); return { productCertInfo: detail(files) };
    } };
    const runtime = () => client; runtime.m = { 99: function () { return 'getMallIdAsync .postWithoutMallId= .mallIdClient='; } };
    const chunks = []; chunks.push = entry => entry[2](runtime);
    const window = { chunkLoadingGlobal_temu_sca_goods: chunks, fetch, addEventListener: (name, fn) => listeners.set(name, fn), postMessage: message => replies.push(message) };
    const ctx = vm.createContext({ window, location, URL, crypto: webcrypto, TextEncoder, AbortController, atob, btoa,
        setTimeout: (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms <= 5000 ? 25 : ms); timers.add(id); return id; },
        clearTimeout: id => { timers.delete(id); clearTimeout(id); } });
    vm.runInContext(source, ctx);
    vm.runInContext(livePhotoSource, ctx);
    vm.runInContext(bridgeSource, ctx);
    const send = data => listeners.get('message')({ source: window, origin: location.origin, data: { source: 'temu-shop-transfer-api-v1', ...data } });
    return { replies, timers, location, listeners, setMall: id => { mallId = id; }, send,
        query: (extra = {}) => send({ kind: 'query', requestId: webcrypto.randomUUID(), runId: 'run-1', spuId, ...extra }) };
}

test('真实页面桥传递来源 origin，私有 PDF 正文落入脱敏快照', async () => {
    const address = 'https://agentseller.temu.com/product-cert-private-tag/a.pdf?sign=BRIDGE-SECRET';
    const h = bridgeHarness(async (input, options) => {
        assert.equal(input, address); assert.equal(options.credentials, 'same-origin');
        assert.equal(options.mode, 'same-origin'); assert.equal(options.redirect, 'error');
        return response(pdf(20), { finalUrl: input, type: 'basic' });
    }, [{ fileUrl: address, fileName: '成分.pdf' }]);
    await h.query();
    assert.equal(h.replies[0].qualifications.archive.status, 'complete');
    assert.equal(h.replies[0].qualifications.assets[0].name, '成分.pdf');
    assert.doesNotMatch(JSON.stringify(h.replies), /BRIDGE-SECRET/);
});

test('真实页面桥附件超时不置 queryUncertain、不阻塞下一件，迟到响应不修改前后结果', async () => {
    let resolveFirst, count = 0;
    const h = bridgeHarness(async () => ++count === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : response(pdf(20)));
    await h.query(); assert.equal(h.replies[0].qualifications.archive.status, 'failed'); assert.equal(h.replies[0].queryUncertain, false); assert.equal(h.replies[0].stopBatch, false);
    await h.query({ spuId: '45962715609' }); assert.equal(h.replies[1].qualifications.archive.status, 'complete'); assert.equal(h.replies[1].queryUncertain, false);
    const late = response(pdf(20)); resolveFirst(late); await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.replies[0].qualifications.assets.length, 0); assert.equal(h.replies[1].qualifications.assets.length, 1); assert.equal(late.stats.reads, 0); assert.equal(h.timers.size, 0);
});

test('取消消息必须匹配当前请求/批次/商品；pagehide 取消且下一件可查询', async () => {
    for (const mode of ['message', 'pagehide']) {
        let notify, signal, count = 0;
        const started = new Promise(resolve => { notify = resolve; });
        const h = bridgeHarness(async (_, options) => {
            if (++count > 1) return response(pdf(20));
            signal = options.signal; notify(); return new Promise(() => {});
        });
        const request = { requestId: 'current-request', runId: 'run-1', spuId }, first = h.query(request); await started;
        for (const extra of [{ requestId: 'old-request' }, { runId: 'old-run' }, { spuId: '45962715609' }]) {
            await h.send({ ...request, ...extra, kind: 'cancel-archive' }); assert.equal(signal.aborted, false);
        }
        if (mode === 'message') await h.send({ ...request, kind: 'cancel-archive' }); else h.listeners.get('pagehide')();
        await first; assert.equal(signal.aborted, true); assert.equal(h.replies[0].queryUncertain, false);
        assert.match(h.replies[0].qualifications.archive.errors[0].reason, /取消/);
        await h.query({ spuId: '45962715609' }); assert.equal(h.replies[1].qualifications.archive.status, 'complete'); assert.equal(h.timers.size, 0);
    }
});

test('源页面在 fetch 后切店/换 URL，真实桥拒绝发送旧资质快照', async () => {
    for (const mode of ['mall', 'url']) {
        const h = bridgeHarness(async () => { if (mode === 'mall') h.setMall('other-mall'); else h.location.href += '?changed=1'; return response(pdf(20)); });
        await h.query(); assert.ok(h.replies[0].error); assert.equal(h.replies[0].qualifications, undefined); assert.equal(h.timers.size, 0);
    }
});
