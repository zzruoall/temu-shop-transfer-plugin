/** 附件回执按目标商城、商品、用途和内容哈希隔离；不同入口不能共用签名或复用文件地址。 */
async function uploadTargetAttachment(task, identity, tabId, productId, file, route, readAsset, stopped) {
    const sha256 = file.asset?.sha256;
    if (!/^[a-f0-9]{64}$/.test(sha256 || '') || !['certificate', 'live-photo'].includes(route)
        || !/^\d{6,20}$/.test(productId || '') || !identity.mallId) throw Error('附件上传归属无效');
    const key = `targetAttachment:${identity.mallId}:${productId}:${route}:${sha256}`;
    const jobKey = JSON.stringify([task.jobId || '', task.sourceTaskId || '', Number(task.directRetrySequence) || 0]);
    const mayRenew = receipt => receipt?.state === 'uploaded' && Date.now() - receipt.savedAt > 30 * 60 * 1000 && receipt.jobKey !== jobKey;
    const stored = await chrome.storage.local.get(key);
    const previous = stored[key];
    if (previous) {
        if (previous.state !== 'uploaded') throw Error('同一目标附件已有未确认上传，未重复发送，请在目标店核对');
        if (!mayRenew(previous)) {
            if (Date.now() - previous.savedAt > 30 * 60 * 1000) throw Error('已上传附件回执已过有效复用期，请核对后从网站重新投递，不在旧任务内自动重传');
            if (!TemuQualificationReader.assetUrl(previous.url)) throw Error('目标附件回执地址无效');
            return previous.url;
        }
    }
    const asset = await readAsset();
    if (await stopped()) return null;
    const attemptId = `${route === 'live-photo' ? 'photo:' : ''}${crypto.randomUUID()}`;
    // 先落盘再发送，后台关闭或页面刷新也不能把已开始上传解释为没上传；容量不足则尚未发请求。
    await withTargetTaskMutation(async () => {
        if (await stopped()) throw Error('执行已暂停');
        await assertExecutionDocument(tabId, identity.documentId);
        // 只读取回执索引，不随每张图扫描全部本地采集数据，避免大资料包拖慢签名前预检。
        const current = await chrome.storage.local.get([key, 'targetAttachmentIndex']);
        const index = (current.targetAttachmentIndex || []).filter(entry => entry !== key);
        // 只有新人工批次可刷新已经确定上传成功但过期的地址；未知结果无论多久都不能按过期重发。
        if (current[key] && !mayRenew(current[key])) throw Error('目标附件已有上传尝试，未并发重传');
        if (!Array.isArray(index) || index.length >= 1000) throw Error('附件回执达到安全上限，请先核对旧的未确认上传');
        await chrome.storage.local.set({ [key]: { state: 'submitting', attemptId, savedAt: Date.now(), jobKey }, targetAttachmentIndex: [...index, key] });
    });
    let result;
    try {
        result = await qualificationWrite(tabId, route === 'live-photo' ? 'photo-upload' : 'upload', identity,
            { productId, attemptId, asset }, stopped);
    } catch (error) { result = { state: 'unknown', reason: directErrorText(error) }; }
    const safeUrl = result.state === 'uploaded' && TemuQualificationReader.assetUrl(result.url);
    await withTargetTaskMutation(async () => {
        const current = (await chrome.storage.local.get(key))[key];
        if (current?.attemptId !== attemptId) throw Error('附件回执归属变化，未接受迟到结果');
        // 停止发生在请求发出前，允许清除预留；其它不明确结果均保留，不靠超时重发。
        if (result.state === 'stopped' || result.state === 'rejected') {
            const index = (await chrome.storage.local.get('targetAttachmentIndex')).targetAttachmentIndex || [];
            await chrome.storage.local.set({ targetAttachmentIndex: index.filter(entry => entry !== key) });
            await chrome.storage.local.remove(key);
        }
        else await chrome.storage.local.set({ [key]: { attemptId, savedAt: Date.now(), jobKey, state: safeUrl ? 'uploaded' : 'unknown', ...(safeUrl ? { url: safeUrl } : {}) } });
    });
    if (result.state === 'stopped') return null;
    if (!safeUrl) throw Error(result.reason || '目标附件上传未确认，未重发');
    return safeUrl;
}

/** 提交回执独立于网站批次；平台列表延迟更新时，重新投递也不能重复发同一证书或实拍图正文。 */
function targetSubmissionKey(identity, productId, route) {
    if (!/^\d{6,20}$/.test(productId || '') || !/^certificate:\d+$|^live-photos$/.test(route)) throw Error('材料提交回执归属无效');
    return `targetSubmission:${identity.mallId}:${productId}:${route}`;
}
async function readTargetSubmission(key) { return (await chrome.storage.local.get(key))[key]; }
/** 先保留提交槽再请求平台；未知事实不可被新网站批次覆盖，明确的发出前拒绝才可释放。 */
async function reserveTargetSubmission(key, attemptId, metadata, stopped) {
    await withTargetTaskMutation(async () => {
        if (await stopped()) throw Error('执行已暂停');
        const stored = await chrome.storage.local.get([key, 'targetSubmissionIndex']);
        if (stored[key]) throw Error('目标材料已有未结算提交，未重复发送');
        const index = stored.targetSubmissionIndex || [];
        if (!Array.isArray(index) || index.length >= 1000) throw Error('材料提交回执达到安全上限');
        await chrome.storage.local.set({ [key]: { state: 'submitting', attemptId, savedAt: Date.now(), ...metadata }, targetSubmissionIndex: [...index, key] });
    });
}
async function settleTargetSubmission(key, attemptId, result) {
    await withTargetTaskMutation(async () => {
        const current = await readTargetSubmission(key);
        if (current?.attemptId !== attemptId) throw Error('目标材料提交回执已变化');
        if (['stopped', 'rejected', 'existing'].includes(result.state)) {
            const index = (await chrome.storage.local.get('targetSubmissionIndex')).targetSubmissionIndex || [];
            await chrome.storage.local.set({ targetSubmissionIndex: index.filter(entry => entry !== key) });
            await chrome.storage.local.remove(key);
        } else await chrome.storage.local.set({ [key]: { ...current, state: result.state === 'submitted' ? 'submitted' : 'unknown' } });
    });
}
