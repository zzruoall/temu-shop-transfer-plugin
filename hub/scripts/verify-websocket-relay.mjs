/** 隔离本机连接测试主动推送；不连接线上、不写商品库、不调用平台接口。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createOneShotRelay } from '../lib/one-shot-relay.mjs';
import { installWebsocketRelay } from '../lib/websocket-relay.mjs';

const identity = { storeId: 'temu:222', pluginInstanceId: 'fixture-instance', relaySessionId: 'fixture-session',
    pluginDetected: true, pluginVersion: '11.0.0', relayProtocol: 1 };
async function fixture(options = {}) {
    const server = http.createServer();
    const relay = createOneShotRelay({ waitMs: 25, ...options.relay });
    const api = installWebsocketRelay(server, { relay,
        pathMatches: req => req.url === '/api/relay/socket',
        authenticate: async (_req, message) => { if (message.token !== 'fixture-token') throw Error('denied'); return { auth: {}, identity: { ...identity, ...message.identity } }; },
        register: async id => ({ ...id, identityMatched: true, canReceiveUploads: true }), validate: async () => {},
        authTimeoutMs: 100, heartbeatMs: 100, ...options.socket });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const connect = async (token = 'fixture-token', extra = {}) => {
        const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/relay/socket`);
        await once(socket, 'open');
        const ready = once(socket, 'message');
        socket.send(JSON.stringify({ type: 'authenticate', token, identity: extra }));
        return { socket, ready };
    };
    return { relay, connect, cleanup: async () => { api.close(); await new Promise(resolve => server.close(resolve)); } };
}

test('连接就绪立即响应，商品主动推送且没有领取请求', async () => {
    const f = await fixture();
    try {
        const { socket, ready } = await f.connect();
        assert.equal(JSON.parse((await ready)[0]).type, 'ready');
        const pushed = once(socket, 'message');
        assert.deepEqual(await f.relay.send(identity, [{ spuId: '123' }], 'owner'), { sent: 1, skippedBlocked: [] });
        assert.deepEqual(JSON.parse((await pushed)[0]), { type: 'products', claimed: [{ spuId: '123' }] });
        assert.equal(f.relay.snapshot().channels, 1);
        socket.close();
    } finally { await f.cleanup(); }
});

test('实际交接仍执行红标过滤，不把禁传商品推入插件', async () => {
    const f = await fixture({ relay: { handoff: (items, deliver) => deliver({ claimed: items.filter(item => !item.blocked), skippedBlocked: [{ spuId: 'bad' }] }) } });
    try {
        const { socket, ready } = await f.connect(); await ready;
        const pushed = once(socket, 'message');
        const result = await f.relay.send(identity, [{ spuId: 'bad', blocked: true }, { spuId: 'good' }], 'owner');
        assert.equal(result.sent, 1); assert.equal(JSON.parse((await pushed)[0]).claimed[0].spuId, 'good');
    } finally { await f.cleanup(); }
});

// 预算包括消息包装，拒绝发生在写入 socket 前，不产生错误商品帧或留存待重放正文。
test('长连接发送受共享缓冲预算限制，拒绝后小消息仍可发送', async () => {
    const f = await fixture({ socket: { maxBufferedBytes: 128 } });
    try {
        const { socket, ready } = await f.connect(); await ready;
        await assert.rejects(f.relay.send(identity, [{ title: 'x'.repeat(200) }], 'owner'), error => error.status === 429);
        const pushed = once(socket, 'message');
        assert.equal((await f.relay.send(identity, [{ spuId: 'small' }], 'owner')).sent, 1);
        assert.equal(JSON.parse((await pushed)[0]).claimed[0].spuId, 'small');
        assert.equal(f.relay.snapshot().bytes, 0);
    } finally { await f.cleanup(); }
});

test('断线的发送超时丢弃，重连后只收到新的主动发送', async () => {
    const f = await fixture();
    try {
        const first = await f.connect(); await first.ready; first.socket.close(); await once(first.socket, 'close');
        await assert.rejects(f.relay.send(identity, [{ spuId: 'old' }], 'owner'), /relay_not_connected/);
        const second = await f.connect(); await second.ready;
        const pushed = once(second.socket, 'message');
        await f.relay.send(identity, [{ spuId: 'new' }], 'owner');
        assert.equal(JSON.parse((await pushed)[0]).claimed[0].spuId, 'new');
    } finally { await f.cleanup(); }
});

test('错误认证、非活性消息、失去权限均关闭连接', async () => {
    const f = await fixture({ socket: { heartbeatMs: 25, validate: async () => { throw Error('revoked'); } } });
    try {
        const rejected = await f.connect('bad'); rejected.ready.catch(() => {});
        assert.equal((await once(rejected.socket, 'close'))[0], 4403);
        const denied = await f.connect(); await denied.ready;
        assert.equal((await once(denied.socket, 'close'))[0], 4403);
    } finally { await f.cleanup(); }
});

test('并发发送仍保留同店互斥，断线没有残留通道', async () => {
    let release;
    const f = await fixture({ relay: { handoff: async (items, deliver) => { await new Promise(resolve => { release = resolve; }); return deliver({ claimed: items }); } } });
    try {
        const { socket, ready } = await f.connect(); await ready;
        const first = f.relay.send(identity, [{ spuId: 'one' }], 'owner');
        await assert.rejects(f.relay.send(identity, [{ spuId: 'two' }], 'owner'), /relay_store_busy/);
        release(); await first; socket.close(); await once(socket, 'close');
        for (let i = 0; i < 25 && f.relay.snapshot().channels; i++) await new Promise(resolve => setTimeout(resolve, 5));
        assert.equal(f.relay.snapshot().channels, 0);
    } finally { await f.cleanup(); }
});
