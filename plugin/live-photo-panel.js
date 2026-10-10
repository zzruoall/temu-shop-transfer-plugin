/** 每个商品列表执行轮次共用一个插件创建的实拍图页；不接管用户已有标签页，也不跨店共享。 */
const livePhotoPanels = new Map();
async function livePhotoPanel(identity, ownerTabId) {
    const key = `${ownerTabId}:${identity.executionRunId}`;
    if (livePhotoPanels.has(key)) return livePhotoPanels.get(key);
    const promise = (async () => {
        if (await readDirectPause(identity.storeId, identity)) throw Error('执行已暂停');
        const tab = await chrome.tabs.create({ url: 'https://agentseller.temu.com/govern/compliant-live-photos', active: false });
        try {
            // 等待浏览器加载事件和页面模块变化，不以固定睡眠或网络轮询驱动页面准备。
            await new Promise((resolve, reject) => {
                const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
                const listener = (tabId, change) => { if (tabId === tab.id && change.status === 'complete') { cleanup(); resolve(); } };
                const timer = setTimeout(() => { cleanup(); reject(Error('实拍图页面加载超时')); }, 30000);
                chrome.tabs.onUpdated.addListener(listener);
                chrome.tabs.get(tab.id).then(current => { if (current.status === 'complete') { cleanup(); resolve(); } }, error => { cleanup(); reject(error); });
            });
            const token = crypto.randomUUID();
            const [entry] = await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN',
                func: (token, mallId) => new Promise((resolve, reject) => {
                    let observer, timer;
                    const check = () => {
                        if (location.origin + location.pathname !== 'https://agentseller.temu.com/govern/compliant-live-photos') return;
                        let runtime;
                        window.webpackChunkbgb_sc_govern?.push([[crypto.randomUUID()], {}, value => { runtime = value; }]);
                        if (!Object.values(runtime?.m || {}).some(factory => String(factory).includes('PUBLIC_C_US') && String(factory).includes('setSignature=function'))) return;
                        observer?.disconnect(); clearTimeout(timer);
                        window.__temuLivePhotoUploadBinding = { token, mallId, stopped: false };
                        resolve(true);
                    };
                    observer = new MutationObserver(check); observer.observe(document.documentElement, { childList: true, subtree: true });
                    timer = setTimeout(() => { observer.disconnect(); reject(Error('实拍图官方模块尚未加载')); }, 15000);
                    check();
                }), args: [token, identity.mallId] }));
            if (!entry?.result || !entry.documentId) throw Error('实拍图页面文档未确认');
            if (await readDirectPause(identity.storeId, identity)) throw Error('执行已暂停');
            await chrome.scripting.executeScript({ target: { tabId: tab.id, documentIds: [entry.documentId] }, world: 'MAIN', files: ['live-photo-upload-page.js'] });
            return { tabId: tab.id, documentId: entry.documentId, token, identity };
        } catch (error) { await chrome.tabs.remove(tab.id).catch(() => {}); throw error; }
    })();
    livePhotoPanels.set(key, promise);
    try { return await promise; } catch (error) { livePhotoPanels.delete(key); throw error; }
}

/** 原页每次仍要核对有效轮次；独立页只接触图片和目标商城，不携带云仓凭据或接收任务权限。 */
async function livePhotoUploadCall(identity, ownerTabId, operation, payload) {
    if (operation !== 'status' && await readDirectPause(identity.storeId, identity)) return { state: 'stopped' };
    const panel = await livePhotoPanel(identity, ownerTabId);
    await assertExecutionDocument(panel.tabId, panel.documentId);
    const [entry] = await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId: panel.tabId, documentIds: [panel.documentId] }, world: 'MAIN',
        func: async (operation, serialized) => {
            try { return await window.__temuLivePhotoUploadPage.run(operation, JSON.parse(serialized)); }
            catch (error) { return { __temuDirectPageError: { message: String(error?.errorMsg || error?.message || error) } }; }
        }, args: [operation, JSON.stringify({ ...payload, photoToken: panel.token, mallId: identity.mallId })] }));
    const error = directPageError(entry);
    if (error) throw Error(error);
    return entry.result;
}

/** 只关闭插件自己创建的页面；暂停/换批事件先撤销其写入能力，再由当前阶段退出时清理。 */
async function closeLivePhotoPanel(identity, ownerTabId) {
    const key = `${ownerTabId}:${identity.executionRunId}`, pending = livePhotoPanels.get(key);
    if (!pending) return;
    livePhotoPanels.delete(key);
    const panel = await pending.catch(() => null);
    if (panel) await chrome.tabs.remove(panel.tabId).catch(() => {});
}
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session') return;
    for (const pending of livePhotoPanels.values()) void pending.then(panel => {
        const change = changes[directPauseKey(panel.identity.storeId)];
        if (!change || change.newValue && !change.newValue.paused && change.newValue.executionRunId === panel.identity.executionRunId) return;
        return chrome.scripting.executeScript({ target: { tabId: panel.tabId, documentIds: [panel.documentId] }, world: 'MAIN',
            func: () => { if (window.__temuLivePhotoUploadBinding) window.__temuLivePhotoUploadBinding.stopped = true; } });
    }).catch(() => {});
});
