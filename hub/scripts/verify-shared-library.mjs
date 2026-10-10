/** 真实 HTTP 的共享库与分类隔离回归；使用临时用户、店铺和商品，不访问生产或平台。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUsers } from '../lib/users.mjs';
import { createStoreOwnership } from '../lib/store-ownership.mjs';
import { createStore } from '../lib/store.mjs';
import { canDeleteCatalogProduct, projectCatalogPermissions } from '../lib/catalog-permissions.mjs';

test('删除权限逐来源投影，不接受未知来源或共享阅读范围冒充写权限', () => {
    const scope = new Set(['mine']);
    assert.equal(canDeleteCatalogProduct({ sourceStoreIds: ['mine'] }, scope), true);
    assert.equal(canDeleteCatalogProduct({ sourceStoreIds: ['other'] }, scope), false);
    assert.equal(canDeleteCatalogProduct({ sourceStoreIds: ['mine', 'other'] }, scope), false);
    assert.equal(canDeleteCatalogProduct({ sourceStoreIds: [] }, null), false);
    assert.equal(canDeleteCatalogProduct({}, scope), false);
    assert.equal(canDeleteCatalogProduct({ sourceStoreIds: [''] }, null), false);
    const original = { products: [{ sourceStoreIds: ['other'], canDelete: true }] };
    assert.equal(projectCatalogPermissions(original, scope).products[0].canDelete, false);
    assert.equal(original.products[0].canDelete, true, '只投影响应，不改原始采集记录');
});

test('共享来源、个人范围、测试正式隔离、目标店权限与迁移持久化', { timeout: 60000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-shared-library-'));
    let admin, database, databaseName, mysqlConfig = '';
    if (process.argv.includes('--mysql')) {
        // 只允许专用回环测试实例和随机库，严禁继承部署凭证或正式数据库配置。
        admin = await (await import('mysql2/promise')).createConnection({ host: '127.0.0.1', port: 33917, user: 'root', connectTimeout: 1500 });
        databaseName = `temu_library_${Date.now()}_${process.pid}`;
        assert.match(databaseName, /^temu_library_\d+_\d+$/);
        await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        mysqlConfig = path.join(root, 'mysql.json');
        await writeFile(mysqlConfig, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: databaseName }));
        database = await (await import('../lib/mysql-database.mjs')).openMysqlDatabase(mysqlConfig);
        await (await import('../lib/mysql-schema.mjs')).initializeMysqlSchema(database);
        await database.query('maintenance', "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    }
    const users = createUsers(root), ownership = createStoreOwnership(root, { database }), inventory = createStore(root, { database });
    const password = 'isolated-password';
    const a = await users.register({ username: '13810000001', password, accountType: 'test' });
    const b = await users.register({ username: '13810000002', password });
    const t = await users.register({ username: '13800000002', password });
    const t2 = await users.register({ username: '13800000003', password });
    const testAdmin = await users.register({ username: '13810000004', password });
    await users.setRole(a.id, 'admin');
    await users.setRole(testAdmin.id, 'admin');
    // admin 是存量账户而非可公开注册的手机号；仅在本测试生成的临时用户文件中构造迁移样本。
    const legacyUsers = await users.getState();
    legacyUsers.users.find(user => user.id === testAdmin.id).username = 'admin';
    await writeFile(path.join(root, 'users.json'), JSON.stringify(legacyUsers));
    const ids = ['temu:101', 'temu:102', 'temu:103', 'temu:104'];
    for (const [index, user] of [a, b, t, t2].entries()) await ownership.claim(ids[index], user, `来源${index}`);
    await ownership.claim('temu:201', b, '正式目标');
    await ownership.claim('temu:202', t2, '测试目标');
    const cookies = Object.fromEntries(await Promise.all([a, b, t, t2, testAdmin].map(async user => [user.id, `temu_session=${(await users.signSession(user.id)).value}`])));
    const spuId = '1234567890';
    const batches = [];
    for (const [index, sourceStoreId] of ids.entries()) {
        const productId = String(Number(spuId) + index);
        const packet = { kind: 'full-capture-packet', schemaVersion: 5, source: { sourceStoreId }, products: [{ spuId: productId }],
            records: [{ dataType: 'product-detail', identity: { productIds: [productId] },
                source: { pageProductId: productId, requestUrl: 'https://example.invalid/visage-agent-seller/product/query' },
                payload: { success: true, result: { productId, productName: `分类商品${index}`, extCode: 'SAME-CODE' } } }] };
        batches.push((await inventory.importFiles([{ originalName: `packet-${index}.json`, payload: packet }], { sourceStoreId })).batch);
    }
    await inventory.importFiles([{ originalName: 'legacy-unclaimed.json', payload: { kind: 'full-capture-packet', source: { sourceStoreId: 'temu:105' },
        records: [{ payload: { result: { pageItems: [{ productId: '1234567899', productName: '历史待归类商品' }] } } }] } }], { sourceStoreId: 'temu:105' });
    const token = randomUUID(), credentials = path.join(root, 'credentials.json');
    await writeFile(credentials, JSON.stringify({ deviceToken: token }));
    const child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true,
        env: { ...process.env, TEMU_CREDENTIALS: credentials, TEMU_MYSQL_CONFIG: mysqlConfig, TEMU_BASE_PATH: '',
            ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_TEST_EPHEMERAL: '1', ZINIAO_INSTANCE_ID: randomUUID(),
            ZINIAO_SEED: '0', ZINIAO_INGEST_TOKEN: token, ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024) } });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    try {
        const [{ port }] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw Error(`启动失败 ${code}: ${output}`); })]);
        const origin = `http://127.0.0.1:${port}`;
        const checkpoint = step => { if (process.argv.includes('--trace')) console.log(step); };
        const api = async (url, user = b, body, method = 'POST') => {
            const response = await fetch(origin + url, { signal: AbortSignal.timeout(15000),
                ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
                headers: { 'content-type': 'application/json', ...(user === 'device' ? { authorization: `Bearer ${token}` } : { cookie: cookies[user.id] }) } });
            return { status: response.status, body: await response.json() };
        };
        const registration = await fetch(origin + '/register', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username: '13930000001', password, confirm: password, accountType: 'test', role: 'admin' }) });
        assert.equal(registration.status, 303);
        const publicCookie = registration.headers.get('set-cookie').split(';')[0];
        const publicMe = await (await fetch(origin + '/api/me', { headers: { cookie: publicCookie } })).json();
        assert.equal(publicMe.user.accountType, 'production'); assert.equal(publicMe.user.role, 'user');
        checkpoint('public register');
        const shared = await api('/api/overview');
        assert.equal(shared.status, 200); assert.equal(shared.body.productCount, 2);
        assert.deepEqual(shared.body.products.flatMap(p => p.sourceStoreIds).sort(), ids.slice(0, 2));
        assert.equal(shared.body.products.find(p => p.sourceStoreIds.includes(ids[0])).canDelete, false);
        assert.equal(shared.body.products.find(p => p.sourceStoreIds.includes(ids[1])).canDelete, true);
        // 空来源元数据只由同 ID 目录补展示名；既有商品原包与正式/测试范围保持不变。
        assert.deepEqual(shared.body.batches.map(batch => batch.sourceStoreName).sort(), ['来源0', '来源1']);
        const namedPage = await api('/api/overview?productLimit=1');
        assert.equal(typeof namedPage.body.products[0].canDelete, 'boolean', '分页同样投影删除权限');
        assert.deepEqual(namedPage.body.sourceStores.map(item => item.storeName).sort(), ['来源0', '来源1']);
        assert.equal(JSON.stringify(shared.body).includes('来源2'), false);
        const personal = await api('/api/overview?library=personal');
        assert.equal(personal.body.productCount, 1); assert.deepEqual(personal.body.products[0].sourceStoreIds, [ids[1]]);
        assert.equal(personal.body.products[0].canDelete, true);
        assert.equal((await api('/api/overview?accountType=test')).body.productCount, 2, '普通用户不能用查询参数切入测试分类');
        assert.deepEqual((await api('/api/overview', t2)).body.products.flatMap(p => p.sourceStoreIds).sort(), ids.slice(2));
        // 管理员角色不等于默认查看正式数据；指定 admin 迁移后工作区仍只读测试分类。
        const adminMe = await api('/api/me', testAdmin);
        assert.equal(adminMe.body.user.accountType, 'test');
        assert.equal(adminMe.body.user.role, 'admin');
        assert.deepEqual((await api('/api/overview', testAdmin)).body.products.flatMap(p => p.sourceStoreIds).sort(), ids.slice(2));
        assert.equal((await api('/api/overview?library=personal', testAdmin)).body.productCount, 0, '未认领店铺的测试管理员个人库为空');
        for (const [index, sourceStoreId] of ids.entries()) {
            const result = await api(`/api/products/${Number(spuId) + index}?sourceStoreId=${sourceStoreId}`);
            assert.equal(result.status, ids.slice(0, 2).includes(sourceStoreId) ? 200 : 404);
            if (result.status === 200) {
                assert.deepEqual(result.body.product.sourceStoreIds, [sourceStoreId]);
                assert.equal(result.body.product.canDelete, sourceStoreId === ids[1]);
                assert.ok(result.body.batches.every(batch => batch.sourceStoreId === sourceStoreId));
            }
        }
        assert.equal((await api(`/api/batches/${batches[0].id}`)).status, 200);
        assert.equal((await api(`/api/batches/${batches[2].id}`)).status, 403);
        for (const [index, batch] of batches.entries()) for (const file of batch.files) {
            assert.equal((await api(`/api/files/${file.storedName}`)).status, index < 2 ? 200 : 403);
        }
        for (const product of shared.body.products) {
            const refs = { products: [{ spuId: product.spuId, sourceIdentity: product.sourceIdentity, productKey: product.productKey }] };
            assert.equal((await api('/api/products/status-read', b, refs)).body.products.length, 1, '相同 SPU 的两条来源各自可核对');
            const mine = await api('/api/products/status-read?library=personal', b, refs);
            assert.equal(mine.body.products.length, product.sourceStoreIds.includes(ids[1]) ? 1 : 0);
            assert.equal((await api('/api/products/status-read', t2, refs)).body.products.length, 0);
            assert.equal((await api('/api/products/status-read', testAdmin, refs)).body.products.length, 0, '测试管理员默认也不能读正式商品状态');
        }
        assert.equal((await api('/api/products', b, { spuIds: [spuId], storeIds: [ids[0]] }, 'DELETE')).status, 403);
        assert.equal((await api('/api/overview')).body.productCount, 2, '共享可读不能赋予删除他人来源权限');
        assert.equal((await api('/api/admin/users/test', b, { username: '13920000001', password })).status, 403);
        const created = await api('/api/admin/users/test', a, { username: '13920000001', password, accountType: 'production', role: 'admin' });
        assert.equal(created.status, 201); assert.equal(created.body.user.accountType, 'test'); assert.equal(created.body.user.role, 'user');
        checkpoint('read scopes and registration');
        assert.equal((await api('/api/overview?accountType=test', a)).body.productCount, 2);
        assert.equal((await api('/api/overview?accountType=production', a)).body.productCount, 2);
        assert.equal((await api('/api/me', t)).body.user.accountType, 'test', '指定账户启动时迁移且旧会话仍可使用');
        const stores = await api('/api/stores');
        assert.ok(!stores.body.stores.some(store => ids.slice(2).includes(store.storeId)));
        const agent = { storeId: 'temu:201', mallId: '201', pluginInstanceId: 'isolated-shared-plugin', storeName: '正式目标', pageStoreName: '正式目标',
            pluginVersion: '11.0.4', executionMode: 'plugin-api', pluginDetected: true, identityMatched: true,
            relayProtocol: 1, relaySessionId: randomUUID() };
        assert.equal((await api('/api/agents/register', 'device', agent)).status, 200);
        const send = { sourceStoreId: ids[0], sourceBatchId: batches[0].id, spuIds: [spuId], targetStoreId: agent.storeId };
        assert.equal((await api('/api/relay/send', t2, send)).status, 403);
        assert.equal((await api('/api/relay/send', b, { ...send, targetStoreId: ids[0] })).status, 403);
        const receiver = api('/api/jobs/claim', 'device', agent);
        const sent = await api('/api/relay/send', b, send);
        assert.equal(sent.status, 200, JSON.stringify(sent)); assert.equal(sent.body.sent, 1);
        const delivered = await receiver;
        assert.equal(delivered.body.claimed[0].sourceStoreId, ids[0]);
        assert.equal(delivered.body.claimed[0].targetStoreId, agent.storeId);
        checkpoint('shared send');
        const ownerSnapshot = await ownership.snapshotDeliveryOwners([ids[0], agent.storeId], agent.storeId, b.id);
        assert.equal((await api('/api/admin/stores/reassign', a, { storeId: agent.storeId, userId: a.id })).status, 200);
        await assert.rejects(ownership.withStableOwners(ownerSnapshot, () => { throw Error('不应交接'); }), { status: 409 });
        assert.equal((await api('/api/relay/send', b, send)).status, 403, '改派后原账户失去发送目标权限');
        // 管理员切换到测试分类时，即使正式目标属于本人也不能跨分类投递。
        for (const actionType of ['product_create', 'qualification_upload']) {
            assert.equal((await api('/api/relay/send?accountType=test', a, {
                sourceStoreId: ids[2], sourceBatchId: batches[2].id, spuIds: [String(Number(spuId) + 2)], targetStoreId: agent.storeId, actionType
            })).status, 403);
        }
        checkpoint('ownership generation');
        const liveShared = await api('/api/live'), liveMine = await api('/api/live?library=personal');
        assert.notEqual(liveShared.body.inventory, liveMine.body.inventory);
        assert.equal((await api('/api/stores/release', t, { storeId: ids[2] })).status, 200);
        assert.equal((await api('/api/stores/claim', b, { storeId: ids[2] })).status, 409, '解绑不能将测试店转成正式店');
        assert.equal((await api('/api/overview', t2)).body.productCount, 2, '解绑后测试数据仍留在测试共享库');
        checkpoint('released categories');
        assert.equal((await api('/api/admin/stores/reassign', a, { storeId: ids[2], userId: b.id })).status, 409);
        assert.equal((await api('/api/overview?accountType=unclassified', a)).body.productCount, 1);
        assert.equal((await api('/api/stores/claim', b, { storeId: 'temu:105' })).status, 409, '历史未知来源不能被普通认领自动归为正式');
        assert.equal((await api('/api/admin/stores/reassign', a, { storeId: 'temu:105', userId: t2.id })).status, 200);
        assert.equal((await api('/api/overview', t2)).body.productCount, 3);
        assert.equal((await api('/api/overview')).body.productCount, 2);
        assert.equal((await api('/api/admin/users/delete', a, { userId: t2.id, mode: 'keep' })).status, 200);
        assert.equal((await api('/api/overview', t)).body.productCount, 3, '删测试账户不把保留资料转入正式库');
        assert.equal((await api('/api/stores/claim', b, { storeId: ids[3] })).status, 409);
        checkpoint('deleted user');
        const fixed = createStoreOwnership(root, { database });
        assert.equal((await fixed.listDataDomains())[ids[2]], 'test');
        checkpoint('domains persisted');
        await fixed.initializeAccountTypes(createUsers(root));
        assert.equal((await fixed.listDataDomains())[ids[2]], 'test');
        // 新入库也要真正落存目录名称，而不只是依靠总览显示兜底；原包不得被补名逻辑改写。
        const sourceAgent = { ...agent, storeId: ids[1], mallId: '102', pluginInstanceId: 'isolated-source-plugin', storeName: '', pageStoreName: '', relaySessionId: randomUUID() };
        assert.equal((await api('/api/agents/register', 'device', sourceAgent)).status, 200);
        const sourcePacket = { kind: 'full-capture-packet', source: { sourceStoreId: ids[1], pluginInstanceId: sourceAgent.pluginInstanceId },
            records: [{ dataType: 'product-detail', identity: { productIds: ['2234567890'] },
                source: { pageProductId: '2234567890', requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
                payload: { success: true, result: { productId: '2234567890', productName: '空来源名新采集', extCode: 'NEW-NAME-FIXTURE' } } }] };
        const ingested = await api('/api/ingest', 'device', sourcePacket);
        assert.equal(ingested.status, 200, JSON.stringify(ingested));
        const savedBatch = await inventory.getBatch(ingested.body.batchId);
        assert.equal(savedBatch.sourceStoreName, '来源1'); assert.equal(savedBatch.sourceStoreId, ids[1]);
        assert.deepEqual((await inventory.readStoredFile(savedBatch.files[0].storedName)).json, sourcePacket);
        const placeholder = structuredClone(sourcePacket);
        placeholder.source.sourceStoreName = ids[1];placeholder.source.shopName = ids[1];
        placeholder.records[0].identity.productIds = ['2234567891'];placeholder.records[0].source.pageProductId = '2234567891';
        placeholder.records[0].payload.result.productId = '2234567891';placeholder.records[0].payload.result.extCode = 'PLACEHOLDER-NAME-FIXTURE';
        const placeholderResult = await api('/api/ingest', 'device', placeholder);
        assert.equal(placeholderResult.status, 200, JSON.stringify(placeholderResult));
        assert.equal((await inventory.getBatch(placeholderResult.body.batchId)).sourceStoreName, '来源1');
        // 网页兼容上传同样补名；不同来源的组合包明确拒绝，不扩大当前账号权限。
        const form = new FormData();form.append('files', new Blob([JSON.stringify(placeholder)], { type: 'application/json' }), 'temu-full-capture-placeholder.json');
        const webResult = await fetch(origin + '/api/import', { method: 'POST', headers: { cookie: cookies[b.id] }, body: form });
        assert.equal(webResult.status, 200);assert.equal((await webResult.json()).batch.sourceStoreName, '来源1');
        const mixed = new FormData();mixed.append('files', new Blob([JSON.stringify(sourcePacket)]), 'first.json');
        mixed.append('files', new Blob([JSON.stringify({ ...sourcePacket, source: { sourceStoreId: ids[2] } })]), 'other-store.json');
        assert.equal((await fetch(origin + '/api/import', { method: 'POST', headers: { cookie: cookies[b.id] }, body: mixed })).status, 400);
        assert.equal((await api('/api/stores/release', b, { storeId: ids[1] })).status, 200);
        const released = await api(`/api/products/1234567891?sourceStoreId=${encodeURIComponent(ids[1])}`);
        assert.equal(released.body.product.canDelete, false, '解除认领后共享可读但不可删除');
        assert.equal((await api('/api/products', b, { spuIds: ['1234567891'], storeIds: [ids[1]], canDelete: true }, 'DELETE')).status, 403, '客户端权限标记不能绕过最新归属');
        const offPage = await api(`/api/overview?productLimit=1&sourceStoreId=${encodeURIComponent(ids[0])}`);
        assert.ok(offPage.body.batches.every(batch=>batch.sourceStoreId!==ids[1]));
        assert.equal(offPage.body.sourceStores.find(item=>item.storeId===ids[1]).storeName, '来源1');
        if(database){
            // 模拟已解绑的旧批次；当前页不带批次，SQL仍必须从全范围元数据取页面店名。
            await database.query('maintenance', "UPDATE hub_batches SET body=JSON_SET(body,'$.sourceStoreName','','$.shopName','','$.pageStoreName','旧页头店名') WHERE store_id=?", [ids[1]]);
        }else{
            // 仅改本测试生成的临时索引，模拟只有页头名称的历史数据，不触碰工作区库存。
            const indexFile = path.join(root, 'data/index.json'),index = JSON.parse(await readFile(indexFile, 'utf8'));
            for(const batch of index.batches)if(batch.sourceStoreId===ids[1])Object.assign(batch,{sourceStoreName:'',shopName:'',pageStoreName:'旧页头店名'});
            await writeFile(indexFile, JSON.stringify(index));
        }
        const directoryOnly = await api(`/api/overview?productLimit=1&sourceStoreId=${encodeURIComponent(ids[0])}`);
        assert.equal(directoryOnly.body.sourceStores.find(item=>item.storeId===ids[1]).storeName, '旧页头店名');
        assert.equal((await api('/api/overview?productLimit=0')).body.sourceStores.find(item=>item.storeId===ids[1]).storeName, '旧页头店名');
        assert.equal((await api('/api/stores/claim', b, { storeId: ids[1] })).status, 200);
        assert.equal((await api('/api/products', b, { spuIds: ['1234567891'], storeIds: [ids[1]] }, 'DELETE')).status, 200, '自己来源允许真实删除');
        assert.equal((await api(`/api/products/1234567891?sourceStoreId=${encodeURIComponent(ids[1])}`)).status, 404);
        assert.equal((await api(`/api/products/${spuId}?sourceStoreId=${encodeURIComponent(ids[0])}`)).status, 200, '同货号其他来源仍保留');
        console.log('shared library HTTP checks passed');
    } finally {
        const exit = once(child, 'exit'); child.kill(); await exit;
        await database?.close();
        if (admin) { await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); }
        await rm(root, { recursive: true, force: true });
    }
});
