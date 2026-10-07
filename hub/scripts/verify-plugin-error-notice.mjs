/** 实际通知模块的隔离反例：只模拟网络和时钟，不向平台或生产服务器发送。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../plugin/error-notice.js', import.meta.url), 'utf8');
const context = vm.createContext({ TextEncoder, crypto: globalThis.crypto, setTimeout, Math, Promise });
vm.runInContext(source, context);
const api = context.TemuErrorNotices;
const item = (extra = {}) => ({ jobId: crypto.randomUUID(), spuId: '1234567890', targetStoreId: 'temu:222',
    relaySessionId: 'session', executionRunId: 'run', noticeToken: 'signed-token', directState: 'rejected',
    reason: 'SKU字段无效', errorCode: 'PRODUCT_SKU_INVALID', ...extra });
const drained = async reporter => {
    for (let i = 0; i < 100 && reporter.snapshot().entries; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(reporter.snapshot().entries, 0);
};
test('正常状态零通知，未知数字和店铺/限流错误不分类为商品禁传', () => {
    for (const directState of ['created', 'duplicate_exists', 'duplicate_wait', 'authorizing']) assert.equal(api.classify(item({ directState })), null);
    assert.equal(api.classify(item({ errorCode: '2000135' })), 'unknown');
    assert.equal(api.classify(item({ errorCode: '429' })), 'transport');
    assert.equal(api.classify(item({ errorCode: 'SHOP_PERMISSION_DENIED' })), 'shop_context');
    assert.equal(api.classify(item({ directState: 'unknown' })), 'unknown');
});

test('已核实平台字段码必须匹配原因、提交阶段和确定性拒绝，原始码仍回传', async () => {
    const { parseProductErrorNotice } = await import('../lib/product-notice-token.mjs');
    const cases = [
        { errorCode: '2000135', reason: '当前类目净含量必填' },
        { errorCode: '2000225', reason: '化妆品成分不存在，请删除：Mentha Piperita (Peppermint) Extract' }
    ];
    for (const entry of cases) {
        const task = item({ ...entry, errorStage: '提交' });
        assert.equal(api.classify(task), 'product_data');
        for (const patch of [{ reason: '未知错误' }, { errorStage: '预检' }, { directState: 'unknown' }, { directState: 'preflight_failed' }]) {
            assert.equal(api.classify({ ...task, ...patch }), 'unknown');
        }
        const calls = [];
        const reporter = api.create({ post: async body => {
            calls.push(body); assert.equal(parseProductErrorNotice(body).mark, true); return { status: 'marked' };
        }, valid: async () => true, status: async () => {} });
        assert.equal(reporter.enqueue(task, 'plugin'), true); await drained(reporter);
        assert.equal(calls.length, 1); assert.equal(calls[0].errorCode, entry.errorCode);
        assert.equal(calls[0].reason, entry.reason);
        assert.equal(parseProductErrorNotice({ ...calls[0], errorScope: 'transport' }).mark, false);
        assert.equal(parseProductErrorNotice({ ...calls[0], reason: '未核实原因' }).mark, false);
        assert.equal(parseProductErrorNotice({ ...calls[0], errorStage: '预检' }).mark, false);
    }
});
test('同错误仅排一次，成功与无凭证不通知，已确认后不重新排', async () => {
    const calls = [], states = [];
    const reporter = api.create({ post: async body => { calls.push(body); return { status: 'marked' }; },
        valid: async () => true, status: async (task, state) => states.push(state) });
    const task = item();
    assert.equal(reporter.enqueue(item({ directState: 'created' }), 'plugin'), false);
    assert.equal(reporter.enqueue(item({ noticeToken: '' }), 'plugin'), false);
    assert.equal(reporter.enqueue(task, 'plugin', ['CODE-1']), true);
    assert.equal(reporter.enqueue(task, 'plugin'), false);
    await drained(reporter);
    assert.equal(calls.length, 1); assert.equal(calls[0].errorScope, 'product_data');
    assert.deepEqual(states, ['pending', 'marked']);
    assert.equal(reporter.enqueue({ ...task, errorNoticeStatus: 'marked' }, 'plugin'), false);
});
test('仅网络通知有限重试，事件标识不变，拒绝授权不重试', async () => {
    const ids = [];
    const reporter = api.create({ post: async body => { ids.push(body.eventId); throw Object.assign(Error('临时不可用'), { status: 503 }); },
        valid: async () => true, status: async () => {}, sleep: async () => {} });
    reporter.enqueue(item(), 'plugin'); await drained(reporter);
    assert.equal(ids.length, 3); assert.equal(new Set(ids).size, 1);
    let denied = 0;
    const second = api.create({ post: async () => { denied++; throw Object.assign(Error('旧授权'), { status: 403 }); },
        valid: async () => true, status: async () => {}, sleep: async () => {} });
    second.enqueue(item(), 'plugin'); await drained(second); assert.equal(denied, 1);
});
test('刷新轮次失效即丢通知，缓冲和同时网络请求有硬上限', async () => {
    let calls = 0, current = false;
    const reporter = api.create({ post: async () => { calls++; return { status: 'marked' }; }, valid: async () => current, status: async () => {} });
    reporter.enqueue(item(), 'plugin'); await drained(reporter); assert.equal(calls, 0);
    let resolve;
    const stalled = new Promise(done => { resolve = done; });
    const bounded = api.create({ post: async () => { calls++; return stalled; }, valid: async () => current,
        status: async () => {} });
    current = true;
    for (let i = 0; i < 70; i++) bounded.enqueue(item(), 'plugin');
    await new Promise(done => setTimeout(done, 1));
    assert.equal(bounded.snapshot().entries, 64); assert.equal(bounded.snapshot().active, 2);
    assert.ok(bounded.snapshot().bytes <= 256 * 1024);
    current = false; resolve({ status: 'marked' }); await drained(bounded);
});
