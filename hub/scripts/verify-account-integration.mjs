/**
 * 账户进程接入验收（方案步骤0的聚合入口）。
 *
 * 这一步的作用是**证明接入还没发生**，而不是证明它已经完成：
 * 只有真实 HTTP 入队产生账户工作行、真实 worker 读取指定原始文件、业务结果落回原表，
 * 才算业务接入完成。当前 server.mjs 未引用新仓库、worker 默认只回 ready:true，
 * 因此本脚本**必须以非 0 退出**。
 *
 * 关键约束：环境缺失、用例跳过都不能算通过。缺 MySQL 或起不来服务时同样退出非 0。
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
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { submitAccountIngest } from './account-ingest-http-fixture.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const INSTANCE_ID = randomBytes(8).toString('hex');
const TOKEN = `integration-${randomBytes(6).toString('hex')}`;

const checks = [];
/** 每一项都独立记录结论；任何一项不通过，整体退出码必须非 0。 */
async function check(id, title, run) {
    try {
        const detail = await run();
        checks.push({ id, title, status: 'PASS', detail: detail === undefined ? null : detail });
    } catch (error) {
        checks.push({ id, title, status: 'FAIL', reason: String(error?.message || error) });
    }
}

async function pickFreePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() || {};
            server.close(error => error ? reject(error) : resolve(port));
        });
    });
}

function waitForExit(child, timeoutMs) {
    return new Promise(resolve => {
        if (child.exitCode != null || child.signalCode != null) return resolve(true);
        const timer = setTimeout(() => resolve(false), timeoutMs);
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
            killer.once('exit', resolve);
            killer.once('error', resolve);
        });
        if (await waitForExit(child, 3000)) return;
    }
    throw new Error(`测试服务未能退出 pid=${child.pid}`);
}

async function waitForServer(child, origin, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
        if (child.exitCode != null) throw new Error(`server exited with code ${child.exitCode}`);
        try {
            const response = await fetch(`${origin}/api/ingest-info`, { signal: AbortSignal.timeout(2000) });
            // 启用云端认证时该接口需要会话，未带会话会返回 401。
            // 401/403 同样证明"服务已在监听并进入路由"，不能用它判定服务没起来——
            // 否则一个正常的鉴权响应会被误读成启动失败。
            if (response.ok || response.status === 401 || response.status === 403) {
                if (!response.ok) return { authGated: true, status: response.status };
                const body = await response.json();
                // 必须对上本次 instanceId：只看 HTTP 200 会把占用同端口的旧服务误当成测试对象。
                if (body?.instanceId && body.instanceId !== INSTANCE_ID) {
                    throw new Error('port occupied by other service');
                }
                return body;
            }
        } catch (error) {
            lastError = error;
            if (/port occupied by other service/.test(String(error?.message || ''))) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`服务未在 ${timeoutMs}ms 内就绪：${lastError ? String(lastError.message || lastError) : '无响应'}`);
}

let isolated = null;
let isolatedPool = null;
let child = null;
let tempRoot = null;
let output = '';
const mysql = require('mysql2/promise');
try {
    // 隔离库：只有端口 33917，绝不指向生产。
    try {
        isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_integration', label: '接入验收' });
        isolatedPool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 4 });
        // 接入验收要有可比对的表结构：先按正式迁移建好，再验证服务端是否真的往里写。
        const database = {
            query: (_lane, sql, params = []) => isolatedPool.query(sql, params),
            async transaction(_lane, action) {
                const connection = await isolatedPool.getConnection();
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
    } catch (error) {
        checks.push({ id: 'isolated_db', title: '隔离数据库可用', status: 'FAIL', reason: String(error?.message || error) });
        console.log(JSON.stringify({ passed: false, checks, note: '隔离库不可用，不能把环境缺失当成通过' }, null, 1));
        process.exit(1);
    }
    tempRoot = await mkdtemp(path.join(tmpdir(), 'ziniao-integration-'));
    // 正式服务只认 TEMU_MYSQL_CONFIG 指向的配置文件，不读 ZINIAO_MYSQL_DATABASE。
    // 只传环境变量等于没绑定隔离库：子服务会走文件模式或继承外部配置，
    // 于是"查到 0 行"不能证明接入失败——必须显式生成指向 33917 临时库的配置。
    const mysqlConfigPath = path.join(tempRoot, 'mysql.json');
    await writeFile(mysqlConfigPath, JSON.stringify({
        host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name
    }));
    // 服务启动会校验 hub_schema：版本、state=ready 且 data_root 与本次临时目录一致。
    // 这是**正确的**安全校验（防止数据库故障时退回旧 JSON 造成两个数据源分叉），
    // 因此测试必须满足它，而不是绕过它——不满足时服务会直接拒绝启动。
    await isolatedPool.query(
        `INSERT INTO hub_schema(id,version,state,data_root,manifest) VALUES(1,1,'ready',?,NULL)
         ON DUPLICATE KEY UPDATE version=VALUES(version),state=VALUES(state),data_root=VALUES(data_root)`,
        [tempRoot]);

    // 用固定端口 + 冲突重试：**不能**用 ZINIAO_TEST_EPHEMERAL，那个模式会关掉后台分发，
    // 而本验收的目的正是检验真实执行链是否接通。服务端启动后自报监听地址。
    let listenOrigin = '';
    for (let attempt = 0; attempt < 3 && !listenOrigin; attempt += 1) {
        const PORT = String(await pickFreePort());
        const candidateOrigin = `http://127.0.0.1:${PORT}`;
        output = '';
        child = fork(path.join(hubDir, 'server.mjs'), [], {
            cwd: hubDir,
            env: {
                ...process.env,
                ZINIAO_BIND: '127.0.0.1',
                ZINIAO_PORT: PORT,
                ZINIAO_INGEST_TOKEN: TOKEN,
                ZINIAO_DATA_ROOT: tempRoot,
                ZINIAO_SKIP_SEED: '1',
                ZINIAO_SEED: '0',
                ZINIAO_WATCH_DIR: path.join(tempRoot, 'inbox'),
                ZINIAO_INSTANCE_ID: INSTANCE_ID,
                // 显式绑定隔离库：正式服务读 TEMU_MYSQL_CONFIG 文件，不读数据库名环境变量。
                TEMU_MYSQL_CONFIG: mysqlConfigPath,
                // 刻意清空：启用云端认证后 /api/ingest 需要用户会话，401 会掩盖
                // "账户账本是否接入"这个真正要检验的缺口。本验收用本机令牌鉴权。
                TEMU_CREDENTIALS: '',
                // 账户进程模式打开，用来证明服务当前是否真的读取了它。
                ZINIAO_ACCOUNT_PROCESS_MODE: 'on',
                // Windows 上读不到 cgroup 限额，预算会（正确地）拒绝启用。
                // 这里显式声明服务预算：这正是方案要求的"读不到就要求显式预算"路径，
                // 不是绕过校验——不给这个值服务会直接拒绝开启账户链。
                ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024)
            },
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            windowsHide: true
        });
        child.stdout.on('data', chunk => { output += chunk.toString(); });
        child.stderr.on('data', chunk => { output += chunk.toString(); });
        try {
            const info = await waitForServer(child, candidateOrigin);
            // 鉴权开启时拿不到 instanceId：仍视为服务已就绪，但不放宽实例校验以外的断言。
            if (!info.authGated) {
                assert.equal(info.instanceId, INSTANCE_ID, `必须连到本次启动的实例，实际 ${info.instanceId}`);
                assert.equal(info.ingestPath, '/api/ingest', 'ingest-info 未返回标准直推路径');
            }
            listenOrigin = candidateOrigin;
        } catch (error) {
            await stopChild(child);
            child = null;
            // 端口被抢或启动失败：换端口重试，三次都失败才抛出。
            if (attempt === 2) throw error;
        }
    }

    // 1) 服务启动后必须真的接上账户工作仓库：真实 HTTP 入队要产生 hub_account_work 行。
    //    前置：来源店必须**已认领**。账本按可信账户登记，未认领店铺没有可信账户，
    //    不设认领就测等于测了个空（会得到 0 行并误判成"未接入"）。
    const SOURCE_STORE = 'temu:990000901';
    await isolatedPool.query(
        `INSERT INTO hub_map_entries(domain,entry_key,body) VALUES('ownership',?,?)
         ON DUPLICATE KEY UPDATE body=VALUES(body)`,
        [SOURCE_STORE, JSON.stringify({ ownerId: 'integration-owner', ownerName: '接入验收账号', storeName: '接入验收店', claimedAt: '2026-09-28T00:00:00.000Z' })]);
    await check('http_ingest_creates_account_work', '真实 HTTP 入队必须产生账户工作行', async () => {
        // sourceStoreId 必须放在 packet.source 下：服务端的 extractIngestUpload
        // 只从 body.sourceStoreId 或 packet.source.sourceStoreId 取值。
        // 写成顶层 storeId 会被解析成空串，于是账本按"未认领"处理，得到 0 行——
        // 那是测试载荷写错，不是产品缺陷。
        // 用真实采集包格式（full-capture-packet + records）：
        // 解析器从 records 里的 pageItems 生成可上架商品；只写一个裸 products 数组
        // 会得到 productCount=0，账本随之报告 no_products——那是载荷不真实，不是接入失败。
        const SOURCE_SPU = '7744886901';
        const packet = {
            schemaVersion: 4,
            kind: 'full-capture-packet',
            exportMode: 'full-capture',
            source: { pageUrl: 'https://agentseller.temu.com/goods/list', allowedSpuIds: [SOURCE_SPU],
                sourceStoreId: SOURCE_STORE, sourceStoreName: '接入验收店' },
            products: [{ spuId: SOURCE_SPU, goodsId: '9901' }],
            records: [{
                identity: { productIds: [SOURCE_SPU], goodsIds: ['9901'] },
                payload: { result: { pageItems: [{
                    productId: Number(SOURCE_SPU), goodsId: 9901, productName: '接入验收商品',
                    productSkuSummaries: [{ productSkuId: 79322569001 }]
                }] } }
            }]
        };
        const response = await submitAccountIngest({ origin: listenOrigin, token: TOKEN, packet, fileName: 'integration.json' });
        const body = await response.json().catch(() => null);
        assert.ok(response.ok, `入队 HTTP 失败：${response.status} ${JSON.stringify(body)}`);
        const [rows] = await isolatedPool.query('SELECT COUNT(*) AS n FROM hub_account_work WHERE store_id=?', [SOURCE_STORE]);
        const count = Number(rows[0]?.n || 0);
        assert.ok(count > 0, `HTTP 入队后 hub_account_work 应产生行，实际 ${count}（server.mjs 尚未接入账户账本）`);
        return { accountWorkRows: count };
    });

    // 2) 真实 worker 必须能读取指定原始文件并产出结果；空 worker 的 {ready:true} 不算业务完成。
    //    这里直接 fork worker：监督器只把 ready 用于"启动成功"判定，不下发也不上报业务结果，
    //    所以必须直接观察子进程对初始任务的回执。
    await check('worker_reads_assigned_source', '真实 worker 必须读取被分配的原始文件', async () => {
        const { fork } = await import('node:child_process');
        // 准备一份真实的原始文件：worker 若真的读取，就能算出内容哈希。
        const sourcePath = path.join(tempRoot, 'assigned-source.json');
        await writeFile(sourcePath, JSON.stringify({ spuId: '880000902', productName: '接入验收商品', skus: [] }), 'utf8');
        const worker = fork(path.join(hubDir, 'workers', 'account-worker.mjs'), [], {
            // 与监督器一致的最小环境：worker 从环境读取账户绑定。
            env: {
                PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV || 'production',
                LANG: process.env.LANG || 'C.UTF-8', TEMP: process.env.TEMP, TMP: process.env.TMP,
                SYSTEMROOT: process.env.SYSTEMROOT,
                WORKER_ACCOUNT_ID: 'temu:990000902', WORKER_SUPERVISOR_EPOCH: '1',
                // 路径引用只能由父端签发：worker 以这个目录为根解析相对引用，
                // 绝对路径会被它独立拦住（这是设计，不是缺陷）。
                WORKER_SOURCE_ROOT: tempRoot
            },
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
        });
        try {
            const reply = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('worker 未回执（8s）')), 8000);
                worker.on('message', message => {
                    // ready 是启动握手，不是任务结果；只认 start 的结果回执。
                    if (!message || message.type === 'ready') return;
                    if (message.type === 'started') return;
                    clearTimeout(timer);
                    resolve(message);
                });
                worker.once('error', error => { clearTimeout(timer); reject(error); });
                worker.once('exit', code => { clearTimeout(timer); reject(new Error(`worker 提前退出 code=${code}`)); });
                worker.send({ protocol: 1, operation: 'start', accountId: 'temu:990000902', supervisorEpoch: 1,
                    // 传相对引用：绝对路径会被 worker 的路径校验拒绝。
                    workId: 'integration-work', sourceRef: path.relative(tempRoot, sourcePath) });
            });
            assert.equal(reply.type, 'prepared', `worker 应回报 prepared，实际 ${JSON.stringify(reply)}`);
            // 空实现回的是 {ready:true}：既没读文件、也没产出业务结果。
            const result = reply.result || {};
            assert.ok(result.sourceRead === true || result.contentHash,
                `worker 必须读取被分配的原始文件并产出可核对结果，实际回执 ${JSON.stringify(reply)}`);
            return { workerReply: reply.type, workerResult: result };
        } finally {
            try { worker.kill(); } catch {}
            await waitForExit(worker, 3000);
        }
    });

    // 3) 业务结果必须落到**对应的**权威表，而不是只在工作索引里打转。
    //    上传的权威表是 hub_batches / hub_batch_products（hub_jobs 是分发/上架路径的表）——
    //    上一版这里断言 hub_jobs，等于用错了表：上传本来就不写它。
    /**
     * 业务结果必须落到权威表——但要按**两段式语义**核对。
     *
     * on 模式下受理响应是 202 accepted，此刻**故意不写** hub_batches：
     * 商品要等账户运行器执行成功后才提交（计划任务 5）。
     * 因此这里必须等运行器把工作结算完，再核对权威表；
     * 直接在上传后立即查表，等于用旧的"导入即完成"语义断言新流程，必然误判。
     */
    await check('business_result_lands_in_authoritative_tables', '运行器执行完成后必须写入 hub_batches 与商品明细', async () => {
        let batchCount = 0, itemCount = 0;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const [[batch]] = await isolatedPool.query(
                'SELECT COUNT(*) AS n FROM hub_batches WHERE store_id=?', [SOURCE_STORE]);
            const [[items]] = await isolatedPool.query(
                `SELECT COUNT(*) AS n FROM hub_batch_products p JOIN hub_batches b ON b.id=p.batch_id WHERE b.store_id=?`,
                [SOURCE_STORE]);
            batchCount = Number(batch?.n || 0);
            itemCount = Number(items?.n || 0);
            if (batchCount > 0 && itemCount > 0) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(batchCount > 0, `运行器完成后必须写入 hub_batches，实际 ${batchCount}\n${output.slice(-5000)}`);
        assert.ok(itemCount > 0, `运行器完成后必须写入商品明细 hub_batch_products，实际 ${itemCount}`);
        return { batches: batchCount, items: itemCount };
    });
} catch (error) {
    checks.push({ id: 'harness', title: '接入验收环境可运行', status: 'FAIL', reason: String(error?.message || error),
        // 带上服务端输出：否则"服务起不来"会退化成一句无信息量的退出码，
        // 让人分不清是脚本配置错、库不通，还是服务自身故障。
        serverOutput: output.slice(-2000) });
} finally {
    try { await stopChild(child); } catch (error) { checks.push({ id: 'teardown', title: '测试服务已退出', status: 'FAIL', reason: String(error?.message || error) }); }
    if (isolatedPool) { try { await isolatedPool.end(); } catch {} }
    if (isolated) { try { await isolated.drop(); } catch {} }
    if (tempRoot) { try { await rm(tempRoot, { recursive: true, force: true }); } catch {} }
}

const failed = checks.filter(item => item.status !== 'PASS');
console.log(JSON.stringify({
    passed: failed.length === 0,
    checks,
    failedCount: failed.length,
    // 判断服务端**是否真的启用了账户执行链**：读启动日志里的启用行。
    // 早先这里 grep 模块名，而日志里根本不会出现模块名，永远为 false——一个没有意义的字段。
    accountChainEnabled: /账户执行链已启用\s+mode=/.test(output),
    realPlatformCalls: 0,
    productionChanged: false
}, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
