/** 真实HTTP路由配合随机回环数据库，验证先申请后上传及丢回执查询，不访问外部网站。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import mysql from 'mysql2/promise';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { transferManifest } from '../lib/transfer-integrity.mjs';
const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33917, user: 'root' });
const name = `temu_http_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root = await mkdtemp(path.join(tmpdir(), 'temu-http-'));
const config = path.join(root, 'mysql.json');
await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: name }));
const db = await openMysqlDatabase(config);
let child, success = false;
try {
    await initializeMysqlSchema(db);
    await db.query('maintenance', "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    const token = crypto.randomUUID(), instanceId = crypto.randomUUID();
    child = fork(new URL('../server.mjs', import.meta.url), [], { env: { ...process.env, TEMU_CREDENTIALS: '', TEMU_MYSQL_CONFIG: config, ZINIAO_DATA_ROOT: root,
        ZINIAO_INGEST_TOKEN: token, ZINIAO_TEST_EPHEMERAL: '1', ZINIAO_INSTANCE_ID: instanceId, ZINIAO_BIND: '127.0.0.1', ZINIAO_SEED: '0', ZINIAO_WATCH_DIR: root }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = ''; child.stderr.on('data', value => { stderr += value; });
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('启动超时 ' + stderr)), 20000);
        child.on('message', message => { if (message.instanceId === instanceId && message.type === 'listening') { clearTimeout(timeout); resolve(message.port); } });
        child.once('exit', code => { clearTimeout(timeout); reject(Error('启动退出 ' + code + stderr)); });
    });
    const base = `http://127.0.0.1:${port}`;
    async function post(url, value, headers = {}) {
        const response = await fetch(base + url, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(value) });
        return { status: response.status, body: await response.json() };
    }
    const identity = { pluginInstanceId: 'fixture-instance', storeId: 'temu:123456', mallId: '123456', storeName: '测试店铺', pageStoreName: '测试店铺', pluginVersion: '10.10.59', pluginDetected: true, identityMatched: true, executionMode: 'plugin-api', schedulingProtocol: 1 };
    assert.equal((await post('/api/agents/register', identity)).status, 200);
    const packet = { kind: 'full-capture-packet', source: { sourceStoreId: identity.storeId, pluginInstanceId: identity.pluginInstanceId, pageStoreName: identity.pageStoreName },
        products: [{ spuId: '6000000001' }], records: [{ payload: { result: { pageItems: [{ productId: '6000000001', productName: '合成商品', extCode: 'fixture' }] } } }] };
    const payload = { packet, fileName: 'fixture.json', transferIntegrity: transferManifest(packet) };
    const input = { ...identity, requestId: crypto.randomUUID(), sha256: payload.transferIntegrity.sha256, bytes: Buffer.byteLength(JSON.stringify(payload)) };
    const denied = await post('/api/ingest/prepare', { ...input, storeId: 'temu:999999' });
    assert.equal(denied.status, 403);
    const prepared = await post('/api/ingest/prepare', input);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body)); assert.equal(prepared.body.state, 'ready');
    const uploaded = await post('/api/ingest', payload, { 'x-ingest-permit': prepared.body.token, 'x-plugin-instance': identity.pluginInstanceId });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body)); assert.equal(uploaded.body.transferIntegrity.verified, true);
    const queried = await post('/api/ingest/prepare', input);
    assert.equal(queried.body.state, 'completed'); assert.equal(queried.body.receipt.batchId, uploaded.body.batchId);
    const reusedPermit = await post('/api/ingest', payload, { 'x-ingest-permit': prepared.body.token, 'x-plugin-instance': identity.pluginInstanceId });
    assert.equal(reusedPermit.status, 409); assert.equal(reusedPermit.body.scheduling.action, 'wait');
    const [[count]] = await db.query('query', 'SELECT COUNT(*) AS n FROM hub_products'); assert.equal(Number(count.n), 1);
    success = true; console.log(JSON.stringify({ passed: true, preparedUpload: true, receiptLookup: true, duplicatePermitDenied: true, wrongSourceDenied: true, realPlatformRequests: 0 }));
} finally {
    if (child && child.exitCode === null) { const closed = new Promise(resolve => child.once('exit', resolve)); child.kill(); await closed; }
    await db.close(); if (success) await admin.query(`DROP DATABASE ${name}`); else console.error('保留隔离测试库', name);
    await admin.end();
}
