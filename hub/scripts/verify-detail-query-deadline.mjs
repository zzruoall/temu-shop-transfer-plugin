/** 虚拟时钟复现详情成功、资质较慢的跨商品锁死；不访问平台，不等待真实十五秒。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const source = await readFile(new URL('../../plugin/api-reader.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

/** 保留真实页面消息入口，只替换请求与时钟，测试成功清理和超时后不可复活两个边界。 */
function harness(post, readSnapshot = async () => ({ snapshot: { status: 'complete' }, stopBatch: false })) {
    let listener, now = 0, sequence = 0;
    const timers = new Map(), replies = [], calls = [];
    const client = { post: (url, input) => { calls.push({ url, input }); return post(url, input); }, mallIdClient: { getMallIdAsync: async () => 'fixture-mall' } };
    const runtime = () => client;
    runtime.m = { 91: function () { return 'getMallIdAsync .postWithoutMallId= .mallIdClient='; } };
    const chunks = []; chunks.push = entry => entry[2](runtime);
    const location = { hostname: 'agentseller.temu.com', pathname: '/goods/list', origin: 'https://agentseller.temu.com', href: 'https://agentseller.temu.com/goods/list' };
    const window = { chunkLoadingGlobal_temu_sca_goods: chunks, addEventListener: (_, fn) => { listener = fn; }, postMessage: value => replies.push(value) };
    vm.runInNewContext(source, { window, location, crypto: webcrypto, TextEncoder,
        TemuQualificationReader: { readSnapshot },
        setTimeout: (fn, delay) => { const id = ++sequence; timers.set(id, { fn, at: now + delay }); return id; }, clearTimeout: id => timers.delete(id) });
    return { calls, replies, timers,
        query: (spuId = '8044560175') => listener({ source: window, origin: location.origin,
            data: { source: 'temu-shop-transfer-api-v1', kind: 'query', requestId: webcrypto.randomUUID(), runId: 'fixture-run', spuId } }),
        advance: ms => { now += ms; for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); } }
    };
}

test('详情成功后资质耗时超过十五秒，下一件仍可查询且无遗留计时器', async () => {
    const started = deferred(), gate = deferred(); let count = 0;
    const h = harness(async (_, input) => ({ productId: input.productId }), async () => {
        if (++count === 1) { started.resolve(); await gate.promise; }
        return { snapshot: { status: 'complete' }, stopBatch: false };
    });
    const first = h.query(); await started.promise;
    h.advance(20000); gate.resolve(); await first;
    assert.equal(h.replies[0].stopBatch, false);
    assert.equal(h.replies[0].queryUncertain, false);
    await h.query('1774239416');
    assert.equal(h.replies[1].payload.result.productId, '1774239416');
    assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0);
});

test('真实详情超时仍锁定本页，迟到成功不恢复查询', async () => {
    const requested = deferred(), gate = deferred();
    const h = harness(() => { requested.resolve(); return gate.promise; });
    const first = h.query(); await requested.promise; h.advance(15000); await first;
    assert.match(h.replies[0].error, /详情查询超时/);
    assert.equal(h.replies[0].queryUncertain, true);
    gate.resolve({ productId: '8044560175' }); await h.query('1774239416');
    assert.match(h.replies[1].error, /上一条查询结果未确认/);
    assert.equal(h.calls.length, 1); assert.equal(h.timers.size, 0);
});

test('真实资质超时独立锁定本页，详情成功不能取消资质保护', async () => {
    const requested = deferred(), gate = deferred();
    const h = harness(async (url, input) => {
        if (url.endsWith('/product/query')) return { productId: input.productId };
        requested.resolve(); return gate.promise;
    }, async (_, options) => {
        try { await options.post('/mms/arbok/product_cert/query/list', {}); }
        catch (error) { return { snapshot: { status: 'failed' }, stopBatch: error.stopBatch, stopReason: error.message }; }
    });
    const first = h.query(); await requested.promise; h.advance(15000); await first;
    assert.equal(h.replies[0].stopBatch, true); assert.match(h.replies[0].stopReason, /资质查询超时/);
    assert.equal(h.replies[0].queryUncertain, true);
    gate.resolve({}); await h.query('1774239416');
    assert.match(h.replies[1].error, /上一条查询结果未确认/);
    assert.equal(h.calls.length, 2); assert.equal(h.timers.size, 0);
});

test('详情业务拒绝不会留下超时计时器或锁住后续商品', async () => {
    let count = 0;
    const h = harness(async (_, input) => ++count === 1 ? { success: false } : { productId: input.productId });
    await h.query(); h.advance(20000); await h.query('1774239416');
    assert.match(h.replies[0].error, /业务失败/); assert.equal(h.replies[1].payload.result.productId, '1774239416');
    assert.equal(h.timers.size, 0);
});
