/** 页面会话管理本地执行；来源入库取消独立保留，不恢复刷新前的目标任务。 */
const executionDocumentEpochs = new Map();
const revokedExecutionRuns = new Set();
const executionActiveTabs = new Map();
const EXECUTION_STOP_ALARM = 'execution-run-stop';
const ingestPageEpochs = new Map();
let ingestStopFlush = null;

/** 页面注入调用必须有截止时间；超时仅终止本地等待，不重发或宣称已撤回平台请求。 */
async function executionWithDeadline(action, timeoutMs = 20000) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(Error('页面调用超时，请核对当前店铺后重试'), { executionTimeout: true })), timeoutMs);
        })]);
    } finally { clearTimeout(timer); }
}

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
    const [entry] = await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] },
        func: () => ({ visible: true }) }));
    if (!entry || entry.documentId !== documentId) throw Error('页面已变化，本次操作已终止');
}

/** 本地控制串行更新，不再向服务端申请或补发执行状态。 */
const executionStateWrites = new Map();
function withExecutionStateLock(storeId, cb) {
    const previous = executionStateWrites.get(storeId) || Promise.resolve();
    const run = previous.catch(() => {}).then(cb);
    executionStateWrites.set(storeId, run.catch(() => {}));
    return run;
}
/** 旧页面异步结果不能覆盖新代次的控制状态。 */
function updateExecutionState(storeId, executionRunId, mutate) {
    return withExecutionStateLock(storeId, () => withTargetTaskMutation(async () => {
        const key = directPauseKey(storeId);
        const latest = (await chrome.storage.session.get(key))[key];
        if (latest?.executionRunId !== executionRunId) return false;
        const patch = mutate(latest);
        if (!patch) return false;
        await chrome.storage.session.set({ [key]: { ...latest, ...patch } });
        return true;
    }));
}
/** 暂停只撤销本地提交代次；已发出的平台请求无法撤回。 */
async function stopExecutionRound(state, reason) {
    if (!state?.executionRunId) return;
    revokedExecutionRuns.add(state.executionRunId);
    directStopRequested.add(state.storeId);
    directRerunTabs.delete(state.tabId);
    await updateExecutionState(state.storeId, state.executionRunId, () => ({ paused: true, reason }));
    await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId: state.tabId, documentIds: [state.documentId] }, world: 'MAIN',
        func: id => { if (window.__temuExecutionRound?.id === id) window.__temuExecutionRound.stopped = true; },
        args: [state.executionRunId] })).catch(() => {});
}
/** 刷新先撤销内存代次，再清理会话队列，迟到响应不得写回新页面。 */
function invalidateExecutionTab(tabId, reason) {
    executionDocumentEpochs.set(tabId, (executionDocumentEpochs.get(tabId) || 0) + 1);
    directRerunTabs.delete(tabId);
    const active = executionActiveTabs.get(tabId);
    if (active) { revokedExecutionRuns.add(active.executionRunId); directStopRequested.add(active.storeId); }
    const run = directPauseControlQueue.then(async () => {
        const stored = await chrome.storage.session.get(null);
        for (const [key, state] of Object.entries(stored)) {
            if (!key.startsWith('directPause:') || state?.tabId !== tabId) continue;
            await stopExecutionRound(state, reason);
            await withTargetTaskMutation(async () => {
                await saveTargetUploadTasks((await getTargetUploadTasks()).filter(task => task.relaySessionId !== state.relaySessionId));
            });
            await chrome.storage.session.remove(key);
        }
        executionActiveTabs.delete(tabId);
    });
    directPauseControlQueue = run.catch(() => {});
    return run;
}

/** 会话绑定可信文档和真实商城；后台休眠保留同页状态，刷新、切店或升级不恢复旧任务。 */
async function bindExecutionIdentity(sender, identity, controlLocked = false) {
    if (!controlLocked) {
        const run = directPauseControlQueue.then(() => bindExecutionIdentity(sender, identity, true));
        directPauseControlQueue = run.catch(() => {});
        return run;
    }
    const tabId = sender.tab.id, documentId = sender.documentId;
    const epoch = executionDocumentEpochs.get(tabId) || 0;
    await assertExecutionDocument(tabId, documentId);
    const identityKey = `executionPageStore:${tabId}`;
    const previous = (await chrome.storage.session.get(identityKey))[identityKey];
    if (previous && previous !== identity.storeId) await invalidateIngestTab(tabId);
    const version = chrome.runtime.getManifest().version;
    const stored = await chrome.storage.session.get(null);
    for (const [key, state] of Object.entries(stored)) {
        if (!key.startsWith('directPause:')) continue;
        if (state.tabId !== tabId && state.storeId !== identity.storeId) continue;
        if (state.documentId === documentId && state.tabId === tabId && state.storeId === identity.storeId && state.enabledVersion === version) continue;
        await stopExecutionRound(state, '页面或商城变化，丢弃旧任务');
        await withTargetTaskMutation(async () => {
            await saveTargetUploadTasks((await getTargetUploadTasks()).filter(task => task.relaySessionId !== state.relaySessionId));
        });
        await chrome.storage.session.remove(key);
    }
    if ((executionDocumentEpochs.get(tabId) || 0) !== epoch) throw Error('页面已变化');
    await chrome.storage.session.set({ [identityKey]: identity.storeId });
    const key = directPauseKey(identity.storeId);
    let state = (await chrome.storage.session.get(key))[key];
    if (!state) {
        state = { storeId: identity.storeId, tabId, documentId, relaySessionId: crypto.randomUUID(),
            executionRunId: crypto.randomUUID(), paused: false, enabledVersion: version };
        await installLocalExecutionRound(state);
        if ((executionDocumentEpochs.get(tabId) || 0) !== epoch) throw Error('页面已变化');
        await withTargetTaskMutation(() => setTargetSessionValues({ [key]: state }));
        directStopRequested.delete(identity.storeId);
    }
    executionActiveTabs.set(tabId, state);
    return { ...identity, tabId, documentId, relayProtocol: 1,
        relaySessionId: state.relaySessionId, executionRunId: state.executionRunId };
}
/** 页面内最后一道门禁独立于网络，离开页面立即禁止尚未发出的新增。 */
async function installLocalExecutionRound(state) {
    await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId: state.tabId, documentIds: [state.documentId] }, world: 'MAIN',
        func: (id, stopped) => {
            window.__temuExecutionRound = { id, stopped };
            window.addEventListener('pagehide', () => {
                if (window.__temuExecutionRound?.id === id) window.__temuExecutionRound.stopped = true;
            }, { once: true });
        }, args: [state.executionRunId, state.paused] }));
}
/** 继续只换本地代次，保留接收会话和未开始队列，不进行服务器握手。 */
async function startExecutionRound(sender, identity, resetReception = false) {
    await assertExecutionDocument(sender.tab.id, sender.documentId);
    const key = directPauseKey(identity.storeId);
    const old = (await chrome.storage.session.get(key))[key];
    if (!old || old.relaySessionId !== identity.relaySessionId) throw Error('接收页面已变化');
    const epoch = executionDocumentEpochs.get(sender.tab.id) || 0;
    // 结束必须同时换接收会话，截断结束前尚未返回的网络投递；继续则保留同一批队列。
    const state = { ...old, paused: false, executionRunId: crypto.randomUUID(),
        ...(resetReception ? { relaySessionId: crypto.randomUUID(), pausedSendId: '', retiredSendIds: [] } : {}) };
    revokedExecutionRuns.add(old.executionRunId);
    await installLocalExecutionRound(state);
    if ((executionDocumentEpochs.get(sender.tab.id) || 0) !== epoch) throw Error('页面已变化');
    await withTargetTaskMutation(async () => {
        // 重读共享控制行保留刚提交的换批名单，再把执行代次与队列一起提交。
        const latest = (await chrome.storage.session.get(key))[key];
        if (!latest || latest.executionRunId !== old.executionRunId || latest.relaySessionId !== old.relaySessionId) throw Error('接收页面已变化');
        Object.assign(state, { ...latest, paused: false, executionRunId: state.executionRunId,
            ...(resetReception ? { relaySessionId: state.relaySessionId, pausedSendId: '', retiredSendIds: [] } : {}) });
        await saveTargetUploadTasks((await getTargetUploadTasks()).map(task =>
            task.relaySessionId === state.relaySessionId
                ? { ...task, executionRunId: state.executionRunId } : task), { [key]: state });
    });
    executionActiveTabs.set(sender.tab.id, state);
    directStopRequested.delete(identity.storeId);
    return { ...identity, relaySessionId: state.relaySessionId, executionRunId: state.executionRunId };
}
