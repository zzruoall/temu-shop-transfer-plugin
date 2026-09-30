/** 页面执行轮次只授权当前文档；MV3休眠不等于刷新，持久化停止通知只补发取消而不恢复业务。 */
const executionDocumentEpochs = new Map();
const revokedExecutionRuns = new Set();
const executionActiveTabs = new Map();
const EXECUTION_STOP_ALARM = 'execution-run-stop';
const ingestPageEpochs = new Map();
let ingestStopFlush = null;

/** 入库与目标上架独立；重试必须仍处于原文档、原版本及未停止的采集代次。 */
async function ingestPageBinding(tabId, documentId = '') {
    const [entry] = await chrome.scripting.executeScript({ target: documentId ? { tabId, documentIds: [documentId] } : { tabId }, func: () => true });
    if (!entry?.documentId) throw Error('无法确认采集页面，请重新采集');
    const key = `ingestPageEpoch:${tabId}`;
    const stored = await chrome.storage.session.get(key);
    return { tabId, documentId: entry.documentId, version: chrome.runtime.getManifest().version,
        epoch: stored[key] || '', memoryEpoch: ingestPageEpochs.get(tabId) || 0 };
}
/** 持久代次用于跨后台唤醒，内存代次用于立即截断正在等待异步结果的同页请求。 */
async function isIngestPageActive(binding) {
    if (!binding || binding.version !== chrome.runtime.getManifest().version) return false;
    if (ingestPageEpochs.has(binding.tabId) && ingestPageEpochs.get(binding.tabId) !== binding.memoryEpoch) return false;
    try {
        const key = `ingestPageEpoch:${binding.tabId}`;
        if (((await chrome.storage.session.get(key))[key] || '') !== binding.epoch) return false;
        await assertExecutionDocument(binding.tabId, binding.documentId);
        return true;
    } catch (_) { return false; }
}
/** 先撤销代次再清队列，失败回调不能把已取消条目插回；已发出的请求只保留结果核对线索。 */
async function invalidateIngestTab(tabId) {
    ingestPageEpochs.set(tabId, (ingestPageEpochs.get(tabId) || 0) + 1);
    await chrome.storage.session.set({ [`ingestPageEpoch:${tabId}`]: crypto.randomUUID(), [captureEnabledKey(tabId)]: false });
    // 所有已受理上传都按页面撤销，包括不在自动队列中的手动上传。
    const tracked = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(tracked)) {
        if (!key.startsWith('ingestRequest:') || value?.pageBinding?.tabId !== tabId) continue;
        await chrome.storage.local.set({ [`ingestStop:${value.requestId}`]: { requestId: value.requestId } });
        if (value.outboxId) await TemuIngestOutbox.retire(value.outboxId);
        await chrome.storage.local.remove(key);
    }
    void flushIngestStops().catch(() => {});
    return withIngestStore(async () => {
        const jobs = await loadPendingIngestJobs(), remaining = [];
        for (const job of jobs) {
            if (job.pageBinding?.tabId !== tabId) { remaining.push(job); continue; }
            await retireIngestJob(job);
        }
        await savePendingIngestJobs(remaining);
    });
}
/** 取消不代表服务端未接收，退出队列时保留摘要而不是记录为成功。 */
async function retireIngestJob(job) {
    const frozen = await TemuIngestOutbox.get(job.id);
    if (frozen?.requestId) {
        // 先持久化停止通知再移除正文；断网后只补发取消，绝不恢复旧商品上传。
        await chrome.storage.local.set({ [`ingestStop:${frozen.requestId}`]: { requestId: frozen.requestId } });
        void flushIngestStops().catch(() => {});
    }
    await TemuIngestOutbox.retire(job.id);
    await recordIngestOutcome({ fingerprint: job.fingerprint, jobId: job.id, status: 'error',
        error: 'capture_round_ended', reason: '页面或采集轮次已结束，停止自动上传；已发送内容需核对服务端结果' });
}

/** 停止通道只发送原requestId；独立于商品队列，最多两条并发，失败留给后续闹钟。 */
function flushIngestStops() {
    // 心跳、升级与刷新可能同时触发；共用一次冲刷，避免每个调用各开两条取消请求。
    if (!ingestStopFlush) ingestStopFlush = flushIngestStopsNow().finally(() => { ingestStopFlush = null; });
    return ingestStopFlush;
}
async function flushIngestStopsNow() {
    const state = await chrome.storage.local.get(null);
    // 重启/升级后复查原文档；只生成停止通知，不启动新的执行轮次。
    for (const [key, value] of Object.entries(state)) {
        if (!key.startsWith('ingestRequest:') || await isIngestPageActive(value.pageBinding)) continue;
        state[`ingestStop:${value.requestId}`] = { requestId: value.requestId };
        await chrome.storage.local.set({ [`ingestStop:${value.requestId}`]: { requestId: value.requestId } });
        if (value.outboxId) await TemuIngestOutbox.retire(value.outboxId);
        await chrome.storage.local.remove(key);
    }
    const pending = Object.entries(state).filter(([key]) => key.startsWith('ingestStop:'));
    for (let index = 0; index < pending.length; index += 2) {
        await Promise.all(pending.slice(index, index + 2).map(async ([key, value]) => {
            try {
                await hubJson(`/api/ingest/requests/${encodeURIComponent(value.requestId)}/cancel`, {});
                await chrome.storage.local.remove(key);
            } catch (_) { chrome.alarms?.create(EXECUTION_STOP_ALARM, { delayInMinutes: 0.5 }); }
        }));
    }
}
/** 升级后连尚未到重试时间或已耗尽次数的条目也清理，防止旧任务长期占满入库队列。 */
async function pruneInactiveIngestJobs(jobs) {
    const live = [];
    for (const job of jobs) {
        if (await isIngestPageActive(job.pageBinding)) live.push(job);
        else await retireIngestJob(job);
    }
    if (live.length !== jobs.length) await savePendingIngestJobs(live);
    return live;
}

/** 文档编号由浏览器给出，不信任页面消息自报；旧文档不能把请求注入刷新后的新页面。 */
async function assertExecutionDocument(tabId, documentId) {
    if (!tabId || !documentId) throw Error('无法确认当前页面文档，请更新浏览器后重新打开店铺');
    const [entry] = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
        func: () => ({ visible: true }) });
    if (!entry || entry.documentId !== documentId) throw Error('页面已变化，本次操作已终止');
}

/**
 * 同一店铺的停写必须串行：读-改-写之间若让出，新轮次可能已经落盘，
 * 旧回执再写回就会把状态覆盖成"旧轮次、已暂停"，干扰正在运行的新任务。
 * storage.local 没有 CAS，只能靠每店一条写入队列把"读最新→校验轮次→写"整体排好。
 */
const executionStateWrites = new Map();

/** 按店铺串行执行一次受保护的读-改-写；cb 返回 null 表示放弃写入。 */
function withExecutionStateLock(storeId, cb) {
    const key = String(storeId || '');
    const previous = executionStateWrites.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(cb);
    executionStateWrites.set(key, run.catch(() => {}));
    return run;
}

/**
 * 受保护写入：锁内重新读取，只有仍是目标轮次才落盘。
 * 旧回执迟到时轮次已经不匹配，直接放弃——绝不把新轮次覆盖回旧状态。
 */
function updateExecutionState(storeId, executionRunId, mutate) {
    const key = directPauseKey(storeId);
    return withExecutionStateLock(storeId, async () => {
        const latest = (await chrome.storage.local.get(key))[key];
        // 轮次已变（启用新轮/被清理）就放弃；这是防覆盖的关键判定。
        if (latest?.executionRunId !== executionRunId) return false;
        const patch = mutate(latest);
        if (!patch) return false;
        await chrome.storage.local.set({ [key]: { ...latest, ...patch } });
        return true;
    });
}

/** 停止通知先落盘；请求失败仍保持本地禁止提交，稍后只重传停止通知。 */
async function stopExecutionRound(state, reason, stopReason = "") {
    if (!state?.executionRunId) return;
    revokedExecutionRuns.add(state.executionRunId);
    const key = directPauseKey(state.storeId);
    const current = (await chrome.storage.local.get(key))[key];
    if (current?.executionRunId !== state.executionRunId) return;
    directStopRequested.add(state.storeId);
    directRerunTabs.delete(state.tabId);
    if (executionActiveTabs.get(state.tabId)?.executionRunId === state.executionRunId) executionActiveTabs.delete(state.tabId);
    // stopReason 决定服务端是清除该轮任务还是保留：只有操作者主动暂停才保留。
    await updateExecutionState(state.storeId, state.executionRunId, latest => ({
        paused: true, pendingStop: true, reason,
        stopReason: stopReason || latest.stopReason || "manual_stop"
    }));
    // 页面中的新增调用在最后一次异步校验后也检查停止标志；已经发出的平台请求不能撤销。
    await chrome.scripting.executeScript({ target: { tabId: state.tabId, documentIds: [state.documentId] }, world: 'MAIN',
        func: id => { if (window.__temuExecutionRound?.id === id) window.__temuExecutionRound.stopped = true; },
        args: [state.executionRunId] }).catch(() => {});
    // 本地禁止提交已经落盘；通知不在这里等待，避免一家店网络故障拖住调用方。
    void flushExecutionStopFor(state.storeId).catch(() => {});
}

let executionStopFlush = null;
let executionStopFlushByStore = new Map();
/**
 * 取消回执有独立通道；网络恢复只能重发停止，不重发商品创建。
 * 每个轮次独立发送并独立重试：一家旧店故障不能挡住同实例其他店铺的启用。
 * 回执恢复与停止通知互不阻塞——回执只是补充证据，不能让取消通知停在它后面。
 */
function flushExecutionStops() {
    void flushIngestStops().catch(() => {});
    if (executionStopFlush) return executionStopFlush;
    executionStopFlush = (async () => {
        const stored = await chrome.storage.local.get(null);
        const pendingEntries = Object.entries(stored)
            .filter(([key, value]) => key.startsWith('directPause:') && value?.pendingStop && value.executionRunId);
        // 各自独立结算：失败只标记本条目待重试，不中断同批其他轮次。
        const outcomes = await Promise.all(pendingEntries.map(([key, value]) => flushExecutionStopEntry(key, value)));
        const pending = outcomes.some(ok => !ok);
        if (pending) chrome.alarms?.create(EXECUTION_STOP_ALARM, { delayInMinutes: 0.5 });
        return !pending;
    })().finally(() => { executionStopFlush = null; });
    return executionStopFlush;
}

/**
 * 停止通知最长等待时间。超过就按"未确认"处理并留给后台闹钟重试，
 * 不能让一个挂死的请求把领取或启用流程一起拖住。
 */
const EXECUTION_STOP_TIMEOUT_MS = 8000;

/** 给可能永不返回的请求加超时：到点按失败处理，保留待重试标记。 */
function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error('停止通知超时')), ms); })
    ]);
}

/**
 * 单个轮次的停止通知：回执恢复不得阻断停止送达。
 *
 * 回执恢复只走后台，不 await：它可能因网络挂起而永不 settle，
 * 一旦等它就等于让取消通知停在回执后面——这正是"停止与反馈独立"要消除的耦合。
 * 回执单独记一个待补标记，由回执通道自己重试；停止只负责把取消送出去。
 * 停止请求本身同样可能挂起，所以也加超时：发送失败只影响本条，不拖住调用方。
 */
async function flushExecutionStopEntry(key, value) {
    // 不等待结果：挂起、失败、成功都不影响下面停止通知的发出。
    void recoverPausedDirectResults(value.identity).then(
        () => markReceiptPending(value.storeId, value.executionRunId, false),
        () => markReceiptPending(value.storeId, value.executionRunId, true)
    ).catch(() => {});
    try {
        const result = await withTimeout(hubJson('/api/jobs/execution-run', { ...value.identity, action: 'stop', executionRunId: value.executionRunId,
            // 终止原因决定服务端清不清任务：外部影响清除，操作者手动暂停保留。
            stopReason: value.stopReason || 'manual_stop',
            pluginInstanceId: await getPluginInstanceId(), executionRunProtocol: 1 }), EXECUTION_STOP_TIMEOUT_MS);
        // 服务端已把该轮任务清出队列时，本店本地快照也必须一并删除，否则下次仍会显示待上传。
        if (result?.purged && result.purged.removed > 0) await purgeLocalRunTasks(value.storeId, value.executionRunId);
        // 只在本条仍是原轮次时清除标记；期间换了新轮次不能覆盖新状态。
        await updateExecutionState(value.storeId, value.executionRunId, () => ({ pendingStop: false }));
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * 回执补发状态单独记录，不与停止通知共用一个标记，避免互相覆盖。
 * 形参必须与调用点一致（storeId, executionRunId, pending）：多一个无用形参会让实参整体左移，
 * updateExecutionState 收到 runId 当店铺、布尔值当轮次，写入静默失效且不报错。
 */
async function markReceiptPending(storeId, executionRunId, pending) {
    await updateExecutionState(storeId, executionRunId, () => ({ receiptPending: pending }));
}

/** 外部终止已清空服务端队列时，本地不留残影；只删属于该轮次的未提交任务。 */
async function purgeLocalRunTasks(storeId, executionRunId) {
    try {
        const tasks = await getTargetUploadTasks();
        const keep = [];
        const dropped = [];
        for (const task of tasks) {
            const sameRun = String(task.targetStoreId || "") === String(storeId)
                && String(task.executionRunId || "") === String(executionRunId);
            // 已有提交记录的项要保留证据，不能因为队列清空就丢掉结果核对线索。
            const attempt = await chrome.storage.local.get(`directAttempt:${task.jobId}:${task.spuId}`);
            const hasAttempt = Boolean(attempt?.[`directAttempt:${task.jobId}:${task.spuId}`]?.attemptId);
            if (sameRun && !hasAttempt) dropped.push(task);
            else keep.push(task);
        }
        if (dropped.length) await saveTargetUploadTasks(keep);
        return dropped.length;
    } catch (_) { return 0; }
}

/**
 * 只结算指定店铺的待发停止通知。启用 B 店时不得被 A 店故障或挂起请求挡住，
 * 所以启用前只等本店的停止确认，其他店铺交给后台闹钟独立重试。
 */
function flushExecutionStopFor(storeId) {
    const key = directPauseKey(storeId);
    const existing = executionStopFlushByStore.get(storeId);
    if (existing) return existing;
    const run = (async () => {
        const value = (await chrome.storage.local.get(key))[key];
        if (!value?.pendingStop || !value.executionRunId) return true;
        return await flushExecutionStopEntry(key, value);
    })().finally(() => { executionStopFlushByStore.delete(storeId); });
    executionStopFlushByStore.set(storeId, run);
    return run;
}

/** 刷新/关闭事件先推进内存代次，再异步落盘，拦截正在等待网络返回的启用操作。 */
function invalidateExecutionTab(tabId, reason, stopReason = "page_close") {
    executionDocumentEpochs.set(tabId, (executionDocumentEpochs.get(tabId) || 0) + 1);
    directRerunTabs.delete(tabId);
    const active = executionActiveTabs.get(tabId);
    if (active) { revokedExecutionRuns.add(active.executionRunId); directStopRequested.add(active.storeId); }
    const run = directPauseControlQueue.then(async () => {
        const stored = await chrome.storage.local.get(null);
        for (const [key, value] of Object.entries(stored)) {
            if (key.startsWith('directPause:') && value?.tabId === tabId && !value.paused) await stopExecutionRound(value, reason, stopReason);
        }
    });
    directPauseControlQueue = run.catch(() => {});
    return run;
}

/** 同页同商城才附带执行轮次；识别到切店或新文档时先终止原页面，不继承旧授权。 */
async function bindExecutionIdentity(sender, identity, controlLocked = false) {
    if (!controlLocked) {
        const run = directPauseControlQueue.then(() => bindExecutionIdentity(sender, identity, true));
        directPauseControlQueue = run.catch(() => {});
        return run;
    }
    const tabId = sender.tab.id, documentId = sender.documentId;
    await assertExecutionDocument(tabId, documentId);
    const identityKey = `executionPageStore:${tabId}`;
    const previous = (await chrome.storage.session.get(identityKey))[identityKey];
    if (previous && previous !== identity.storeId) await invalidateIngestTab(tabId);
    await chrome.storage.session.set({ [identityKey]: identity.storeId });
    const stored = await chrome.storage.local.get(null);
    for (const [key, value] of Object.entries(stored)) {
        if (key.startsWith('directPause:') && value?.tabId === tabId && !value.paused
            && (value.documentId !== documentId || value.storeId !== identity.storeId || value.enabledVersion !== chrome.runtime.getManifest().version)) {
            // 三种外部原因都算非人工终止，任务要清走；分别标记便于服务端日志区分。
            const stopReason = value.storeId !== identity.storeId ? 'store_switch'
                : value.enabledVersion !== chrome.runtime.getManifest().version ? 'plugin_upgrade' : 'page_refresh';
            await stopExecutionRound(value, '页面刷新、切换店铺或插件升级，本轮未执行任务已停止', stopReason);
        }
    }
    const state = (await chrome.storage.local.get(directPauseKey(identity.storeId)))[directPauseKey(identity.storeId)];
    if (!state?.paused && state?.documentId === documentId && state?.tabId === tabId) executionActiveTabs.set(tabId, state);
    return { ...identity, tabId, documentId, executionRunProtocol: 1,
        executionRunId: !state?.paused && state?.documentId === documentId && state?.tabId === tabId ? state.executionRunId || '' : '' };
}

/** 人工启用先创建服务端轮次，再开放本地提交；启动响应丢失时保留停止记录，绝不猜测已获授权。 */
async function startExecutionRound(sender, identity) {
    const tabId = sender.tab.id, documentId = sender.documentId, epoch = executionDocumentEpochs.get(tabId) || 0;
    if (directRunningStores.has(identity.storeId)) throw Error('上一件商品仍在核对结果，请稍后启用新一轮');
    await assertExecutionDocument(tabId, documentId);
    const key = directPauseKey(identity.storeId), old = (await chrome.storage.local.get(key))[key];
    if (old?.executionRunId && !old.paused) await stopExecutionRound(old, '操作者启用新一轮，旧轮次已结束');
    // 只等本店的停止确认；同实例其他店铺的停止失败或挂起不能挡住这里启用。
    if (!await flushExecutionStopFor(identity.storeId)) throw Error('旧轮次停止通知尚未确认，请网络恢复后再启用');
    // 其他店铺的待发停止在后台独立重试，不阻塞也不吞掉失败。
    void flushExecutionStops().catch(() => {});
    const registration = await registerStoreAgent(identity);
    const executionRunId = crypto.randomUUID();
    const state = { paused: true, pendingStop: true, executionRunId, tabId, documentId, storeId: identity.storeId,
        identity, enabledVersion: chrome.runtime.getManifest().version, at: new Date().toISOString() };
    // 新轮次落盘与旧轮的迟到写入共用同一把店铺锁：谁后写谁生效，
    // 不能让旧轮次的停止回调把刚建立的新轮次覆盖回"已暂停"。
    await withExecutionStateLock(identity.storeId, () => chrome.storage.local.set({ [key]: state }));
    try {
        const result = await hubJson('/api/jobs/execution-run', { ...identity, action: 'start', executionRunId,
            previousRunId: registration.agent?.executionRunLastId || '', pluginInstanceId: await getPluginInstanceId() });
        await assertExecutionDocument(tabId, documentId);
        if ((executionDocumentEpochs.get(tabId) || 0) !== epoch || revokedExecutionRuns.has(executionRunId)) throw Error('页面已经变化，未启用执行');
        await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'MAIN', func: id => {
            window.__temuExecutionRound = { id, stopped: false };
            window.addEventListener('pagehide', () => { if (window.__temuExecutionRound?.id === id) window.__temuExecutionRound.stopped = true; }, { once: true });
        }, args: [executionRunId] });
        if ((executionDocumentEpochs.get(tabId) || 0) !== epoch) throw Error('页面已经变化，未启用执行');
        // 只有本条仍是本次轮次时才开放提交；中途被替换就放弃，不复活旧状态。
        await updateExecutionState(identity.storeId, executionRunId, () => ({
            paused: false, pendingStop: false, expiresAt: result.expiresAt
        }));
        if ((executionDocumentEpochs.get(tabId) || 0) !== epoch) throw Error('页面已经变化，已停止执行');
        executionActiveTabs.set(tabId, state);
        directStopRequested.delete(identity.storeId);
        return { ...identity, executionRunId };
    } catch (error) {
        await stopExecutionRound(state, '启用未完成，已停止本轮').catch(() => {});
        throw error;
    }
}
