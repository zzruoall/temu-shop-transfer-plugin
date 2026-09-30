/**
 * 账户工作流闭环验收（计划任务 0）。
 *
 * 与 `verify-account-integration.mjs` 的分工：
 * - integration 检查三个**组件**是否各自可用（HTTP 能入队、worker 能读文件、权威表有行）；
 * - 本脚本检查它们是不是**同一件商品的同一条因果链**——HTTP 受理的 requestId/workId
 *   由主服务自己发现候选、自己 fork、自己结算，而不是测试分别拼出来的三件事。
 *
 * 因此本脚本**禁止**直接调用 claim/settle 给业务补结果，也禁止测试自己 fork worker
 * 冒充主服务。它只发 HTTP，然后观察服务端是否自己把链路跑完。
 *
 * 必须观察实际入库、平台许可、unknown占槽和终态回执；仅HTTP受理或存在队列行不算闭环。
 */
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
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
const repoRoot = path.dirname(hubDir);
const INSTANCE_ID = randomBytes(8).toString('hex');
const TOKEN = `workflow-${randomBytes(6).toString('hex')}`;
const mysql = require('mysql2/promise');

const checks = [];
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
            killer.once('exit', resolve); killer.once('error', resolve);
        });
    }
}
async function waitForServer(child, origin, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (child.exitCode != null) throw new Error(`server exited with code ${child.exitCode}`);
        try {
            const response = await fetch(`${origin}/api/ingest-info`, { signal: AbortSignal.timeout(2000) });
            if (response.ok || response.status === 401) return true;
        } catch {}
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('服务未就绪');
}

/** 4 账户 × 3 店 × 10 商品的认领与店铺夹具（合成值，不触达真实店铺）。 */
function fixture() {
    const accounts = [];
    for (let a = 0; a < 4; a += 1) {
        const accountId = `wf-acct-${String(a + 1).padStart(2, '0')}`;
        const stores = [];
        for (let s = 0; s < 3; s += 1) {
            const mallId = String(990100000000 + a * 100 + s);
            stores.push({ storeId: `temu:${mallId}`, mallId, storeName: `${accountId}-店${s}` });
        }
        accounts.push({ accountId, stores });
    }
    return accounts;
}

/** 生成一份真实结构的采集包（records + pageItems）。 */
function packetFor(store, spuId, productName) {
    return {
        schemaVersion: 4,
        kind: 'full-capture-packet',
        exportMode: 'full-capture',
        source: { pageUrl: 'https://agentseller.temu.com/goods/list', allowedSpuIds: [spuId],
            sourceStoreId: store.storeId, sourceStoreName: store.storeName },
        products: [{ spuId, goodsId: '9901' }],
        records: [{
            identity: { productIds: [spuId], goodsIds: ['9901'] },
            payload: { result: { pageItems: [{
                productId: Number(spuId), goodsId: 9901, productName,
                productSkuSummaries: [{ productSkuId: 79322569001 }]
            }] } }
        }, { dataType: 'product-detail', identity: { productIds: [spuId] },
            source: { pageProductId: spuId, requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
            payload: { success: true, result: { productId: spuId, productName, extraSourceField: 'preserve-me' } }
        }]
    };
}

let isolated = null, pool = null, child = null, tempRoot = null, output = '';
try {
    isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_workflow', label: '工作流闭环验收' });
    // 观察连接不参与业务并发，留出隔离MySQL的控制余量，服务自身仍使用真实14连接分区。
    pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 2 });
    const database = {
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
    // 只用于**只读**核对因果链（workOf 查询）；结算与领取由服务端负责，测试不代写终态。
    const { createAccountWorkRepository } = await import('../lib/account-work-repository.mjs');
    const repo = createAccountWorkRepository(database);

    tempRoot = await mkdtemp(path.join(tmpdir(), 'ziniao-workflow-'));
    await pool.query(
        `INSERT INTO hub_schema(id,version,state,data_root,manifest) VALUES(1,1,'ready',?,NULL)
         ON DUPLICATE KEY UPDATE version=VALUES(version),state=VALUES(state),data_root=VALUES(data_root)`,
        [tempRoot]);
    // 认领关系：4 账户各自认领自己的 3 家店。归属必须可信，否则账本不登记。
    for (const account of fixture()) {
        for (const store of account.stores) {
            await pool.query(
                `INSERT INTO hub_map_entries(domain,entry_key,body) VALUES('ownership',?,?)
                 ON DUPLICATE KEY UPDATE body=VALUES(body)`,
                [store.storeId, JSON.stringify({ ownerId: account.accountId, ownerName: account.accountId, storeName: store.storeName, claimedAt: '2026-09-28T00:00:00.000Z' })]);
        }
    }
    /**
     * 受控源根必须与**服务端写文件的位置**一致。
     *
     * `sourceRef` 是 `data/files/<name>`，相对于 `ZINIAO_DATA_ROOT`；
     * 之前把根设成 `tempRoot/sources`，worker 解析出 `tempRoot/sources/data/files/...`，
     * 必然 ENOENT 并被结算成 failed（复核也指出过这处契约不一致）。
     * 源根就是 dataRoot，与服务端传给运行器的值保持同一个。
     */
    const sourceRoot = tempRoot;
    const mysqlConfigPath = path.join(tempRoot, 'mysql.json');
    await writeFile(mysqlConfigPath, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name }));

    const PORT = String(await pickFreePort());
    const origin = `http://127.0.0.1:${PORT}`;
    child = fork(path.join(hubDir, 'server.mjs'), [], {
        cwd: hubDir,
        env: {
            ...process.env,
            ZINIAO_BIND: '127.0.0.1', ZINIAO_PORT: PORT,
            ZINIAO_INGEST_TOKEN: TOKEN, ZINIAO_DATA_ROOT: tempRoot,
            ZINIAO_SKIP_SEED: '1', ZINIAO_SEED: '0', ZINIAO_INSTANCE_ID: INSTANCE_ID,
            ZINIAO_WATCH_DIR: path.join(tempRoot, 'inbox'),
            TEMU_MYSQL_CONFIG: mysqlConfigPath, TEMU_CREDENTIALS: '',
            ZINIAO_ACCOUNT_PROCESS_MODE: 'on',
            ZINIAO_SERVICE_MEMORY_BYTES: String(768 * 1024 * 1024),
            ZINIAO_WORKER_SOURCE_ROOT: sourceRoot
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true
    });
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });
    await waitForServer(child, origin);

    /**
     * 一、真实因果链：HTTP 受理的 requestId/workId 必须由主服务自己走到终态。
     *
     * 断言要点（复核指出的不足）：
     * - 必须绑定**同一条** work（用 HTTP 回执里的 workId 定位），不能只按店铺/SPU 找行；
     * - "通过"必须以发生过执行为前提：完成态必须伴随来源摘要（worker 读过源文件才能算出），
     *   主进程直接把状态写成 done 不算通过。
     */
    await check('http_request_completes_via_account_worker', 'HTTP 受理的同一 work 必须由主服务自行处理到终态', async () => {
        const accounts = fixture();
        const store = accounts[0].stores[0];
        const spuId = '8801000001';
        const response = await submitAccountIngest({ origin, token: TOKEN, packet: packetFor(store, spuId, '闭环商品'), fileName: 'workflow.json' });
        const body = await response.json().catch(() => null);
        assert.ok(response.ok, `HTTP 入队失败：${response.status} ${JSON.stringify(body)}`);

        // 回执必须给出账户工作标识：没有它就无法把"受理"与"执行"绑定成一条链。
        const acceptedWorkId = body?.accountWork?.workId || '';
        assert.ok(acceptedWorkId, `HTTP 回执必须带 workId 以便绑定因果链，实际 accountWork=${JSON.stringify(body?.accountWork)}`);

        const deadline = Date.now() + 40000;
        let work = null;
        while (Date.now() < deadline) {
            work = await repo.workOf(acceptedWorkId);
            if (work && ['done', 'failed', 'cancelled', 'unknown'].includes(work.status)) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(work, '受理后必须产生对应 work 行');
        assert.equal(work.status, 'done', `主服务必须把该 work 处理到 done，实际 ${work?.status}（运行器尚未接入）`);
        // 执行证据：来源摘要必须落库（worker 读过源文件才能算出）。
        assert.ok(work.source_hash && work.source_hash.length === 64,
            `done 必须伴随来源摘要，实际 "${work.source_hash}"——主进程直接写 done 不算通过`);
        return { workId: work.work_id, status: work.status, sourceHash: work.source_hash.slice(0, 16) };
    });

    /**
     * 二、同账户合计单件：同时注入**上传与上架**两个方向，且必须观察到实际活动。
     *
     * 复核指出原断言的两处问题：只发上传（没有上架）、peak=0 也算通过。
     * "没有任何活动"不能证明互斥，只能证明没跑起来——这里要求确实登记了同账户工作。
     */
    await check('same_account_single_active_item', '同账户上传与上架合计最多一件在处理', async () => {
        const accounts = fixture();
        const account = accounts[1];
        // 上传方向：同一账户的 3 家店同时提交。
        const uploads = account.stores.map((store, index) => submitAccountIngest({ origin, token: TOKEN,
            packet: packetFor(store, `88010010${index}0`, `并发商品${index}`), fileName: `c${index}.json`
        }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }), error => ({ status: 'error', reason: error.message })));
        /**
         * 上架方向：必须引用**确实已入库**的批次与商品。
         *
         * 上传请求是并发发出的，此刻可能还没落库；所以先等这一批入库完成，
         * 再取该店的真实批次 ID。用不存在的批次/未上传的 SPU 会被服务端 400 拒绝，
         * 那样等于没注入第二个方向，"互斥"也就无从验证（复核实测正是如此）。
         */
        await Promise.allSettled(uploads);
        const uploadedSpu = `88010010${0}0`;
        let batchRow = null;
        for (let i = 0; i < 40 && !batchRow; i += 1) {
            const [[found]] = await pool.query(
                `SELECT b.id AS id FROM hub_batches b
                 JOIN hub_batch_products p ON p.batch_id = b.id
                 WHERE b.store_id=? AND p.spu_id=? LIMIT 1`,
                [account.stores[0].storeId, uploadedSpu]);
            if (found?.id) batchRow = found;
            else await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.ok(batchRow?.id, `必须能取到该店的真实批次以构造有效上架请求（SPU ${uploadedSpu}）`);
        const target = account.stores[0];
        const identity = { ...target, pluginInstanceId: `fixture-${createHash('sha256').update(target.storeId).digest('hex').slice(0, 24)}`,
            pluginVersion: '10.10.67', executionMode: 'plugin-api', pluginDetected: true, identityMatched: true,
            pageStoreName: target.storeName, executionRunProtocol: 1, schedulingProtocol: 1,
            executionRunId: 'workflow-publish-round-0000001' };
        // 只模拟插件协议请求，不直接调用仓库领取/结算，运行器必须自己发现并准备工作。
        const post = async (route, value) => {
            const result = await fetch(`${origin}${route}`, { method: 'POST', headers: {
                'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-plugin-instance': identity.pluginInstanceId
            }, body: JSON.stringify(value), signal: AbortSignal.timeout(15000) });
            const json = await result.json();
            assert.ok(result.ok, `${route}: ${result.status} ${JSON.stringify(json)}`);
            return json;
        };
        await post('/api/agents/register', identity);
        await post('/api/jobs/execution-run', { ...identity, action: 'start', previousRunId: '' });
        const publish = fetch(`${origin}/api/jobs`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, 'x-plugin-instance': INSTANCE_ID },
            body: JSON.stringify({ sourceStoreId: account.stores[0].storeId, targetStoreId: account.stores[0].storeId,
                spuIds: [uploadedSpu], sourceBatchId: batchRow?.id || '',
                // 同店发送是合法操作，但**必须**由调用方显式确认——这是既有的业务硬约束，
                // 不能为了让测试通过而绕过它。
                sameStoreConfirmed: true, requireOnline: true, directCreate: true, complianceVersion: 'V2.0' }),
            signal: AbortSignal.timeout(15000)
        }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }), () => ({ status: 'error' }));
        const results = await Promise.all([...uploads, publish]);
        // 受理成功是 2xx（/api/jobs 成功返回 201）；把错误体一并带出，便于定位是哪一步失败。
        const statuses = results.map(item => item.status);
        const failures = results.filter(item => !(item.status >= 200 && item.status < 300));
        assert.deepEqual(failures, [], `真实上架受理失败：${JSON.stringify(failures)}`);
        const job = results.at(-1).body.job;
        let task;
        for (let i = 0; i < 80 && !task; i++) {
            const reply = await post('/api/jobs/claim', { ...identity, claimManualUploads: true, manualUploadsOnly: true,
                pendingUploadCount: 0, pendingUploadBytes: 0 });
            task = reply.claimed.find(item => item.jobId === job.id);
            if (!task) await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.ok(task, '真实运行器必须把publish准备成插件可领取任务');
        const base = { ...identity, jobId: job.id, spuId: uploadedSpu, claimToken: task.claimToken };
        await post('/api/jobs/report', { ...base, status: 'received', snapshotSha256: task.transferIntegrity.sha256 });
        const attempt = await post('/api/jobs/direct-progress', { ...base, phase: 'begin', requestHash: 'a'.repeat(64),
            authorizationKey: 'workflow-authorization-000001' });
        assert.ok(attempt.attemptId, `必须真正获得平台许可：${JSON.stringify(attempt)}`);
        await post('/api/jobs/direct-progress', { ...base, phase: 'unknown', attemptId: attempt.attemptId });
        // 同账户新上传必须等未知上架核对，其他账户仍可独立完成。
        const heldUpload = await submitAccountIngest({ origin, token: TOKEN,
            packet: packetFor(account.stores[2], '8801001099', '等待本账户上架结果') });
        const heldId = (await heldUpload.json()).accountWork.workId;
        const other = fixture()[2].stores[1];
        const otherResponse = await submitAccountIngest({ origin, token: TOKEN, packet: packetFor(other, '8801002099', '其他账户同时推进') });
        const otherId = (await otherResponse.json()).accountWork.workId;
        for (let i = 0; i < 80 && (await repo.workOf(otherId)).status !== 'done'; i++) await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal((await repo.workOf(otherId)).status, 'done');
        assert.equal((await repo.workOf(heldId)).status, 'queued');

        let peak = 0;
        const until = Date.now() + 1000;
        while (Date.now() < until) {
            const [[row]] = await pool.query(
                "SELECT COUNT(*) AS n FROM hub_account_work WHERE account_id=? AND status IN ('running','waiting','unknown')",
                [account.accountId]);
            peak = Math.max(peak, Number(row?.n || 0));
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        /**
         * 两方向的请求都必须被**受理**：上架请求若 400，就没有真正注入第二个方向，
         * "互斥"也就无从谈起（复核实测上架返回 400 而测试仍判通过）。
         */
        assert.deepEqual(failures, [],
            `两方向请求都必须受理成功；失败项=${JSON.stringify(failures.map(f => ({ status: f.status, error: f.body?.error })))}`
            + ` 全部状态=${JSON.stringify(statuses)}`);
        /**
         * 互斥必须建立在**确实发生过执行**之上。
         *
         * peak=0 只能说明"没跑"，不能证明"跑起来的不会重叠"——复核指出这正是假通过。
         * 因此这里要求观察到实际执行：没有运行器时必须失败（本项是任务 4 的出口）。
         */
        assert.ok(peak >= 1,
            `必须观察到实际执行才能断言互斥；峰值 ${peak} 说明没有任何账户工作真正在跑`
            + `；状态=${JSON.stringify(statuses)}`);
        assert.ok(peak <= 1, `同账户同时活跃必须 <=1，实测峰值 ${peak}`);
        await post('/api/jobs/direct-progress', { ...base, phase: 'created', attemptId: attempt.attemptId,
            productId: '9900112233', verified: true });
        for (let i = 0; i < 80 && (await repo.workOf(heldId)).status !== 'done'; i++) await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal((await repo.workOf(heldId)).status, 'done', '平台明确成功后本账户上传应继续');
        const [[publishWork]] = await pool.query('SELECT status FROM hub_account_work WHERE job_id=?', [job.id]);
        assert.equal(publishWork.status, 'done');
        return { peak, uploadStatuses: statuses, actualPublishCompleted: true, unknownBlockedOnlyOwnAccount: true };
    });

    /**
     * 三、其他账户并行推进：同样要求执行证据，不是"查到了行"就算。
     */
    await check('other_account_progresses', '其他账户必须能独立推进', async () => {
        const accounts = fixture();
        const target = accounts[2];
        const store = target.stores[0];
        const response = await submitAccountIngest({ origin, token: TOKEN, packet: packetFor(store, '8801002001', '并行商品'), fileName: 'p.json' });
        const body = await response.json().catch(() => null);
        const workId = body?.accountWork?.workId || '';
        assert.ok(workId, '回执必须带 workId');
        const deadline = Date.now() + 30000;
        let row = null;
        while (Date.now() < deadline) {
            row = await repo.workOf(workId);
            if (row && ['done', 'failed', 'cancelled', 'unknown'].includes(row.status)) break;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        assert.ok(row, '另一账户必须出现工作行');
        assert.equal(row.status, 'done', `另一账户的 work 必须自行完成，实际 ${row?.status}`);
        assert.ok(row.source_hash, '完成必须带来源摘要（执行证据）');
        return { accountId: target.accountId, status: row.status };
    });

    /**
     * 四、真实缺料：受理后**实际破坏**该 work 的源引用，必须明确失败且零业务提交。
     * 复核指出原断言只发正常包、absent/queued 也算通过——那样运行器修好后反而会失败。
     */
    await check('missing_source_refuses', '源文件不可读时必须明确失败而不是假成功', async () => {
        const accounts = fixture();
        const store = accounts[3].stores[0];
        const spuId = '8801003001';
        // 冻结领导授权但不改写业务终态，确保文件损坏发生在fork之前，消除测试时间竞争。
        const gate = await pool.getConnection();
        let workId;
        try {
            await gate.beginTransaction();
            await gate.query('SELECT id FROM hub_process_control WHERE id=1 FOR UPDATE');
            const response = await submitAccountIngest({ origin, token: TOKEN, packet: packetFor(store, spuId, '缺料商品'), fileName: 'm.json' });
            const body = await response.json().catch(() => null);
            workId = body?.accountWork?.workId;
            assert.ok(workId, '回执须带workId才能注入缺料');
            await gate.query('UPDATE hub_account_work SET source_ref=? WHERE work_id=?', ['definitely/missing.json', workId]);
            await gate.commit();
        } catch (error) { await gate.rollback(); throw error; }
        finally { gate.release(); }
        let row;
        for (let i = 0; i < 80; i++) {
            row = await repo.workOf(workId);
            if (row?.status === 'failed') break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.equal(row?.status, 'failed', '缺料必须明确失败，queued/running都不算处理完成');
        // 原始资料验证失败时，权威商品与完成状态都不能写入。
        const [[biz]] = await pool.query(
            'SELECT COUNT(*) AS n FROM hub_batch_products p JOIN hub_batches b ON b.id=p.batch_id WHERE b.store_id=? AND p.spu_id=?',
            [store.storeId, spuId]);
        assert.equal(Number(biz?.n || 0), 0,
            `缺料时不得提交业务结果，实际 ${Number(biz?.n || 0)} 行`);
        return { status: row?.status || 'absent', businessRows: Number(biz?.n || 0) };
    });

} catch (error) {
    checks.push({ id: 'harness', title: '闭环验收环境可运行', status: 'FAIL',
        reason: String(error?.message || error), serverOutput: output.slice(-1500) });
} finally {
    try { await stopChild(child); } catch {}
    if (pool) { try { await pool.end(); } catch {} }
    if (isolated) { try { await isolated.drop(); } catch {} }
    if (tempRoot) { try { await rm(tempRoot, { recursive: true, force: true }); } catch {} }
}

const failed = checks.filter(item => item.status !== 'PASS');
console.log(JSON.stringify({
    passed: failed.length === 0,
    checks,
    failedCount: failed.length,
    ...(failed.length ? { serverOutput: output.slice(-12000) } : {}),
    // 如实报告服务端是否真的启用了账户链（读启动日志，不猜）。
    accountChainEnabled: /账户执行链已启用\s+mode=/.test(output),
    realPlatformCalls: 0,
    productionChanged: false
}, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
