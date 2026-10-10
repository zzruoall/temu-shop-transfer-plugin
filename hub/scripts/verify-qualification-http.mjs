/** 附件读取及归档全部在随机临时仓库完成，不继承线上凭证，不访问真实店铺。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createUsers } from '../lib/users.mjs';
import { createStoreOwnership } from '../lib/store-ownership.mjs';
import { createStore } from '../lib/store.mjs';
import { packet, qualificationSnapshot, spuId } from './qualification-fixture.mjs';

test('10MiB真实归档与HTTP字节读取、插件实例认证、共享/个人与分类隔离、删除和篡改拒绝', { timeout: 60000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-qualification-http-'));
    const users = createUsers(root), owners = createStoreOwnership(root), store = createStore(root);
    const sourceUser = await users.register({ username: '13990000101', password: 'isolated-password' });
    const targetUser = await users.register({ username: '13990000102', password: 'isolated-password' });
    const testUser = await users.createTestUser({ username: '13990000103', password: 'isolated-password' });
    const sourceStore = 'temu:101', targetStore = 'temu:201', testStore = 'temu:301';
    await owners.claim(sourceStore, sourceUser, '正式来源');
    await owners.claim(targetStore, targetUser, '正式目标');
    await owners.claim(testStore, testUser, '测试来源');
    const cookies = new Map();
    for (const user of [sourceUser, targetUser, testUser]) cookies.set(user.id, `temu_session=${(await users.signSession(user.id)).value}`);
    const bytes = Buffer.alloc(10 * 1024 * 1024); bytes.write('%PDF-1.7');
    const hash = createHash('sha256').update(bytes).digest('hex');
    const snapshot = qualificationSnapshot();
    snapshot.items[0].detail = { certType: 1421, certNeedUpload: { certNeedUploadItems: [{ contentType: 1 }] },
        productCertFiles: [{ fileUrl: 'https://bstatic.kwcdn.com/cert.pdf', fileName: '证书.pdf' }] };
    snapshot.assets = [{ url: 'https://bstatic.kwcdn.com/cert.pdf', name: '证书.pdf', mimeType: 'application/pdf',
        bytes: bytes.length, sha256: hash, dataBase64: bytes.toString('base64') }];
    snapshot.archive = { status: 'complete', errors: [] };
    const saved = await store.importFiles([{ originalName: 'qualification.json', payload: packet(snapshot, sourceStore) }], { sourceStoreId: sourceStore });
    const testSnapshot = structuredClone(snapshot); testSnapshot.productId = '45962715609';
    await store.importFiles([{ originalName: 'test-qualification.json', payload: packet(testSnapshot, testStore) }], { sourceStoreId: testStore });
    const device = randomUUID(), instance = randomUUID(), token = 'pt_' + randomUUID().replaceAll('-', '');
    const credentials = path.join(root, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ deviceToken: device }));
    await writeFile(path.join(root, 'plugin-tokens.json'), JSON.stringify({ [token]: { instanceId: instance, issuedAt: Date.now(), disabled: false } }));
    const child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true,
        env: { ...process.env, TEMU_CREDENTIALS: credentials, TEMU_BASE_PATH: '/temu', TEMU_MYSQL_CONFIG: '',
            ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_TEST_EPHEMERAL: '1', ZINIAO_INSTANCE_ID: randomUUID(),
            ZINIAO_INGEST_TOKEN: device, ZINIAO_SEED: '0', ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024) } });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    try {
        const [{ port }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw Error(output); })]);
        const origin = `http://127.0.0.1:${port}/temu`;
        const address = source => `/api/qualification-assets/${source === testStore ? testSnapshot.productId : spuId}/${hash}?sourceStoreId=${encodeURIComponent(source)}`;
        const get = (url, auth = {}) => fetch(origin + url, { headers: auth, redirect: 'manual', signal: AbortSignal.timeout(15000) });
        const web = user => ({ cookie: cookies.get(user.id) });
        assert.equal((await get(address(sourceStore))).status, 401);
        assert.equal((await get(address(sourceStore), web(testUser))).status, 403);
        assert.equal((await get(address(testStore), web(targetUser))).status, 403);
        assert.equal((await get(address(sourceStore) + '&library=personal', web(targetUser))).status, 403);
        const response = await get(address(sourceStore), web(targetUser));
        assert.equal(response.status, 200, await response.clone().text());
        assert.equal(response.headers.get('content-type'), 'application/pdf');
        assert.equal(Number(response.headers.get('content-length')), bytes.length);
        assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
        const plugin = { authorization: `Bearer ${token}`, 'x-plugin-instance': instance };
        assert.equal((await get(address(sourceStore), plugin)).status, 403, '尚无当前认领目标不能读取');
        const identity = { storeId: targetStore, mallId: '201', storeName: '正式目标', pageStoreName: '正式目标', pluginInstanceId: instance,
            pluginVersion: '11.0.4', executionMode: 'plugin-api', identityMatched: true, pluginDetected: true, relayProtocol: 1, relaySessionId: randomUUID() };
        const registered = await fetch(origin + '/api/agents/register', { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify(identity) });
        assert.equal(registered.status, 200, await registered.text());
        assert.equal((await get(address(sourceStore), { ...plugin, 'x-plugin-instance': 'forged' })).status, 403);
        const pluginResponse = await get(address(sourceStore), plugin);
        assert.equal(pluginResponse.status, 200, await pluginResponse.clone().text());
        assert.equal(createHash('sha256').update(Buffer.from(await pluginResponse.arrayBuffer())).digest('hex'), hash);
        assert.equal((await get(address(testStore), plugin)).status, 403);
        assert.equal((await get(address(sourceStore) + '&url=https://example.invalid', plugin)).status, 400);
        // 单次人工投递只发送静态引用；原包校验和归档投影仍须通过真实服务端发送链。
        const receiver = fetch(origin + '/api/jobs/claim', { method: 'POST', headers: { ...plugin, 'content-type': 'application/json' },
            body: JSON.stringify(identity), signal: AbortSignal.timeout(15000) });
        const sent = await fetch(origin + '/api/relay/send', { method: 'POST', headers: { ...web(targetUser), 'content-type': 'application/json' },
            body: JSON.stringify({ sourceStoreId: sourceStore, sourceBatchId: saved.batch.id, spuIds: [spuId], targetStoreId: targetStore, actionType: 'qualification_upload' }),
            signal: AbortSignal.timeout(15000) });
        assert.equal(sent.status, 200, await sent.clone().text());
        assert.equal((await sent.json()).sent, 1);
        const received = await receiver;
        assert.equal(received.status, 200, await received.clone().text());
        const delivery = await received.json();
        assert.equal(delivery.claimed[0].actionType, 'qualification_upload');
        assert.equal(delivery.claimed[0].snapshot.qualifications.items[0].files[0].asset.sha256, hash);
        assert.doesNotMatch(JSON.stringify(delivery), /dataBase64/);
        // 同一份采集资料的商品任务不携带资质；协议非法及旧插件不能借兼容入口收到任务。
        const sendTask = actionType => fetch(origin + '/api/relay/send', { method: 'POST', headers: { ...web(targetUser), 'content-type': 'application/json' },
            body: JSON.stringify({ sourceStoreId: sourceStore, sourceBatchId: saved.batch.id, spuIds: [spuId], targetStoreId: targetStore, actionType }), signal: AbortSignal.timeout(15000) });
        assert.equal((await sendTask('unknown_action')).status, 400);
        for (const invalid of [false, 0, null, '']) assert.equal((await sendTask(invalid)).status, 400, '显式无效动作不能兼容为商品创建');
        const registerVersion = pluginVersion => fetch(origin + '/api/agents/register', { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...identity, pluginVersion }) });
        assert.equal((await registerVersion('11.0.3')).status, 200);
        assert.equal((await sendTask('product_create')).status, 409);
        assert.equal((await sendTask('qualification_upload')).status, 409);
        assert.equal((await registerVersion('11.0.4')).status, 200);
        const productReceiver = fetch(origin + '/api/jobs/claim', { method: 'POST', headers: { ...plugin, 'content-type': 'application/json' },
            body: JSON.stringify(identity), signal: AbortSignal.timeout(15000) });
        const productSend = await sendTask('product_create');
        assert.equal(productSend.status, 200, await productSend.clone().text());
        const productDelivery = await (await productReceiver).json();
        assert.equal(productDelivery.claimed[0].actionType, 'product_create');
        assert.equal(Object.hasOwn(productDelivery.claimed[0].snapshot, 'qualifications'), false);
        const rawFile = path.join(store.filesDir, saved.batch.files[0].storedName);
        const original = await readFile(rawFile);
        const changed = JSON.parse(original.toString('utf8')); changed.records[0].payload.result.productName = '篡改';
        await writeFile(rawFile, JSON.stringify(changed));
        assert.notEqual((await get(address(sourceStore), plugin)).status, 200, '归档原包改变必须拒绝读取');
        await writeFile(rawFile, original);
        await store.deleteProducts([spuId], new Set([sourceStore]));
        assert.equal((await get(address(sourceStore), plugin)).status, 404);
        assert.equal((await get(address(testStore), web(testUser))).status, 200, '删除正式资料不影响测试资料');
    } finally {
        child.kill(); await once(child, 'exit').catch(() => {});
        // 仅清理由本测试创建的临时目录，并核验绝对路径位于系统临时目录下。
        assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
        await rm(root, { recursive: true, force: true });
    }
});
