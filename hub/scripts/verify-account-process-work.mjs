/**
 * 步骤2 验收：账户工作仓库的事务职责。
 *
 * 断言方案要求的出口条件：
 * - 两个并发请求争抢同一账户只成功一个（账户业务槽互斥）；
 * - unknown 不释放账户槽（保留业务占用，防止可能已提交的商品被当成未提交）；
 * - 幂等：同一业务提交重复入队只得到一个 work_id；
 * - 平台未决许可不因租约到期自动释放。
 *
 * 只连隔离 MySQL（33917）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createAccountWorkRepository, WORK_STATUS } from '../lib/account-work-repository.mjs';

const isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_work', label: '工作仓库验证' });
const root = await mkdtemp(path.join(tmpdir(), 'temu-accproc-work-'));
await writeFile(path.join(root, 'mysql.json'), JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name }));
const database = await openMysqlDatabase(path.join(root, 'mysql.json'));
try {
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const repo = createAccountWorkRepository(database);

    // 一、幂等入队：同一业务提交（同账户/方向/任务/商品/轮次）只得一个 work_id。
    const base = { accountId: 'acct-01', storeId: 'temu:990000000000', direction: 'publish',
        jobId: 'job-1', spuId: 'spu-1', runId: 'run-1' };
    const first = await repo.enqueue(base);
    const again = await repo.enqueue(base);
    assert.equal(first.work_id, again.work_id, '同一业务提交重复入队必须复用同一 work_id');

    // 不同轮次是不同工作单元：新轮次应该拿到新的 work_id。
    const nextRun = await repo.enqueue({ ...base, runId: 'run-2' });
    assert.notEqual(nextRun.work_id, first.work_id, '不同轮次必须是不同工作单元');

    // 二、账户业务槽互斥：并发领取同一账户只成功一个。
    const [a, b] = await Promise.all([
        repo.claimAccountWork('acct-01', { runId: 'run-1', workerEpoch: 0 }).catch(error => ({ claimed: false, error: String(error.message) })),
        repo.claimAccountWork('acct-01', { runId: 'run-1', workerEpoch: 0 }).catch(error => ({ claimed: false, error: String(error.message) }))
    ]);
    const claimedCount = [a, b].filter(r => r.claimed).length;
    assert.equal(claimedCount, 1, `并发领取同一账户只应成功一个，实际 ${claimedCount}`);

    // 三、账户已有 running 时不能再领第二件（每账户合计 1 件）。
    const busy = await repo.claimAccountWork('acct-01', { runId: 'run-1', workerEpoch: 0 });
    assert.equal(busy.claimed, false, '账户忙时不得再领');
    assert.ok(['account_busy', 'unknown_pending'].includes(busy.reason), `等待原因应明确，实际 ${busy.reason}`);

    // 四、不同账户互不影响：另一个账户能同时领取。
    await repo.enqueue({ ...base, accountId: 'acct-02' });
    const other = await repo.claimAccountWork('acct-02', { runId: 'run-1', workerEpoch: 0 });
    assert.equal(other.claimed, true, '不同账户必须能同时领取（账户之间并行）');

    // 五、unknown 不释放账户槽：这件的商品可能已在平台建成。
    const running = [a, b].find(r => r.claimed).work;
    const settledUnknown = await repo.settleWork(running.work_id, { state: WORK_STATUS.unknown, reason: '平台结果未知',
        accountId: 'acct-01', runId: 'run-1', workerEpoch: 0 });
    assert.equal(settledUnknown.settled, true, 'unknown 结算应成功');
    assert.equal(settledUnknown.released, false, 'unknown 不得释放账户槽');
    const runtimeAfter = await repo.runtimeOf('acct-01');
    assert.equal(runtimeAfter.state, 'unknown', '账户状态应保持 unknown 等待核对');
    const blocked = await repo.claimAccountWork('acct-01', { runId: 'run-1', workerEpoch: 0 });
    assert.equal(blocked.claimed, false, 'unknown 未核对前不得启动同账户下一件');

    // 六、明确终态才释放账户槽。
    await repo.settleWork(running.work_id, { state: WORK_STATUS.done, accountId: 'acct-01', runId: 'run-1', workerEpoch: 0 });
    const freed = await repo.runtimeOf('acct-01');
    assert.equal(freed.state, 'idle', '明确终态后账户应回到 idle');
    assert.equal(freed.current_work_id, '', '明确终态后应清空当前工作');
    // run-1 已完成，下一件属于 run-2：领取必须按当前有效的轮次，传旧轮次不会被匹配。
    const staleClaim = await repo.claimAccountWork('acct-01', { runId: 'run-1', workerEpoch: 0 });
    assert.equal(staleClaim.claimed, false, '旧轮次不得领到新轮的工作');
    const nextClaim = await repo.claimAccountWork('acct-01', { runId: 'run-2', workerEpoch: 0 });
    assert.equal(nextClaim.claimed, true, '释放后同账户应能按当前轮次领取下一件');

    // 七、平台未决许可不因到期自动释放。
    const lease = await repo.holdPlatformLease({ leaseId: 'lease-1', accountId: 'acct-01', workId: nextClaim.work.work_id,
        attemptId: 'attempt-1', ttlMs: -1000 }); // 故意给已过期的 TTL
    assert.equal(lease.state, 'held', '过期的平台许可仍应保持 held，不能自动释放');
    assert.equal(await repo.pendingPlatformLeases(), 1, '未决许可必须计入待核对数');
    await repo.releasePlatformLease('lease-1', { state: 'released' });
    assert.equal(await repo.pendingPlatformLeases(), 0, '只有在收到可信终态后才不再计入');

    // 八、检查点可保存并读回：让位后新 worker 能继续。
    // 必须用仍占用账户槽的工作：前面 running 那件已结算为终态，终态按状态机不可回退。
    const liveWork = nextClaim.work.work_id;
    const saved = await repo.checkpointWork(liveWork, { checkpointRef: 'cp-42', state: WORK_STATUS.waiting, nextRunAt: '',
        accountId: 'acct-01', runId: nextClaim.work.run_id, workerEpoch: 0 });
    assert.equal(saved.changed, true, `检查点应写入成功，实际 ${saved.reason || ''}`);
    const [checkpointRow] = await database.query('maintenance', 'SELECT checkpoint_ref,status FROM hub_account_work WHERE work_id=?', [liveWork]);
    assert.equal(checkpointRow[0].checkpoint_ref, 'cp-42', '检查点必须落盘');
    assert.equal(checkpointRow[0].status, 'waiting', '等待状态必须可读回');
    // 终态不可回退：对已 done 的工作保存检查点必须被拒绝。
    const refused = await repo.checkpointWork(running.work_id, { checkpointRef: 'cp-stale', state: WORK_STATUS.waiting,
        accountId: 'acct-01', runId: 'run-1', workerEpoch: 0 });
    assert.equal(refused.changed, false, '终态工作的检查点必须被拒绝');
    assert.equal(refused.reason, 'terminal_immutable', `拒绝原因应明确，实际 ${refused.reason}`);

    // 九、结算不能承担续接职责：这是复核 P1 的完整因果链，不是只检查"某一次调用被拒绝"。
    // 顺序是：入队两件 → 领第一件 → 存检查点并设置远期退避 → 结算试图置 running → 再次领取。
    // 只要三步里任意一步失守，同账户就会出现两条 running。
    const chainInput = { accountId: 'acct-chain', storeId: 'temu:880000001', direction: 'publish',
        jobId: 'chain-first', spuId: '880000001', runId: 'chain-run' };
    const chainContext = { accountId: 'acct-chain', runId: 'chain-run', workerEpoch: 0 };
    const chainFirst = await repo.enqueue(chainInput);
    assert.equal((await repo.claimAccountWork('acct-chain', chainContext)).claimed, true, '因果链首件必须能领取');
    const futureAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const chainPaused = await repo.checkpointWork(chainFirst.work_id, { ...chainContext,
        checkpointRef: 'chain-cp', state: WORK_STATUS.waiting, nextRunAt: futureAt });
    assert.equal(chainPaused.changed, true, '因果链的让位检查点必须写入成功');
    const chainSecond = await repo.enqueue({ ...chainInput, jobId: 'chain-second' });
    // 退避未到期时，正常续接必须拒绝。
    const notDue = await repo.claimAccountWork('acct-chain', chainContext);
    assert.equal(notDue.claimed, false, '退避中的工作不得被续接');
    assert.equal(notDue.reason, 'not_due', `退避续接的拒绝原因应为 not_due，实际 ${notDue.reason}`);
    // 结算入口不得把 waiting 推回 running：一旦允许，就等于绕开 next_run_at 退避。
    let chainSettle = null;
    try {
        chainSettle = await repo.settleWork(chainFirst.work_id, { ...chainContext, state: WORK_STATUS.running });
    } catch (error) {
        chainSettle = { settled: false, code: error.code };
    }
    assert.equal(chainSettle.settled, false, '结算入口不得把工作置为 running');
    assert.equal(chainSettle.code, 'work_settle_cannot_start', `拒绝码应明确，实际 ${chainSettle.code}`);
    // 工作状态与账户状态必须一致：work=waiting 时 runtime 也应是 waiting，不能出现矛盾组合。
    const [chainWorkRow] = await database.query('maintenance', 'SELECT status FROM hub_account_work WHERE work_id=?', [chainFirst.work_id]);
    const chainRuntime = await repo.runtimeOf('acct-chain');
    assert.equal(chainWorkRow[0].status, WORK_STATUS.waiting, '工作状态不应被结算改动');
    assert.ok(['waiting', 'running', 'idle', 'unknown'].includes(chainRuntime.state), '账户状态必须仍是合法值');
    assert.equal(chainRuntime.state, chainWorkRow[0].status === WORK_STATUS.waiting ? 'waiting' : chainRuntime.state,
        '工作与账户状态必须一致，不能出现 work=running 而 runtime=waiting');
    // 再次领取仍不得拿到第二件：全账户只允许一条执行中的工作。
    const chainAgain = await repo.claimAccountWork('acct-chain', chainContext);
    assert.equal(chainAgain.claimed, false, '结算绕过后退避不得失效');
    const [chainRows] = await database.query('maintenance', 'SELECT status FROM hub_account_work WHERE account_id=?', ['acct-chain']);
    assert.equal(chainRows.filter(row => row.status === WORK_STATUS.running).length, 0,
        '同账户不得出现执行中的工作（退避中的那件必须仍是 waiting）');

    // 十、状态矛盾不得清槽：即使矛盾是被外部改库制造的（不依赖结算这条入口），
    // 领取也必须在原地停住并报告，而不是释放占用后另领一件。
    const conflictInput = { accountId: 'acct-conflict', storeId: 'temu:880000002', direction: 'publish',
        jobId: 'conflict-first', spuId: '880000002', runId: 'conflict-run' };
    const conflictContext = { accountId: 'acct-conflict', runId: 'conflict-run', workerEpoch: 0 };
    const conflictFirst = await repo.enqueue(conflictInput);
    await repo.claimAccountWork('acct-conflict', conflictContext);
    await repo.checkpointWork(conflictFirst.work_id, { ...conflictContext, checkpointRef: 'conflict-cp', state: WORK_STATUS.waiting });
    await repo.enqueue({ ...conflictInput, jobId: 'conflict-second' });
    await database.query('maintenance', "UPDATE hub_account_work SET status='running' WHERE work_id=?", [conflictFirst.work_id]);
    const conflictClaim = await repo.claimAccountWork('acct-conflict', conflictContext);
    assert.equal(conflictClaim.claimed, false, '状态矛盾时不得领取第二件');
    assert.equal(conflictClaim.reason, 'state_conflict', `矛盾必须被显式报告，实际 ${conflictClaim.reason}`);
    const conflictRuntime = await repo.runtimeOf('acct-conflict');
    assert.equal(conflictRuntime.current_work_id, conflictFirst.work_id, '矛盾状态下不得静默清除占用');

    // 十一、同事务内部接口（计划任务2）：业务结果与工作索引必须一起提交或一起回滚。
    // 用顶层 enqueue() 会在事务内另开连接，任一点失败就留下半边成功；
    // 这里用 enqueueInTransaction 走同一 conn，并注入异常验证回滚彻底。
    {
        const accountId = 'txn-acct';
        // (1) 提交路径：同一事务里写业务行 + 工作行，两者都应存在。
        let committedWorkId = '';
        await database.transaction('maintenance', async conn => {
            await conn.query("INSERT INTO hub_jobs(id,source_store,target_store,created_at,updated_at,status,record_group,body,summary) VALUES(?,?,?,?,?,'queued','active','{}','{}')",
                ['txn-job-1', 'temu:txn', 'temu:txn', '2026-01-01', '2026-01-01']);
            const inserted = await repo.enqueueInTransaction(conn, { accountId, storeId: 'temu:txn', direction: 'ingest',
                jobId: 'txn-job-1', spuId: 'spu-txn-1', requestId: 'req-txn-1', sourceRef: 'staging/txn-1.json',
                sourceHash: 'a'.repeat(64), sourceHashAlgorithm: 'sha256', expectedBytes: 66 });
            committedWorkId = inserted.work_id;
        });
        const committed = await repo.workOf(committedWorkId);
        assert.ok(committed, '提交路径必须写入工作行');
        assert.equal(committed.source_hash, 'a'.repeat(64), '来源摘要必须持久化');
        assert.equal(Number(committed.expected_bytes), 66, '期望字节数必须持久化');
        assert.equal(committed.source_ref, 'staging/txn-1.json', '来源引用必须持久化');

        // (2) 回滚路径：事务中途抛错，业务行与工作行都不得存在。
        let rolledBack = false;
        try {
            await database.transaction('maintenance', async conn => {
                await conn.query("INSERT INTO hub_jobs(id,source_store,target_store,created_at,updated_at,status,record_group,body,summary) VALUES(?,?,?,?,?,'queued','active','{}','{}')",
                    ['txn-job-2', 'temu:txn', 'temu:txn', '2026-01-01', '2026-01-01']);
                await repo.enqueueInTransaction(conn, { accountId, storeId: 'temu:txn', direction: 'ingest',
                    jobId: 'txn-job-2', spuId: 'spu-txn-2', requestId: 'req-txn-2', sourceHash: 'b'.repeat(64) });
                throw new Error('注入：结算中失败');
            });
        } catch { rolledBack = true; }
        assert.equal(rolledBack, true, '注入异常必须让事务失败');
        const [[jobRows]] = await database.query('maintenance', "SELECT COUNT(*) AS n FROM hub_jobs WHERE id='txn-job-2'");
        assert.equal(Number(jobRows.n), 0, '回滚后业务行不得残留');
        const [[orphanRows]] = await database.query('maintenance',
            "SELECT COUNT(*) AS n FROM hub_account_work WHERE store_id='temu:txn' AND job_id='txn-job-2'");
        assert.equal(Number(orphanRows.n), 0, '回滚后工作行不得残留（半边成功）');

        // (3) 同键换正文必须冲突：指纹含来源摘要。
        let conflicted = false;
        try {
            await database.transaction('maintenance', async conn => {
                await repo.enqueueInTransaction(conn, { accountId, storeId: 'temu:txn', direction: 'ingest',
                    jobId: 'txn-job-1', spuId: 'spu-txn-1', requestId: 'req-txn-1', sourceHash: 'c'.repeat(64) });
            });
        } catch (error) { conflicted = error.code === 'work_input_conflict'; }
        assert.equal(conflicted, true, '同键不同正文必须报 409 冲突');

        // (4) 缺连接必须拒绝：内部接口不能被当成普通方法误用。
        let missingConn = false;
        try { await repo.enqueueInTransaction(null, { accountId, storeId: 'temu:txn', direction: 'ingest', jobId: 'x' }); }
        catch (error) { missingConn = error.code === 'work_missing_conn'; }
        assert.equal(missingConn, true, '缺事务连接必须明确拒绝');
    }

    const snap = await repo.snapshot();
    console.log(JSON.stringify({
        passed: true,
        idempotentEnqueue: true,
        accountSlotSingleton: true,
        crossAccountParallel: true,
        unknownKeepsSlot: true,
        terminalReleasesSlot: true,
        platformLeaseNotAutoReleased: true,
        checkpointPersisted: true,
        settleCannotResume: true,
        stateConflictStopsClaim: true,
        sameTransactionAtomic: true,
        pendingPlatform: snap.pendingPlatform,
        realPlatformCalls: 0
    }));
} finally {
    await database.close?.();
    await isolated.drop();
}
