/** 独立运行器反例：真实子进程与隔离库，不用测试替业务领取或写入成功。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createAccountRuntime } from '../lib/account-runtime.mjs';
import { createAccountWorkRepository } from '../lib/account-work-repository.mjs';
import { openIsolatedDatabase } from './account-process-harness.mjs';

const checks = [];
const root = await mkdtemp(path.join(tmpdir(), 'account-safety-'));
let isolated, pool, runtime;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    isolated = await openIsolatedDatabase({ prefix: 'temu_runtime_safety', label: '运行器安全边界' });
    pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 4 });
    const database = {
        query: (_lane, sql, params = []) => pool.query(sql, params),
        async transaction(_lane, fn) {
            const conn = await pool.getConnection();
            try {
                await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
                await conn.beginTransaction();
                const value = await fn(conn);
                await conn.commit();
                return value;
            } catch (error) { await conn.rollback(); throw error; }
            finally { conn.release(); }
        }
    };
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    await pool.query('CREATE TABLE safety_business (id VARCHAR(255) PRIMARY KEY)');
    const repo = createAccountWorkRepository(database);
    await mkdir(path.join(root, 'data'), { recursive: true });
    // 默认worker现在真实解析单商品，安全夹具也必须提供可解析原包而非任意占位文本。
    const body = JSON.stringify({ kind: 'full-capture-packet', products: ['legacy', 'bad-hash', 'repeat', 'rollback', 'blocked', 'ready'].map(spuId => ({ spuId })), records: [] });
    await writeFile(path.join(root, 'data/source.json'), body);
    const source = { sourceRef: 'data/source.json', sourceHash: createHash('sha256').update(body).digest('hex'),
        sourceHashAlgorithm: 'sha256', expectedBytes: Buffer.byteLength(body) };
    let commits = 0;
    const replies = [];
    const makeRuntime = (onCommit = async () => { commits += 1; }) => createAccountRuntime({
        database, sourceRoot: root, scanIntervalMs: 100, idleExitMs: 50,
        workerPath: fileURLToPath(new URL('../workers/account-worker.mjs', import.meta.url)), onCommit,
        onTrace: (type, fields) => replies.push({ type, ...fields })
    });
    const enqueue = (account, extra = {}) => repo.enqueue({
        accountId: account, storeId: `store-${account}`, direction: 'ingest', spuId: account,
        requestId: account, runId: `run-${account}`, executionRunId: `run-${account}`,
        actorId: 'plugin-1', ownershipGeneration: '2026-09-28', ...source, ...extra
    });
    const waitTerminal = async work => {
        const until = Date.now() + 5000;
        while (Date.now() < until) {
            const row = await repo.workOf(work.work_id);
            if (['done', 'failed', 'cancelled', 'unknown'].includes(row.status)) return row;
            await sleep(30);
        }
        return repo.workOf(work.work_id);
    };
    const check = async (name, fn) => {
        commits = 0;
        try { await fn(); checks.push({ name, passed: true }); }
        catch (error) { checks.push({ name, passed: false, reason: error.message }); }
        finally {
            await runtime?.stop(); runtime = null;
            // 仅清理本脚本创建的隔离库，避免前一个反例的待确认行影响后续断言。
            for (const table of ['hub_account_work', 'hub_account_runtime', 'hub_process_control', 'hub_process_leases', 'hub_worker_messages']) {
                await pool.query(`DELETE FROM ${table}`);
            }
        }
    };
    await check('无轮次历史工作不得自动执行', async () => {
        runtime = makeRuntime();
        const work = await enqueue('legacy', { runId: '', executionRunId: '' });
        await runtime.scanOnce(); await sleep(500);
        assert.equal(commits, 0);
        assert.equal((await repo.workOf(work.work_id)).status, 'queued');
    });
    await check('摘要不匹配不得提交业务', async () => {
        runtime = makeRuntime();
        const work = await enqueue('bad-hash', { sourceHash: 'f'.repeat(64) });
        await runtime.scanOnce();
        assert.equal((await waitTerminal(work)).status, 'failed');
        assert.equal(commits, 0);
    });
    await check('重复或伪造回执不能再次调用业务提交', async () => {
        runtime = makeRuntime();
        const work = await enqueue('repeat');
        await runtime.scanOnce();
        assert.equal((await waitTerminal(work)).status, 'done');
        await runtime.handleWorkerReply({ accountId: 'repeat', workId: work.work_id, epoch: 999, type: 'prepared', result: {} });
        assert.equal(commits, 1);
    });
    await check('业务写入异常必须与结算一起回滚', async () => {
        let usedTransaction = false;
        runtime = makeRuntime(async ({ connection, work }) => {
            assert.ok(connection?.query, '提交必须取得同一个事务连接');
            await connection.query('INSERT INTO safety_business VALUES(?)', [work.work_id]);
            usedTransaction = true;
            throw Error('injected_business_failure');
        });
        const work = await enqueue('rollback');
        await runtime.scanOnce();
        assert.equal((await waitTerminal(work)).status, 'failed');
        assert.equal(usedTransaction, true, '不能把缺少事务连接导致提前失败算作回滚通过');
        const [[count]] = await pool.query('SELECT COUNT(*) AS n FROM safety_business');
        assert.equal(Number(count.n), 0);
    });
    await check('未知占槽账户不能阻塞其他账户', async () => {
        runtime = makeRuntime();
        const blocked = await enqueue('blocked');
        await pool.query("INSERT INTO hub_account_runtime(account_id,current_work_id,store_id,run_id,state,updated_at) VALUES(?,?,?,?, 'unknown',?)",
            ['blocked', 'old-unknown', 'store-blocked', 'old-run', new Date().toISOString()]);
        const ready = await enqueue('ready');
        await runtime.scanOnce();
        assert.equal((await waitTerminal(ready)).status, 'done');
        assert.equal((await repo.workOf(blocked.work_id)).status, 'queued');
    });
} finally {
    await runtime?.stop();
    await pool?.end();
    await isolated?.drop();
    // mkdtemp 返回的绝对目录必须仍在系统临时根，才允许递归清理。
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) await rm(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ checks, passed: checks.every(c => c.passed), productionChanged: false }, null, 2));
process.exitCode = checks.every(c => c.passed) ? 0 : 1;
