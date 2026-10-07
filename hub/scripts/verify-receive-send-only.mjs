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
