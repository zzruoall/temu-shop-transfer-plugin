/**
 * 运行时资源预算：所有新入口读取同一份预算，不再各自把 12 当作默认安全并发。
 *
 * 设计要点（对应方案第四节）：
 * - 内存分母必须是**本服务的限额**（cgroup memory.max），不是整机内存；
 *   读不到限额时**不按整机总量自动放开**——要求显式服务预算，否则拒绝启用新模式。
 * - CPU 节流与错误率用**采样差值/时间窗口**，不用累计值触发永久降载。
 * - 分级：70% 停扩进程、80% 停新增重解析与接收许可、90% 停新业务授权；
 *   已提交任务不被改成失败。
 * - 恢复需要连续 30 秒低于 65%，且数据库等待与事件循环延迟均已恢复；
 *   每 60 秒最多增加 1 个名额，不突破配置硬上限。
 * - 暂存与业务授权分开：磁盘低于保留值时拒绝新暂存，但回执/取消仍可处理。
 *
 * 本模块是纯逻辑 + 可注入采样：Windows 上的注入样本只能证明逻辑正确，
 * **不能当作真实 Linux 容量证据**。
 */
import { readFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';

export const BUDGET_MODE = Object.freeze({ healthy: 'healthy', constrained: 'constrained', paused: 'paused' });

/** 分级阈值与恢复参数。窗口与阈值需隔离实测修订，这里是保守起点。 */
export const DEFAULT_BUDGET_CONFIG = Object.freeze({
    processLimit: 2,
    parserLimit: 1,
    publishLimit: 2,
    // 内存分级（占本服务限额的比例）
    memoryStopSpawnRatio: 0.70,
    memoryStopParseRatio: 0.80,
    memoryStopBusinessRatio: 0.90,
    memoryRecoverRatio: 0.65,
    recoverHoldMs: 30_000,
    growIntervalMs: 60_000,
    // 数据库等待与事件循环延迟：连续两个窗口超阈值才降载
    dbWaitConstrainedMs: 500,
    dbWaitPausedMs: 3000,
    loopLagConstrainedMs: 250,
    loopLagPausedMs: 1500,
    windowMs: 10_000,
    requiredWindows: 2,
    // 磁盘保留：max(2 GiB, 文件系统容量的 10%)
    diskReserveMinBytes: 2 * 1024 * 1024 * 1024,
    diskReserveRatio: 0.10,
    // CPU 节流比例（节流周期 / 总周期）超此值视为受限
    cpuThrottleConstrainedRatio: 0.25,
    retryAfterMs: 5000
});

/** 从 /proc 读取本进程所在 cgroup 路径，不硬编码整机 cgroup 路径。 */
export function parseSelfCgroup(text) {
    // /proc/self/cgroup 形如 "0::/system.slice/ziniao.service"
    const line = String(text || '').split('\n').find(item => item.startsWith('0::'));
    if (!line) return '';
    const path = line.slice(3).trim();
    return path.startsWith('/') ? path : `/${path}`;
}

/** 从挂载信息里找出 cgroup2 的挂载点，避免假定一定是 /sys/fs/cgroup。 */
export function parseCgroupMount(text) {
    const line = String(text || '').split('\n')
        .find(item => /\bcgroup2\b/.test(item));
    if (!line) return '';
    const fields = line.split(/\s+/);
    return fields.length >= 5 ? fields[4] : '';
}

/** 解析 memory.max：`max` 表示无限制，返回 null（不能当成 0 或整机内存）。 */
export function parseMemoryMax(text) {
    const raw = String(text || '').trim();
    if (!raw || raw === 'max') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
}

/** 解析 cpu.stat 的累计计数；差值由调用方计算，累计值本身不触发降载。 */
export function parseCpuStat(text) {
    const out = {};
    for (const line of String(text || '').split('\n')) {
        const [key, value] = line.trim().split(/\s+/);
        if (key && value !== undefined) out[key] = Number(value);
    }
    return out;
}

/** 解析 cpu.max：`max 100000` 或 `50000 100000`。 */
export function parseCpuMax(text) {
    const [quota, period] = String(text || '').trim().split(/\s+/);
    return {
        quotaUs: quota === 'max' ? null : Number(quota),
        periodUs: Number(period) || 0
    };
}

/**
 * 读取真实 cgroup 采样。非 Linux 或读不到限额时返回 ok:false，
 * 由调用方决定是否拒绝启用——绝不回退成整机内存。
 */
export async function readCgroupSample({ selfCgroupPath = '/proc/self/cgroup', mountInfoPath = '/proc/self/mountinfo', statfsFn = statfs, dataPath = '.' } = {}) {
    if (process.platform !== 'linux') {
        return { ok: false, source: 'unsupported-platform', platform: process.platform };
    }
    try {
        const mountText = await readFile(mountInfoPath, 'utf8');
        const mount = parseCgroupMount(mountText);
        if (!mount) return { ok: false, source: 'no-cgroup2-mount' };
        const selfText = await readFile(selfCgroupPath, 'utf8');
        const relative = parseSelfCgroup(selfText);
        const base = `${mount}${relative}`;
        const [memoryCurrentText, memoryMaxText, cpuStatText, cpuMaxText, memoryEventsText] = await Promise.all([
            readFile(`${base}/memory.current`, 'utf8').catch(() => ''),
            readFile(`${base}/memory.max`, 'utf8').catch(() => ''),
            readFile(`${base}/cpu.stat`, 'utf8').catch(() => ''),
            readFile(`${base}/cpu.max`, 'utf8').catch(() => ''),
            readFile(`${base}/memory.events`, 'utf8').catch(() => '')
        ]);
        const memoryMaxBytes = parseMemoryMax(memoryMaxText);
        // 读取失败的空串不能被Number转成0，否则会把未知占用当作全部空闲。
        const memoryCurrentRaw = String(memoryCurrentText).trim();
        const memoryCurrentBytes = /^\d+$/.test(memoryCurrentRaw) ? Number(memoryCurrentRaw) : NaN;
        if (!memoryMaxBytes || !Number.isFinite(memoryCurrentBytes)) {
            // 限额缺失（例如整机 root cgroup）：明确报"不可用"，不猜测。
            return { ok: false, source: 'cgroup-limit-missing', cgroupPath: base };
        }
        const events = parseCpuStat(memoryEventsText);
        const disk = await readDiskSample({ statfsFn, path: dataPath });
        return {
            ok: true, source: 'cgroup', cgroupPath: base,
            memoryCurrentBytes, memoryMaxBytes,
            memoryOomKills: Number(events.oom_kill || 0),
            cpuStat: parseCpuStat(cpuStatText),
            cpuMax: parseCpuMax(cpuMaxText),
            ...disk
        };
    } catch (error) {
        return { ok: false, source: 'cgroup-read-failed', reason: String(error?.message || error) };
    }
}

/** 读取磁盘余量；失败时返回 null，表示"未知"，由调用方按拒绝新暂存处理。 */
export async function readDiskSample({ statfsFn = statfs, path = '.' } = {}) {
    try {
        const info = await statfsFn(path);
        const totalBytes = Number(info.blocks) * Number(info.bsize);
        const freeBytes = Number(info.bavail) * Number(info.bsize);
        if (!Number.isFinite(totalBytes) || !Number.isFinite(freeBytes)) return { diskFreeBytes: null, diskTotalBytes: null };
        return { diskFreeBytes: freeBytes, diskTotalBytes: totalBytes };
    } catch {
        return { diskFreeBytes: null, diskTotalBytes: null };
    }
}

/** 窗口分位数：只保留窗口内的样本，避免累计值导致永久降载。 */
function createWindow({ windowMs, now }) {
    let samples = [];
    return {
        push(value, at = now()) {
            if (!Number.isFinite(value)) return;
            samples.push({ at, value });
            samples = samples.filter(item => at - item.at <= windowMs);
        },
        count(at = now()) { return samples.filter(item => at - item.at <= windowMs).length; },
        p95(at = now()) {
            const values = samples.filter(item => at - item.at <= windowMs).map(item => item.value).sort((a, b) => a - b);
            if (!values.length) return 0;
            const index = Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1);
            return values[index];
        }
    };
}

/**
 * 预算控制器。
 * @param {object} options
 * @param {Function} options.probe 采样函数：返回 {ok, memoryCurrentBytes, memoryMaxBytes, ...}
 * @param {Function} options.now 可注入时钟（测试用）
 * @param {object} options.config 阈值覆盖
 * @param {boolean} options.requireServiceLimit 缺服务限额时是否拒绝（真实服务必须为 true）
 */
export function createRuntimeResourceBudget({ probe, now = Date.now, config = {}, requireServiceLimit = true, onTrace = () => {} } = {}) {
    const cfg = { ...DEFAULT_BUDGET_CONFIG, ...config };
    const dbWindow = createWindow({ windowMs: cfg.windowMs, now });
    const loopWindow = createWindow({ windowMs: cfg.windowMs, now });

    // 状态：分级 + 恢复计时 + 逐步放量
    let memoryMode = BUDGET_MODE.healthy;
    let latencyMode = BUDGET_MODE.healthy;
    let lastSample = { ok: false, source: 'never-probed' };
    let belowSince = null;
    // OOM 累计计数的上一次取值：只按增量暂停，历史击杀不永久降载。
    let previousOomKills = null;
    let lastGrowAt = 0;
    let processLimit = cfg.processLimit;
    let cpuThrottled = false;
    let latencyBreachSince = null;
    let previousCpu = null;
    let previousCpuAt = 0;

    /** 采样并计算预算；所有入口都读这个结果。 */
    async function sample() {
        const at = now();
        let raw;
        try { raw = await probe({ now: at }); }
        catch (error) { raw = { ok: false, source: 'probe-failed', reason: String(error?.message || error) }; }
        lastSample = raw || { ok: false, source: 'empty-sample' };
        if (!raw?.ok) {
            // 读不到服务限额：不按整机放开。要求显式预算，否则整链拒绝。
            const refused = requireServiceLimit;
            onTrace({ type: 'budget:unavailable', source: raw?.source || 'unknown', refused });
            return {
                mode: BUDGET_MODE.paused,
                processLimit: 0, parserLimit: 0, publishLimit: 0,
                canStartNewWork: false, canSpawnProcess: false, canStartParse: false,
                canAcceptNewStaging: false, canAuthorizeBusiness: false,
                reasonCode: refused ? 'budget_unknown' : 'budget_unavailable',
                retryAfterMs: cfg.retryAfterMs,
                memoryRatio: null,
                observed: { source: raw?.source || 'unknown', platform: process.platform }
            };
        }

        const memoryRatio = raw.memoryMaxBytes ? raw.memoryCurrentBytes / raw.memoryMaxBytes : null;
        // 只推真实样本：凭空补 0 会把"窗口内样本数"抬起来，让单次抖动被误判成连续两个窗口。
        if (Number.isFinite(raw.dbWaitMs)) dbWindow.push(raw.dbWaitMs, at);
        if (Number.isFinite(raw.loopLagMs)) loopWindow.push(raw.loopLagMs, at);

        // CPU 节流用差值：累计的 nr_throttled 会一路增长，不能直接触发降载。
        if (raw.cpuStat && Number.isFinite(raw.cpuStat.nr_throttled)) {
            if (previousCpu && at > previousCpuAt) {
                const throttledDelta = raw.cpuStat.nr_throttled - previousCpu.nr_throttled;
                const periodDelta = (raw.cpuStat.nr_periods || 0) - (previousCpu.nr_periods || 0);
                // 降载后cgroup可能完全空闲、不再增加周期；不能沿用上个窗口的节流标志把恢复永久锁死。
                cpuThrottled = periodDelta > 0 && throttledDelta >= 0
                    && (throttledDelta / periodDelta) >= cfg.cpuThrottleConstrainedRatio;
            }
            previousCpu = raw.cpuStat;
            previousCpuAt = at;
        }

        const dbP95 = dbWindow.p95(at);
        const loopP95 = loopWindow.p95(at);
        const windowsSeen = Math.max(dbWindow.count(at), loopWindow.count(at));

        // "持续两个窗口"按**时间**判定：连续越限必须累计到 requiredWindows × windowMs 才降载。
        // 只数样本个数会把"一秒内采两次"误当成两个窗口；只看单次 P95 又会让一个尖峰
        // 在滑动窗口里滞留十秒并立刻触发降载。两者都用时间长度来表达才准确。
        const breachedNow = dbP95 >= cfg.dbWaitConstrainedMs || loopP95 >= cfg.loopLagConstrainedMs || cpuThrottled;
        if (breachedNow) {
            if (latencyBreachSince === null) latencyBreachSince = at;
        } else {
            latencyBreachSince = null;
        }
        const breachDurationMs = latencyBreachSince === null ? 0 : at - latencyBreachSince;
        const requiredBreachMs = cfg.requiredWindows * cfg.windowMs;

        // 1) 严重延迟或 OOM 击杀：暂停新业务
        const severeLatency = dbP95 >= cfg.dbWaitPausedMs || loopP95 >= cfg.loopLagPausedMs;
        // OOM 必须按**增量**判定：memory.events 的 oom_kill 是累计计数，
        // 用 `> 0` 会让一次历史击杀把服务永久钉在暂停态——即使此后一直健康（复核 P2-2 之一）。
        const oomTotal = Number(raw.memoryOomKills || 0);
        const oomKilledNow = previousOomKills !== null && oomTotal > previousOomKills;
        if (Number.isFinite(oomTotal)) previousOomKills = oomTotal;
        if (severeLatency || oomKilledNow) latencyMode = BUDGET_MODE.paused;
        else if (breachDurationMs >= requiredBreachMs) latencyMode = BUDGET_MODE.constrained;
        else if (!breachedNow) latencyMode = BUDGET_MODE.healthy;

        // 2) 内存分级（带恢复迟滞）
        if (Number.isFinite(memoryRatio)) {
            // 只要没低于恢复线，就必须重置恢复计时——否则"低内存开始计时 → 反弹到 95% → 再回落"
            // 会在累计时间一到就立刻恢复，而不是重新连续统计（复核 P2-2 之二）。
            if (memoryRatio >= cfg.memoryRecoverRatio) belowSince = null;
            if (memoryRatio >= cfg.memoryStopBusinessRatio) memoryMode = BUDGET_MODE.paused;
            else if (memoryRatio >= cfg.memoryStopParseRatio) memoryMode = BUDGET_MODE.constrained;
            else if (memoryRatio >= cfg.memoryStopSpawnRatio) memoryMode = BUDGET_MODE.constrained;
            else if (memoryRatio < cfg.memoryRecoverRatio) {
                // 恢复需要连续低于恢复线，且延迟已恢复
                if (belowSince === null) belowSince = at;
                if (at - belowSince >= cfg.recoverHoldMs && latencyMode === BUDGET_MODE.healthy) memoryMode = BUDGET_MODE.healthy;
            }
        }

        // 3) 逐步放量：每 growIntervalMs 最多 +1，不突破硬上限
        if (memoryMode === BUDGET_MODE.healthy && latencyMode === BUDGET_MODE.healthy) {
            if (processLimit < cfg.processLimit && at - lastGrowAt >= cfg.growIntervalMs) {
                processLimit += 1;
                lastGrowAt = at;
                onTrace({ type: 'budget:grow', processLimit });
            } else if (at - lastGrowAt >= cfg.growIntervalMs) {
                lastGrowAt = at;
            }
        } else {
            // 降载立即生效，不需要等待间隔
            processLimit = 0;
        }

        const mode = memoryMode === BUDGET_MODE.paused || latencyMode === BUDGET_MODE.paused ? BUDGET_MODE.paused
            : (memoryMode === BUDGET_MODE.constrained || latencyMode === BUDGET_MODE.constrained ? BUDGET_MODE.constrained : BUDGET_MODE.healthy);

        const canSpawnProcess = mode === BUDGET_MODE.healthy && processLimit > 0;
        const canStartParse = mode !== BUDGET_MODE.paused && memoryMode !== BUDGET_MODE.paused && Number(memoryRatio ?? 0) < cfg.memoryStopParseRatio;
        const canAuthorizeBusiness = mode === BUDGET_MODE.healthy;

        // 4) 磁盘：低于保留值只拒绝**新暂存**，回执/取消不受影响。
        const reserveBytes = Math.max(cfg.diskReserveMinBytes, (raw.diskTotalBytes || 0) * cfg.diskReserveRatio);
        const diskLow = Number.isFinite(raw.diskFreeBytes) ? raw.diskFreeBytes < reserveBytes : false;
        const diskUnknown = !Number.isFinite(raw.diskFreeBytes);
        // 80% 档就要停新增接收许可（方案第四节）：内存 80% 以上时不再接收新暂存，
        // 否则"接收"会把已经吃紧的内存继续推高（复核 P2-2 之三）。
        const stagingMemoryBlocked = Number(memoryRatio ?? 0) >= cfg.memoryStopParseRatio;
        const canAcceptNewStaging = !diskLow && !diskUnknown && mode === BUDGET_MODE.healthy && !stagingMemoryBlocked;

        const reasonCode = mode === BUDGET_MODE.paused
            ? (oomKilledNow ? 'memory_oom_killed' : (severeLatency ? 'latency_paused' : (memoryMode === BUDGET_MODE.paused ? 'memory_critical' : 'budget_paused')))
            : (mode === BUDGET_MODE.constrained ? (cpuThrottled ? 'cpu_throttled' : (memoryMode === BUDGET_MODE.constrained ? 'memory_pressure' : 'latency_backpressure')) : '');

        return {
            mode,
            processLimit: mode === BUDGET_MODE.healthy ? processLimit : 0,
            parserLimit: canStartParse ? cfg.parserLimit : 0,
            publishLimit: canAuthorizeBusiness ? cfg.publishLimit : 0,
            canStartNewWork: canSpawnProcess,
            canSpawnProcess,
            canStartParse,
            canAcceptNewStaging,
            canAuthorizeBusiness,
            reasonCode,
            retryAfterMs: mode === BUDGET_MODE.healthy ? 0 : cfg.retryAfterMs,
            memoryRatio,
            diskFreeBytes: Number.isFinite(raw.diskFreeBytes) ? raw.diskFreeBytes : null,
            observed: {
                source: raw.source,
                dbWaitP95Ms: dbP95,
                loopLagP95Ms: loopP95,
                cpuThrottled,
                windowsSeen,
                breachDurationMs,
                diskLow,
                diskUnknown
            }
        };
    }

    return {
        sample,
        /** 观测用快照，不触发采样。 */
        snapshot: () => ({ processLimit, memoryMode, latencyMode, lastSource: lastSample?.source || 'unknown' }),
        config: cfg
    };
}

/**
 * 新模式启动前的预算就绪校验。
 * 方案要求：读不到服务限额时**不能按整机总量自动放开**——
 * 要么给出显式服务预算，要么拒绝启用 on/shadow。
 */
export function assertBudgetReadyForService({ mode, sample, explicitBudget = null } = {}) {
    if (mode === 'off') return { ready: true, checked: false, reason: 'off 模式不依赖预算' };
    if (explicitBudget && Number(explicitBudget.memoryMaxBytes) > 0) {
        return { ready: true, checked: true, source: 'explicit-budget', memoryMaxBytes: Number(explicitBudget.memoryMaxBytes) };
    }
    if (!sample?.ok) {
        throw Object.assign(new Error(`缺少可信服务资源限额（${sample?.source || 'unknown'}），不能启用账户进程模式`),
            { status: 503, code: 'budget_unavailable' });
    }
    return { ready: true, checked: true, source: sample.source, memoryMaxBytes: sample.memoryMaxBytes };
}
