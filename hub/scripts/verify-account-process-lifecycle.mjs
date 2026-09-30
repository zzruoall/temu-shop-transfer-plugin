/**
 * 步骤3 验收：账户专属进程的生命周期（真实 fork）。
 *
 * 复核报告指出原基座"直接记录 pid=1001/1002，没有真实 fork"，
 * 本脚本用真实 `child_process.fork` 启动子进程，断言：
 * - 每个账户拿到**独立且真实**的 PID；
 * - 同时存在的子进程不超过配置上限（含启动中与退出中的）；
 * - 名额在 fork 前登记、exit 后才释放；
 * - 同账户不会有两个 worker；旧 epoch 消息被拒绝；
 * - 启动失败按退避处理，不忙循环重启。
 *
 * 不连数据库、不调用真实平台。
 */
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createAccountProcessSupervisor } from '../lib/account-process-supervisor.mjs';
import { createTrace } from './account-process-harness.mjs';

const trace = createTrace();

/** 收集某子进程的下一条指定类型消息。 */
function waitForMessage(child, type, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ${type} 超时`)), timeoutMs);
        const onMessage = message => {
            if (message?.type !== type) return;
            clearTimeout(timer);
            child.off('message', onMessage);
            resolve(message);
        };
        child.on('message', onMessage);
    });
}

const supervisor = createAccountProcessSupervisor({
    maxAccountProcesses: 2, maxStartPerSecond: 10, idleExitMs: 30000, workerOldSpaceMiB: 64,
    onTrace: (type, fields) => trace.push(type, fields)
});

// 一、两个账户各启动一个真实子进程：PID 真实、互不相同、数量不超上限。
const started = [];
for (const accountId of ['acct-01', 'acct-02']) {
    const result = await supervisor.spawnFor(accountId, { workId: `w-${accountId}` });
    assert.equal(result.started, true, `${accountId} 应启动成功，实际 ${result.reason}`);
    assert.ok(Number.isInteger(result.pid) && result.pid > 0, 'PID 必须是真实正整数');
    started.push(result);
}
await delay(1200); // 等子进程 ready
assert.notEqual(started[0].pid, started[1].pid, '两个账户必须拿到不同 PID');
assert.ok(trace.hasRealProcessEvidence(), '轨迹必须包含真实 pid 的 fork 事件');

// 二、名额上限：第三个账户被拒绝，且不超开。
const third = await supervisor.spawnFor('acct-03', { workId: 'w-acct-03' });
assert.equal(third.started, false, '超过上限时不得再启动');
assert.equal(third.reason, 'process_limit', `拒绝原因应为 process_limit，实际 ${third.reason}`);
assert.equal(supervisor.snapshot().count, 2, '活跃进程数不得超上限');
assert.ok(trace.maxChildrenObserved() <= 2, `观测到的子进程数不应超过 2，实际 ${trace.maxChildrenObserved()}`);

// 三、同账户不会有两个 worker。
const duplicate = await supervisor.spawnFor('acct-01', { workId: 'w-dup' });
assert.equal(duplicate.started, false, '同账户不得重复启动');
assert.equal(duplicate.reason, 'already_running', `拒绝原因应为 already_running，实际 ${duplicate.reason}`);

// 四、让位：请求 acct-01 退出，exit 后名额才释放，随后新账户可以启动。
const yielded = await supervisor.requestYield('acct-01');
assert.equal(yielded.yielded, true, '让位请求应成功退出');
await delay(300); // 等 exit 事件完成名额回收
assert.equal(supervisor.snapshot().count, 1, '让位后活跃进程应减为 1');
const fourth = await supervisor.spawnFor('acct-03', { workId: 'w-acct-03' });
assert.equal(fourth.started, true, `名额释放后新账户应能启动，实际 ${fourth.reason}`);
assert.ok(Number.isInteger(fourth.pid) && fourth.pid > 0, '新进程也应有真实 PID');

// 五、旧 epoch 消息被拒绝：直接向子进程发一条旧 epoch 的 IPC 消息，断言其拒绝。
{
    // 通过监督器暴露的通道取到实际 child；这里用 spawnFor 后立即发送伪造消息的方式验证。
    const probe = createAccountProcessSupervisor({ maxAccountProcesses: 4, maxStartPerSecond: 10, onTrace: () => {} });
    const started = await probe.spawnFor('epoch-probe');
    assert.equal(started.started, true, 'epoch 探针进程应能启动');
    const entry = probe.snapshot().live.find(item => item.accountId === 'epoch-probe');
    assert.ok(entry?.pid, '应能找到探针子进程的 pid');
    const rejection = await probe.__sendForTest('epoch-probe', {
        protocol: 1, operation: 'start', accountId: 'epoch-probe',
        supervisorEpoch: 999, workId: 'stale-work'
    });
    assert.equal(rejection?.type, 'rejected', `旧 epoch 消息必须被拒绝，实际 ${JSON.stringify(rejection).slice(0, 120)}`);
    assert.equal(rejection.reason, 'stale_epoch', `拒绝原因应为 stale_epoch，实际 ${rejection.reason}`);
    // 账户不匹配的消息同样被拒绝（消息自报值不被信任）。
    const wrongAccount = await probe.__sendForTest('epoch-probe', {
        protocol: 1, operation: 'start', accountId: 'other-account',
        supervisorEpoch: started.epoch, workId: 'wrong-account-work'
    });
    assert.equal(wrongAccount?.type, 'rejected', '账户不匹配的消息必须被拒绝');
    assert.equal(wrongAccount.reason, 'account_mismatch', `拒绝原因应为 account_mismatch，实际 ${wrongAccount.reason}`);
    // 白名单外的操作被拒绝。
    const badOp = await probe.__sendForTest('epoch-probe', {
        protocol: 1, operation: 'drop-database', accountId: 'epoch-probe', supervisorEpoch: started.epoch
    });
    assert.equal(badOp?.type, 'rejected', '白名单外的操作必须被拒绝');
    assert.equal(badOp.reason, 'operation_not_allowed', `拒绝原因应为 operation_not_allowed，实际 ${badOp.reason}`);
    await probe.stopAll({ timeoutMs: 3000 });
}

// 六、启动速率限制：短时间内连续启动会被拦。
{
    const fast = createAccountProcessSupervisor({ maxAccountProcesses: 8, maxStartPerSecond: 1, onTrace: () => {} });
    const firstSpawn = await fast.spawnFor('rate-a');
    assert.equal(firstSpawn.started, true, '第一个应成功');
    const secondSpawn = await fast.spawnFor('rate-b');
    assert.equal(secondSpawn.started, false, '一秒内第二个应被速率限制拦住');
    assert.equal(secondSpawn.reason, 'start_rate_limited', `拒绝原因应为 start_rate_limited，实际 ${secondSpawn.reason}`);
    await fast.stopAll({ timeoutMs: 5000 });
}

// 七、故障熔断：连续启动失败达到阈值后进入待处理，不忙循环重启。
{
    const broken = createAccountProcessSupervisor({ workerPath: 'E:/project/ziniao/hub/workers/does-not-exist.mjs', maxAccountProcesses: 4, maxStartPerSecond: 10, onTrace: () => {} });
    let lastReason = '';
    // 退避生效后，连续失败必须**跨过退避窗口**才能再次尝试（N8 要求）。
    // 退避序列为 1/2/4/8 秒，达到 5 次失败即进入待处理；
    // 这里用有界循环等待，不跳过退避、也不无限重试。
    let attempts = 0;
    const deadlineAt = Date.now() + 40000;
    while (!broken.isQuarantined('broken-account') && Date.now() < deadlineAt) {
        const result = await broken.spawnFor('broken-account');
        lastReason = result.reason || '';
        attempts += 1;
        if (result.reason === 'backoff') {
            await delay(Math.min(9000, (result.retryAfterMs || 1000) + 150));
            continue;
        }
        // fork 对缺失入口是**异步失败**（先返回 pid，随后 exit code=1），
        // 必须等退出事件完成计账，否则下一次 spawn 时槽位还没释放。
        await delay(400);
    }

    assert.equal(broken.isQuarantined('broken-account'), true,
        `连续失败达到阈值后应进入待处理（尝试 ${attempts} 次，最后原因 ${lastReason}）`);
    const afterQuarantine = await broken.spawnFor('broken-account');
    assert.equal(afterQuarantine.started, false, '已隔离账户不得自动重启');
    assert.equal(afterQuarantine.reason, 'quarantined', `拒绝原因应为 quarantined，实际 ${afterQuarantine.reason}`);
    assert.ok(attempts >= 5, `达到隔离至少需要 5 次失败尝试，实际 ${attempts}`);
}

// 六、长任务不得被误判空闲：空闲回收的时间基准必须是"最后活动"而不是"启动时刻"。
// 用一个真实慢任务子进程：启动后保持忙碌，idleExitMs 很短，但它不该在忙碌期间被回收。
{
    const fixturePath = new URL('../../output/reviews/account-process-slow-worker-fixture.mjs', import.meta.url).pathname;
    const fixture = process.platform === 'win32' ? fixturePath.replace(/^\//, '') : fixturePath;
    const slow = createAccountProcessSupervisor({
        workerPath: fixture, maxAccountProcesses: 2, maxStartPerSecond: 10,
        // idleExitMs 远小于任务时长：若用 startedAt 判断，进程会被立刻回收。
        idleExitMs: 400, workerOldSpaceMiB: 64, onTrace: () => {}
    });
    try {
        process.env.FIXTURE_DELAY_MS = '1600';
        const spawned = await slow.spawnFor('slow-account', { workId: 'slow-work' });
        assert.equal(spawned.started, true, `慢任务进程应能启动，实际 ${spawned.reason}`);
        // 等过 idleExitMs：任务仍在进行中，进程必须还在。
        await delay(700);
        assert.equal(slow.snapshot().count, 1, '忙碌中的长任务不得被空闲回收（时间基准不能用 startedAt）');
        // 任务完成后进程仍存活（等待下一个任务），随后允许被回收。
        /**
         * 等待回收**发生**，而不是猜一个固定时长。
         *
         * 回收由监督器的周期性定时器触发，在机器繁忙时可能晚于固定等待
         * （实测串行跑 5/5 通过、放在整条链里跑就超时失败）。
         * 这里轮询到上限再断言，让结论与机器负载无关，同时仍然检验
         * "空闲后确实会被回收"这一行为。
         */
        const reclaimDeadline = Date.now() + 8000;
        let afterIdle = slow.snapshot().count;
        while (afterIdle > 0 && Date.now() < reclaimDeadline) {
            await delay(200);
            afterIdle = slow.snapshot().count;
        }
        assert.equal(afterIdle, 0, `空闲超过 idleExitMs 后应收敛回收，实际仍存活 ${afterIdle} 个`);
    } finally {
        delete process.env.FIXTURE_DELAY_MS;
        await slow.stopAll({ timeoutMs: 3000 }).catch(() => {});
    }
}

await supervisor.stopAll({ timeoutMs: 8000 });
await delay(400);

const report = {
    realFork: true,
    distinctPids: started.map(s => s.pid),
    maxChildrenObserved: trace.maxChildrenObserved(),
    maxChildrenAllowed: 2,
    processLimitEnforced: true,
    slotReleasedAfterExit: true,
    sameAccountSingleWorker: true,
    startRateLimited: true,
    failureQuarantine: true,
    realPlatformCalls: 0
};
console.log(JSON.stringify({ passed: true, ...report }));
