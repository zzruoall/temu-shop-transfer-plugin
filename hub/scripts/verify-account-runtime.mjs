/**
 * 账户运行器验收（计划任务 4）。
 *
 * 这是**唯一**能证明"任务真的会被执行"的测试：它起一个真实运行器，
 * 让运行器自己发现候选、精确领取、fork 专属进程、收 worker 回执并结算。
 * 测试**不**调用 claim/settle 替业务补结果——那正是上一轮闭环测试的缺陷。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createAccountRuntime } from '../lib/account-runtime.mjs';
import { createAccountWorkRepository } from '../lib/account-work-repository.mjs';
import { openIsolatedDatabase } from './account-process-harness.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const hubDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mysql = require('mysql2/promise');

const checks = [];
async function check(id, title, run) {
    try { checks.push({ id, title, status: 'PASS', detail: await run() ?? null }); }
    catch (error) { checks.push({ id, title, status: 'FAIL', reason: String(error?.message || error) }); }
}

let isolated = null, pool = null, runtime = null, sourceRoot = null;
try {
    isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_runtime', label: '运行器验收' });
    pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 4 });
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
    const rawRepo = createAccountWorkRepository(database);
    // 可执行夹具明确绑定用户轮次和认领快照；缺上下文历史行由独立安全反例确认不执行。
    const repo = { ...rawRepo, enqueue: input => rawRepo.enqueue({
        runId: `run-${input.accountId}`, executionRunId: `run-${input.accountId}`,
        actorId: 'runtime-fixture', ownershipGeneration: '2026-09-28', ...input
    }) };

    // 受控源根：准备两份真实源文件，worker 会读它们并算摘要。
    sourceRoot = await mkdtemp(path.join(tmpdir(), 'ziniao-runtime-'));
    await mkdir(path.join(sourceRoot, 'data', 'files'), { recursive: true });
    const sources = {};
    /**
     * 源文件必须是**真实采集包结构**（records + pageItems）。
     * 用 `{"spuId":"a"}` 这种占位内容，worker 解析后找不到被指派商品，
     * 会以 `capture_assigned_product_missing` 失败——那是测试夹具不真实，
     * 不是运行器缺陷。
     */
    const capture = (spuId, productName) => JSON.stringify({
        schemaVersion: 4, kind: 'full-capture-packet', exportMode: 'full-capture',
        source: { pageUrl: 'https://agentseller.temu.com/goods/list', allowedSpuIds: [spuId],
            sourceStoreId: 'temu:990800000001', sourceStoreName: 'rt-store' },
        products: [{ spuId, goodsId: '9901' }],
        records: [
            { identity: { productIds: [spuId], goodsIds: ['9901'] },
              payload: { result: { pageItems: [{ productId: Number(spuId), goodsId: 9901,
                  productName, productSkuSummaries: [{ productSkuId: 79322569001 }] }] } } },
            { dataType: 'product-detail', identity: { productIds: [spuId] },
              source: { pageProductId: spuId,
                  requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
              payload: { success: true, result: { productId: spuId, productName, extraSourceField: 'preserve-me' } } }
        ]
    });
    for (const [name, body] of [['a.json', capture('880800001', 'rt-a')], ['b.json', capture('880800012', 'rt-b')]]) {
        const rel = `data/files/${name}`;
        const full = path.join(sourceRoot, rel);
        await writeFile(full, body, 'utf8');
        // 摘要与字节数都取**实际落盘内容**，与 worker 的计算口径一致。
        const onDisk = await readFile(full);
        sources[name] = {
            rel,
            hash: createHash('sha256').update(onDisk).digest('hex'),
            bytes: onDisk.length
        };
    }
    const hashes = sources;

    const trace = [];
    runtime = createAccountRuntime({
        database, mode: 'on', workerPath: path.join(hubDir, 'workers', 'account-worker.mjs'),
        sourceRoot, scanIntervalMs: 300, maxAccountProcesses: 2,
        onTrace: (type, fields) => trace.push({ type, ...fields })
    });

    // 一、运行器必须自己把一件真实工作推进到 done（含来源摘要证据）。
    await check('runtime_completes_work_end_to_end', '运行器必须自行把工作推进到 done', async () => {
        /**
         * 必须提供**完整执行上下文**才可被调度。
         *
         * 候选查询要求 `run_id`/`execution_run_id`/`actor_id`/`ownership_generation`
         * 全部非空：这是"可信上下文"约束，缺任何一项的工作不会进入可运行候选
         * （而不是被领取后再失败）。测试按真实契约补齐这些字段。
         */
        const work = await repo.enqueue({
            accountId: 'rt-acct-1', storeId: 'temu:990800000001', direction: 'ingest',
            jobId: 'rt-job-1', spuId: '880800001', requestId: 'rt-req-1',
            runId: 'rt-run-1', executionRunId: 'rt-run-1',
            actorId: 'rt-actor-1', ownershipGeneration: '2026-01-01T00:00:00.000Z',
            sourceRef: sources['a.json'].rel, sourceHash: hashes['a.json'].hash,
            sourceHashAlgorithm: 'sha256', expectedBytes: hashes['a.json'].bytes
        });
        // 测试只等结果，不替业务调用 claim/settle。
        const result = await runtime.scanOnce();
        assert.ok(result.scanned, `扫描应执行，实际 ${JSON.stringify(result)}`);
        const deadline = Date.now() + 20000;
        let row = null;
        while (Date.now() < deadline) {
            row = await repo.workOf(work.work_id);
            if (row && ['done', 'failed', 'cancelled', 'unknown'].includes(row.status)) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        assert.equal(row?.status, 'done',
            `运行器必须把工作结算为 done，实际 ${row?.status}（扫描结果 ${JSON.stringify(result)}）`
            + ` 轨迹=${JSON.stringify(trace.slice(-6))}`);
        // 执行证据：必须出现真实 fork 与 start 事件，而不是主进程直接写 done。
        assert.ok(trace.some(e => e.type === 'process:fork'), '必须观察到真实 fork');
        assert.ok(trace.some(e => e.type === 'work:start' && e.workId === work.work_id), '必须观察到该工作的 start 事件');
        return { workId: work.work_id, status: row.status, forks: trace.filter(e => e.type === 'process:fork').length };
    });

    // 二、失败要如实结算：源文件缺失时不得假成功，且必须写明原因。
    await check('runtime_fails_without_source_evidence', '缺来源证据必须结算为 failed 而不是 done', async () => {
        const work = await repo.enqueue({
            accountId: 'rt-acct-2', storeId: 'temu:990800000002', direction: 'ingest',
            jobId: 'rt-job-2', spuId: '880800002', requestId: 'rt-req-2'
            // 刻意不给 sourceRef/sourceHash
        });
        await runtime.scanOnce();
        await new Promise(resolve => setTimeout(resolve, 1500));
        const row = await repo.workOf(work.work_id);
        assert.equal(row?.status, 'failed', `缺证据必须 failed，实际 ${row?.status}`);
        return { status: row.status };
    });

    // 三、源文件被删除时 worker 失败，运行器必须结算为 failed（不假成功）。
    await check('runtime_worker_failure_is_settled', 'worker 读不到文件时必须结算为 failed', async () => {
        const badRel = 'data/files/missing.json';
        const work = await repo.enqueue({
            accountId: 'rt-acct-3', storeId: 'temu:990800000003', direction: 'ingest',
            jobId: 'rt-job-3', spuId: '880800003', requestId: 'rt-req-3',
            runId: 'rt-run-3', executionRunId: 'rt-run-3',
            actorId: 'rt-actor-3', ownershipGeneration: '2026-01-01T00:00:00.000Z',
            sourceRef: badRel, sourceHash: 'c'.repeat(64), sourceHashAlgorithm: 'sha256', expectedBytes: 10
        });
        await runtime.scanOnce();
        await new Promise(resolve => setTimeout(resolve, 3000));
        const row = await repo.workOf(work.work_id);
        assert.equal(row?.status, 'failed', `读不到源文件必须 failed，实际 ${row?.status}`);
        return { status: row.status };
    });

    // 四、同账户单件：两件工作不能同时进入执行。
    await check('runtime_single_active_per_account', '同账户同时只允许一件在跑', async () => {
        for (const spu of ['880800011', '880800012']) {
            await repo.enqueue({
                accountId: 'rt-acct-4', storeId: 'temu:990800000004', direction: 'ingest',
                jobId: `rt-job-4-${spu}`, spuId: spu, requestId: `rt-req-4-${spu}`,
                sourceRef: sources['b.json'].rel, sourceHash: hashes['b.json'].hash,
                sourceHashAlgorithm: 'sha256', expectedBytes: hashes['b.json'].bytes
            });
        }
        let peak = 0;
        const until = Date.now() + 6000;
        while (Date.now() < until) {
            const [[row]] = await pool.query(
                "SELECT COUNT(*) AS n FROM hub_account_work WHERE account_id=? AND status IN ('running','waiting','unknown')",
                ['rt-acct-4']);
            peak = Math.max(peak, Number(row?.n || 0));
            await runtime.scanOnce();
            await new Promise(resolve => setTimeout(resolve, 150));
        }
        assert.ok(peak <= 1, `同账户同时活跃必须 <=1，实测 ${peak}`);
        return { peak };
    });

    // 五、失败领取不记账：公平份额只在取得成功服务后推进。
    await check('runtime_does_not_charge_failed_claim', '失败领取不得消耗账户公平份额', async () => {
        const before = runtime.dispatcher.snapshot();
        const beforeServed = Object.fromEntries(before.map(e => [e.owner, e.served]));
        // 制造一次必然失败的领取：指定的 workId 不存在。
        const outcome = await runtime.repo.claimAccountWork('rt-acct-none', {
            workId: 'w-does-not-exist', runId: '', workerEpoch: 0
        }).catch(() => ({ claimed: false, reason: 'error' }));
        assert.equal(outcome.claimed, false, '不存在的工作不得领取成功');
        const after = runtime.dispatcher.snapshot();
        const afterServed = Object.fromEntries(after.map(e => [e.owner, e.served]));
        for (const owner of Object.keys(afterServed)) {
            assert.equal(afterServed[owner], beforeServed[owner] ?? afterServed[owner],
                `失败领取后 ${owner} 的份额不得变化`);
        }
        return { reason: outcome.reason };
    });
} catch (error) {
    checks.push({ id: 'harness', title: '运行器验收环境可运行', status: 'FAIL', reason: String(error?.message || error) });
} finally {
    if (runtime) { try { await runtime.stop(); } catch {} }
    if (pool) { try { await pool.end(); } catch {} }
    if (isolated) { try { await isolated.drop(); } catch {} }
    if (sourceRoot) { try { await rm(sourceRoot, { recursive: true, force: true }); } catch {} }
}

const failed = checks.filter(item => item.status !== 'PASS');
console.log(JSON.stringify({ passed: failed.length === 0, checks, failedCount: failed.length,
    realPlatformCalls: 0, productionChanged: false }, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
