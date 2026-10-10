/** 商品与资质共用本店串行队列；附件只在当前步骤内存中存在，不写入会话任务或恢复队列。 */
async function qualificationPage(tabId, operation, identity, payload = {}) {
    await assertExecutionDocument(tabId, identity.documentId);
    // 只有实拍图附件才进入独立页面；商品资质正文和证书附件继续使用原商品页客户端。
    if (operation === 'photo-upload' || operation === 'status' && String(payload.attemptId || '').startsWith('photo:')) {
        return livePhotoUploadCall(identity, tabId, operation, payload);
    }
    const [entry] = await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId, documentIds: [identity.documentId] }, world: 'MAIN',
        // Chrome 的对象参数转换会删除 null 字段；使用 JSON 文本跨边界，避免稳定模板和提交正文失真。
        func: async (operation, serialized) => {
            try { return await window.__temuQualificationPage.run(operation, JSON.parse(serialized)); }
            catch (error) { return { __temuDirectPageError: { message: String(error?.errorMsg || error?.message || error), stopBatch: Boolean(error?.stopBatch) } }; }
        }, args: [operation, JSON.stringify({ ...payload, mallId: identity.mallId, executionRunId: identity.executionRunId })] }));
    const error = directPageError(entry);
    if (error) throw Error(error);
    return entry.result;
}

/** 私有附件读取复用现有令牌；只按商品及内容哈希取归档字节，禁止代理来源临时链接。 */
async function qualificationAsset(task, file, identity, tabId, route = 'qualification') {
    if (await readDirectPause(identity.storeId, identity)) throw Error('执行已暂停');
    const ref = file.asset;
    if (!ref?.sha256 || !Number.isSafeInteger(ref.bytes) || ref.bytes <= 0 || ref.bytes > 10 * 1024 * 1024) throw Error('资质附件未归档，请重新采集');
    const settings = await getIngestSettings();
    if (!settings.token || !await ensureIngestPermission(settings.endpoint)) throw Error('仓库附件读取未授权');
    if (!['qualification', 'live-photo'].includes(route)) throw Error('归档附件路由无效');
    const url = new URL(hubApiUrl(settings.endpoint, `/api/${route}-assets/${task.spuId}/${ref.sha256}`));
    url.searchParams.set('sourceStoreId', task.sourceStoreId);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
        const response = await authenticatedIngestFetch(url.href, settings, { signal: controller.signal,
            headers: { 'x-plugin-instance': await getPluginInstanceId() } });
        if (!response.ok) throw Error(`资质归档读取失败（HTTP ${response.status}），请核对权限或重新采集`);
        if (Number(response.headers.get('content-length')) !== ref.bytes || !response.body
            || response.headers.get('content-type')?.split(';')[0].trim() !== ref.mimeType) throw Error('归档附件长度或MIME声明与快照不一致');
        const reader = response.body.getReader(), chunks = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > ref.bytes) throw Error('资质附件流超过快照大小');
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); }
        if (size !== ref.bytes) throw Error('资质附件不完整');
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (hash !== ref.sha256) throw Error('资质附件哈希不一致，未上传');
        await assertExecutionDocument(tabId, identity.documentId);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
        return { ...ref, name: ref.name || file.name || 'qualification.pdf', dataBase64: btoa(binary) };
    } finally { clearTimeout(timer); }
}

/** 等待的是本页一次写请求的内存结果，不轮询网络、不重发；超时只留下未知事实。 */
async function qualificationWrite(tabId, operation, identity, payload, stopped) {
    if (await stopped()) return { state: 'stopped' };
    const started = await qualificationPage(tabId, operation, identity, payload);
    // 页面预检拒绝发生在平台提交前，直接结算未提交；不能转成结果未知或反复查询该尝试。
    if (['existing', 'rejected'].includes(started?.state)) return started;
    if (started?.state !== 'submitting') throw Error('资质写入未确认启动');
    // 实拍图官方 SDK 超时上限为 60 秒，文件为 30 秒；这里只等待内存结果，不增加网络重试。
    for (let i = 0; i < (operation === 'photo-upload' ? 125 : 65); i++) {
        try {
            const result = await qualificationPage(tabId, 'status', identity, { attemptId: payload.attemptId });
            if (result.state !== 'submitting') return result;
        } catch (error) { return { state: 'unknown', reason: directErrorText(error) }; }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { state: 'unknown', reason: '资质提交结果未确认，请在目标店核对后再人工投递' };
}

/** 已存在商品只进入资质阶段；每一条已发出请求先留本地事实，暂停继续不得重放。 */
async function runDirectQualifications(task, identity, tabId, record, key) {
    const stopped = async () => directStopRequested.has(identity.storeId) || Boolean(await readDirectPause(identity.storeId, identity));
    const source = task.snapshot?.qualifications;
    // 资质为可选采集部分；旧插件未返回时只跳过证书流程，不妨碍独立实拍图处理。
    if (!source) return { state: 'not-delivered', items: [], reason: '本次任务未附资质文件资料，已跳过证书补传；不代表证书齐全' };
    const items = record.qualificationItems || [];
    const save = async () => {
        record.stage = 'qualifying'; record.qualificationItems = items;
        await writeDirectAttempt(task, key, record);
        await rememberDirectProgress(task, { directState: 'qualifying', productId: record.productId,
            productState: 'complete', qualificationItems: items, errorStage: '资质', reason: `商品 ${record.productId} 已确认，正在处理资质`, status: 'received' }, tabId);
    };
    try {
        if (await stopped()) return { state: 'stopped', reason: '已暂停，尚未完成资质' };
        if (!/^\d{6,20}$/.test(record.productId || '') || record.mallId !== identity.mallId) throw Error('目标资质商品或商城归属无效');
        await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId, documentIds: [identity.documentId] }, world: 'MAIN', files: ['qualification-page.js'] }));
        await save();
        if (!source || source.status !== 'complete' || source.lastAttempt) throw Error('来源资质尚未完整采集或最新采集失败，请重新采集后投递');
        const requested = source.items.filter(TemuQualificationTransfer.sourceHasContent).map(item => item.certType);
        if (new Set(source.items.map(item => item.certType)).size !== source.items.length) throw Error('来源资质类型重复，未猜测需要提交的版本');
        const target = requested.length ? await qualificationPage(tabId, 'read', identity, { productId: record.productId, certTypes: requested })
            : { status: 'complete', items: source.items.map(item => ({ certType: item.certType })) };
        if (target.status !== 'complete' && !(target.status === 'partial' && target.selectionComplete)) throw Error(`目标资质未完整读取：${target.reason || '身份或模板未确认'}`);
        if (requested.length && !target.items.length) throw Error('目标资质列表尚未生成或商品不可读，请核对后再次人工投递');
        const sources = new Map(source.items.map(item => [item.certType, item]));
        const uploaded = new Map();
        // 来源填写但目标没有该类型必须留下明确异常，不能因只遍历目标清单而宣称全部成功。
        for (const certType of requested.filter(type => !target.items.some(entry => entry.certType === type))) {
            const previous = items.find(item => item.certType === certType);
            if (!previous) items.push({ certType, name: sources.get(certType)?.name || String(certType), state: 'failed', reason: '目标没有匹配的资质类型，未提交' });
        }
        for (const entry of target.items) {
            if (await stopped()) return { state: 'stopped', reason: '已暂停，剩余资质未提交', items };
            const previous = items.find(item => item.certType === entry.certType);
            if (previous && ['submitted', 'unknown', 'submitting'].includes(previous.state)) continue;
            const item = previous || { certType: entry.certType, name: String(entry.summary?.showName || entry.summary?.certName || entry.certType), state: 'pending', reason: '' };
            if (!previous) items.push(item);
            try {
                const incoming = sources.get(entry.certType);
                // 补传只处理来源实际填写的项目；其余正常跳过，不能因目标要求尚未填满而报错。
                if (!TemuQualificationTransfer.sourceHasContent(incoming)) {
                    item.state = 'skipped'; item.reason = incoming ? '来源未填写此项资质，无需补传' : '来源未提供此项资质，无需补传';
                    await save(); continue;
                }
                // 目标清单已确认审核中或通过时无需读取模板，名称、来源材料或详情失败都不能触发重传。
                const decision = TemuQualificationTransfer.decision(entry.summary);
                if (decision === 'existing') { item.state = 'existing'; item.reason = '目标已有已提交资质，未覆盖'; await save(); continue; }
                if (decision !== 'missing') throw Error(decision === 'rejected' ? '目标资质已被驳回或要求替换，需要人工核对，未覆盖' : '目标资质状态未知，未提交');
                if (entry.status === 'failed' || !entry.detail) throw Error(`此项目标资质详情未完整读取：${entry.reason || '模板未确认'}`);
                const receiptKey = targetSubmissionKey(identity, record.productId, `certificate:${entry.certType}`);
                const receipt = await readTargetSubmission(receiptKey);
                if (receipt) {
                    item.state = receipt.state === 'submitted' ? 'existing' : 'unknown';
                    item.reason = receipt.state === 'submitted' ? '此前已被平台接收，正在等待目标状态更新，未重复提交' : '此前提交结果未确认，未因重新投递而重发';
                    await save(); continue;
                }
                // 在上传附件前完成模板和材料校验，避免为不兼容模板留下无用目标文件。
                const placeholder = new Map((incoming.files || []).filter(file => file.asset).map(file => [file.asset.sha256, 'https://img.kwcdn.com/validated-placeholder.pdf']));
                TemuQualificationTransfer.requestFor(incoming, entry.detail, record.productId, placeholder);
                for (const file of TemuQualificationTransfer.requiredFiles(incoming)) {
                    if (!file.asset) throw Error('来源资质仅有临时链接，附件未归档，请重新采集');
                    if (uploaded.has(file.asset.sha256)) continue;
                    if (await stopped()) return { state: 'stopped', reason: '已暂停，未继续上传附件', items };
                    const url = await uploadTargetAttachment(task, identity, tabId, record.productId, file, 'certificate',
                        () => qualificationAsset(task, file, identity, tabId), stopped);
                    if (!url) return { state: 'stopped', reason: '已暂停，未上传附件', items };
                    uploaded.set(file.asset.sha256, url);
                }
                if (await stopped()) return { state: 'stopped', reason: '已暂停，附件已上传但资质尚未提交', items };
                // 发出前的二次核对只在页面适配器进行，避免后台再完整读取一次所有证书。
                const current = entry;
                const request = TemuQualificationTransfer.requestFor(incoming, current.detail, record.productId, uploaded);
                item.attemptId = crypto.randomUUID();
                await reserveTargetSubmission(receiptKey, item.attemptId, {}, stopped);
                item.state = 'submitting'; await save();
                const result = await qualificationWrite(tabId, 'submit', identity, { productId: record.productId, attemptId: item.attemptId, request, expectedTargetDetail: current.detail }, stopped);
                await settleTargetSubmission(receiptKey, item.attemptId, result);
                if (result.state === 'stopped') { item.state = 'pending'; await save(); return { state: 'stopped', reason: '已暂停，未提交资质', items }; }
                item.state = result.state === 'existing' ? 'existing' : result.state === 'submitted' ? 'submitted' : result.state === 'rejected' ? 'failed' : 'unknown';
                item.reason = result.reason || (item.state === 'submitted' ? '平台已接收资质，不代表审核通过' : '资质提交结果待核对，未重发');
            } catch (error) {
                item.state = item.state === 'submitting' ? 'unknown' : 'failed'; item.reason = directErrorText(error);
                if (/商城身份变化|离开商品列表|登录|未登录|验证码/.test(item.reason)) directStopRequested.add(identity.storeId);
            }
            await save();
            await TemuOperationLog.append({ action: 'qualification-transfer', storeId: identity.storeId, jobId: task.jobId, spuId: task.spuId,
                productId: record.productId, certType: item.certType, status: item.state, reason: item.reason });
        }
        const unknown = items.some(item => ['unknown', 'submitting'].includes(item.state));
        const failures = items.filter(item => item.state === 'failed');
        return { state: unknown ? 'unknown' : failures.length ? 'partial' : 'complete', items,
            reason: failures.length || unknown ? items.filter(item => ['failed', 'unknown', 'submitting'].includes(item.state)).map(item => `${item.name}：${item.reason}`).join('；').slice(0, 2000)
                : items.some(item => ['submitted', 'existing'].includes(item.state))
                    ? `商品 ${record.productId} 的来源已填写资质已补传或目标已提交，未填写项已跳过，不代表平台审核通过`
                    : `商品 ${record.productId} 的来源没有需要补传的资质，未填写项已跳过` };
    } catch (error) {
        // 登录失效或离开原商城是整店上下文失效，不能当成单件材料错误继续队列。
        if (/商城身份变化|离开商品列表|登录|未登录|验证码|请打开商品列表页/.test(directErrorText(error))) directStopRequested.add(identity.storeId);
        if (await stopped()) return { state: 'stopped', reason: directErrorText(error), items };
        return { state: 'partial', reason: `商品 ${record.productId} 已确认，资质未完成：${directErrorText(error)}`, items };
    }
}

/** 独立资质任务只结算资质结果，不能把已存在的目标商品计为本次创建成功。 */
async function finishDirectQualifications(task, identity, tabId, record, key) {
    const documents = await runDirectQualifications(task, identity, tabId, record, key);
    if (documents.state === 'stopped') return false;
    const photos = await runDirectLivePhotos(task, identity, tabId, record, key);
    if (photos.state === 'stopped') return false;
    // 文件和实拍图分别结算，部分成功不能被另一入口的失败抹去；缺少传输协议时不宣称图片已完成。
    const state = [documents.state, photos.state].includes('unknown') ? 'unknown'
        : [documents.state, photos.state].includes('partial') ? 'partial' : 'complete';
    const result = { state, items: documents.items, reason: `${documents.reason}；${photos.reason}`.slice(0, 2000) };
    if (result.state === 'stopped') return false;
    record.done = true;
    record.stage = result.state === 'complete' ? 'qualification_complete' : result.state === 'unknown' ? 'qualification_unknown' : 'qualification_failed';
    record.businessError = result.reason; delete record.request;
    await writeDirectAttempt(task, key, record);
    await rememberDirectProgress(task, { directState: record.stage, productId: record.productId, productState: 'complete',
        qualificationItems: result.items, livePhotoItems: photos.items || [], reason: result.reason, errorStage: result.state === 'complete' ? '' : '资质', errorCode: '', status: 'received' }, tabId);
    await TemuOperationLog.append({ action: 'qualification-transfer', status: result.state === 'complete' ? 'succeeded' : 'failed',
        phase: record.stage, jobId: task.jobId, spuId: task.spuId, productId: record.productId, reason: result.reason });
    return true;
}

/** 商品任务只确认内容创建，资质材料不可影响商品成功结算，也不得被自动提交。 */
async function finishDirectProduct(task, tabId, record, key) {
    record.done = true; record.stage = 'created'; delete record.request;
    record.businessError = `商品 ${record.productId} 内容已创建，资质未在本次任务中上传，不代表平台审核上架`;
    await writeDirectAttempt(task, key, record);
    await rememberDirectProgress(task, { directState: 'created', productId: record.productId, productState: 'complete',
        reason: record.businessError, errorStage: '', errorCode: '', status: 'received' }, tabId);
    await TemuOperationLog.append({ action: 'direct-create', status: 'succeeded', phase: 'created',
        jobId: task.jobId, spuId: task.spuId, productId: record.productId, reason: record.businessError });
}

/** 仅网站显式投递的资质任务可进入此分支；失败跳过当前商品，不建立新增商品请求。 */
async function runStandaloneQualifications(task, identity, tabId, record, key) {
    try {
        await TemuTransferIntegrity.verify(task.snapshot, task.transferIntegrity);
        if (await readDirectPause(identity.storeId, identity)) return false;
        // 暂停恢复也重新匹配；保存的商品ID只是恢复事实，不能代替当前货号/SKU和删除状态核验。
        {
            const source = directSnapshotSource(task.snapshot);
            if (String(source?.productId) !== task.spuId) throw Error('来源商品身份不一致');
            const skcs = directAsArray(source.productSkcList);
            const compare = { ...directSourceComparePayload(source, identity), qualificationMatch: true,
                skuCodes: [...new Set(skcs.flatMap(skc => directAsArray(skc.productSkuList)
                    .map(sku => String(sku.extCode || sku.skuExtCode || '').trim()).filter(Boolean)))] };
            await rememberDirectProgress(task, { directState: 'authorizing', reason: '正在按货号和SKU货号匹配资质目标商品', status: 'received' }, tabId);
            const target = compare.productCodes.length || compare.skuCodes.length
                ? await directDuplicateCheck(tabId, compare, { force: true })
                : { state: 'not_found', reason: '没有匹配到内容：来源没有商品货号或SKU货号' };
            if (target.state !== 'exists') {
                const reason = target.state === 'not_found' ? target.reason || '没有匹配到内容：目标店未找到对应的未删除商品'
                    : `没有匹配到内容：目标查询未确认，${target.reason || '请核对店铺页面'}`;
                record = { stage: 'qualification_not_found', done: true, businessError: reason, retrySequence: directTaskRetrySequence(task) };
                await writeDirectAttempt(task, key, record);
                await rememberDirectProgress(task, { directState: record.stage, reason, errorStage: '资质匹配', status: 'received' }, tabId);
                await TemuOperationLog.append({ action: 'qualification-transfer', status: 'skipped', phase: record.stage,
                    jobId: task.jobId, spuId: task.spuId, reason });
                if (/商城身份变化|登录|未登录|验证码|请打开商品列表页/.test(reason)) directStopRequested.add(identity.storeId);
                return !directStopRequested.has(identity.storeId);
            }
            if (record?.productId && (record.productId !== target.productId || record.mallId !== identity.mallId)) {
                throw Error('没有匹配到内容：恢复时目标商品已变化，未向另一商品提交资质');
            }
            record = { ...record, stage: 'qualifying', productId: target.productId, mallId: identity.mallId,
                qualificationItems: record?.qualificationItems || [], retrySequence: directTaskRetrySequence(task) };
            await writeDirectAttempt(task, key, record);
        }
        return await finishDirectQualifications(task, identity, tabId, record, key);
    } catch (error) {
        const reason = directErrorText(error);
        if (await readDirectPause(identity.storeId, identity)) return false;
        record = { ...record, stage: 'qualification_failed', done: true, businessError: reason, retrySequence: directTaskRetrySequence(task) };
        await writeDirectAttempt(task, key, record);
        await rememberDirectProgress(task, { directState: record.stage, reason, errorStage: '资质', status: 'received' }, tabId);
        await TemuOperationLog.append({ action: 'qualification-transfer', status: 'failed', jobId: task.jobId, spuId: task.spuId, reason });
        if (/商城身份变化|登录|未登录|验证码|请打开商品列表页/.test(reason)) { directStopRequested.add(identity.storeId); return false; }
        return true;
    }
}
