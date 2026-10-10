/** 真实服务端的隔离闭环：只操作临时仓库，插件接收连接不存储运行情况或恢复旧投递。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { transferManifest } from '../lib/transfer-integrity.mjs';

test('真实云端认证、前缀路由和主动投递闭环，不轮询、不保存运行结果、不重放', { timeout: 30000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-ws-http-'));
    const device = 'isolated-websocket-device', instance = 'isolated-plugin-instance';
    const token = 'pt_' + randomUUID().replaceAll('-', '');
    const otherToken = 'pt_' + randomUUID().replaceAll('-', ''), otherInstance = 'isolated-other-store-instance';
    const credentials = path.join(root, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ deviceToken: device }));
    await writeFile(path.join(root, 'plugin-tokens.json'), JSON.stringify({ [token]: { instanceId: instance, issuedAt: Date.now(), disabled: false },
        [otherToken]: { instanceId: otherInstance, issuedAt: Date.now(), disabled: false } }));
    const child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true,
        env: { ...process.env, TEMU_CREDENTIALS: credentials, TEMU_BASE_PATH: '/temu', TEMU_MYSQL_CONFIG: '',
            ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_TEST_EPHEMERAL: '1',
            ZINIAO_INSTANCE_ID: randomUUID(), ZINIAO_INGEST_TOKEN: device, ZINIAO_SEED: '0' } });
    let output = ''; const sockets = [];
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    try {
        const [{ port }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(output); })]);
        const origin = `http://127.0.0.1:${port}/temu`;
        const api = async (url, body) => {
            const response = await fetch(origin + url, { headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' },
                ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
            assert.equal(response.status, 200, await response.clone().text()); return response.json();
        };
        const identity = { storeId: 'temu:222', mallId: '222', storeName: '隔离目标店', pageStoreName: '隔离目标店',
            pageUrl: 'https://agentseller.temu.com/goods/list', relayProtocol: 1, relaySessionId: randomUUID(),
            executionMode: 'plugin-api', identityMatched: true, pluginVersion: '11.0.4' };
        const connect = async (auth = token, changes = {}, pluginInstanceId = instance) => {
            const socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/relay/socket'); sockets.push(socket);
            const frames = [], callbacks = [];
            socket.on('error', () => {});
            socket.on('message', data => { const frame = JSON.parse(data); frames.push(frame); callbacks.splice(0).forEach(fn => fn()); });
            const next = async type => {
                const deadline = AbortSignal.timeout(5000);
                while (!frames.some(frame => frame.type === type)) {
                    await new Promise((resolve, reject) => {
                        const done = () => { deadline.removeEventListener('abort', abort); resolve(); };
                        const abort = () => { callbacks.splice(callbacks.indexOf(done), 1); reject(Error('未收到' + type)); };
                        callbacks.push(done); deadline.addEventListener('abort', abort, { once: true });
                    });
                }
                return frames.splice(frames.findIndex(frame => frame.type === type), 1)[0];
            };
            await once(socket, 'open');
            socket.send(JSON.stringify({ type: 'authenticate', token: auth, pluginInstanceId, identity: { ...identity, ...changes } }));
            return { socket, frames, next };
        };
        const invalid = await connect('bad-token'); assert.equal((await once(invalid.socket, 'close'))[0], 4403);
        const malformed = await connect(token, { storeId: 'other:222' }); assert.equal((await once(malformed.socket, 'close'))[0], 4403);
        const forged = await connect(token, {}, otherInstance); assert.equal((await once(forged.socket, 'close'))[0], 4403);
        // 有效凭证也不能让旧不完整版本或未知主版本进入通道，更不能依赖目录上的灰色状态兜底。
        for (const version of ['12.0.0', '10.0.3', '10.10.56']) {
            const unsupported = await connect(token, { pluginVersion: version });
            assert.equal((await once(unsupported.socket, 'close'))[0], 4403, version);
            assert.equal(unsupported.frames.length, 0, '拒绝版本不得收到ready或商品');
        }
        const receiver = await connect(); const ready = await receiver.next('ready');
        assert.equal(ready.agent.storeId, identity.storeId); assert.equal(ready.agent.pluginInstanceId, instance);
        assert.equal(ready.agent.pluginVersion, '11.0.4');assert.equal(ready.agent.canReceiveUploads,true);
        // 不同紫鸟店铺使用各自浏览器配置与插件实例，两条连接不得改变彼此店铺绑定。
        const other = await connect(otherToken, { storeId: 'temu:333', mallId: '333', relaySessionId: randomUUID() }, otherInstance);
        assert.equal((await other.next('ready')).agent.storeId, 'temu:333');
        const agents = (await api('/api/agents')).agents;
        assert.equal(agents.find(agent => agent.pluginInstanceId === instance).storeId, 'temu:222');
        assert.equal(agents.find(agent => agent.pluginInstanceId === otherInstance).storeId, 'temu:333');
        const source = { productId: '1234567890', productName: '隔离商品' };
        const packet = { kind: 'full-capture-packet', schemaVersion: 5, source: { sourceStoreId: 'temu:111', shopName: '隔离来源店' },
            products: [{ spuId: source.productId }], records: [{ dataType: 'product-detail', identity: { productIds: [source.productId] },
                source: { pageProductId: source.productId, requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
                payload: { success: true, result: source } }] };
        const imported = await api('/api/ingest', { packet, transferIntegrity: transferManifest(packet) });
        const send = { sourceStoreId: 'temu:111', sourceBatchId: imported.batchId, targetStoreId: identity.storeId, spuIds: [source.productId] };
        const before = JSON.parse(await readFile(path.join(root, 'data/jobs.json'), 'utf8')).jobs;
        assert.equal((await api('/api/relay/send', send)).sent, 1);
        const first = (await receiver.next('products')).claimed[0];
        assert.deepEqual(first.snapshot.publicationData.sourceProduct, source);
        assert.equal((await api('/api/relay/send', { ...send, targetStoreId: 'temu:333' })).sent, 1);
        assert.equal((await other.next('products')).claimed[0].targetStoreId, 'temu:333');
        assert.equal((await api('/api/relay/send', send)).sent, 1, '人工重复点击仍可再次发送');
        await receiver.next('products');
        assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data/jobs.json'), 'utf8')).jobs, before);
        // 已有连接不代表永久拥有资格；后续登记成不支持版本时，实际发送和兼容领取都必须拒绝。
        for (const version of ['12.0.0', '10.0.3', '11..0']) {
            await api('/api/agents/register', { ...identity, pluginInstanceId: instance, pluginDetected: true, pluginVersion: version });
            const request = async (endpoint, body) => fetch(origin + endpoint, { method: 'POST',
                headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
            assert.equal((await request('/api/relay/send', send)).status, 409, version);
            assert.equal((await request('/api/jobs/claim', { ...identity, pluginInstanceId: instance })).status, 426, version);
            assert.equal(receiver.frames.length, 0, '不支持版本不能借已有连接接到商品');
        }
        await api('/api/agents/register', { ...identity, pluginInstanceId: instance, pluginDetected: true });
        receiver.socket.close(); await once(receiver.socket, 'close');
        // 重连只收到身份就绪，不包含旧商品；只有下一次人工发送才出现商品帧。
        const next = await connect(token, { pluginVersion: '11.0.4' });
        assert.equal((await next.next('ready')).agent.canReceiveUploads, true); assert.equal(next.frames.length, 0);
        assert.equal((await api('/api/relay/send', send)).sent, 1); await next.next('products');
        next.socket.send(JSON.stringify({ type: 'progress', completed: 1 }));
        assert.equal((await once(next.socket, 'close'))[0], 4400);
    } finally {
        sockets.forEach(socket => socket.terminate());
        if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
        await rm(root, { recursive: true, force: true });
    }
});
