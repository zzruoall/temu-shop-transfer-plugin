/** 无回执中转的验收只用假连接，不访问平台或正式仓库。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createOneShotRelay } from '../lib/one-shot-relay.mjs';

const identity = { storeId: 'temu:1', pluginInstanceId: 'plugin1', relaySessionId: 'page1' };
test('发出后不等待回执，也不把同一内容自动再次下发', async () => {
    const relay = createOneShotRelay({ waitMs: 20 });
    const receiving = relay.receive(identity);
    await relay.send(identity, [{ spuId: 'a' }], 'account');
    assert.equal((await receiving).claimed[0].spuId, 'a');
    assert.deepEqual((await relay.receive(identity)).claimed, []);
    assert.equal(relay.snapshot().bytes, 0);
});
test('无接收连接时超时丢弃，后续连接不会恢复旧发送', async () => {
    const relay = createOneShotRelay({ waitMs: 10 });
    await assert.rejects(relay.send(identity, [{ spuId: 'a' }], 'account'), /relay_not_connected/);
    assert.deepEqual((await relay.receive(identity)).claimed, []);
});
test('店铺、实例和页面均隔离', async () => {
    const relay = createOneShotRelay({ waitMs: 15 });
    const wrong = relay.receive({ ...identity, relaySessionId: 'new-page' });
    await assert.rejects(relay.send(identity, [{ spuId: 'a' }], 'account'), /relay_not_connected/);
    assert.deepEqual((await wrong).claimed, []);
});
test('发送端断开后不留待办，重复人工点击仍可新发', async () => {
    const relay = createOneShotRelay({ waitMs: 15 });
    const controller = new AbortController();
    const sending = relay.send(identity, [{ spuId: 'a' }], 'account', controller.signal);
    controller.abort();
    await assert.rejects(sending, /relay_aborted/);
    for (let i = 0; i < 2; i++) {
        const receiver = relay.receive(identity);
        await relay.send(identity, [{ spuId: 'a' }], 'account');
        assert.equal((await receiver).claimed.length, 1);
    }
});
test('传输容量有上限，不能按商品数量无限占内存', async () => {
    const relay = createOneShotRelay({ waitMs: 15, maxBytes: 20 });
    await assert.rejects(relay.send(identity, [{ content: 'x'.repeat(21) }], 'account'), /relay_capacity/);
    assert.equal(relay.snapshot().bytes, 0);
});

/** 两条实际交接路径均在最后安全点重读资格，不用最初发起时的缓存标志。 */
for (const receiverFirst of [true, false]) test(`等待交接中新标记被过滤（接收先到=${receiverFirst}）`, async () => {
    let unlock, entered, blocked = false;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { unlock = resolve; });
    const relay = createOneShotRelay({ waitMs: 1000, handoff: async (claimed, deliver) => {
        entered(); await gate;
        return deliver({ claimed: blocked ? [] : claimed, skippedBlocked: blocked ? claimed : [] });
    } });
    let sending, receiving;
    if (receiverFirst) { receiving = relay.receive(identity); sending = relay.send(identity, [{ spuId: 'a' }], 'account'); }
    else { sending = relay.send(identity, [{ spuId: 'a' }], 'account'); receiving = relay.receive(identity); }
    await started;
    if (receiverFirst) await assert.rejects(relay.send(identity, [{ spuId: 'b' }], 'account'), /relay_store_busy/);
    else await assert.rejects(relay.receive(identity), /relay_receiver_busy/);
    blocked = true; unlock();
    assert.equal((await sending).sent, 0); assert.deepEqual((await receiving).claimed, []);
    assert.equal(relay.snapshot().bytes, 0);
    assert.equal(relay.snapshot().pending, 0);
});

/** 资格查询等待期间撤销原 HTTP，不允许迟到回调把正文交给下一条连接。 */
for (const receiverFirst of [true, false]) test(`资格核验期间结束不会迟到交付（接收先到=${receiverFirst}）`, async () => {
    let unlock, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { unlock = resolve; });
    const controller = new AbortController();
    const relay = createOneShotRelay({ waitMs: 1000, handoff: async (claimed, deliver) => {
        entered(); await gate; return deliver({ claimed });
    } });
    const receiving = receiverFirst ? relay.receive(identity) : null;
    const sending = relay.send(identity, [{ spuId: 'a' }], 'account', controller.signal);
    const actualReceiver = receiving || relay.receive(identity);
    // 先注册拒绝处理，避免取消产生预期拒绝时被测试框架误判为未处理异常。
    const sendCheck = assert.rejects(sending, /relay_aborted/);
    const receiveCheck = assert.rejects(actualReceiver, /relay_aborted/);
    await started; controller.abort(); unlock();
    await sendCheck; await receiveCheck;
    assert.equal(relay.snapshot().bytes, 0);
});
