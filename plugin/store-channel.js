"use strict";

// 同一商城只有一条后台连接；页面只是观看者，队列与执行门禁仍由现有本地会话管理。
const storeChannels = new Map();
const storeSnapshotWrites = new Map();

/** 状态序号跨后台唤醒保留，迟到的网络或页面回执不能覆盖新状态。 */
function publishStoreChannelState(storeId) {
    const previous = storeSnapshotWrites.get(storeId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
        const saved = await chrome.storage.session.get(null);
        const state = saved[directPauseKey(storeId)];
        const revisionKey = `storeChannelRevision:${storeId}`;
        const sequence = Number(saved[revisionKey] || 0) + 1;
        await chrome.storage.session.set({ [revisionKey]: sequence });
        const channel = storeChannels.get(storeId);
        const tasks = state ? summarizeTargetUploadTasks((saved[TARGET_UPLOAD_TASKS_KEY] || []).filter(task =>
            task.targetStoreId === storeId && task.relaySessionId === state.relaySessionId && task.executionRunId === state.executionRunId), storeId) : [];
        const common = { storeId, mallId: state?.mallId || storeId.replace(/^temu:/, ''),
            /**
             * 店名取值顺序必须与"谁能读到它"一致：页面读 DOM 拿到的最准（含托管备注），
             * 会话里存的是上一次读到的，服务端回显是更早的存量。
             * 这里把页面读到的放在最前，否则新店永远补不上名字——
             * 只会一直显示服务端的旧值或店铺 ID。
             */
            storeName: channel?.identity?.storeName || channel?.identity?.pageStoreName
                || state?.storeName || state?.pageStoreName || channel?.agent?.storeName || '',
            executionMode: 'plugin-api', identityMatched: Boolean(state),
            relaySessionId: state?.relaySessionId || '', executionRunId: state?.executionRunId || '',
            tasks, directPaused: Boolean(state?.paused), sequence,
            connection: channel?.connection || { phase: 'disconnected', detail: '连接已断开' } };
        const views = Object.values(saved).filter(value => value?.storeId === storeId && value?.documentId
            && saved[`executionViewer:${value.tabId}`] === value);
        for (const view of views) {
            try { await chrome.tabs.sendMessage(view.tabId, { type: 'storeAgentState', snapshot: { ...common, viewDocumentId: view.documentId } }, { documentId: view.documentId }); }
            catch { /* 页面可能已经离开；浏览器导航事件负责清理，不把发送失败当商品失败。 */ }
        }
        return common;
    });
    storeSnapshotWrites.set(storeId, next);
    void next.finally(() => { if (storeSnapshotWrites.get(storeId) === next) storeSnapshotWrites.delete(storeId); }).catch(() => {});
    return next;
}

/** 新观看页只绑定身份并获取快照，绝不等待商品推送或抢占同店执行页。 */
async function subscribeStoreChannel(sender, hints = {}) {
    const identity = await directIdentity(sender, hints);
    await assertExecutionDocument(sender.tab.id, sender.documentId);
    await rememberPageIdentity({ ...hints, pageUrl: sender.tab.url });
    /**
     * 页面读到的店名要**落进会话状态**，不能只留在这一次的 identity 里。
     *
     * 为什么必须落盘：连接重建、后台唤醒、切店都会重新拼身份，
     * 那时页面不在场、`hints` 是空的，只有会话里存着才不至于每断一次就退回店铺 ID。
     * 只在确实读到名字（非空）时覆盖，读不到时保留原值——
     * 用空串覆盖会把已经存下来的名字抹掉，那是另一种数据损坏。
     */
    const pageName = String(hints.pageStoreName || hints.storeName || '').trim().slice(0, 120);
    if (pageName) {
        const key = directPauseKey(identity.storeId);
        // 与会话队列共用同一把写锁：店名写入不能和"换批/结束"的队列提交交错。
        await withTargetTaskMutation(async () => {
            const state = (await chrome.storage.session.get(key))[key];
            if (!state || state.relaySessionId !== identity.relaySessionId) return;
            if (state.storeName === pageName && state.pageStoreName === pageName) return;
            await setTargetSessionValues({ [key]: { ...state, storeName: pageName, pageStoreName: pageName } });
        });
    }
    await chrome.storage.local.set({ [BOUND_STORE_KEY]: { storeId: identity.storeId, storeName: identity.storeName || identity.pageStoreName || `商城 ${identity.mallId}` } });
    ensureStoreChannel(identity);
    const snapshot = await publishStoreChannelState(identity.storeId);
    return { snapshot: { ...snapshot, viewDocumentId: sender.documentId } };
}

/** 同店连接建立单飞；重连只恢复网络通道，不读取服务器任务、不重发平台提交。 */
function ensureStoreChannel(identity) {
    const storeId = identity.storeId;
    const existing = storeChannels.get(storeId);
    if (existing?.identity.relaySessionId === identity.relaySessionId) {
        /**
         * 同会话但店名变了：必须**重开一次**连接。
         *
         * 为什么：认证帧只在建连时发一次，服务端的店名就来自那一帧。
         * 首屏 DOM 还没渲染出名时订阅，会用空名建连；之后即使读到真名，
         * 不重开就永远送不上去，网站只能一直显示店铺 ID（或更早的存量名）。
         * 用空名反向覆盖旧名的情况返回原记录，避免把已知名字抹掉。
         */
        const next = String(identity.storeName || identity.pageStoreName || '').trim();
        const current = String(existing.identity.storeName || existing.identity.pageStoreName || '').trim();
        if (!next || next === current) return;
        closeStoreChannel(existing);
    } else if (existing) closeStoreChannel(existing);
    const record = { identity, connection: { phase: 'connecting', detail: '正在连接' },
        socket: null, timer: null, failures: 0, stopped: false, incoming: Promise.resolve() };
    storeChannels.set(storeId, record);
    void openStoreChannel(record);
}

/** 只清理当前连接自己的资源，旧连接关闭不能撤销已建立的新会话。 */
function closeStoreChannel(record) {
    record.stopped = true;
    clearTimeout(record.timer); clearTimeout(record.deadline);
    record.socket?.close();
    if (storeChannels.get(record.identity.storeId) === record) storeChannels.delete(record.identity.storeId);
}

async function openStoreChannel(record) {
    if (record.stopped || storeChannels.get(record.identity.storeId) !== record) return;
    try {
        const settings = await bootstrapIngestToken(await getIngestSettings(), true);
        if (!await ensureIngestPermission(settings.endpoint)) throw Error('未授权访问仓库地址');
        if (!settings.token) throw Error('缺少连接令牌');
        await assertExecutionDocument(record.identity.tabId, record.identity.documentId);
        if (record.stopped || storeChannels.get(record.identity.storeId) !== record) return;
        const endpoint = new URL(hubApiUrl(settings.endpoint, '/api/relay/socket'));
        endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(endpoint.toString());
        record.socket = socket;
        record.connection = { phase: record.failures ? 'reconnecting' : 'connecting', detail: record.failures ? '正在重新连接' : '正在连接' };
        void publishStoreChannelState(record.identity.storeId);
        record.deadline = setTimeout(() => socket.close(), 15000);
        socket.onopen = async () => {
            try {
                if (record.stopped || storeChannels.get(record.identity.storeId) !== record) return socket.close();
                const { storeId, mallId, storeName, pageStoreName, relaySessionId } = record.identity;
                // 云端只接收连接身份；本地文档、执行代次和暂停状态不进入网络协议。
                socket.send(JSON.stringify({ type: 'authenticate', token: settings.token,
                    pluginInstanceId: await getPluginInstanceId(), identity: { storeId, mallId, storeName, pageStoreName, relaySessionId,
                        pageUrl: 'https://agentseller.temu.com/goods/list', pluginVersion: chrome.runtime.getManifest().version,
                        // 不靠版本号猜测能力，未发布的同版本开发包也必须显式声明独立实拍图协议。
                        relayProtocol: 1, livePhotoTransferVersion: 1, executionMode: 'plugin-api', identityMatched: true } }));
            } catch { socket.close(); }
        };
        socket.onmessage = event => {
            if (record.stopped || storeChannels.get(record.identity.storeId) !== record || record.socket !== socket) return;
            let message;
            try { message = JSON.parse(event.data); } catch { socket.close(); return; }
            if (message.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }
            record.incoming = record.incoming.then(async () => {
                if (record.stopped || record.socket !== socket) return;
                if (message.type === 'ready') {
                    if (message.agent?.storeId !== record.identity.storeId || message.agent?.relaySessionId !== record.identity.relaySessionId) throw Error('店铺连接身份不符');
                    clearTimeout(record.deadline); record.failures = 0; record.agent = message.agent;
                    record.connection = { phase: 'connected', detail: '已连接' };
                    await publishStoreChannelState(record.identity.storeId);
                } else if (message.type === 'products') {
                    if (record.connection.phase !== 'connected' || !Array.isArray(message.claimed) || !message.claimed.length) throw Error('投递内容不合法');
                    // 同文档切店也可能不触发浏览器导航事件；接收前再核对执行页，旧店数据不得入队。
                    const actual = await directPage(record.identity.tabId, 'identity', { documentId: record.identity.documentId });
                    if (String(actual.mallId) !== String(record.identity.mallId)) {
                        closeStoreChannel(record);
                        await invalidateExecutionTab(record.identity.tabId, '商城已变化，丢弃旧店投递');
                        await recoverStoreChannel(record.identity.storeId); return;
                    }
                    const state = (await chrome.storage.session.get(directPauseKey(record.identity.storeId)))[directPauseKey(record.identity.storeId)];
                    if (!state || state.relaySessionId !== record.identity.relaySessionId) return;
                    const identity = { ...record.identity, executionRunId: state.executionRunId };
                    await receiveTargetUploadTasks(message.claimed, identity.storeId, identity);
                    await publishStoreChannelState(identity.storeId);
                    if (!state.paused) void runDirectTasks(identity.tabId, identity).catch(error => TemuOperationLog.append({ action: 'direct-create', status: 'failed', error: directBackgroundErrorText(error), storeId: identity.storeId }));
                } else throw Error('未知连接消息');
            }).catch(async error => {
                record.connection = { phase: 'error', detail: String(error?.message || '接收失败') };
                await publishStoreChannelState(record.identity.storeId); socket.close();
            });
        };
        socket.onerror = () => { record.connection = { phase: 'error', detail: '仓库连接失败，正在重连' }; };
        socket.onclose = event => {
            clearTimeout(record.deadline);
            if (record.stopped || record.socket !== socket || storeChannels.get(record.identity.storeId) !== record) return;
            // 认证拒绝时清除过期插件令牌，下次只申请新连接，不补发任何商品。
            if (event.code === 4403 && String(settings.token).startsWith('pt_')) {
                void chrome.storage.local.set({ [INGEST_SETTINGS_KEY]: { ...settings, token: '', pluginTokenExpiresAt: 0 } });
            }
            scheduleStoreReconnect(record);
        };
    } catch (error) {
        record.connection = { phase: 'error', detail: String(error?.message || '连接失败') };
        scheduleStoreReconnect(record);
    }
}

/** 仅网络断开触发有界退避；不是商品查询定时器。 */
function scheduleStoreReconnect(record) {
    if (record.stopped || storeChannels.get(record.identity.storeId) !== record) return;
    record.failures = Math.min(record.failures + 1, 6);
    record.connection = { phase: 'reconnecting', detail: '连接已断开，正在重连' };
    void publishStoreChannelState(record.identity.storeId);
    clearTimeout(record.timer);
    record.timer = setTimeout(() => void openStoreChannel(record), Math.min(30000, 1000 * 2 ** (record.failures - 1)));
}

/** 普通观看页退出不清队列；执行页退出则结束旧批次，并从其他可信观看页建立空闲新会话。 */
async function leaveStoreChannel(sender) {
    const key = `executionViewer:${sender.tab?.id}`;
    const viewer = (await chrome.storage.session.get(key))[key];
    if (!viewer || viewer.documentId !== sender.documentId) return { left: true };
    await invalidateExecutionTab(sender.tab.id, '执行页面离开，结束当前批次');
    await recoverStoreChannel(viewer.storeId);
    return { left: true };
}

/** 浏览器事件立即关闭旧执行页连接；恢复只选仍在列表页的观看者，绝不迁移旧队列。 */
function detachStoreChannelTab(tabId) {
    for (const record of storeChannels.values()) {
        if (record.identity.tabId === tabId) closeStoreChannel(record);
    }
}

async function recoverStoreChannel(storeId) {
    const state = (await chrome.storage.session.get(directPauseKey(storeId)))[directPauseKey(storeId)];
    if (state) {
        try {
            // 后台唤醒或同文档切店不能只相信会话缓存；实时身份不符时先结束旧批次。
            await assertExecutionDocument(state.tabId, state.documentId);
            const tab = await chrome.tabs.get(state.tabId);
            if (!/^https:\/\/agentseller\.temu\.com\/goods\/list(?:[?#]|$)/.test(tab.url || '')) throw Error('执行页已离开');
            const actual = await directPage(state.tabId, 'identity', { documentId: state.documentId });
            if (String(actual.mallId) !== String(state.mallId)) throw Error('商城已变化');
            const latest = (await chrome.storage.session.get(directPauseKey(storeId)))[directPauseKey(storeId)];
            if (latest?.relaySessionId !== state.relaySessionId) return;
            ensureStoreChannel({ ...latest, identityMatched: true, executionMode: 'plugin-api', relayProtocol: 1 });
            await publishStoreChannelState(storeId); return;
        } catch {
            detachStoreChannelTab(state.tabId);
            await invalidateExecutionTab(state.tabId, '执行页面或商城变化，结束旧批次');
        }
    }
    const saved = await chrome.storage.session.get(null);
    for (const [key, viewer] of Object.entries(saved)) {
        if (!key.startsWith('executionViewer:') || viewer.storeId !== storeId) continue;
        try {
            const tab = await chrome.tabs.get(viewer.tabId);
            await subscribeStoreChannel({ tab, documentId: viewer.documentId }, viewer); return;
        } catch { await chrome.storage.session.remove(key); }
    }
    const record = storeChannels.get(storeId); if (record) closeStoreChannel(record);
    await publishStoreChannelState(storeId);
}

/** 本地存储变更主动广播；正常进度不会向服务器发送，也不需要页面定时读取。 */
chrome.storage.onChanged?.addListener((changes, area) => {
    if (area !== 'session') return;
    const stores = new Set();
    for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith('directPause:')) stores.add(key.slice('directPause:'.length));
        if (key === TARGET_UPLOAD_TASKS_KEY) for (const task of [...(change.oldValue || []), ...(change.newValue || [])]) stores.add(task.targetStoreId);
    }
    for (const storeId of stores) {
        void publishStoreChannelState(storeId);
        // 人工结束换接收会话后必须换通道；其他存储变化只更新状态，不做网络查询。
        const key = directPauseKey(storeId);
        if (changes[key]) void recoverStoreChannel(storeId).catch(() => {});
    }
});

/** MV3 后台重新唤醒只恢复仍有效文档的网络通道，不启动旧平台任务或读取历史任务清单。 */
setTimeout(() => void (async () => {
    const saved = await chrome.storage.session.get(null);
    for (const [key, state] of Object.entries(saved)) {
        if (!key.startsWith('directPause:') || state?.enabledVersion !== chrome.runtime.getManifest().version) continue;
        try {
            await assertExecutionDocument(state.tabId, state.documentId);
            const tab = await chrome.tabs.get(state.tabId);
            if (!/^https:\/\/agentseller\.temu\.com\/goods\/list(?:[?#]|$)/.test(tab.url || '')) throw Error('执行页已离开');
            await recoverStoreChannel(state.storeId);
        } catch { await invalidateExecutionTab(state.tabId, '原执行文档已失效，丢弃旧批次'); await recoverStoreChannel(state.storeId); }
    }
})().catch(() => {}), 0);
