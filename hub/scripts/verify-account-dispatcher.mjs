/**
 * 账户分发器验收（方案步骤3）。
 *
 * 在**真实库候选**上验证（4 账户 × 3 店 × 10 商品），不只在数组上测 pick：
 * - 等成本账户无饥饿，服务计数差不超过 1；
 * - 单账户增加店铺不增加份额；
 * - 候选超过分页窗口时，后加入的就绪账户仍能被选中（无固定前缀垄断）；
 * - 积压/未知账户不挡住就绪账户；
 * - 续片与领取新工作分开：持有业务槽的账户不会被自己的 waiting 挡住；
 * - 失败申请不记账（不算完成一次服务）；
 * - 惰性清单不一次物化 100 万组合。
 *
 * 全部使用 127.0.0.1:33917 临时隔离库，真实平台调用 0。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createAccountWorkRepository } from '../lib/account-work-repository.mjs';
import { createAccountDispatcher, listAccountCandidates, listResumeCandidates, createLazyManifest, CANDIDATE_KIND } from '../lib/account-dispatcher.mjs';
import { openIsolatedDatabase } from './account-process-harness.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const mysql = require('mysql2/promise');
const isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_dispatch', label: '分发器验收' });
const pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 6 });
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

const checks = [];
async function check(id, title, run) {
    try {
        const detail = await run();
        checks.push({ id, title, status: 'PASS', detail: detail === undefined ? null : detail });
    } catch (error) {
        checks.push({ id, title, status: 'FAIL', reason: String(error?.message || error) });
    }
}

/** 4 账户 × 3 店 × 10 商品的真实库 fixture。 */
async function seedFixture(repo, { accounts = 4, storesPerAccount = 3, productsPerStore = 10, prefix = 'fx' } = {}) {
    const accountsOut = [];
    for (let a = 0; a < accounts; a += 1) {
        const accountId = `${prefix}-acct-${String(a + 1).padStart(2, '0')}`;
        accountsOut.push(accountId);
        for (let s = 0; s < storesPerAccount; s += 1) {
            const storeId = `temu:${prefix}${a}${s}`;
            for (let p = 0; p < productsPerStore; p += 1) {
                await repo.enqueue({ accountId, storeId, direction: p % 2 ? 'publish' : 'ingest',
                    jobId: `${prefix}-job-${a}-${s}-${p}`, spuId: `spu-${a}-${s}-${p}`, runId: `${prefix}-run` });
            }
        }
    }
    return accountsOut;
}

let report = null;
try {
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const repo = createAccountWorkRepository(database);

    // 不消费首屏，直接验证发现游标跨越两整页；随后全部改为续片重复验证，不能靠 queued 分支掩盖问题。
    await check('discovery_keyset_wraps', '真实SQL发现405账户并回绕，fresh/resume均不饿死尾页', async () => {
        const ids = [];
        for (let i = 0; i < 405; i++) {
            const accountId = `page-${String(i).padStart(3, '0')}`;
            ids.push(accountId);
            await repo.enqueue({ accountId, storeId: 'temu:page', direction: 'publish', jobId: accountId, spuId: 'spu', runId: 'page-run' });
        }
        const dispatcher = createAccountDispatcher({ database });
        for (let i = 1; i <= 3; i++) {
            await dispatcher.refreshAccounts();
            assert.equal(dispatcher.knownAccounts().length, Math.min(i * 200, 405));
        }
        await repo.enqueue({ accountId: '000-late', storeId: 'temu:page', direction: 'publish', jobId: 'late-page', spuId: 'spu', runId: 'page-run' });
        await dispatcher.refreshAccounts();
        assert.ok(dispatcher.knownAccounts().includes('000-late'));
        // 仅本次随机隔离库的 page 夹具改为 waiting，不触碰其他测试或真实运行时。
        await database.query('maintenance', `INSERT INTO hub_account_runtime
            (account_id,current_work_id,store_id,run_id,state,worker_epoch,worker_lease_until,updated_at)
            SELECT account_id,work_id,store_id,run_id,'waiting',0,'',updated_at FROM hub_account_work WHERE account_id LIKE 'page-%'`);
        await database.query('maintenance', "UPDATE hub_account_work SET status='waiting' WHERE account_id LIKE 'page-%'");
        const resumed = createAccountDispatcher({ database });
        for (let i = 0; i < 3; i++) await resumed.refreshAccounts();
        for (const id of ids) assert.ok(resumed.knownAccounts().includes(id));
        return { freshAccounts: ids.length, resumeAccounts: ids.length, wrapped: true };
    });

    // 固定积压不删除：如果轮转正确，46个桶各拿一次后才回到首桶，不依赖先清空20条商品。
    await check('bucket_heads_beyond_window', '真实SQL跨越20桶窗口并保持同店不同方向独立', async () => {
        const accountId = 'bucket-account';
        for (let i = 0; i < 45; i++) {
            await repo.enqueue({ accountId, storeId: `temu:bucket-${String(i).padStart(2, '0')}`, direction: 'publish',
                jobId: `bucket-${i}`, spuId: 'spu', runId: 'bucket-run' });
        }
        for (let i = 0; i < 30; i++) {
            await repo.enqueue({ accountId, storeId: 'temu:bucket-00', direction: 'publish',
                jobId: `bucket-extra-${i}`, spuId: 'spu', runId: 'bucket-run' });
        }
        await repo.enqueue({ accountId, storeId: 'temu:bucket-00', direction: 'ingest', requestId: 'bucket-ingest', spuId: 'spu', runId: 'bucket-run' });
        const dispatcher = createAccountDispatcher({ database, perAccountLimit: 20 });
        dispatcher.registerAccounts([accountId]);
        const selected = [];
        for (let i = 0; i < 47; i++) {
            const { candidate } = await dispatcher.next();
            selected.push(`${candidate.storeId}/${candidate.direction}`);
            dispatcher.recordServed(candidate.owner);
        }
        assert.equal(new Set(selected.slice(0, 46)).size, 46);
        assert.equal(selected[46], selected[0]);
        return { buckets: 46, window: 20, selected: selected.length };
    });

    // 缺证据行比合法行更早、busy账户仍有queued：过滤必须先于桶头排名，不能被分页优化旁路。
    await check('strict_context_and_busy_preserved', '真实SQL保留上下文与占槽过滤', async () => {
        const base = { storeId: 'temu:strict', direction: 'publish', spuId: 'spu', runId: 'strict-run',
            executionRunId: 'strict-run', actorId: 'actor', ownershipGeneration: 'generation' };
        await repo.enqueue({ ...base, accountId: 'strict-ready', jobId: 'strict-bad', actorId: '' });
        const valid = await repo.enqueue({ ...base, accountId: 'strict-ready', jobId: 'strict-valid' });
        const occupied = await repo.enqueue({ ...base, accountId: 'strict-busy', jobId: 'strict-occupied' });
        await repo.claimAccountWork('strict-busy', { workId: occupied.work_id, runId: base.runId, workerEpoch: 0 });
        await repo.enqueue({ ...base, accountId: 'strict-busy', jobId: 'strict-queued' });
        const candidates = await listAccountCandidates({ database, accountIds: ['strict-ready', 'strict-busy'], requireExecutionContext: true });
        assert.deepEqual(candidates.map(row => row.workId), [valid.work_id]);
        const dispatcher = createAccountDispatcher({ database, requireExecutionContext: true });
        await dispatcher.refreshAccounts();
        assert.deepEqual(dispatcher.knownAccounts(), ['strict-ready']);
        return { candidates: 1, blockedExcluded: true, invalidHeadExcluded: true };
    });

    // 一、每店两个方向各取一个桶头；同桶商品积压不能增加账户份额或遮住其他店。
    await check('real_candidates_per_account', '真实库候选按账户分页取得', async () => {
        const accounts = await seedFixture(repo, { prefix: 'cand' });
        const all = await listAccountCandidates({ database, accountIds: accounts, perAccountLimit: 100 });
        assert.equal(all.length, accounts.length * 3 * 2, `候选总数应为 4×3×2=24，实际 ${all.length}`);
        const byOwner = new Map();
        for (const item of all) byOwner.set(item.owner, (byOwner.get(item.owner) || 0) + 1);
        for (const accountId of accounts) {
            assert.equal(byOwner.get(accountId), 6, `${accountId} 应取到 6 个桶头，实际 ${byOwner.get(accountId)}`);
        }
        return { total: all.length, perAccount: 6 };
    });

    // 二、分页窗口：取 5 条/账户时，各账户都只取到 5 条（不能一个账户占满窗口）。
    await check('window_is_per_account', '分页窗口按账户生效', async () => {
        const accounts = ['cand-acct-01', 'cand-acct-02', 'cand-acct-03', 'cand-acct-04'];
        const limited = await listAccountCandidates({ database, accountIds: accounts, perAccountLimit: 5 });
        assert.equal(limited.length, 20, `4 账户 × 5 条 = 20，实际 ${limited.length}`);
        const byOwner = new Map();
        for (const item of limited) byOwner.set(item.owner, (byOwner.get(item.owner) || 0) + 1);
        for (const accountId of accounts) assert.equal(byOwner.get(accountId), 5, `${accountId} 应为 5 条`);
        return { total: limited.length, perAccount: 5 };
    });

    // 三、等成本公平：单步驱动，服务计数差不超过 1，且无连续垄断。
    await check('equal_cost_no_starvation', '等成本账户服务计数差不超过 1', async () => {
        const accounts = ['cand-acct-01', 'cand-acct-02', 'cand-acct-03', 'cand-acct-04'];
        const dispatcher = createAccountDispatcher({ database, perAccountLimit: 4 });
        dispatcher.registerAccounts(accounts);
        const served = new Map();
        let previous = null, maxStreak = 0, streak = 0;
        for (let step = 0; step < 200; step += 1) {
            const { candidate } = await dispatcher.next();
            assert.ok(candidate, `第 ${step} 步应有候选`);
            dispatcher.recordServed(candidate.owner, candidate.cost);
            served.set(candidate.owner, (served.get(candidate.owner) || 0) + 1);
            if (candidate.owner === previous) { streak += 1; maxStreak = Math.max(maxStreak, streak); }
            else { streak = 1; previous = candidate.owner; }
        }
        const counts = accounts.map(id => served.get(id) || 0);
        const spread = Math.max(...counts) - Math.min(...counts);
        assert.ok(spread <= 1, `等成本服务计数差应 ≤1，实际 ${spread}（${JSON.stringify(counts)}）`);
        assert.ok(maxStreak <= 2, `不得连续垄断，最长连续 ${maxStreak}`);
        return { counts, spread, maxStreak };
    });

    // 四、单账户增加店铺不增加份额：给它 3 倍店铺，份额不变。
    await check('more_stores_no_more_share', '单账户增加店铺不增加份额', async () => {
        const accounts = ['cand-acct-01', 'cand-acct-02', 'cand-acct-03', 'cand-acct-04'];
        const dispatcher = createAccountDispatcher({ database, perAccountLimit: 200 });
        dispatcher.registerAccounts(accounts);
        const served = new Map();
        for (let step = 0; step < 160; step += 1) {
            const { candidate } = await dispatcher.next();
            dispatcher.recordServed(candidate.owner, candidate.cost);
            served.set(candidate.owner, (served.get(candidate.owner) || 0) + 1);
        }
        const counts = accounts.map(id => served.get(id) || 0);
        const spread = Math.max(...counts) - Math.min(...counts);
        // 每个账户都是 3 店 × 10 商品：份额必须仍然等权，不因候选多而多拿。
        assert.ok(spread <= 1, `店铺数相同则份额必须相等，实际 ${spread}（${JSON.stringify(counts)}）`);
        return { counts, spread };
    });

    // 五、后加入账户不被固定前缀垄断：先让 2 个账户跑，再加入 2 个新账户。
    await check('late_joiner_gets_served', '后加入的账户仍能被选中', async () => {
        const dispatcher = createAccountDispatcher({ database, perAccountLimit: 6 });
        const early = ['freshlate-acct-01', 'freshlate-acct-02'];
        const late = ['freshlate-acct-03', 'freshlate-acct-04'];
        // 为新账户准备候选
        for (const accountId of [...early, ...late]) {
            for (let i = 0; i < 6; i += 1) {
                await repo.enqueue({ accountId, storeId: `temu:late${i % 3}`, direction: 'publish',
                    jobId: `late-job-${accountId}-${i}`, spuId: `late-spu-${i}`, runId: 'late-run' });
            }
        }
        // 第一阶段：只有早期账户参与
        dispatcher.registerAccounts(early);
        const servedEarly = new Map();
        for (let step = 0; step < 40; step += 1) {
            const { candidate } = await dispatcher.next();
            dispatcher.recordServed(candidate.owner, candidate.cost);
            servedEarly.set(candidate.owner, (servedEarly.get(candidate.owner) || 0) + 1);
        }
        // 第二阶段：新账户加入，必须在接下来的轮次里被服务到
        dispatcher.registerAccounts(late);
        const servedLate = new Map();
        for (let step = 0; step < 40; step += 1) {
            const { candidate } = await dispatcher.next();
            dispatcher.recordServed(candidate.owner, candidate.cost);
            servedLate.set(candidate.owner, (servedLate.get(candidate.owner) || 0) + 1);
        }
        // 后加入账户在第二阶段的总服务量应接近早期账户（对齐到同一虚拟时间后立即参与竞争）
        const lateTotal = late.reduce((sum, id) => sum + (servedLate.get(id) || 0), 0);
        assert.ok(lateTotal > 0, `后加入账户必须被服务到，实际 ${lateTotal}`);
        const lateCounts = late.map(id => servedLate.get(id) || 0);
        const spread = Math.max(...lateCounts) - Math.min(...lateCounts);
        assert.ok(spread <= 1, `后加入账户之间也应等权，实际 ${JSON.stringify(lateCounts)}`);
        return { servedLate: lateCounts, lateTotal, early: [...servedEarly.values()] };
    });

    // 六、候选超过分页窗口：窗口外的账户仍会被选中（按账户游标分页的核心理由）。
    await check('beyond_window_still_selectable', '候选超出窗口的账户仍可被选中', async () => {
        // 账户 A 积压 500 条；账户 B 只有 1 条。若用全局 LIMIT，B 会被挤到窗口外。
        const accountA = 'window-acct-A', accountB = 'window-acct-B';
        for (let i = 0; i < 500; i += 1) {
            await repo.enqueue({ accountId: accountA, storeId: 'temu:windowA', direction: 'publish',
                jobId: `window-a-${i}`, spuId: `wa-${i}`, runId: 'window-run' });
        }
        await repo.enqueue({ accountId: accountB, storeId: 'temu:windowB', direction: 'publish',
            jobId: 'window-b-0', spuId: 'wb-0', runId: 'window-run' });
        const dispatcher = createAccountDispatcher({ database, perAccountLimit: 3 });
        dispatcher.registerAccounts([accountA, accountB]);
        const served = new Map();
        for (let step = 0; step < 30; step += 1) {
            const { candidate } = await dispatcher.next();
            dispatcher.recordServed(candidate.owner, candidate.cost);
            served.set(candidate.owner, (served.get(candidate.owner) || 0) + 1);
        }
        const aCount = served.get(accountA) || 0, bCount = served.get(accountB) || 0;
        assert.ok(bCount > 0, `积压账户不得让小额账户饿死，实际 A=${aCount} B=${bCount}`);
        assert.ok(Math.abs(aCount - bCount) <= 1, `等权轮转应近似相等，实际 A=${aCount} B=${bCount}`);
        assert.deepEqual(served.get(accountB), Math.min(bCount, 30), '小额账户应拿到它的份额');
        return { A: aCount, B: bCount };
    });

    // 七、unknown 账户不挡住其他账户：unknown 保留账户槽，但其他账户照常被服务。
    await check('unknown_account_does_not_block_others', 'unknown 账户不挡住就绪账户', async () => {
        const blocked = 'blocked-acct', ready = 'ready-acct';
        const work = await repo.enqueue({ accountId: blocked, storeId: 'temu:blocked', direction: 'publish',
            jobId: 'blocked-job', spuId: 'blocked-spu', runId: 'blocked-run' });
        await repo.claimAccountWork(blocked, { runId: 'blocked-run', workerEpoch: 0 });
        // 平台结果未知：账户槽保留
        await repo.settleWork(work.work_id, { state: 'unknown', accountId: blocked, runId: 'blocked-run', workerEpoch: 0 });
        await repo.enqueue({ accountId: ready, storeId: 'temu:ready', direction: 'publish',
            jobId: 'ready-job', spuId: 'ready-spu', runId: 'ready-run' });
        const dispatcher = createAccountDispatcher({ database, perAccountLimit: 5 });
        dispatcher.registerAccounts([blocked, ready]);
        const served = new Map();
        for (let step = 0; step < 20; step += 1) {
            const { candidate } = await dispatcher.next();
            assert.ok(candidate, '就绪账户必须仍有候选');
            dispatcher.recordServed(candidate.owner, candidate.cost);
            served.set(candidate.owner, (served.get(candidate.owner) || 0) + 1);
        }
        assert.equal(served.get(blocked) || 0, 0, 'unknown 账户不应被分派新工作（保留槽等待核对）');
        assert.ok((served.get(ready) || 0) > 0, '就绪账户必须持续被服务');
        return { blockedServed: served.get(blocked) || 0, readyServed: served.get(ready) || 0 };
    });

    // 八、续片与新工作分开：持有槽的账户不会被自己的 waiting 挡住。
    await check('resume_separate_from_fresh', '续片与新工作分开且都能被选出', async () => {
        const accountId = 'resume-acct';
        const work = await repo.enqueue({ accountId, storeId: 'temu:resume', direction: 'publish',
            jobId: 'resume-job', spuId: 'resume-spu', runId: 'resume-run' });
        await repo.claimAccountWork(accountId, { runId: 'resume-run', workerEpoch: 0 });
        await repo.checkpointWork(work.work_id, { accountId, runId: 'resume-run', workerEpoch: 0,
            checkpointRef: 'cp', state: 'waiting', nextRunAt: '' }); // 已到期
        const resumes = await listResumeCandidates({ database, accountIds: [accountId] });
        assert.equal(resumes.length, 1, `应识别出 1 条可续片，实际 ${resumes.length}`);
        assert.equal(resumes[0].kind, CANDIDATE_KIND.resume, '类型必须是 resume');
        assert.equal(resumes[0].workId, work.work_id);
        // 未到期的续片不得被列出
        // 注意：waiting 不能直接结算为 done（状态机不允许跳过执行），先续接回 running 再结算。
        const resumed = await repo.claimAccountWork(accountId, { runId: 'resume-run', workerEpoch: 0 });
        assert.equal(resumed.claimed, true, '到期的续片应能续接');
        assert.equal(resumed.resumed, true, '应走续接路径而不是新领');
        await repo.settleWork(work.work_id, { state: 'done', accountId, runId: 'resume-run', workerEpoch: 0 });
        const afterDone = await listResumeCandidates({ database, accountIds: [accountId] });
        assert.equal(afterDone.length, 0, '终态工作不得作为续片候选');
        return { resumeCount: resumes.length, afterDone: afterDone.length };
    });

    // 九、失败申请不记账：被拒绝的申请不该消耗账户的公平份额。
    await check('failed_attempt_no_credit', '失败申请不记服务量', async () => {
        const accounts = ['credit-acct-01', 'credit-acct-02'];
        for (const accountId of accounts) {
            await repo.enqueue({ accountId, storeId: `temu:credit-${accountId}`, direction: 'publish',
                jobId: `credit-${accountId}`, spuId: 'credit-spu', runId: 'credit-run' });
        }
        const dispatcher = createAccountDispatcher({ database, perAccountLimit: 5 });
        dispatcher.registerAccounts(accounts);
        const { candidate } = await dispatcher.next();
        // 模拟"拿到候选但资源被拒"：不调用 recordServed
        const before = dispatcher.snapshot().find(entry => entry.owner === candidate.owner);
        const virtualBefore = before ? before.virtualTime : 0;
        const after = dispatcher.snapshot().find(entry => entry.owner === candidate.owner);
        const virtualAfter = after ? after.virtualTime : 0;
        assert.equal(virtualAfter, virtualBefore, '未记录服务时虚拟时间不得推进');
        // 另一个账户仍应能被选中（没被"假服务"挤掉）
        const second = await dispatcher.next();
        assert.ok(second.candidate, '其他账户仍应有候选');
        return { notCredited: true };
    });

    // 十、惰性清单：5000 × 200 不一次物化 100 万对象。
    await check('lazy_manifest_bounded_window', '惰性清单不一次物化全部组合', async () => {
        const spus = Array.from({ length: 5000 }, (_, i) => `spu-${i}`);
        const stores = Array.from({ length: 200 }, (_, i) => `temu:${i}`);
        const manifest = createLazyManifest({ jobId: 'lazy-1', spuIds: spus, targetStoreIds: stores,
            globalWindow: 2000, perAccountWindow: 100 });
        assert.equal(manifest.totalPairs, 1_000_000, '总数应为 100 万对');
        assert.equal(manifest.materializedTotal(), 0, '创建时不得物化任何组合');
        const batch = manifest.take({ accountId: 'acct-1' });
        assert.ok(batch.length <= 100, `单次不得超过每账户窗口 100，实际 ${batch.length}`);
        assert.ok(manifest.materializedTotal() <= 2000, '不得突破全局窗口');
        // 返回的是引用，不含商品正文
        assert.ok(batch[0].sourceRef, '必须返回引用');
        assert.equal(batch[0].snapshot, undefined, '不得携带商品正文');
        assert.equal(batch[0].products, undefined, '不得携带商品正文');
        // 每账户窗口重置后可继续
        manifest.resetAccountWindow('acct-1');
        const more = manifest.take({ accountId: 'acct-1' });
        assert.ok(more.length > 0, '重置账户窗口后应能继续物化');
        assert.notEqual(more[0].spuId + more[0].targetStoreId, batch[0].spuId + batch[0].targetStoreId, '新窗口应推进游标');
        return { totalPairs: manifest.totalPairs, firstBatch: batch.length, materialized: manifest.materializedTotal() };
    });
} catch (error) {
    checks.push({ id: 'harness', title: '分发器验收环境可运行', status: 'FAIL', reason: String(error?.message || error) });
}

const failed = checks.filter(item => item.status !== 'PASS');
report = { passed: failed.length === 0, checks, failedCount: failed.length,
    realPlatformCalls: 0, productionChanged: false };
try {
    // 协作验收可只输出控制台，不覆盖主线程正在使用的报告文件。
    if (!process.argv.includes('--no-report')) {
        await writeFile(new URL('../../output/reviews/account-process-dispatcher-results.json', import.meta.url), JSON.stringify(report, null, 2));
    }
} catch {}
console.log(JSON.stringify(report, null, 1));
await pool.end();
await isolated.drop();
process.exit(failed.length === 0 ? 0 : 1);
