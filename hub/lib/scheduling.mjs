import os from 'node:os';

/** 新调度只对明确支持恢复协议的插件开放；旧插件保留三店上限。 */
export function supportsScheduling(input = {}) {
    const [major, minor, patch] = String(input.pluginVersion || '').split('.').map(Number);
    return input.schedulingProtocol === 1 && major === 10 && (minor > 10 || minor === 10 && patch >= 59);
}

/** 指令描述下一步而非成功结果；未知写入结果只能核对，不能自动重新创建。 */
export function schedulingError(error) {
    const code = error.code || (/^[a-z_]+$/.test(error.message || '') ? error.message : 'request_failed');
    const status = Number(error.status || 500);
    const waits = new Set(['direct_capacity_wait', 'store_execution_wait', 'ingest_capacity_wait', 'ingest_permit_expired', 'database_capacity_wait', 'bulk_backpressure', 'target_offline']);
    const action = error.action || (waits.has(code) ? 'wait' : code === 'ingest_result_pending' ? 'reconcile' : status === 401 ? 'reauthenticate' : status === 403 ? 'stop' : status >= 500 ? 'reconcile' : 'stop');
    return { protocol: 1, action, reasonCode: code, retryAfterMs: ['wait', 'reconcile'].includes(action) ? Math.max(5000, Number(error.retryAfter || 15) * 1000) : 0 };
}

/** 仅调节新授权：健康且有需求时缓增，反馈积压、数据库等待或事件循环拥堵时退让。 */
// initial/max 设为 12：配合"一个账户同时只执行一家店"，允许多个账户各自并行推进，
// 账户之间不再互相占满全局名额。过载时控制器仍会自动下调，不需要人工干预。
//
// 内存分母：优先用**本服务限额**（cgroup memory.max），而不是整机内存。
// 整机内存会让"本服务已接近自己的上限"被算成很小的比例，等于永不降载（方案 D4）。
// memoryRatioProvider 由调用方注入：拿到 cgroup 样本时用服务限额，拿不到就返回 null，
// 此时**不参与降载判定**，交由资源预算的 budget_unknown 拒绝启用——而不是回退成整机内存。
export function createSchedulingController({ now = Date.now, pressure = () => ({}), min = 1, max = 12, initial = 12,
    memoryRatioProvider = null } = {}) {
    let limit = Math.max(min, Math.min(max, initial)), lastChange = now(), healthySince = now(), demand = 0;
    let pausedUntil = 0, reason = '', lastTick = now();
    function sample(extra = {}) {
        const t = now(), p = { ...pressure(), ...extra };
        // 显式传入的 memoryRatio 优先；否则用注入的服务限额采样。
        // 两条路径都要走服务限额：只在定时器里替换、而 sample() 里退回整机内存，
        // 会让任何直接调用 sample() 的入口继续用错误的分母（D4 只修一半）。
        if (!Number.isFinite(p.memoryRatio) && memoryRatioProvider) {
            const injected = memoryRatioProvider();
            if (Number.isFinite(injected)) p.memoryRatio = injected;
        }
        // memoryRatio 为 null 时不参与比较：`null >= 0.9` 是 false，符合"未知不降载"，
        // 但必须由预算侧的 budget_unknown 兜住启动，不能靠这里假装健康。
        const memory = Number.isFinite(p.memoryRatio) ? p.memoryRatio : null;
        const severe = p.feedbackPending >= 16 || p.dbWaitMs >= 3000 || p.loopLagMs >= 1500 || (memory !== null && memory >= 0.9);
        const overloaded = severe || p.dbWaitMs >= 500 || p.feedbackPending >= 4 || p.loopLagMs >= 250 || (memory !== null && memory >= 0.8) || p.errors > 2;
        if (overloaded) {
            healthySince = t; reason = severe ? 'server_overloaded' : 'server_backpressure';
            if (severe) pausedUntil = t + 30000;
            if (t - lastChange >= 30000) { limit = Math.max(min, Math.floor(limit / 2)); lastChange = t; }
        } else if (t >= pausedUntil) {
            reason = '';
            if (demand && t - healthySince >= 60000 && t - lastChange >= 60000) { limit = Math.min(max, limit + 1); lastChange = t; healthySince = t; demand = 0; }
        }
        return snapshot();
    }
    function snapshot() { return { protocol: 1, limit, min, max, paused: now() < pausedUntil, reasonCode: reason, retryAfterMs: 15000 }; }
    const timer = setInterval(() => {
        const t = now();
        // 默认（无注入）时退回整机内存，只为兼容旧调用方；生产路径必须注入服务限额。
        const memoryRatio = memoryRatioProvider ? memoryRatioProvider() : (process.memoryUsage().rss / os.totalmem());
        sample({ loopLagMs: Math.max(0, t - lastTick - 5000), memoryRatio });
        lastTick = t;
    }, 5000);    timer.unref();
    return { snapshot, sample, demand: () => { demand++; }, stop: () => clearInterval(timer),
        usesServiceLimit: Boolean(memoryRatioProvider) };
}
