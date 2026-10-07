/** 新错误通知通过真实 HTTP 和真实库存验收；平台、账户和数据库均为本脚本隔离数据。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { transferManifest } from '../lib/transfer-integrity.mjs';
import { createUsers } from '../lib/users.mjs';

test('错误通知真实闭环：权限、首次标记、并发去重、实际禁传、解除代次、删除重传', { timeout: 45000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-error-http-'));
    const token = randomUUID(), pluginInstanceId = 'notice-http-plugin', pluginToken = `pt_${randomUUID().replaceAll('-', '')}`;
    const users = createUsers(root);
    const user = await users.register({ username: '13800001001', password: 'isolated-password' });
    const other = await users.register({ username: '13800001002', password: 'isolated-password' });
    const cookie = `temu_session=${(await users.signSession(user.id)).value}`;
    const otherCookie = `temu_session=${(await users.signSession(other.id)).value}`;
    const credentials = path.join(root, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ deviceToken: token }));
    await writeFile(path.join(root, 'plugin-tokens.json'), JSON.stringify({ [pluginToken]: { instanceId: pluginInstanceId, issuedAt: Date.now(), disabled: false } }));
    let admin, database, databaseName, mysqlConfig = '';
    if (process.argv.includes('--mysql')) {
        // 固定回环端口、随机库；不读取部署配置，故障也不得落入生产数据库。
        admin = await (await import('mysql2/promise')).createConnection({ host: '127.0.0.1', port: 33917, user: 'root', connectTimeout: 1500 });
        databaseName = `temu_error_http_${Date.now()}_${process.pid}`;
        await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        mysqlConfig = path.join(root, 'mysql.json');
        await writeFile(mysqlConfig, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: databaseName }));
        database = await (await import('../lib/mysql-database.mjs')).openMysqlDatabase(mysqlConfig);
        await (await import('../lib/mysql-schema.mjs')).initializeMysqlSchema(database);
        await database.query('maintenance', "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    }
    const child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true,
        env: { ...process.env, TEMU_CREDENTIALS: credentials, TEMU_BASE_PATH: '', TEMU_MYSQL_CONFIG: mysqlConfig,
            ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_PORT: '18380', ZINIAO_TEST_EPHEMERAL: '1',
            ZINIAO_INSTANCE_ID: randomUUID(), ZINIAO_SEED: '0', ZINIAO_INGEST_TOKEN: token, ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024) } });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    try {
        const [{ port }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw Error(`启动失败 ${code}: ${output}`); })]);
        const origin = `http://127.0.0.1:${port}`;
        const api = async (url, body, auth = 'user', method = 'POST') => {
            const response = await fetch(origin + url, { signal: AbortSignal.timeout(18000),
                ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
                headers: { 'content-type': 'application/json', ...(auth === 'user' || auth === 'other'
                    ? { cookie: auth === 'user' ? cookie : otherCookie } : { authorization: `Bearer ${auth === 'plugin' ? pluginToken : token}` }) } });
            return { status: response.status, body: await response.json() };
        };
        const sourceStoreId = 'temu:111', spuId = '1234567890';
        const agent = { storeId: 'temu:222', mallId: '222', pluginInstanceId, storeName: '隔离目标店', pageStoreName: '隔离目标店',
            pluginVersion: '10.10.72', executionMode: 'plugin-api', pluginDetected: true, identityMatched: true,
            relayProtocol: 1, relaySessionId: randomUUID() };
        assert.equal((await api('/api/agents/register', agent, 'device')).status, 200);
        assert.equal((await api('/api/stores/claim', { storeIds: [sourceStoreId, agent.storeId] })).status, 200);
        const source = { productId: spuId, productName: '隔离商品', extCode: 'TEST-CODE-01', arbitrary: { n: 0, list: [null, false] } };
        const packet = { kind: 'full-capture-packet', schemaVersion: 5, source: { sourceStoreId }, products: [{ spuId }],
            records: [{ dataType: 'product-detail', identity: { productIds: [spuId] },
                source: { pageProductId: spuId, requestUrl: 'https://example.invalid/visage-agent-seller/product/query' }, payload: { success: true, result: source } }] };
        const ingest = async () => {
            const result = await api('/api/ingest', { packet, transferIntegrity: transferManifest(packet) }, 'device');
            assert.equal(result.status, 200, JSON.stringify(result)); return result.body.batchId;
        };
        let sourceBatchId = await ingest();
        const sendBody = () => ({ sourceStoreId, sourceBatchId, targetStoreId: agent.storeId, spuIds: [spuId] });
        const deliver = async () => {
            const receive = api('/api/jobs/claim', agent, 'plugin');
            const sent = await api('/api/relay/send', sendBody());
            assert.equal(sent.status, 200, JSON.stringify(sent)); assert.equal(sent.body.sent, 1);
            const result = await receive;
            assert.equal(result.status, 200, JSON.stringify(result));
            const item = result.body.claimed[0]; assert.ok(item.noticeToken); assert.equal(item.deliveryOwners, undefined);
            const authorization = JSON.parse(Buffer.from(item.noticeToken.split('.')[0], 'base64url'));
            assert.equal(Object.hasOwn(authorization, 'productCodes'), false, '展示货号不能扩大签名授权或撑大凭证');
            assert.equal(Object.hasOwn(authorization, 'sendBlocked'), false);
            return item;
        };
        let task = await deliver();
        const notice = (overrides = {}) => ({ pluginInstanceId, noticeToken: task.noticeToken, eventId: randomUUID(),
            errorScope: 'product_data', errorCode: 'PRODUCT_SKU_INVALID', errorStage: '提交',
            reason: 'SKU TEST-SKU-1 包装重量必须大于0', offendingSkuCode: 'TEST-SKU-1', ...overrides });
        const view = async () => (await api('/api/overview?productLimit=20')).body.products.find(p => p.spuIds.includes(spuId));
        const originalIdentity = (await view()).sourceIdentity;
        assert.match(originalIdentity, /^[a-f0-9]{64}$/);
        const statusBody = { products: [{ spuId, sourceIdentity: originalIdentity, productKey: (await view()).productKey }] };
        const statusRead = () => api('/api/products/status-read', statusBody);
        assert.equal((await statusRead()).body.products[0].sendBlocked, false);
        assert.deepEqual((await api('/api/products/status-read', statusBody, 'other')).body, { products: [], staleIds: [spuId] });
        assert.equal((await api('/api/products/status-read', statusBody, 'plugin')).status, 403);
        for (const invalid of [{ products: [] }, { products: Array(101).fill(statusBody.products[0]) },
            { products: [...statusBody.products, ...statusBody.products] }, { products: [{ spuId, sourceIdentity: 'bad' }] },
            { ...statusBody, role: 'admin' }, { products: [{ ...statusBody.products[0], blocked: true }] }]) {
            assert.equal((await api('/api/products/status-read', invalid)).status, 400);
        }
        assert.equal((await view()).sendBlocked, false);
        assert.equal((await api('/api/products/error-notice', notice({ errorScope: 'transport', errorCode: '429' }), 'plugin')).body.status, 'not_product_error');
        assert.equal((await api('/api/products/error-notice', notice({ errorCode: '2000135' }), 'plugin')).body.status, 'not_product_error', '未经核实的数字平台码不能禁传');
        assert.equal((await api('/api/products/error-notice', notice({ pluginInstanceId: 'wrong' }), 'plugin')).status, 403);
        assert.equal((await api('/api/products/error-notice', notice({ noticeToken: task.noticeToken + 'x' }), 'plugin')).status, 403);
        assert.equal((await api('/api/products/error-notice', notice({ amount: 1 }), 'plugin')).status, 400);
        assert.equal((await api('/api/products/error-notice', notice(), 'other')).status, 403);
        // 从真实接收取得授权，验证数字平台拒绝能标红且保留原始码；解除后使用新授权，不绕过生命周期。
        for (const entry of [{ errorCode: '2000135', reason: '当前类目净含量必填' },
            { errorCode: '2000225', reason: '化妆品成分不存在，请删除：Mentha Piperita (Peppermint) Extract' }]) {
            assert.equal((await api('/api/products/error-notice', notice(entry), 'plugin')).body.status, 'marked');
            assert.equal((await view()).sendBlocked, true);
            const state = (await statusRead()).body.products[0];
            assert.equal(state.sourceIdentity, originalIdentity);
            assert.equal(state.blocked, true); assert.equal(state.errorNotice.summary, entry.reason);
            assert.doesNotMatch(JSON.stringify(state), /publicationData|sourceProduct|images|noticeToken/);
            const url = `/api/products/error-details?${new URLSearchParams({ sourceStoreId, spuId, sourceInstanceId: task.sourceNoticeRef.sourceInstanceId })}`;
            const details = await api(url); assert.equal(details.body.notice.code, entry.errorCode);
            assert.equal(details.body.notice.reason, entry.reason);
            assert.equal((await api('/api/relay/send', sendBody())).body.sent, 0);
            assert.equal((await api('/api/products/error-unblock', { sourceStoreId, spuIds: [spuId],
                sourceInstanceIds: [task.sourceNoticeRef.sourceInstanceId], noticeEpochs: [task.sourceNoticeRef.noticeEpoch] })).body.cleared, 1);
            task = await deliver();
            assert.equal((await statusRead()).body.products[0].sendBlocked, false);
        }
        const marks = await Promise.all(Array.from({ length: 5 }, () => api('/api/products/error-notice', notice(), 'plugin')));
        assert.equal(marks.filter(result => result.body.status === 'marked').length, 1, JSON.stringify(marks));
        assert.equal(marks.filter(result => result.body.status === 'already_marked').length, 4);
        const markedRow = await view(); assert.equal(markedRow.sendBlocked, true); assert.match(markedRow.errorNotice.summary, /包装重量/);
        assert.equal((await api('/api/overview?productLimit=20&blocked=blocked')).body.blockedCount, 1);
        const detailUrl = `/api/products/error-details?${new URLSearchParams({ sourceStoreId, spuId, sourceInstanceId: task.sourceNoticeRef.sourceInstanceId })}`;
        const details = await api(detailUrl); assert.equal(details.status, 200); assert.equal(details.body.notice.skuCode, 'TEST-SKU-1');
        assert.equal((await api(detailUrl, undefined, 'other')).status, 403);
        assert.equal((await api(detailUrl, undefined, 'plugin')).status, 403);
        const before = (await api('/api/live')).body;
        assert.equal((await api('/api/products/error-notice', notice({ reason: '不能覆盖首次原因' }), 'plugin')).body.status, 'already_marked');
        assert.deepEqual((await api(detailUrl)).body, details.body); assert.deepEqual((await api('/api/live')).body, before);
        const skipped = await api('/api/relay/send', sendBody());
        assert.equal(skipped.body.sent, 0); assert.equal(skipped.body.skippedBlocked.length, 1);
        assert.doesNotMatch(JSON.stringify(skipped.body), /noticeToken|owners|sourceProduct/);
        const unblock = { sourceStoreId, spuIds: [spuId], sourceInstanceIds: [task.sourceNoticeRef.sourceInstanceId], noticeEpochs: [task.sourceNoticeRef.noticeEpoch] };
        assert.equal((await api('/api/products/error-unblock', { sourceStoreId, spuIds: [spuId] })).status, 400);
        assert.equal((await api('/api/products/error-unblock', unblock, 'plugin')).status, 403);
        assert.equal((await api('/api/products/error-unblock', unblock)).body.cleared, 1);
        assert.equal((await api('/api/products/error-notice', notice(), 'plugin')).body.status, 'stale_or_deleted');
        const oldTask = task; task = await deliver();
        assert.equal((await api('/api/products/error-notice', notice(), 'plugin')).body.status, 'marked');
        assert.equal((await api('/api/products/error-unblock', unblock)).body.cleared, 0, '旧页面不能解除新一轮标记');
        const removed = await api('/api/products', { spuIds: [spuId], storeIds: [sourceStoreId] }, 'user', 'DELETE');
        assert.equal(removed.status, 200, JSON.stringify(removed));
        assert.deepEqual((await statusRead()).body, { products: [], staleIds: [spuId] });
        assert.equal((await api('/api/products/error-notice', notice(), 'plugin')).body.status, 'stale_or_deleted');
        sourceBatchId = await ingest();
        const freshTask = await deliver();
        assert.notEqual(freshTask.sourceNoticeRef.sourceInstanceId, oldTask.sourceNoticeRef.sourceInstanceId);
        assert.equal((await view()).sendBlocked, false);
        assert.notEqual((await view()).sourceIdentity, originalIdentity);
        assert.deepEqual((await statusRead()).body, { products: [], staleIds: [spuId] }, '旧选择不能读取重导商品的状态');
        assert.equal((await api('/api/products/error-notice', notice(), 'plugin')).body.status, 'stale_or_deleted');
        task = freshTask;
        // 归属回到同一账户仍是新的认领代次，旧下发授权不能借此重新生效。
        assert.equal((await api('/api/stores/release', { storeId: agent.storeId })).status, 200);
        assert.equal((await api('/api/stores/claim', { storeId: agent.storeId })).status, 200);
        const oldOwnership = await api('/api/products/error-notice', notice(), 'plugin');
        assert.equal(oldOwnership.status, 409); assert.equal(oldOwnership.body.error, 'failure_source_changed');
        task = await deliver();
        assert.equal((await api('/api/products/error-notice', notice({ reason: '长'.repeat(1800), reasonTruncated: true }), 'plugin')).body.status, 'marked');
        const longDetails = await api(`/api/products/error-details?${new URLSearchParams({ sourceStoreId, spuId, sourceInstanceId: task.sourceNoticeRef.sourceInstanceId })}`);
        assert.equal(longDetails.body.notice.reason.length, 1000); assert.equal(longDetails.body.notice.truncated, true);
        await api('/api/agents/register', { ...agent, relaySessionId: randomUUID() }, 'device');
        assert.equal((await api('/api/products/error-notice', notice(), 'plugin')).status, 403, '刷新后的旧页面通知失效');
        assert.equal((await api('/api/agents')).body.agents[0].online, true);
        assert.equal((await api('/api/stores?view=mine')).body.stores.find(s => s.storeId === agent.storeId).claimState, 'mine');
    } catch (error) { error.message += `\n${output.slice(-2000)}`; throw error; }
    finally {
        if (child.exitCode === null && child.signalCode === null) { const done = once(child, 'exit'); child.kill(); await done; }
        await database?.close();
        if (admin) { await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); }
        assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
        await rm(root, { recursive: true, force: true });
    }
});
