/**
 * 账户专属进程监督器。
 *
 * 职责（对应方案第 3 节）：
 * - 公平挑账户 → fork 一个绑定该账户的子进程 → 用完回收；
 * - 进程名额在 fork **之前**原子登记，收到 exit **之后**才真正释放；
 * - 同时最多 `maxAccountProcesses` 个子进程，包含启动中与退出中的；
 * - 启动失败按 1/2/4/8 秒退避、上限 30 秒；同账户 5 次/10 分钟失败进入待处理，不忙循环重启。
 *
 * 边界：子进程没有监听端口、不建自己的数据库池、不跑全局定时器；
 * 它承担本账户的商品解析与结果方案生成，平台请求仍由插件执行。
 * 本模块只做进程生命周期与名额，不含 IPC 业务语义（那在 broker 里）。
 */
import { fork } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 方案第 2 节给出的起始配置候选；实际取值由调用方传入并经实测调整。 */
export const ACCOUNT_PROCESS_INITIAL_LIMITS = Object.freeze({
    maxAccountProcesses: 2,
    maxActiveItemsPerAccount: 1,
    maxUnsettledPublishes: 2,
    maxIngestReceivers: 2,
    maxHeavyParsers: 1,
    ingestReservedBytes: 64 * 1024 * 1024,
    stagedBytesGlobal: 256 * 1024 * 1024,
    stagedBytesPerAccount: 64 * 1024 * 1024,
    ipcMessageBytes: 64 * 1024,
    workerOldSpaceMiB: 128,
    prepareQuantumMs: 5000,
    idleExitMs: 30000
});

/** 启动退避序列与失败熔断阈值。 */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 30000];
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const FAILURE_LIMIT = 5;

/**
 * @param {object} options
 * @param {string} options.workerPath 子进程入口（account-worker.mjs）
 * @param {number} [options.maxAccountProcesses] 同时存在的子进程上限
 * @param {number} [options.maxStartPerSecond] 启动速率上限
 * @param {number} [options.idleExitMs] 空闲多久后主动让位退出
 * @param {Function} [options.onTrace] 事件回调，用于验收轨迹
 */
export function createAccountProcessSupervisor({
    workerPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'workers', 'account-worker.mjs'),
    maxAccountProcesses = ACCOUNT_PROCESS_INITIAL_LIMITS.maxAccountProcesses,
    maxStartPerSecond = 1,
    idleExitMs = ACCOUNT_PROCESS_INITIAL_LIMITS.idleExitMs,
    workerOldSpaceMiB = ACCOUNT_PROCESS_INITIAL_LIMITS.workerOldSpaceMiB,
    // 受控源根：worker 以它为根解析 sourceRef，绝对路径由 worker 独立拦截。
    // 由调用方显式传入，不依赖子进程猜测工作目录。
    sourceRoot = '',
    onTrace = null,
    // 业务回执回调：监督器不解释业务，只把 worker 的 prepared/failed 转给运行器。
    onReply = null,
    onExit = null
} = {}) {
    // 活跃进程：accountId → { child, startedAt, epoch, exiting }
    const live = new Map();
    // 失败记录：accountId → [时间戳...]
    const failures = new Map();
    // 待处理账户（失败超限后不再自动重启）
    const quarantined = new Set();
    // 退避到期时间：accountId → 最早允许再次启动的时间戳
    const nextAllowedAt = new Map();
    let supervisorEpoch = 0;
    let startTimestamps = [];
    // 空闲回收定时器：只在有活跃进程时运行，避免空转。
    let idleTimer = null;

    const trace = (type, fields) => { try { onTrace?.(type, fields); } catch { /* 轨迹失败不影响调度 */ } };
    /** 占用名额 = 活跃进程数（含退出中的）；这是 fork 前的准入依据。 */
    const liveCount = () => live.size;

    /**
     * 空闲回收：超过 idleExitMs **没有活动**的进程主动让位，释放名额给其他账户。
     *
     * 时间基准必须是"最后一次活动"而不是"启动时刻"：
     * 一个从启动起跑了 10 分钟的长任务，用 startedAt 判断会在第 30 秒就被判成空闲，
     * 而它其实一直在干活。busy 标记由消息流转维护（started/prepared/failed），
     * 两者结合才能既回收真空闲、又不打扰长任务。
     */
    function ensureIdleReclaim() {
        if (idleTimer || !live.size) return;
        const period = Math.max(10, Math.floor(idleExitMs / 2));
        idleTimer = setInterval(() => {
            const nowMs = Date.now();
            for (const [accountId, entry] of live) {
                // 退出中或正在执行任务的**一律不回收**：让位只在安全点进行。
                if (entry.exiting || entry.yielding || entry.busy) continue;
                const lastActivity = entry.lastActivityAt || entry.startedAt;
                if (nowMs - lastActivity >= idleExitMs) {
                    trace('process:idle-reclaim', { accountId, pid: entry.child?.pid || null,
                        idleMs: nowMs - lastActivity, startedAt: entry.startedAt, lastActivityAt: lastActivity });
                    // 主动让位不算失败，因此先标记 yielding。
                    void requestYield(accountId, { timeoutMs: 2000 }).catch(() => {});
                }
            }
            if (!live.size) { clearInterval(idleTimer); idleTimer = null; }
        }, period);
        // 不阻塞进程退出：定时器不应让服务无法关闭。
        idleTimer.unref?.();
    }

    /** 启动速率限制：每秒最多 maxStartPerSecond 个，避免 fork 风暴。 */
    function startAllowed(nowMs = Date.now()) {
        startTimestamps = startTimestamps.filter(t => nowMs - t < 1000);
        if (startTimestamps.length >= maxStartPerSecond) return false;
        startTimestamps.push(nowMs);
        return true;
    }

    /** 退避时长：按该账户近期失败次数递增。 */
    function backoffFor(accountId) {
        const list = failures.get(accountId) || [];
        return BACKOFF_MS[Math.min(list.length, BACKOFF_MS.length - 1)];
    }

    function recordFailure(accountId, nowMs = Date.now()) {
        const list = (failures.get(accountId) || []).filter(t => nowMs - t < FAILURE_WINDOW_MS);
        list.push(nowMs);
        failures.set(accountId, list);
        if (list.length >= FAILURE_LIMIT) quarantined.add(accountId);
        // 记录退避到期：下次启动必须等过这段时间，不能立刻重试。
        nextAllowedAt.set(accountId, nowMs + BACKOFF_MS[Math.min(list.length - 1, BACKOFF_MS.length - 1)]);
        return list.length;
    }

    /**
     * 为一个账户启动子进程。
     * 名额在 fork 之前登记（先用占位项占住 live），失败时移除；
     * 这样"启动中"的进程也计入上限，不会因为并发启动而超开。
     */
    async function spawnFor(accountId, payload = {}) {
        if (quarantined.has(accountId)) return { started: false, reason: 'quarantined' };
        if (live.has(accountId)) return { started: false, reason: 'already_running' };
        // 退避检查：上次失败后必须等过退避时长，不能立刻重试（复核 N8）。
        const allowedAt = nextAllowedAt.get(accountId) || 0;
        if (Date.now() < allowedAt) {
            return { started: false, reason: 'backoff', retryAfterMs: allowedAt - Date.now() };
        }
        if (liveCount() >= maxAccountProcesses) return { started: false, reason: 'process_limit' };
        if (!startAllowed()) return { started: false, reason: 'start_rate_limited' };

        const epoch = ++supervisorEpoch;
        // 先占名额：占位项同样计入 liveCount，收到 exit 才删除。
        const placeholder = { child: null, startedAt: Date.now(), epoch, exiting: false, placeholder: true };
        live.set(accountId, placeholder);
        trace('process:fork-requested', { accountId, epoch });
        let child;
        try {
            // 租约号不是凭据；放在参数里供OS核对fork后尚未登记PID的崩溃窗口。
            child = fork(workerPath, payload.processLeaseId ? [`--account-lease=${payload.processLeaseId}`] : [], {
                // 最小环境：只传子进程真正需要的变量，不继承整个 process.env
                // （父进程环境可能含凭据；子进程没有数据库池，也不需要它们）。
                env: {
                    PATH: process.env.PATH,
                    NODE_ENV: process.env.NODE_ENV || 'production',
                    LANG: process.env.LANG || 'C.UTF-8',
                    TEMP: process.env.TEMP,
                    TMP: process.env.TMP,
                    SYSTEMROOT: process.env.SYSTEMROOT,
                    WORKER_ACCOUNT_ID: accountId,
                    WORKER_SUPERVISOR_EPOCH: String(epoch),
                    // 只在显式配置时传入：留空则 worker 退回自己的默认根，不传空串覆盖。
                    ...(sourceRoot ? { WORKER_SOURCE_ROOT: String(sourceRoot) } : {})
                },
                // Windows 下不弹窗；旧生代上限限制单进程内存。
                windowsHide: true,
                execArgv: [`--max-old-space-size=${workerOldSpaceMiB}`],
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            });
        } catch (error) {
            live.delete(accountId);
            const count = recordFailure(accountId);
            trace('process:fork-failed', { accountId, epoch, reason: String(error.message || error) });
            return { started: false, reason: 'fork_failed', failures: count, backoffMs: backoffFor(accountId) };
        }
        placeholder.child = child;
        // 无交互终端，排空诊断管道，避免日志反压阻塞子进程。
        child.stdout?.resume();
        child.stderr?.resume();
        placeholder.placeholder = false;
        // 忙闲跟踪：busy 由消息流维护，lastActivityAt 用于空闲回收的时间基准。
        // 只更新一次 startedAt 会让长任务在第 idleExitMs 秒被误判成空闲。
        placeholder.busy = false;
        placeholder.lastActivityAt = Date.now();
        placeholder.markBusy = () => { placeholder.busy = true; placeholder.lastActivityAt = Date.now(); };
        placeholder.markIdle = () => { placeholder.busy = false; placeholder.lastActivityAt = Date.now(); };
        // 启动空闲回收：超过 idleExitMs 未推进的进程主动让位，名额给其他账户。
        ensureIdleReclaim();
        trace('process:fork', { accountId, epoch, pid: child.pid });
        // 是否确认过启动成功（收到 ready）——用于区分"正常让位退出"与"启动即失败"。
        placeholder.ready = false;
        placeholder.readyWaiters = [];
        // 子进程退出后才释放名额：退出中的进程仍计入上限。
        child.once('exit', (code, signal) => {
            placeholder.exiting = true;
            live.delete(accountId);
            // 主动让位不是失败；其余退出都要计失败并退避，分两种情形：
            // 1) 未收到 ready 就退出 = 启动失败（fork 对缺失入口是异步失败的：
            //    先返回 pid，随后以 exit code=1 报错）；
            // 2) ready 之后异常退出（退出码非 0 或被信号杀死）= 运行期崩溃，
            //    同样不能立刻重启，否则会变成崩溃—重启的死循环（复核 T7）。
            const crashedAfterReady = placeholder.ready && (Number(code) !== 0 || signal);
            if (!placeholder.yielding && (!placeholder.ready || crashedAfterReady)) {
                recordFailure(accountId);
                trace(placeholder.ready ? 'process:crashed' : 'process:start-failed',
                    { accountId, epoch, pid: child.pid, code, signal });
            }
            trace('process:exit', { accountId, epoch, pid: child.pid, code, signal });
            try { onExit?.({ accountId, epoch, pid: child.pid, code, signal }); }
            catch (error) { trace('process:exit-handler-failed', { accountId, reason: String(error.message || error) }); }
        });
        child.once('error', error => {
            recordFailure(accountId);
            trace('process:error', { accountId, epoch, pid: child.pid, reason: String(error.message || error) });
        });
        // 收到子进程的 ready 才算启动成功：此前退出都按启动失败处理。
        child.on('message', message => {
            if (message?.type === 'ready') { placeholder.ready = true; placeholder.lastActivityAt = Date.now(); }
            // 任务开始/结束都刷新活动时间：长任务因此不会被空闲回收误杀。
            if (message?.type === 'started' || message?.type === 'prepared' || message?.type === 'failed') {
                placeholder.lastActivityAt = Date.now();
            }
            if (message?.type === 'started') placeholder.markBusy?.();
            if (message?.type === 'prepared' || message?.type === 'failed') placeholder.markIdle?.();
            /**
             * 业务回执交给调用方处理。
             *
             * 监督器只负责进程生命周期，不解释业务语义；但"收到回执"这件事
             * 必须在监督器里转出来，否则运行器只能靠轮询数据库发现结果，
             * 既延迟又会在进程退出后丢失时机。
             */
            if (message?.type === 'prepared' || message?.type === 'failed') {
                try {
                    onReply?.({
                        accountId, epoch, workId: String(message.workId || ''),
                        type: message.type, result: message.result, reason: message.reason
                    });
                } catch (error) {
                    // 回执处理失败不能影响子进程回收；由运行器侧记录。
                    trace('process:reply-failed', { accountId, workId: message.workId || '', reason: String(error?.message || error) });
                }
            }
        });
        // 把初始任务通过 IPC 交给子进程（小消息，只含引用）。
        try { child.send({ protocol: 1, operation: 'start', accountId, supervisorEpoch: epoch, ...payload }); }
        catch (error) { trace('process:send-failed', { accountId, epoch, reason: String(error.message || error) }); }
        return { started: true, accountId, epoch, pid: child.pid };
    }

    /** 请求某账户让位：先请子进程在安全点退出，确认 exit 后再回收名额。 */
    async function requestYield(accountId, { timeoutMs = 10000 } = {}) {
        const entry = live.get(accountId);
        if (!entry?.child) return { yielded: false, reason: 'not_running' };
        const child = entry.child;
        // 标记为主动让位：退出事件据此区分"正常让位"与"启动即失败"。
        entry.yielding = true;
        const exited = new Promise(resolve => child.once('exit', () => resolve(true)));
        try { child.send({ protocol: 1, operation: 'yield', accountId, supervisorEpoch: entry.epoch }); }
        catch { /* 通道已断：直接走强制退出 */ }
        const timeout = new Promise(resolve => setTimeout(() => resolve(false), timeoutMs));
        if (!await Promise.race([exited, timeout])) {
            // 安全点内未退出：不强杀正在进行的平台请求，交由调用方决定。
            return { yielded: false, reason: 'yield_timeout' };
        }
        return { yielded: true, pid: child.pid };
    }

    /** 优雅停止：用于服务关闭。不删除任何调度状态，只回收进程。 */
    async function stopAll({ timeoutMs = 10000 } = {}) {
        if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
        const ids = [...live.keys()];
        const results = await Promise.all(ids.map(id => requestYield(id, { timeoutMs }).catch(() => ({ yielded: false }))));
        return { stopped: results.filter(r => r.yielded).length, total: ids.length };
    }

    return {
        spawnFor,
        requestYield,
        stopAll,
        /**
         * 仅测试用：向指定账户的子进程发一条消息并等待其回执。
         * 用于验证"旧 epoch / 错误账户 / 白名单外操作必须被拒绝"。
         * 只认本次消息对应的回执：用 workId 区分，避免捕获到初始任务的 started 回执。
         * 生产路径不应使用它——正常下发走 spawnFor 的初始任务。
         */
        __sendForTest: async (accountId, message, { timeoutMs = 3000 } = {}) => {
            const entry = live.get(accountId);
            if (!entry?.child) return null;
            const child = entry.child;
            const marker = message.workId || '';
            return await new Promise(resolve => {
                const timer = setTimeout(() => { child.off('message', onMessage); resolve(null); }, timeoutMs);
                const onMessage = reply => {
                    // 只接受与本次消息 workId 相符的回执；空 workId 的消息用类型判定。
                    if (!reply || !['rejected', 'started', 'prepared', 'pong'].includes(reply.type)) return;
                    if (marker && String(reply.workId || '') !== marker) return;
                    clearTimeout(timer);
                    child.off('message', onMessage);
                    resolve(reply);
                };
                child.on('message', onMessage);
                try { child.send(message); } catch { clearTimeout(timer); child.off('message', onMessage); resolve(null); }
            });
        },
        /** 观测：当前活跃进程、隔离账户、名额上限。 */
        snapshot: () => ({
            live: [...live.entries()].map(([accountId, entry]) => ({ accountId, pid: entry.child?.pid || null, epoch: entry.epoch, exiting: entry.exiting })),
            count: liveCount(), max: maxAccountProcesses,
            quarantined: [...quarantined]
        }),
        isQuarantined: accountId => quarantined.has(accountId),
        /** 观测：该账户是否仍在退避窗口内。 */
        backoffRemainingMs: accountId => Math.max(0, (nextAllowedAt.get(accountId) || 0) - Date.now()),
        releaseQuarantine: accountId => quarantined.delete(accountId),
        limits: { maxAccountProcesses, maxStartPerSecond, idleExitMs, workerOldSpaceMiB }
    };
}
