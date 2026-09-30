/**
 * 账户模式门控验收（计划任务 1）。
 *
 * 要封住的绕行（计划原文）：
 * - on 初始化失败后仍能继续走旧路径接受新业务；
 * - shadow 也初始化并可能登记**可执行**工作；
 * - 非法模式值被当成合法；
 * - 归属"没有认领"与"查询故障"被混为一类。
 *
 * 判定必须是**行为**：不是看日志里有没有"已启用"，而是看在相应模式下
 * 新业务是否被正确放行/拒绝，以及账本里是否出现了可执行工作。
 */
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { normalizeAccountProcessMode } from '../lib/mysql-schema.mjs';
import { openIsolatedDatabase } from './account-process-harness.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mysql = require('mysql2/promise');

const checks = [];
async function check(id, title, run) {
    try { checks.push({ id, title, status: 'PASS', detail: await run() ?? null }); }
    catch (error) { checks.push({ id, title, status: 'FAIL', reason: String(error?.message || error) }); }
}

async function pickFreePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { const { port } = server.address() || {}; server.close(e => e ? reject(e) : resolve(port)); });
    });
}
function waitForExit(child, ms) {
    return new Promise(resolve => {
        if (child.exitCode != null || child.signalCode != null) return resolve(true);
        const timer = setTimeout(() => resolve(false), ms);
        child.once('exit', () => { clearTimeout(timer); resolve(true); });
    });
}
async function stopChild(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try { child.kill(); } catch {}
    if (await waitForExit(child, 5000)) return;
    try { child.kill('SIGKILL'); } catch {}
    if (await waitForExit(child, 3000)) return;
    if (process.platform === 'win32' && child.pid) {
        await new Promise(resolve => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
            killer.once('exit', resolve); killer.once('error', resolve);
        });
    }
}

/** 起一个服务实例；返回可观测的句柄。 */
async function bootServer({ database, mode, storeIds, budget = true, breakOwnership = false }) {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'ziniao-mode-'));
    await database.query('maintenance',
        `INSERT INTO hub_schema(id,version,state,data_root,manifest) VALUES(1,1,'ready',?,NULL)
         ON DUPLICATE KEY UPDATE version=VALUES(version),state=VALUES(state),data_root=VALUES(data_root)`, [tempRoot]);
    for (const [storeId, ownerId] of Object.entries(storeIds || {})) {
        await database.query('maintenance',
            `INSERT INTO hub_map_entries(domain,entry_key,body) VALUES('ownership',?,?)
             ON DUPLICATE KEY UPDATE body=VALUES(body)`,
            [storeId, JSON.stringify({ ownerId, ownerName: ownerId, storeName: storeId })]);
    }
    const instanceId = randomBytes(8).toString('hex');
    const token = `mode-${randomBytes(6).toString('hex')}`;
    const configPath = path.join(tempRoot, 'mysql.json');
    await writeFile(configPath, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: database.name }));
    const PORT = String(await pickFreePort());
    const origin = `http://127.0.0.1:${PORT}`;
    const child = fork(path.join(hubDir, 'server.mjs'), [], {
        cwd: hubDir,
        env: {
            ...process.env,
            ZINIAO_BIND: '127.0.0.1', ZINIAO_PORT: PORT,
            ZINIAO_INGEST_TOKEN: token, ZINIAO_DATA_ROOT: tempRoot,
            ZINIAO_SKIP_SEED: '1', ZINIAO_SEED: '0', ZINIAO_INSTANCE_ID: instanceId,
            ZINIAO_WATCH_DIR: path.join(tempRoot, 'inbox'),
            TEMU_MYSQL_CONFIG: configPath, TEMU_CREDENTIALS: '',
            ZINIAO_ACCOUNT_PROCESS_MODE: mode,
            ...(budget ? { ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024) } : {})
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    return { child, origin, token, instanceId, tempRoot, getOutput: () => output };
}
async function waitReady(handle, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (handle.child.exitCode != null) throw new Error(`服务提前退出 code=${handle.child.exitCode}：${handle.getOutput().slice(-300)}`);
        try {
            const res = await fetch(`${handle.origin}/api/ingest-info`, { signal: AbortSignal.timeout(2000) });
            if (res.ok || res.status === 401) return;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('服务未就绪');
}
/** 发一份真实结构的采集包，返回 {status, body}。 */
async function upload(handle, storeId, spuId) {
    const packet = {
        schemaVersion: 4, kind: 'full-capture-packet', exportMode: 'full-capture',
        source: { pageUrl: 'https://agentseller.temu.com/goods/list', allowedSpuIds: [spuId],
            sourceStoreId: storeId, sourceStoreName: storeId },
        products: [{ spuId, goodsId: '9901' }],
        records: [{ identity: { productIds: [spuId], goodsIds: ['9901'] },
            payload: { result: { pageItems: [{ productId: Number(spuId), goodsId: 9901,
                productName: '模式验收', productSkuSummaries: [{ productSkuId: 79322569001 }] }] } } }]
    };
    /**
     * 走完整的许可协议：on 模式下服务端要求 `x-ingest-permit`，
     * 裸传会先得到 428，就测不到本用例真正关心的门控/归属语义。
     * 用共享协议客户端，保证契约只有一份实现。
     */
    const { submitAccountIngest } = await import('./account-ingest-http-fixture.mjs');
    const response = await submitAccountIngest({ origin: handle.origin, token: handle.token, packet, fileName: 'mode.json' });
    const body = await response.json().catch(() => null);
    return { status: response.status, body };
}

let isolated = null, pool = null, database = null;
const handles = [];
try {
    isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_modegate', label: '模式门控验收' });
    pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 4 });
    database = {
        name: isolated.name,
        query: (_lane, sql, params = []) => pool.query(sql, params),
        async transaction(_lane, action) {
            const connection = await pool.getConnection();
            try {
                await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                await connection.beginTransaction();
                const result = await action(connection);
                await connection.commit();
                return result;
            } catch (error) { await connection.rollback(); throw error; }
            finally { connection.release(); }
        }
    };
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const storeId = 'temu:990200000001';

    // 一、模式值归一化：非法值必须明确报错，不能被静默当成合法模式。
    await check('mode_value_normalized', '非法模式值必须明确报错而不是被接受', async () => {
        assert.equal(normalizeAccountProcessMode('on').mode, 'on');
        assert.equal(normalizeAccountProcessMode('off').mode, 'off');
        assert.equal(normalizeAccountProcessMode('shadow').mode, 'shadow');
        // 非法值：normalize 给出 invalid 标记，调用方据此拒绝启动。
        const bogus = normalizeAccountProcessMode('ON');
        assert.equal(bogus.invalid, true, '大小写/未知值应被标记为非法，而不是悄悄规范化成 on');
        return { on: 'on', invalid: bogus.invalid };
    });

    // 二、shadow 不得写入**可执行**队列：影子只做观测。
    await check('shadow_writes_no_executable_work', 'shadow 模式不得产生可执行的账户工作', async () => {
        const handle = await bootServer({ database, mode: 'shadow', storeIds: { [storeId]: 'shadow-owner' } });
        handles.push(handle);
        await waitReady(handle);
        const result = await upload(handle, storeId, '8802000001');
        assert.ok(result.status < 500, `shadow 下上传不应 5xx，实际 ${result.status}`);
        // 等一小段时间让任何异步登记落地，再断言没有可执行工作。
        await new Promise(r => setTimeout(r, 3000));
        const [[row]] = await pool.query(
            "SELECT COUNT(*) AS n FROM hub_account_work WHERE account_id=? AND status IN ('queued','running')",
            ['shadow-owner']);
        assert.equal(Number(row?.n || 0), 0, `shadow 不得登记可执行工作，实际 ${Number(row?.n || 0)} 条`);
        return { executable: Number(row?.n || 0) };
    });

    // 三、on 初始化失败（缺预算）时必须阻止新业务，而不是回落到旧路径继续收单。
    await check('on_failure_blocks_new_business', 'on 初始化失败必须阻止新业务而不是继续旧路径', async () => {
        const handle = await bootServer({ database, mode: 'on', storeIds: { [storeId]: 'onfail-owner' }, budget: false });
        handles.push(handle);
        await waitReady(handle);
        const result = await upload(handle, storeId, '8802000002');
        // 计划要求：on 未就绪时新业务返回 503 与明确原因。
        assert.equal(result.status, 503, `on 未就绪必须返回 503，实际 ${result.status} ${JSON.stringify(result.body)}`);
        assert.ok(/account_runtime_unavailable|budget_unavailable/.test(JSON.stringify(result.body || {})),
            `必须给出明确原因，实际 ${JSON.stringify(result.body)}`);
        return { status: result.status, reason: result.body?.code || result.body?.error };
    });

    // 四、归属查询故障与"没有认领"必须区分：前者 503，后者不登记（待确认）。
    // 混为一类会让"数据库抖动"被误判成"未认领"，商品静默留在待确认里。
    await check('ownership_lookup_failure_is_503', '归属查询故障必须报 503，不能当成未认领', async () => {
        const storeA = 'temu:990200000011';
        const storeB = 'temu:990200000012';
        // 只认领 A：B 是真正的"未认领"，A 用来对照。
        const handle = await bootServer({ database, mode: 'on', storeIds: { [storeA]: 'owner-known' } });
        handles.push(handle);
        await waitReady(handle);

        // 未认领店铺：不报 5xx，也不登记可执行工作（进入待确认）。
        const unknown = await upload(handle, storeB, '8802000011');
        assert.ok(unknown.status < 500, `未认领不应 5xx，实际 ${unknown.status}`);
        const [[unknownRows]] = await pool.query(
            "SELECT COUNT(*) AS n FROM hub_account_work WHERE store_id=?", [storeB]);
        assert.equal(Number(unknownRows?.n || 0), 0, '未认领店铺不得登记可执行工作');

        // 查询故障：把归属表改名，再上传必须 503（不是 200 也不是 500）。
        await pool.query('RENAME TABLE hub_map_entries TO hub_map_entries_hidden');
        let failure = null;
        try {
            failure = await upload(handle, storeA, '8802000012');
        } finally {
            await pool.query('RENAME TABLE hub_map_entries_hidden TO hub_map_entries');
        }
        assert.equal(failure.status, 503,
            `归属查询故障必须返回 503，实际 ${failure.status} ${JSON.stringify(failure.body)}`);
        return { unclaimed: unknown.status, lookupFailure: failure.status };
    });
    // 五、全部新业务入口都必须被门控覆盖（计划任务1 要求"每个入口均有失败关闭反例"）。
    //    只测直传不足以证明"on 未就绪时不放行新业务"。
    await check('all_new_business_entries_gated', 'on 未就绪时所有新业务入口都必须拒绝', async () => {
        const handle = await bootServer({ database, mode: 'on', storeIds: { [storeId]: 'gate-owner' }, budget: false });
        handles.push(handle);
        await waitReady(handle);
        const post = async (path, body) => {
            const response = await fetch(`${handle.origin}${path}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${handle.token}`, 'x-plugin-instance': handle.instanceId },
                body: JSON.stringify(body || {}),
                signal: AbortSignal.timeout(10000)
            });
            return response.status;
        };
        /**
         * 逐个入口核对"失败关闭"。
         *
         * 期望值是**两个**可接受状态，不是单一的 503：
         * - 依赖账户运行时的入口（ingest/prepare/jobs/claim）在未就绪时必须 503；
         * - `/api/import` 在 on 模式下**本来就该被拒绝**（409），
         *   因为文件导入没有持久提交轮次，放行等于绕开账户串行约束。
         *   它比 503 更明确，属于设计决定而不是缺陷。
         * 关键是：任何入口都不得返回 2xx，也不得 5xx。
         */
        const expected = {
            'ingest': [503],
            'ingest/prepare': [503],
            'jobs': [503],
            'jobs/claim': [503],
            'import': [409]
        };
        // 只核对**本轮**新增的业务行：同一个探针前面的用例可能已经写入批次，
        // 用总数断言会把那些正常行算成"被拒入口写进去的"。
        const [[batchesBefore]] = await pool.query('SELECT COUNT(*) AS n FROM hub_batches');
        const entries = {
            'ingest': await post('/api/ingest', { packet: { schemaVersion: 4, kind: 'full-capture-packet', source: {}, products: [], records: [] } }),
            'ingest/prepare': await post('/api/ingest/prepare', { storeId, pluginInstanceId: handle.instanceId }),
            'jobs': await post('/api/jobs', { sourceStoreId: storeId, targetStoreId: storeId, spuIds: [] }),
            'jobs/claim': await post('/api/jobs/claim', { storeId, pluginInstanceId: handle.instanceId }),
            'import': await post('/api/import', {})
        };
        for (const [name, status] of Object.entries(entries)) {
            // 失败关闭 = 明确的 4xx，且是对该入口约定的那一个；不得 2xx、不得 5xx。
            assert.ok(expected[name].includes(status),
                `${name} 入口状态码应属于 ${JSON.stringify(expected[name])}，实际 ${status}`);
        }
        // 失败关闭必须真的**没有产生业务行**：只看状态码无法排除"先写后拒"。
        // hub_batches 没有 source 列（来源记录在 body JSON 内），按**增量**断言。
        const [[batchesAfter]] = await pool.query('SELECT COUNT(*) AS n FROM hub_batches');
        const added = Number(batchesAfter?.n || 0) - Number(batchesBefore?.n || 0);
        assert.equal(added, 0, `被拒绝的入口不得产生业务行，实际新增 ${added}`);
        return entries;
    });

    // 六、门控必须**先于**读取正文（确定性判别，不用耗时阈值）。
    //    用裸 socket 发完整头部 + Content-Length 声明 8MiB，但只发 1 字节正文：
    //    - 门控在前：服务端在 readBody 之前拒绝，立即回 503 并关闭连接；
    //    - 门控在后：服务端会等正文（req.setTimeout 120s），socket 不会在秒级收到响应。
    //    fetch 会自动校验 content-length 与 body 长度，所以这里必须用 net socket。
    await check('gate_precedes_body_read', '门控必须先于读取正文（声明 8MiB 但只发 1 字节）', async () => {
        const handle = await bootServer({ database, mode: 'on', storeIds: { [storeId]: 'gate3-owner' }, budget: false });
        handles.push(handle);
        await waitReady(handle);
        const status = await new Promise((resolve, reject) => {
            const port = Number(new URL(handle.origin).port);
            const socket = net.connect({ host: '127.0.0.1', port }, () => {
                const CRLF = String.fromCharCode(13, 10);
                socket.write([
                    'POST /api/ingest HTTP/1.1',
                    `Host: 127.0.0.1:${port}`,
                    'Content-Type: application/json',
                    `Authorization: Bearer ${handle.token}`,
                    'x-plugin-instance: ' + handle.instanceId,
                    'Content-Length: 8388608',
                    'Connection: close',
                    '', ''
                ].join(CRLF));
                socket.write('{');
            });
            let data = '';
            const timer = setTimeout(() => {
                socket.destroy();
                // 超时=服务端在等正文=门控晚于读取。
                resolve({ timeout: true, data });
            }, 6000);
            socket.on('data', chunk => { data += chunk.toString(); });
            socket.on('end', () => { clearTimeout(timer); resolve({ timeout: false, data }); });
            socket.on('error', error => { clearTimeout(timer); reject(error); });
        });
        assert.equal(status.timeout, false, '声明 8MiB 只发 1 字节时被挂住：说明服务端先读正文、后过门控');
        const match = /^HTTP\/1\.1 (\d{3})/.exec(status.data);
        assert.ok(match, `未收到合法 HTTP 响应：${status.data.slice(0, 120)}`);
        assert.equal(match[1], '503', `必须立即返回 503，实际 ${match[1]}`);
        return { status: Number(match[1]) };
    });

} catch (error) {
    checks.push({ id: 'harness', title: '模式门控验收环境可运行', status: 'FAIL', reason: String(error?.message || error) });
} finally {
    for (const handle of handles) {
        try { await stopChild(handle.child); } catch {}
        try { await rm(handle.tempRoot, { recursive: true, force: true }); } catch {}
    }
    if (pool) { try { await pool.end(); } catch {} }
    if (isolated) { try { await isolated.drop(); } catch {} }
}

const failed = checks.filter(item => item.status !== 'PASS');
console.log(JSON.stringify({ passed: failed.length === 0, checks, failedCount: failed.length,
    realPlatformCalls: 0, productionChanged: false }, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
