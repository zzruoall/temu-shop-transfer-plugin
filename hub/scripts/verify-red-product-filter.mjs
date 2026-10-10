/** 用真实收发 HTTP 复现六件中两件旧红标的过滤；只用隔离目录/33917随机库和模拟插件。 */
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore } from '../lib/store.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { transferManifest } from '../lib/transfer-integrity.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'temu-red-filter-'));
const token = randomUUID(), sourceStoreId = 'temu:111', ids = Array.from({ length: 6 }, (_, i) => String(9100000001 + i));
const reds = ids.slice(0, 2), normal = ids.slice(2);
let admin, database, name, child, config = '', log = '';
/** 六件使用不同货号，不把同行合并造成的件数变化混入红标过滤断言。 */
function packet(spuIds) {
    return { kind: 'full-capture-packet', schemaVersion: 5, source: { sourceStoreId }, products: spuIds.map(spuId => ({ spuId })),
        records: spuIds.map(spuId => ({ dataType: 'product-detail', identity: { productIds: [spuId] },
            source: { pageProductId: spuId, requestUrl: 'https://example.invalid/visage-agent-seller/product/query' },
            payload: { success: true, result: { productId: spuId, productName: `隔离商品${spuId}`, extCode: `CODE-${spuId}` } } })) };
}
try {
    if (process.argv.includes('--mysql')) {
        admin = await (await import('mysql2/promise')).createConnection({ host: '127.0.0.1', port: 33917, user: 'root', connectTimeout: 1500 });
        name = `temu_red_filter_${Date.now()}_${process.pid}`;
        assert.match(name, /^temu_red_filter_\d+_\d+$/);
        await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        config = path.join(root, 'mysql.json');
        await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: name }));
        database = await openMysqlDatabase(config);
        await initializeMysqlSchema(database);
        await database.query('maintenance', "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    }
    const store = createStore(root, { database });
    const original = await store.importFiles([{ originalName: 'six-products.json', payload: packet(ids) }]);
    const before = await store.noticeRefs(sourceStoreId, ids);
    for (const spuId of reds) await store.markProductBlocked({ storeId: sourceStoreId, spuId, reason: `旧版原始错误-${spuId}` });
    const boundary = await store.withNoticeDelivery(before.map(ref => ({ sourceStoreId, spuId: ref.spuId, sourceNoticeRef: ref })), payload => payload);
    assert.deepEqual(boundary.claimed.map(item => item.spuId), normal);
    assert.deepEqual(boundary.skippedBlocked.map(item => item.spuId), reds, '先准备后标红，实际交接仍须过滤');
    const credentials = path.join(root, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ deviceToken: token }));
    child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true, env: {
        ...process.env, TEMU_CREDENTIALS: credentials, TEMU_BASE_PATH: '', TEMU_MYSQL_CONFIG: config,
        ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_TEST_EPHEMERAL: '1', ZINIAO_INSTANCE_ID: randomUUID(),
        ZINIAO_SEED: '0', ZINIAO_INGEST_TOKEN: token, ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024)
    } });
    child.stdout.on('data', bytes => { log += bytes; }); child.stderr.on('data', bytes => { log += bytes; });
    const [{ port }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw Error(`隔离服务启动失败 ${code}: ${log}`); })]);
    const api = async (url, body, method = 'POST') => {
        const response = await fetch(`http://127.0.0.1:${port}${url}`, { signal: AbortSignal.timeout(15000),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            ...(body === undefined ? {} : { method, body: JSON.stringify(body) }) });
        const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
    };
    const agent = { storeId: 'temu:222', mallId: '222', pluginInstanceId: 'red-filter-plugin', storeName: '隔离目标店',
        pageStoreName: '隔离目标店', pluginVersion: '11.0.4', executionMode: 'plugin-api', pluginDetected: true,
        identityMatched: true, relayProtocol: 1, relaySessionId: randomUUID() };
    await api('/api/agents/register', agent);
    const body = spuIds => ({ sourceStoreId, sourceBatchId: original.batch.id, targetStoreId: agent.storeId, spuIds });
    const overview = await api('/api/overview?productLimit=20');
    assert.equal(overview.productCount, 6); assert.equal(overview.blockedCount, 2);
    for (const p of overview.products) {
        assert.equal(p.sendBlocked, reds.includes(p.spuId));
        assert.equal(p.errorNotice, null, '不能伪造旧红标为新版错误通知');
    }
    // 两种任务与两种调用顺序都经过实际交接，补全资质不能绕过红标商品过滤。
    for (const actionType of ['product_create', 'qualification_upload']) for (const receiveFirst of [true, false]) {
        let receive, send;
        if (receiveFirst) { receive = api('/api/jobs/claim', agent); send = api('/api/relay/send', { ...body(ids), actionType }); }
        else { send = api('/api/relay/send', { ...body(ids), actionType }); await new Promise(resolve => setTimeout(resolve, 100)); receive = api('/api/jobs/claim', agent); }
        const [sent, got] = await Promise.all([send, receive]);
        assert.equal(sent.sent, 4); assert.deepEqual(sent.skippedBlocked.map(p => p.spuId).sort(), [...reds].sort());
        assert.deepEqual(got.claimed.map(p => p.spuId).sort(), [...normal].sort(), '插件实际收到只能是四件正常商品');
        assert.ok(got.claimed.every(task => task.actionType === actionType));
    }
    const skipped = await api('/api/relay/send', body(reds));
    assert.equal(skipped.sent, 0); assert.equal(skipped.skippedBlocked.length, 2, '全红不等待接收、不发空批次');
    await api('/api/products/unblock', { spuIds: [reds[0]] });
    const receive = api('/api/jobs/claim', agent), sent = await api('/api/relay/send', body(ids));
    assert.equal(sent.sent, 5); assert.equal((await receive).claimed.length, 5, '人工解除后可重新发送');
    await api('/api/products', { spuIds: [reds[1]], storeIds: [sourceStoreId] }, 'DELETE');
    const freshPacket = packet([reds[1]]);
    const fresh = await api('/api/ingest', { packet: freshPacket, transferIntegrity: transferManifest(freshPacket) });
    const receiveFresh = api('/api/jobs/claim', agent);
    const resent = await api('/api/relay/send', { ...body([reds[1]]), sourceBatchId: fresh.batchId });
    assert.equal(resent.sent, 1); assert.equal((await receiveFresh).claimed[0].spuId, reds[1], '删除重传不继承旧红标');
    console.log(JSON.stringify({ passed: true, backend: database ? 'mysql-isolated-33917' : 'file', selected: 6, sent: 4,
        skipped: 2, bothHandoffOrders: true, allRedZero: true, manualUnblock: true, deleteReupload: true, realPlatformCalls: 0 }));
} catch (error) { error.message += `\n${log.slice(-1500)}`; throw error; }
finally {
    if (child && child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
    await database?.close();
    if (admin) { if (name) await admin.query(`DROP DATABASE ${name}`); await admin.end(); }
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
}
