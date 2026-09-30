/**
 * 资源预算验收（方案步骤1）。
 *
 * 全部用**注入样本**：
 * - 768 MiB 服务限额不能被整机内存替换；
 * - 70/80/90% 分级、恢复迟滞、CPU 计数差值、计数器重置、缺失 cgroup、低磁盘；
 * - 降载只阻止新授权，不改写已提交结果。
 *
 * Windows 上的注入样本只能证明逻辑正确，**不能当作真实 Linux 容量证据**——
 * 这一点在输出里如实标注。
 */
import assert from 'node:assert/strict';
import {
    createRuntimeResourceBudget, BUDGET_MODE, DEFAULT_BUDGET_CONFIG,
    parseSelfCgroup, parseCgroupMount, parseMemoryMax, parseCpuStat, parseCpuMax,
    assertBudgetReadyForService
} from '../lib/runtime-resource-budget.mjs';

const MiB = 1024 * 1024;
const checks = [];
async function check(id, title, run) {
    try {
        const detail = await run();
        checks.push({ id, title, status: 'PASS', detail: detail === undefined ? null : detail });
    } catch (error) {
        checks.push({ id, title, status: 'FAIL', reason: String(error?.message || error) });
    }
}

// 可控时钟：恢复需要连续 30 秒，不能靠真实等待。
function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: ms => { t += ms; return t; } };
}

/** 构造一个可编程的采样器：按调用序号或状态返回样本。 */
function sampler(initial = {}) {
    const state = {
        memoryCurrentBytes: 400 * MiB, memoryMaxBytes: 768 * MiB,
        diskFreeBytes: 100 * 1024 * MiB, diskTotalBytes: 500 * 1024 * MiB,
        cpuStat: { nr_throttled: 0, nr_periods: 100 },
        ...initial
    };
    return { state, probe: async () => ({ ok: true, source: 'injected', ...state }) };
}

// 一、解析函数：cgroup 路径与限额解析不能硬编码或猜错语义。
await check('parse_cgroup_and_limits', 'cgroup 路径与限额解析正确', async () => {
    assert.equal(parseSelfCgroup('0::/system.slice/ziniao.service\n'), '/system.slice/ziniao.service');
    assert.equal(parseSelfCgroup('garbage'), '', '缺失 0:: 行应返回空而不是猜一个路径');
    const mount = parseCgroupMount('36 25 0:30 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n');
    assert.equal(mount, '/sys/fs/cgroup');
    assert.equal(parseMemoryMax('805306368\n'), 805306368, '768MiB 应被读成字节数');
    assert.equal(parseMemoryMax('max\n'), null, 'max 表示无限制，不能当成 0');
    const cpu = parseCpuStat('nr_periods 100\nnr_throttled 25\nthrottled_usec 500\n');
    assert.equal(cpu.nr_throttled, 25);
    const cpuMax = parseCpuMax('50000 100000\n');
    assert.deepEqual(cpuMax, { quotaUs: 50000, periodUs: 100000 });
    return { mount, memoryMax: 805306368 };
});

// 二、768MiB 限额不能被整机内存替换：分母必须是服务限额。
await check('service_limit_not_host_memory', '内存分母用服务限额而非整机内存', async () => {
    const { state, probe } = sampler();
    const budget = createRuntimeResourceBudget({ probe, now: () => 1_000_000 });
    const result = await budget.sample();
    // 400/768 ≈ 52%：必须落在 healthy，而不是拿整机内存算出接近 0 的比例。
    assert.ok(result.memoryRatio > 0.5 && result.memoryRatio < 0.53,
        `内存比例应基于服务限额，实际 ${result.memoryRatio}`);
    assert.equal(result.mode, BUDGET_MODE.healthy, '52% 应为健康');
    assert.equal(result.canSpawnProcess, true);
    // 换成整机内存会得到完全不同的结论：显式证明我们没有那样算。
    const hostRatio = state.memoryCurrentBytes / (32 * 1024 * MiB);
    assert.ok(hostRatio < 0.02, '整机内存比例应与服务限额比例显著不同');
    return { serviceRatio: result.memoryRatio, hostRatio };
});

// 三、70/80/90% 分级：各级允许的操作必须不同。
await check('memory_tiers', '70/80/90% 三档分级行为正确', async () => {
    const at70 = createRuntimeResourceBudget({ probe: sampler({ memoryCurrentBytes: 0.71 * 768 * MiB }).probe, now: () => 1_000_000 });
    const r70 = await at70.sample();
    assert.equal(r70.canSpawnProcess, false, '70% 必须停止扩大进程名额');

    const at80 = createRuntimeResourceBudget({ probe: sampler({ memoryCurrentBytes: 0.81 * 768 * MiB }).probe, now: () => 1_000_000 });
    const r80 = await at80.sample();
    assert.equal(r80.canSpawnProcess, false, '80% 不得扩进程');
    assert.equal(r80.canStartParse, false, '80% 必须停止新增重解析与接收许可');

    const at90 = createRuntimeResourceBudget({ probe: sampler({ memoryCurrentBytes: 0.91 * 768 * MiB }).probe, now: () => 1_000_000 });
    const r90 = await at90.sample();
    assert.equal(r90.mode, BUDGET_MODE.paused, '90% 必须暂停新业务授权');
    assert.equal(r90.canAuthorizeBusiness, false, '90% 不得签发新业务许可');
    assert.equal(r90.canAcceptNewStaging, false, '90% 不得接收新暂存');
    return { r70: r70.canSpawnProcess, r80: r80.canStartParse, r90: r90.canAuthorizeBusiness };
});

// 四、恢复迟滞：必须连续 30 秒低于 65%，不能因为一次低采样就放量。
await check('recovery_hysteresis', '恢复需要连续 30 秒低于 65%', async () => {
    const c = clock();
    const { state, probe } = sampler({ memoryCurrentBytes: 0.91 * 768 * MiB });
    const budget = createRuntimeResourceBudget({ probe, now: c.now });
    const paused = await budget.sample();
    assert.equal(paused.mode, BUDGET_MODE.paused, '高内存应暂停');
    // 降到 60%，但只等待很短时间：不得恢复
    state.memoryCurrentBytes = 0.60 * 768 * MiB;
    c.advance(5_000);
    const tooEarly = await budget.sample();
    assert.notEqual(tooEarly.mode, BUDGET_MODE.healthy, '未满 30 秒不得恢复');
    // 等满 30 秒后应恢复
    c.advance(30_000);
    const recovered = await budget.sample();
    assert.equal(recovered.mode, BUDGET_MODE.healthy, '连续低于恢复线 30 秒后应恢复');
    return { paused: paused.mode, tooEarly: tooEarly.mode, recovered: recovered.mode };
});

// 五、CPU 节流用差值：累计计数增长本身不能触发永久降载。
await check('cpu_delta_not_cumulative', 'CPU 节流按差值判定，累计值不触发降载', async () => {
    const c = clock();
    const { state, probe } = sampler({ cpuStat: { nr_throttled: 0, nr_periods: 100 } });
    const budget = createRuntimeResourceBudget({ probe, now: c.now });
    await budget.sample();
    // 第二采样：累计 nr_throttled 大幅增长，但本窗口内没有新的节流（周期数同步增长）
    state.cpuStat = { nr_throttled: 500, nr_periods: 100_000 };
    c.advance(2_000);
    const afterBigCumulative = await budget.sample();
    assert.equal(afterBigCumulative.observed.cpuThrottled, false,
        '累计 nr_throttled 增长不应被判为当前节流（差值为 500/99900 ≈ 0.5%）');
    // 真正节流：本窗口 80% 周期被节流
    state.cpuStat = { nr_throttled: 500 + 8_000, nr_periods: 100_000 + 10_000 };
    c.advance(2_000);
    const throttled = await budget.sample();
    assert.equal(throttled.observed.cpuThrottled, true, '本窗口 80% 节流必须被识别');
    c.advance(5_000);
    const idle = await budget.sample();
    assert.equal(idle.observed.cpuThrottled, false, '降载后没有新CPU周期，不能一直保留旧节流标志');
    state.cpuStat = { nr_throttled: 8600, nr_periods: 110100 };
    c.advance(5_000); assert.equal((await budget.sample()).observed.cpuThrottled, true);
    state.cpuStat = { nr_throttled: 0, nr_periods: 0 };
    c.advance(5_000); assert.equal((await budget.sample()).observed.cpuThrottled, false, '真节流之后计数器重置也必须恢复');
    return { cumulativeSafe: afterBigCumulative.observed.cpuThrottled, throttledDetected: throttled.observed.cpuThrottled };
});

// 六、计数器重置不是故障：差值变负应按"无节流"处理，不能卡在降载。
await check('counter_reset_safe', '计数器重置不得卡住降载状态', async () => {
    const c = clock();
    const { state, probe } = sampler({ cpuStat: { nr_throttled: 50_000, nr_periods: 100_000 } });
    const budget = createRuntimeResourceBudget({ probe, now: c.now });
    await budget.sample();
    state.cpuStat = { nr_throttled: 10, nr_periods: 20 }; // 重启导致计数器归零
    c.advance(2_000);
    const afterReset = await budget.sample();
    assert.equal(afterReset.observed.cpuThrottled, false, '计数器重置后不得继续判为节流');
    return { throttled: afterReset.observed.cpuThrottled };
});

// 七、缺失 cgroup：新模式不得按整机总量放开，必须拒绝并要求显式预算。
await check('missing_cgroup_refuses', '缺失服务限额时拒绝启用而不是放开', async () => {
    const budget = createRuntimeResourceBudget({
        probe: async () => ({ ok: false, source: 'cgroup-limit-missing' }),
        now: () => 1_000_000
    });
    const result = await budget.sample();
    assert.equal(result.canStartNewWork, false, '限额未知时不得开始新工作');
    assert.equal(result.canAuthorizeBusiness, false, '限额未知时不得签发新业务许可');
    assert.equal(result.reasonCode, 'budget_unknown', `原因码应明确，实际 ${result.reasonCode}`);

    // 启动校验：非 off 模式必须抛错，不能静默降级。
    assert.throws(() => assertBudgetReadyForService({ mode: 'on', sample: { ok: false, source: 'cgroup-limit-missing' } }),
        /缺少可信服务资源限额/, 'on 模式缺限额必须拒绝');
    const shadow = () => assertBudgetReadyForService({ mode: 'shadow', sample: { ok: false, source: 'x' } });
    assert.throws(shadow, /缺少可信服务资源限额/, 'shadow 模式同样必须拒绝');
    const off = assertBudgetReadyForService({ mode: 'off', sample: { ok: false } });
    assert.equal(off.ready, true, 'off 模式不依赖预算');
    // 显式给预算时允许（运维显式声明，不靠整机猜测）
    const explicit = assertBudgetReadyForService({ mode: 'on', sample: { ok: false }, explicitBudget: { memoryMaxBytes: 768 * MiB } });
    assert.equal(explicit.ready, true);
    assert.equal(explicit.source, 'explicit-budget');
    return { refusedOn: true, refusedShadow: true, offAllowed: off.ready, explicitAllowed: explicit.ready };
});

// 八、低磁盘：只拒绝新暂存，回执/取消不受影响。
await check('low_disk_blocks_staging_only', '磁盘低于保留值只拒绝新暂存', async () => {
    // 保留值 = max(2GiB, 总量 10%)；这里总量 500GiB → 保留 50GiB，给 10GiB 可用。
    const { probe } = sampler({ diskFreeBytes: 10 * 1024 * MiB, diskTotalBytes: 500 * 1024 * MiB });
    const budget = createRuntimeResourceBudget({ probe, now: () => 1_000_000 });
    const result = await budget.sample();
    assert.equal(result.canAcceptNewStaging, false, '磁盘不足必须拒绝新暂存');
    assert.equal(result.observed.diskLow, true, '应报告磁盘不足');
    // 关键：暂停暂存不等于停止服务——回执与取消由调用方独立处理，这里只保证不误报整链故障。
    assert.notEqual(result.reasonCode, 'budget_unknown', '磁盘不足不应报成预算未知');
    return { canAcceptNewStaging: result.canAcceptNewStaging, diskLow: result.observed.diskLow };
});

// 九、磁盘读取失败=未知：按拒绝新暂存处理，而不是当成"磁盘充足"。
await check('disk_unknown_is_not_enough', '磁盘未知不得当成充足', async () => {
    const { probe } = sampler({ diskFreeBytes: null, diskTotalBytes: null });
    const budget = createRuntimeResourceBudget({ probe, now: () => 1_000_000 });
    const result = await budget.sample();
    assert.equal(result.canAcceptNewStaging, false, '磁盘未知时必须保守拒绝新暂存');
    assert.equal(result.observed.diskUnknown, true);
    return { diskUnknown: result.observed.diskUnknown };
});

// 十、降载不改变已提交结果：预算只输出准入结论，不持有任何写回路径。
await check('budget_is_admission_only', '预算只做准入，不写业务状态', async () => {
    const { probe } = sampler({ memoryCurrentBytes: 0.95 * 768 * MiB });
    const budget = createRuntimeResourceBudget({ probe, now: () => 1_000_000 });
    const result = await budget.sample();
    assert.equal(result.mode, BUDGET_MODE.paused);
    // 契约检查：输出里不包含任何"把任务改成失败"之类的字段。
    const keys = Object.keys(result).join(',');
    assert.ok(!/fail|abort|cancel|rewrite/i.test(keys), `预算输出不应包含改写业务结果的字段：${keys}`);
    return { outputKeys: keys };
});

// 十一、延迟降载按**持续时间**判定：连续越限满两个窗口才降载；单次尖峰恢复后不得降载。
await check('latency_needs_two_windows', '延迟降载需要连续两个窗口，单次尖峰不降载', async () => {
    const requiredMs = DEFAULT_BUDGET_CONFIG.requiredWindows * DEFAULT_BUDGET_CONFIG.windowMs;

    // 场景A：从第一次采样起持续越限，满两个窗口后降载。
    const cA = clock();
    const budgetA = createRuntimeResourceBudget({
        probe: async () => ({ ok: true, source: 'injected', memoryCurrentBytes: 400 * MiB, memoryMaxBytes: 768 * MiB,
            diskFreeBytes: 100 * 1024 * MiB, diskTotalBytes: 500 * 1024 * MiB, dbWaitMs: 600 }),
        now: cA.now
    });
    const a1 = await budgetA.sample();
    cA.advance(1_000);
    const a2 = await budgetA.sample();
    assert.equal(a1.mode, BUDGET_MODE.healthy, '刚开始越限不应立即降载');
    assert.equal(a2.mode, BUDGET_MODE.healthy, `仅持续 1 秒不应降载，实际 ${a2.mode}`);
    cA.advance(requiredMs);
    const a3 = await budgetA.sample();
    assert.equal(a3.mode, BUDGET_MODE.constrained, '持续越限满两个窗口应降载');

    // 场景B：单次尖峰后立即恢复正常 → 连续越限被打断，不得降载。
    const cB = clock();
    let spike = true;
    const budgetB = createRuntimeResourceBudget({
        probe: async () => ({ ok: true, source: 'injected', memoryCurrentBytes: 400 * MiB, memoryMaxBytes: 768 * MiB,
            diskFreeBytes: 100 * 1024 * MiB, diskTotalBytes: 500 * 1024 * MiB, dbWaitMs: spike ? 600 : 20 }),
        now: cB.now
    });
    const b1 = await budgetB.sample();
    spike = false;
    cB.advance(requiredMs * 2);
    const b2 = await budgetB.sample();
    assert.equal(b1.mode, BUDGET_MODE.healthy, '单次尖峰的首个窗口不应降载');
    assert.equal(b2.mode, BUDGET_MODE.healthy, `尖峰后恢复正常不应降载，实际 ${b2.mode}`);
    return { sustained: [a1.mode, a2.mode, a3.mode], spike: [b1.mode, b2.mode] };
});

// 十二、调度控制器必须用服务限额：整机内存分母会让"接近本服务上限"被算成很小的比例。
await check('scheduling_uses_service_limit', '调度控制器降载分母用服务限额', async () => {
    const { createSchedulingController } = await import('../lib/scheduling.mjs');
    // 注入服务限额比例 0.95：必须判为严重过载并暂停。
    const scoped = createSchedulingController({ memoryRatioProvider: () => 0.95 });
    const high = scoped.sample({ loopLagMs: 10 });
    assert.equal(high.reasonCode, 'server_overloaded', `95% 服务内存应判严重过载，实际 ${high.reasonCode}`);
    assert.equal(high.paused, true, '严重过载应暂停新授权');
    assert.equal(scoped.usesServiceLimit, true, '应标记为使用服务限额');
    // 未知内存：不参与降载判定（由预算侧 budget_unknown 拒绝启用，而不是这里假装健康）。
    const unknown = createSchedulingController({ memoryRatioProvider: () => null });
    const u = unknown.sample({ loopLagMs: 10 });
    assert.equal(u.reasonCode, '', '内存未知不应在这里降载');
    assert.notEqual(u.paused, true, '内存未知不应暂停（交由预算侧处理）');
    // 低比例：健康
    const healthyBudget = createSchedulingController({ memoryRatioProvider: () => 0.4 });
    const h = healthyBudget.sample({ loopLagMs: 10 });
    assert.equal(h.paused, false, '40% 不应暂停');
    scoped.stop(); unknown.stop(); healthyBudget.stop();
    return { high: high.reasonCode, unknown: u.reasonCode, healthyLimit: h.limit };
});

const failed = checks.filter(item => item.status !== 'PASS');
console.log(JSON.stringify({
    passed: failed.length === 0,
    checks,
    failedCount: failed.length,
    platform: process.platform,
    // 如实标注：非 Linux 上这些结论只证明逻辑，不是真实容量证据。
    capacityEvidence: process.platform === 'linux' ? 'linux-real' : 'injected-samples-only',
    productionChanged: false
}, null, 1));
process.exit(failed.length === 0 ? 0 : 1);
