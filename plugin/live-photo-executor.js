/** 旧包的真实图片只能证明资料存在，缺少视角或 SKU 时不得按数组顺序补造上传槽。 */
function legacyLivePhotoCount(snapshot) {
    const evidence = snapshot?.livePhotoCompatibility;
    if (evidence?.state === 'legacy-unclassified' && Number.isSafeInteger(evidence.imageCount)
        && evidence.imageCount > 0 && evidence.imageCount <= 200) return evidence.imageCount;
    const hashes = new Set(), array = value => Array.isArray(value) ? value : [];
    const qualifications = snapshot?.qualifications;
    if (qualifications?.schemaVersion !== 1 || qualifications.spuId !== snapshot.spuId) return 0;
    let inspected = 0;
    // 网站尚未升级时也识别旧证书记录，避免将已归档图片误报为来源未提供；仍不自动上传未知位置。
    for (const item of array(qualifications.items)) {
        const pictures = array(item?.content?.realPictures), files = array(item?.files);
        inspected += pictures.length + files.length;
        if (inspected > 40000) return 0;
        if (item?.status !== 'complete') continue;
        for (const photo of pictures) {
            const url = TemuQualificationReader.publicAssetUrl(photo?.imageUrl);
            if (!url) continue;
            const file = files.find(file => file?.role === '资质实拍图' && file.archiveStatus === 'archived'
                && TemuQualificationReader.publicAssetUrl(file.url) === url && file.asset?.url === file.url);
            if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file?.asset?.mimeType)
                && /^[a-f0-9]{64}$/.test(file.asset.sha256 || '') && Number.isSafeInteger(file.asset.bytes)
                && file.asset.bytes > 0 && file.asset.bytes <= 10 * 1024 * 1024) hashes.add(file.asset.sha256);
            if (hashes.size > 40) return 0;
        }
    }
    return hashes.size;
}

/** 仅显式提供独立实拍图快照的资质任务进入上传阶段；旧图缺少分类时明确要求重新采集。 */
async function runDirectLivePhotos(task, identity, tabId, record, key) {
    const source = task.snapshot?.livePhotos;
    if (!source) {
        const count = legacyLivePhotoCount({ ...task.snapshot, spuId: task.spuId });
        if (count) {
            const reason = `来源已归档 ${count} 张历史实拍图，但缺少独立上传所需的视角和SKU归属；请在来源店升级插件并刷新页面，重新采集后从网站投递，不需要删除商品`;
            return { state: 'partial', items: [{ key: 'legacy-unclassified', name: '历史实拍图', state: 'failed', reason }], reason };
        }
        return { state: 'not-delivered', items: [], reason: '本次任务未附独立实拍图资料，仅处理资质文件；未宣称图片补全' };
    }
    const stopped = async () => directStopRequested.has(identity.storeId) || Boolean(await readDirectPause(identity.storeId, identity));
    const save = async () => {
        await writeDirectAttempt(task, key, record);
        await rememberDirectProgress(task, { directState: 'qualifying', productId: record.productId,
            productState: 'complete', livePhotoItems: record.livePhotoItems, errorStage: '商品实拍图',
            reason: '正在按采集位置、视角及SKU货号补传商品实拍图', status: 'received' }, tabId);
    };
    try {
        TemuLivePhotoReader.validateReferenceSnapshot(source, task.spuId);
        if (task.sourceStoreId !== `temu:${source.mallId}`) throw Error('来源实拍图店铺与任务不一致');
        if (source.status !== 'complete' || source.archive.status !== 'complete') throw Error('来源实拍图尚未完整采集归档');
        // 已经发出的正文不重放；新投递可重新读取平台实际槽位，但旧任务未知状态不自动猜成功。
        if (['submitting', 'unknown', 'submitted'].includes(record.livePhotoState)) return {
            state: record.livePhotoState === 'submitted' ? 'complete' : 'unknown', items: record.livePhotoItems || [],
            reason: record.livePhotoState === 'submitted' ? '本次商品实拍图请求已被平台接收，未重复发送' : '本次商品实拍图提交结果未确认，请在目标店核对，未重发' };
        if (await stopped()) return { state: 'stopped' };
        if (!source.groups.some(group => group.images.length)) return { state: 'complete', items: [], reason: '来源未填写商品实拍图，无需补传' };
        await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId, documentIds: [identity.documentId] }, world: 'MAIN', files: ['live-photo-transfer.js', 'qualification-page.js'] }));
        const target = await qualificationPage(tabId, 'photo-read', identity, { productId: record.productId });
        const plan = TemuLivePhotoTransfer.plan(source, target);
        const receiptKey = targetSubmissionKey(identity, record.productId, 'live-photos');
        const slotKey = row => `${row.position}:${row.positionType}:${[...row.owners].sort().join(',')}`;
        const receipt = await readTargetSubmission(receiptKey);
        // 独立实拍图接口提交整份位置正文；旧写入尚未显示时不能提交其它槽，否则会把旧槽当空白覆盖。
        const confirmed = slot => {
            const [position, type, owners] = String(slot).split(':');
            const group = target.detail.positionDetail.find(row => row.position === Number(position));
            return owners && group && owners.split(',').every(owner => {
                const row = group.skuPhotoInfoList.find(row => group.isSameSku || String(row.skuId) === owner);
                return row?.imageList.some(image => image.positionType === Number(type));
            });
        };
        if (receipt && (!Array.isArray(receipt.slots) || !receipt.slots.length || !receipt.slots.every(confirmed))) {
            return { state: 'unknown', items: [], reason: '此前实拍图已发出但目标槽位尚未确认更新，未重复上传或用空槽覆盖，请在目标店核对' };
        }
        if (receipt) await settleTargetSubmission(receiptKey, receipt.attemptId, { state: 'existing' });
        record.livePhotoItems = plan.items; await save();
        const uploaded = new Map();
        for (const addition of plan.additions) {
            const item = plan.items.find(item => item.key === addition.key);
            if (item.state !== 'pending' || uploaded.has(addition.asset.sha256)) continue;
            if (await stopped()) return { state: 'stopped' };
            try {
                const asset = addition.asset;
                // 图片按专用归档引用读取；不代理来源链接，字节不进入任务队列或持久化回执。
                const url = await uploadTargetAttachment(task, identity, tabId, record.productId, { asset }, 'live-photo',
                    async () => {
                        if (asset.dataBase64) {
                            TemuLivePhotoReader.validateSnapshot(source, task.spuId);
                            return { ...asset };
                        }
                        return qualificationAsset(task, { asset }, identity, tabId, 'live-photo');
                    }, stopped);
                if (!url) return { state: 'stopped' };
                uploaded.set(asset.sha256, url);
            } catch (error) {
                item.state = 'failed'; item.reason = directErrorText(error);
                if (/商城身份变化|登录|未登录|验证码|离开商品列表/.test(item.reason)) directStopRequested.add(identity.storeId);
            }
            await save();
        }
        // 一个槽任一图片失败就不提交该槽的残缺内容，其它合格槽可以继续，已上传文件保留回执供恢复复用。
        plan.additions = plan.additions.filter(row => plan.items.find(item => item.key === row.key).state === 'pending');
        if (await stopped()) return { state: 'stopped' };
        if (plan.additions.length) {
            const hashes = new Set(plan.additions.map(row => row.asset.sha256));
            const receipts = [...uploaded].filter(([hash]) => hashes.has(hash));
            record.livePhotoAttemptId = crypto.randomUUID();
            await reserveTargetSubmission(receiptKey, record.livePhotoAttemptId, { slots: [...new Set(plan.additions.map(slotKey))] }, stopped);
            record.livePhotoState = 'submitting'; await save();
            const result = await qualificationWrite(tabId, 'photo-submit', identity,
                { productId: record.productId, attemptId: record.livePhotoAttemptId, source, expectedTarget: plan.guard, uploaded: receipts,
                    allowedKeys: plan.additions.map(row => row.key) }, stopped);
            await settleTargetSubmission(receiptKey, record.livePhotoAttemptId, result);
            if (result.state === 'stopped') { record.livePhotoState = 'pending'; await save(); return { state: 'stopped' }; }
            record.livePhotoState = result.state === 'submitted' ? 'submitted' : ['rejected', 'existing'].includes(result.state) ? 'settled' : 'unknown';
            for (const item of plan.items.filter(item => item.state === 'pending')) {
                item.state = result.state === 'submitted' ? 'submitted' : result.state === 'existing' ? 'existing' : result.state === 'rejected' ? 'failed' : 'unknown';
                item.reason = result.reason || '实拍图结果待核对';
            }
            await save();
        }
        const errors = plan.items.filter(item => ['failed', 'unknown'].includes(item.state));
        const state = plan.items.some(item => item.state === 'unknown') ? 'unknown' : errors.length ? 'partial' : 'complete';
        await TemuOperationLog.append({ action: 'live-photo-transfer', status: state, spuId: task.spuId, productId: record.productId,
            jobId: task.jobId, items: plan.items.map(item => ({ key: item.key, state: item.state, reason: item.reason })) });
        return { state, items: plan.items, reason: errors.length ? errors.map(item => `${item.name}：${item.reason}`).join('；').slice(0, 2000)
            : '来源商品实拍图已补传或目标对应槽位已有图片，不代表平台审核通过' };
    } catch (error) {
        if (record.livePhotoState === 'submitting') record.livePhotoState = 'unknown';
        const reason = directErrorText(error);
        if (/商城身份变化|登录|未登录|验证码|离开商品列表/.test(reason)) directStopRequested.add(identity.storeId);
        if (await stopped()) return { state: 'stopped', reason };
        return { state: record.livePhotoState === 'unknown' ? 'unknown' : 'partial', items: record.livePhotoItems || [], reason };
    } finally { await closeLivePhotoPanel(identity, tabId); }
}
