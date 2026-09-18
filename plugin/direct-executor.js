/** 后台固定接口执行器：页面只接触商品数据，不接触云仓凭据。 */
const directRunningTabs=new Set();
const directRerunTabs=new Map();
// 预检与提交必须严格串行：并发调用多个页面脚本会争抢同一个 Temu runtime，
// 曾导致目标店接口返回“系统异常（错误码 1000005）”这类临时故障，把资料完好的商品误判为失败。
const DIRECT_PREFLIGHT_CONCURRENCY = 1;
// 提交成功后 Temu 会刷新商品列表页，回查可能正好落在文档重载窗口里。回查与“按货号在列表确认”共用这一时间窗，
// 窗口内允许重试，超时后按结果未知处理，仍不重发新增请求。
const DIRECT_VERIFY_WINDOW_MS = 20000;
const DIRECT_VERIFY_RETRY_MS = 1200;
// 次数上限是时间窗之外的兜底：单次注入卡住时不能无限重试同一件商品。
const DIRECT_VERIFY_MAX_ATTEMPTS = 12;
/**
 * 逐店“停止接口创建”开关。运营此前只能用刷新页面尝试打断自动创建，刷新反而会重新领取并继续，
 * 因此停止标记必须落盘：刷新、切页、重开浏览器后都保持停止，直到操作者在面板上点“继续接口创建”。
 * 内存集合只用于让已经开始的那一轮在下一个安全点收手，不作为判断的唯一依据。
 */
const directStopRequested = new Set();
function directPauseKey(storeId) { return `directPause:${String(storeId || '').trim()}`; }
/** 读取某目标店的停止标记；存储异常时按“未停止”处理，不能让读失败永久挡住正常任务。 */
async function readDirectPause(storeId) {
    const store = String(storeId || '').trim();
    if (!store) return null;
    try {
        const key = directPauseKey(store);
        const stored = await chrome.storage.local.get(key);
        return stored?.[key]?.paused ? stored[key] : null;
    } catch (_) { return null; }
}
/** 写入或清除停止标记。停止必须先落盘再置内存标记，插件被刷新时状态才不会丢。 */
async function writeDirectPause(storeId, paused, reason = '') {
    const store = String(storeId || '').trim();
    if (!store) throw Error('缺少目标店铺，无法停止接口创建');
    const key = directPauseKey(store);
    if (!paused) {
        directStopRequested.delete(store);
        await chrome.storage.local.remove(key);
        return null;
    }
    const value = { paused: true, at: new Date().toISOString(), reason: String(reason || '').slice(0, 240) };
    await chrome.storage.local.set({ [key]: value });
    directStopRequested.add(store);
    return value;
}
/**
 * 把任意抛出值转成可读文本。Temu 客户端在接口校验失败时抛出的是普通对象（只有 success/errorCode/errorMsg），
 * 直接 String() 只会得到 "[object Object]"，会让“结果待核对”完全失去可诊断性。
 * 因此按错误语义字段优先取值：先下探响应体（真正原因通常在里面），再退回顶层 message。
 */
function directErrorText(error, limit = 800) {
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
        directCreate:true,
        ...patch
    };
    if(typeof updateDirectTaskProgress==="function"){
        await updateDirectTaskProgress(task.targetStoreId,task.jobId,task.spuId,patch);
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
/** 人工重试由服务器递增序号；插件必须按该序号隔离旧 attempt，不能继续沿用本地已结束记录。 */
function directTaskRetrySequence(task){
    return Math.max(0, Number(task?.directRetrySequence) || 0);
}
/** 读取当前重试轮次的本地记录；服务器已重新排队时先清除上一轮，避免 done 标记把新任务跳过。 */
async function directAttemptRecord(task,key){
    const record=(await chrome.storage.local.get(key))[key];
    if(!record)return null;
    if(Number(record.retrySequence||0)===directTaskRetrySequence(task))return record;
    await chrome.storage.local.remove(key);
    return null;
}
/**
 * 测试开关：开启后跳过目标店重复检索，商品不判重直接进入真实创建。
 * 仅用于测试版本，避免自动化测试反复被"目标店已存在"挡住；
 * 正式发布必须保持为 false，否则同一件商品会被重复创建。
 * 注意：只跳过"创建前防重复"，创建后的回查确认仍走真实检索（options.force）。
 */
const SKIP_DUPLICATE_CHECK_FOR_TESTING = true;

/**
 * 在目标店铺页面查询真实商品列表，创建授权前先排除已存在商品。
 * 查询必须由目标店插件执行，因为服务器无法访问 Temu 店铺会话。
 * 优先使用服务端货号过滤；过滤不可用时才遍历全部分页。接口异常、分页重复或超过上限都返回 uncertain，
 * 由调用方按“结果未知”处理，禁止在无法证明不存在时创建，避免产生重复商品。
 * options.force：创建后的回查确认必须真实检索，不能被测试跳过开关影响，否则无法判断商品是否已创建。
 */
async function directDuplicateCheck(tabId, payload = {}, options = {}) {
    // 测试版：创建前直接判定“未发现重复”，不发起任何检索请求。
    if (SKIP_DUPLICATE_CHECK_FOR_TESTING && !options.force) {
        return { state: 'not_found', scanned: 0, pages: 0, queryMode: 'skipped_for_testing' };
    }
    let lastError = null;
    // 重复检索是唯一的重复防线，允许整体重试一次，避免一次页面切换把任务永久判为失败。
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const [entry] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: async (payload) => {
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
                // 判重主键分两级：商品/SKC 货号优先，只有完全没有商品货号时才使用 SKU 货号。
                // 两级不能交叉匹配，否则来源 SKU 货号会误命中目标店其他商品的商品货号。
                const normalizeCodes = values => new Set((Array.isArray(values) ? values : [])
                    .map(value => String(value || '').trim()).filter(Boolean));
                const hasStructuredCodes = Array.isArray(payload.productCodes) || Array.isArray(payload.skuCodes);
                const targetProductCodes = normalizeCodes(payload.productCodes);
                const targetSkuCodes = normalizeCodes(payload.skuCodes);
                const legacyExtCodes = hasStructuredCodes ? new Set() : normalizeCodes(payload.extCodes);
                const QUERY_PATH = '/visage-agent-seller/product/skc/pageQuery';
                const PAGE_SIZE = 100;
                const MAX_PAGES = 60;
                const readRows = (response) => {
                    const root = response?.result || response?.data || response;
                    const rows = root?.pageItems || root?.items || root?.list || root?.records;
                    return Array.isArray(rows) ? rows : null;
                };
                const matchRow = (row) => {
                    const id = String(row.productId || row.spuId || row.goodsId || '');
                    const name = String(row.productName || row.productTitle || row.name || '').trim();
                    const skus = [row.productSkuSummaries, row.skus, row.productSkuList]
                        .find(value => Array.isArray(value) && value.length) || [];
                    const rowCodes = [String(row.extCode || row.skcExtCode || '').trim()].filter(Boolean);
                    const skuCodes = skus.map(item => String(item.extCode || item.skuExtCode || item.merchantSku || item.skuCode || '').trim()).filter(Boolean);
                    if (targetProductCodes.size && rowCodes.some(code => targetProductCodes.has(code))) {
                        return { state: 'exists', productId: id, productName: name, matchedBy: 'productExtCode' };
                    }
                    if (targetSkuCodes.size && skuCodes.some(code => targetSkuCodes.has(code))) {
                        return { state: 'exists', productId: id, productName: name, matchedBy: 'skuExtCode' };
                    }
                    // 旧调用方仍传扁平 extCodes；仅为兼容历史记录保留组合匹配，新的内部调用不再使用这条路径。
                    if (legacyExtCodes.size && [...rowCodes, ...skuCodes].some(code => legacyExtCodes.has(code))) {
                        return { state: 'exists', productId: id, productName: name, matchedBy: 'legacyExtCode' };
                    }
                    return null;
                };
                const readTotal = (response) => {
                    const root = response?.result || response?.data || response;
                    const value = root?.total ?? root?.totalCount ?? root?.count;
                    return Number.isFinite(Number(value)) ? Number(value) : null;
                };
                // 过滤接口只用于加速命中。商品级过滤字段在当前 Temu 版本中并非公开契约，
                // 即使返回 0 条也不能直接判定不存在，必须继续完整分页；SKU 过滤字段确认支持后才允许提前判定无重复。
                const tryCodeFilter = async (codes, fields) => {
                    if (!codes.size) return { allAccepted: false, allZero: false };
                    let accepted = 0;
                    let zeroResults = 0;
                    for (const code of codes) {
                        let codeAccepted = false;
                        for (const field of fields) {
                            let response;
                            try {
                                response = await client.post(QUERY_PATH, { page: 1, pageSize: PAGE_SIZE, [field]: [code] });
                            } catch (_) {
                                continue;
                            }
                            const rows = readRows(response);
                            if (!rows) continue;
                            codeAccepted = true;
                            accepted += 1;
                            for (const row of rows) {
                                const hit = matchRow(row);
                                if (hit) return { hit: { ...hit, queryMode: field, scanned: rows.length, pages: 1 } };
                            }
                            if (readTotal(response) === 0) zeroResults += 1;
                            break;
                        }
                        if (!codeAccepted) return { allAccepted: false, allZero: false };
                    }
                    return {
                        allAccepted: accepted === codes.size,
                        allZero: accepted === codes.size && zeroResults === codes.size
                    };
                };
                if (targetProductCodes.size) {
                    const filtered = await tryCodeFilter(targetProductCodes, ['extCodes', 'skcExtCodes']);
                    if (filtered.hit) return filtered.hit;
                }
                if (targetSkuCodes.size) {
                    const filtered = await tryCodeFilter(targetSkuCodes, ['skuExtCodes']);
                    if (filtered.hit) return filtered.hit;
                    // 仅在没有任何商品级货号、且平台的 SKU 过滤已确认执行时，才允许直接判定目标店无重复。
                    if (!targetProductCodes.size && filtered.allZero) {
                        return { state: 'not_found', scanned: 0, pages: 0, queryMode: 'skuExtCodes' };
                    }
                }
                // 货号只用于判断是不是重复商品，不是上传前提：有商品货号按商品货号比、只有 SKU 货号按 SKU 货号比。
                // 两者都没有时无法比对，按“未发现重复”继续真实上传，由平台决定能否创建；
                // 只有检索命中重复才停止，避免用名称、SPU 或 SKU ID 猜测同款。
                if (!targetProductCodes.size && !targetSkuCodes.size && !legacyExtCodes.size) {
                    return { state: 'not_found', scanned: 0, pages: 0, queryMode: 'no_code' };
                }
                // 分页字段名随页面版本变化，用第一页确认哪一种可用，后续沿用同一种，绝不中途换形。
                let pageKey = '';
                let rows = null;
                for (const key of ['page', 'pageNum', 'pageNumber']) {
                    try {
                        const candidate = readRows(await client.post(QUERY_PATH, { [key]: 1, pageSize: PAGE_SIZE }));
                        if (candidate) { pageKey = key; rows = candidate; break; }
                    } catch (_) { /* 该字段名不被当前版本接受时换下一种。 */ }
                }
                if (!pageKey) throw Error('商品检索接口无响应或返回结构未知');
                const seenPages = new Set();
                let scanned = 0;
                let pages = 0;
                // 以“出现空页”作为唯一终止条件，不依赖 pageSize 是否被服务端采纳，避免被悄悄截断成第一页。
                for (;;) {
                    if (!rows.length) break;
                    const signature = rows.map(row => String(row.productId || row.spuId || row.goodsId || row.productName || row.productTitle || row.name || '')).join(',');
                    if (signature.replace(/,/g, '') && seenPages.has(signature)) return { state: 'uncertain', scanned, pages, reason: '商品检索分页重复，无法确认目标商品是否已存在' };
                    if (signature.replace(/,/g, '')) seenPages.add(signature);
                    for (const row of rows) { const hit = matchRow(row); if (hit) return hit; }
                    scanned += rows.length;
                    pages += 1;
                    if (pages >= MAX_PAGES) return { state: 'uncertain', scanned, pages, reason: '商品检索超过分页上限，无法确认目标商品是否已存在' };
                    rows = readRows(await client.post(QUERY_PATH, { [pageKey]: pages + 1, pageSize: PAGE_SIZE }));
                    if (!rows) throw Error('商品检索分页返回结构未知');
                }
                return { state: 'not_found', scanned, pages };
            }, args: [payload] });
            const pageError = directPageError(entry);
            if (pageError) throw Error(pageError);
            return entry.result;
        } catch (error) {
            lastError = error;
            if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 800));
        }
    }
    throw lastError || Error('商品重复检索失败');
}
async function directPage(tabId,operation,payload={}){
    const execute = async () => chrome.scripting.executeScript({target:{tabId},world:'MAIN',func:async(operation,payload)=>{
        /** 页面侧错误文本：平台失败对象没有 message，必须按语义字段取值，避免只留下 "[object Object]"。 */
        const pageErrorText = (value, limit = 800) => {
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
        if(operation==='prepare'){
            if(typeof window.__temuDirectFingerprint!=='function')throw Error('页面指纹脚本未就绪，请刷新商品列表页');
            const p=await window.__temuDirectPrepare(payload.source);
            // 目标店”要哪些必填项”由平台回答，本地不再拦截：本地猜规则一旦比平台严，就会造出
            // 平台上并不存在的失败（如把条件必填当无条件必填）。可疑项只作为备注带回排查。
            const prepareNotes=[...(Array.isArray(p.notes)?p.notes:[]),...(Array.isArray(p.warnings)?p.warnings:[])];
            /**
             * 一致性检查只做记录，不再阻断上传。
             * 它核对的是”服务端拉来的来源资料”与”生成的请求”是否一致（货号/规格/价格/净含量/成分有没有在转换中丢失），
             * 属于插件自身该负责的传输完整性；但即便发现不一致，也不能替平台决定商品不能上传，
             * 否则平台能创建的商品会被我们自己的检查判成失败。不一致写进备注，由平台结果说话。
             */
            let integrityNote='';
            try{ window.__temuDirectCheck(payload.source,p.request); }
            catch(checkError){ integrityNote=`提交前一致性检查未通过（已照常提交，请核对）：${directErrorText(checkError,200)}`; }
            const protocol=p.request.productComplianceStatementReq;
            if(protocol?.protocolVersion!=='V2.0'||protocol.protocolUrl!=='https://dl.kwcdn.com/seller-public-file-us-tag/2079f603b6/56888d17d8166a6700c9f3e82972e813.html')throw Error('平台合规声明变化');
            // 转换器生成的规格字段是带 toJSON 的类数组实例：JSON 序列化正常，但 structuredClone 会丢掉内容
            // （chrome.scripting 回传和 chrome.storage 都走 structuredClone）。
            // 回查阶段用的是从扩展存储读回的请求副本，规格一旦丢失就会误报“规格对应关系不唯一”，
            // 因此必须在请求离开页面前就用 JSON 往返规范化成真数组，让两条路径拿到同一份数据。
            const request=JSON.parse(JSON.stringify(p.request));
            const fingerprint=await window.__temuDirectFingerprint(request);
            // 页面内留一份规范化后的请求原件：提交时优先复用同一对象，避免请求经扩展存储/消息边界往返后被重新序列化。
            window.__temuDirectPreparedRequests=window.__temuDirectPreparedRequests||Object.create(null);
            if(payload.prepareKey)window.__temuDirectPreparedRequests[payload.prepareKey]=request;
            // 目标店要求的字段（备货区域、生产地）由插件补齐时把结论带回后台，运营才能看到实际提交了什么。
            if(integrityNote)prepareNotes.push(integrityNote);
            return {request,hash:fingerprint.hash,hashLength:fingerprint.length,notes:prepareNotes};
        }
        if(operation==='submit'){
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
                    // 同一次页面会话内直接使用生成时的对象；只有页面刷新导致内存副本丢失时，才退回扩展存储里的副本。
                    const prepared=window.__temuDirectPreparedRequests?.[payload.requestKey];
                    const request=prepared||payload.request;
                    // 指纹基于规范化请求内容，跨扩展存储/消息边界往返后仍然可比；长度差异用于区分“结构变化”和“顺序差异”。
                    const fingerprint = await window.__temuDirectFingerprint(request);
                    if (payload.requestHash && fingerprint.hash !== String(payload.requestHash)) {
                        throw Error(`提交前请求指纹变化（长度 ${fingerprint.length}/${Number(payload.requestHashLength)||0}）`);
                    }
                    const result=await client.post('/visage-agent-seller/product/add',request),productId=String(result?.productId||'');
                    if(!/^\d{6,20}$/.test(productId)) throw Error('新增响应没有商品ID');
                    const completed = { state: 'created', productId, at: Date.now() };
                    window.__temuDirectSubmitStates[key] = completed;
                    sessionStorage.setItem(key, JSON.stringify(completed));
                } catch (error) {
                    // 平台校验失败抛出的是普通对象（success:false/errorCode/errorMsg），属于确定性拒绝：商品没有创建，
                    // 不能写成“结果待核对”，否则插件会反复重试且运营看不出真实原因。
                    // 但“系统异常/限流/超时”是临时故障，重试就能好，必须与内容错误区分开，
                    // 否则一件资料完好的商品会因为平台抖动被标红、要求运营重新采集。
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
                    const failed = { state: definitive ? 'rejected' : 'unknown', error: readable, errorCode: rawCode ?? null, transient, at: Date.now() };
                    window.__temuDirectSubmitStates[key] = failed;
                    sessionStorage.setItem(key, JSON.stringify(failed));
                }
            })();
            return { started: true };
        }
        if(operation==='verify'){
            // 商品ID由平台在创建时随机生成，每个店铺都不一样，不能作为“是不是同一件商品”的依据，
            // 否则会把已经创建成功的商品误判成回查不匹配。回查只按设置好的内容确认：
            // 商品名称 + 内容完整性检查（SKU 数量与货号、主图数量、价格、缩略图、净含量、成分）。
            // 两侧都要 JSON 规范化：平台回查响应同样可能带 toJSON 类数组，若只规范一侧会造成假差异。
            const saved=JSON.parse(JSON.stringify(await client.post('/visage-agent-seller/product/query',{productId:payload.productId})));
            const request=JSON.parse(JSON.stringify(payload.request));
            if(!saved||typeof saved!=='object')throw Error('回查没有返回商品');
            if(String(saved.productName||'')!==String(request.productName||''))throw Error('回查商品名称不一致');
            window.__temuDirectCheck(saved,request);return {verified:true};
        }
        throw Error('不支持的操作');
        } catch (error) {
            // 页面异常改为正常返回值，避免 chrome.scripting 在不同 Chromium 版本下丢弃 exceptionDetails，
            // 让后台只能看到空 result 并误报“页面注入未返回结果”。
            return {
                __temuDirectPageError: pageErrorText(error),
                __temuDirectPageErrorCode: error && typeof error === 'object' ? (error.errorCode ?? error.code ?? null) : null
            };
        }
    },args:[operation,payload]});
    let lastError = null;
    // 页面切换/Frame 重建只允许在只读阶段有限重试；submit 阶段绝不重试，避免重复创建。
    const attempts = operation === 'submit' ? 1 : 2;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const [entry] = await execute();
            const pageError = directPageError(entry);
            if (!pageError) return entry.result;
            lastError = Error(`${operation}: ${pageError}`);
        } catch (error) {
            lastError = error;
        }
        if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 600));
    }
    let tabUrl = '';
    try { tabUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (_) {}
    throw Error(`${lastError?.message || '页面未返回结果'}（阶段=${operation}，页面=${tabUrl || '未知'}）`);
}
/** 真实商城ID采用独立命名空间，不能把紫鸟账号ID当成商城ID。 */
async function directIdentity(sender,identity){
    if(!sender.tab?.id)throw Error('缺少页面');
    let hostname = '';
    try { hostname = new URL(sender.tab.url || '').hostname; } catch (_) {}
    // 只有卖家中心页面拥有可信商城运行时；其他 temu 子域即使注入了脚本也不能参与店铺绑定。
    if (hostname !== 'agentseller.temu.com') throw Error('unsupported_page');
    const {mallId}=await directPage(sender.tab.id,'identity');
    return {...identity,storeId:`temu:${mallId}`,mallId,identityMatched:true,executionMode:'plugin-api'};
}
/** 从来源快照提取跨店判重所需的货号集合；不把来源店内部 ID、商品名称当成目标店主键。 */
function directSnapshotSource(snapshot) {
    const source = snapshot?.publicationData?.sourceProduct;
    if (!source || typeof source !== 'object') return null;
    const merged = JSON.parse(JSON.stringify(source));
    const properties = Array.isArray(merged.productPropertyList) ? merged.productPropertyList : [];
    const attributes = Array.isArray(snapshot.attributes) ? snapshot.attributes : [];
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
function directComparePayload(skcs, skuKey = "productSkuList") {
    const sourceSkcs = Array.isArray(skcs) ? skcs : [];
    const productCodes = sourceSkcs
        .map(skc => String(skc?.extCode || skc?.skcExtCode || '').trim())
        .filter(Boolean);
    const skuCodes = productCodes.length
        ? []
        : sourceSkcs.flatMap(skc => (Array.isArray(skc?.[skuKey]) ? skc[skuKey] : [])
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
 * 从已授权的创建请求里取出实际提交的货号。
 * 详情回查失败时用同一批货号回目标店列表确认商品是否已经创建；这批货号在提交前刚刚确认过不存在，
 * 因此它现在出现在目标店即可判定是本次创建的结果，不依赖平台随机生成的 productId。
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
/** 把插件确认的“已存在/批次内重复”写成服务器终态，防止任务下次心跳再次领取。 */
async function reportDirectPreflightSkipped(task, identity, reason) {
    await hubJson('/api/jobs/direct-progress', {
        storeId: identity.storeId,
        storeName: identity.storeName || identity.pageStoreName || '',
        pageStoreName: identity.pageStoreName || '',
        pluginInstanceId: await getPluginInstanceId(),
        pluginVersion: chrome.runtime.getManifest().version,
        jobId: task.jobId,
        spuId: task.spuId,
        claimToken: task.claimToken,
        phase: 'preflight_failed',
        reason: String(reason || '').slice(0, 800)
    });
}
/**
 * 只做目标店重复预检和本地请求准备，不占用服务器创建许可。
 * 预检结果写入后台后，主循环再按店铺串行提交，避免同店并发写入。
 */
async function prepareDirectTask(task, identity, tabId, key, reservedCodes = new Set()) {
    const source = directSnapshotSource(task.snapshot);
    if (String(source?.productId) !== task.spuId) throw Error('缺少来源完整资料');
    const compare = directSourceComparePayload(source, identity);
    const codes = directCompareKeys(compare);
    // 同一批次内出现重复货号（有商品货号按商品货号、没有才按 SKU 货号）时，只上传第一件，后面的直接跳过。
    // 这不属于"目标店判重"，而是批次内自我去重，因此不受测试版跳过目标店检索的开关影响。
    if (codes.some(code => reservedCodes.has(code))) {
        const reason = '同一批次已有相同货号，本件跳过，避免批次内重复创建';
        await chrome.storage.local.set({ [key]: { stage: 'duplicate_exists', done: true, retrySequence: directTaskRetrySequence(task) } });
        await rememberDirectProgress(task, { directState: 'duplicate_exists', reason, status: 'received' }, tabId);
        await TemuOperationLog.append({ action: 'direct-create', status: 'skipped', jobId: task.jobId, spuId: task.spuId, phase: 'duplicate_exists', reason });
        await reportDirectPreflightSkipped(task, identity, reason).catch(() => {});
        return { kind: 'duplicate_batch', codes: [] };
    }
    // 无货号商品没有任何可比对主键，按 SPU 记录保留位，避免同一件商品被重复排入同一批。
    if (!codes.length) reservedCodes.add(`spu\u0000${task.spuId}`);
    for (const code of codes) reservedCodes.add(code);
    try {
        await rememberDirectProgress(task, { directState: 'authorizing', reason: `正在对比目标店货号，SPU ${task.spuId}`, status: 'received' }, tabId);
        const duplicate = await directDuplicateCheck(tabId, compare);
        if (duplicate.state === 'exists') {
            const matchedLabel = duplicate.matchedBy === 'skuExtCode' ? 'SKU货号' : '商品货号';
            const reason = `目标店已存在商品 ${duplicate.productId || task.spuId}，按${matchedLabel}确认，未创建`;
            await chrome.storage.local.set({ [key]: { stage: 'duplicate_exists', done: true, retrySequence: directTaskRetrySequence(task) } });
            await rememberDirectProgress(task, { directState: 'duplicate_exists', reason, status: 'received' }, tabId);
            await TemuOperationLog.append({ action: 'direct-create', status: 'skipped', jobId: task.jobId, spuId: task.spuId, phase: 'duplicate_exists', reason });
            await reportDirectPreflightSkipped(task, identity, reason).catch(() => {});
            return { kind: 'duplicate_exists', codes };
        }
        if (duplicate.state !== 'not_found') throw Error(duplicate.reason || '目标店是否已有该商品无法确认，未创建');
        // 无货号时没有任何可比对的主键（queryMode=no_code），如实写"无货号无法比对"，不能谎称已按货号确认。
        const compareLabel = duplicate.queryMode === 'skipped_for_testing'
            ? '测试版已跳过目标店重复检索，未判重直接创建'
            : (duplicate.queryMode === 'no_code'
                ? '无货号可比对，未发现重复，继续上传'
                : `${compare.compareMode === 'sku' ? 'SKU货号' : '商品货号'}对比确认不存在，查询方式 ${duplicate.queryMode || '分页兜底'}，扫描 ${Number(duplicate.scanned) || 0} 个商品`);
        await TemuOperationLog.append({ action: 'direct-create', status: 'checked', jobId: task.jobId, spuId: task.spuId, phase: 'duplicate_check', reason: compareLabel });
        const prepared = await directPage(tabId, 'prepare', { source, mallId: identity.mallId, prepareKey: key });
        const record = { stage: 'authorizing', request: prepared.request, hash: prepared.hash, hashLength: prepared.hashLength, authorizationKey: crypto.randomUUID(), mallId: identity.mallId, retrySequence: directTaskRetrySequence(task) };
        await chrome.storage.local.set({ [key]: record });
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
/** 授权与提交阶段持久化；同一 attempt 只补报或回查，不重发新增。 */
async function runDirectTasks(tabId,identity){
    // 锁必须按标签页隔离：A 店正在创建时不能挡住 B 店自动创建。
    if(directRunningTabs.has(tabId)){
        // 心跳可能在上一轮仍执行时到达；记住最新身份，上一轮结束后补跑，避免批量任务丢唤醒。
        directRerunTabs.set(tabId, identity);
        return;
    }
    if(!tabId||!identity.storeId)return;
    // 停止标记优先于任何页面操作：刷新页面后由心跳再次进入也不能绕过。
    if(directStopRequested.has(identity.storeId)||await readDirectPause(identity.storeId)){directRerunTabs.delete(tabId);return;}
    directRunningTabs.add(tabId);
    try{
        await chrome.scripting.executeScript({target:{tabId},world:'MAIN',files:['direct-adapter.js','direct-fingerprint.js']});
        const tasks = (await getTargetUploadTasks()).filter(t => t.directCreate && t.targetStoreId === identity.storeId);
        const reservedCodes = new Set();
        const candidates = [];
        for (const task of tasks) {
            const key = `directAttempt:${task.jobId}:${task.spuId}`;
            const record = await directAttemptRecord(task,key);
            if (!record && task.directState !== 'unknown') candidates.push({ task, key });
        }
        const preflightPromises = new Map();
        let nextCandidate = 0;
        const startCandidate = () => {
            const candidate = candidates[nextCandidate++];
            if (!candidate) return false;
            const promise = prepareDirectTask(candidate.task, identity, tabId, candidate.key, reservedCodes)
                .then(result => ({ result }))
                .catch(error => ({ error }));
            preflightPromises.set(candidate.key, promise);
            return true;
        };
        for (let i = 0; i < DIRECT_PREFLIGHT_CONCURRENCY; i += 1) startCandidate();
        /** 停止是协作式的：页面内已发出的新增请求无法撤回，所以只在“开下一件”和“申请新授权”两个安全点生效。 */
        const stopPending = async () => directStopRequested.has(identity.storeId) || Boolean(await readDirectPause(identity.storeId));
        let stopped = false;
        for(const task of tasks){
            // 每件商品开始前先看停止标记，避免停止后仍继续对比、预检下一件。
            if(await stopPending()){stopped=true;break;}
            const key=`directAttempt:${task.jobId}:${task.spuId}`;let record=await directAttemptRecord(task,key);if(record?.done)continue;
            if (preflightPromises.has(key)) {
                const outcome = await preflightPromises.get(key);
                preflightPromises.delete(key);
                startCandidate();
                if (outcome.error) {
                    const readable = directErrorText(outcome.error);
                    // 预检发生在任何新增请求之前，失败后没有平台副作用；落终态是为了阻止心跳无限重复失败。
                    // 人工重试入口会删除该键，因此这里不牺牲确定性错误后的恢复能力。
                    await chrome.storage.local.set({ [key]: { stage: 'preflight_failed', done: true, businessError: readable, retrySequence: directTaskRetrySequence(task) } });
                    await TemuOperationLog.append({ action: 'direct-create', status: 'failed', jobId: task.jobId, spuId: task.spuId, phase: 'preflight', error: readable });
                    await rememberDirectProgress(task, { directState: 'preflight_failed', reason: readable.slice(0, 240), status: 'received' }, tabId);
                    // 服务端任务必须落成 failed，否则页面会一直显示“已接收、正在排队”，运营看不到真实失败原因。
                    await reportDirectPreflightSkipped(task, identity, readable).catch(() => {});
                    continue;
                }
                if (outcome.result?.kind === 'duplicate_exists' || outcome.result?.kind === 'duplicate_batch') continue;
                record = await directAttemptRecord(task,key);
            }
            // 已回查成功的任务不能因心跳再次进入新增。
            if(task.directState==="created")continue;
            // 结果未知必须隔离：请求可能已被平台受理，禁止心跳自动复核/重发，避免两个商品变成三个创建尝试。
            if(task.directState==="unknown"||record?.stage==="unknown"){
                await rememberDirectProgress(task,{directState:'unknown',reason:'结果未知，未自动重发；请先核对目标店商品后人工确认重试',status:'received'},tabId);
                continue;
            }
            const base={...identity,pluginInstanceId:await getPluginInstanceId(),jobId:task.jobId,spuId:task.spuId,claimToken:task.claimToken};
            const report=extra=>hubJson('/api/jobs/direct-progress',{...base,...extra});
            try{
                if(!record){
                    const source=directSnapshotSource(task.snapshot);if(String(source?.productId)!==task.spuId)throw Error('缺少来源完整资料');
                    // 检索要翻完目标店全部分页，先给出可见状态，避免操作者以为点击没有反应。
                    await rememberDirectProgress(task,{directState:"authorizing",reason:`正在检索目标店是否已存在 SPU ${task.spuId}，请保持商品列表页打开`,status:"received"},tabId);
                    const duplicate = await directDuplicateCheck(tabId, directSourceComparePayload(source, identity));
                    if (duplicate.state === 'exists') {
                        // 仅凭列表检索不能伪造 created 回执：用 preflight_failed 上报可读原因，并留下终态标记避免反复重扫。
                        const existsReason = `目标店已存在商品 ${duplicate.productId || task.spuId}，插件检索确认，未重复创建`;
                        await chrome.storage.local.set({ [key]: { stage: 'duplicate_exists', done: true, retrySequence: directTaskRetrySequence(task) } });
                        await rememberDirectProgress(task, { directState: 'duplicate_exists', reason: existsReason, status: 'received' }, tabId);
                        await TemuOperationLog.append({ action: 'direct-create', status: 'skipped', jobId: task.jobId, spuId: task.spuId, phase: 'duplicate_exists' });
                        await report({ phase: 'preflight_failed', reason: existsReason }).catch(() => {});
                        continue;
                    }
                    // 检索失败或分页不完整时无法证明目标店没有该商品，按结果未知停下，不允许进入创建。
                    if (duplicate.state !== 'not_found') throw Error(duplicate.reason || '目标店是否已有该商品无法确认，未创建');
                    await TemuOperationLog.append({action:"direct-create",status:"checked",jobId:task.jobId,spuId:task.spuId,phase:"duplicate_check",reason:`重复检索确认不存在，已扫描 ${Number(duplicate.scanned)||0} 个商品`});
                    const p=await directPage(tabId,'prepare',{source,mallId:identity.mallId,prepareKey:key});
                    record={stage:'authorizing',request:p.request,hash:p.hash,hashLength:p.hashLength,authorizationKey:crypto.randomUUID(),mallId:identity.mallId,retrySequence:directTaskRetrySequence(task)};await chrome.storage.local.set({[key]:record});
                    await TemuOperationLog.append({action:"direct-create",status:"started",jobId:task.jobId,spuId:task.spuId,phase:"prepare"});
                    await rememberDirectProgress(task,{directState:"authorizing",reason:`正在预检并创建 SPU ${task.spuId}，请保持商品列表页打开`,status:"received"},tabId);
                }
                if(record.mallId!==identity.mallId)throw Error('任务商城变化');
                if(record.stage==='authorizing'){
                    // 提交授权是最后一个安全点：此刻点停止就不再申请新的创建许可，也不会发出新增请求。
                    if(await stopPending()){stopped=true;break;}
                    const permit=await report({phase:'begin',requestHash:record.hash,mallId:record.mallId,authorizationKey:record.authorizationKey,duplicateCheck:'not_found'});
                    record.attemptId=permit.attemptId;record.stage=permit.resumed?'unknown':'submitting';await chrome.storage.local.set({[key]:record});
                    if(!permit.resumed){
                        await directPage(tabId,'submit',{attemptId:record.attemptId,mallId:record.mallId,requestHash:record.hash,requestHashLength:record.hashLength,requestKey:key,request:record.request});
                        let result = null; let statusError = '';
                        // 轮询页面持久化状态；页面短暂刷新时只等待，不重新发起新增请求。
                        for (let i = 0; i < 60; i += 1) {
                            try { result = await directPage(tabId, 'submit-status', { attemptId: record.attemptId }); statusError = ''; } catch (error) { result = null; statusError = directErrorText(error, 240); }
                            if (result?.state === 'created' || result?.state === 'unknown' || result?.state === 'rejected') break;
                            await new Promise(resolve => setTimeout(resolve, 500));
                        }
                        // 平台临时故障（系统异常/限流/超时）不代表商品有问题：同一份资料稍后重试就能成功。
                        // 这里必须先于“确定性拒绝”处理，否则一件资料完好的商品会被判失败并要求运营重新采集。
                        if (result?.transient) {
                            record.stage = 'transient_failed';
                            record.transientError = result.error || '';
                            await chrome.storage.local.set({ [key]: record });
                            await TemuOperationLog.append({ action: 'direct-create', status: 'retry_wait', jobId: task.jobId, spuId: task.spuId, phase: 'transient', reason: `平台临时故障，稍后自动重试：${String(result.error || '').slice(0, 160)}` });
                            await rememberDirectProgress(task, { directState: 'transient', reason: `平台临时故障，稍后自动重试：${String(result.error || '').slice(0, 120)}`, status: 'received' }, tabId);
                            // 由服务端决定是否还有自动重试额度：额度用尽会把项目落成终态并标红，插件不自行判断。
                            const retryReply = await report({ phase: 'transient', attemptId: record.attemptId, reason: String(result.error || '').slice(0, 800) }).catch(() => null);
                            // 本地记录必须清掉，否则下一次重试会被旧的 done/attempt 记录挡住。
                            if (retryReply && retryReply.state === 'retry_wait') await chrome.storage.local.remove(key);
                            continue;
                        }
                        // 超时或状态不可读时把最后一次真实原因带出来，避免只看到“待核对”而无法定位。
                        if (result?.state !== 'created') {
                            const failure = Error(`${result?.error || '提交结果待核对，禁止自动重发'}${statusError ? `；读取提交状态失败：${statusError}` : ''}`.slice(0, 800));
                            // 平台明确拒绝时商品确定没有创建，标记为确定性失败，避免进入自动复核循环。
                            if (result?.state === 'rejected') failure.definitive = true;
                            throw failure;
                        }
                        record.productId = result.productId; record.stage='verifying'; await chrome.storage.local.set({[key]:record});
                    }
                }
                await rememberDirectProgress(task,{directState:record.stage==="verifying"?"verifying":record.stage,reason:record.stage==="verifying"?`已提交 SPU ${task.spuId}，正在回查商品ID`:`正在授权创建 SPU ${task.spuId}`,status:"received"},tabId);
                if(record.productId){
                    let verifyReason = '插件接口创建并回查成功';
                    // 提交成功后 Temu 会刷新商品列表页，详情回查可能正好落在文档重载或路由切换的瞬间拿不到结果。
                    // 这里在有限时间窗和次数内重试，并用提交时同一批货号回列表确认；两者都用尽仍按结果未知停下，绝不重发新增。
                    const verifyCompare = directRequestComparePayload(record.request);
                    const verifyHasCodes = verifyCompare.productCodes.length > 0 || verifyCompare.skuCodes.length > 0;
                    const verifyDeadline = Date.now() + DIRECT_VERIFY_WINDOW_MS;
                    let verifyFailure = null;
                    for (let verifyAttempt = 1; verifyAttempt <= DIRECT_VERIFY_MAX_ATTEMPTS; verifyAttempt += 1) {
                        try {
                            await directPage(tabId,'verify',{mallId:record.mallId,productId:record.productId,request:record.request});
                            verifyFailure = null;
                            break;
                        } catch (verifyError) {
                            verifyFailure = verifyError;
                            // 列表按货号确认：这批货号提交前刚确认不存在，现在能查到就说明本次创建已经落到目标店。
                            // 列表查不到、分页不完整或商品没有货号都保持未知，禁止把不确定结果当成成功。
                            // 创建后的回查确认必须真实检索：它是判断"商品有没有创建成功"的依据，
                            // 不能被测试跳过开关影响，否则创建成功也会因查不到而停在结果未知。
                            const listed = verifyHasCodes
                                ? await directDuplicateCheck(tabId, { mallId: record.mallId, ...verifyCompare }, { force: true }).catch(() => null)
                                : null;
                            if (listed?.state === 'exists') {
                                // 把回查的真实原因一并写进结论：可能是页面重载拿不到结果，也可能是内容比对不通过
                                // （SKU 数量、主图数量、价格、净含量、成分）。运营据此区分“只是没读到”和“确实有内容差异”。
                                verifyReason = `插件接口已创建，已按货号在目标店列表确认存在（商品 ${listed.productId || record.productId}）；详情回查未通过：${directErrorText(verifyError, 200)}`;
                                verifyFailure = null;
                                break;
                            }
                            if (Date.now() >= verifyDeadline) break;
                            await new Promise(resolve => setTimeout(resolve, DIRECT_VERIFY_RETRY_MS));
                        }
                    }
                    // 平台已经返回商品ID，说明创建成功；我们的回查一致性检查失败只记备注，不能改判成失败。
                    // 回查查不到通常只是页面刷新的读取时机问题（列表确认那条分支已覆盖），
                    // 若这里抛错，平台明明创建成功的商品会被标红、被禁止再传，运营还得去重抓一件好商品。
                    if (verifyFailure) {
                        verifyReason = `插件接口已创建（商品 ${record.productId}），但回查未通过，请人工核对：${directErrorText(verifyFailure, 200)}`;
                    }
                    await report({phase:'created',attemptId:record.attemptId,productId:record.productId,verified:true,reason:`${verifyReason}；不代表审核上架`});record.done=true;record.stage='created';delete record.request;
                    await TemuOperationLog.append({action:"direct-create",status:"succeeded",jobId:task.jobId,spuId:task.spuId,phase:"created"});
                    await rememberDirectProgress(task,{directState:"created",reason:`${verifyReason}；请到目标店商品列表核对，不等于审核上架`,status:"received"},tabId);
                }else{await report({phase:'unknown',attemptId:record.attemptId,reason:'提交结果待核对，禁止自动重发'});record.stage='unknown';
                    await rememberDirectProgress(task,{directState:"unknown",reason:"提交结果待核对，禁止自动重发",status:"received"},tabId);
                }
                await chrome.storage.local.set({[key]:record});
            }catch(error){
                const readable=directErrorText(error);
                // 确定性拒绝（平台校验失败）表示商品确定没有创建，必须停在“预检失败”并写明原因，
                // 不能走“结果待核对 → 自动复核重试”，否则只会反复撞同一个平台校验错误。
                const definitive=error?.definitive===true;
                await TemuOperationLog.append({action:'direct-create',status:'failed',jobId:task.jobId,spuId:task.spuId,error:readable});
                const failedState=definitive?"preflight_failed":(record?.attemptId?"unknown":"preflight_failed");
                if(definitive){
                    record={...(record||{}),stage:'rejected',done:true,businessError:readable};
                    await chrome.storage.local.set({[key]:record});
                }
                await rememberDirectProgress(task,{directState:failedState,reason:readable.slice(0,240),status:"received"},tabId);
                if(record?.attemptId&&!definitive)await report({phase:'unknown',attemptId:record.attemptId,productId:record.productId||'',reason:readable.slice(0,800)}).catch(()=>{});
                // 带上 attemptId：服务端据此把“当前尝试被平台明确拒绝”记为终态并写入平台原文；
                // 缺少它时，已授权过的任务会被当成重复提交而丢掉真实原因。
                else if(!record||definitive)await report({phase:'preflight_failed',attemptId:record?.attemptId||'',reason:readable.slice(0,800)}).catch(()=>{});continue;
            }
            if(!record.done)continue;
        }
        // 停止后留一条可核对的结论：运营需要知道停止生效在哪个位置，以及还有多少件没动。
        if(stopped)await TemuOperationLog.append({action:'direct-create',status:'skipped',storeId:identity.storeId,phase:'stopped',
            reason:`操作者已停止接口创建：本轮不再处理剩余 ${tasks.length} 件中的未完成商品，已发出的提交无法撤回`});
    }catch(error){
        const tasks=(await getTargetUploadTasks()).filter(t=>t.directCreate&&t.targetStoreId===identity.storeId);
        const task=tasks[0];
        const readable=directErrorText(error);
        await TemuOperationLog.append({action:"direct-create",status:"failed",storeId:identity.storeId,error:readable});
        if(task)await rememberDirectProgress(task,{directState:"preflight_failed",reason:readable.slice(0,240),status:"received"},tabId);
    }finally{
        directRunningTabs.delete(tabId);
        const rerunIdentity = directRerunTabs.get(tabId);
        if (rerunIdentity) {
            directRerunTabs.delete(tabId);
            queueMicrotask(() => runDirectTasks(tabId, rerunIdentity).catch(error => {
                TemuOperationLog.append({ action: 'direct-create', status: 'failed', storeId: rerunIdentity.storeId, error: directErrorText(error) }).catch(() => {});
            }));
        }
    }
}
