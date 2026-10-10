/** 实拍图HTTP权限和下发在随机临时服务验证，包含大原图但不产生真实平台写入。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createUsers } from '../lib/users.mjs';
import { createStoreOwnership } from '../lib/store-ownership.mjs';
import { createStore } from '../lib/store.mjs';
import { livePhotoSnapshot, livePhotoPacket, sourceStoreId } from './live-photo-fixture.mjs';
import { spuId } from './qualification-fixture.mjs';

test('大原图认证读取、测试正式隔离、新插件引用投递与旧插件商品兼容', { timeout: 60000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-photo-http-'));
    let child;
    try {
        const users = createUsers(root), owners = createStoreOwnership(root), store = createStore(root);
        const source = await users.register({ username: '13990000201', password: 'isolated-password' });
        const target = await users.register({ username: '13990000202', password: 'isolated-password' });
        const tester = await users.createTestUser({ username: '13990000203', password: 'isolated-password' });
        const targetStore = 'temu:634418214794848', testStore = 'temu:634418214700003';
        await owners.claim(sourceStoreId, source, '正式来源'); await owners.claim(targetStore, target, '正式目标');
        await owners.claim(testStore, tester, '测试店');
        const cookies = new Map();
        for (const user of [source, target, tester]) cookies.set(user.id, `temu_session=${(await users.signSession(user.id)).value}`);
        const snapshot = livePhotoSnapshot(), bytes = Buffer.alloc(5 * 1024 * 1024); bytes.set([255,216,255,224]);
        snapshot.assets[0] = { ...snapshot.assets[0], bytes: bytes.length, dataBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
        const saved = await store.importFiles([{ originalName: 'photos.json', payload: livePhotoPacket(snapshot) }]);
        const device = randomUUID(), instance = randomUUID(), token = 'pt_' + randomUUID().replaceAll('-', '');
        const credentials = path.join(root, 'credentials.json');
        await writeFile(credentials, JSON.stringify({ deviceToken: device }));
        await writeFile(path.join(root, 'plugin-tokens.json'), JSON.stringify({ [token]: { instanceId: instance, issuedAt: Date.now(), disabled: false } }));
        child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true,
            env: { ...process.env, TEMU_CREDENTIALS: credentials, TEMU_BASE_PATH: '/temu', TEMU_MYSQL_CONFIG: '',
                ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_TEST_EPHEMERAL: '1', ZINIAO_INSTANCE_ID: randomUUID(),
                ZINIAO_INGEST_TOKEN: device, ZINIAO_SEED: '0', ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024) } });
        let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
        const [{ port }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(output); })]);
        const origin = `http://127.0.0.1:${port}/temu`;
        // 发布候选可在同一随机服务预先跑正式只读smoke，暴露验收脚本自身的问题而不是到维护期才发现。
        if (process.env.TEMU_SMOKE_LIVE_PHOTO === '1') {
            (await import('node:child_process')).execFileSync(process.execPath,
                [new URL('./smoke-live-photo-v60.mjs', import.meta.url).pathname.replace(/^\/(\w:)/, '$1')],
                { env: { ...process.env, TEMU_CREDENTIALS: credentials, TEMU_SMOKE_BASE: origin, TEMU_MYSQL_CONFIG: '' },
                    windowsHide: true, timeout: 60000, stdio: 'inherit' });
        }
        const plugin = { authorization: `Bearer ${token}`, 'x-plugin-instance': instance };
        const web = user => ({ cookie: cookies.get(user.id) });
        const photo = `/api/live-photo-assets/${spuId}/${snapshot.assets[0].sha256}?sourceStoreId=${encodeURIComponent(sourceStoreId)}`;
        const get = (url, headers = {}) => fetch(origin + url, { headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        assert.equal((await get(photo)).status, 401);
        assert.equal((await get(photo, web(tester))).status, 403);
        assert.equal((await get(photo + '&library=personal', web(target))).status, 403);
        assert.equal((await get(photo + '&url=https://evil.invalid', web(target))).status, 400);
        assert.equal((await get(photo, plugin)).status, 403);
        const data = await get(photo, web(target));
        assert.equal(data.status, 200, await data.clone().text());
        assert.equal(data.headers.get('content-type'), 'image/jpeg');
        assert.equal(data.headers.get('cache-control'), 'private, no-store');
        assert.deepEqual(Buffer.from(await data.arrayBuffer()), bytes);
        assert.equal((await get(photo.replace('live-photo-assets', 'qualification-assets'), web(target))).status, 404);
        const detail = await (await get(`/api/products/${spuId}?sourceStoreId=${encodeURIComponent(sourceStoreId)}`, web(target))).json();
        assert.equal(detail.product.livePhotoCaptures[0].assets[0].sha256, snapshot.assets[0].sha256);
        assert.doesNotMatch(JSON.stringify(detail), /dataBase64/);
        const identity = { storeId: targetStore, mallId: targetStore.slice(5), storeName: '正式目标', pageStoreName: '正式目标', pluginInstanceId: instance,
            pluginVersion: '11.0.8', executionMode: 'plugin-api', identityMatched: true, pluginDetected: true,
            relayProtocol: 1, relaySessionId: randomUUID() };
        const register = async () => {
            const response = await fetch(origin + '/api/agents/register', { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify(identity) });
            assert.equal(response.status, 200, await response.text());
        };
        await register();
        assert.equal((await get(photo, plugin)).status, 200);
        assert.equal((await get(photo, { ...plugin, 'x-plugin-instance': 'forged' })).status, 403);
        const send = actionType => fetch(origin + '/api/relay/send', { method: 'POST', headers: { ...web(target), 'content-type': 'application/json' },
            body: JSON.stringify({ sourceStoreId, sourceBatchId: saved.batch.id, spuIds: [spuId], targetStoreId: targetStore, actionType }), signal: AbortSignal.timeout(15000) });
        assert.equal((await send('qualification_upload')).status, 409, '旧能力不能静默遗漏图片');
        const receive = () => fetch(origin + '/api/jobs/claim', { method: 'POST', headers: { ...plugin, 'content-type': 'application/json' }, body: JSON.stringify(identity), signal: AbortSignal.timeout(15000) });
        let receiving = receive(), sent = await send('product_create');
        assert.equal(sent.status, 200, await sent.clone().text());
        let delivery = await (await receiving).json();
        assert.equal(delivery.claimed[0].snapshot.livePhotos, undefined);
        identity.livePhotoTransferVersion = 1; await register();
        receiving = receive(); sent = await send('qualification_upload');
        assert.equal(sent.status, 200, await sent.clone().text());
        delivery = await (await receiving).json();
        assert.equal(delivery.claimed[0].snapshot.livePhotos.assets[0].sha256, snapshot.assets[0].sha256);
        assert.doesNotMatch(JSON.stringify(delivery), /dataBase64/);
        assert.ok(Buffer.byteLength(JSON.stringify(delivery)) < 4 * 1024 * 1024);
        await store.deleteProducts([spuId]);
        assert.equal((await get(photo, plugin)).status, 404);
    } finally {
        if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); }
        await rm(root, { recursive: true, force: true });
    }
});
