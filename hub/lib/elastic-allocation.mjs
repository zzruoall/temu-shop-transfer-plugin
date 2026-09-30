/** 容量只控制新准入，不撤销已受理任务；硬上限表示运维允许范围，不等于当前可用名额。 */
const MiB = 1024 * 1024;
const defaults = { businessMax: 2, accountMax: 2, processMax: 1, publishMax: 2 };
/** 硬上限来自运维配置；非法值拒绝启动，不能静默扩大资源范围。 */
export function readElasticAllocationConfig(env = process.env) {
    const config = {};
    for (const [key, suffix] of Object.entries({ businessMax: 'BUSINESS_MAX', accountMax: 'ACCOUNT_MAX', processMax: 'PROCESS_MAX', publishMax: 'PUBLISH_MAX' })) {
        const raw = env[`ZINIAO_ELASTIC_${suffix}`];
        const value = raw === undefined ? defaults[key] : Number(raw);
        if (!Number.isInteger(value) || value < 1 || value > (key === 'processMax' ? 8 : 64)) throw Error(`elastic_config_invalid:${suffix}`);
        config[key] = value;
    }
    return config;
}

/** 用真实cgroup余量和既有健康判断共同限流；各采样中的占用量是已分配槽，不是新申请数。 */
export function createElasticAllocation({ config = {}, now = Date.now } = {}) {
    const cfg = { ...defaults, ...config };
    for (const key of Object.keys(defaults)) if (!Number.isInteger(cfg[key]) || cfg[key] < 1 || cfg[key] > (key === 'processMax' ? 8 : 64)) throw Error('elastic_config_invalid');
    let current = 0, healthySince = null, lastGrowth = null, sampledAt = null, initialized = false;
    let result = { businessLimit: 0, perAccountLimit: 0, processLimit: 0, publishLimit: 0, reason: 'resource_sample_missing' };
    function update(sample = {}) {
        const at = now();
        if (sampledAt !== null && (at < sampledAt || at - sampledAt > 15000)) { current = 0; healthySince = null; }
        sampledAt = at;
        const max = Number(sample.memoryMaxBytes), used = Number(sample.memoryCurrentBytes);
        const quota = sample.cpuMax?.quotaUs, period = Number(sample.cpuMax?.periodUs);
        const cpuValid = Number.isFinite(period) && period > 0 && (quota === null || (Number.isFinite(Number(quota)) && Number(quota) > 0));
        const memoryValid = typeof sample.memoryMaxBytes === 'number' && typeof sample.memoryCurrentBytes === 'number'
            && max > 0 && used >= 0 && Number.isFinite(max) && Number.isFinite(used);
        const good = sample.ok === true && memoryValid && cpuValid && sample.mode === 'healthy'
            && sample.canAuthorizeBusiness === true && used / max < 0.70;
        // 已占用资源在memory.current里；只为未来槽估算额外工作集，避免把同一占用再预留一次。
        const free = memoryValid ? Math.max(0, max * 0.70 - used - 64 * MiB) : 0;
        const occupied = Number(sample.activeBusiness ?? 0);
        const processes = Number(sample.activeProcesses ?? 0);
        const countsValid = Number.isInteger(occupied) && occupied >= 0 && Number.isInteger(processes) && processes >= 0;
        const cpuCap = quota === null ? cfg.processMax : Math.max(1, Math.floor(Number(quota) / period));
        const processCap = good && sample.canStartNewWork === true ? Math.min(cfg.processMax, cpuCap, sample.processLimit ?? cfg.processMax, processes + Math.floor(free / (128 * MiB))) : 0;
        // 准备进程和新增业务不能同时花掉同一份空闲内存，先预留至少一个可启动进程的工作集。
        const businessFree = Math.max(0, free - (processes ? 0 : 128 * MiB));
        const capacity = good ? Math.min(cfg.businessMax, occupied + Math.floor(businessFree / (64 * MiB))) : 0;
        // 已准备商品不再需要CPU进程；不能把进程余量不足扩散成发布许可永久归零。
        if (!good || !countsValid || capacity < 1) {
            current = 0; healthySince = null; lastGrowth = at; initialized = true;
            result = { businessLimit: 0, perAccountLimit: 0, processLimit: 0, publishLimit: 0,
                reason: !memoryValid || !cpuValid || !countsValid || sample.ok !== true ? 'resource_sample_missing' : 'resource_pressure', sampledAt: at };
            return result;
        }
        if (healthySince === null) healthySince = at;
        if (!initialized) { current = 1; lastGrowth = at; initialized = true; }
        current = Math.min(current, capacity);
        if (at - healthySince >= 30000 && at - lastGrowth >= 60000 && current < capacity) { current++; lastGrowth = at; }
        const processRoom = processes + Math.floor(Math.max(0, free - Math.max(0, current - occupied) * 64 * MiB) / (128 * MiB));
        result = { businessLimit: current, perAccountLimit: Math.min(cfg.accountMax, current),
            processLimit: Math.min(processCap, current, processRoom), publishLimit: Math.min(cfg.publishMax, current),
            reason: current ? '' : 'resource_recovery_wait', sampledAt: at };
        return result;
    }
    return { update, config: cfg, snapshot: () => sampledAt === null || now() < sampledAt || now() - sampledAt > 15000
        ? { ...result, businessLimit: 0, perAccountLimit: 0, processLimit: 0, publishLimit: 0, reason: 'resource_sample_stale' }
        : { ...result } };
}
