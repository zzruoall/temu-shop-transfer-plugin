/** 真实 HTTP 认领视图回归：只使用临时用户、目录和模拟心跳，不访问真实平台或部署数据。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createUsers } from '../lib/users.mjs';
import { createStoreOwnership } from '../lib/store-ownership.mjs';

/** 比较完整店铺集合而非仅检查某个元素，防止多出本人店、跨分类店或重复分页数据。 */
function assertStoreIds(items, expected, message) {
    assert.deepEqual(items.map(item => item.storeId).sort(), [...expected].sort(), message);
}

/** 核对分页的派生列表，避免主列表正确但在线、离线或本人列表仍泄漏隐藏店铺。 */
function assertPageLists(body) {
    assert.deepEqual(body.online, body.stores.filter(store => store.online));
    assert.deepEqual(body.offline, body.stores.filter(store => !store.online));
    assert.deepEqual(body.mine, body.stores.filter(store => store.claimState === 'mine'));
}

test('云端会话的全部店铺与本人店铺隔离，保留目标权限及正式测试分类', { timeout: 60000 }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-claim-view-isolation-'));
    let child, childClosed;
    try {
        const token = randomUUID(), instanceId = randomUUID();
        const credentials = path.join(root, 'credentials.json');
        await writeFile(credentials, JSON.stringify({ deviceToken: token }));

        // 用户工具会在构造时捕获凭据路径；同步替换后立即还原，避免迁移任何真实管理员凭据。
        const previousCredentials = process.env.TEMU_CREDENTIALS;
        let users;
        try {
            process.env.TEMU_CREDENTIALS = credentials;
            users = createUsers(root);
        } finally {
            if (previousCredentials === undefined) delete process.env.TEMU_CREDENTIALS;
            else process.env.TEMU_CREDENTIALS = previousCredentials;
        }
        const password = `isolated-${randomUUID()}`;
        const alice = await users.register({ username: '13841000001', password });
        const bob = await users.register({ username: '13841000002', password });
        const tester = await users.createTestUser({ username: '13941000001', password });
        const testPeer = await users.createTestUser({ username: '13941000002', password });
        const ownership = createStoreOwnership(root);
        const fixtures = {
            aliceLive: { storeId: 'temu:9101', storeName: '00-Alice在线', owner: alice, online: true },
            aliceOffline: { storeId: 'temu:9102', storeName: '00-Alice无心跳', owner: alice, online: false },
            bobLive: { storeId: 'temu:9201', storeName: '01-Bob在线', owner: bob, online: true },
            bobOffline: { storeId: 'temu:9202', storeName: '01-Bob无心跳', owner: bob, online: false },
            testLive: { storeId: 'temu:9301', storeName: '02-测试本人在线', owner: tester, online: true },
            testOffline: { storeId: 'temu:9302', storeName: '02-测试本人无心跳', owner: tester, online: false },
            peerLive: { storeId: 'temu:9401', storeName: '03-测试他人在线', owner: testPeer, online: true },
            peerOffline: { storeId: 'temu:9402', storeName: '03-测试他人无心跳', owner: testPeer, online: false },
            available: { storeId: 'temu:9501', storeName: '90-正式待认领', online: true },
            neutral: { storeId: 'temu:9502', storeName: '91-未分类新心跳', online: true }
        };
        for (const fixture of Object.values(fixtures)) {
            if (fixture.owner) await ownership.claim(fixture.storeId, fixture.owner, fixture.storeName);
        }
        // 正式待认领店保留分类；另一个从未认领的新心跳用于验证两类账号都能浏览未知新店。
        await ownership.claim(fixtures.available.storeId, alice, fixtures.available.storeName);
        await ownership.release(fixtures.available.storeId, alice.id);
        const productionIds = ['aliceLive', 'aliceOffline', 'bobLive', 'bobOffline', 'available', 'neutral']
            .map(key => fixtures[key].storeId);
        const testIds = ['testLive', 'testOffline', 'peerLive', 'peerOffline', 'neutral']
            .map(key => fixtures[key].storeId);

        // 清除继承的业务及 Node 注入配置，云端认证、文件存储和插件令牌全部指向本次临时目录。
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
            !/^(?:TEMU_|ZINIAO_|NODE_OPTIONS$|NODE_PATH$)/i.test(key)));
        child = fork(new URL('../server.mjs', import.meta.url), [], {
            silent: true, windowsHide: true, execArgv: [], cwd: root,
            env: { ...env, TEMU_CREDENTIALS: credentials, TEMU_MYSQL_CONFIG: '', TEMU_BASE_PATH: '',
                TEMU_PLUGIN_TOKENS: path.join(root, 'plugin-tokens.json'), ZINIAO_DATA_ROOT: root,
                ZINIAO_BIND: '127.0.0.1', ZINIAO_PORT: '18380', ZINIAO_TEST_EPHEMERAL: '1',
                ZINIAO_INSTANCE_ID: instanceId, ZINIAO_SEED: '0', ZINIAO_INGEST_TOKEN: token,
                ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024) }
        });
        childClosed = new Promise(resolve => child.once('close', resolve));
        let output = '';
        child.stdout.on('data', value => { output = (output + value).slice(-16000); });
        child.stderr.on('data', value => { output = (output + value).slice(-16000); });
        const startup = new AbortController();
        let ready;
        try {
            const signal = AbortSignal.any([startup.signal, t.signal, AbortSignal.timeout(10000)]);
            [ready] = await Promise.race([
                once(child, 'message', { signal }),
                once(child, 'exit', { signal }).then(([code, exitSignal]) => {
                    throw Error(`服务启动失败 ${code ?? exitSignal}: ${output}`);
                })
            ]);
        } finally {
            startup.abort();
        }
        assert.equal(ready.instanceId, instanceId, '只能连接本次测试启动的服务');
        assert.ok(Number.isInteger(ready.port) && ready.port > 0);
        const origin = `http://127.0.0.1:${ready.port}`;
        const requestSignal = () => AbortSignal.any([t.signal, AbortSignal.timeout(8000)]);
        const cookies = new Map();

        /** 通过真实口令登录获取 Cookie，读取列表时绝不用设备令牌或管理员身份冒充普通用户。 */
        async function login(user) {
            const response = await fetch(origin + '/session', { method: 'POST', redirect: 'manual',
                signal: requestSignal(), headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ username: user.username, password }) });
            await response.text();
            assert.equal(response.status, 303, '临时普通用户应能完成真实云端登录');
            const cookie = response.headers.get('set-cookie')?.split(';')[0];
            assert.match(cookie || '', /^temu_session=.+/);
            cookies.set(user.id, cookie);
        }

        /** 设备身份仅登记模拟心跳；其他业务请求必须显式传入已登录用户，避免权限测试误用高权限。 */
        async function api(url, user, body) {
            assert.ok(user === 'device' || cookies.has(user?.id), '业务请求需要明确的测试身份');
            const response = await fetch(origin + url, { signal: requestSignal(), redirect: 'manual',
                ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
                headers: { 'content-type': 'application/json', ...(user === 'device'
                    ? { authorization: `Bearer ${token}` } : { cookie: cookies.get(user.id) }) } });
            return { status: response.status, body: await response.json() };
        }

        /** 所有分页用显式上限；不依赖缺省上限，确保真正检查完整集合以及过滤后总数。 */
        async function stores(user, filters = {}) {
            const query = new URLSearchParams({ limit: '200', ...filters });
            const result = await api(`/api/stores?${query}`, user);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assertPageLists(result.body);
            return result.body;
        }

        /** 按商城命名空间登记能力完整的虚拟接收端，只写本地心跳，不创建或投递任何平台任务。 */
        function agentFor(fixture) {
            return { storeId: fixture.storeId, mallId: fixture.storeId.split(':')[1],
                pluginInstanceId: `claim-view-${fixture.storeId.split(':')[1]}`,
                storeName: fixture.storeName, pageStoreName: fixture.storeName,
                pluginVersion: '11.0.4', executionMode: 'plugin-api', pluginDetected: true,
                identityMatched: true, relayProtocol: 1, relaySessionId: randomUUID() };
        }
        for (const user of [alice, bob, tester, testPeer]) {
            await login(user);
            const me = await api('/api/me', user);
            assert.equal(me.status, 200);
            assert.equal(me.body.user.id, user.id);
            assert.equal(me.body.user.role, 'user');
            assert.equal(me.body.user.accountType, user.accountType);
        }
        for (const fixture of Object.values(fixtures).filter(item => item.online)) {
            const registered = await api('/api/agents/register', 'device', agentFor(fixture));
            assert.equal(registered.status, 200, JSON.stringify(registered.body));
            assert.equal(registered.body.agent.storeId, fixture.storeId);
            assert.equal(registered.body.agent.online, true);
        }

        for (const [name, user, own, other] of [
            ['Alice', alice, [fixtures.aliceLive, fixtures.aliceOffline], [fixtures.bobLive, fixtures.bobOffline]],
            ['Bob', bob, [fixtures.bobLive, fixtures.bobOffline], [fixtures.aliceLive, fixtures.aliceOffline]]
        ]) {
            await t.test(`${name} 隐藏本人但保留他人、未认领和无心跳离线店`, async () => {
                const ownIds = own.map(item => item.storeId), otherIds = other.map(item => item.storeId);
                const expected = [...otherIds, fixtures.available.storeId, fixtures.neutral.storeId];
                const counts = { unclaimed: 2, mine: 2, others: 2, online: 3, offline: 1 };
                const online = await stores(user, { view: 'online' });
                assertStoreIds(online.stores, expected);
                assert.equal(online.total, 4);
                assert.equal(online.hasMore, false);
                assert.equal(online.isAdmin, false);
                assert.deepEqual(online.counts, counts);
                assert.ok(online.stores.every(item => item.claimState !== 'mine'));
                for (const item of online.stores) {
                    assert.equal(item.claimState, otherIds.includes(item.storeId) ? 'others' : 'unclaimed');
                    assert.equal(item.ownerId, '', '普通用户不能取得他人内部账号标识');
                    if (item.claimState === 'others') assert.match(item.ownerName, /^\d{3}\*{4}\d{4}$/);
                }
                const mine = await stores(user, { view: 'mine' });
                assertStoreIds(mine.stores, ownIds);
                assert.equal(mine.total, 2);
                assert.deepEqual(mine.counts, { unclaimed: 0, mine: 2, others: 0, online: 1, offline: 1 });
                const offline = mine.stores.find(item => item.storeId === own[1].storeId);
                assert.equal(offline.online, false);
                assert.equal(offline.lastSeenAt, '', '没有任何心跳的已认领店仍须出现在本人店铺');
                assert.ok(mine.stores.every(item => item.claimState === 'mine' && item.ownerName === user.username));

                const defaultDirectory = await api('/api/stores', user);
                assert.equal(defaultDirectory.status, 200);
                assertPageLists(defaultDirectory.body);
                assertStoreIds(defaultDirectory.body.stores, productionIds);
                assertStoreIds(defaultDirectory.body.mine, ownIds);
                assert.deepEqual(defaultDirectory.body.counts,
                    { unclaimed: 2, mine: 2, others: 2, online: 4, offline: 2 });
                const all = await stores(user, { view: 'all' });
                assert.deepEqual(all.stores, defaultDirectory.body.stores, '显式完整目录与无参数兼容接口一致');
                assert.deepEqual(all.counts, defaultDirectory.body.counts);
                assert.equal(all.total, 6);

                // 本人在线店排在待认领店之前，用逐页结果锁定“先排除，再分页”，避免总数正确但出现空页。
                const paged = [];
                for (let offset = 0; offset < expected.length; offset++) {
                    const page = await stores(user, { view: 'online', limit: '1', offset: String(offset) });
                    assert.equal(page.stores.length, 1);
                    assert.equal(page.total, expected.length);
                    assert.equal(page.offset, offset);
                    assert.equal(page.limit, 1);
                    assert.equal(page.hasMore, offset < expected.length - 1);
                    assert.deepEqual(page.counts, counts, '计数来自浏览集合，不随分页缩小');
                    paged.push(...page.stores);
                }
                assert.deepEqual(paged, online.stores, '每页顺序稳定且没有遗漏或重复');
                const pastEnd = await stores(user, { view: 'online', limit: '1', offset: '4' });
                assertStoreIds(pastEnd.stores, []);
                assert.equal(pastEnd.total, 4);
                assert.equal(pastEnd.hasMore, false);
                assert.deepEqual(pastEnd.counts, counts);

                // 查询本人店名、店号、账号及三态的组合，都不能把已隐藏的本人店重新并入浏览集合。
                for (const q of [own[0].storeName, own[0].storeId, own[1].storeId, user.username]) {
                    for (const onlineFilter of ['', '1', '0']) {
                        const searched = await stores(user, { view: 'online', q, online: onlineFilter });
                        assertStoreIds(searched.stores, []);
                        assert.equal(searched.total, 0);
                        assert.equal(searched.hasMore, false);
                        assert.deepEqual(searched.counts, counts, '搜索与在线过滤不改变视图计数口径');
                    }
                }
                for (const [filters, ids] of [
                    [{ online: '1' }, [other[0].storeId, fixtures.available.storeId, fixtures.neutral.storeId]],
                    [{ online: '0' }, [other[1].storeId]],
                    [{ q: other[0].storeName }, [other[0].storeId]],
                    [{ q: fixtures.available.storeId }, [fixtures.available.storeId]],
                    [{ claimState: 'others' }, otherIds],
                    [{ claimState: 'unclaimed' }, [fixtures.available.storeId, fixtures.neutral.storeId]],
                    [{ online: '1', claimState: 'others' }, [other[0].storeId]],
                    [{ online: '0', q: other[1].storeName }, [other[1].storeId]]
                ]) {
                    const filtered = await stores(user, { view: 'online', ...filters });
                    assertStoreIds(filtered.stores, ids);
                    assert.equal(filtered.total, ids.length);
                    assert.deepEqual(filtered.counts, counts);
                }
                for (const onlineFilter of ['', '1', '0']) {
                    const legacy = await stores(user, { view: 'online', claimState: 'mine', online: onlineFilter });
                    assertStoreIds(legacy.stores, []);
                    assert.equal(legacy.total, 0, '旧客户端的 mine 条件不能覆盖全部店铺排除本人规则');
                    assert.deepEqual(legacy.counts, counts);
                }
                const mineOffline = await stores(user, { view: 'mine', online: '0', q: own[1].storeId });
                assertStoreIds(mineOffline.stores, [own[1].storeId]);
                assert.equal(mineOffline.total, 1);
                assert.deepEqual(mineOffline.counts, mine.counts, '本人视图的计数来自完整本人集合');
                const allMine = await stores(user, { view: 'all', claimState: 'mine' });
                // 归属核验不受两页搜索和分页排除影响，且不得泄露另一账号分类的店铺标识。
                const hiddenClaims = await stores(user, { view: 'online', limit: '1', q: fixtures.neutral.storeId });
                assertStoreIds(hiddenClaims.unclaimableStoreIds.map(storeId => ({ storeId })), [...ownIds, ...otherIds]);
                assert.ok(hiddenClaims.unclaimableStoreIds.every(id => productionIds.includes(id)));
                assert.equal(allMine.unclaimableStoreIds, undefined, '完整目录兼容口径不新增认领页字段');
                assertStoreIds(allMine.stores, ownIds, '旧完整目录仍允许筛选本人店');
                assert.equal(allMine.total, 2);
                assert.deepEqual(allMine.counts, all.counts);

                const agents = await api('/api/agents?online=1&receivable=1&limit=200', user);
                assert.equal(agents.status, 200);
                assertStoreIds(agents.body.agents, [own[0].storeId], '目标列表必须保留可接收的本人在线绑定店');
                assert.equal(agents.body.total, 1);
                assert.equal((await api('/api/stores/claim', user, { storeId: other[0].storeId })).status, 409);
                assert.equal((await api('/api/stores/release', user, { storeId: other[0].storeId })).status, 403);
                assert.equal((await api('/api/agents/register', user, agentFor(other[0]))).status, 403,
                    '能浏览他人店并不赋予其插件登记权限');
            });
        }

        await t.test('认领后从全部消失并进入本人和目标列表，释放后重现且目标授权撤销', async () => {
            const id = fixtures.available.storeId;
            const claimed = await api('/api/stores/claim', alice, { storeId: id });
            assert.equal(claimed.status, 200);
            assert.equal(claimed.body.claimedCount, 1);
            assert.equal(claimed.body.claim.ownerId, alice.id);
            const aliceOnline = await stores(alice, { view: 'online' });
            assertStoreIds(aliceOnline.stores, [fixtures.bobLive.storeId, fixtures.bobOffline.storeId, fixtures.neutral.storeId]);
            assert.equal(aliceOnline.total, 3);
            assert.deepEqual(aliceOnline.counts, { unclaimed: 1, mine: 3, others: 2, online: 2, offline: 1 });
            const aliceMine = await stores(alice, { view: 'mine' });
            assertStoreIds(aliceMine.stores, [fixtures.aliceLive.storeId, fixtures.aliceOffline.storeId, id]);
            assert.equal(aliceMine.total, 3);
            assert.deepEqual(aliceMine.counts, { unclaimed: 0, mine: 3, others: 0, online: 2, offline: 1 });
            const aliceTargets = await api('/api/agents', alice);
            assert.equal(aliceTargets.status, 200);
            assertStoreIds(aliceTargets.body.agents, [fixtures.aliceLive.storeId, id]);
            const bobView = await stores(bob, { view: 'online' });
            assert.equal(bobView.total, 4);
            assert.equal(bobView.stores.find(item => item.storeId === id).claimState, 'others');
            assert.deepEqual(bobView.counts, { unclaimed: 1, mine: 2, others: 3, online: 3, offline: 1 });
            assert.equal((await api('/api/stores/claim', bob, { storeId: id })).status, 409);
            assert.equal((await api('/api/stores/release', bob, { storeId: id })).status, 403);
            const released = await api('/api/stores/release', alice, { storeId: id });
            assert.equal(released.status, 200);
            assert.equal(released.body.released, true);
            for (const [user, others] of [[alice, [fixtures.bobLive, fixtures.bobOffline]], [bob, [fixtures.aliceLive, fixtures.aliceOffline]]]) {
                const online = await stores(user, { view: 'online' });
                assertStoreIds(online.stores, [...others.map(item => item.storeId), id, fixtures.neutral.storeId]);
                assert.equal(online.total, 4);
                assert.equal(online.stores.find(item => item.storeId === id).claimState, 'unclaimed');
                assert.deepEqual(online.counts, { unclaimed: 2, mine: 2, others: 2, online: 3, offline: 1 });
            }
            assertStoreIds((await stores(alice, { view: 'mine' })).stores,
                [fixtures.aliceLive.storeId, fixtures.aliceOffline.storeId]);
            assertStoreIds((await api('/api/agents', alice)).body.agents, [fixtures.aliceLive.storeId]);
            assert.equal((await api('/api/agents/register', alice, agentFor(fixtures.available))).status, 403);
        });

        await t.test('正式测试分类不因展示过滤、查询伪造或释放认领而串库', async () => {
            for (const user of [alice, bob]) {
                for (const view of ['all', 'online', 'mine']) {
                    const normal = await stores(user, { view });
                    const forged = await stores(user, { view, accountType: 'test' });
                    assert.deepEqual(forged.stores, normal.stores);
                    assert.deepEqual(forged.counts, normal.counts);
                    assert.equal(forged.total, normal.total);
                    assert.ok(forged.stores.every(item => item.accountType !== 'test'));
                    assert.equal((await stores(user, { view, q: fixtures.testLive.storeId })).total, 0);
                }
                assert.equal((await api('/api/stores/claim', user, { storeId: fixtures.testLive.storeId })).status, 409);
            }
            const testAll = await stores(tester, { view: 'all' });
            assertStoreIds(testAll.stores, testIds);
            assert.equal(testAll.total, 5);
            assert.deepEqual(testAll.counts, { unclaimed: 1, mine: 2, others: 2, online: 3, offline: 2 });
            const testOnline = await stores(tester, { view: 'online', accountType: 'production' });
            assertStoreIds(testOnline.stores, [fixtures.peerLive.storeId, fixtures.peerOffline.storeId, fixtures.neutral.storeId]);
            assert.equal(testOnline.total, 3);
            assert.deepEqual(testOnline.counts, { unclaimed: 1, mine: 2, others: 2, online: 2, offline: 1 });
            const testMine = await stores(tester, { view: 'mine' });
            assertStoreIds(testMine.stores, [fixtures.testLive.storeId, fixtures.testOffline.storeId]);
            assert.deepEqual(testMine.counts, { unclaimed: 0, mine: 2, others: 0, online: 1, offline: 1 });
            assertStoreIds((await api('/api/agents', tester)).body.agents, [fixtures.testLive.storeId]);
            assert.equal((await api('/api/stores/claim', tester, { storeId: fixtures.available.storeId })).status, 409,
                '正式店已释放但永久分类仍不允许测试账号认领');
            assert.equal((await api('/api/stores/release', tester, { storeId: fixtures.testLive.storeId })).status, 200);
            const releasedTest = await stores(tester, { view: 'online' });
            assert.equal(releasedTest.stores.find(item => item.storeId === fixtures.testLive.storeId).claimState, 'unclaimed');
            assert.equal(releasedTest.total, 4);
            assert.deepEqual(releasedTest.counts, { unclaimed: 2, mine: 1, others: 2, online: 3, offline: 1 });
            for (const user of [alice, bob]) {
                assertStoreIds((await stores(user, { view: 'all' })).stores, productionIds);
                assert.equal((await api('/api/stores/claim', user, { storeId: fixtures.testLive.storeId })).status, 409,
                    '释放测试归属不能让正式账号看到或认领测试店');
            }
        });
    } finally {
        // 启动失败、请求异常或断言失败也先结束子进程并等候管道关闭，再删除本次唯一的临时目录。
        try {
            if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            if (childClosed) await childClosed;
        } finally {
            assert.equal(path.dirname(root), path.resolve(tmpdir()), '清理目标必须是系统临时目录的直接子目录');
            assert.ok(path.basename(root).startsWith('temu-claim-view-isolation-'));
            await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            await assert.rejects(access(root), { code: 'ENOENT' }, '临时数据目录必须已删除');
        }
    }
});
