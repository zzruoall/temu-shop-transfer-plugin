/** 发布前副本与发布后只读冒烟；只核对现有数据，不登记插件、不向真实店铺投递。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';

const database = await openMysqlDatabase();
assert.ok(database, '发布冒烟必须使用明确的MySQL配置');
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS, 'utf8'));
assert.ok(credentials.deviceToken, '缺少受保护的设备读取凭证');
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// 下载包版本取本发布树的插件清单，避免新服务冒烟仍只核对旧版安装包。
const pluginVersion = JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url))).version;
let child, stderr = '';
try {
    const [[counts]] = await database.query('query', `SELECT
        (SELECT COUNT(*) FROM hub_products) AS products,
        (SELECT COUNT(*) FROM hub_batches) AS batches,
        (SELECT COUNT(*) FROM hub_agents) AS agents,
        (SELECT COUNT(*) FROM hub_jobs) AS jobs`);
    let base = process.env.TEMU_SMOKE_BASE;
    if (!base) {
        const instanceId = `relay-smoke-${Date.now()}`;
        child = fork(new URL('../server.mjs', import.meta.url), [], {
            env: { ...process.env, ZINIAO_TEST_EPHEMERAL: '1', ZINIAO_INSTANCE_ID: instanceId,
                ZINIAO_BIND: '127.0.0.1', ZINIAO_SEED: '0', TEMU_BASE_PATH: '/temu' },
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
        });
        child.stderr.on('data', chunk => { stderr += chunk; });
        let timer;
        try {
            const [message] = await Promise.race([once(child, 'message'),
                once(child, 'exit').then(([code]) => { throw Error(`候选服务退出${code}: ${stderr}`); }),
                new Promise((_, reject) => { timer = setTimeout(() => reject(Error('候选启动超时')), 30000); })]);
            assert.equal(message.instanceId, instanceId);
            base = `http://127.0.0.1:${message.port}/temu`;
        } finally { clearTimeout(timer); }
    }
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/temu$/);
    const get = async (endpoint, authenticated = true) => {
        const response = await fetch(base + endpoint, { headers: authenticated ? headers : {}, redirect: 'manual', signal: AbortSignal.timeout(20000) });
        return response;
    };
    // 未登录不得读库存；登录页本身保留且不会因删除旧首页而丢失入口。
    const denied = await get('/api/overview', false);
    assert.ok([401, 403].includes(denied.status));
    assert.equal((await get('/login', false)).status, 200);
    const overview = await get('/api/overview?productLimit=20');
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).productCount, Number(counts.products));
    for (const endpoint of ['/api/stores?limit=20', '/api/agents?limit=20', '/api/live']) {
        const response = await get(endpoint); assert.equal(response.status, 200, endpoint);
        const body = await response.json();
        if (endpoint.startsWith('/api/agents')) {
            for (const agent of body.agents) {
                assert.equal(typeof agent.online, 'boolean');
                assert.equal(typeof agent.identityMatched, 'boolean');
            }
        }
    }
    const capability = await get('/api/direct-create-capability');
    assert.equal(capability.status, 200);
    const protocol = await capability.json();
    assert.equal(protocol.minimumPluginVersion, '10.10.69');
    assert.equal(protocol.errorNoticeProtocol, 2);
    // 协议门槛与安装包版本分开核对，后续插件升级不得误提高已兼容的最低版本。
    assert.equal(protocol.errorNoticeMinimumPluginVersion, '10.10.72');
    for (const endpoint of ['/api/jobs', '/api/jobs/dashboard', '/api/work-log']) {
        assert.equal((await get(endpoint)).status, 404, `旧统计/状态入口未关闭:${endpoint}`);
    }
    for (const endpoint of ['/api/jobs/report', '/api/jobs/direct-progress', '/api/jobs/execution-run', '/api/jobs/target-task-states']) {
        const response = await fetch(base + endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 404, `旧执行入口未关闭:${endpoint}`);
    }
    for (const relative of ['public/app.js', 'public/styles.css', 'public/index.html', 'public/product-error-ui.js',
        `public/downloads/temu-transfer-plugin-${pluginVersion}.zip`, `public/downloads/temu-transfer-plugin-${pluginVersion}.crx`]) {
        const endpoint = relative === 'public/index.html' ? '/' : '/' + relative.slice('public/'.length);
        const response = await get(endpoint); assert.equal(response.status, 200, endpoint);
        assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../' + relative, import.meta.url))), `HTTP内容不是候选文件:${relative}`);
    }
    assert.equal(stderr, '', `候选有启动或接口错误: ${stderr}`);
    // 冒烟不制造新红标；比较现有标记、库存版本及数量，证明停用响应没有写库或清理历史数据。
    const retiredState = async () => {
        const [revision] = await database.query('query', 'SELECT * FROM hub_inventory_revision ORDER BY id');
        const [markers] = await database.query('query', 'SELECT store_id,SHA2(CAST(body AS CHAR),256) AS digest FROM hub_inventory_store_meta ORDER BY store_id');
        const [totals] = await database.query('query', `SELECT
            (SELECT COUNT(*) FROM hub_products) AS products,
            (SELECT COUNT(*) FROM hub_products WHERE blocked=1) AS blocked,
            (SELECT COUNT(*) FROM hub_batches) AS batches,
            (SELECT COUNT(*) FROM hub_inventory_payloads) AS payloads,
            (SELECT COUNT(*) FROM hub_jobs) AS jobs`);
        return { revision, markers, totals };
    };
    const beforeRetired = await retiredState();
    const liveBeforeRetired = await (await get('/api/live')).json();
    const deniedNotice = await fetch(base + '/api/products/failure', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: '{}', signal: AbortSignal.timeout(10000) });
    assert.equal(deniedNotice.status, 401, '停用路由仍不得绕过登录认证');
    for (const body of ['{}', '{', JSON.stringify({ pluginInstanceId: 'legacy-smoke-instance', failureGrant: 'old-grant',
        kind: 'rejected', reason: '旧插件失败通知' })]) {
        const retiredNotice = await fetch(base + '/api/products/failure', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
            body, signal: AbortSignal.timeout(10000) });
        assert.equal(retiredNotice.status, 410, '失败回执必须明确停用，不再按旧正文校验或接受写入');
        assert.equal((await retiredNotice.json()).error, 'product_failure_retired');
    }
    assert.deepEqual(await retiredState(), beforeRetired, '停用请求不能更改历史红标、库存版本或持久化数量');
    assert.deepEqual(await (await get('/api/live')).json(), liveBeforeRetired, '停用请求不能触发商品或目录状态更新');
    console.log(JSON.stringify({ relayReleaseSmoke: true, counts, pluginVersion, failureReceiptRetired: true, realPlatformCalls: 0 }));
} finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await database.close();
}
