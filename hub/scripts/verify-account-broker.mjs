/**
 * 账户 worker broker 验收（方案步骤2）。
 *
 * 覆盖四类必须隔离复现的场景：
 * - 旧代次写入被拒；
 * - 重复消息返回相同结果且**不重复执行副作用**；
 * - 双监督器只有一个能签发许可，失联即停止新授权；
 * - 忙碌让位与崩溃后，平台许可不会随之消失（租约与许可分开）。
 *
 * 全部使用 127.0.0.1:33917 的临时隔离库，真实平台调用 0。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import {
    createAccountWorkerBroker, createSupervisorLeader, createProcessLeaseRegistry,
    validatePathRef, validateMessageShape, messageDedupKey,
    IPC_MESSAGE_BYTES, STATEFUL_OPERATIONS, BROKER_ALLOWED_OPERATIONS
} from '../lib/account-worker-broker.mjs';
import { openIsolatedDatabase } from './account-process-harness.mjs';

const require = createRequire(new URL('../package.json', import.meta.url));
const mysql = require('mysql2/promise');
const isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_broker', label: 'broker 验收' });
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

let report = null;
try {
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const broker = createAccountWorkerBroker({ database });

    // 一、白名单：任意 SQL / 未知操作一律拒绝。
    await check('whitelist_rejects_non_business_ops', '白名单拒绝未知操作与任意 SQL', async () => {
        const r1 = await broker.dispatch({ accountId: 'acc-1', workerEpoch: 1,
            message: { operation: 'drop_table', messageId: 'm1' }, execute: async () => ({ ran: true }) });
        assert.equal(r1.ok, false, '未知操作必须被拒绝');
        assert.equal(r1.reason, 'operation_not_allowed');
        const r2 = await broker.dispatch({ accountId: 'acc-1', workerEpoch: 1,
            message: { operation: 'ping', sql: 'SELECT 1' }, execute: async () => ({ ran: true }) });
        assert.equal(r2.ok, false, '携带 SQL 字段的消息必须被拒绝');
        assert.match(r2.reason, /forbidden_field:sql/);
        assert.deepEqual(broker.allowedOperations.sort(), [...BROKER_ALLOWED_OPERATIONS].sort());
        return { unknownOp: r1.reason, sqlField: r2.reason };
    });

    // 二、父端绑定优先：消息自报账户不被采信，代次不一致被拒。
    await check('binding_over_self_report', '账户取父端绑定，自报值不被采信', async () => {
        // 自报与绑定不一致 → 拒绝
        const mismatch = await broker.dispatch({ accountId: 'acc-bound', workerEpoch: 1,
            message: { operation: 'ping', accountId: 'acc-other' }, execute: async () => ({ ran: true }) });
        assert.equal(mismatch.ok, false, '自报账户与绑定不一致必须拒绝');
        assert.equal(mismatch.reason, 'account_mismatch');
        // 自报与绑定一致 → 执行时用的仍是绑定值（execute 收到的 accountId）
        let seenAccount = null;
        const ok = await broker.dispatch({ accountId: 'acc-bound', workerEpoch: 1,
            message: { operation: 'ping', accountId: 'acc-bound' }, execute: async ({ accountId }) => { seenAccount = accountId; return { pong: true }; } });
        assert.equal(ok.ok, true, '一致时应放行');
        assert.equal(seenAccount, 'acc-bound', '执行时必须使用父端绑定账户');
        // 旧代次 → 拒绝
        const stale = await broker.dispatch({ accountId: 'acc-bound', workerEpoch: 5,
            message: { operation: 'ping', workerEpoch: 4 }, execute: async () => ({ ran: true }) });
        assert.equal(stale.ok, false, '旧代次必须被拒绝');
        assert.equal(stale.reason, 'epoch_mismatch');
        // 缺绑定账户 → 直接拒绝处理
        let threw = false;
        try { await broker.dispatch({ accountId: '', workerEpoch: 1, message: { operation: 'ping' }, execute: async () => ({}) }); }
        catch (error) { threw = error.code === 'broker_missing_binding'; }
        assert.equal(threw, true, '缺绑定账户必须抛错而不是猜一个账户');
        return { mismatch: mismatch.reason, stale: stale.reason, usedAccount: seenAccount };
    });

    // 三、消息去重：重复消息返回相同结果，且副作用只执行一次。
    await check('stateful_message_dedup', '有状态消息去重且副作用只执行一次', async () => {
        let executions = 0;
        const message = { operation: 'settle', messageId: 'dedup-1', workId: 'w-1', state: 'done' };
        const first = await broker.dispatch({ accountId: 'acc-dedup', workerEpoch: 2, message,
            execute: async () => { executions += 1; return { settled: true, seq: executions }; } });
        const second = await broker.dispatch({ accountId: 'acc-dedup', workerEpoch: 2, message,
            execute: async () => { executions += 1; return { settled: true, seq: executions }; } });
        assert.equal(first.ok, true, '首次应执行');
        assert.equal(first.deduplicated, false);
        assert.equal(second.ok, true, '重复消息应成功返回');
        assert.equal(second.deduplicated, true, '重复消息必须被识别为去重');
        assert.equal(executions, 1, `副作用只应执行一次，实际 ${executions}`);
        assert.deepEqual(second.result, first.result, '重复消息必须返回相同结果');
        // 有状态消息缺 messageId → 拒绝（宁可拒绝也不冒重复执行的风险）
        const noId = await broker.dispatch({ accountId: 'acc-dedup', workerEpoch: 2,
            message: { operation: 'settle', workId: 'w-2' }, execute: async () => ({ ran: true }) });
        assert.equal(noId.ok, false, '有状态消息缺 messageId 必须拒绝');
        assert.equal(noId.reason, 'missing_message_id');
        // 不同 messageId → 各自执行
        const third = await broker.dispatch({ accountId: 'acc-dedup', workerEpoch: 2,
            message: { operation: 'settle', messageId: 'dedup-2', workId: 'w-1' },
            execute: async () => { executions += 1; return { settled: true, seq: executions }; } });
        assert.equal(third.deduplicated, false, '不同 messageId 不应被判为重复');
        assert.equal(executions, 2, '新消息应真的执行');
        // 去重键包含代次：换代次后同 messageId 不是同一条
        const nextEpoch = await broker.dispatch({ accountId: 'acc-dedup', workerEpoch: 3,
            message: { operation: 'settle', messageId: 'dedup-1', workId: 'w-1' },
            execute: async () => { executions += 1; return { settled: true, seq: executions }; } });
        assert.equal(nextEpoch.deduplicated, false, '换 worker 代次后同 messageId 应视为新消息');
        assert.equal(executions, 3);
        assert.ok(STATEFUL_OPERATIONS.has('settle'));
        return { executions, replayEqual: true };
    });

    // 四、路径引用：绝对路径、盘符、UNC、协议前缀与目录穿越全部拒绝。
    await check('path_ref_hardening', '路径引用拒绝越界与绝对路径', async () => {
        const bad = ['/etc/passwd', 'C:/windows/system32', '\\\\server\\share', 'file:///etc/passwd', '../../secrets.json', 'a/../../b'];
        for (const ref of bad) {
            const result = validatePathRef(ref);
            assert.equal(result.ok, false, `必须拒绝 ${ref}，实际通过`);
        }
        const good = validatePathRef('staging/2026/packet.json', { allowedRoot: process.cwd() });
        assert.equal(good.ok, true, '正常相对路径应通过');
        // 通过 broker 的端到端拒绝
        const viaBroker = await broker.dispatch({ accountId: 'acc-path', workerEpoch: 1,
            message: { operation: 'start', sourceRef: '/etc/passwd' }, execute: async () => ({ ran: true }) });
        assert.equal(viaBroker.ok, false, 'broker 必须拒绝绝对路径');
        assert.match(viaBroker.reason, /bad_source_ref:absolute_path/);
        return { rejected: bad.length, accepted: good.relative };
    });

    // 五、消息字节上限：超过 64 KiB 拒绝，不截断执行。
    await check('message_size_limit', '单条 IPC 消息超限被拒', async () => {
        const small = validateMessageShape({ operation: 'ping' });
        assert.equal(small.ok, true);
        const big = validateMessageShape({ operation: 'ping', padding: 'x'.repeat(IPC_MESSAGE_BYTES + 100) });
        assert.equal(big.ok, false, '超过 64KiB 的消息必须被拒绝');
        assert.equal(big.reason, 'message_too_large');
        const viaBroker = await broker.dispatch({ accountId: 'acc-size', workerEpoch: 1,
            message: { operation: 'ping', padding: 'x'.repeat(IPC_MESSAGE_BYTES + 100) }, execute: async () => ({ ran: true }) });
        assert.equal(viaBroker.ok, false);
        return { limitBytes: IPC_MESSAGE_BYTES, actualBytes: big.bytes };
    });

    // 六、持久领导代次：两个实例只有一个当选；失联过期后可被接管；epoch 单调递增。
    await check('leader_election_persistent', '领导代次落库：双实例只有一个能签发许可', async () => {
        // 两个实例独立竞选
        const a = createSupervisorLeader({ database, instanceId: 'instance-a' });
        const b = createSupervisorLeader({ database, instanceId: 'instance-b' });
        const first = await a.campaign();
        assert.equal(first.leader, true, '第一个应当选');
        const second = await b.campaign();
        assert.equal(second.leader, false, '他人领导未过期时第二个不得当选');
        assert.equal(second.reason, 'held_by_other');
        assert.equal(a.canAuthorize(), true, '领导可签发许可');
        assert.equal(b.canAuthorize(), false, '非领导不得签发许可');
        // 同一实例续租仍是领导
        const renew = await a.campaign();
        assert.equal(renew.leader, true);
        assert.equal(renew.reason, 'renewed');
        assert.equal(renew.epoch, first.epoch, '续租不应改变代次');

        // 过期后接管：代次必须递增，旧领导不再是领导
        const c = createSupervisorLeader({ database, instanceId: 'instance-c', leaseMs: 1 });
        await new Promise(resolve => setTimeout(resolve, 20));
        const takeover = await c.campaign();
        assert.equal(takeover.leader, true, '租约过期后应可接管');
        assert.ok(takeover.epoch > first.epoch, `接管后代次必须递增，实际 ${takeover.epoch} <= ${first.epoch}`);
        // 旧领导再竞选时不能凭旧代次拿回领导权
        const staleAttempt = await a.campaign();
        assert.equal(staleAttempt.leader, false, '旧领导不得凭过期代次重新当选');
        return { firstEpoch: first.epoch, takeoverEpoch: takeover.epoch, staleRejected: true };
    });

    // 七、进程租约与 PID 重用：重启后同 PID 不能被误认为旧 worker。
    await check('lease_survives_pid_reuse', '租约区分 bootId，PID 重用不被误认', async () => {
        const registry = createProcessLeaseRegistry({ database });
        await registry.register({ leaseId: 'lease-a', accountId: 'acc-lease', workerEpoch: 1, supervisorEpoch: 1,
            pid: 4242, bootId: 'boot-1' });
        const same = await registry.isPossiblyAlive({ leaseId: 'lease-a', currentBootId: 'boot-1' });
        assert.equal(same.alive, true, '同一 bootId 同一 pid 应视为可能存活');
        const rebooted = await registry.isPossiblyAlive({ leaseId: 'lease-a', currentBootId: 'boot-2' });
        assert.equal(rebooted.alive, false, '换 bootId 说明是重启后的 PID 重用，不得当成旧 worker');
        assert.equal(rebooted.reason, 'pid_reused_after_reboot');
        // 重启接管必须能看到仍标记 live 的租约，不能忽略后直接再开两个
        const live = await registry.liveLeases();
        assert.ok(live.some(row => row.lease_id === 'lease-a'), 'live 租约必须能被列出以便核对');
        await registry.markExited({ leaseId: 'lease-a' });
        const after = await registry.isPossiblyAlive({ leaseId: 'lease-a', currentBootId: 'boot-1' });
        assert.equal(after.alive, false, '已退出租约不得报存活');
        return { sameBoot: same.alive, rebooted: rebooted.reason, liveListed: live.length };
    });

    // 八、平台许可不随进程退出消失：租约是进程层，许可是业务层，分开记账。
    await check('lease_exit_does_not_release_platform_permit', '进程退出不释放平台未决许可', async () => {
        const { createAccountWorkRepository } = await import('../lib/account-work-repository.mjs');
        const repo = createAccountWorkRepository(database);
        const work = await repo.enqueue({ accountId: 'acc-permit', storeId: 'temu:990000801', direction: 'publish',
            jobId: 'permit-job', spuId: '880000801', runId: 'permit-run' });
        await repo.claimAccountWork('acc-permit', { runId: 'permit-run', workerEpoch: 0 });
        await repo.holdPlatformLease({ leaseId: 'platform-permit-1', accountId: 'acc-permit', workId: work.work_id,
            attemptId: 'attempt-1', ttlMs: -1000 }); // 故意过期
        const registry = createProcessLeaseRegistry({ database });
        await registry.register({ leaseId: 'proc-lease-1', accountId: 'acc-permit', workerEpoch: 0, supervisorEpoch: 1,
            pid: 9999, bootId: 'boot-x' });
        await registry.markExited({ leaseId: 'proc-lease-1' });
        // 进程租约已退出，但平台许可必须仍然 held（可能已在平台提交）
        const pending = await repo.pendingPlatformLeases();
        assert.ok(pending >= 1, `进程退出后平台未决许可必须保留，实际 ${pending}`);
        const [[leaseRow]] = await database.query('maintenance', 'SELECT state FROM hub_resource_leases WHERE lease_id=?', ['platform-permit-1']);
        assert.equal(leaseRow.state, 'held', '过期的平台许可不得自动释放');
        return { pendingPlatform: pending };
    });
} catch (error) {
    checks.push({ id: 'harness', title: 'broker 验收环境可运行', status: 'FAIL', reason: String(error?.message || error) });
}

const failed = checks.filter(item => item.status !== 'PASS');
report = { passed: failed.length === 0, checks, failedCount: failed.length,
    realPlatformCalls: 0, productionChanged: false };
try {
    await writeFile(new URL('../../output/reviews/account-process-broker-results.json', import.meta.url), JSON.stringify(report, null, 2));
} catch {}
console.log(JSON.stringify(report, null, 1));
await pool.end();
await isolated.drop();
process.exit(failed.length === 0 ? 0 : 1);
