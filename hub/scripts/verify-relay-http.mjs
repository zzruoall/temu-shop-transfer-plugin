/** 隔离HTTP闭环：不向真实平台提交，不读取生产凭证，核对传输与店铺状态的保留边界。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { transferManifest, verifyTransferManifest } from '../lib/transfer-integrity.mjs';
import { createUsers } from '../lib/users.mjs';
import { createStore } from '../lib/store.mjs';
import { legacyFailureBody, snapshotRelayPersistence } from './verify-product-failure-retired.mjs';

test('实际HTTP收存发送，失败回执停用且零写入，保留历史红标、人工解除、认证隔离和状态更新', { timeout: 30000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-relay-http-'));
    const token = 'relay-http-isolated-token', instance = randomUUID();
    // 云端分支使用真正的本地会话与认领接口，不用设备令牌冒充普通用户。
    let credentialPath = '', aliceCookie = '', bobCookie = '';
    const pluginToken = `pt_${randomUUID().replaceAll('-', '')}`;
    if (process.argv.includes('--cloud')) {
        credentialPath = path.join(root, 'credentials.json');
        await writeFile(credentialPath, JSON.stringify({ deviceToken: token }));
        const users = createUsers(root);
        const alice = await users.register({ username: '13800000001', password: 'isolated-password' });
        const bob = await users.register({ username: '13800000002', password: 'isolated-password' });
        aliceCookie = `temu_session=${(await users.signSession(alice.id)).value}`;
        bobCookie = `temu_session=${(await users.signSession(bob.id)).value}`;
        await writeFile(path.join(root, 'plugin-tokens.json'), JSON.stringify({ [pluginToken]: {
            instanceId: 'relay-test-instance', issuedAt: Date.now(), disabled: false } }));
    }
    let admin, database, databaseName, mysqlConfig = '';
    if (process.argv.includes('--mysql')) {
        // Linux发布验收可显式使用本机socket，始终新建随机隔离库，绝不继承生产库名或凭证。
        const socketPath = process.env.TEMU_TEST_MYSQL_SOCKET;
        if (socketPath) assert.equal(socketPath, '/var/run/mysqld/mysqld.sock');
        const testMysql = socketPath ? { socketPath, user: 'root' } : { host: '127.0.0.1', port: 33917, user: 'root' };
        const mysql = (await import('mysql2/promise')).default;
        admin = await mysql.createConnection(testMysql);
        databaseName = `temu_relay_${Date.now()}`;
        await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        mysqlConfig = path.join(root, 'mysql.json');
        await writeFile(mysqlConfig, JSON.stringify({ ...testMysql, database: databaseName }));
        database = await (await import('../lib/mysql-database.mjs')).openMysqlDatabase(mysqlConfig);
        await (await import('../lib/mysql-schema.mjs')).initializeMysqlSchema(database);
        await database.query('maintenance', "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    }
    const child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true,
        env: { ...process.env, TEMU_CREDENTIALS: credentialPath, TEMU_BASE_PATH: '', TEMU_MYSQL_CONFIG: mysqlConfig,
            ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024),
            ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_PORT: '18380',
            ZINIAO_TEST_EPHEMERAL: '1', ZINIAO_INSTANCE_ID: instance, ZINIAO_INGEST_TOKEN: token, ZINIAO_SEED: '0' } });
    let output = '';
    child.stdout.on('data', value => { output += value; });
    child.stderr.on('data', value => { output += value; });
    const eventsAbort = new AbortController();
    try {
        const [{ port, instanceId }] = await Promise.race([once(child, 'message'),
            once(child, 'exit').then(([code]) => { throw Error(`服务退出${code}: ${output}`); })]);
        assert.equal(instanceId, instance);
        const origin = `http://127.0.0.1:${port}`;
        const api = async (url, body, options = {}) => {
            const response = await fetch(origin + url, { signal: options.signal || AbortSignal.timeout(16000),
                ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
                headers: { 'content-type': 'application/json', ...(options.cookie ? { cookie: options.cookie } : { authorization: `Bearer ${options.token || token}` }) } });
            return { status: response.status, body: await response.json() };
        };
        const agent = { pluginInstanceId: 'relay-test-instance', storeId: 'temu:222', mallId: '222',
            storeName: '目标验证店', pageStoreName: '目标验证店', pluginVersion: '11.0.4',
            executionMode: 'plugin-api', pluginDetected: true, identityMatched: true,
            relayProtocol: 1, relaySessionId: randomUUID() };
        assert.equal((await api('/api/agents/register', agent)).status, 200);
        const directory = (await api('/api/agents')).body.agents;
        assert.equal(directory.length, 1);
        assert.equal(directory[0].online, true);
        assert.equal(directory[0].identityMatched, true);
        assert.equal(directory[0].storeId, agent.storeId);
        const initialLive = (await api('/api/live')).body;
        assert.equal(typeof initialLive.agents, 'string');
        const heartbeat = await api('/api/agents/register', { ...agent, expectedCount: 100,
            completedCount: 20, capturePhase: 'running', ingestPhase: 'running', pendingUploadCount: 5 });
        assert.equal(heartbeat.status, 200);
        for (const field of ['expectedCount', 'completedCount', 'capturePhase', 'ingestPhase', 'pendingUploadCount']) {
            assert.equal(Object.hasOwn(heartbeat.body.agent, field), false, '连接登记不能存储或暴露任务统计');
        }
        assert.deepEqual((await api('/api/live')).body, initialLive, '无状态变化的心跳不能触发界面重绘');
        assert.equal((await api('/api/stores?view=online')).status, 200, '店铺认领列表仍可访问');
        if (aliceCookie) {
            const claims = await api('/api/stores/claim', { storeIds: ['temu:111', agent.storeId] }, { cookie: aliceCookie });
            assert.equal(claims.status, 200, JSON.stringify(claims.body));
            assert.equal(claims.body.claimedCount, 2);
            const mine = await api('/api/stores?view=mine', undefined, { cookie: aliceCookie });
            assert.ok(mine.body.stores.some(store => store.storeId === agent.storeId && store.claimState === 'mine'));
            assert.equal((await api('/api/stores/claim', { storeId: agent.storeId }, { cookie: bobCookie })).status, 409);
            assert.equal((await api('/api/agents/register', { ...agent, userId: 'forged' }, { cookie: bobCookie })).status, 403);
        }

        const source = { productId: '1234567890', productName: '任意结构商品', custom: { arbitrary: [null, 0, false] } };
        const packet = { kind: 'full-capture-packet', schemaVersion: 5,
            source: { sourceStoreId: 'temu:111', shopName: '来源验证店' },
            products: [{ spuId: source.productId }], records: [{ dataType: 'product-detail',
                identity: { productIds: [source.productId] },
                source: { pageProductId: source.productId, requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
                payload: { success: true, result: source } }] };
        const imported = await api('/api/ingest', { packet, transferIntegrity: transferManifest(packet) });
        assert.equal(imported.status, 200, JSON.stringify(imported.body));
        assert.equal(imported.body.transferIntegrity.verified, true);
        if (aliceCookie) {
            const forged = await api('/api/ingest', { packet, pluginInstanceId: agent.pluginInstanceId,
                transferIntegrity: transferManifest(packet) }, { token: pluginToken });
            assert.equal(forged.status, 403, '目标店的插件凭证不能上传到来源店');
            const matchedPacket = { ...packet, source: { ...packet.source, sourceStoreId: agent.storeId,
                pluginInstanceId: agent.pluginInstanceId, pageStoreName: agent.pageStoreName },
                products: [{ spuId: '1234567999' }], records: [{ ...packet.records[0],
                    identity: { productIds: ['1234567999'] }, source: { ...packet.records[0].source, pageProductId: '1234567999' },
                    payload: { success: true, result: { ...source, productId: '1234567999' } } }] };
            const legal = await api('/api/ingest', { packet: matchedPacket,
                transferIntegrity: transferManifest(matchedPacket) }, { token: pluginToken });
            assert.equal(legal.status, 200, JSON.stringify(legal.body));
        }
        const sendBody = { sourceStoreId: 'temu:111', sourceBatchId: imported.body.batchId,
            targetStoreId: agent.storeId, spuIds: [source.productId] };
        if (aliceCookie) {
            assert.equal((await api('/api/relay/send', { ...sendBody, userId: 'forged' }, { cookie: bobCookie })).status, 403);
            assert.equal((await api('/api/overview?productLimit=20', undefined, { cookie: bobCookie })).body.productCount, 0);
        }
        const savedJobs = async () => database ? (await database.query('maintenance', 'SELECT * FROM hub_jobs'))[0]
            : await readFile(path.join(root, 'data/jobs.json'), 'utf8');
        const oldState = await savedJobs();
        const receiver = api('/api/jobs/claim', agent);
        const sent = await api('/api/relay/send', sendBody, { cookie: aliceCookie });
        assert.equal(sent.status, 200, JSON.stringify(sent.body));
        assert.equal(sent.body.sent, 1);
        assert.equal(sent.body.deliveryConfirmed, false);
        const received = await receiver;
        assert.equal(received.status, 200);
        assert.equal(received.body.claimed.length, 1);
        const task = received.body.claimed[0];
        assert.equal(Object.hasOwn(task, 'failureGrant'), false, '下发不得携带失败回执授权');
        assert.equal(verifyTransferManifest(task.snapshot, task.transferIntegrity), true);
        assert.deepEqual(task.snapshot.publicationData.sourceProduct, source);
        assert.deepEqual(await savedJobs(), oldState, '发送不能保存上架运行状态');
        for (const url of ['/api/jobs/report', '/api/jobs/direct-progress', '/api/jobs/execution-run', '/api/jobs/target-task-states']) {
            assert.equal((await api(url, agent)).status, 404, `旧执行接口仍存在:${url}`);
        }
        const nextReceiver = api('/api/jobs/claim', agent);
        const manualSendId = randomUUID();
        const again = await api('/api/relay/send', { ...sendBody, manualSendId }, { cookie: aliceCookie });
        assert.equal(again.body.sent, 1, '再次人工发送同一商品不受历史任务阻止');
        const nextTask = (await nextReceiver).body.claimed[0];
        assert.equal(Object.hasOwn(nextTask, 'failureGrant'), false);
        assert.notEqual(nextTask.jobId, task.jobId);
        assert.equal(nextTask.jobId, manualSendId, '同一次人工点击的分段标识必须原样传到插件');
        // 隔离库通过存储层预置停用前历史红标；服务端不得因旧请求新增、覆盖或清理标记。
        await createStore(root, { database }).markProductBlocked({ storeId: sendBody.sourceStoreId,
            spuId: source.productId, sourceBatchId: imported.body.batchId, reason: '历史平台拒绝：净含量不能为空' });
        const failureBody = legacyFailureBody(token, { ...task, snapshot: undefined, transferIntegrity: undefined,
            pluginInstanceId: agent.pluginInstanceId });
        const notifierAuth = aliceCookie ? { token: pluginToken } : {};
        const beforeFailure = (await api('/api/live', undefined, { cookie: aliceCookie })).body;
        const marked = (await api('/api/overview?productLimit=20&blocked=blocked')).body;
        const red = marked.products.find(product => product.spuIds.includes(source.productId));
        assert.ok(red?.blocked, JSON.stringify(marked));
        assert.match(red.blockedReason, /净含量/);
        assert.ok((await api(`/api/products/${source.productId}`)).body.product.blocked, '详情与商品列表的标记必须一致');
        const persistenceBefore = await snapshotRelayPersistence(root, database);
        const notices = await Promise.all([
            failureBody, { ...failureBody, failureGrant: failureBody.failureGrant + 'x' },
            { ...failureBody, pluginInstanceId: 'wrong-instance' }, { ...failureBody, kind: 'duplicate_exists' },
            { ...failureBody, sourceStoreId: 'temu:444' }, {},
            ...Array.from({ length: 8 }, () => ({ ...failureBody, reason: '其他传输稍后失败' }))
        ].map(body => api('/api/products/failure', body, notifierAuth)));
        if (bobCookie) notices.push(await api('/api/products/failure', failureBody, { cookie: bobCookie }));
        for (const result of notices) {
            assert.equal(result.status, 410, JSON.stringify(result));
            assert.equal(result.body.error, 'product_failure_retired');
        }
        if (aliceCookie) {
            assert.equal((await api('/api/products/failure', failureBody, { token: 'invalid-token' })).status, 401);
            for (const url of ['/api/overview', '/api/live', '/api/events']) {
                assert.equal((await api(url, undefined, { token: pluginToken })).status, 403, '插件令牌不能读取用户库存或状态');
            }
            assert.equal((await api('/api/products/unblock', { spuIds: [source.productId] }, notifierAuth)).status, 403);
            assert.equal((await api('/api/relay/send', sendBody, notifierAuth)).status, 403, '插件令牌不能获得人工下发权限');
            const deniedUnblock = await api('/api/products/unblock', { spuIds: [source.productId] }, { cookie: bobCookie });
            assert.equal(deniedUnblock.status, 200);
            assert.equal(deniedUnblock.body.cleared, 0, '其他用户不能解除来源店的历史红标');
        }
        assert.deepEqual(await snapshotRelayPersistence(root, database), persistenceBefore, '旧失败请求及越权操作不能写任何文件或数据库表');
        assert.deepEqual((await api('/api/live', undefined, { cookie: aliceCookie })).body, beforeFailure, '停用回执不能触发状态版本变化');
        assert.deepEqual((await api('/api/overview?productLimit=20&blocked=blocked')).body.products, marked.products, '历史原因与时间必须保留');
        assert.deepEqual(await savedJobs(), oldState, '停用回执不保存上架运行状态');
        const redSkipped = await api('/api/relay/send', sendBody, { cookie: aliceCookie });
        assert.equal(redSkipped.body.sent, 0, '历史红标与新版通知一样阻止发送');
        assert.equal(redSkipped.body.skippedBlocked.length, 1);
        const unblocked = await api('/api/products/unblock', { spuIds: [source.productId] }, { cookie: aliceCookie });
        assert.equal(unblocked.status, 200);
        assert.equal(unblocked.body.cleared, 1, '人工解除历史红标仍有效');
        const redReceiver = api('/api/jobs/claim', agent);
        assert.equal((await api('/api/relay/send', sendBody, { cookie: aliceCookie })).body.sent, 1, '解除之后允许重新人工发送');
        const manualRetry = (await redReceiver).body.claimed[0];
        assert.equal(Object.hasOwn(manualRetry, 'failureGrant'), false);
        const afterUnblock = await snapshotRelayPersistence(root, database);
        assert.equal((await api('/api/products/failure', failureBody, notifierAuth)).status, 410);
        assert.deepEqual(await snapshotRelayPersistence(root, database), afterUnblock, '人工解除后旧回执不能重新标红或推进代次');
        const recaptured = structuredClone(packet);
        recaptured.records[0].payload.result.productName = '新采集资料';
        const recaptureResult = await api('/api/ingest', { packet: recaptured, transferIntegrity: transferManifest(recaptured) });
        assert.equal(recaptureResult.status, 200);
        assert.equal((await api('/api/overview?productLimit=20&blocked=blocked')).body.products.length, 0, '更新采集资料解除旧红标');
        const afterRecapture = await snapshotRelayPersistence(root, database);
        assert.equal((await api('/api/products/failure', failureBody, notifierAuth)).status, 410);
        assert.deepEqual(await snapshotRelayPersistence(root, database), afterRecapture, '迟到回执不能改写新采集版本');
        // 从真实长连接读取通知，避免仅检查版本接口就误认自动更新链路已接通。
        const eventsResponse = await fetch(origin + '/api/events', {
            headers: aliceCookie ? { cookie: aliceCookie } : { authorization: `Bearer ${token}` },
            signal: AbortSignal.any([eventsAbort.signal, AbortSignal.timeout(12000)])
        });
        assert.equal(eventsResponse.status, 200);
        const reader = eventsResponse.body.getReader(), decoder = new TextDecoder();
        let eventBuffer = '';
        async function nextLive(matches = () => true) {
            while (true) {
                const boundary = eventBuffer.indexOf('\n\n');
                if (boundary < 0) {
                    const chunk = await reader.read();
                    assert.equal(chunk.done, false, '状态通知不能提前断开');
                    eventBuffer += decoder.decode(chunk.value, { stream: true });
                    continue;
                }
                const lines = eventBuffer.slice(0, boundary).split('\n');
                eventBuffer = eventBuffer.slice(boundary + 2);
                if (!lines.includes('event: live')) continue;
                const value = JSON.parse(lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'));
                if (matches(value)) return value;
            }
        }
        const firstEvent = await nextLive();
        const freshReceiver = api('/api/jobs/claim', agent);
        assert.equal((await api('/api/relay/send', { ...sendBody, sourceBatchId: recaptureResult.body.batchId }, { cookie: aliceCookie })).body.sent, 1);
        const freshTask = (await freshReceiver).body.claimed[0];
        assert.equal(Object.hasOwn(freshTask, 'failureGrant'), false);
        assert.equal(verifyTransferManifest(freshTask.snapshot, freshTask.transferIntegrity), true);
        const beforeUnknown = await snapshotRelayPersistence(root, database);
        assert.equal((await api('/api/products/failure', { ...failureBody,
            kind: 'unknown', reason: '网络中断，平台结果尚未确认' }, notifierAuth)).status, 410);
        const unknownView = (await api('/api/overview?productLimit=20&blocked=blocked')).body.products;
        assert.equal(unknownView.length, 0, '停用回执不能给正常商品新增红标');
        const afterUnknown = (await api('/api/live', undefined, { cookie: aliceCookie })).body;
        assert.deepEqual(afterUnknown, firstEvent, '停用回执不能更新 SSE 的状态快照');
        assert.deepEqual(await snapshotRelayPersistence(root, database), beforeUnknown);
        const lastUnblock = await api('/api/products/unblock', { spuIds: [source.productId] }, { cookie: aliceCookie });
        assert.equal(lastUnblock.body.cleared, 0, '重复人工解除仍是幂等操作');
        const newPage = { ...agent, relaySessionId: randomUUID() };
        await api('/api/agents/register', newPage);
        assert.equal((await api('/api/jobs/claim', agent)).status, 409, '旧页面不能接收刷新后新任务');
        await api('/api/agents/register', { ...newPage, identityMatched: false });
        assert.notEqual((await api('/api/live')).body.agents, initialLive.agents, '身份变化仍自动通知商品库');
        await nextLive(value => value.agents !== firstEvent.agents);
        assert.equal((await api('/api/relay/send', sendBody)).status, 409, '身份错配不能跨店发送');
        const overview = await api('/api/overview?productLimit=20');
        assert.equal(overview.body.productCount, aliceCookie ? 2 : 1);
        const beforeOffline = (await api('/api/live')).body;
        const expiredAt = new Date(Date.now() - 10 * 60000).toISOString();
        // 仅修改本脚本生成的隔离目录或随机数据库，模拟停止心跳而不等待真实十分钟。
        if (database) await database.query('maintenance', "UPDATE hub_agents SET body=JSON_SET(body,'$.lastSeenAt',?) WHERE store_id=?", [expiredAt, agent.storeId]);
        else {
            const file = path.join(root, 'data/jobs.json');
            const state = JSON.parse(await readFile(file, 'utf8'));
            for (const item of state.agents) if (item.storeId === agent.storeId) item.lastSeenAt = expiredAt;
            await writeFile(file, JSON.stringify(state));
        }
        const offline = (await api('/api/agents')).body.agents.find(item => item.storeId === agent.storeId);
        assert.equal(offline.online, false, '停止心跳仍按原规则显示离线');
        assert.notEqual((await api('/api/live')).body.agents, beforeOffline.agents, '在线到离线的摘要仍通知商品库');
        if (aliceCookie) {
            const claimsBefore = (await api('/api/live', undefined, { cookie: aliceCookie })).body;
            assert.equal((await api('/api/stores/release', { storeId: agent.storeId }, { cookie: aliceCookie })).status, 200);
            const afterRelease = await snapshotRelayPersistence(root, database);
            assert.equal((await api('/api/products/failure', failureBody, notifierAuth)).status, 410, '解绑后旧回执仍停用');
            assert.deepEqual(await snapshotRelayPersistence(root, database), afterRelease);
            const claimsAfter = (await api('/api/live', undefined, { cookie: aliceCookie })).body;
            assert.notEqual(claimsAfter.claims, claimsBefore.claims);
            assert.notEqual(claimsAfter.directory, claimsBefore.directory);
            await nextLive(value => value.claims === claimsAfter.claims && value.directory === claimsAfter.directory);
            assert.equal((await api('/api/stores/claim', { storeId: agent.storeId }, { cookie: aliceCookie })).status, 200);
            const afterReclaim = await snapshotRelayPersistence(root, database);
            assert.equal((await api('/api/products/failure', failureBody, notifierAuth)).status, 410,
                '同账号重新认领也不能复活停用回执');
            assert.deepEqual(await snapshotRelayPersistence(root, database), afterReclaim);
        }
    } catch (error) {
        error.message += `\n${output.slice(-2000)}`;
        throw error;
    } finally {
        eventsAbort.abort();
        if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
        await database?.close();
        if (admin) { await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); }
        // 只删除本脚本创建的系统临时目录，绝不操作共享库存目录。
        assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
        await rm(root, { recursive: true, force: true });
    }
});
