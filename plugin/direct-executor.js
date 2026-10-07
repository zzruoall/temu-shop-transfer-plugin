/** 后台固定接口执行器：页面只接触商品数据，不接触云仓凭据。 */
const directRunningTabs=new Set();
const directRunningStores=new Map();
const directRerunTabs=new Map();
// 已开始的预检/提交与尚未开始队列分离，暂停换批和结束不得重放当前件。
const directActiveTaskKeys = new Set();
const directDuplicateEpochs = new Map();
/** 本地暂停开关只属于当前页面会话，不能继承旧版本或刷新前任务。 */
const directStopRequested = new Set();
function directPauseKey(storeId) { return `directPause:${String(storeId || '').trim()}`; }
/** 每个提交安全点核对真实文档和本地代次，读取失败保持禁止提交。 */
async function readDirectPause(storeId, identity = null) {
    try {
        const key = directPauseKey(storeId);
        const state = (await chrome.storage.session.get(key))[key];
        if (!state || state.paused || state.enabledVersion !== chrome.runtime.getManifest().version
            || revokedExecutionRuns.has(state.executionRunId)) return state || { paused: true };
        if (identity && (state.executionRunId !== identity.executionRunId || state.relaySessionId !== identity.relaySessionId
            || state.documentId !== identity.documentId || state.tabId !== identity.tabId)) return { paused: true };
        await assertExecutionDocument(state.tabId, state.documentId);
        return null;
    } catch (_) { return { paused: true, reason: '无法核对当前页面，停止新增' }; }
}
/**
 * 把任意抛出值转成可读文本。Temu 客户端在接口校验失败时抛出的是普通对象（只有 success/errorCode/errorMsg），
 * 直接 String() 只会得到 "[object Object]"，会让“结果待核对”完全失去可诊断性。
 * 因此按错误语义字段优先取值：先下探响应体（真正原因通常在里面），再退回顶层 message。
 */
function directErrorText(error, limit = 2000) {
    const seen = new Set();
    const read = (value, depth) => {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        if (typeof value !== 'object' || depth > 4 || seen.has(value)) return '';
        seen.add(value);
        for (const key of ['response', 'data', 'result', 'body', 'error', 'detail', 'message', 'msg', 'errorMsg', 'errorMessage', 'error_message', 'reason']) {
            const text = read(value[key], depth + 1);
            if (text) return text;
        }
        try { return JSON.stringify(value) ?? ''; } catch (_) { return ''; }
    };
    let text = '';
    try { text = read(error, 0); } catch (_) { text = ''; }
    if (!text) { try { text = String(error ?? ''); } catch (_) { text = ''; } }
    text = text.replace(/\s+/g, ' ').trim();
    // 平台错误码是运营核对问题的关键线索，文本里没有就补上。
    const code = error && typeof error === 'object' ? error.errorCode ?? error.code : null;
    if (code !== null && code !== undefined && !text.includes(String(code))) text = `${text}（错误码 ${code}）`;
    return text.slice(0, limit) || '未知错误';
}
/** 把接口创建阶段写回本店任务，并通知当前页面板；失败时不能只记后台日志。 */
async function rememberDirectProgress(task,patch,tabId){
    const payload={
        jobId:task.jobId,
        spuId:task.spuId,
        targetStoreId:task.targetStoreId,
        relaySessionId:task.relaySessionId,
        executionRunId:task.executionRunId,
        directCreate:true,
        ...patch
    };
    if(typeof updateDirectTaskProgress==="function"){
        await updateDirectTaskProgress(task.targetStoreId,task.jobId,task.spuId,patch,task);
    }
    if(typeof notifyDirectCreateProgress==="function"){
        await notifyDirectCreateProgress(tabId,payload);
    }
}
function directPageError(entry){
    if(entry?.error)return directErrorText(entry.error);
    if(entry?.result?.__temuDirectPageError)return directErrorText(entry.result.__temuDirectPageError);
    // chrome.scripting.executeScript 在页面函数抛错时仍会返回结果项，真实原因位于 exceptionDetails；不读取这里会把业务阻断误报成页面未响应。
    if(entry?.exceptionDetails){
        const exception=entry.exceptionDetails;
        const detail=directErrorText(exception.exception?.description||exception.exception?.value||exception.text||exception);
        if(detail&&detail!=='未知错误')return detail;
    }
    // 注入返回空结果通常发生在文档重载或路由切换瞬间，写清原因，便于在日志里和“平台拒绝”区分开。
    if(!entry?.result)return "页面注入未返回结果（可能正在刷新或已离开商品列表页）";
    return "";
}
/** 兼容旧任务摘要中的重试序号；当前人工重试直接清理本页尝试，不请求服务器许可。 */
function directTaskRetrySequence(task){
    return Math.max(0, Number(task?.directRetrySequence) || 0);
}
/** 读取当前页面的尝试；不匹配的旧序号不再参与本次执行。 */
async function directAttemptRecord(task,key){
    const record=(await chrome.storage.session.get(key))[key];
    if(!record)return null;
    if(Number(record.retrySequence||0)===directTaskRetrySequence(task))return record;
    await chrome.storage.session.remove(key);
    return null;
}

/** 尝试正文与队列使用同一写锁；迟到预检或旧执行代次不能重新落盘孤儿请求。 */
async function writeDirectAttempt(task, key, record) {
    return withTargetTaskMutation(async () => {
        const tasks = await getTargetUploadTasks();
        const live = tasks.find(item => item.targetStoreId === task.targetStoreId
            && item.jobId === task.jobId && item.spuId === task.spuId
            && item.relaySessionId === task.relaySessionId);
        const previous = (await chrome.storage.session.get(key))[key];
        // 暂停禁止下一次提交，但不抹掉已发出同一attempt的真实结果；结束换会话后仍必须拒绝。
        const knownResult = record.attemptId && previous?.attemptId === record.attemptId
            && ['verifying', 'created', 'unknown', 'rejected'].includes(record.stage);
        if (!live || (!knownResult && (live.executionRunId !== task.executionRunId || revokedExecutionRuns.has(task.executionRunId)))) throw Error('本地执行轮次已结束，丢弃迟到结果');
        await pruneDirectAttempts();
        if (knownResult) {
            await saveTargetUploadTasks(tasks.map(item => item !== live ? item : { ...item, directState: record.stage,
                ...(record.productId ? { reason: `平台已返回商品 ${record.productId}；请到目标店核对，不代表审核上架` } : {}) }), { [key]: record });
        } else await setTargetSessionValues({ [key]: record });
    });
}
/**
 * 目标店判重开关。正式版必须为 true：货号比对是防止同一件商品被重复创建的唯一防线。
 * 仅在需要"不判重直接上传"的临时测试版本里改成 false，改完必须改回来。
 */
const DUPLICATE_CHECK_ENABLED = true;

/**
 * 在目标店铺页面查询真实商品列表，新增前排除同货号的未删除商品。
 * 查询必须由目标店插件执行，因为服务器无法访问 Temu 店铺会话。
 * 使用页面已验证的 skcExtCodes / skuExtCodes 精确过滤，只遍历对应货号的结果。
 *
 * 检索失败返回 uncertain，不能伪装成不存在；无货号是明确的无法比对条件，仍允许提交。
 * 不缓存不存在或已删除结论；仅保留本轮平台已确认的新建事实，避免列表同步延迟造成重复新增。
 * options.force：仅用于隔离测试绕过临时缓存，正式创建前仍必须判重。
 */
async function directDuplicateCheck(tabId, payload = {}, options = {}) {
    // 判重整体关闭时（临时测试版本）直接判定"未发现重复"，不发起任何检索请求。
    if (!DUPLICATE_CHECK_ENABLED && !options.force) {
        return { state: 'not_found', scanned: 0, pages: 0, queryMode: 'check_disabled' };
    }
    let lastError = null;
    // 检索失败允许整体重试一次，避免一次页面切换就白白放弃判重。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const [entry] = await executionWithDeadline(() => chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: async (payload) => {
                if (location.origin + location.pathname !== 'https://agentseller.temu.com/goods/list') throw Error('请打开商品列表页');
                let runtime; window.chunkLoadingGlobal_temu_sca_goods?.push([[crypto.randomUUID()], {}, r => runtime = r]);
                // 客户端模块名必须与 prepare/submit 使用同一套特征，避免选到无法发起请求的同名模块。
                const candidates = Object.entries(runtime?.m || {}).filter(([, f]) => {
                    const source = String(f).replace(/\s+/g, '');
                    return source.includes('getMallIdAsync') && source.includes('.postWithoutMallId=') && source.includes('.mallIdClient=');
                });
                if (candidates.length !== 1) throw Error('平台客户端不兼容');
                const client = runtime(candidates[0][0]);
                const mallId = String(await client.mallIdClient.getMallIdAsync());
                if (mallId !== String(payload.mallId)) throw Error('商城身份变化');
                const epoch = String(payload.cacheEpoch || '');
                const cached = window.__temuDuplicateIndex;
                const sameCache = !payload.force && epoch && cached?.removalAware === true && cached.epoch === epoch && cached.mallId === mallId;
                const createdRows = sameCache ? cached.rows.filter(row => row.locallyCreated) : [];
                // 判重主键分两级：商品/SKC 货号优先，只有完全没有商品货号时才使用 SKU 货号。
                // 两级不能交叉匹配，否则来源 SKU 货号会误命中目标店其他商品的商品货号。
                // 页面侧同样可能拿到类数组实例，这里不能只认 Array.isArray，否则货号会被读成空集合。
                const pageArray = value => Array.isArray(value) ? value : (value && typeof value === 'object' && typeof value.length === 'number' ? Array.from(value) : []);
                const normalizeCodes = values => new Set(pageArray(values)
                    .map(value => String(value || '').trim()).filter(Boolean));
                const hasStructuredCodes = Array.isArray(payload.productCodes) || Array.isArray(payload.skuCodes);
                const targetProductCodes = normalizeCodes(payload.productCodes);
                const targetSkuCodes = normalizeCodes(payload.skuCodes);
                const legacyExtCodes = hasStructuredCodes ? new Set() : normalizeCodes(payload.extCodes);
                const QUERY_PATH = '/visage-agent-seller/product/skc/pageQuery';
                const PAGE_SIZE = 100;
                const MAX_PAGES = 60;
                // 删除状态属于具体商品行；同货号的删除版本不能替仍在店内的另一版本放行。
                const unknownMatches = new Set();
                // 实时匹配与缓存压缩使用同一组 SKU，空数组不能遮蔽另一字段内的有效货号。
                const rowSkus = row => [row.productSkuSummaries, row.skus, row.productSkuList]
                    .find(value => Array.isArray(value) && value.length) || [];
                const removalStatus = row => {
                    const value = row.removeStatus;
                    return value === 0 || value === 1 ? value
                        : (typeof value === 'string' && /^[01]$/.test(value.trim()) ? Number(value) : null);
                };
                const matchRow = (row) => {
                    const id = String(row.productId || row.spuId || row.goodsId || '');
                    const name = String(row.productName || row.productTitle || row.name || '').trim();
                    const skus = rowSkus(row);
                    const rowCodes = [String(row.extCode || row.skcExtCode || '').trim()].filter(Boolean);
                    const skuCodes = skus.map(item => String(item.extCode || item.skuExtCode || item.merchantSku || item.skuCode || '').trim()).filter(Boolean);
                    let matchedBy = '';
                    if (targetProductCodes.size && rowCodes.some(code => targetProductCodes.has(code))) matchedBy = 'productExtCode';
                    else if (targetSkuCodes.size && skuCodes.some(code => targetSkuCodes.has(code))) matchedBy = 'skuExtCode';
                    // 旧调用方仍传扁平 extCodes；仅为兼容历史记录保留组合匹配，新的内部调用不再使用这条路径。
                    else if (legacyExtCodes.size && [...rowCodes, ...skuCodes].some(code => legacyExtCodes.has(code))) matchedBy = 'legacyExtCode';
                    if (!matchedBy) return null;
                    // 同货号版本分别记录未知状态，不能用另一删除版本抵消未确认的行。
                    const key = id && row.productSkcId ? JSON.stringify([id, row.productSkcId, matchedBy]) : null;
                    const status = removalStatus(row);
                    if (status === null) { unknownMatches.add(key || Symbol()); return null; }
                    if (status === 1) return null;
                    return { state: 'exists', productId: id, productName: name, matchedBy };
                };
                // 本轮已确认新建属于批次防重事实；平台列表同步延迟或旧删除行不能抹掉这一事实。
                for (const row of createdRows) {
                    const hit = matchRow(row);
                    if (hit) return { ...hit, queryMode: 'created_in_batch' };
                }
                // 货号只用于判断是不是重复商品，不是上传前提：有商品货号按商品货号比、只有 SKU 货号按 SKU 货号比。
                // 两者都没有时无法比对，按“未发现重复”继续真实上传，由平台决定能否创建；
                // 只有检索命中重复才停止，避免用名称、SPU 或 SKU ID 猜测同款。
                if (!targetProductCodes.size && !targetSkuCodes.size && !legacyExtCodes.size) {
                    return { state: 'not_found', scanned: 0, pages: 0, queryMode: 'no_code' };
                }
                let scanned = 0;
                let pages = 0;
                // 页面精确查询字段已在真实店铺核实；旧 extCodes 会被忽略，禁止再尝试或退回无过滤请求。
                const queries = [
                    ...Array.from(targetProductCodes, code => ({ field: 'skcExtCodes', code })),
                    ...Array.from(targetSkuCodes, code => ({ field: 'skuExtCodes', code })),
                    ...Array.from(legacyExtCodes, code => ({ field: 'skcExtCodes', code })),
                    ...Array.from(legacyExtCodes, code => ({ field: 'skuExtCodes', code }))
                ];
                const queryMode = [...new Set(queries.map(query => query.field))].join('+');
                for (const { field, code } of queries) {
                    let total = null;
                    let received = 0;
                    const seenRows = new Set();
                    for (let page = 1; page <= MAX_PAGES; page += 1) {
                        const response = await client.post(QUERY_PATH, { page, pageSize: PAGE_SIZE, [field]: [code] });
                        const root = response?.result || response?.data || response;
                        const rows = root?.pageItems;
                        const count = root?.total;
                        // 空结果只有在平台明确 total=0 时才足以放行，错误响应或缺总数不能当作没有重复。
                        if (response?.success === false || !Array.isArray(rows)
                            || !Number.isSafeInteger(count) || count < 0) {
                            throw Error('货号精确查询返回结构或总数未知');
                        }
                        if (total !== null && total !== count) throw Error('货号精确查询总数变化，尚未确认');
                        total = count;
                        scanned += rows.length;
                        pages += 1;
                        if (received + rows.length > total || (!rows.length && received < total)) {
                            throw Error('货号精确查询结果不完整，尚未确认');
                        }
                        // 先核对整页过滤语义，再采用任一命中，避免半页有效掩盖平台字段失效。
                        for (const row of rows) {
                            const codes = field === 'skcExtCodes'
                                ? [String(row?.extCode || row?.skcExtCode || '').trim()]
                                : rowSkus(row || {}).map(sku => String(sku.extCode || sku.skuExtCode || sku.merchantSku || sku.skuCode || '').trim());
                            // 平台忽略过滤或使用宽松匹配时不能证明不存在，不允许偷偷改成扫描整店。
                            if (!codes.includes(code)) throw Error('货号精确查询过滤未生效，尚未确认');
                        }
                        for (const row of rows) {
                            const hit = matchRow(row);
                            if (hit) return { ...hit, queryMode: field, scanned, pages };
                            const id = String(row.productId || row.spuId || row.goodsId || '');
                            const signature = JSON.stringify([id, String(row.productSkcId || '')]);
                            if (!id || seenRows.has(signature)) throw Error('货号精确查询分页重复或商品身份未知');
                            seenRows.add(signature);
                        }
                        received += rows.length;
                        if (received === total) break;
                        if (page === MAX_PAGES) throw Error('货号精确查询超过分页上限，尚未确认');
                    }
                }
                if (unknownMatches.size) return { state: 'uncertain', scanned, pages, reason: '同货号商品的删除状态未确认，尚未提交' };
                return { state: 'not_found', scanned, pages, queryMode };
            }, args: [{ ...payload, cacheEpoch: directDuplicateEpochs.get(tabId) || '', force: options.force === true }] }));
            const pageError = directPageError(entry);
            if (pageError) throw Error(pageError);
            return entry.result;
        } catch (error) {
            lastError = error;
            if (error.executionTimeout) break;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 800));
        }
    }
    // 查询不确定与商品资料缺失是两件事；调用方等待重查，不能自动改为平台新增。
    return { state: 'uncertain', scanned: 0, pages: 0, reason: `商品检索失败，无法确认目标店是否已有该商品：${directErrorText(lastError, 200)}` };
}
async function directPage(tabId,operation,payload={}){
    const execute = async () => chrome.scripting.executeScript({target: payload.documentId ? { tabId, documentIds: [payload.documentId] } : {tabId},world:'MAIN',func:async(operation,payload)=>{
        /** 页面侧错误文本：平台失败对象没有 message，必须按语义字段取值，避免只留下 "[object Object]"。 */
        const pageErrorText = (value, limit = 2000) => {
            const seen = new Set();
            const read = (node, depth) => {
                if (node === null || node === undefined) return '';
                if (typeof node === 'string') return node;
                if (typeof node === 'number' || typeof node === 'boolean') return String(node);
                if (typeof node !== 'object' || depth > 4 || seen.has(node)) return '';
                seen.add(node);
                for (const key of ['response', 'data', 'result', 'body', 'error', 'detail', 'message', 'msg', 'errorMsg', 'errorMessage', 'error_message', 'reason']) {
                    const text = read(node[key], depth + 1);
                    if (text) return text;
                }
                try { return JSON.stringify(node) ?? ''; } catch (_) { return ''; }
            };
            let text = '';
            try { text = read(value, 0); } catch (_) { text = ''; }
            if (!text) { try { text = String(value ?? ''); } catch (_) { text = ''; } }
            text = text.replace(/\s+/g, ' ').trim();
            const code = value && typeof value === 'object' ? value.errorCode ?? value.code : null;
            if (code !== null && code !== undefined && !text.includes(String(code))) text = `${text}（错误码 ${code}）`;
            return text.slice(0, limit) || '未知错误';
        };
        try {
        // 身份探测是只读操作，详情页/首页也必须能完成连接；商品准备、提交仍只能从商品列表页发起。
        // 提交状态读取允许 Temu 提交后跳转到其他同源商品路由。
        if (!['identity', 'submit-status'].includes(operation)
            && location.origin + location.pathname !== 'https://agentseller.temu.com/goods/list') throw Error('请打开商品列表页');
        // 状态轮询不能依赖商品列表 runtime；Temu 提交后路由可能已切换，但同源存储仍可读取。
        if (operation === 'submit-status') {
            const key = 'temu-api-attempt-' + payload.attemptId;
            window.__temuDirectSubmitStates = window.__temuDirectSubmitStates || Object.create(null);
            let value;
            try { value = window.__temuDirectSubmitStates[key] || JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { value = window.__temuDirectSubmitStates[key] || null; }
            if (!value) throw Error('提交状态不存在');
            return value;
        }
        let runtime;window.chunkLoadingGlobal_temu_sca_goods?.push([[crypto.randomUUID()],{},r=>runtime=r]);
        const candidates=Object.entries(runtime?.m||{}).filter(([,f])=>{const s=String(f).replace(/\s+/g,'');return s.includes('getMallIdAsync')&&s.includes('.postWithoutMallId=')&&s.includes('.mallIdClient=');});
        if(candidates.length!==1)throw Error('平台客户端不兼容');
        const client=runtime(candidates[0][0]),mallId=String(await client.mallIdClient.getMallIdAsync());
        if(!/^\d+$/.test(mallId))throw Error('商城身份未知');
        if(operation==='identity')return {mallId};
        if(mallId!==payload.mallId)throw Error('商城身份变化');
        if (operation === 'cache-created') {
            let cache = window.__temuDuplicateIndex;
            const epoch = String(payload.cacheEpoch || cache?.epoch || '');
            if (!cache || cache.mallId !== mallId || cache.epoch !== epoch) {
                // 仅保存本轮平台确认的新建事实，不保存查重负结论或整店快照。
                cache = { mallId, epoch, at: 0, rows: [], removalAware: true };
                window.__temuDuplicateIndex = cache;
            }
            // 平台已确认新建的商品按未删除写入本轮索引，后续同货号立即跳过。
            for (const skc of payload.request.productSkcReqs || []) cache.rows.push({ productId: payload.productId, removeStatus: 0, locallyCreated: true, extCode: skc.extCode || skc.skcExtCode, productSkuSummaries: (skc.productSkuReqs || []).map(sku => ({ extCode: sku.extCode || sku.skuExtCode })) });
            return { updated: true };
        }
        if(operation==='preserve'){
            // 当前页面保留的请求仍需核对来源字段，暂停继续不能绕过本地来源保真检查。
            window.__temuSourcePreservation(payload.source, payload.request);
            return { preserved: true };
        }
        if(operation==='prepare'){
            if(typeof window.__temuDirectFingerprint!=='function')throw Error('页面指纹脚本未就绪，请刷新商品列表页');
            const p=await window.__temuDirectPrepare(payload.source);
            // 目标店”要哪些必填项”由平台回答，本地不再拦截：本地猜规则一旦比平台严，就会造出
            // 平台上并不存在的失败（如把条件必填当无条件必填）。可疑项只作为备注带回排查。
            const prepareNotes=[...(Array.isArray(p.notes)?p.notes:[]),...(Array.isArray(p.warnings)?p.warnings:[])];
            // 只保护来源实际存在的业务值，不把目标类目的必填模板当成上传门槛。
            window.__temuSourcePreservation(payload.source, p.request);
            const protocol=p.request.productComplianceStatementReq;
            if(protocol?.protocolVersion!=='V2.0'||protocol.protocolUrl!=='https://dl.kwcdn.com/seller-public-file-us-tag/2079f603b6/56888d17d8166a6700c9f3e82972e813.html')throw Error('平台合规声明变化');
            // 转换器生成的规格字段是带 toJSON 的类数组实例：JSON 序列化正常，但 structuredClone 会丢掉内容
            // （chrome.scripting 回传和 chrome.storage 都走 structuredClone）。
            // 暂停继续时使用从扩展存储读回的请求副本，规格丢失会误报“规格对应关系不唯一”，
            // 因此必须在请求离开页面前就用 JSON 往返规范化成真数组，让两条路径拿到同一份数据。
            const request=JSON.parse(JSON.stringify(p.request));
            const fingerprint=await window.__temuDirectFingerprint(request);
            // 页面内留一份规范化后的请求原件：提交时优先复用同一对象，避免请求经扩展存储/消息边界往返后被重新序列化。
            window.__temuDirectPreparedRequests=window.__temuDirectPreparedRequests||Object.create(null);
            if(payload.prepareKey)window.__temuDirectPreparedRequests[payload.prepareKey]=request;
            // 目标店要求的字段（备货区域、生产地）由插件补齐时把结论带回后台，运营才能看到实际提交了什么。
            return {request,hash:fingerprint.hash,hashLength:fingerprint.length,notes:prepareNotes};
        }
        if(operation==='submit'){
            if (!payload.executionRunId || window.__temuExecutionRound?.id !== payload.executionRunId || window.__temuExecutionRound.stopped) throw Error('页面执行轮次已结束，未提交');
            if(typeof window.__temuDirectFingerprint!=='function')throw Error('页面指纹脚本未就绪，请刷新商品列表页');
            const key='temu-api-attempt-'+payload.attemptId;
            window.__temuDirectSubmitStates = window.__temuDirectSubmitStates || Object.create(null);
            const old = window.__temuDirectSubmitStates[key] || (()=>{ try { return JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (_) { return null; } })();
            if (old) throw Error('禁止重复提交');
            // 提交请求可能触发商品列表页刷新，不能依赖 executeScript 直接返回 Promise 结果。
            const state = { state: 'submitting', startedAt: Date.now() };
            window.__temuDirectSubmitStates[key] = state;
            sessionStorage.setItem(key, JSON.stringify(state));
            (async()=>{
                try {
                    const currentMallId = String(await client.mallIdClient.getMallIdAsync());
                    if (currentMallId !== String(payload.mallId)) throw Error('提交前商城身份变化');
                    // 仅当前文档可提交；页面内副本缺失时仍对后台提供的同轮次请求核验指纹。
                    const prepared=window.__temuDirectPreparedRequests?.[payload.requestKey];
                    const request=prepared||payload.request;
                    // 指纹基于规范化请求内容，跨扩展存储/消息边界往返后仍然可比；长度差异用于区分“结构变化”和“顺序差异”。
                    const fingerprint = await window.__temuDirectFingerprint(request);
                    if (payload.requestHash && fingerprint.hash !== String(payload.requestHash)) {
                        throw Error(`提交前请求指纹变化（长度 ${fingerprint.length}/${Number(payload.requestHashLength)||0}）`);
                    }
                    if (window.__temuExecutionRound?.id !== payload.executionRunId || window.__temuExecutionRound.stopped) throw Error('本轮已停止，未向平台提交');
                    const result=await client.post('/visage-agent-seller/product/add',request),productId=String(result?.productId||'');
                    if(!/^\d{6,20}$/.test(productId)) throw Error('新增响应没有商品ID');
                    const completed = { state: 'created', productId, at: Date.now() };
                    window.__temuDirectSubmitStates[key] = completed;
                    sessionStorage.setItem(key, JSON.stringify(completed));
                } catch (error) {
                    // 平台校验失败抛出的是普通对象（success:false/errorCode/errorMsg），属于确定性拒绝：商品没有创建，
                    // 不能写成“结果待核对”，否则插件会反复重试且运营看不出真实原因。
                    // 系统异常、限流和超时都不能证明平台未创建；保留 unknown，禁止自动再次新增。
                    // 该判定必须写在页面函数内：提交结果只在这里生成，模块作用域的常量在这里不可见。
                    const readable = pageErrorText(error);
                    const rawCode = error && typeof error === 'object' ? (error.errorCode ?? error.code) : null;
                    const codeNumber = rawCode === null || rawCode === undefined || String(rawCode).trim() === '' ? null : Number(rawCode);
                    const transientCodes = [1000005, 1000002, 1000001, 1000004, 429, 500, 502, 503, 504];
                    const transientText = /系统异常|系统繁忙|服务(?:器)?(?:异常|不可用)|请求超时|超时|过于频繁|限流|稍后重试|网络|gateway|timeout|too\s*many\s*requests/i;
                    const transient = Number.isFinite(codeNumber) ? transientCodes.includes(codeNumber) : transientText.test(readable);
                    const hasPlatformCode = Boolean(error && typeof error === 'object'
                        && (error.success === false || error.errorCode !== null && error.errorCode !== undefined || error.errorMsg !== null && error.errorMsg !== undefined));
                    const definitive = hasPlatformCode && !transient;
                    // 只采信平台明确返回的 SKU 货号字段；SKU ID 或整件 SKU 列表不能冒充出错货号。
                    const offendingSkuCode = String(error?.offendingSkuCode || error?.skuExtCode || '').slice(0, 255);
                    const failed = { state: definitive ? 'rejected' : 'unknown', error: readable, errorCode: rawCode ?? null,
                        offendingSkuCode, reasonTruncated: readable.length >= 2000, transient, at: Date.now() };
                    window.__temuDirectSubmitStates[key] = failed;
                    sessionStorage.setItem(key, JSON.stringify(failed));
                }
            })();
            return { started: true };
        }
        throw Error('不支持的操作');
        } catch (error) {
            // 页面异常改为正常返回值，避免 chrome.scripting 在不同 Chromium 版本下丢弃 exceptionDetails，
            // 让后台只能看到空 result 并误报“页面注入未返回结果”。
            return {
                __temuDirectPageError: pageErrorText(error),
                __temuDirectPageErrorCode: error && typeof error === 'object' ? (error.errorCode ?? error.code ?? null) : null,
                __temuDirectOffendingSkuCode: String(error?.offendingSkuCode || error?.skuExtCode || '').slice(0, 255)
            };
        }
    },args:[operation,payload]});
    let lastError = null;
    // 页面切换/Frame 重建只允许在只读阶段有限重试；submit 阶段绝不重试，避免重复创建。
    const attempts = operation === 'submit' ? 1 : 2;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const [entry] = await executionWithDeadline(execute);
            const pageError = directPageError(entry);
            if (!pageError) return entry.result;
            lastError = Object.assign(Error(`${operation}: ${pageError}`), {
                errorCode: entry.result?.__temuDirectPageErrorCode,
                offendingSkuCode: entry.result?.__temuDirectOffendingSkuCode || ''
            });
        } catch (error) {
            lastError = error;
            if (error.executionTimeout) {
                // 新增调用超时可能仍在页面等待；撤销旧代次，禁止迟到代码再开始新增或自动推进下一件。
                const state = executionActiveTabs.get(tabId);
                if (operation === 'submit' && state?.executionRunId === payload.executionRunId) await stopExecutionRound(state, '提交页面调用超时，请人工核对');
                break;
            }
        }
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 600));
    }
    let tabUrl = '';
    try { tabUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    throw Object.assign(Error(`${lastError?.message || '页面未返回结果'}（阶段=${operation}，页面=${tabUrl || '未知'}）`), {
        executionTimeout: Boolean(lastError?.executionTimeout), errorCode: lastError?.errorCode,
        offendingSkuCode: lastError?.offendingSkuCode || ''
    });
}
/** 真实商城ID采用独立命名空间，不能把紫鸟账号ID当成商城ID。 */
async function directIdentity(sender,identity,controlLocked=false){
    if(!sender.tab?.id)throw Error('缺少页面');
    let hostname = '';
    try { hostname = new URL(sender.tab.url || '').hostname; } catch (_) {}
    // 只有卖家中心页面拥有可信商城运行时；其他 temu 子域即使注入了脚本也不能参与店铺绑定。
    if (hostname !== 'agentseller.temu.com') throw Error('unsupported_page');
    await assertExecutionDocument(sender.tab.id, sender.documentId);
    const {mallId}=await directPage(sender.tab.id,'identity', { documentId: sender.documentId });
    return bindExecutionIdentity(sender, {...identity,storeId:`temu:${mallId}`,mallId,identityMatched:true,executionMode:'plugin-api'}, controlLocked);
}
/** 从来源快照提取跨店判重所需的货号集合；不把来源店内部 ID、商品名称当成目标店主键。 */
function directSnapshotSource(snapshot) {
    const source = snapshot?.publicationData?.sourceProduct;
    if (!source || typeof source !== 'object') return null;
    const merged = JSON.parse(JSON.stringify(source));
    // 类数组字段在 JSON 往返后会变成普通对象/真数组，这里统一按可迭代内容读取，避免读成空集合。
    const properties = directAsArray(merged.productPropertyList);
    const attributes = directAsArray(snapshot.attributes);
    for (const attribute of attributes) {
        const propName = String(attribute?.name || '').trim();
        const propValue = String(attribute?.value || '').trim();
        if (!propName || !propValue) continue;
        const current = properties.find(item => item && (
            (item.refPid != null && attribute.refPid != null && String(item.refPid) === String(attribute.refPid))
            || (item.vid != null && attribute.vid != null && String(item.vid) === String(attribute.vid))
            || (String(item.propName || '').trim() === propName && String(item.propValue || '').trim() === propValue)
        ));
        if (current) {
            for (const key of ['templatePid', 'pid', 'refPid', 'vid', 'valueExtendInfo', 'numberInputValue']) {
                if ((current[key] == null || current[key] === '') && attribute[key] != null && attribute[key] !== '') current[key] = attribute[key];
            }
            continue;
        }
        properties.push({
            templatePid: attribute.templatePid,
            pid: attribute.pid,
            refPid: attribute.refPid,
            vid: attribute.vid,
            propName,
            propValue,
            valueUnit: String(attribute.unit || ''),
            valueExtendInfo: String(attribute.valueExtendInfo || ''),
            numberInputValue: String(attribute.numberInputValue || '')
        });
    }
    merged.productPropertyList = properties;
    return merged;
}
/**
 * 从 SKC 列表构造跨店判重载荷：存在商品/SKC 货号时只返回商品货号，没有时才回退到 SKU 货号。
 * 返回值保留 compareMode，目标店必须按对应层级匹配，不能把两级 extCode 再合并成一个集合。
 */
/**
 * 平台转换器与页面运行时回传的列表常是"带 length/索引的类数组实例"，Array.isArray 返回 false。
 * 只认真数组会把这些列表读成空集合，进而得出"没有货号可比对"或"规格为空"的错误结论，
 * 所以判重主键提取必须统一走这里。取不到内容时返回空数组，绝不抛错打断上传流程。
 */
function directAsArray(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== 'object') return [];
    if (typeof value.length !== 'number') return [];
    try { return Array.from(value); } catch (_) { return []; }
}

function directComparePayload(skcs, skuKey = "productSkuList") {
    const sourceSkcs = directAsArray(skcs);
    const productCodes = sourceSkcs
        .map(skc => String(skc?.extCode || skc?.skcExtCode || '').trim())
        .filter(Boolean);
    const skuCodes = productCodes.length
        ? []
        : sourceSkcs.flatMap(skc => directAsArray(skc?.[skuKey])
            .map(sku => String(sku?.extCode || sku?.skuExtCode || '').trim()).filter(Boolean));
    const compareMode = productCodes.length ? 'product' : (skuCodes.length ? 'sku' : 'none');
    return {
        productCodes: [...new Set(productCodes)],
        skuCodes: [...new Set(skuCodes)],
        compareMode
    };
}

/** 从来源快照提取跨店判重所需的两级货号；不把来源店内部 ID、商品名称当成目标店主键。 */
function directSourceComparePayload(source, identity) {
    return {
        mallId: identity.mallId,
        ...directComparePayload(source?.productSkcList, "productSkuList")
    };
}
/**
 * 从本地已生成的创建请求里取货号，暂停继续前用它复查目标店是否已存在。
 * 命中时只表示不能再次创建，不据此猜测是哪一次请求创建的商品。
 */
function directRequestComparePayload(request) {
    return directComparePayload(request?.productSkcReqs, "productSkuReqs");
}

/** 批次内保留键必须带层级前缀，避免某个商品的 SKU 货号与另一个商品的商品货号偶然相同。 */
function directCompareKeys(compare) {
    return [
        ...(compare?.productCodes || []).map(code => `product\u0000${code}`),
        ...(compare?.skuCodes || []).map(code => `sku\u0000${code}`)
    ];
}
/** 判重与预检结论仅写本地日志，不向服务器回传执行结果。 */
async function reportDirectPreflightSkipped(task, identity, reason, phase = 'preflight_failed') {
    await TemuOperationLog.append({ action: 'direct-create', storeId: identity.storeId,
        jobId: task.jobId, spuId: task.spuId, phase, status: 'skipped', reason });
}
/**
 * 目标店重复预检：检索目标店商品，看这件商品的货号是否已存在。
 * 命中重复返回终态；未命中继续，未确认抛出可识别的等待信号，不能触发新增。
 *
 * 单独抽出来是因为有两个入口都必须查到：首次预检，以及"请求已生成但还没提交"的恢复路径。
 * 后者以前跳过判重直接提交，而上一次尝试可能其实已经创建成功，于是同一件商品被创建两次。
 */
async function directPreflightDuplicate(task, identity, tabId, compare) {
    const duplicate = await directDuplicateCheck(tabId, compare);
    if (duplicate.state !== 'exists') {
        const unconfirmed = duplicate.state !== 'not_found';
        if (unconfirmed) throw Object.assign(Error(`目标店重复检索未确认，尚未提交：${duplicate.reason || '检索未完成'}`), { duplicateWaiting: true });
        // 无货号时没有任何可比对的主键（queryMode=no_code），如实写"无货号无法比对"，不能谎称已按货号确认。
        const compareLabel = duplicate.queryMode === 'check_disabled'
            ? '判重已关闭（测试版），未判重直接创建'
            : unconfirmed
                ? '目标店重复检索未确认，尚未提交'
                : (duplicate.queryMode === 'no_code'
                    ? '无货号可比对，未发现重复，继续上传'
                    : `${compare.compareMode === 'sku' ? 'SKU货号' : '商品货号'}对比确认不存在，查询方式 ${duplicate.queryMode || '货号精确查询'}，检查 ${Number(duplicate.scanned) || 0} 条同货号记录`);
        await TemuOperationLog.append({ action: 'direct-create', status: unconfirmed ? 'unconfirmed' : 'checked', jobId: task.jobId, spuId: task.spuId, phase: 'duplicate_check', reason: compareLabel });
        return { duplicate: false, unconfirmed, compareLabel };
    }
    const matchedLabel = duplicate.matchedBy === 'skuExtCode' ? 'SKU货号' : '商品货号';
    const reason = `目标店已存在商品 ${duplicate.productId || task.spuId}，按${matchedLabel}确认，未创建`;
    await reportDirectPreflightSkipped(task, identity, reason, 'duplicate_exists');
    await writeDirectAttempt(task, `directAttempt:${task.jobId}:${task.spuId}`, { stage: 'duplicate_exists', done: true, retrySequence: directTaskRetrySequence(task) });
    await rememberDirectProgress(task, { directState: 'duplicate_exists', reason, status: 'received' }, tabId);
    await TemuOperationLog.append({ action: 'direct-create', status: 'skipped', jobId: task.jobId, spuId: task.spuId, phase: 'duplicate_exists', reason });
    return { duplicate: true, reason };
}

/**
 * 只做目标店重复预检和本地请求准备，不占用服务器创建许可。
 * 预检结果写入后台后，主循环再按店铺串行提交，避免同店并发写入。
 */
async function prepareDirectTask(task, identity, tabId, key, reservedCodes = new Set()) {
    // 只验证收到的原始快照未变，不按标题、图片、详情或 SKU 模板拦截。
    await TemuTransferIntegrity.verify(task.snapshot, task.transferIntegrity);
    const source = directSnapshotSource(task.snapshot);
    if (String(source?.productId) !== task.spuId) throw Error('缺少来源完整资料');
    const compare = directSourceComparePayload(source, identity);
    const codes = directCompareKeys(compare);
    // 同一批次内出现重复货号（有商品货号按商品货号、没有才按 SKU 货号）时，只上传第一件，后面的直接跳过。
    // 这不属于"目标店判重"，而是批次内自我去重。
    if (codes.some(code => reservedCodes.has(code))) {
        const reason = '同一批次已有相同货号，本件跳过，避免批次内重复创建';
        await reportDirectPreflightSkipped(task, identity, reason, 'duplicate_exists');
        await writeDirectAttempt(task, key, { stage: 'duplicate_exists', done: true, retrySequence: directTaskRetrySequence(task) });
        await rememberDirectProgress(task, { directState: 'duplicate_exists', reason, status: 'received' }, tabId);
        await TemuOperationLog.append({ action: 'direct-create', status: 'skipped', jobId: task.jobId, spuId: task.spuId, phase: 'duplicate_exists', reason });
        return { kind: 'duplicate_batch', codes: [] };
    }
    // 无货号商品没有任何可比对主键，按 SPU 记录保留位，避免同一件商品被重复排入同一批。
    if (!codes.length) reservedCodes.add(`spu\u0000${task.spuId}`);
    for (const code of codes) reservedCodes.add(code);
    try {
        await rememberDirectProgress(task, { directState: 'authorizing', reason: `正在对比目标店货号，SPU ${task.spuId}`, status: 'received' }, tabId);
        const finding = await directPreflightDuplicate(task, identity, tabId, compare);
        if (finding.duplicate) return { kind: 'duplicate_exists', codes };
        const prepared = await directPage(tabId, 'prepare', { source, mallId: identity.mallId, prepareKey: key });
        // 判重结论要如实带到提交阶段留痕：未确认就是未确认，不能写死成 not_found 谎称已确认不存在。
        const record = { stage: 'authorizing', request: prepared.request, hash: prepared.hash, hashLength: prepared.hashLength, authorizationKey: crypto.randomUUID(), mallId: identity.mallId, duplicateCheck: finding.unconfirmed ? 'unconfirmed' : (finding.compareLabel.includes('无货号') ? 'no_code' : 'not_found'), retrySequence: directTaskRetrySequence(task) };
        await writeDirectAttempt(task, key, record);
        await TemuOperationLog.append({ action: 'direct-create', status: 'started', jobId: task.jobId, spuId: task.spuId, phase: 'prepare', reason: prepared.notes?.length ? prepared.notes.join('；') : undefined });
        await rememberDirectProgress(task, { directState: 'authorizing', reason: `对比通过，已完成 SPU ${task.spuId} 预检，等待串行提交`, status: 'received' }, tabId);
        return { kind: 'prepared', codes };
    } catch (error) {
        // 预检失败要释放批次内保留位，否则这件商品即使之后重试也会被自己的占位挡住。
        for (const code of codes) reservedCodes.delete(code);
        if (!codes.length) reservedCodes.delete(`spu\u0000${task.spuId}`);
        throw error;
    }
}
/** 本地提交阶段存于浏览器会话；未知结果不重发，刷新清队列，不向服务器补报。 */
async function runDirectTasks(tabId,identity){
    // 标签页重入只补记唤醒；真正执行还要申请同一浏览器配置的平台占用，防止跨标签冲突。
    if(directRunningTabs.has(tabId)){
        // 心跳可能在上一轮仍执行时到达；记住最新身份，上一轮结束后补跑，避免批量任务丢唤醒。
        directRerunTabs.set(tabId, identity);
        return;
    }
    if(!tabId||!identity.storeId)return;
    // 停止标记优先于任何页面操作：刷新页面后由心跳再次进入也不能绕过。
    if(directStopRequested.has(identity.storeId)||await readDirectPause(identity.storeId, identity)){
        directRerunTabs.delete(tabId);
        // 暂停不恢复或补报旧执行结果。
        return;
    }
    if (!await acquirePlatformForDirect(tabId, identity.storeId)) return;
    directDuplicateEpochs.set(tabId, crypto.randomUUID());
    const runningTaskKeys = new Set();
    try{
        await executionWithDeadline(() => chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['direct-adapter.js','direct-fingerprint.js','direct-source-preservation.js']}));
        const tasks = (await getTargetUploadTasks()).filter(t => t.directCreate && t.targetStoreId === identity.storeId && t.executionRunId === identity.executionRunId);
        const reservedCodes = new Set();
        // 一件完成预检和平台提交结果读取后才处理下一件，防止同店平台请求重叠。
        const checkedThisPass = new Set();
        /** 停止是协作式的：每件开始与平台提交前都核对本地轮次；已发出的新增请求无法撤回。 */
        const stopPending = async () => directStopRequested.has(identity.storeId) || Boolean(await readDirectPause(identity.storeId, identity));
        let stopped = false;
        let activeKey = null;
        for(const task of tasks){
            if (activeKey) directActiveTaskKeys.delete(activeKey);
            // 一次性投递无需收妥回执，当前页面绑定有效即可开始。
            // 每件商品开始前先看停止标记，避免停止后仍继续对比、预检下一件。
            if(await stopPending()){stopped=true;break;}
            const key=`directAttempt:${task.jobId}:${task.spuId}`;let record=await directAttemptRecord(task,key);if(record?.done)continue;
            let ownedCodes = [];
            directActiveTaskKeys.add(key);runningTaskKeys.add(key);activeKey = key;
            if (record?.schedulingBlocked) break;
            // 目标店查询退避只存在本页队列，不能被心跳提前打断。
            if (record?.retryAt && Date.now() < record.retryAt) break;
            let duplicateChecks = 0;
            if (record?.stage === 'duplicate_wait') {
                if (Date.now() < record.retryAt) break;
                duplicateChecks = Number(record.duplicateChecks || 0);
                await chrome.storage.session.remove(key); record = null;
            }
            if (!record && task.directState !== 'unknown') {
                const outcome = await prepareDirectTask(task, identity, tabId, key, reservedCodes)
                    .then(result => ({ result })).catch(error => ({ error }));
                if (outcome.error) {
                    const readable = directErrorText(outcome.error);
                    if (outcome.error.duplicateWaiting && duplicateChecks < 2) {
                        await writeDirectAttempt(task, key, { stage: 'duplicate_wait', duplicateChecks: duplicateChecks + 1, retryAt: Date.now() + 60000, retrySequence: directTaskRetrySequence(task) });
                        await rememberDirectProgress(task, { directState: 'duplicate_wait', reason: readable, status: 'received' }, tabId);
                        break;
                    }
                    // 预检发生在任何新增请求之前，失败后没有平台副作用；落终态是为了阻止心跳无限重复失败。
                    // 人工重试入口会删除该键，因此这里不牺牲确定性错误后的恢复能力。
                    await reportDirectPreflightSkipped(task, identity, readable);
                    await writeDirectAttempt(task, key, { stage: 'preflight_failed', done: true, businessError: readable, retrySequence: directTaskRetrySequence(task) });
                    await TemuOperationLog.append({ action: 'direct-create', status: 'failed', jobId: task.jobId, spuId: task.spuId, phase: 'preflight', error: readable });
                    await rememberDirectProgress(task, { directState: 'preflight_failed', reason: readable, errorStage: '预检', errorCode: String(outcome.error?.errorCode || outcome.error?.code || ''), offendingSkuCode: String(outcome.error?.offendingSkuCode || outcome.error?.skuExtCode || ''), status: 'received' }, tabId);
                    continue;
                }
                if (outcome.result?.kind === 'duplicate_exists' || outcome.result?.kind === 'duplicate_batch') continue;
                ownedCodes = outcome.result?.codes || [];
                // 本件预检已查过目标店，提交前不重复扫描。
                if (outcome.result?.kind === 'prepared') checkedThisPass.add(key);
                record = await directAttemptRecord(task,key);
            }
            // 平台已确认创建的任务不能因心跳再次进入新增。
            if(task.directState==="created")continue;
            // 结果未知必须隔离：请求可能已被平台受理，禁止心跳自动复核/重发，避免两个商品变成三个创建尝试。
            if(task.directState==="unknown"||record?.stage==="unknown"){
                // 心跳只补齐未知分类，不覆盖首次平台错误；人工核对提示由状态标签承担。
                await rememberDirectProgress(task,{directState:'unknown',reason:task.reason || record?.businessError || '结果未知，未自动重发；请先核对目标店商品后人工确认重试',status:'received'},tabId);
                continue;
            }
            // 执行结果仅保留在当前页队列与插件日志，服务器不接收结果或授予创建许可。
            const report=extra=>TemuOperationLog.append({ action:'direct-create', storeId:identity.storeId,
                jobId:task.jobId, spuId:task.spuId, ...extra });
            try{
                // 后台重启后可能直接恢复已准备的任务，执行入口仍须核验快照。
                await TemuTransferIntegrity.verify(task.snapshot, task.transferIntegrity);
                if(!record){
                    const source=directSnapshotSource(task.snapshot);if(String(source?.productId)!==task.spuId)throw Error('缺少来源完整资料');
                    // 检索要翻完目标店全部分页，先给出可见状态，避免操作者以为点击没有反应。
                    await rememberDirectProgress(task,{directState:"authorizing",reason:`正在检索目标店是否已存在 SPU ${task.spuId}，请保持商品列表页打开`,status:"received"},tabId);
                    const finding = await directPreflightDuplicate(task, identity, tabId, directSourceComparePayload(source, identity));
                    if (finding.duplicate) continue;
                    const p=await directPage(tabId,'prepare',{source,mallId:identity.mallId,prepareKey:key});
                    record={stage:'authorizing',request:p.request,hash:p.hash,hashLength:p.hashLength,authorizationKey:crypto.randomUUID(),mallId:identity.mallId,duplicateCheck:finding.unconfirmed?'unconfirmed':'not_found',retrySequence:directTaskRetrySequence(task)};await writeDirectAttempt(task,key,record);
                    await TemuOperationLog.append({action:"direct-create",status:"started",jobId:task.jobId,spuId:task.spuId,phase:"prepare"});
                    await rememberDirectProgress(task,{directState:"authorizing",reason:`正在预检并创建 SPU ${task.spuId}，请保持商品列表页打开`,status:"received"},tabId);
                    // 现场预检刚查过目标店，登记后提交前不重复扫描。
                    checkedThisPass.add(key);
                }
                /**
                 * 提交前必须再查一次目标店——但只在本轮没有刚查过时才查。
                 * 恢复场景（请求已生成但还没提交，例如刷新页面、点停止、MV3 后台被回收）
                 * 会带着上一轮留下的本地记录直接落到这里。上一轮可能其实已经创建成功
                 * （提交后没来得及记录平台结果就被打断），只按本地记录继续提交就会把同一件商品创建两次。
                 * 刚做完预检的路径已经查过了，这里不重复扫一遍。
                 */
                if(!checkedThisPass.has(key) && record.stage==='authorizing'){
                    const source=directSnapshotSource(task.snapshot);
                    const requestCompare=directRequestComparePayload(record.request);
                    // 已准备但尚未提交的记录也参加本轮批次防重，不能依赖新建商品立刻出现在平台列表。
                    const requestKeys = directCompareKeys(requestCompare);
                    if (requestKeys.some(code => reservedCodes.has(code))) {
                        const reason = '同一批次已有相同货号，本件跳过，避免批次内重复创建';
                        record = { ...record, stage: 'duplicate_exists', done: true, businessError: reason };
                        await writeDirectAttempt(task, key, record);
                        await rememberDirectProgress(task, { directState: 'duplicate_exists', reason, status: 'received' }, tabId);
                        await report({ phase: 'duplicate_exists', status: 'skipped', reason });
                        continue;
                    }
                    for (const code of requestKeys) reservedCodes.add(code);
                    ownedCodes = requestKeys;
                    const canRetrieve=Boolean(requestCompare.productCodes.length||requestCompare.skuCodes.length);
                    const recheckPayload=canRetrieve?requestCompare:(source?directSourceComparePayload(source,identity):null);
                    if(recheckPayload){
                        const recheck=await directDuplicateCheck(tabId,{mallId:record.mallId||identity.mallId,...recheckPayload});
                        if(recheck.state==='exists'){
                            const matchedLabel=recheck.matchedBy==='skuExtCode'?'SKU货号':'商品货号';
                            const reason=`目标店已存在商品 ${recheck.productId||task.spuId}，按${matchedLabel}确认，未创建（提交前复查）`;
                            await report({phase:'duplicate_exists',reason});
                            record={...record,stage:'duplicate_exists',done:true,businessError:reason};
                            await writeDirectAttempt(task,key,record);
                            await rememberDirectProgress(task,{directState:'duplicate_exists',reason,status:'received'},tabId);
                            await TemuOperationLog.append({action:'direct-create',status:'skipped',jobId:task.jobId,spuId:task.spuId,phase:'duplicate_exists',reason});
                            continue;
                        }
                        // 恢复请求也不能绕过未查清保护；尚无授权时停止，等待人工核对后重试。
                        if(recheck.state!=='not_found'){
                            throw Object.assign(Error(`提交前复查未确认，未提交：${String(recheck.reason || '检索未完成').slice(0,120)}`), { beforeAuthorization: true });
                        }
                    }
                }
                if(record.mallId!==identity.mallId)throw Error('任务商城变化');
                if(record.stage==='authorizing'){
                    // 平台提交前最后核对本地停止状态，防止暂停或结束之后发出下一件新增请求。
                    if(await stopPending()){stopped=true;break;}
                    await directPage(tabId,'preserve',{source:directSnapshotSource(task.snapshot),request:record.request,mallId:record.mallId})
                        .catch(error => { error.beforeAuthorization = true; throw error; });
                    if(await stopPending()){stopped=true;break;}
                    // 每次新增的唯一标识在本地生成并先落盘；后台中断后绝不重放 submitting 状态。
                    record.attemptId=crypto.randomUUID();record.stage='submitting';await writeDirectAttempt(task,key,record);
                    {
                        if(await stopPending()){
                            record.stage='authorizing';delete record.attemptId;
                            await writeDirectAttempt(task,key,record);
                            stopped=true;break;
                        }
                        await directPage(tabId,'submit',{documentId:identity.documentId,executionRunId:identity.executionRunId,attemptId:record.attemptId,mallId:record.mallId,requestHash:record.hash,requestHashLength:record.hashLength,requestKey:key,request:record.request});
                        let result = null; let statusError = '';
                        // 轮询页面持久化状态；页面短暂刷新时只等待，不重新发起新增请求。
                        for (let i = 0; i < 60; i += 1) {
                            try { result = await directPage(tabId, 'submit-status', { attemptId: record.attemptId }); statusError = ''; } catch (error) { result = null; statusError = directErrorText(error, 240); if (error.executionTimeout) break; }
                            if (result?.state === 'created' || result?.state === 'unknown' || result?.state === 'rejected') break;
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        // 超时或状态不可读时把最后一次真实原因带出来，避免只看到“待核对”而无法定位。
                        if (result?.state !== 'created') {
                            const failure = Error(`${result?.error || '提交结果待核对，禁止自动重发'}${statusError ? `；读取提交状态失败：${statusError}` : ''}`.slice(0, 2000));
                            failure.errorCode = result?.errorCode;
                            failure.offendingSkuCode = result?.offendingSkuCode || '';
                            failure.reasonTruncated = Boolean(result?.reasonTruncated || failure.message.length >= 2000);
                            // 平台明确拒绝时商品确定没有创建，标记为确定性失败，避免进入自动复核循环。
                            if (result?.state === 'rejected') failure.definitive = true;
                            throw failure;
                        }
                        // 创建编号来自平台提交响应；立即结算，不再额外查询详情或比对已创建内容。
                        record.productId = result.productId; record.stage='created'; await writeDirectAttempt(task,key,record);
                        await directPage(tabId, 'cache-created', { mallId: record.mallId, productId: record.productId, request: record.request, cacheEpoch: directDuplicateEpochs.get(tabId) || '' }).catch(() => directDuplicateEpochs.delete(tabId));
                    }
                }
                if(record.productId){
                    const createdReason = `平台已确认创建（商品 ${record.productId}），不代表审核上架`;
                    await report({phase:'created',attemptId:record.attemptId,productId:record.productId,reason:createdReason});record.done=true;record.stage='created';delete record.request;
                    await TemuOperationLog.append({action:"direct-create",status:"succeeded",jobId:task.jobId,spuId:task.spuId,phase:"created"});
                    await rememberDirectProgress(task,{directState:"created",reason:createdReason,errorCode:'',errorStage:'',status:"received"},tabId);
                }else{await report({phase:'unknown',attemptId:record.attemptId,reason:'提交结果待核对，禁止自动重发'});record.stage='unknown';
                    await rememberDirectProgress(task,{directState:"unknown",reason:"提交结果待核对，禁止自动重发",status:"received"},tabId);
                }
                await writeDirectAttempt(task,key,record);
            }catch(error){
                const readable=directErrorText(error);
                // 新增尚未发出时释放本件自己的批次占位；已提交或结果未知的占位不能释放以免重复创建。
                if (!record?.attemptId) for (const code of ownedCodes) reservedCodes.delete(code);

                if (!record?.attemptId && error?.beforeAuthorization) {
                    // 本页复用的请求若丢字段必须落成明确失败，不能让心跳无限重复预检。
                    await report({phase:'preflight_failed',reason:readable.slice(0,800)});
                    record={...record,stage:'preflight_failed',done:true,businessError:readable};
                    await writeDirectAttempt(task,key,record);
                    await rememberDirectProgress(task,{directState:'preflight_failed',reason:readable,status:'received'},tabId);
                    continue;
                }

                // 确定性拒绝（平台校验失败）表示商品确定没有创建，必须停在“预检失败”并写明原因，
                // 不能走“结果待核对 → 自动复核重试”，否则只会反复撞同一个平台校验错误。
                const definitive=error?.definitive===true;
                await TemuOperationLog.append({action:'direct-create',status:'failed',jobId:task.jobId,spuId:task.spuId,error:readable});
                const failedState=definitive?"rejected":(record?.attemptId?"unknown":"preflight_failed");
                if(definitive){
                    await report({phase:'rejected',attemptId:record?.attemptId||'',reason:readable.slice(0,800)});
                    record={...(record||{}),stage:'rejected',done:true,businessError:readable};
                    await writeDirectAttempt(task,key,record);
                }
                await rememberDirectProgress(task,{directState:failedState,reason:readable,errorCode:String(error?.errorCode ?? error?.code ?? ''),
                    offendingSkuCode:String(error?.offendingSkuCode || error?.skuExtCode || ''), reasonTruncated:Boolean(error?.reasonTruncated),
                    errorStage:record?.attemptId?'提交':'预检',status:"received"},tabId);
                if(record?.attemptId&&!definitive){
                    // 先保留本地未知状态；即使补报落盘失败，下一轮也不能再次执行平台新增。
                    record.stage='unknown';record.businessError=readable;await writeDirectAttempt(task,key,record);
                    await report({phase:'unknown',attemptId:record.attemptId,productId:record.productId||'',reason:readable.slice(0,800)});
                }
                // 尚未生成尝试的失败也记入本地日志，不留服务端待补回执。
                else if(!record)await report({phase:'preflight_failed',reason:readable.slice(0,800)});continue;
            }
            if(!record.done)continue;
        }
        // 停止后留一条可核对的结论：运营需要知道停止生效在哪个位置，以及还有多少件没动。
        if(stopped)await TemuOperationLog.append({action:'direct-create',status:'skipped',storeId:identity.storeId,phase:'stopped',
            reason:`操作者已停止接口创建：本轮不再处理剩余 ${tasks.length} 件中的未完成商品，已发出的提交无法撤回`});
    }catch(error){
        const tasks=(await getTargetUploadTasks()).filter(t=>t.directCreate&&t.targetStoreId===identity.storeId
            && t.relaySessionId === identity.relaySessionId && t.executionRunId === identity.executionRunId);
        // 注入等外围错误只关联尚未结束的当前件，不能把本批第一件已成功商品误标为失败。
        const task=tasks.find(item=>!['created','duplicate_exists','preflight_failed','rejected','unknown'].includes(String(item.directState||'')));
        const readable=directErrorText(error);
        await TemuOperationLog.append({action:"direct-create",status:"failed",storeId:identity.storeId,error:readable});
        if(task){
            await rememberDirectProgress(task,{directState:"preflight_failed",reason:readable,errorStage:'预检',status:"received"},tabId);
        }
    }finally{
        for (const key of runningTaskKeys) directActiveTaskKeys.delete(key);
        await withTargetTaskMutation(() => pruneDirectAttempts()).catch(() => {});
        directDuplicateEpochs.delete(tabId);
        directRunningTabs.delete(tabId);
        if (directRunningStores.get(identity.storeId) === tabId) directRunningStores.delete(identity.storeId);
        const rerunIdentity = directRerunTabs.get(tabId);
        if (rerunIdentity) {
            directRerunTabs.delete(tabId);
            queueMicrotask(() => runDirectTasks(tabId, rerunIdentity).catch(error => {
                TemuOperationLog.append({ action: 'direct-create', status: 'failed', storeId: rerunIdentity.storeId, error: directErrorText(error) }).catch(() => {});
            }));
        }
    }
}
