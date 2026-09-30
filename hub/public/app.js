/**
 * 中转仓前端。主流程是查验台、商品库和任务台；旧探测页仍可通过链接打开，但不作为派发入口。
 * 页面数字必须区分：文件数、响应数、SPU、goodsId、SKC、SKU，避免再混成一个“商品数”。
 */
const app = document.getElementById("app");

/**
 * 商品库的单商品/批量上传和库存删除进行中时冻结自动刷新，避免重绘打断正在提交的任务。
 * 标记由各自的提交流程写入，自动刷新控制器只读。
 */
let singleUploadBusy = false;
let batchUploadBusy = false;
let storeClaimBusy = false;

/**
 * 商品库使用真正的页码分页，并把跨页勾选保存在稳定商品 ID 上。
 * 页面重绘、切换页码或修改每页数量时，浏览器不能再从当前 DOM 反推批量选择，
 * 否则前面页面已选商品会在最终上传时静默丢失。
 */
const PRODUCT_PAGE_SIZE_OPTIONS = [20, 50, 100];
let catalogProductPage = 1;
let catalogProductPageSize = PRODUCT_PAGE_SIZE_OPTIONS[0];
let catalogSelectedProducts = new Map();
let catalogSelectedBatches = new Map();
// 输入草稿不参与请求，只有提交搜索后才更新查询条件，翻页和自动刷新沿用已提交条件。
const catalogFilters = { q: "", draft: "", sourceStoreId: "", blocked: "" };
const storeViews = {
    online: { page: 1, size: 20, q: "", draft: "", online: "", claimState: "" },
    mine: { page: 1, size: 20, q: "", draft: "", online: "", claimState: "" }
};
const selectedClaimStores = new Map();
let activeClaimView = "online";
let storePageBusy = false;
let catalogPageLoading = false;
let catalogPageLoadVersion = 0;
// 当前商品页独立接收增量更新；离开页面即失效，后台通知不得接管导航。
let refreshCatalogView = null;
// 店铺连接状态独立于商品重绘，勾选商品和打开目标店弹窗不能冻结在线目录。
let refreshCatalogTargets = null;
let refreshTaskPanels = null;
let viewInteractionVersion = 0;
for (const type of ["pointerdown", "keydown", "input", "change"]) {
    app.addEventListener(type, (event) => { if (event.isTrusted) viewInteractionVersion += 1; }, true);
}

/** 商品请求始终使用已提交的条件，避免未点击搜索的草稿被翻页带入。 */
function catalogPageUrl(page = catalogProductPage) {
    const params = new URLSearchParams({ productLimit: String(catalogProductPageSize), productOffset: String((page - 1) * catalogProductPageSize) });
    if (catalogFilters.q) params.set("productQ", catalogFilters.q);
    if (catalogFilters.sourceStoreId) params.set("sourceStoreId", catalogFilters.sourceStoreId);
    if (catalogFilters.blocked) params.set("blocked", catalogFilters.blocked);
    return `/temu/api/overview?${params}`;
}

/** 店铺两类列表独立保存分页和搜索，自动刷新不得回退到第一页或提交输入草稿。 */
function claimStorePageUrl(view, state = storeViews[view]) {
    const params = new URLSearchParams({ view, limit: String(state.size), offset: String((state.page - 1) * state.size) });
    for (const key of ["q", "online", "claimState"]) if (state[key]) params.set(key, state[key]);
    return `/temu/api/stores?${params}`;
}

/** 认领或删除使总页数缩小时，再请求有效末页，不能只修改页码而留下空列表。 */
async function fetchClaimStorePage(view, state, options = {}) {
    let page = await api(claimStorePageUrl(view, state), options);
    const lastPage = Math.max(1, Math.ceil((Number(page.total) || 0) / state.size));
    if (state.page > lastPage) {
        state.page = lastPage;
        page = await api(claimStorePageUrl(view, state), options);
    }
    return page;
}

/** 紧凑页码下拉不随页数横向扩张，商品库和店铺认领共用同一操作顺序。 */
function renderInlinePagination(prefix, page, size, total, label) {
    const pages = Math.max(1, Math.ceil(total / size));
    return `<div class="catalog-pagination catalog-pagination-inline" id="${prefix}-pagination" aria-label="${label}分页">
        <label class="catalog-page-size">每页<select id="${prefix}-page-size" aria-label="每页${label}数量">${PRODUCT_PAGE_SIZE_OPTIONS.map(value => `<option value="${value}"${value === size ? " selected" : ""}>${value}</option>`).join("")}</select></label>
        <div class="catalog-page-controls"><button type="button" class="catalog-page-button" id="${prefix}-page-prev"${page <= 1 ? " disabled" : ""}>上页</button><select class="catalog-page-select" id="${prefix}-page-buttons" aria-label="${label}页码">${Array.from({ length: pages }, (_, index) => `<option value="${index + 1}"${index + 1 === page ? " selected" : ""}>${index + 1} / ${pages}</option>`).join("")}</select><button type="button" class="catalog-page-button" id="${prefix}-page-next"${page >= pages ? " disabled" : ""}>下页</button></div>
        <span class="catalog-page-status visually-hidden" id="${prefix}-page-status" aria-live="polite">共 ${total} 个${label}</span>
    </div>`;
}

/** 离开商品库时清除跨页选择，避免用户下次进入时看到不可见但会被上传的商品。 */
function clearCatalogProductSelection() {
    catalogSelectedProducts.clear();
    catalogSelectedBatches.clear();
}

/** 服务器上仍未结束的商品项状态；接口任务只要停在这些状态就会一直占住同店同货号。 */
const ACTIVE_ITEM_STATUSES = new Set(["queued", "opening", "opened", "claimed", "received", "upload_opened", "plugin_missing", "retry_wait"]);
/** 服务器允许人工重置的接口任务状态，与 job-queue 的 directRetry 保持一致。 */
const DIRECT_RETRYABLE_STATES = ["unknown", "preflight_failed", "rejected"];
/** 提交中断必须等静默窗口结束才允许重置，阈值与服务器 DIRECT_STALE_MS 相同。 */
const DIRECT_STALE_MS = 10 * 60 * 1000;
/** 接口任务商品项的状态文案；与服务器状态机一一对应，避免运营把“结果未知”当成已失败。 */
const DIRECT_ITEM_LABEL = {
    creating: "接口创建中",
    unknown: "结果待核对（禁止重发）",
    created: "已创建（不等于审核上架）",
    rejected: "平台拒绝（未创建）",
    preflight_failed: "预检失败（未提交）",
    duplicate_exists: "目标店已存在（未重复创建）"
};

/**
 * 工作日志按上海时区显示，避免把 UTC 的 Z 去掉后看起来像停在早上的旧时间。
 */
function formatWorkLogTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value || "");
    const parts = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${pick("year")}-${pick("month")}-${pick("day")} ${pick("hour")}:${pick("minute")}:${pick("second")}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

/**
 * 工作日志按店铺分组。每条记录保留来源与目标店，方便在目标店时间线里追溯商品从哪里发来。
 */
function groupWorkLogEntries(entries) {
    const groups = [];
    const index = new Map();
    for (const entry of entries || []) {
        const storeId = String(entry.targetStoreId || entry.storeId || "").trim() || "unknown-store";
        const storeName = String(entry.targetStoreName || "").trim() || storeId;
        const sourceLabel = String(entry.sourceStoreName || entry.sourceStoreId || "").trim();
        let group = index.get(storeId);
        if (!group) {
            group = { storeId, storeName, sourceLabel: "", sourceLabels: [], entries: [] };
            index.set(storeId, group);
            groups.push(group);
        }
        // 同一目标店可能接收多个来源店；保留全部来源名称，搜索不能只命中第一条日志。
        if (sourceLabel && !group.sourceLabels.includes(sourceLabel)) group.sourceLabels.push(sourceLabel);
        group.sourceLabel = group.sourceLabels.join("、");
        group.entries.push(entry);
    }
    return groups;
}

const STATUS_LABEL = {
    "sample-only": "仅样本",
    "sample-verified": "样本已核验",
    "verified-incomplete": "可核验",
    "ready-for-map": "完整包已齐",
    "packet-incomplete": "包未齐",
    unverified: "未核验"
};

const TRANSFER_STATUS_LABEL = {
    awaiting_confirmation: "待确认探测",
    blocked_preflight: "预检未通过",
    queued: "已排队",
    running: "探测中",
    probed: "已探测，未上传",
    partial: "部分探测失败",
    failed: "探测失败",
    cancelled: "已取消",
    blocked_page: "页面不匹配"
};

const JOB_STATUS_LABEL = {
    queued: "待领取",
    opening: "正在打开目标店",
    claimed: "目标店已领取",
    opened: "店铺已打开",
    identity_verified: "目标店已打开且店名匹配",
    identity_mismatch: "店铺身份不符",
    plugin_missing: "未检测到采集插件",
    retry_wait: "等待重试",
    received: "插件已接收商品",
    upload_opened: "已打开上传页",
    uploaded: "已确认上传",
    blocked_preflight: "预检未通过",
    partial: "处理中或部分完成",
    completed: "已处理完成",
    skipped: "重复跳过",
    failed: "失败",
    cancelled: "已取消"
};

const apiCache = new Map();

/**
 * GET 请求可短时复用已成功结果，避免首页和商品库在连续导航时重复下载同一份总览。
 * POST 等写操作成功后统一清缓存，保证后续页面不会继续读取变更前的数据。
 */
async function api(path, options = {}) {
    // 调用方按线上挂载前缀 /temu 书写路径；这里替换成当前地址的真实前缀，
    // 使线上（/temu）、本机直连（根路径）都能命中，且请求不会跳出本站。
    const { cacheMs = 0, force = false, signal, ...fetchOptions } = options;
    const requestPath = path.startsWith("/temu/") ? `${siteRoot()}${path.slice("/temu".length)}` : path;
    const method = String(fetchOptions.method || "GET").toUpperCase();
    const cacheKey = `${method}:${requestPath}`;
    const cached = cacheMs > 0 && !force && method === "GET" ? apiCache.get(cacheKey) : null;
    if (cached && Date.now() - cached.at <= cacheMs) return cached.data;

    // 只读请求设置截止时间，网络悬挂不能永久锁住分页或轮询；写入请求不自动中断或重试。
    const readController = method === "GET" ? new AbortController() : null;
    const abortRead = () => readController?.abort();
    let readTimedOut = false;
    if (signal?.aborted) abortRead();
    else signal?.addEventListener("abort", abortRead, { once: true });
    const timeout = readController ? window.setTimeout(() => { readTimedOut = true; abortRead(); }, 20000) : null;
    try {
        const response = await fetch(requestPath, { ...fetchOptions, signal: readController?.signal || signal });
        let data = {};
        try {
            const text = await response.text();
            data = text ? JSON.parse(text) : {};
        } catch (error) {
            if (error?.name === "AbortError") throw error;
            data = { error: `服务器返回了无法解析的响应（HTTP ${response.status}）` };
        }
        if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
        // 强制取数仅跳过旧缓存，成功结果仍可被紧邻的人工操作复用。
        if (method === "GET" && cacheMs > 0) apiCache.set(cacheKey, { at: Date.now(), data });
        else if (method !== "GET") apiCache.clear();
        return data;
    } catch (error) {
        // 超时必须成为可见的读取失败，不能被路由当作主动取消而永久留下加载占位。
        if (readTimedOut && !signal?.aborted) throw new Error("读取数据超时，请稍后重试");
        throw error;
    } finally {
        if (timeout !== null) window.clearTimeout(timeout);
        signal?.removeEventListener("abort", abortRead);
    }
}

function stampClass(status) {
    if (status === "ready-for-map") return "stamp";
    if (status === "sample-verified" || status === "verified-incomplete") return "stamp warn";
    return "stamp bad";
}

function fileKindLabel(kind) {
    return {
        "dataset-sample": "结构样本",
        "capture-log": "采集日志",
        "page-structure": "页面结构",
        "full-packet": "完整数据包",
        unknown: "未识别"
    }[kind] || kind;
}

/**
 * 商品未就绪时按真实缺口写状态，避免把“缺详情”和“SKU 没解析到”混成同一句话。
 */
function missingLabel(product) {
    const completeness = product && product.completeness ? product.completeness : {};
    const missing = [];
    if (!completeness.hasSku) missing.push("SKU");
    if (!completeness.hasImages) missing.push("图片");
    if (!completeness.hasDetail && !completeness.hasPrimaryDetail) missing.push("详情接口资料");
    if (completeness.detailState === "unverified") missing.push("正文结构待核验");
    return missing.length ? `缺${missing.join(" / ")}` : "资料未齐";
}

function formatMoney(price, currency) {
    if (price == null || price === "") return "—";
    const amount = Number(price);
    const unit = String(currency || "").trim();
    if (Number.isFinite(amount) && amount >= 100 && Number.isInteger(amount)) {
        return `${unit ? `${unit} ` : ""}${(amount / 100).toFixed(2)}`;
    }
    return `${unit ? `${unit} ` : ""}${price}`;
}

function formatWeight(value) {
    if (value == null || value === "") return "—";
    const amount = Number(value);
    if (!Number.isFinite(amount)) return String(value);
    if (amount >= 1000) return `${(amount / 1000).toFixed(amount % 1000 ? 1 : 0)} g`;
    return `${amount}`;
}

/** 商品/SKC 货号来自列表行或 productSkcList；旧数据没有该字段时继续展示已解析的 articleNo。 */
function productExtCodes(product) {
    const rows = Array.isArray(product?.productExtCodes) ? product.productExtCodes : [];
    return [...new Set([...rows, product?.articleNo]
        .map((code) => String(code || "").trim())
        .filter(Boolean))];
}

/** 商品库展示用的 SKU 货号来自 SKU 级 extCode，不能提升为商品货号。 */
function skuExtCodes(product) {
    const rows = Array.isArray(product?.skus) ? product.skus : [];
    const codes = Array.isArray(product?.skuExtCodes) ? product.skuExtCodes : [];
    return [...new Set([...codes, ...rows.map((sku) => sku?.extCode)]
        .map((code) => String(code || "").trim())
        .filter(Boolean))];
}

/** 列表展示把 SKC/SKU 标识统一成可 join 的文本，避免旧数据不是数组时整页读失败。 */
function identifierText(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean).join(" / ");
    const text = String(value || "").trim();
    return text;
}

function renderSkuTable(product) {
    const rows = Array.isArray(product.skus) && product.skus.length
        ? product.skus
        : (product.skuIds || []).map((skuId) => ({ skuId }));
    if (!rows.length) return `<p class="muted empty-state">当前完整包没有解析到 SKU。列表接口的 SKU 应出现在商品行的 productSkuSummaries 中。</p>`;
    return `
        <table class="sku-table">
            <thead><tr><th>SKU</th><th>货号</th><th>规格</th><th>供货价</th><th>重量</th></tr></thead>
            <tbody>
                ${rows.map((sku) => `
                    <tr>
                        <td class="num">${escapeHtml(sku.skuId)}</td>
                        <td>${escapeHtml(sku.extCode || "—")}</td>
                        <td>${escapeHtml((sku.specs || []).map((item) => item.name ? `${item.name}:${item.value}` : item.value).filter(Boolean).join(" / ") || "—")}</td>
                        <td>${escapeHtml(formatMoney(sku.price, sku.currency))}</td>
                        <td>${escapeHtml(formatWeight(sku.weight))}</td>
                    </tr>
                `).join("")}
            </tbody>
        </table>
    `;
}

function renderAttributeList(product) {
    const attrs = Array.isArray(product.attributes) ? product.attributes : [];
    if (!attrs.length) return `<p class="muted empty-state">当前包没有商品属性。这不等于详情正文。</p>`;
    return `<ul class="attr-list">${attrs.map((item) => `<li><span>${escapeHtml(item.name)}</span><strong>${escapeHtml(item.value)}${item.unit ? ` ${escapeHtml(item.unit)}` : ""}</strong></li>`).join("")}</ul>`;
}

/** 商品库和批次详情共用单行商品结构；商品库用台账式分栏，批次详情继续复用紧凑模式。 */
function renderProductRows(products, selectable = false, transferStores = [], sourceBatches = []) {
    const rows = Array.isArray(products) ? products : [];
    if (!rows.length) {
        // 商品库空态由 renderCatalogEmpty 解释入库路径；批次详情仍用通用空提示。
        return selectable ? "" : `<div class="catalog-empty">这个批次没有解析出商品。</div>`;
    }
    return rows.map((product) => {
        const productBatches = (Array.isArray(sourceBatches) ? sourceBatches : [])
            .filter((batch) => (product.batchIds || []).includes(batch.id) && batch.sourceStoreId);
        const image = (product.images || []).map(safeImageUrl).find(Boolean);
        const productCodes = productExtCodes(product);
        const skuCodes = skuExtCodes(product);
        const sourceStores = [...new Set(productBatches.map((batch) => batch.sourceStoreName || batch.shopName || batch.sourceStoreId).filter(Boolean))];
        const sourceStoreIds = [...new Set(productBatches.map((batch) => String(batch.sourceStoreId || "").trim()).filter(Boolean))];
        const sourceStoreLabel = sourceStores.join("、") || "来源店铺待核验";
        // 合并行只对外暴露一个 SPU，同货号的其他 SPU 仍要能被搜到，否则运营按旧 SPU 查不到商品。
        const searchText = [product.title, product.spuId, ...(product.spuIds || []), product.goodsId, product.articleNo, product.category, identifierText(product.skcIds), identifierText(product.skuIds), ...productCodes, ...skuCodes].filter(Boolean).join(" ").toLocaleLowerCase();
        return `
            <article class="product-row${product.blocked ? " product-row-blocked" : ""}" data-product-row data-search="${escapeHtml(searchText)}" data-source-stores="${escapeHtml(sourceStoreIds.join(","))}" data-blocked="${product.blocked ? "1" : "0"}" data-spu="${escapeHtml(product.spuId)}">
                ${selectable ? `<label class="row-select" aria-label="选择 SPU ${escapeHtml(product.spuId)}"><input type="checkbox" class="product-checkbox" value="${escapeHtml(product.spuId)}"><span></span></label>` : ""}
                <a class="product-thumb" href="#/product/${encodeURIComponent(product.spuId)}" aria-label="查看 ${escapeHtml(product.title || product.spuId)}">
                    ${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">` : `<span>无图</span>`}
                </a>
                <a class="product-row-main" href="#/product/${encodeURIComponent(product.spuId)}">
                    <strong>${escapeHtml(product.title || "标题未从页面行还原")}</strong>
                    <span class="product-article">货号 ${escapeHtml(productCodes.join(" / ") || "—")}</span>
                    <span class="product-category">${escapeHtml(product.category || "类目未还原")}</span>
                </a>
                <div class="product-source"><strong>${escapeHtml(sourceStoreLabel)}</strong><span>${escapeHtml(product.category || "类目未还原")}</span></div>
                <div class="product-identifiers">
                    <span><b>SPU</b><em class="num">${escapeHtml(identifierText(product.spuIds) || product.spuId || "—")}</em></span>
                    <span><b>Goods</b><em class="num">${escapeHtml(product.goodsId || "—")}</em></span>
                    <span><b>SKU</b><em class="num">${escapeHtml(skuCodes.join(" / ") || identifierText(product.skuIds) || "—")}</em></span>
                </div>
                <span class="ticket-status ${product.blocked ? "blocked" : "ready"}">${product.blocked ? "历史失败记录" : "来源已采集"}</span>
                ${selectable ? `<div class="row-actions"><button type="button" class="row-send" data-transfer-spu="${escapeHtml(product.spuId)}" aria-label="上传 SPU ${escapeHtml(product.spuId)}" ${transferStores.length && productBatches.length ? "" : "disabled"} title="${transferStores.length && productBatches.length ? "选择目标店铺后上传" : (productBatches.length ? "等待在线目标店铺插件" : "缺少可追溯的来源批次")}">上传</button><a href="#/product/${encodeURIComponent(product.spuId)}" class="row-detail">详情</a><button type="button" class="row-delete" data-delete-spu="${escapeHtml(product.spuId)}" aria-label="删除 SPU ${escapeHtml(product.spuId)}">删除</button></div>` : ""}
            </article>`;
    }).join("");
}

function setNav(name) {
    document.querySelectorAll("[data-nav]").forEach((link) => {
        if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });
}

function renderDashboardRanking(items, emptyText, type) {
    if (!items.length) return `<p class="workspace-empty">${escapeHtml(emptyText)}</p>`;
    const max = Math.max(...items.map((item) => Number(item.count) || 0), 1);
    return `<ol class="dashboard-ranking-list">${items.map((item, index) => `
        <li>
            <span class="ranking-index num">${index + 1}</span>
            <div class="ranking-copy"><strong>${escapeHtml(item.name)}</strong><small>${type === "product" ? `SPU ${escapeHtml(item.id)}` : "来源店铺"}</small></div>
            <span class="ranking-meter" aria-hidden="true"><i style="width:${Math.max(8, Math.round((Number(item.count) || 0) / max * 100))}%"></i></span>
            <b class="num">${item.count}</b>
        </li>
    `).join("")}</ol>`;
}

function renderHome(overview, dashboard = {}) {
    setNav("home");
    const topProducts = Array.isArray(dashboard.topProducts) ? dashboard.topProducts : [];
    const topSources = Array.isArray(dashboard.topSources) ? dashboard.topSources : [];
    const productCount = Number(overview.productCount) || 0;
    const readyCount = Number(overview.readyCount) || 0;
    const missingDetailCount = Number(overview.missingDetailCount) || 0;
    const missingImageCount = Number(overview.missingImageCount) || 0;
    app.innerHTML = `
        <div class="top catalog-top">
            <div class="top-copy">
                <h1>查验台</h1>
                <p class="lede">汇总今日发送、上传成功、异常和仓库库存，再核对商品与来源店的累计流转排名。</p>
            </div>
            <div class="home-sync"><span class="live-dot"></span><strong>实时数据</strong></div>
        </div>
        <section class="dashboard-metrics" aria-label="今日经营汇总">
            <article class="dashboard-metric metric-inventory"><span>仓库商品</span><strong>${productCount}</strong><small>${readyCount} 件资料可交付</small></article>
            <article class="dashboard-metric metric-sent"><span>今日发送商品</span><strong>${Number(dashboard.todaySent) || 0}</strong><small>${Number(dashboard.activeJobs) || 0} 个任务仍在处理或需核对</small></article>
            <article class="dashboard-metric metric-uploaded"><span>今日上传成功</span><strong>${Number(dashboard.todayUploaded) || 0}</strong><small>已由目标店插件确认创建</small></article>
            <article class="dashboard-metric metric-attention"><span>今日异常</span><strong>${Number(dashboard.todayAttention) || 0}</strong><small>结果未知、预检失败或商品失败</small></article>
        </section>
        <section class="dashboard-rankings" aria-label="累计流转排名">
            <section class="ranking-panel">
                <div class="workspace-heading"><div><h2>发送最多的商品</h2><p>按进入目标店任务商品包的次数降序排列。</p></div><span class="section-count">前 ${topProducts.length} 项</span></div>
                ${renderDashboardRanking(topProducts, "还没有商品发送记录。", "product")}
            </section>
            <section class="ranking-panel">
                <div class="workspace-heading"><div><h2>发送最多的来源店铺</h2><p>按来源批次累计发送的商品项数量降序排列。</p></div><span class="section-count">前 ${topSources.length} 项</span></div>
                ${renderDashboardRanking(topSources, "还没有来源店铺发送记录。", "source")}
            </section>
        </section>
        <section class="ingest-status-strip" id="inbox-card" aria-label="采集入库状态">
            <div class="ingest-status-main">
                <span class="status-dot pending" id="inbox-status-dot"></span>
                <div class="ingest-status-copy">
                    <strong id="inbox-status-title">正在读取采集监控</strong>
                    <span id="inbox-status-subtitle">等待本地目录监控返回状态…</span>
                </div>
                <button type="button" class="toolbar-button primary" id="inbox-scan" disabled>读取中…</button>
            </div>
            <dl class="ingest-status-metrics">
                <div><dt>新文件已入库</dt><dd id="inbox-imported">—</dd></div>
                <div><dt>重复文件</dt><dd id="inbox-reused">—</dd></div>
                <div><dt>入库失败</dt><dd id="inbox-failed">—</dd></div>
            </dl>
        </section>
        <section class="metric-grid" aria-label="商品统计">
            <div class="metric-card metric-primary"><span>可交付</span><strong>${readyCount}</strong><small>图片、SKU 和详情资料可核验；发布仍需目标店校验</small></div>
            <div class="metric-card"><span>待采详情</span><strong>${missingDetailCount}</strong><small>另有 ${Number(overview.sourceEmptyDetailCount) || 0} 件已采集但源正文为空</small></div>
            <div class="metric-card"><span>缺图片</span><strong>${missingImageCount}</strong><small>已入库但还没有可用主图</small></div>
            <div class="metric-card"><span>历史批次</span><strong>${Number(overview.batchCount) || 0}</strong><small>保留原始文件和解析结果便于回溯</small></div>
        </section>
        <label class="drop manual-ingest" id="drop">
            <span class="drop-symbol" aria-hidden="true">＋</span>
            <span class="drop-copy"><strong>上传采集文件</strong><small>可手动补传完整包。目录监控只自动收取 temu-full-capture 文件</small></span>
            <span class="drop-button">选择文件</span>
            <input class="file-input" id="files" type="file" accept="application/json,.json" multiple>
        </label>
        <div id="toast"></div>
        <div class="home-workspace">
            <section class="workspace-panel batch-workspace" aria-label="最近批次">
                <div class="workspace-heading"><div><h2>最近批次</h2><p>每个批次保留原始文件和解析结果，便于回溯。</p></div><span class="section-count">${overview.batchCount} 个批次</span></div>
                <div class="board">
                    <div class="board-head"><span>批次</span><span>店铺 / 来源</span><span>覆盖</span><span>SPU / SKU</span><span>结论</span><span>状态</span></div>
                ${overview.batches.map((batch) => `
                    <a class="board-row ${batch.status === "ready-for-map" ? "ok" : "hold"}" href="#/batch/${batch.id}">
                        <span class="batch-id num">${batch.id}</span>
                        <span class="batch-source"><strong>${escapeHtml(batch.shopName || batch.label)}</strong><small>${escapeHtml(hostOf(batch.pageUrl))}</small></span>
                        <span class="num table-emphasis">${batch.coverage || "—"}</span>
                        <span class="num">${batch.counts.spu} <i>/</i> ${batch.counts.sku}</span>
                        <span class="batch-readiness">${escapeHtml(batch.readiness)}</span>
                        <span class="${stampClass(batch.status)}">${STATUS_LABEL[batch.status] || batch.status}</span>
                    </a>
                `).join("") || `<div class="board-row board-empty"><span>还没有批次。来源店采集完成后会自动出现在这里。</span></div>`}
                </div>
            </section>
            <section class="workspace-panel activity-workspace" aria-label="最近入库活动">
                <div class="workspace-heading"><div><h2>最近入库活动</h2><p>只显示最近扫描到的文件和处理结果。</p></div><button type="button" class="text-button" id="inbox-refresh">刷新</button></div>
                <div class="recent-files" id="recent-ingest-list"><p class="workspace-empty">正在读取最近文件…</p></div>
            </section>
        </div>
    `;
    bindDrop();
    bindInboxCard();
    document.getElementById("inbox-refresh")?.addEventListener("click", () => bindInboxCard());
}

/** 将目录监控的最近文件区分成已入库、重复文件和失败，避免把“扫到文件”说成“商品已进库”。 */
function renderRecentFile(item) {
    const statusText = {
        imported: "已入库",
        reused: "重复文件，未新建批次",
        failed: "入库失败"
    }[item && item.status] || (item && item.status) || "未知";
    const extra = item && item.status === "failed"
        ? escapeHtml(item.error || "解析失败")
        : (item && item.productCount != null ? `解析 ${Number(item.productCount) || 0} 个 SPU` : "");
    const batch = item && item.batchId ? `<a href="#/batch/${encodeURIComponent(item.batchId)}">${escapeHtml(item.batchId)}</a>` : "";
    return `<article class="recent-file ${escapeHtml(item && item.status || "")}">
        <strong>${escapeHtml(item && item.fileName || "未命名文件")}</strong>
        <span class="recent-status">${escapeHtml(statusText)}</span>
        <span class="muted">${extra}${batch ? ` · 批次 ${batch}` : ""}</span>
    </article>`;
}

/** 展示本机目录监控状态；扫描动作只触发本地解析，不会把文件发送到外部平台。 */
async function bindInboxCard() {
    const card = document.getElementById("inbox-card");
    const activityList = document.getElementById("recent-ingest-list");
    if (!card) return;
    try {
        const status = await api("/temu/api/inbox/status");
        const recent = Array.isArray(status.recent) ? status.recent.slice(0, 8) : [];
        const dot = card.querySelector("#inbox-status-dot");
        const title = card.querySelector("#inbox-status-title");
        const subtitle = card.querySelector("#inbox-status-subtitle");
        const imported = card.querySelector("#inbox-imported");
        const reused = card.querySelector("#inbox-reused");
        const failed = card.querySelector("#inbox-failed");
        dot.className = `status-dot ${status.running ? "" : "pending"}`.trim();
        title.textContent = status.running ? "采集目录监控中" : "采集目录监控已停止";
        subtitle.textContent = status.lastError
            ? `最近错误：${status.lastError}`
            : `监控目录：${(status.directories || []).join("；") || "未配置"}`;
        imported.textContent = status.imported || 0;
        reused.textContent = status.reused || 0;
        failed.textContent = status.failed || 0;
        failed.classList.toggle("is-error", Number(status.failed || 0) > 0);
        if (activityList) {
            activityList.innerHTML = recent.map(renderRecentFile).join("") || `<p class="workspace-empty">还没有扫描到完整采集包。</p>`;
        }
        const button = card.querySelector("#inbox-scan");
        if (button) {
            button.disabled = false;
            button.textContent = "立即扫描";
        }
        card.querySelector("#inbox-scan").onclick = async () => {
            const button = card.querySelector("#inbox-scan");
            if (button) { button.disabled = true; button.textContent = "扫描中…"; }
            try { await api("/temu/api/inbox/scan", { method: "POST" }); await route(); }
            catch (error) { if (button) { button.disabled = false; button.textContent = `扫描失败：${error.message}`; } }
        };
    } catch (error) {
        card.querySelector("#inbox-status-title").textContent = "采集监控读取失败";
        card.querySelector("#inbox-status-subtitle").textContent = error.message;
        card.querySelector("#inbox-status-dot").className = "status-dot is-error";
        card.querySelector("#inbox-scan").disabled = false;
        card.querySelector("#inbox-scan").textContent = "重试";
        card.querySelector("#inbox-scan").onclick = () => bindInboxCard();
        if (activityList) activityList.innerHTML = `<p class="workspace-empty is-error">读取失败：${escapeHtml(error.message)}</p>`;
    }
}

/** 两个视图使用独立地址，框架预览不复用当前库存的操作事件或权限范围。 */
function renderCatalogViewSwitch(active) {
    return `<nav class="catalog-view-switch" aria-label="商品库视图">
        <a href="#/products"${active === "mine" ? ' aria-current="page"' : ""}>我的商品</a>
        <a href="#/products/all"${active === "all" ? ' aria-current="page"' : ""}>全部商品</a>
    </nav>`;
}

/** 仅供确认布局的全部商品框架：不查询共享库存、不注册业务事件，避免预览触发真实操作。 */
function renderAllProductsFrame() {
    setNav("products");
    app.innerHTML = `
        <div class="top catalog-top">
            <div class="catalog-title-line"><h1>商品库</h1>${renderCatalogViewSwitch("all")}</div>
            <span class="catalog-preview-label">框架预览</span>
        </div>
        <fieldset class="catalog-preview-controls" disabled aria-label="全部商品筛选预览">
            <div class="catalog-filter-bar">
                <label class="catalog-filter"><span>来源店铺</span><select><option>全部来源店铺</option></select></label>
                <label class="catalog-filter"><span>资料状态</span><select><option>全部状态</option></select></label>
                <div class="catalog-search-form"><label class="catalog-search"><span class="visually-hidden">搜索全部商品</span><input type="search" placeholder="名称、货号、SKU"></label><button type="button" class="toolbar-button">搜索</button></div>
            </div>
            <div class="catalog-action-row">
                <div class="catalog-action-left"><label class="select-all"><input type="checkbox"><span></span>全选本页</label><button type="button" class="toolbar-button">清除选择</button><button type="button" class="toolbar-button">导入商品</button><button type="button" class="toolbar-button">选择目标店铺</button></div>
                <div class="catalog-action-right">${renderInlinePagination("all-products-preview", 1, 20, 0, "商品")}</div>
            </div>
            <div class="batch-upload-row"><span class="batch-store-summary">目标店铺：未选择</span><button type="button" class="toolbar-button primary">一键上架</button></div>
        </fieldset>
        <section class="catalog-preview-table-wrap" aria-label="全部商品列表预览">
            <table class="catalog-preview-table">
                <thead><tr><th scope="col"><span class="visually-hidden">选择</span></th><th scope="col">商品</th><th scope="col">来源店铺</th><th scope="col">货号</th><th scope="col">SKU 货号</th><th scope="col">资料状态</th><th scope="col">操作</th></tr></thead>
                <tbody><tr><td colspan="7" class="catalog-preview-empty">待接入商品数据</td></tr></tbody>
            </table>
        </section>`;
}

/**
 * 商品库只列出近期在线、店名已核验且支持接收快照的目标插件。
 * 不能根据紫鸟店铺列表直接假定插件在线，否则“发送”会变成没有接收方的假成功。
 */
function renderProducts(overview, agentResult = { agents: [], total: 0, hasMore: false }) {
    setNav("products");
    const productTotal = Math.max(0, Number(overview.productTotal ?? overview.productCount) || 0);
    const loadedProductCount = Array.isArray(overview.products) ? overview.products.length : 0;
    const targetStores = (agentResult.agents || []).filter(agent => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId)
        .map(agent => ({ storeId: agent.storeId, storeName: agent.storeName || agent.pageStoreName || agent.storeId }));
    const targetStoreTotal = Math.max(targetStores.length, Number(agentResult.total) || 0);
    const targetStoresHaveMore = Boolean(agentResult.hasMore);
    const readyCount = Number(overview.readyCount) || 0;
    const incompleteCount = Math.max(0, Number(overview.productCount) - readyCount);
    const sourceStores = Array.isArray(overview.sourceStores) && overview.sourceStores.length
        ? overview.sourceStores.map((store) => [String(store.storeId), store.storeName || store.storeId])
        : [...new Map((overview.batches || []).filter(batch => batch.sourceStoreId).map(batch => [String(batch.sourceStoreId), batch.sourceStoreName || batch.shopName || batch.sourceStoreId])).entries()];
    app.innerHTML = `
        <div class="top catalog-top">
            <div class="top-copy">
                <div class="catalog-title-line"><h1>商品库</h1>${renderCatalogViewSwitch("mine")}</div>
                <p class="lede">先核对已入库资料，再批量上传到目标店插件。商品是否重复由目标店插件在店铺会话内判断。</p>
            </div>
            <div class="catalog-top-stats"><span><b id="catalog-product-total">${overview.productCount}</b> 个商品</span><span><b id="product-target-store-total">${targetStoreTotal}</b> 个目标店在线</span></div>
        </div>
        <div class="catalog-filter-bar" aria-label="商品筛选和搜索">
            <label class="catalog-filter"><span>来源店铺</span><select id="source-store-filter"><option value="">全部来源店铺</option>${sourceStores.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("")}</select></label>
            <label class="catalog-filter"><span>标红状态</span><select id="blocked-filter"><option value="">全部商品</option><option value="blocked">仅看标红（上传失败）</option><option value="normal">仅看未标红</option></select></label>
            <label class="catalog-filter"><span>查看方式</span><select id="product-view-mode"><option value="list">平铺列表</option><option value="group">按店铺分组</option></select></label>
            <form class="catalog-search-form" id="product-search-form" role="search"><label class="catalog-search"><span class="visually-hidden">搜索商品</span><input id="product-search" type="search" placeholder="名称、货号、SPU、SKU" title="搜索名称、货号、SPU、SKU、Goods ID" autocomplete="off" value="${escapeHtml(catalogFilters.draft)}"></label><button class="toolbar-button" type="submit">搜索</button><span class="visually-hidden" id="search-count" aria-live="polite">本页 ${loadedProductCount} / 共 ${productTotal} 个</span></form>
        </div>
        <div class="catalog-action-row" aria-label="商品操作">
            <div class="catalog-action-left"><label class="select-all"><input id="select-all-products" type="checkbox"><span></span>全选本页</label><button type="button" class="toolbar-button" id="clear-product-selection" disabled>清除选择</button><button type="button" class="toolbar-button danger" id="delete-selected" disabled>删除</button><button type="button" class="toolbar-button" id="unblock-selected" disabled>解除标红</button><button type="button" class="toolbar-button" id="batch-target-trigger" ${targetStores.length ? "" : "disabled"}>选择目标店铺</button><button type="button" class="toolbar-button" id="catalog-upload-button">导入资料</button><span id="catalog-live-pending" class="muted" role="status" hidden>有商品更新</span><input class="visually-hidden" id="catalog-files" type="file" accept="application/json,.json" multiple></div>
            <div class="catalog-action-right"><span class="selection-count" id="selection-count">已选择 0 个</span>${renderInlinePagination("product", catalogProductPage, catalogProductPageSize, productTotal, "商品")}</div>
        </div>
        <div class="catalog-connection-row" aria-label="连接店铺状态"><span class="connection-pulse" aria-hidden="true"></span><strong id="product-target-store-connection">${targetStoreTotal} 个目标店铺已连接</strong><span class="muted">在线插件可接收批量上传任务</span><span class="connection-stores" id="product-target-store-names">${targetStores.map(store => escapeHtml(store.storeName || store.storeId)).join("、") || "暂无在线店铺"}</span></div>
        <div class="batch-upload-row" aria-label="批量上传">
            <div class="batch-store-summary" id="batch-store-summary">尚未选择目标店铺</div>
            <button type="button" class="toolbar-button primary" id="batch-direct-create" disabled>一键上架</button>
        </div>
        <select id="batch-target-stores" class="visually-hidden" multiple aria-hidden="true" tabindex="-1">${targetStores.map(store => `<option value="${escapeHtml(store.storeId)}">${escapeHtml(store.storeName || store.storeId)}</option>`).join("")}</select>
        <dialog id="batch-target-dialog" class="batch-target-dialog" aria-labelledby="batch-target-dialog-title">
            <form method="dialog">
                <div class="batch-dialog-head"><div><h2 id="batch-target-dialog-title">选择目标店铺</h2><p>勾选一个或多个店铺，完成后回到商品库继续上传。</p></div><button type="submit" value="cancel" class="dialog-close" aria-label="关闭">×</button></div>
                <label class="batch-dialog-search"><span class="search-symbol" aria-hidden="true"></span><span class="visually-hidden">搜索店铺</span><input id="batch-target-search" type="search" placeholder="搜索店铺名称" autocomplete="off"></label>
                <label class="batch-dialog-select-all"><input id="batch-target-select-all" type="checkbox"><span></span>全选当前店铺</label>
                <div class="batch-target-options" id="batch-target-options">${targetStores.map(store => `<label class="batch-target-option" data-store-search="${escapeHtml((store.storeName || store.storeId).toLocaleLowerCase())}"><input type="checkbox" value="${escapeHtml(store.storeId)}"><span class="batch-target-check"></span><strong>${escapeHtml(store.storeName || store.storeId)}</strong><small>在线，可接收上传任务</small></label>`).join("") || `<p class="muted">暂无在线目标店铺。</p>`}</div>
                <div class="task-load-more" id="batch-target-load-more-wrap" ${targetStoresHaveMore ? "" : "hidden"}><button type="button" class="toolbar-button" id="batch-target-load-more">加载更多目标店铺</button><span id="batch-target-load-more-status">已显示 ${targetStores.length} / ${targetStoreTotal} 家</span></div>
                <div class="batch-dialog-footer"><span id="batch-dialog-count">已选择 0 家店铺</span><button type="submit" value="apply" class="toolbar-button primary">完成选择</button></div>
            </form>
        </dialog>
        <dialog id="single-target-dialog" class="batch-target-dialog" aria-labelledby="single-target-dialog-title">
            <form method="dialog">
                <div class="batch-dialog-head"><div><h2 id="single-target-dialog-title">选择上传店铺</h2><p>为 <strong id="single-target-spu">当前商品</strong> 选择一个或多个已连接店铺。点击“确定上传”即表示确认该商品符合适用要求，并同意平台《商品合规声明》V2.0；重复检索由目标店插件完成。</p></div><button type="submit" value="cancel" class="dialog-close" aria-label="关闭">×</button></div>
                <label class="batch-dialog-search"><span class="search-symbol" aria-hidden="true"></span><span class="visually-hidden">搜索上传店铺</span><input id="single-target-search" type="search" placeholder="搜索店铺名称或 ID" autocomplete="off"></label>
                <label class="batch-dialog-select-all"><input id="single-target-select-all" type="checkbox"><span></span>全选当前店铺</label>
                <div class="batch-target-options" id="single-target-options">${targetStores.map(store => `<label class="batch-target-option" data-store-search="${escapeHtml(`${store.storeName || store.storeId} ${store.storeId}`.toLocaleLowerCase())}"><input type="checkbox" value="${escapeHtml(store.storeId)}"><span class="batch-target-check"></span><strong>${escapeHtml(store.storeName || store.storeId)}</strong><small>${escapeHtml(store.storeId)} · 在线，可接收上传任务</small></label>`).join("") || `<p class="muted">暂无在线目标店铺。</p>`}</div>
                <div class="task-load-more" id="single-target-load-more-wrap" ${targetStoresHaveMore ? "" : "hidden"}><button type="button" class="toolbar-button" id="single-target-load-more">加载更多目标店铺</button><span id="single-target-load-more-status">已显示 ${targetStores.length} / ${targetStoreTotal} 家</span></div>
                <div class="batch-dialog-footer"><span id="single-target-count" aria-live="polite">已选择 0 家店铺</span><div class="single-target-dialog-actions"><button type="submit" value="cancel" class="toolbar-button">取消</button><button type="submit" value="apply" class="toolbar-button primary">确定上传</button></div></div>
            </form>
        </dialog>
        <section class="catalog-workspace" aria-label="商品台账">
          <div id="catalog-toast" aria-live="polite"></div>
          <div class="transfer-hint ${targetStores.length ? "ready" : ""}">${targetStores.length ? `已检测到 ${targetStores.length} 个可接收上传任务的目标店插件。` : "未检测到可接收上传任务的目标店插件。请先打开目标店并等待插件身份匹配。"}</div>
          <div class="product-table-head" aria-hidden="true"><span></span><span></span><span>商品</span><span>来源店铺</span><span>标识信息</span><span>状态</span><span>操作</span></div>
          <div class="product-list">${renderProductRows(overview.products, true, targetStores, overview.batches) || renderCatalogEmpty(overview)}</div>
        </section>
    `;
    bindProductInventory(overview, targetStores, agentResult);
}

/** 区分仓库为空和筛选无结果；两种状态需要不同的下一步，不能都提示重新入库。 */
function renderCatalogEmpty(overview = {}) {
    if (Number(overview.productCount) > 0 && Number(overview.productTotal) === 0) {
        return `<div class="catalog-empty">没有符合当前筛选条件的商品，请调整来源店铺、标红状态或搜索词。</div>`;
    }
    return `<div class="catalog-empty">还没有解析出商品。插件采集完成后需要成功推送到入库台，或在这里上传完整采集包。</div>`;
}

/** 按稳定店铺编号识别同店发送，并在任何任务提交前统一确认；取消时整次提交不产生任务。 */
async function confirmSourceStoreTargets(sources, targets) {
    const matches = new Map();
    for (const source of sources) {
        const storeId = String(source.sourceStoreId || "").trim();
        const target = targets.find(item => String(item.storeId || "").trim() === storeId);
        if (!storeId || !target) continue;
        const name = source.sourceStoreName || source.shopName || target.storeName || target.pageStoreName || storeId;
        matches.set(storeId, `${name}（${storeId}）`);
    }
    if (!matches.size) return true;
    return Boolean(await confirmAction({ title: "确认发送到来源店铺", details: ["以下目标店铺也是本次商品的来源店铺：", ...matches.values(), "是否继续发送？目标店仍会检查重复商品。"], confirmLabel: "确认发送到来源店铺", destructive: false }));
}

/** 每次人工发送独立编号；该请求的网络重传复用请求体，不按商品内容合并下一次点击。 */
async function submitBulkManifest(groups, targets) {
    const body = { groups: groups.map(group => ({ sourceStoreId: group.sourceStoreId, sourceBatchId: group.sourceBatchId, spuIds: [...group.spuIds].sort() })).sort((a,b) => a.sourceBatchId.localeCompare(b.sourceBatchId)),
        targets: targets.map(target => ({ storeId: target.storeId, storeName: target.storeName || target.pageStoreName || target.storeId })).sort((a,b) => a.storeId.localeCompare(b.storeId)),
        sameStoreConfirmed: true, complianceVersion: 'V2.0' };
    const requestId = crypto.randomUUID();
    const result = await api('/temu/api/bulk-dispatch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, requestId }) });
    if (!result.batch?.id) throw Error('服务端尚未确认批量清单，请保留选择后重试');
    return result.batch;
}

/** 单商品也统一提交持久化清单，选择多家店后不再依赖页面逐店发送。 */
async function submitSingleProduct({ product, sourceBatch, targets, button, toast }) {
    const spuId = String(product?.spuId || "");
    const routeVersion = routeRequestId;
    // 发送资格由原始来源关联及服务端传输校验决定，不由类目模板字段决定。
    if (!sourceBatch) throw new Error("该商品尚无可追溯的完整来源资料，请重新导入完整采集包并确认来源店铺。");
    const capability = await api("/temu/api/direct-create-capability");
    // 等待资格响应期间已离开商品页时，不在新页面补弹确认窗。
    if (routeVersion !== routeRequestId || button?.isConnected === false) return;
    if (!capability?.directCreate) throw new Error("后台尚未启用接口创建，请重启本地网站及连接器后再试。");
    if (!targets.length) throw new Error("请至少选择一个在线且身份已匹配的目标店插件。");
    if (!await confirmSourceStoreTargets([sourceBatch], targets)) {
        if (toast) toast.innerHTML = `<div class="toast">已取消发送，未创建任务。</div>`;
        return;
    }
    // 写入尚未开始时离开页面即取消；已发出的任务则继续收集回执，不宣称已撤回。
    if (routeVersion !== routeRequestId || button?.isConnected === false) return;
    if (button) {
        button.disabled = true;
        button.textContent = "上传中…";
    }
    if (toast) toast.innerHTML = `<div class="toast">正在向 ${escapeHtml(String(targets.length))} 家目标店上传 SPU ${escapeHtml(spuId)}…</div>`;
    try {
        await submitBulkManifest([{ sourceStoreId: sourceBatch.sourceStoreId, sourceBatchId: sourceBatch.id, spuIds: [spuId] }], targets);
        if (toast) toast.innerHTML = `<div class="toast success">发送清单已保存，${targets.length} 家店铺排队中。<a href="#/jobs">查看分发进度</a></div>`;
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "上传";
        }
    }
}

/** 商品库筛选和页码分页都由服务端完成，浏览器只保留当前页数据和跨页勾选上下文。 */
function bindProductInventory(overview, initialTargetStores, agentResult = {}) {
    const input = document.getElementById("product-search");
    const sourceStoreFilter = document.getElementById("source-store-filter");
    const loadedProducts = Array.isArray(overview.products) ? [...overview.products] : [];
    overview.products = loadedProducts;
    let rows = [...document.querySelectorAll("[data-product-row]")];
    const selectAll = document.getElementById("select-all-products");
    const clearProductSelection = document.getElementById("clear-product-selection");
    const deleteSelected = document.getElementById("delete-selected");
    const selectionCount = document.getElementById("selection-count");
    const searchCount = document.getElementById("search-count");
    const uploadButton = document.getElementById("catalog-upload-button");
    const files = document.getElementById("catalog-files");
    const batchTargetStores = document.getElementById("batch-target-stores");
    const batchDirectCreate = document.getElementById("batch-direct-create");
    const batchTargetTrigger = document.getElementById("batch-target-trigger");
    const batchTargetDialog = document.getElementById("batch-target-dialog");
    const batchTargetSearch = document.getElementById("batch-target-search");
    const batchTargetSelectAll = document.getElementById("batch-target-select-all");
    let batchTargetOptions = [...document.querySelectorAll("#batch-target-options .batch-target-option")];
    const batchStoreSummary = document.getElementById("batch-store-summary");
    const batchDialogCount = document.getElementById("batch-dialog-count");
    const singleTargetDialog = document.getElementById("single-target-dialog");
    const singleTargetSpu = document.getElementById("single-target-spu");
    const singleTargetSearch = document.getElementById("single-target-search");
    const singleTargetSelectAll = document.getElementById("single-target-select-all");
    let singleTargetOptions = [...document.querySelectorAll("#single-target-options .batch-target-option")];
    const singleTargetCount = document.getElementById("single-target-count");
    const viewMode = document.getElementById("product-view-mode");
    const productList = document.querySelector(".catalog-workspace .product-list");
    const productPageSizeSelect = document.getElementById("product-page-size");
    const productPagePrev = document.getElementById("product-page-prev");
    const productPageNext = document.getElementById("product-page-next");
    const productPageButtons = document.getElementById("product-page-buttons");
    const productPageStatus = document.getElementById("product-page-status");
    let targetStores = [...initialTargetStores];
    const knownTargetStoreIds = new Set(targetStores.map((store) => String(store.storeId)));
    let targetStoreTotal = Math.max(targetStores.length, Number(agentResult.total) || 0);
    let targetAgentsHasMore = Boolean(agentResult.hasMore);
    let targetAgentsOffset = targetStores.length;
    let targetAgentsBusy = false;
    if (!input || !selectAll || !deleteSelected) return;
    sourceStoreFilter.value = catalogFilters.sourceStoreId;
    document.getElementById("blocked-filter").value = catalogFilters.blocked;
    if (productPageSizeSelect) {
        catalogProductPageSize = Number(productPageSizeSelect.value) || catalogProductPageSize;
        productPageSizeSelect.value = String(catalogProductPageSize);
    }

    const visibleRows = () => rows.filter((row) => !row.hidden);
    const checkedBoxes = () => rows.map((row) => row.querySelector(".product-checkbox")).filter((box) => box && box.checked);
    /** 当前页携带的批次只覆盖本页商品，选中后需要独立缓存，切页后才能还原上传上下文。 */
    const cacheSelectedBatches = (products, batches) => {
        const productBatchIds = new Set(products.flatMap((product) => (product?.batchIds || []).map(String)));
        for (const batch of batches || []) {
            if (productBatchIds.has(String(batch.id))) catalogSelectedBatches.set(String(batch.id), batch);
        }
    };
    /** 商品选择以 SPU 为键跨页保存完整快照；取消选择只移除商品，共享批次缓存不做误删。 */
    const setProductSelected = (product, selected) => {
        const spuId = String(product?.spuId || "").trim();
        if (!spuId) return;
        if (selected) {
            catalogSelectedProducts.set(spuId, product);
            cacheSelectedBatches([product], overview.batches);
        } else {
            catalogSelectedProducts.delete(spuId);
        }
    };
    /** 接口任务必须引用商品实际发布的来源批次，不能拿任意关联批次代替。 */
    const sourceBatchForProduct = (product) => {
        const sourceBatchId = String(product?.publicationData?.sourceBatchId || "");
        if (!sourceBatchId || !(product?.batchIds || []).map(String).includes(sourceBatchId)) return null;
        return catalogSelectedBatches.get(sourceBatchId)
            || (overview.batches || []).find((batch) => String(batch.id) === sourceBatchId && batch.sourceStoreId)
            || null;
    };
    const selectedTargetOptions = () => [...(batchTargetStores?.selectedOptions || [])].filter(option => option.value);
    const updateTargetSummary = () => {
        const selected = selectedTargetOptions();
        if (batchStoreSummary) batchStoreSummary.textContent = selected.length
            ? `已选择 ${selected.length} 家店铺：${selected.map(option => option.textContent.trim()).join("、")}`
            : "尚未选择目标店铺";
    };
    const updateTargetAgentPagination = () => {
        const statusText = `已显示 ${targetStores.length} / ${targetStoreTotal} 家`;
        ["batch", "single"].forEach((prefix) => {
            const wrap = document.getElementById(`${prefix}-target-load-more-wrap`);
            const status = document.getElementById(`${prefix}-target-load-more-status`);
            if (wrap) wrap.hidden = !targetAgentsHasMore;
            if (status) status.textContent = statusText;
        });
        const total = document.getElementById("product-target-store-total");
        const connection = document.getElementById("product-target-store-connection");
        const names = document.getElementById("product-target-store-names");
        if (total) total.textContent = targetStoreTotal;
        if (connection) connection.textContent = `${targetStoreTotal} 个目标店铺已连接`;
        if (names) names.textContent = targetStores.map(store => store.storeName || store.storeId).join("、") || "暂无在线店铺";
        if (batchTargetTrigger) batchTargetTrigger.disabled = !targetStores.length;
        const hint = app.querySelector(".transfer-hint");
        if (hint) {
            hint.classList.toggle("ready", Boolean(targetStores.length));
            hint.textContent = targetStores.length ? `已检测到 ${targetStores.length} 个可接收上传任务的目标店插件。` : "未检测到可接收上传任务的目标店插件。请先打开目标店并等待插件身份匹配。";
        }
        // 在线状态只影响上传入口，不替换商品行，避免图片重载及分页、焦点丢失。
        for (const row of rows) {
            const product = overview.products.find((item) => String(item.spuId) === String(row.dataset.spu));
            const button = row.querySelector("[data-transfer-spu]");
            if (!button || !product) continue;
            const hasBatch = (overview.batches || []).some((batch) => (product.batchIds || []).includes(batch.id) && batch.sourceStoreId);
            // 来源历史失败不等于当前目标店拒收，按钮只受来源可追溯性和目标在线资格影响。
            button.disabled = !targetStores.length || !hasBatch;
            button.title = !hasBatch ? "缺少可追溯的来源批次" : targetStores.length ? "选择目标店铺后上传" : "等待在线目标店铺插件";
        }
    };
    const syncDialogCount = () => {
        const visibleOptions = batchTargetOptions.filter(option => !option.hidden);
        const checkedVisible = visibleOptions.filter(option => option.querySelector("input")?.checked).length;
        if (batchTargetSelectAll) {
            batchTargetSelectAll.checked = Boolean(visibleOptions.length) && checkedVisible === visibleOptions.length;
            batchTargetSelectAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleOptions.length;
        }
        if (batchDialogCount) batchDialogCount.textContent = `已选择 ${batchTargetOptions.filter(option => option.querySelector("input")?.checked).length} 家店铺`;
    };
    const syncDialogFromSelect = () => {
        const selected = new Set(selectedTargetOptions().map(option => String(option.value)));
        batchTargetOptions.forEach(option => { const input = option.querySelector("input"); if (input) input.checked = selected.has(String(input.value)); });
        syncDialogCount();
    };
    const applyDialogSelection = () => {
        const selected = new Set(batchTargetOptions.filter(option => option.querySelector("input")?.checked).map(option => String(option.querySelector("input").value)));
        [...(batchTargetStores?.options || [])].forEach(option => { option.selected = selected.has(String(option.value)); });
        updateTargetSummary();
        batchTargetStores?.dispatchEvent(new Event("change", { bubbles: true }));
    };
    batchTargetTrigger?.addEventListener("click", () => { syncDialogFromSelect(); batchTargetDialog?.showModal(); batchTargetSearch?.focus(); });
    batchTargetSearch?.addEventListener("input", () => {
        const query = batchTargetSearch.value.trim().toLocaleLowerCase();
        batchTargetOptions.forEach(option => { option.hidden = Boolean(query) && !String(option.dataset.storeSearch || "").includes(query); });
        syncDialogCount();
    });
    batchTargetSelectAll?.addEventListener("change", () => {
        batchTargetOptions.filter(option => !option.hidden).forEach(option => { const input = option.querySelector("input"); if (input) input.checked = batchTargetSelectAll.checked; });
        syncDialogCount();
    });
    const bindBatchTargetOption = (option) => option.querySelector("input")?.addEventListener("change", syncDialogCount);
    batchTargetOptions.forEach(bindBatchTargetOption);
    batchTargetDialog?.addEventListener("close", () => { if (batchTargetDialog.returnValue === "apply") applyDialogSelection(); else syncDialogFromSelect(); });
    const syncSingleDialogCount = () => {
        const visibleOptions = singleTargetOptions.filter(option => !option.hidden);
        const checkedVisible = visibleOptions.filter(option => option.querySelector("input")?.checked).length;
        if (singleTargetSelectAll) {
            singleTargetSelectAll.checked = Boolean(visibleOptions.length) && checkedVisible === visibleOptions.length;
            singleTargetSelectAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleOptions.length;
        }
        if (singleTargetCount) singleTargetCount.textContent = `已选择 ${singleTargetOptions.filter(option => option.querySelector("input")?.checked).length} 家店铺`;
    };
    const resetSingleDialog = () => {
        if (singleTargetSearch) singleTargetSearch.value = "";
        singleTargetOptions.forEach(option => {
            option.hidden = false;
            const checkbox = option.querySelector("input");
            if (checkbox) checkbox.checked = false;
        });
        syncSingleDialogCount();
    };
    singleTargetSearch?.addEventListener("input", () => {
        const query = singleTargetSearch.value.trim().toLocaleLowerCase();
        singleTargetOptions.forEach(option => { option.hidden = Boolean(query) && !String(option.dataset.storeSearch || "").includes(query); });
        syncSingleDialogCount();
    });
    singleTargetSelectAll?.addEventListener("change", () => {
        singleTargetOptions.filter(option => !option.hidden).forEach(option => {
            const checkbox = option.querySelector("input");
            if (checkbox) checkbox.checked = singleTargetSelectAll.checked;
        });
        syncSingleDialogCount();
    });
    const bindSingleTargetOption = (option) => option.querySelector("input")?.addEventListener("change", syncSingleDialogCount);
    singleTargetOptions.forEach(bindSingleTargetOption);
    singleTargetDialog?.addEventListener("close", async () => {
        const spuId = String(singleTargetDialog.dataset.spu || "");
        if (singleTargetDialog.returnValue !== "apply" || !spuId) {
            resetSingleDialog();
            return;
        }
        if (singleUploadBusy || batchUploadBusy) {
            resetSingleDialog();
            return;
        }
        singleUploadBusy = true;
        const targetIds = singleTargetOptions.filter(option => option.querySelector("input")?.checked).map(option => String(option.querySelector("input")?.value || "")).filter(Boolean);
        const product = (overview.products || []).find(item => String(item.spuId) === spuId);
        const sourceBatchId = product?.publicationData?.sourceBatchId;
        const sourceBatch = (overview.batches || []).find(batch => batch.id === sourceBatchId && (product?.batchIds || []).includes(batch.id) && batch.sourceStoreId);
        const targets = (targetStores || []).filter(item => targetIds.includes(String(item.storeId)));
        const row = rows.find(item => String(item.dataset.spu || "") === spuId);
        const button = row?.querySelector("[data-transfer-spu]");
        const toast = document.getElementById("catalog-toast");
        try {
            await submitSingleProduct({ product, sourceBatch, targets, button, toast });
        } catch (error) {
            if (toast) toast.innerHTML = `<div class="toast error">上传失败：${escapeHtml(error.message)}</div>`;
        } finally {
            singleUploadBusy = false;
            syncSelection();
            singleTargetDialog.dataset.spu = "";
            resetSingleDialog();
        }
    });
    const loadMoreTargetAgents = async (event) => {
        if (targetAgentsBusy || !targetAgentsHasMore) return;
        const trigger = event?.currentTarget;
        targetAgentsBusy = true;
        document.querySelectorAll("#batch-target-load-more, #single-target-load-more").forEach((button) => {
            button.disabled = true;
            button.textContent = "加载中…";
        });
        try {
            const page = await api(`/temu/api/agents?online=1&receivable=1&limit=100&offset=${targetAgentsOffset}`, { cacheMs: 2500 });
            const additions = (page.agents || [])
                .filter((agent) => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId)
                .map((agent) => ({ storeId: agent.storeId, storeName: agent.storeName || agent.pageStoreName || agent.storeId }))
                .filter((store) => !knownTargetStoreIds.has(String(store.storeId)));
            for (const store of additions) {
                const storeId = String(store.storeId);
                const storeName = String(store.storeName || storeId);
                knownTargetStoreIds.add(storeId);
                targetStores.push(store);
                if (batchTargetStores) {
                    batchTargetStores.append(new Option(storeName, storeId));
                }
                const batchOption = document.createElement("label");
                batchOption.className = "batch-target-option";
                batchOption.dataset.storeSearch = storeName.toLocaleLowerCase();
                batchOption.innerHTML = `<input type="checkbox" value="${escapeHtml(storeId)}"><span class="batch-target-check"></span><strong>${escapeHtml(storeName)}</strong><small>在线，可接收上传任务</small>`;
                document.getElementById("batch-target-options")?.append(batchOption);
                batchTargetOptions.push(batchOption);
                bindBatchTargetOption(batchOption);

                const singleOption = document.createElement("label");
                singleOption.className = "batch-target-option";
                singleOption.dataset.storeSearch = `${storeName} ${storeId}`.toLocaleLowerCase();
                singleOption.innerHTML = `<input type="checkbox" value="${escapeHtml(storeId)}"><span class="batch-target-check"></span><strong>${escapeHtml(storeName)}</strong><small>${escapeHtml(storeId)} · 在线，可接收上传任务</small>`;
                document.getElementById("single-target-options")?.append(singleOption);
                singleTargetOptions.push(singleOption);
                bindSingleTargetOption(singleOption);
            }
            targetAgentsOffset += Array.isArray(page.agents) ? page.agents.length : 0;
            targetStoreTotal = Math.max(targetStores.length, Number(page.total) || 0);
            targetAgentsHasMore = Boolean(page.hasMore);
            updateTargetAgentPagination();
            batchTargetSearch?.dispatchEvent(new Event("input"));
            singleTargetSearch?.dispatchEvent(new Event("input"));
        } catch (error) {
            const toast = document.getElementById("catalog-toast");
            if (toast) toast.innerHTML = `<div class="toast error">目标店铺加载失败：${escapeHtml(error.message)}</div>`;
        } finally {
            targetAgentsBusy = false;
            document.querySelectorAll("#batch-target-load-more, #single-target-load-more").forEach((button) => {
                button.disabled = false;
                button.textContent = "加载更多目标店铺";
            });
            if (trigger) trigger.focus({ preventScroll: true });
        }
    };
    document.getElementById("batch-target-load-more")?.addEventListener("click", loadMoreTargetAgents);
    document.getElementById("single-target-load-more")?.addEventListener("click", loadMoreTargetAgents);
    window.setTimeout(() => {
        const restoredTargetAgentCount = Math.max(
            takeRestoredPageCount("productTargetAgents"),
            Number(livePaginationTargets.productTargetAgents) || 0
        );
        if (restoredTargetAgentCount > targetStores.length && targetAgentsHasMore) {
            void (async () => {
                while (targetStores.length < restoredTargetAgentCount && targetAgentsHasMore && !targetAgentsBusy) {
                    await loadMoreTargetAgents();
                }
            })();
        }
    }, 0);
    resetSingleDialog();
    const syncSelection = () => {
        rows.forEach((row) => {
            const box = row.querySelector(".product-checkbox");
            if (box) box.checked = catalogSelectedProducts.has(String(row.dataset.spu || ""));
        });
        const visibleBoxes = visibleRows().map((row) => row.querySelector(".product-checkbox")).filter(Boolean);
        const checkedVisible = visibleBoxes.filter((box) => box.checked).length;
        const selected = catalogSelectedProducts.size;
        selectAll.disabled = visibleBoxes.length === 0;
        selectAll.checked = Boolean(visibleBoxes.length) && checkedVisible === visibleBoxes.length;
        selectAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleBoxes.length;
        deleteSelected.disabled = selected === 0;
        const unblockButton = document.getElementById("unblock-selected");
        if (unblockButton) unblockButton.disabled = ![...catalogSelectedProducts.values()].some((product) => product?.blocked);
        if (clearProductSelection) clearProductSelection.disabled = selected === 0;
        selectionCount.textContent = `已选择 ${selected} 个`;
        const targetCount = [...(batchTargetStores?.selectedOptions || [])].filter(option => option.value).length;
        if (batchDirectCreate) batchDirectCreate.disabled = batchUploadBusy || singleUploadBusy || selected === 0 || targetCount === 0;
        updateTargetSummary();
    };
    let filterRequestId = 0;
    let productPageBusy = false;
    let displayedProductState = { ...catalogFilters, page: catalogProductPage, size: catalogProductPageSize };
    /** 页码、按钮和当前页范围统一由服务端总数计算，删除后越界会在请求返回时自动收回。 */
    const updateProductPagination = () => {
        const total = Math.max(0, Number(overview.productTotal) || 0);
        const totalPages = Math.max(1, Math.ceil(total / catalogProductPageSize));
        catalogProductPage = Math.min(Math.max(1, catalogProductPage), totalPages);
        if (productPagePrev) productPagePrev.disabled = productPageBusy || catalogProductPage <= 1;
        if (productPageNext) productPageNext.disabled = productPageBusy || catalogProductPage >= totalPages;
        if (productPageButtons) {
            productPageButtons.innerHTML = Array.from({ length: totalPages }, (_, index) => `<option value="${index + 1}"${index + 1 === catalogProductPage ? " selected" : ""}>${index + 1} / ${totalPages}</option>`).join("");
            productPageButtons.disabled = productPageBusy;
        }
        if (productPageStatus) {
            const currentCount = Array.isArray(overview.products) ? overview.products.length : 0;
            productPageStatus.textContent = total
                ? `第 ${catalogProductPage} / ${totalPages} 页 · 本页 ${currentCount} 个 · 共 ${total} 个`
                : "共 0 个商品";
        }
    };
    /** 翻页期间冻结分页操作并标记列表忙碌，防止连续点击造成请求互相覆盖。 */
    const setProductPageBusy = (busy) => {
        productPageBusy = busy;
        catalogPageLoading = busy;
        if (productPageSizeSelect) productPageSizeSelect.disabled = busy;
        sourceStoreFilter.disabled = busy;
        const blockedSelect = document.getElementById("blocked-filter");
        const searchButton = document.querySelector("#product-search-form button");
        if (blockedSelect) blockedSelect.disabled = busy;
        if (searchButton) searchButton.disabled = busy;
        updateProductPagination();
        productList?.setAttribute("aria-busy", busy ? "true" : "false");
    };
    const updateProductTotals = () => {
        const filteredTotal = Math.max(0, Number(overview.productTotal) || 0);
        const loaded = Array.isArray(overview.products) ? overview.products.length : 0;
        searchCount.textContent = `本页 ${loaded} / 共 ${filteredTotal} 个`;
        updateProductPagination();
    };
    const loadProductPage = async ({ page = catalogProductPage, background = false, canApply = () => true } = {}) => {
        const requestId = background ? filterRequestId : ++filterRequestId;
        const loadVersion = background ? catalogPageLoadVersion : ++catalogPageLoadVersion;
        const requestedPage = Math.max(1, Number(page) || 1);
        if (!background) setProductPageBusy(true);
        try {
            const pagePayload = await api(catalogPageUrl(requestedPage), { cacheMs: 2500, force: background });
            if (requestId !== filterRequestId || loadVersion !== catalogPageLoadVersion || !productList?.isConnected || !canApply()) return false;
            const nextProducts = [...(Array.isArray(pagePayload.products) ? pagePayload.products : [])];
            const filteredTotal = Math.max(0, Number(pagePayload.productTotal) || 0);
            const totalPages = Math.max(1, Math.ceil(filteredTotal / catalogProductPageSize));
            if (requestedPage > totalPages) {
                return await loadProductPage({ page: totalPages, background, canApply });
            }
            // 其他用户的入库也会改变全局信号；本页数据未变时保留原有行节点和图片。
            const rowsChanged = JSON.stringify([overview.products, overview.batches]) !== JSON.stringify([nextProducts, pagePayload.batches || []]);
            overview.productCount = Number(pagePayload.productCount) || 0;
            overview.productTotal = filteredTotal;
            overview.productPageSize = catalogProductPageSize;
            overview.productsHasMore = Boolean(pagePayload.productsHasMore);
            overview.sourceStores = Array.isArray(pagePayload.sourceStores) ? pagePayload.sourceStores : overview.sourceStores;
            overview.batches = Array.isArray(pagePayload.batches) ? pagePayload.batches : [];
            overview.products = nextProducts;
            const totalLabel = document.getElementById("catalog-product-total");
            if (totalLabel) totalLabel.textContent = overview.productCount;
            const availableSources = [...(overview.sourceStores || [])];
            // 来源店商品被清空时保留已提交筛选，不能让下拉显示“全部”而请求仍限定原店。
            if (catalogFilters.sourceStoreId && !availableSources.some(store => String(store.storeId) === catalogFilters.sourceStoreId)) {
                availableSources.push({ storeId: catalogFilters.sourceStoreId, storeName: sourceStoreFilter.selectedOptions[0]?.textContent || catalogFilters.sourceStoreId });
            }
            const sourceOptions = `<option value="">全部来源店铺</option>${availableSources.map((store) => `<option value="${escapeHtml(store.storeId)}">${escapeHtml(store.storeName || store.storeId)}</option>`).join("")}`;
            if (sourceStoreFilter.innerHTML !== sourceOptions) {
                sourceStoreFilter.innerHTML = sourceOptions;
                sourceStoreFilter.value = catalogFilters.sourceStoreId;
            }
            catalogProductPage = requestedPage;
            displayedProductState = { ...catalogFilters, page: requestedPage, size: catalogProductPageSize };
            livePaginationTargets.products = catalogProductPage;
            cacheSelectedBatches(nextProducts, overview.batches);
            for (const product of nextProducts) {
                const spuId = String(product?.spuId || "");
                if (spuId && catalogSelectedProducts.has(spuId)) catalogSelectedProducts.set(spuId, product);
            }
            if (productList && (!background || rowsChanged)) {
                productList.classList.remove("grouped");
                productList.innerHTML = renderProductRows(nextProducts, true, targetStores, overview.batches) || renderCatalogEmpty(overview);
                rows = [...productList.querySelectorAll("[data-product-row]")];
            }
            // 绑定函数自行记录已绑定状态，调用方提前标记会使新页所有行跳过事件注册。
            rows.forEach(bindProductRow);
            if ((!background || rowsChanged) && viewMode?.value === "group") viewMode.dispatchEvent(new Event("change", { bubbles: true }));
            updateProductTotals();
            syncSelection();
            return true;
        } catch (error) {
            if (background) throw error;
            if (requestId !== filterRequestId || loadVersion !== catalogPageLoadVersion || !productList?.isConnected) return;
            // 失败时维持已展示结果对应的页码和筛选，未提交的输入草稿仍保留供用户重试。
            catalogProductPage = displayedProductState.page;
            catalogProductPageSize = displayedProductState.size;
            for (const key of ["q", "sourceStoreId", "blocked"]) catalogFilters[key] = displayedProductState[key];
            sourceStoreFilter.value = catalogFilters.sourceStoreId;
            document.getElementById("blocked-filter").value = catalogFilters.blocked;
            productPageSizeSelect.value = String(catalogProductPageSize);
            const toast = document.getElementById("catalog-toast");
            if (toast) toast.innerHTML = `<div class="toast error">商品筛选失败：${escapeHtml(error.message)}</div>`;
        } finally {
            if (!background && loadVersion === catalogPageLoadVersion) {
                catalogPageLoading = false;
                if (productList?.isConnected) setProductPageBusy(false);
            }
        }
    };
    /** 商品更新仍避让勾选、弹窗及翻页；店铺状态由独立通道同步。 */
    refreshCatalogView = async (live, previous, canApply) => {
        if (!productList?.isConnected) return false;
        const inventoryChanged = live.inventory !== previous.inventory || live.claims !== previous.claims;
        if (inventoryChanged && !await loadProductPage({ background: true, canApply })) return false;
        return canApply();
    };
    let appliedTargetVersion = null;
    /** 只消费成功应用的店铺版本；失败重试不影响商品，普通心跳不重复请求目录。 */
    refreshCatalogTargets = async (live, canApply) => {
        const version = JSON.stringify([live.agents, live.claims]);
        if (version === appliedTargetVersion) return true;
        if (targetAgentsBusy || !productList?.isConnected || !canApply()) return false;
        targetAgentsBusy = true;
        try {
            // 保持用户已展开的目标店数量；按接口分页读取，不能只保留前 100 家。
            const agents = [];
            const wanted = Math.max(100, targetAgentsOffset);
            const retainedIds = new Set([...selectedTargetOptions().map(option => String(option.value)),
                ...[...batchTargetOptions, ...singleTargetOptions].filter(option => option.querySelector("input")?.checked).map(option => String(option.querySelector("input").value))]);
            const fetchedIds = new Set();
            let page;
            let directoryVersion;
            do {
                page = await api(`/temu/api/agents?online=1&receivable=1&limit=100&offset=${agents.length}`, { force: true });
                if (!canApply() || !productList.isConnected) return false;
                if (agents.length && page.directoryVersion !== directoryVersion) return false;
                directoryVersion = page.directoryVersion;
                agents.push(...(page.agents || []));
                for (const agent of page.agents || []) fetchedIds.add(String(agent.storeId));
                // 查询期间新勾选的目标也要保留，不能把移到后续页的在线店误当成离线。
                for (const option of [...batchTargetOptions, ...singleTargetOptions]) {
                    if (option.querySelector("input")?.checked) retainedIds.add(String(option.querySelector("input").value));
                }
            } while (page.hasMore && page.agents?.length && (agents.length < wanted || [...retainedIds].some(id => !fetchedIds.has(id))));
            const nextStores = agents.filter(agent => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId)
                .map(agent => ({ storeId: agent.storeId, storeName: agent.storeName || agent.pageStoreName || agent.storeId }));
            if (JSON.stringify(targetStores) !== JSON.stringify(nextStores)) {
                targetStores = nextStores;
                knownTargetStoreIds.clear();
                targetStores.forEach(store => knownTargetStoreIds.add(String(store.storeId)));
                // 按店铺 ID 复用节点，保留已提交选择、弹窗草稿、键盘焦点和滚动位置。
                const selectOptions = new Map([...batchTargetStores.options].map(option => [String(option.value), option]));
                for (const [id, option] of selectOptions) if (!knownTargetStoreIds.has(id)) option.remove();
                for (const store of targetStores) {
                    const existing = selectOptions.get(String(store.storeId));
                    if (existing) existing.textContent = store.storeName;
                    else batchTargetStores.append(new Option(store.storeName, store.storeId));
                }
                for (const prefix of ["batch", "single"]) {
                    const container = document.getElementById(`${prefix}-target-options`);
                    const options = new Map([...container.querySelectorAll(".batch-target-option")].map(option => [String(option.querySelector("input").value), option]));
                    container.querySelectorAll("p.muted").forEach(node => node.remove());
                    for (const [id, option] of options) if (!knownTargetStoreIds.has(id)) {
                        if (option.contains(document.activeElement)) document.getElementById(`${prefix}-target-search`)?.focus({ preventScroll: true });
                        option.remove();
                    }
                    for (const store of targetStores) {
                        let option = options.get(String(store.storeId));
                        if (!option) {
                            option = document.createElement("label");
                            option.className = "batch-target-option";
                            option.innerHTML = `<input type="checkbox" value="${escapeHtml(store.storeId)}"><span class="batch-target-check"></span><strong></strong><small>在线，可接收上传任务</small>`;
                            container.append(option);
                            (prefix === "batch" ? bindBatchTargetOption : bindSingleTargetOption)(option);
                        }
                        option.dataset.storeSearch = `${store.storeName} ${store.storeId}`.toLocaleLowerCase();
                        option.querySelector("strong").textContent = store.storeName;
                    }
                    if (!targetStores.length) container.innerHTML = `<p class="muted">暂无在线目标店铺。</p>`;
                }
                batchTargetOptions = [...document.querySelectorAll("#batch-target-options .batch-target-option")];
                singleTargetOptions = [...document.querySelectorAll("#single-target-options .batch-target-option")];
                batchTargetSearch?.dispatchEvent(new Event("input"));
                singleTargetSearch?.dispatchEvent(new Event("input"));
                syncSingleDialogCount();
                syncSelection();
            }
            targetAgentsOffset = agents.length;
            targetStoreTotal = Math.max(targetStores.length, Number(page.total) || 0);
            targetAgentsHasMore = Boolean(page.hasMore);
            updateTargetAgentPagination();
            appliedTargetVersion = version;
            return true;
        } finally {
            targetAgentsBusy = false;
        }
    };
    input.addEventListener("input", () => { catalogFilters.draft = input.value; });
    document.getElementById("product-search-form")?.addEventListener("submit", (event) => {
        event.preventDefault();
        if (productPageBusy) return;
        catalogFilters.q = input.value.trim();
        catalogFilters.draft = input.value;
        void loadProductPage({ page: 1 });
    });
    sourceStoreFilter?.addEventListener("change", () => {
        catalogFilters.sourceStoreId = sourceStoreFilter.value;
        if (!pendingPaginationRestore) livePaginationTargets.products = 1;
        loadProductPage({ page: 1 });
    });
    document.getElementById("blocked-filter")?.addEventListener("change", () => {
        catalogFilters.blocked = document.getElementById("blocked-filter").value;
        if (!pendingPaginationRestore) livePaginationTargets.products = 1;
        loadProductPage({ page: 1 });
    });
    batchTargetStores?.addEventListener("change", syncSelection);
    selectAll.addEventListener("change", () => {
        visibleRows().forEach((row) => {
            const box = row.querySelector(".product-checkbox");
            if (!box) return;
            box.checked = selectAll.checked;
            const product = overview.products.find((item) => String(item.spuId) === String(box.value));
            if (product) setProductSelected(product, box.checked);
        });
        syncSelection();
    });
    clearProductSelection?.addEventListener("click", () => {
        clearCatalogProductSelection();
        syncSelection();
    });
    deleteSelected.addEventListener("click", () => deleteInventoryProducts([...catalogSelectedProducts.keys()]));
    document.getElementById("unblock-selected")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        // 只解除选中的标红商品：未标红的商品无需处理，避免把正常商品也写一遍。
        const targets = [...new Set([...catalogSelectedProducts.values()]
            .filter((product) => product?.blocked)
            .map((product) => String(product.spuId || ""))
            .filter(Boolean))];
        if (!targets.length) return;
        if (!window.confirm(`确认解除 ${targets.length} 个商品的标红？解除后这些商品可以再次上传。`)) return;
        button.disabled = true;
        button.textContent = "解除中…";
        try {
            await api("/temu/api/products/unblock", { method: "POST", body: JSON.stringify({ spuIds: targets }) });
            await route({ forceRefresh: true });
        } catch (error) {
            window.alert(`解除标红失败：${error.message}`);
        } finally {
            button.disabled = false;
            button.textContent = "解除标红";
        }
    });
    const bindProductRow = (row) => {
        if (!row || row.dataset.productBound === "1") return;
        row.dataset.productBound = "1";
        row.querySelector(".product-checkbox")?.addEventListener("change", (event) => {
            const box = event.currentTarget;
            const product = overview.products.find((item) => String(item.spuId) === String(box.value));
            if (product) setProductSelected(product, box.checked);
            syncSelection();
        });
        row.querySelector("[data-delete-spu]")?.addEventListener("click", (event) => {
            event.stopPropagation();
            deleteInventoryProducts([event.currentTarget.dataset.deleteSpu]);
        });
        row.querySelector("[data-transfer-spu]")?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const button = event.currentTarget;
            const spuId = String(button.dataset.transferSpu || "");
            const product = overview.products.find(item => String(item.spuId) === spuId);
            const toast = document.getElementById("catalog-toast");
            if (singleUploadBusy || batchUploadBusy) {
                if (toast) toast.innerHTML = `<div class="toast">已有单商品上传正在处理中，请等待当前任务完成。</div>`;
                return;
            }
            if (!singleTargetDialog || !singleTargetOptions.length) {
                if (toast) toast.innerHTML = `<div class="toast error">当前没有可接收上传任务的在线目标店插件。</div>`;
                return;
            }
            singleTargetDialog.dataset.spu = spuId;
            if (singleTargetSpu) singleTargetSpu.textContent = spuId;
            resetSingleDialog();
            singleTargetDialog.showModal();
            singleTargetSearch?.focus();
        });
    };
    rows.forEach(bindProductRow);
    batchDirectCreate?.addEventListener("click", async () => {
        const toast = document.getElementById("catalog-toast");
        if (batchUploadBusy || singleUploadBusy) {
            if (toast) toast.innerHTML = `<div class="toast">批量上传正在处理中，请等待当前任务完成。</div>`;
            return;
        }
        const selectedIds = [...catalogSelectedProducts.keys()];
        const targetIds = [...(batchTargetStores?.selectedOptions || [])].map(option => String(option.value || "")).filter(Boolean);
        const targets = (targetStores || []).filter(store => targetIds.includes(String(store.storeId)));
        if (!selectedIds.length || !targets.length) {
            if (toast) toast.innerHTML = `<div class="toast error">请先选择商品和在线目标店铺。</div>`;
            return;
        }
        const products = selectedIds.map(spuId => catalogSelectedProducts.get(spuId)).filter(Boolean);
        const groups = new Map();
        const skipped = [];
        for (const product of products) {
            const sourceBatch = sourceBatchForProduct(product);
            // 历史失败只作为提示；真正缺少可追溯来源的商品仍不能创建传输任务。
            if (!sourceBatch) {
                skipped.push(String(product.spuId));
                continue;
            }
            const group = groups.get(sourceBatch.id) || { sourceBatch, spuIds: [] };
            group.spuIds.push(String(product.spuId));
            groups.set(sourceBatch.id, group);
        }
        if (!groups.size) {
            if (toast) toast.innerHTML = `<div class="toast error">所选商品缺少来源批次关联${skipped.length ? `：${escapeHtml(skipped.join("、"))}` : ""}。</div>`;
            return;
        }
        batchUploadBusy = true;
        const routeVersion = routeRequestId;
        batchDirectCreate.disabled = true;
        batchDirectCreate.textContent = "等待确认…";
        // 确认与检查也纳入同一互斥及错误恢复范围；内嵌浏览器的原生 confirm 可能被静默取消。
        try {
        const total = [...groups.values()].reduce((count, group) => count + group.spuIds.length, 0);
        if (!await confirmAction({ title: "确认批量上架", details: [`将 ${total} 个商品发送到 ${targets.length} 家目标店：`, ...targets.map(target => target.storeName), "确认表示商品符合适用要求，并同意平台《商品合规声明》V2.0。", "目标店插件会检查重复商品；创建不等于审核上架，结果待核对时不要重发。"], confirmLabel: "确认发送", destructive: false })) {
            if (toast) toast.innerHTML = `<div class="toast">已取消发送，未创建任务。</div>`;
            return;
        }
        if (!await confirmSourceStoreTargets([...groups.values()].map(group => group.sourceBatch), targets)) {
            if (toast) toast.innerHTML = `<div class="toast">已取消发送到来源店铺，本次未创建任务。</div>`;
            return;
        }
        batchDirectCreate.textContent = "检查中…";
        if (toast) toast.innerHTML = `<div class="toast">正在检查发送服务…</div>`;
        const capability = await api("/temu/api/direct-create-capability");
        if (!capability?.directCreate) throw new Error("后台尚未启用接口创建，请联系管理员启用。");
        if (routeVersion !== routeRequestId || !batchDirectCreate.isConnected) return;
        batchDirectCreate.textContent = "发送中…";
        if (toast) toast.innerHTML = `<div class="toast">正在向 ${escapeHtml(String(targets.length))} 家目标店上传 ${escapeHtml(String(total))} 个商品…</div>`;
            await submitBulkManifest([...groups.values()].map(group => ({ sourceStoreId: group.sourceBatch.sourceStoreId, sourceBatchId: group.sourceBatch.id, spuIds: group.spuIds })), targets);
            if (toast) toast.innerHTML = `<div class="toast success">发送清单已保存：${total} 个商品，${targets.length} 家店铺。${skipped.length ? `跳过 ${skipped.length} 个无来源批次商品。` : ''}<a href="#/jobs">查看分发进度</a></div>`;
            clearCatalogProductSelection();
            syncSelection();
        } catch (error) {
            if (toast) toast.innerHTML = `<div class="toast error">批量发送失败：${escapeHtml(error.message)}</div>`;
        } finally {
            batchUploadBusy = false;
            batchDirectCreate.textContent = "一键上架";
            syncSelection();
        }
    });
    /** 分页只发起当前页请求，筛选条件仍由服务端统一应用。 */
    const goToProductPage = (page) => {
        const nextPage = Math.max(1, Number(page) || 1);
        if (nextPage === catalogProductPage || productPageBusy) return;
        void loadProductPage({ page: nextPage });
    };
    productPagePrev?.addEventListener("click", () => goToProductPage(catalogProductPage - 1));
    productPageNext?.addEventListener("click", () => goToProductPage(catalogProductPage + 1));
    productPageButtons?.addEventListener("change", () => goToProductPage(productPageButtons.value));
    productPageSizeSelect?.addEventListener("change", () => {
        catalogProductPageSize = Number(productPageSizeSelect.value) || PRODUCT_PAGE_SIZE_OPTIONS[0];
        catalogProductPage = 1;
        livePaginationTargets.products = 1;
        void loadProductPage({ page: 1 });
    });
    uploadButton?.addEventListener("click", () => {
        if (files) files.value = "";
        files?.click();
    });
    files?.addEventListener("change", () => {
        if (files.files.length) {
            uploadFiles(files.files, "catalog-toast");
            files.value = "";
        }
    });

    /**
     * 按店铺分组视图。
     *
     * 为什么需要：运营清理商品时通常按店铺来（"这个店不做了"），
     * 平铺列表得逐个搜索勾选；分组后可直接整组处理。
     *
     * 分组只在视觉上把已有行归拢，不重新请求数据：
     * 直接复用渲染好的行节点，避免两套渲染逻辑产生差异。
     */
    if (viewMode && productList) {
        // 店名映射从 overview.batches 现算：sourceStores 是 renderProducts 里的局部变量，
        // 本函数拿不到它；分组标题需要「店名」而不是「storeId」。
        const nameOfStore = () => new Map((overview.batches || [])
            .filter((batch) => batch.sourceStoreId)
            .map((batch) => [String(batch.sourceStoreId), String(batch.sourceStoreName || batch.shopName || batch.sourceStoreId)]));
        const applyGrouping = () => {
            const grouped = viewMode.value === "group";
            // 先把已生成的组容器拆掉、行节点还原回列表，避免来回切换时节点丢失。
            for (const wrapper of [...productList.querySelectorAll("[data-business-product-group]")]) {
                const rowsBox = wrapper.querySelector(".business-group-rows");
                for (const row of [...(rowsBox?.children || [])]) productList.insertBefore(row, wrapper);
                wrapper.remove();
            }
            productList.classList.toggle("grouped", grouped);
            if (!grouped) return;

            const rows = [...productList.querySelectorAll("[data-product-row]")];
            const groups = new Map();
            for (const row of rows) {
                const ids = String(row.dataset.sourceStores || "").split(",").map((value) => value.trim()).filter(Boolean);
                const buckets = ids.length ? ids : [""];
                for (const storeId of buckets) {
                    if (!groups.has(storeId)) groups.set(storeId, []);
                    groups.get(storeId).push(row);
                }
            }
            // 有来源店的组按名称排序，无归属组放最后（它是待清理项）。
            const storeNames = nameOfStore();
            const ordered = [...groups.entries()].sort(([left], [right]) => {
                if (!left) return 1;
                if (!right) return -1;
                return String(storeNames.get(left) || left).localeCompare(String(storeNames.get(right) || right), "zh-Hans-CN");
            });
            for (const [storeId, groupRows] of ordered) {
                const wrapper = document.createElement("section");
                wrapper.className = "business-product-group";
                wrapper.dataset.businessProductGroup = storeId || "__unassigned__";
                const title = storeId ? (storeNames.get(storeId) || storeId) : "无归属店铺";
                wrapper.innerHTML = `
                    <header class="business-group-head">
                        <label class="select-all"><input type="checkbox" data-business-group-check><span></span>全选本组</label>
                        <strong>${escapeHtml(title)}</strong>
                        <span class="business-group-count">${groupRows.length} 个</span>
                        <button type="button" class="toolbar-button danger" data-business-group-delete="${escapeHtml(storeId)}" disabled>删除本组选中</button>
                    </header>
                    <div class="business-group-rows"></div>`;
                const rowsBox = wrapper.querySelector(".business-group-rows");
                // 行节点从列表里移到组容器内：同一个节点，事件绑定与勾选状态都保留。
                for (const row of groupRows) rowsBox.appendChild(row);
                productList.appendChild(wrapper);
            }
        };

        // 组内全选与整组删除：删除时带上该组的 storeId，避免清掉别的店那份。
        productList.addEventListener("change", (event) => {
            const box = event.target;
            if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
            if (!box.hasAttribute("data-business-group-check")) return;
            const wrapper = box.closest("[data-business-product-group]");
            for (const row of wrapper.querySelectorAll("[data-product-row]")) {
                const target = row.querySelector(".product-checkbox");
                if (!target || row.hidden) continue;
                target.checked = box.checked;
                const product = overview.products.find((item) => String(item.spuId) === String(target.value));
                if (product) setProductSelected(product, box.checked);
            }
            syncSelection();
        });
        productList.addEventListener("click", async (event) => {
            const button = event.target.closest("[data-business-group-delete]");
            if (!button) return;
            const wrapper = button.closest("[data-business-product-group]");
            const title = wrapper.querySelector("strong")?.textContent?.trim() || "本组";
            const ids = [...wrapper.querySelectorAll("[data-product-row]")]
                .filter((row) => !row.hidden)
                .map((row) => row.querySelector(".product-checkbox"))
                .filter((box) => box && box.checked)
                .map((box) => String(box.value || ""))
                .filter(Boolean);
            if (!ids.length) return;
            const storeId = button.getAttribute("data-business-group-delete") || "";
            button.disabled = true;
            try {
                const ok = await confirmInventoryRemoval(`${ids.length} 个商品（${title}）`);
                if (!ok) return;
                await api("/temu/api/products", {
                    method: "DELETE",
                    headers: { "content-type": "application/json" },
                    // 限定在本次分组内：同一 SPU 在别的店可能另有一行，不限定会跨店误删。
                    body: JSON.stringify({ spuIds: ids, storeIds: storeId ? [storeId] : [] })
                });
                clearCatalogProductSelection();
                await route();
            } catch (error) {
                const toast = document.getElementById("catalog-toast");
                if (toast) toast.innerHTML = `<div class="toast error">删除失败：${escapeHtml(error.message)}</div>`;
                button.disabled = false;
            }
        });
        // 每次勾选后同步"删除本组选中"按钮的可用状态与文案。
        const syncGroupButtons = () => {
            for (const wrapper of productList.querySelectorAll("[data-business-product-group]")) {
                const checked = [...wrapper.querySelectorAll("[data-product-row]")]
                    .filter((row) => !row.hidden)
                    .map((row) => row.querySelector(".product-checkbox"))
                    .filter((box) => box && box.checked);
                const button = wrapper.querySelector("[data-business-group-delete]");
                if (button) {
                    button.disabled = checked.length === 0;
                    button.textContent = checked.length ? `删除本组选中 ${checked.length} 个` : "删除本组选中";
                }
                const head = wrapper.querySelector("[data-business-group-check]");
                const visibleBoxes = [...wrapper.querySelectorAll("[data-product-row]")]
                    .filter((row) => !row.hidden)
                    .map((row) => row.querySelector(".product-checkbox"))
                    .filter(Boolean);
                if (head) {
                    head.checked = visibleBoxes.length > 0 && checked.length === visibleBoxes.length;
                    head.indeterminate = checked.length > 0 && checked.length < visibleBoxes.length;
                }
            }
        };
        productList.addEventListener("change", (event) => {
            if (event.target instanceof HTMLInputElement && event.target.classList.contains("product-checkbox")) syncGroupButtons();
        });
        viewMode.addEventListener("change", () => { applyGrouping(); syncSelection(); syncGroupButtons(); });
    }

    syncSelection();
    updateProductPagination();
}

/** 内嵌浏览器可能抑制原生 confirm；使用页面对话框，取消与 Escape 均不发送删除请求。 */
function confirmInventoryRemoval(description) {
    if (document.getElementById("inventory-delete-dialog")) return Promise.resolve(false);
    return new Promise(resolve => {
        const previousFocus = document.activeElement;
        const dialog = document.createElement("dialog");
        dialog.id = "inventory-delete-dialog";
        dialog.setAttribute("aria-labelledby", "inventory-delete-title");
        dialog.setAttribute("aria-describedby", "inventory-delete-description");
        dialog.style.cssText = "max-width:480px;width:calc(100% - 48px);border:1px solid #cbd5e1;border-radius:12px;padding:24px;color:#172b4d;background:white;";
        dialog.innerHTML = `<h2 id="inventory-delete-title">彻底删除所选商品？</h2><p id="inventory-delete-description">将从服务端库存、历史批次和原始采集文件中彻底删除 ${escapeHtml(description)}；同 SPU 后续上传会作为新内容重新入库。该操作不会删除店铺里的商品。</p><form method="dialog"><button class="toolbar-button" value="cancel" autofocus>取消</button> <button class="toolbar-button danger" value="delete">确认彻底删除</button></form>`;
        const onRouteChange = () => dialog.close("cancel");
        window.addEventListener("hashchange", onRouteChange, { once: true });
        dialog.addEventListener("close", () => {
            const accepted = dialog.returnValue === "delete";
            window.removeEventListener("hashchange", onRouteChange);
            dialog.remove();
            if (previousFocus?.isConnected) previousFocus.focus();
            resolve(accepted);
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    });
}

/** 删除前冻结所选 ID 并要求确认；成功后重读仓库，不再显示占据表格空间的成功提示。 */
let inventoryDeletionBusy = false;
async function deleteInventoryProducts(spuIds) {
    const ids = [...new Set((spuIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!ids.length) return;
    const description = ids.length === 1 ? `SPU ${ids[0]}` : `${ids.length} 个所选商品`;
    if (inventoryDeletionBusy || !await confirmInventoryRemoval(description)) return;
    inventoryDeletionBusy = true;
    const toast = document.getElementById("catalog-toast");
    if (toast) toast.innerHTML = `<div class="toast">正在删除 ${description}…</div>`;
    try {
        await api("/temu/api/products", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spuIds: ids })
        });
        // 删除可能连同同货号的其他 SPU 一并清理，跨页选择已不再完整，重绘前统一清空。
        clearCatalogProductSelection();
        if (location.hash.startsWith("#/product/")) location.hash = "#/products";
        else await route();
    } catch (error) {
        if (toast) toast.innerHTML = `<div class="toast error">删除失败：${escapeHtml(error.message)}</div>`;
    } finally {
        inventoryDeletionBusy = false;
    }
}

function renderImport(overview) {
    setNav("import");
    const ready = overview.products.filter((item) => item.ready);
    app.innerHTML = `
        <div class="top">
            <div class="top-copy">
                <h1>导入准备</h1>
                <p class="lede">这是隐藏的资料缺口页，不是当前主流程。日常收集请回到查验台和商品库；这里仍不会保存草稿或发布。</p>
            </div>
            <div class="top-context"><a class="back-link" href="#/">返回查验台</a></div>
        </div>
        <div class="grid-two">
            <section class="panel">
                <div class="panel-heading"><h2>当前结论</h2><span class="panel-kicker">只读检查</span></div>
                <p>标准商品 ${overview.productCount} 个，其中资料已齐 ${ready.length} 个。</p>
                <ul class="list">
                    <li>完整业务数据包：${overview.products.some((item) => item.sources.includes("full-packet")) ? "已提供" : "未提供"}</li>
                    <li>目标平台提交：未接通，转移任务只探测 Temu 新建页</li>
                    <li>类目 / 属性映射：未建立</li>
                    <li>图片二进制：插件尚未下载</li>
                    ${overview.batches.map((batch) => `<li>${escapeHtml(batch.shopName || batch.label)}：${escapeHtml(batch.readiness)}，SPU ${batch.counts.spu} / SKU ${batch.counts.sku}</li>`).join("")}
                </ul>
            </section>
            <section class="panel">
                <div class="panel-heading"><h2>以后怎么转出</h2><span class="panel-kicker">下一阶段</span></div>
                <p class="muted">插件补上完整数据包后，这里继续列出标题、类目、SKU、价格、重量、图片缺口。一键导入仍未接通；转移任务确认后也只打开 Temu 新建页并截图，不会发布。</p>
            </section>
        </div>
    `;
}

function renderBatch(batch) {
    setNav("home");
    const files = (batch.files || []).map((file) => `
        <li>
            <span class="tape">${fileKindLabel(file.kind)}</span>
            ${escapeHtml(file.originalName)}
            <a href="${siteRoot()}/api/files/${encodeURIComponent(file.storedName)}">下载</a>
        </li>
    `).join("");
    app.innerHTML = `
        <div class="top">
            <div class="top-copy">
                <h1>${escapeHtml(batch.shopName || batch.label)}</h1>
                <p class="lede">覆盖 ${batch.coverage || "—"}。本页保存 ${batch.logSaved || 0} 条响应，商品相关失败 ${batch.productFailures || 0}。响应数不是商品数。</p>
            </div>
            <span class="${stampClass(batch.status)}">${escapeHtml(batch.readiness)}</span>
        </div>
        <div class="detail-summary"><span><b>${batch.counts.spu}</b> SPU</span><span><b>${batch.counts.goods}</b> goodsId</span><span><b>${batch.counts.skc}</b> SKC</span><span><b>${batch.counts.sku}</b> SKU</span></div>
        <div class="grid-two">
            <section class="panel">
                <div class="panel-heading"><h2>原始文件</h2><span class="panel-kicker">${(batch.files || []).length} 个文件</span></div>
                <ul class="list">${files}</ul>
            </section>
            <section class="panel">
                <div class="panel-heading"><h2>核验说明</h2><span class="panel-kicker">字段分开记账</span></div>
                <p class="muted">${escapeHtml((batch.warnings || []).join(" "))}</p>
            </section>
        </div>
        <div class="section-heading detail-products-heading"><div><h2>批次商品</h2><p>点击商品查看字段完整度和来源。</p></div><span class="section-count">${(batch.products || []).length} 个 SPU</span></div>
        <div class="product-list compact" style="margin-top:0">${renderProductRows(batch.products || [], false)}</div>
    `;
}

function renderProduct(payload) {
    setNav("products");
    const product = payload.product;
    const checks = [
        ["SPU", product.completeness.hasSpu],
        ["标题", product.completeness.hasTitle],
        ["goodsId", product.completeness.hasGoods],
        ["SKC", product.completeness.hasSkc],
        ["SKU", product.completeness.hasSku],
        ["属性", product.completeness.hasAttributes],
        ["详情资料", product.completeness.hasDetail || product.completeness.hasPrimaryDetail],
        ["图片", product.completeness.hasImages]
    ];
    app.innerHTML = `
        <div class="top product-detail-top"><div class="top-copy"><h1>商品详情</h1><p class="lede">标准商品字段、来源和完整度检查。</p></div><div class="detail-actions"><a class="back-link" href="#/products">返回商品库</a><button type="button" class="toolbar-button danger" id="delete-current-product">删除商品</button></div></div>
        <div class="product-hero">
            ${renderProductMedia(product)}
            <div>
                <h2 class="product-name">${escapeHtml(product.title || product.spuId)}</h2>
                <p class="lede">${escapeHtml(product.category || "类目未还原")}</p>
                <p>SPU ID：${escapeHtml(product.spuId)}</p>
                <p>SKC ID：${escapeHtml(identifierText(product.skcIds) || "—")}</p>
                <p>货号：${escapeHtml(productExtCodes(product).join(" / ") || "—")}</p>
                <p>SKU货号：${escapeHtml(skuExtCodes(product).join(" / ") || "—")}</p>
            </div>
        </div>
        <div class="checks" style="margin:22px 0">
            ${checks.map(([label, on]) => `<div class="check ${on ? "on" : ""}">${label}　${on ? "有" : "缺"}</div>`).join("")}
        </div>
        <div class="grid-two">
            <section class="panel">
                <div class="panel-heading"><h2>SKU 与规格</h2><span class="panel-kicker">${(product.skus || product.skuIds || []).length} 条</span></div>
                <p class="muted">SKC ID：${escapeHtml(identifierText(product.skcIds) || "无")}　SKU货号：${escapeHtml(skuExtCodes(product).join(" / ") || "无")}</p>
                ${renderSkuTable(product)}
            </section>
            <section class="panel">
                <h2>来源批次</h2>
                <ul class="list">
                    ${payload.batches.map((batch) => `<li><a href="#/batch/${batch.id}">${batch.id}</a>　${escapeHtml(batch.readiness)}</li>`).join("")}
                </ul>
            </section>
            <section class="panel">
                <div class="panel-heading"><h2>商品属性</h2><span class="panel-kicker">列表资料</span></div>
                ${renderAttributeList(product)}
            </section>
            <section class="panel">
                <div class="panel-heading"><h2>商品详情正文</h2><span class="panel-kicker">${product.completeness.hasDetail ? "已读取" : (product.completeness.detailState === "source-empty" ? "源正文为空" : (product.completeness.hasPrimaryDetail ? "结构待核验" : "尚未采集"))}</span></div>
                ${product.completeness.hasDetail ? `<pre class="detail-text">${escapeHtml(JSON.stringify(product.detail, null, 2))}</pre>` : `<p class="muted empty-state">${product.completeness.detailState === "source-empty" ? "已收到对应商品的详情接口资料，接口中的正文容器为空。这不是采集失败；目标店是否要求填写正文，需要按目标类目另行核对。" : (product.completeness.hasPrimaryDetail ? "详情接口已收到，但正文结构未能确认。原始响应已保留，请导出完整包进行分析，不能认定原商品没有正文。" : "尚未确认收到对应商品的详情资料。请在 Temu 商品列表页使用新版插件采集，再上传完整包；无需逐个打开编辑页。")}</p>`}
            </section>
        </div>
    `;
    document.getElementById("delete-current-product")?.addEventListener("click", () => deleteInventoryProducts([product.spuId]));
}

function jobStatusLabel(status) {
    return JOB_STATUS_LABEL[status] || status || "未知状态";
}

/**
 * 汇总单个店铺在任务队列中的实时阶段，供状态表按列独立显示在线、部署、发送、上传和异常。
 * 这里只读现有 Agent 与任务数据，不改变任务的领取和提交规则。
 */
function storeRuntimeSummary(agent, jobs, directoryStore = null, runtimeStores = null) {
    const storeId = String(directoryStore?.storeId || agent?.storeId || "");
    const storeJobs = (jobs || []).filter((job) => String(job.targetStoreId || "") === storeId);
    const activeJobs = storeJobs.filter((job) => ["active", "attention"].includes(jobRecordGroup(job)));
    const items = activeJobs.flatMap((job) => (job.items || []).map((item) => ({ job, item })));
    // MySQL 返回完整店铺汇总，不能把分页任务或截断的商品明细误当成全部运行状态。
    const runtime = Array.isArray(runtimeStores) ? runtimeStores.find(row => row.storeId === storeId) || { queued: 0, uploading: 0, failures: 0, activeCount: 0 } : null;
    const queued = runtime ? runtime.queued : items.filter(({ item }) => ["queued", "opening", "opened", "claimed", "retry_wait"].includes(String(item.status || ""))).length;
    const uploading = runtime ? runtime.uploading : items.filter(({ item }) => ["received", "upload_opened"].includes(String(item.status || "")) || String(item.directState || "") === "creating").length;
    const failures = runtime ? runtime.failures : items.filter(({ item }) => ["failed", "identity_mismatch"].includes(String(item.status || ""))
        || ["unknown", "preflight_failed", "rejected"].includes(String(item.directState || ""))).length;
    const version = String(agent?.pluginVersion || "");
    const [major, minor, patch] = version.split('.').map(Number);
    const versionReady = major === 10 && (minor > 10 || minor === 10 && patch >= 56);
    const deployTone = !agent?.pluginDetected ? "danger" : (!versionReady || !agent?.identityMatched || !agent?.canReceiveUploads ? "warn" : "ok");
    const deployText = !agent?.pluginDetected
        ? "插件未部署"
        : (!versionReady ? `版本待升级 ${version || "未知版"}` : (!agent?.identityMatched ? "店名未核验" : "已部署可接收"));
    const onlineTone = agent?.online ? "ok" : "idle";
    const sendTone = failures ? "danger" : (queued ? "active" : "ok");
    const sendText = failures ? `${failures} 项异常` : (queued ? `${queued} 项待发送` : "无待发送");
    const uploadTone = failures ? "danger" : (uploading || Number(agent?.pendingUploadCount || 0) ? "active" : "ok");
    const uploadText = failures ? `${failures} 项异常` : (uploading || Number(agent?.pendingUploadCount || 0)
        ? `${Math.max(uploading, Number(agent?.pendingUploadCount || 0))} 项处理中`
        : "无上传任务");
    const activeCount = runtime ? runtime.activeCount : activeJobs.length;
    const runtimeTone = failures ? "danger" : (activeCount ? "active" : (agent?.online ? "ok" : "idle"));
    const current = runtime ? runtime.current : activeJobs[0];
    const currentText = current ? `${jobStatusLabel(current.status)} · ${current.id}` : "空闲";
    const errorTone = failures ? "danger" : "ok";
    const lastActivity = (runtime ? runtime.lastActivity : activeJobs.map((job) => job.updatedAt).filter(Boolean).sort().pop()) || agent?.lastSeenAt || "";
    return {
        storeId,
        storeName: String(agent?.storeName || agent?.pageStoreName || directoryStore?.name || directoryStore?.storeName || storeId || "未知店铺"),
        onlineTone,
        onlineText: agent?.online ? "在线" : "离线",
        deployTone,
        deployText,
        sendTone,
        sendText,
        uploadTone,
        uploadText,
        runtimeTone,
        currentText,
        errorTone,
        errorText: failures ? `${failures} 项需处理` : "无异常",
        failures,
        activeCount,
        lastActivity
    };
}

function statusValue(tone, text, meta = "") {
    return `<span class="runtime-value tone-${escapeHtml(tone)}"><i aria-hidden="true"></i><span><strong>${escapeHtml(text)}</strong>${meta ? `<small>${escapeHtml(meta)}</small>` : ""}</span></span>`;
}

function renderStoreRuntimeRows(rows) {
    if (!rows.length) {
        return `<tr><td colspan="8"><p class="workspace-empty">还没有读取到紫鸟店铺。请确认紫鸟客户端和 ZClaw Bridge 已启动，然后点击“刷新状态”。</p></td></tr>`;
    }
    return rows.map((row) => `<tr data-store-runtime-row data-search="${escapeHtml([row.storeName, row.storeId, row.currentText, row.deployText].join(" ").toLocaleLowerCase())}" data-tone="${escapeHtml(row.runtimeTone)}" data-failures="${row.failures}" data-active="${row.activeCount}">
        <td class="runtime-store"><strong>${escapeHtml(row.storeName)}</strong><small>${escapeHtml(row.storeId)}</small></td>
        <td>${statusValue(row.onlineTone, row.onlineText)}</td>
        <td>${statusValue(row.deployTone, row.deployText)}</td>
        <td>${statusValue(row.sendTone, row.sendText)}</td>
        <td>${statusValue(row.uploadTone, row.uploadText)}</td>
        <td class="runtime-current">${statusValue(row.runtimeTone, row.currentText.split(" · ")[0], row.currentText.split(" · ")[1] || "")}</td>
        <td>${statusValue(row.errorTone, row.errorText)}</td>
        <td class="runtime-time">${row.lastActivity ? escapeHtml(formatWorkLogTime(row.lastActivity)) : "—"}</td>
    </tr>`).join("");
}

/**
 * 任务台只给指定目标店派发领取任务。不会向所有插件广播，也不会在这一页保存草稿或发布。
 */
function renderJobs(overview, storeResult = null, storeError = null, jobs = { jobs: [], agents: [] }, targetAgentResult = { agents: [], total: 0, hasMore: false }, statusAgentResult = { agents: [] }) {
    setNav("jobs");
    const stores = storeResult && Array.isArray(storeResult.stores) ? storeResult.stores : [];
    const directoryError = String(storeResult?.error || "");
    const loadedStatusAgents = Array.isArray(statusAgentResult.agents) ? statusAgentResult.agents : [];
    let targetAgents = (Array.isArray(targetAgentResult.agents) ? targetAgentResult.agents : [])
        .filter(agent => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId);
    let targetAgentTotal = Math.max(targetAgents.length, Number(targetAgentResult.total) || 0);
    let targetAgentsHaveMore = Boolean(targetAgentResult.hasMore);
    // 旧来源失败记录仅供查看，任务台仍允许选择并发送给其他目标店。
    const readyProducts = overview.products || [];
    const toneRank = { danger: 0, warn: 1, active: 2, ok: 3, idle: 4 };
    const agentByStore = new Map(loadedStatusAgents.filter((agent) => agent.storeId).map((agent) => [String(agent.storeId), agent]));
    const directoryStores = (storeResult?.stores || []).filter((store) => store.storeId);
    const runtimeStores = [
        ...directoryStores.map((store) => ({ directoryStore: store, agent: agentByStore.get(String(store.storeId)) || null })),
        ...loadedStatusAgents
            .filter((agent) => agent.storeId && !directoryStores.some((store) => String(store.storeId) === String(agent.storeId)))
            .map((agent) => ({ directoryStore: null, agent }))
    ];
    const runtimeJobs = [...new Map([...(jobs.activeJobs || []), ...(jobs.jobs || [])].map((job) => [String(job.id || ""), job])).values()];
    const runtimeRows = runtimeStores
        .map(({ directoryStore, agent }) => storeRuntimeSummary(agent, runtimeJobs, directoryStore, jobs.runtimeStores))
        .sort((left, right) => toneRank[left.runtimeTone] - toneRank[right.runtimeTone]
            || right.failures - left.failures
            || left.storeName.localeCompare(right.storeName, "zh-CN"));
    const activeJobCount = Number(jobs.counts?.active) || 0;
    const attentionJobCount = Number(jobs.counts?.attention) || 0;
    const totalJobCount = Number(jobs.total ?? jobs.counts?.total ?? (jobs.jobs || []).length) || 0;
    const targetOptions = targetAgents.map((item) => `
        <label class="target-option" data-target-search="${escapeHtml((item.storeName || item.pageStoreName || item.storeId).toLocaleLowerCase())}">
            <input type="checkbox" value="${escapeHtml(item.storeId)}">
            <span class="target-check" aria-hidden="true"></span>
            <span class="target-option-copy"><strong>${escapeHtml(item.storeName || item.pageStoreName || item.storeId)}</strong><small>${escapeHtml(item.storeId)} · 在线，可接收上传任务</small></span>
        </label>
    `).join("");
    const productOptions = (overview.products || []).map((item) => {
        const productCodes = productExtCodes(item);
        const searchText = [item.title, item.spuId, ...(item.spuIds || []), item.goodsId, item.category, ...productCodes, ...skuExtCodes(item)].filter(Boolean).join(" ").toLocaleLowerCase();
        return `
            <label class="task-product-option" data-batch-ids="${escapeHtml((item.batchIds || []).join(","))}" data-search="${escapeHtml(searchText)}">
                <input type="checkbox" name="job-spu" value="${escapeHtml(item.spuId)}">
                <span class="task-product-check" aria-hidden="true"></span>
                <span class="task-product-copy"><strong>${escapeHtml(item.title || item.spuId)}</strong><small>SPU ${escapeHtml(item.spuId)} · 货号 ${escapeHtml(productCodes.join(" / ") || "—")}</small></span>
                <span class="task-product-state ready">来源已采集</span>
            </label>
        `;
    }).join("");
    app.innerHTML = `
        <div class="top task-top">
            <div class="top-copy">
                <h1>任务台</h1>
                <p class="lede">先看所有店铺的在线、部署、发送和上传状态，再进入创建任务；任务记录独立查看，关键操作不会被长表单挤到页面底部。</p>
            </div>
            <div class="task-top-actions">
                <div class="task-top-stats"><span><b>${runtimeRows.filter((row) => row.onlineTone === "ok").length}</b> 家在线</span><span><b>${activeJobCount}</b> 个进行中</span><span class="${attentionJobCount ? "has-attention" : ""}"><b>${attentionJobCount}</b> 个需处理</span></div>
                <button type="button" class="toolbar-button" id="refresh-job-stores">刷新状态</button>
            </div>
        </div>
        ${storeError ? `<p class="toast error">读取店铺失败：${escapeHtml(storeError.message)}。本机工人和紫鸟客户端需要先启动。</p>` : ""}
        ${!storeError && directoryError ? `<p class="toast error">全量店铺目录读取失败，当前仅显示已有心跳的店铺。请确认紫鸟客户端已启动后刷新状态。</p>` : ""}
        <nav class="task-view-tabs" aria-label="任务台视图">
            <button type="button" class="active" data-task-view-button="status" aria-selected="true">实时状态 <b>${runtimeRows.length}</b></button>
            <button type="button" data-task-view-button="create" aria-selected="false">创建任务 <b>${Number(overview.productTotal) || 0}</b></button>
            <button type="button" data-task-view-button="records" aria-selected="false">任务记录 <b>${totalJobCount}</b></button>
        </nav>
        <section class="task-view-panel live-status-panel" data-task-panel="status">
            <div class="task-record-toolbar"><h2>批量分发</h2><div><button type="button" class="toolbar-button" id="bulk-prev">上页</button><button type="button" class="toolbar-button" id="bulk-next">下页</button></div></div>
            <div class="live-status-table-wrap"><table class="live-status-table bulk-status-table"><thead><tr><th>创建时间</th><th>目标店</th><th>分发进度</th><th>状态</th><th>异常</th><th>操作</th></tr></thead><tbody id="bulk-dispatch-body"><tr><td colspan="6">加载中…</td></tr></tbody></table></div>
            <p id="bulk-dispatch-message" role="status"></p>
            <div class="live-status-toolbar">
                <label class="task-search"><span class="search-symbol" aria-hidden="true"></span><input id="store-runtime-search" type="search" placeholder="搜索店铺、ID 或当前任务" autocomplete="off"></label>
                <label><span>状态</span><select id="store-runtime-filter"><option value="all">全部状态</option><option value="danger">只看异常</option><option value="active">只看处理中</option><option value="offline">只看离线</option></select></label>
                <span class="live-status-note"><i></i>实时更新</span>
            </div>
            <div class="live-status-table-wrap">
                <table class="live-status-table">
                    <thead><tr><th>店铺</th><th>在线</th><th>插件部署</th><th>发送队列</th><th>商品上传</th><th>当前任务</th><th>异常</th><th>最后活动</th></tr></thead>
                    <tbody id="store-runtime-body">${renderStoreRuntimeRows(runtimeRows)}</tbody>
                </table>
            </div>
            <p class="live-status-empty" id="store-runtime-empty" role="status" hidden>没有匹配的店铺状态。</p>
            <div class="task-load-more" id="job-status-load-more-wrap" ${storeResult?.hasMore ? "" : "hidden"}>
                <button type="button" class="toolbar-button" id="job-status-load-more">加载更多店铺状态</button>
                <span id="job-status-load-more-status">已显示 ${runtimeRows.length} / ${Number(storeResult?.total) || runtimeRows.length} 家</span>
            </div>
        </section>
        <section class="task-view-panel task-create-panel" data-task-panel="create" hidden>
            <form id="job-form" class="task-layout">
                <div class="task-composer">
                    <section class="task-step">
                        <div class="task-step-heading"><span class="task-step-index">1</span><div><h2>来源与批次</h2><p>批次已经绑定采集店铺，来源店只用于提交前核对。</p></div></div>
                        <div class="task-field-grid">
                            <label>来源批次<select id="job-batch" required><option value="">请选择来源批次</option>${overview.batches.map((item) => `<option value="${escapeHtml(item.id)}" data-source-store="${escapeHtml(item.sourceStoreId || "")}">${escapeHtml(item.label || item.id)} · ${escapeHtml(item.sourceStoreName || item.shopName || "未知店铺")} · SPU ${item.counts.spu}</option>`).join("")}</select><button type="button" class="toolbar-button" id="job-batch-more" ${overview.batchesHasMore ? '' : 'hidden'}>加载更多批次</button></label>
                            <label>识别到的来源店铺<select id="job-source-store" disabled aria-describedby="job-source-note"><option value="">选择批次后自动识别</option>${stores.map((item) => `<option value="${escapeHtml(item.storeId)}">${escapeHtml(item.name)} (${escapeHtml(item.storeId)})</option>`).join("")}</select><small id="job-source-note" class="field-note">来源店铺由批次采集信息锁定，避免选错店铺。</small></label>
                        </div>
                    </section>
                    <section class="task-step">
                        <div class="task-step-heading"><span class="task-step-index">2</span><div><h2>目标店铺</h2><p>只显示在线、插件在场且店名已核验的目标店。</p></div><button type="button" class="toolbar-button" id="job-target-trigger" ${targetAgents.length ? "" : "disabled"}>选择目标店铺</button></div>
                        <select id="job-target-store" class="visually-hidden" multiple aria-hidden="true" tabindex="-1">${targetAgents.map((item) => `<option value="${escapeHtml(item.storeId)}">${escapeHtml(item.storeName || item.pageStoreName || item.storeId)}</option>`).join("")}</select>
                        <div class="selection-chips" id="job-target-chips"><span class="selection-empty">尚未选择目标店铺</span></div>
                    </section>
                    <section class="task-step">
                        <div class="task-step-heading"><span class="task-step-index">3</span><div><h2>选择商品</h2><p>商品由服务端分页筛选；可以按名称、货号或 SPU 跨页搜索。</p></div><span class="selection-count" id="job-product-visible-count">${readyProducts.length} / ${Number(overview.productTotal) || 0} 个已加载</span></div>
                        <div class="task-product-tools">
                            <label class="task-search"><span class="search-symbol" aria-hidden="true"></span><input id="job-product-search" type="search" placeholder="搜索商品名称、货号或 SPU" autocomplete="off"></label>
                            <label class="task-check-toggle"><input id="job-select-visible" type="checkbox"><span>全选当前结果</span></label>
                        </div>
                        <div class="transfer-products task-product-list" id="job-products">${productOptions || `<span class="workspace-empty">当前商品库为空，请先从来源店采集入库。</span>`}</div>
                        <div class="task-load-more" id="job-product-load-more-wrap" ${overview.productsHasMore ? "" : "hidden"}>
                            <button type="button" class="toolbar-button" id="job-product-load-more">加载更多商品</button>
                            <span id="job-product-load-more-status">已显示 ${readyProducts.length} / ${Number(overview.productTotal) || 0} 个</span>
                        </div>
                    </section>
                </div>
                <aside class="task-summary" aria-label="提交摘要">
                    <div class="task-summary-head"><span>提交摘要</span><strong>接口创建</strong></div>
                    <dl>
                        <div><dt>已选商品</dt><dd id="job-summary-products">0</dd></div>
                        <div><dt>目标店铺</dt><dd id="job-summary-stores">0</dd></div>
                        <div><dt>预计任务数</dt><dd id="job-summary-jobs">0</dd></div>
                    </dl>
                    <p>创建不等于审核上架。结果待核对时不要重发，先在目标店商品列表确认货号状态。</p>
                    <button class="toolbar-button primary task-submit" id="job-submit" type="submit" ${targetAgents.length && Number(overview.productTotal) ? "" : "disabled"}>确认并接口创建</button>
                    <span id="job-message" class="task-message" role="status"></span>
                </aside>
            </form>
        </section>
        <dialog id="job-target-dialog" class="target-dialog" aria-labelledby="job-target-dialog-title">
            <form method="dialog">
                <div class="target-dialog-head"><div><h2 id="job-target-dialog-title">选择目标店铺</h2><p>可多选。展开的是店铺名称和 ID，提交前还能在摘要中复核。</p></div><button type="submit" value="cancel" class="dialog-close" aria-label="关闭">×</button></div>
                <label class="target-search"><span class="search-symbol" aria-hidden="true"></span><input id="job-target-search" type="search" placeholder="搜索店铺名称或 ID" autocomplete="off"></label>
                <label class="target-select-all"><input id="job-target-select-all" type="checkbox"><span>全选当前店铺</span></label>
                <div class="target-options" id="job-target-options">${targetOptions || `<p class="workspace-empty">暂无在线目标店铺。</p>`}</div>
                <div class="task-load-more" id="job-target-load-more-wrap" ${targetAgentsHaveMore ? "" : "hidden"}><button type="button" class="toolbar-button" id="job-target-load-more">加载更多目标店铺</button><span id="job-target-load-more-status">已显示 ${targetAgents.length} / ${targetAgentTotal} 家</span></div>
                <div class="target-dialog-footer"><span id="job-target-dialog-count">已选择 0 家店铺</span><button type="submit" value="apply" class="toolbar-button primary">完成选择</button></div>
            </form>
        </dialog>
        <section class="task-view-panel task-records-panel" data-task-panel="records" hidden>
            <div class="task-record-toolbar">
                <div><h2>任务记录</h2><p>共 ${totalJobCount} 条任务，当前已加载 ${(jobs.jobs || []).length} 条；筛选只作用于已加载记录。</p></div>
                <div class="record-filters" role="group" aria-label="任务状态筛选">
                    <button type="button" class="filter-chip active" data-job-filter="attention">需处理</button>
                    <button type="button" class="filter-chip" data-job-filter="active">进行中</button>
                    <button type="button" class="filter-chip" data-job-filter="done">已完成</button>
                    <button type="button" class="filter-chip" data-job-filter="all">全部</button>
                </div>
            </div>
            <div class="transfer-jobs" id="job-records">${jobs.jobs.map(renderHubJob).join("") || `<p class="workspace-empty">还没有跨店任务。</p>`}</div>
            <div class="task-load-more" id="job-load-more-wrap" ${jobs.hasMore ? "" : "hidden"}>
                <button type="button" class="toolbar-button" id="job-load-more">加载更多任务</button>
                <span id="job-load-more-status"></span>
            </div>
        </section>
    `;
    let bulkOffset = 0;
    let bulkGeneration = 0;
    const bulkFailurePages = new Map();
    /** 分页查看失败商品，缓存仅限当前批次页；不把整批异常明细塞进常规SSE刷新。 */
    const renderBulkFailures = (batch) => {
        if (!batch.failed) return '';
        const page = bulkFailurePages.get(batch.id) || { failures: batch.failureSamples || [], offset: 0, hasMore: batch.failed > 20 };
        const names = new Map(batch.targets.map(target => [target.storeId, target.storeName]));
        return `<details ${bulkFailurePages.has(batch.id) ? 'open' : ''}><summary>${batch.failed} 件分发失败</summary>${page.failures.map(item => `<p>${escapeHtml(names.get(item.storeId) || item.storeId)} · SPU ${escapeHtml(item.spuId)}：${escapeHtml(item.reason)}</p>`).join('')}<div><button class="toolbar-button" data-bulk-id="${batch.id}" data-failure-offset="${Math.max(0, page.offset - 20)}" ${page.offset === 0 ? 'disabled' : ''}>上一页</button><span> 第 ${Math.floor(page.offset / 20) + 1} 页 </span><button class="toolbar-button" data-bulk-id="${batch.id}" data-failure-offset="${page.offset + 20}" ${page.hasMore ? '' : 'disabled'}>下一页</button></div></details>`;
    };
    /** 分发与执行分开显示；SSE 只更新表格正文，不重建创建任务表单或清掉勾选。 */
    const refreshBulk = async () => {
        const body = document.getElementById('bulk-dispatch-body');
        if (!body) return;
        // 翻页和SSE可能同时返回，过期响应不得覆盖当前页。
        const generation = ++bulkGeneration, offset = bulkOffset;
        const page = await api(`/temu/api/bulk-dispatch?offset=${offset}`);
        if (!body.isConnected || generation !== bulkGeneration || offset !== bulkOffset) return;
        const labels = { queued: '分发中', paused: '分发暂停', completed: '分发完成', completed_errors: '分发结束（有失败）', cancelled: '已停止分发' };
        for (const id of bulkFailurePages.keys()) if (!page.batches.some(batch => batch.id === id)) bulkFailurePages.delete(id);
        const html = page.batches.map(batch => {
            const issues = batch.targets.filter(target => target.error);
            const issueDetails = (issues.length ? `<details><summary>${issues.length} 家等待或异常</summary>${issues.map(target => `<p>${escapeHtml(target.storeName)}：${escapeHtml(target.error)}</p>`).join('')}</details>` : '') + renderBulkFailures(batch);
            return `<tr><td>${escapeHtml(formatWorkLogTime(batch.createdAt))}</td><td>${batch.targets.length} 家</td><td>${batch.sent} / ${batch.total}${batch.failed ? `<br>失败 ${batch.failed}` : ''}</td><td>${escapeHtml(labels[batch.status] || batch.status)}</td><td>${issueDetails || '无'}</td><td>${!['completed','completed_errors','cancelled'].includes(batch.status) ? `${batch.targets.some(target => target.paused) ? `<button class="toolbar-button" data-bulk-id="${batch.id}" data-bulk-action="resume">继续分发</button>` : ''}<button class="toolbar-button" data-bulk-id="${batch.id}" data-bulk-action="cancel">停止分发</button>` : ''}</td></tr>`;
        }).join('') || '<tr><td colspan="6">暂无批量分发记录</td></tr>';
        if (body.innerHTML !== html && !body.contains(document.activeElement)) body.innerHTML = html;
        document.getElementById('bulk-prev').disabled = bulkOffset === 0;
        document.getElementById('bulk-next').disabled = !page.hasMore;
    };
    const bulkError = error => { const node = document.getElementById('bulk-dispatch-message'); if (node) node.textContent = error.message; };
    document.getElementById('bulk-prev')?.addEventListener('click', () => { bulkOffset = Math.max(0, bulkOffset - 20); void refreshBulk().catch(bulkError); });
    document.getElementById('bulk-next')?.addEventListener('click', () => { bulkOffset += 20; void refreshBulk().catch(bulkError); });
    document.getElementById('bulk-dispatch-body')?.addEventListener('click', async event => {
        const button = event.target.closest('[data-bulk-id]');
        if (!button) return;
        const { bulkId, bulkAction } = button.dataset;
        if (button.dataset.failureOffset !== undefined) {
            button.disabled = true;
            try {
                const page = await api(`/temu/api/bulk-dispatch/${bulkId}/failures?offset=${button.dataset.failureOffset}`);
                if (!button.isConnected) return;
                bulkFailurePages.set(bulkId, page); button.blur(); await refreshBulk();
            } catch (error) { bulkError(error); }
            finally { if (button.isConnected) button.disabled = false; }
            return;
        }
        if (bulkAction === 'cancel' && !await confirmAction({ title: '停止剩余分发', details: ['尚未分发的商品将停止。已分发到店铺的任务不会撤回，结果待核对的商品不会重发。'], confirmLabel: '停止分发' })) return;
        button.disabled = true;
        try { await api(`/temu/api/bulk-dispatch/${bulkId}/${bulkAction}`, { method: 'POST' }); button.blur(); await refreshBulk(); }
        catch (error) { bulkError(error); }
        finally { if (button.isConnected) button.disabled = false; }
    });
    void refreshBulk().catch(bulkError);
    const taskViewButtons = [...app.querySelectorAll("[data-task-view-button]")];
    const showTaskView = (name) => {
        taskViewButtons.forEach((button) => {
            const active = button.getAttribute("data-task-view-button") === name;
            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", active ? "true" : "false");
        });
        app.querySelectorAll("[data-task-panel]").forEach((panel) => {
            panel.hidden = panel.getAttribute("data-task-panel") !== name;
        });
    };
    taskViewButtons.forEach((button) => button.addEventListener("click", () => showTaskView(button.getAttribute("data-task-view-button") || "status")));
    const runtimeSearch = document.getElementById("store-runtime-search");
    const runtimeFilter = document.getElementById("store-runtime-filter");
    const runtimeRowsElements = [...app.querySelectorAll("[data-store-runtime-row]")];
    const runtimeEmpty = document.getElementById("store-runtime-empty");
    const applyRuntimeFilter = () => {
        const query = String(runtimeSearch?.value || "").trim().toLocaleLowerCase();
        const filter = String(runtimeFilter?.value || "all");
        let visible = 0;
        runtimeRowsElements.forEach((row) => {
            const matchesQuery = !query || String(row.dataset.search || "").includes(query);
            const tone = String(row.dataset.tone || "");
            const matchesFilter = filter === "all"
                || (filter === "danger" && tone === "danger")
                || (filter === "active" && tone === "active")
                || (filter === "offline" && tone === "idle");
            row.hidden = !(matchesQuery && matchesFilter);
            if (!row.hidden) visible += 1;
        });
        if (runtimeEmpty) runtimeEmpty.hidden = visible !== 0;
    };
    runtimeSearch?.addEventListener("input", applyRuntimeFilter);
    runtimeFilter?.addEventListener("change", applyRuntimeFilter);
    let loadedStoreStatusCount = runtimeRowsElements.length;
    let loadedStatusAgentCount = loadedStatusAgents.length;
    const knownStatusAgentIds = new Set(loadedStatusAgents.map((agent) => String(agent.storeId || "")).filter(Boolean));
    const knownRuntimeStoreIds = new Set(runtimeRowsElements.map((row) => String(row.querySelector(".runtime-store small")?.textContent || "")));
    const loadMoreStoreStatus = async (event = null) => {
        const button = event?.currentTarget || document.getElementById("job-status-load-more");
        const status = document.getElementById("job-status-load-more-status");
        if (button) {
            button.disabled = true;
            button.textContent = "加载中…";
        }
        try {
            const [page, agentPage] = await Promise.all([
                api(`/temu/api/ziniao/stores?scope=all&refresh=0&limit=100&offset=${loadedStoreStatusCount}`, { cacheMs: 3000 }),
                api(`/temu/api/agents?limit=100&offset=${loadedStatusAgentCount}`, { cacheMs: 3000 }).catch(() => ({ agents: [] }))
            ]);
            for (const agent of agentPage.agents || []) {
                const storeId = String(agent.storeId || "");
                if (!storeId || knownStatusAgentIds.has(storeId)) continue;
                knownStatusAgentIds.add(storeId);
                agentByStore.set(storeId, agent);
            }
            loadedStatusAgentCount += Array.isArray(agentPage.agents) ? agentPage.agents.length : 0;
            const additions = [];
            for (const store of page.stores || []) {
                const storeId = String(store.storeId || "");
                if (!storeId || knownRuntimeStoreIds.has(storeId)) continue;
                knownRuntimeStoreIds.add(storeId);
                additions.push(storeRuntimeSummary(agentByStore.get(storeId) || null, runtimeJobs, store, jobs.runtimeStores));
            }
            const tbody = document.getElementById("store-runtime-body");
            tbody?.insertAdjacentHTML("beforeend", renderStoreRuntimeRows(additions));
            if (additions.length) {
                runtimeRowsElements.push(...[...(tbody?.querySelectorAll("[data-store-runtime-row]") || [])].slice(-additions.length));
            }
            loadedStoreStatusCount += Array.isArray(page.stores) ? page.stores.length : 0;
            if (status) status.textContent = `已显示 ${runtimeRowsElements.length} / ${Number(page.total) || runtimeRowsElements.length} 家`;
            const wrap = document.getElementById("job-status-load-more-wrap");
            if (wrap) wrap.hidden = !page.hasMore;
            applyRuntimeFilter();
        } catch (error) {
            if (status) status.textContent = `加载失败：${error.message}`;
        } finally {
            if (button) {
                button.disabled = false;
                button.textContent = "加载更多店铺状态";
            }
        }
    };
    document.getElementById("job-status-load-more")?.addEventListener("click", loadMoreStoreStatus);
    window.setTimeout(() => {
        const restoredStoreStatusCount = Math.max(
            takeRestoredPageCount("storeStatus"),
            Number(livePaginationTargets.storeStatus) || 0
        );
        if (restoredStoreStatusCount > runtimeRowsElements.length) {
            void (async () => {
                while (runtimeRowsElements.length < restoredStoreStatusCount && document.getElementById("job-status-load-more-wrap")?.hidden === false) {
                    await loadMoreStoreStatus();
                }
            })();
        }
    }, 0);
    document.getElementById("refresh-job-stores")?.addEventListener("click", () => {
        forceStoreDirectoryRefresh = true;
        route();
    });
    const sourceStoreSelect = document.getElementById("job-source-store");
    const batchSelect = document.getElementById("job-batch");
    let batchDirectoryOffset = overview.batches.length;
    document.getElementById('job-batch-more')?.addEventListener('click', async event => {
        const button = event.currentTarget; button.disabled = true;
        try {
            const page = await api(`/temu/api/overview?productLimit=0&includeAllBatches=1&batchLimit=100&batchOffset=${batchDirectoryOffset}`);
            batchDirectoryOffset += page.batches.length;
            for (const batch of page.batches) {
                if (overview.batches.some(existing => existing.id === batch.id)) continue;
                overview.batches.push(batch);
                const option = document.createElement('option'); option.value = batch.id; option.dataset.sourceStore = batch.sourceStoreId || '';
                option.textContent = `${batch.label || batch.id} · ${batch.sourceStoreName || batch.shopName || '未知店铺'} · SPU ${batch.counts.spu}`;
                batchSelect.append(option);
            }
            button.hidden = !page.batchesHasMore;
        } catch (error) { const message = document.getElementById('job-message'); if (message) message.textContent = error.message; }
        finally { button.disabled = false; }
    });
    const targetDialog = document.getElementById("job-target-dialog");
    const targetStoreSelect = document.getElementById("job-target-store");
    let targetChecks = [...targetDialog.querySelectorAll('input[type="checkbox"][value]')];
    let productChecks = [];
    let productLabels = [];
    const productSearch = document.getElementById("job-product-search");
    const selectVisible = document.getElementById("job-select-visible");
    const targetDialogCount = document.getElementById("job-target-dialog-count");
    const targetDialogSelectAll = document.getElementById("job-target-select-all");
    const summaryProducts = document.getElementById("job-summary-products");
    const summaryStores = document.getElementById("job-summary-stores");
    const summaryJobs = document.getElementById("job-summary-jobs");
    const submitButton = document.getElementById("job-submit");
    const jobProductList = document.getElementById("job-products");
    const jobProductLoadMore = document.getElementById("job-product-load-more");
    const jobProductLoadMoreWrap = document.getElementById("job-product-load-more-wrap");
    const jobProductLoadMoreStatus = document.getElementById("job-product-load-more-status");
    const selectedJobSpus = new Set();
    const loadedJobProducts = new Map();
    const knownTargetAgentIds = new Set(targetAgents.map((agent) => String(agent.storeId || "")).filter(Boolean));
    let targetAgentOffset = targetAgents.length;
    let targetAgentsBusy = false;
    const selectedTargetIds = () => [...targetStoreSelect.selectedOptions].map(option => String(option.value || "")).filter(Boolean);
    const updateTaskSummary = () => {
        const productCount = selectedJobSpus.size;
        const storeCount = selectedTargetIds().length;
        if (summaryProducts) summaryProducts.textContent = productCount;
        if (summaryStores) summaryStores.textContent = storeCount;
        if (summaryJobs) summaryJobs.textContent = productCount * storeCount;
        if (submitButton) submitButton.disabled = !(productCount && storeCount);
    };
    const renderTargetSelection = () => {
        const selected = new Set(selectedTargetIds());
        targetChecks.forEach(input => { input.checked = selected.has(String(input.value)); });
        [...targetStoreSelect.options].forEach(option => { option.selected = selected.has(String(option.value)); });
        const names = [...targetStoreSelect.selectedOptions].map(option => option.textContent || option.value);
        const chips = document.getElementById("job-target-chips");
        if (chips) chips.innerHTML = names.length ? names.map(name => `<span class="selection-chip">${escapeHtml(name)}</span>`).join("") : `<span class="selection-empty">尚未选择目标店铺</span>`;
        if (targetDialogCount) targetDialogCount.textContent = `已选择 ${names.length} 家店铺`;
        updateTaskSummary();
    };
    const applyTargetDialogFilter = () => {
        const query = String(document.getElementById("job-target-search")?.value || "").trim().toLocaleLowerCase();
        const visible = [];
        targetChecks.forEach(input => {
            const option = input.closest(".target-option");
            const matches = !query || String(option?.dataset.targetSearch || "").includes(query);
            option.hidden = !matches;
            if (matches) visible.push(input);
        });
        if (targetDialogSelectAll) {
            const checked = visible.filter(input => input.checked).length;
            targetDialogSelectAll.checked = visible.length > 0 && checked === visible.length;
            targetDialogSelectAll.indeterminate = checked > 0 && checked < visible.length;
        }
    };
    const bindTargetCheck = (input) => input.addEventListener("change", () => {
        const option = [...targetStoreSelect.options].find(item => String(item.value) === String(input.value));
        if (option) option.selected = input.checked;
        renderTargetSelection();
        applyTargetDialogFilter();
    });
    const cacheJobProducts = (products = []) => {
        for (const product of products) {
            const spuId = String(product?.spuId || "");
            if (spuId) loadedJobProducts.set(spuId, product);
        }
    };
    const syncJobProductSelection = () => {
        productChecks = [...jobProductList.querySelectorAll('input[name="job-spu"]')];
        productLabels = [...jobProductList.querySelectorAll(".task-product-option")];
        productChecks.forEach((input) => { input.checked = selectedJobSpus.has(String(input.value)); });
        const checked = productChecks.filter((input) => input.checked).length;
        if (selectVisible) {
            selectVisible.checked = productChecks.length > 0 && checked === productChecks.length;
            selectVisible.indeterminate = checked > 0 && checked < productChecks.length;
        }
        const count = document.getElementById("job-product-visible-count");
        if (count) count.textContent = `${productChecks.length} / ${Math.max(0, Number(overview.productTotal) || 0)} 个已加载`;
        if (jobProductLoadMoreStatus) jobProductLoadMoreStatus.textContent = `已显示 ${productChecks.length} / ${Math.max(0, Number(overview.productTotal) || 0)} 个`;
        if (jobProductLoadMoreWrap) jobProductLoadMoreWrap.hidden = !overview.productsHasMore;
        updateTaskSummary();
    };
    const jobProductUrl = (offset = 0) => {
        const params = new URLSearchParams({
            productLimit: "100",
            productOffset: String(Math.max(0, Number(offset) || 0))
        });
        const batchId = batchSelect?.value || "";
        const query = String(productSearch?.value || "").trim();
        if (batchId) params.set("sourceBatchId", batchId);
        if (query) params.set("productQ", query);
        return `/temu/api/overview?${params.toString()}`;
    };
    let jobProductRequestId = 0;
    const loadJobProductPage = async ({ append = false, restoreCount = null } = {}) => {
        const requestId = ++jobProductRequestId;
        const desiredCount = append
            ? 0
            : (restoreCount == null
                ? Math.max(takeRestoredPageCount("jobProducts"), Number(livePaginationTargets.jobProducts) || 0)
                : restoreCount);
        if (jobProductLoadMore) {
            jobProductLoadMore.disabled = true;
            jobProductLoadMore.textContent = append ? "加载中…" : "筛选中…";
        }
        jobProductList?.setAttribute("aria-busy", "true");
        try {
            const offset = append ? loadedJobProducts.size : 0;
            let page = await api(jobProductUrl(offset), { cacheMs: 2500 });
            if (requestId !== jobProductRequestId) return;
            const products = [...(Array.isArray(page.products) ? page.products : [])];
            let productsHasMore = Boolean(page.productsHasMore);
            while (!append && productsHasMore && products.length < desiredCount) {
                page = await api(jobProductUrl(products.length), { cacheMs: 2500 });
                if (requestId !== jobProductRequestId) return;
                products.push(...(Array.isArray(page.products) ? page.products : []));
                productsHasMore = Boolean(page.productsHasMore) && Array.isArray(page.products) && page.products.length > 0;
            }
            cacheJobProducts(products);
            overview.productTotal = Math.max(0, Number(page.productTotal) || 0);
            overview.productsHasMore = productsHasMore;
            if (append) overview.products = [...(overview.products || []), ...products];
            else overview.products = products;
            if (!append) selectedJobSpus.clear();
            if (jobProductList) {
                const html = products.map((item) => {
                    const productCodes = productExtCodes(item);
                    const searchText = [item.title, item.spuId, ...(item.spuIds || []), item.goodsId, item.category, ...productCodes, ...skuExtCodes(item)].filter(Boolean).join(" ").toLocaleLowerCase();
                    return `
                        <label class="task-product-option" data-batch-ids="${escapeHtml((item.batchIds || []).join(","))}" data-search="${escapeHtml(searchText)}">
                            <input type="checkbox" name="job-spu" value="${escapeHtml(item.spuId)}">
                            <span class="task-product-check" aria-hidden="true"></span>
                            <span class="task-product-copy"><strong>${escapeHtml(item.title || item.spuId)}</strong><small>SPU ${escapeHtml(item.spuId)} · 货号 ${escapeHtml(productCodes.join(" / ") || "—")}</small></span>
                            <span class="task-product-state ready">来源已采集</span>
                        </label>`;
                }).join("");
                if (append) jobProductList.insertAdjacentHTML("beforeend", html);
                else jobProductList.innerHTML = html || `<span class="workspace-empty">没有符合当前条件的商品。</span>`;
            }
            syncJobProductSelection();
        } catch (error) {
            if (requestId !== jobProductRequestId) return;
            const message = document.getElementById("job-message");
            if (message) message.textContent = `商品筛选失败：${error.message}`;
        } finally {
            if (requestId === jobProductRequestId) {
                jobProductList?.setAttribute("aria-busy", "false");
                if (jobProductLoadMore) {
                    jobProductLoadMore.disabled = false;
                    jobProductLoadMore.textContent = "加载更多商品";
                }
            }
        }
    };
    const syncSourceFromBatch = () => {
        const option = batchSelect?.selectedOptions?.[0];
        const batchStoreId = option?.getAttribute("data-source-store") || "";
        if (sourceStoreSelect && batchStoreId) sourceStoreSelect.value = batchStoreId;
        const batchId = batchSelect?.value || "";
        if (batchId) {
            for (const spuId of [...selectedJobSpus]) {
                const product = loadedJobProducts.get(spuId);
                if (!product || !(product.batchIds || []).map(String).includes(batchId)) selectedJobSpus.delete(spuId);
            }
        }
        loadJobProductPage();
    };
    batchSelect?.addEventListener("change", () => {
        if (!pendingPaginationRestore) livePaginationTargets.jobProducts = 100;
        syncSourceFromBatch();
    });
    let jobProductDebounce = 0;
    productSearch?.addEventListener("input", () => {
        if (!pendingPaginationRestore) livePaginationTargets.jobProducts = 100;
        window.clearTimeout(jobProductDebounce);
        jobProductDebounce = window.setTimeout(() => loadJobProductPage(), 250);
    });
    selectVisible?.addEventListener("change", () => {
        productChecks.forEach((input) => {
            const spuId = String(input.value || "");
            if (selectVisible.checked) selectedJobSpus.add(spuId);
            else selectedJobSpus.delete(spuId);
        });
        syncJobProductSelection();
    });
    jobProductList?.addEventListener("change", (event) => {
        const input = event.target.closest?.('input[name="job-spu"]');
        if (!input) return;
        const spuId = String(input.value || "");
        if (input.checked) selectedJobSpus.add(spuId);
        else selectedJobSpus.delete(spuId);
        syncJobProductSelection();
    });
    jobProductLoadMore?.addEventListener("click", () => loadJobProductPage({ append: true }));
    document.getElementById("job-target-trigger")?.addEventListener("click", () => {
        applyTargetDialogFilter();
        targetDialog.showModal();
    });
    document.getElementById("job-target-search")?.addEventListener("input", applyTargetDialogFilter);
    targetChecks.forEach(bindTargetCheck);
    const loadMoreJobTargetAgents = async (event = null) => {
        if (targetAgentsBusy || !targetAgentsHaveMore) return;
        const button = event?.currentTarget || document.getElementById("job-target-load-more");
        const status = document.getElementById("job-target-load-more-status");
        targetAgentsBusy = true;
        if (button) {
            button.disabled = true;
            button.textContent = "加载中…";
        }
        try {
            const page = await api(`/temu/api/agents?online=1&receivable=1&limit=100&offset=${targetAgentOffset}`, { cacheMs: 2500 });
            const additions = (page.agents || []).filter((agent) => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId && !knownTargetAgentIds.has(String(agent.storeId)));
            for (const agent of additions) {
                const storeId = String(agent.storeId);
                const storeName = String(agent.storeName || agent.pageStoreName || storeId);
                knownTargetAgentIds.add(storeId);
                targetAgents.push(agent);
                agentByStore.set(storeId, agent);
                targetStoreSelect.append(new Option(storeName, storeId));
                const label = document.createElement("label");
                label.className = "target-option";
                label.dataset.targetSearch = `${storeName} ${storeId}`.toLocaleLowerCase();
                label.innerHTML = `<input type="checkbox" value="${escapeHtml(storeId)}"><span class="target-check" aria-hidden="true"></span><span class="target-option-copy"><strong>${escapeHtml(storeName)}</strong><small>${escapeHtml(storeId)} · 在线，可接收上传任务</small></span>`;
                document.getElementById("job-target-options")?.append(label);
                const input = label.querySelector('input[type="checkbox"]');
                if (input) {
                    targetChecks.push(input);
                    bindTargetCheck(input);
                }
            }
            targetAgentOffset += Array.isArray(page.agents) ? page.agents.length : 0;
            targetAgentTotal = Math.max(targetAgents.length, Number(page.total) || 0);
            targetAgentsHaveMore = Boolean(page.hasMore);
            if (status) status.textContent = `已显示 ${targetAgents.length} / ${targetAgentTotal} 家`;
            const wrap = document.getElementById("job-target-load-more-wrap");
            if (wrap) wrap.hidden = !targetAgentsHaveMore;
            applyTargetDialogFilter();
        } catch (error) {
            if (status) status.textContent = `加载失败：${error.message}`;
        } finally {
            targetAgentsBusy = false;
            if (button) {
                button.disabled = false;
                button.textContent = "加载更多目标店铺";
            }
        }
    };
    document.getElementById("job-target-load-more")?.addEventListener("click", loadMoreJobTargetAgents);
    window.setTimeout(() => {
        const restoredJobTargetAgentCount = Math.max(
            takeRestoredPageCount("jobTargetAgents"),
            Number(livePaginationTargets.jobTargetAgents) || 0
        );
        if (restoredJobTargetAgentCount > targetAgents.length && targetAgentsHaveMore) {
            void (async () => {
                while (targetAgents.length < restoredJobTargetAgentCount && targetAgentsHaveMore && !targetAgentsBusy) {
                    await loadMoreJobTargetAgents();
                }
            })();
        }
    }, 0);
    targetDialogSelectAll?.addEventListener("change", () => {
        targetChecks.filter(input => !input.closest(".target-option")?.hidden).forEach(input => {
            input.checked = targetDialogSelectAll.checked;
            const option = [...targetStoreSelect.options].find(item => String(item.value) === String(input.value));
            if (option) option.selected = input.checked;
        });
        renderTargetSelection();
        applyTargetDialogFilter();
    });
    targetStoreSelect?.addEventListener("change", renderTargetSelection);
    renderTargetSelection();
    cacheJobProducts(overview.products || []);
    syncJobProductSelection();
    syncSourceFromBatch();
    document.getElementById("job-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("job-message");
        const selectedBatch = overview.batches.find((item) => item.id === batchSelect?.value);
        const sourceStoreId = selectedBatch?.sourceStoreId || sourceStoreSelect?.value || "";
        const targetStoreIds = [...(document.getElementById("job-target-store")?.selectedOptions || [])].map((option) => String(option.value || "")).filter(Boolean);
        const sourceBatchId = document.getElementById("job-batch")?.value || "";
        const sourceStoreName = selectedBatch?.sourceStoreName || selectedBatch?.shopName || stores.find((item) => item.storeId === sourceStoreId)?.name || "";
        const selectedTargets = targetAgents.filter((item) => targetStoreIds.includes(String(item.storeId)));
        const targetStoreNames = selectedTargets.map((item) => item.storeName || item.pageStoreName || item.storeId);
        // 商品可跨页选择，提交必须读取持久选择集合，不能只收集当前 DOM 中已加载的勾选项。
        const spuIds = [...selectedJobSpus];
        if (!message) return;
        if (selectedBatch && selectedBatch.sourceStoreId && selectedBatch.sourceStoreId !== sourceStoreId) {
            message.textContent = "来源店必须和该批次采集时的店铺一致。";
            return;
        }
        if (!sourceBatchId || !sourceStoreId) {
            message.textContent = "请选择已经绑定来源店铺的采集批次。";
            return;
        }
        if (!targetStoreIds.length) {
            message.textContent = "请至少选择一个目标店铺。";
            return;
        }
        if (selectedTargets.length !== targetStoreIds.length) {
            message.textContent = "所选目标店铺已离线，请刷新店铺列表后重试。";
            return;
        }
        if (!spuIds.length) { message.textContent = "请至少选择一个商品。"; return; }
        if (batchUploadBusy || singleUploadBusy) { message.textContent = "已有发送操作正在处理中。"; return; }
        // 页面内确认是异步的，必须在等待操作者时锁住提交，防止多次点击叠加任务。
        batchUploadBusy = true;
        const routeVersion = routeRequestId;
        const submitButton = event.submitter;
        if (submitButton) submitButton.disabled = true;
        try {
            if (!await confirmAction({ title: "确认创建任务", details: [`将 ${spuIds.length} 个商品发送到：`, ...targetStoreNames, "确认表示商品符合适用要求，并同意平台《商品合规声明》V2.0。", "创建不等于审核上架，结果待核对时不要重发。"], confirmLabel: "确认发送", destructive: false })
                || !await confirmSourceStoreTargets([{ sourceStoreId, sourceStoreName }], selectedTargets)) {
                message.textContent = "已取消发送，未创建任务。";
                return;
            }
            message.textContent = "正在检查发送服务…";
            const capability = await api("/temu/api/direct-create-capability");
            if (!capability?.directCreate) throw new Error("后台尚未启用接口创建，请联系管理员启用。");
            if (routeVersion !== routeRequestId || !message.isConnected) return;
            message.textContent = `正在为 ${targetStoreNames.length} 家目标店创建任务…`;
            await submitBulkManifest([{ sourceStoreId, sourceBatchId, spuIds }], selectedTargets);
            message.textContent = `发送清单已保存：${spuIds.length} 个商品，${selectedTargets.length} 家店铺；分发进度见实时状态。`;
            // 成功后清空这次选择，不用延迟重绘覆盖下一次确认；新任务记录由实时通道更新。
            selectedJobSpus.clear();
            syncJobProductSelection();
        } catch (error) {
            message.textContent = `创建失败：${error.message}`;
        } finally {
            batchUploadBusy = false;
            if (submitButton) submitButton.disabled = false;
        }
    });
    let loadedJobCount = (jobs.jobs || []).length;
    const records = document.getElementById("job-records");
    const loadMoreButton = document.getElementById("job-load-more");
    const loadMoreWrap = document.getElementById("job-load-more-wrap");
    const loadMoreStatus = document.getElementById("job-load-more-status");
    const bindJobActions = (root = app) => {
        root.querySelectorAll("[data-job-action]:not([data-job-action-bound])").forEach((button) => {
            button.dataset.jobActionBound = "1";
            button.addEventListener("click", async () => {
                const id = button.getAttribute("data-job-id");
                const action = button.getAttribute("data-job-action");
                const storeId = button.getAttribute("data-job-store") || "";
                const spuId = button.getAttribute("data-job-spu") || "";
                const retryMode = button.getAttribute("data-retry-mode") || "retry";
                const label = button.textContent;
                // 结果未知的商品重发过就会在目标店生成重复商品，必须先由操作者确认目标店没有该货号。
                if (action === "retry" && !(await confirmDirectRetry(spuId, retryMode))) return;
                button.disabled = true;
                button.textContent = "处理中…";
                try {
                    if (action === "retry") {
                        await api("/temu/api/jobs/direct-retry", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({ jobId: id, storeId, spuId, confirmed: true })
                        });
                    } else {
                        await api(`/temu/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
                    }
                    await route();
                } catch (error) {
                    button.disabled = false;
                    button.textContent = label;
                    alert(`${action === "retry" ? "重新排队" : "取消"}失败：${error.message}`);
                }
            });
        });
    };
    const activeJobFilter = () => app.querySelector("[data-job-filter].active")?.getAttribute("data-job-filter") || "all";
    const applyJobFilter = () => {
        const filter = activeJobFilter();
        records?.querySelectorAll(".job-record").forEach((record) => {
            record.hidden = filter !== "all" && record.getAttribute("data-job-group") !== filter;
        });
    };
    app.querySelectorAll("[data-job-filter]").forEach(button => {
        button.addEventListener("click", () => {
            app.querySelectorAll("[data-job-filter]").forEach(item => item.classList.toggle("active", item === button));
            applyJobFilter();
        });
        if (button.getAttribute("data-job-filter") === "attention") button.click();
    });
    loadMoreButton?.addEventListener("click", async () => {
        loadMoreButton.disabled = true;
        loadMoreButton.textContent = "加载中…";
        if (loadMoreStatus) loadMoreStatus.textContent = "";
        try {
            const page = await api(`/temu/api/jobs?limit=50&offset=${loadedJobCount}`);
            const nextJobs = Array.isArray(page.jobs) ? page.jobs : [];
            records.insertAdjacentHTML("beforeend", nextJobs.map(renderHubJob).join(""));
            loadedJobCount += nextJobs.length;
            bindJobActions(records);
            applyJobFilter();
            if (!page.hasMore) loadMoreWrap.hidden = true;
            loadMoreButton.disabled = false;
            loadMoreButton.textContent = "加载更多任务";
            const loadedText = document.querySelector(".task-records-panel .task-record-toolbar p");
            if (loadedText) loadedText.textContent = `共 ${Number(page.total) || loadedJobCount} 条任务，当前已加载 ${loadedJobCount} 条；筛选只作用于已加载记录。`;
        } catch (error) {
            loadMoreButton.disabled = false;
            loadMoreButton.textContent = "重新加载";
            if (loadMoreStatus) loadMoreStatus.textContent = `加载失败：${error.message}`;
        }
    });
    bindJobActions();
    refreshTaskPanels = async () => {
        const tbody = document.getElementById('store-runtime-body');
        if (!tbody || singleUploadBusy || batchUploadBusy || document.querySelector('dialog[open]')) return false;
        const fresh = await api(`/temu/api/jobs?limit=${Math.min(200, loadedJobCount || 50)}&offset=0&includeAgents=0`);
        const agents = [];
        let offset = 0, version;
        do {
            const page = await api(`/temu/api/agents?limit=100&offset=${offset}`);
            if (version && page.directoryVersion !== version) return false;
            version = page.directoryVersion; agents.push(...page.agents); offset += page.agents.length;
            if (!page.hasMore || !page.agents.length) break;
        } while (offset < 500);
        if (!tbody.isConnected) return false;
        const byStore = new Map(agents.map(agent => [agent.storeId, agent]));
        const directory = runtimeRowsElements.map(row => ({ storeId: row.querySelector('.runtime-store small')?.textContent || '', name: row.querySelector('.runtime-store strong')?.textContent || '' }));
        const rows = directory.map(store => storeRuntimeSummary(byStore.get(store.storeId), fresh.jobs, store, fresh.runtimeStores));
        const html = renderStoreRuntimeRows(rows);
        if (tbody.innerHTML !== html) tbody.innerHTML = html;
        runtimeRowsElements.splice(0, runtimeRowsElements.length, ...tbody.querySelectorAll('[data-store-runtime-row]'));
        applyRuntimeFilter();
        // 已加载记录按ID就地替换；用户正在聚焦的记录下一次再更新，保留展开状态和创建表单草稿。
        for (const job of fresh.jobs) {
            const existing = [...records.querySelectorAll('.job-record')].find(node => node.dataset.jobId === job.id);
            if (existing?.contains(document.activeElement)) continue;
            const template = document.createElement('template'); template.innerHTML = renderHubJob(job);
            const next = template.content.firstElementChild;
            if (existing) { if ('open' in existing) next.open = existing.open; existing.replaceWith(next); }
            else if (loadedJobCount <= 50) records.prepend(next);
        }
        while (records.querySelectorAll('.job-record').length > Math.max(50, loadedJobCount)) records.querySelector('.job-record:last-of-type')?.remove();
        bindJobActions(records); applyJobFilter();
        await refreshBulk();
        return true;
    };
}

/**
 * 判断一个接口任务商品项能否人工重置，并区分两种语义：
 * retry = 平台侧可能已经受理过，必须先核对目标店没有相同货号；
 * requeue = 快照已送达但提交从未开始，重新排队不会在平台生成商品。
 */
function directRetryMode(item) {
    const state = String(item && item.directState || "");
    // 已取消的项目会保留历史 directState，不能再给它人工重试入口，否则取消过的商品会被重新排队。
    if (!item || item.status === "cancelled") return "";
    if (DIRECT_RETRYABLE_STATES.includes(state)) return "retry";
    if (item && item.status === "received" && !state) return "requeue";
    if (state === "creating" && Date.parse(String(item && item.directUpdatedAt || "")) < Date.now() - DIRECT_STALE_MS) return "retry";
    return "";
}

/** 内嵌浏览器可能抑制原生 confirm；重发确认改用页面对话框，取消与 Escape 都不发送请求。 */
function confirmDirectRetry(spuId, mode) {
    if (document.getElementById("direct-retry-dialog")) return Promise.resolve(false);
    const description = mode === "requeue"
        ? `SPU ${escapeHtml(spuId)} 尚未提交到目标店，将重新排队等目标店插件处理。`
        : `SPU ${escapeHtml(spuId)} 的上一次提交结果未确认，重新排队会再次调用新增接口。请先在目标店商品列表确认没有相同货号，否则可能生成重复商品。`;
    return new Promise(resolve => {
        const previousFocus = document.activeElement;
        const dialog = document.createElement("dialog");
        dialog.id = "direct-retry-dialog";
        dialog.setAttribute("aria-labelledby", "direct-retry-title");
        dialog.setAttribute("aria-describedby", "direct-retry-description");
        dialog.style.cssText = "max-width:520px;width:calc(100% - 48px);border:1px solid #cbd5e1;border-radius:12px;padding:24px;color:#172b4d;background:white;";
        dialog.innerHTML = `<h2 id="direct-retry-title">重新排队该商品？</h2><p id="direct-retry-description">${description}</p><form method="dialog"><button class="toolbar-button" value="cancel" autofocus>取消</button> <button class="toolbar-button primary" value="retry">确认重新排队</button></form>`;
        const onRouteChange = () => dialog.close("cancel");
        window.addEventListener("hashchange", onRouteChange, { once: true });
        dialog.addEventListener("close", () => {
            const accepted = dialog.returnValue === "retry";
            window.removeEventListener("hashchange", onRouteChange);
            dialog.remove();
            if (previousFocus?.isConnected) previousFocus.focus();
            resolve(accepted);
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    });
}

function jobRecordGroup(job) {
    const status = String(job?.status || "");
    if (status === 'cancelled' || status === 'completed') return 'done';
    const itemStates = (job?.items || []).filter(item => item.status !== 'cancelled').map(item => String(item.directState || ""));
    if (itemStates.some(state => ["unknown", "preflight_failed", "rejected"].includes(state))
        || ["failed", "blocked_preflight", "identity_mismatch"].includes(status)
        || (job.items || []).some(item => ['failed','blocked','identity_mismatch'].includes(item.status))) return "attention";
    if (itemStates.includes("creating")) return "active";
    // 接口任务完成后 job.status 仍可能停在 received，实际是否结束要看商品项的 directState。
    if (itemStates.length && itemStates.every(state => ["created", "duplicate_exists"].includes(state))) return "done";
    if (ACTIVE_ITEM_STATUSES.has(status) || (job.items || []).some(item => ACTIVE_ITEM_STATUSES.has(item.status))) return "active";
    return "done";
}

function renderHubJob(job) {
    const actions = [];
    if (["queued", "blocked_preflight"].includes(job.status)) {
        actions.push(`<button type="button" class="toolbar-button" data-job-action="cancel" data-job-id="${escapeHtml(job.id)}">取消</button>`);
    }
    // 项目已经停下却仍在占位的任务（partial）同样要能取消，否则同店同货号会被永久挡住。
    const stuckItems = (job.items || []).filter((item) => ACTIVE_ITEM_STATUSES.has(String(item.status || "")));
    const blockedFromCancel = (job.items || []).some((item) => ACTIVE_ITEM_STATUSES.has(item.status) && ["creating", "unknown"].includes(String(item.directState || "")));
    if (!actions.length && stuckItems.length && !blockedFromCancel) {
        actions.push(`<button type="button" class="toolbar-button" data-job-action="cancel" data-job-id="${escapeHtml(job.id)}">取消未完成项</button>`);
    }
    const items = (job.items || []).map((item) => {
        const mode = directRetryMode(item);
        const reset = mode
            ? `<button type="button" class="toolbar-button" data-job-action="retry" data-job-id="${escapeHtml(job.id)}" data-job-store="${escapeHtml(job.targetStoreId || "")}" data-job-spu="${escapeHtml(item.spuId)}" data-retry-mode="${escapeHtml(mode)}">${mode === "requeue" ? "重新排队" : "人工确认重试"}</button>`
            : "";
        const state = String(item.directState || "");
        const stateClass = ["unknown", "preflight_failed", "rejected"].includes(state) ? "attention" : (state === "created" || state === "duplicate_exists" ? "done" : "");
        return `<li class="${stateClass}"><span>SPU ${escapeHtml(item.spuId)}</span><span>${escapeHtml(DIRECT_ITEM_LABEL[item.directState] || jobStatusLabel(item.status))}</span><span>${escapeHtml(item.reason || "")}</span>${reset}</li>`;
    }).join("");
    return `<article class="transfer-job job-record" data-job-id="${escapeHtml(job.id)}" data-job-group="${jobRecordGroup(job)}">
        <strong>${escapeHtml(job.id)}</strong>
        <span>${escapeHtml(job.sourceStoreName || job.sourceStoreId)} → ${escapeHtml(job.targetStoreName || job.targetStoreId)}</span>
        <span>${escapeHtml(jobStatusLabel(job.status))}</span>
        <div class="transfer-job-actions">${actions.join("")}</div>
        <small>${escapeHtml(job.preflight && job.preflight.note || "")}</small>
        ${items ? `<ul class="transfer-item-list">${items}</ul>` : ""}
    </article>`;
}

/** 工作日志删除只清该店最近操作记录，不撤销已发送或已创建的商品。 */
function confirmWorkLogRemoval(storeName) {
    if (document.getElementById("work-log-delete-dialog")) return Promise.resolve(false);
    return new Promise(resolve => {
        const previousFocus = document.activeElement;
        const dialog = document.createElement("dialog");
        dialog.id = "work-log-delete-dialog";
        dialog.setAttribute("aria-labelledby", "work-log-delete-title");
        dialog.setAttribute("aria-describedby", "work-log-delete-description");
        dialog.style.cssText = "max-width:480px;width:calc(100% - 48px);border:1px solid #cbd5e1;border-radius:12px;padding:24px;color:#172b4d;background:white;";
        dialog.innerHTML = `<h2 id="work-log-delete-title">删除该店工作日志？</h2><p id="work-log-delete-description">将清除 ${escapeHtml(storeName)} 最近 15 天的操作记录。已发送任务和平台商品不会被撤销。</p><form method="dialog"><button class="toolbar-button" value="cancel" autofocus>取消</button> <button class="toolbar-button danger" value="delete">确认删除</button></form>`;
        const onRouteChange = () => dialog.close("cancel");
        window.addEventListener("hashchange", onRouteChange, { once: true });
        dialog.addEventListener("close", () => {
            const accepted = dialog.returnValue === "delete";
            window.removeEventListener("hashchange", onRouteChange);
            dialog.remove();
            if (previousFocus?.isConnected) previousFocus.focus();
            resolve(accepted);
        }, { once: true });
        document.body.append(dialog);
        dialog.showModal();
    });
}

const WORK_LOG_LABEL = {
    web_task_created: "网页创建发送任务",
    web_task_replaced: "旧任务被新任务替换",
    web_task_cancelled: "网页取消任务",
    plugin_claimed: "目标插件领取商品",
    plugin_received: "目标插件已接收商品",
    plugin_upload_opened: "操作者打开上传页",
    plugin_uploaded: "操作者确认已上传",
    direct_creating: "新增接口提交中",
    direct_created: "平台已创建（不等于审核上架）",
    direct_rejected: "平台拒绝（未创建）",
    direct_duplicate_exists: "重复跳过（未创建）",
    direct_unknown: "结果待核对（禁止重发）",
    direct_preflight_failed: "预检失败（未提交）",
    direct_manual_retry: "人工确认后重新排队"
};

const WORK_LOG_OUTCOME = {
    attention: { label: "需处理", className: "attention" },
    active: { label: "处理中", className: "active" },
    done: { label: "已完成", className: "done" }
};

function workLogOutcome(entry) {
    const type = String(entry?.type || "");
    if (["direct_unknown", "direct_preflight_failed", "direct_rejected", "failed", "blocked", "web_task_replaced"].includes(type)) return "attention";
    if (["direct_created", "direct_duplicate_exists", "plugin_uploaded"].includes(type)) return "done";
    return "active";
}

function workLogStoreSourceLabels(store) {
    return [...new Set([
        store.sourceStoreName,
        store.sourceLabel,
        store.sourceStoreId,
        ...(store.entries || []).flatMap((entry) => [entry.sourceStoreName, entry.sourceStoreId])
    ].map((value) => String(value || "").trim()).filter(Boolean))];
}

/** 工作日志使用店铺索引加右侧时间线；筛选只影响当前视图，不重新请求后端。 */
function renderWorkLogs(payload = { entries: [], stores: [] }, jobsPayload = { agents: [] }, storePayload = { stores: [] }) {
    setNav("logs");
    const loggedStores = Array.isArray(payload.stores) ? payload.stores : groupWorkLogEntries(payload.entries || []);
    const storeMap = new Map(loggedStores.map((store) => [String(store.storeId || ""), store]));
    const agentByStore = new Map((jobsPayload.agents || [])
        .filter((agent) => agent.storeId)
        .map((agent) => [String(agent.storeId), agent]));
    for (const directoryStore of storePayload.stores || []) {
        const storeId = String(directoryStore.storeId || "");
        if (!storeId) continue;
        const agent = agentByStore.get(storeId);
        const existing = storeMap.get(storeId);
        if (existing) {
            existing.online = Boolean(agent?.online || directoryStore.online);
            existing.storeName = existing.storeName || agent?.storeName || agent?.pageStoreName || directoryStore.name || storeId;
            continue;
        }
        storeMap.set(storeId, {
            storeId,
            storeName: agent?.storeName || agent?.pageStoreName || directoryStore.name || storeId,
            online: Boolean(agent?.online || directoryStore.online),
            updatedAt: agent?.lastSeenAt || directoryStore.lastSeenAt || "",
            entries: []
        });
    }
    for (const agent of jobsPayload.agents || []) {
        const storeId = String(agent.storeId || "");
        if (!storeId) continue;
        const existing = storeMap.get(storeId);
        if (existing) {
            existing.online = Boolean(agent.online);
            existing.storeName = existing.storeName || agent.storeName || agent.pageStoreName || storeId;
            continue;
        }
        storeMap.set(storeId, {
            storeId,
            storeName: agent.storeName || agent.pageStoreName || storeId,
            online: Boolean(agent.online),
            updatedAt: agent.lastSeenAt || "",
            entries: []
        });
    }
    const stores = [...storeMap.values()].sort((left, right) => {
        if (Boolean(left.online) !== Boolean(right.online)) return left.online ? -1 : 1;
        return String(right.updatedAt || "").localeCompare(String(left.updatedAt || ""));
    });
    const entries = stores.flatMap((store) => store.entries || []);
    const attentionCount = entries.filter(entry => workLogOutcome(entry) === "attention").length;
    const typeOptions = [...new Set(entries.map(entry => String(entry.type || "")).filter(Boolean))]
        .sort()
        .map(type => `<option value="${escapeHtml(type)}">${escapeHtml(WORK_LOG_LABEL[type] || type)}</option>`)
        .join("");
    const storeNav = stores.map((store) => {
        const sourceLabels = workLogStoreSourceLabels(store);
        const latestAt = (store.entries || []).map(entry => entry.at).filter(Boolean).sort().pop() || "";
        const searchIndex = [store.storeName, store.storeId, ...sourceLabels].filter(Boolean).join(" ").toLocaleLowerCase();
        return `<button type="button" class="log-store-button ${store.online ? "is-online" : ""}" data-log-store="${escapeHtml(store.storeId)}" data-search="${escapeHtml(searchIndex)}"><span class="log-store-marker"></span><span class="log-store-copy"><strong>${escapeHtml(store.storeName || store.storeId)}</strong><small>${store.online ? "在线" : "离线"} · ${escapeHtml(store.storeId)}${sourceLabels.length ? ` · 来源 ${escapeHtml(sourceLabels.join("、"))}` : ""}</small></span><span class="log-store-counts"><b data-store-visible-count>0</b><small>条</small>${latestAt ? `<time>${escapeHtml(formatWorkLogTime(latestAt))}</time>` : ""}</span></button>`;
    }).join("");
    app.innerHTML = `
        <div class="top work-log-top">
            <div class="top-copy"><h1>工作日志</h1><p class="lede">所有已登记店铺保留最近 15 天操作。新日志会自动出现，手动刷新入口固定在页面顶部。</p></div>
            <div class="work-log-top-actions">
                <div class="work-log-stats"><span><b>${stores.length}</b> 家店铺</span><span><b>${entries.length}</b> 条记录</span><span class="${attentionCount ? "has-attention" : ""}"><b>${attentionCount}</b> 条需处理</span></div>
                <button type="button" class="toolbar-button primary" id="refresh-work-log">刷新日志</button>
                <span class="auto-refresh-note"><i></i>实时更新</span>
            </div>
        </div>
        <section class="panel log-toolbar" aria-label="工作日志筛选">
            <label class="task-search"><span class="search-symbol" aria-hidden="true"></span><input id="work-log-search" type="search" placeholder="搜索店铺、来源店、任务号或 SPU" autocomplete="off"></label>
            <label><span>处理结果</span><select id="work-log-outcome"><option value="">全部结果</option><option value="attention">只看需处理</option><option value="active">处理中</option><option value="done">已完成</option></select></label>
            <label><span>动作类型</span><select id="work-log-type"><option value="">全部动作</option>${typeOptions}</select></label>
            <label><span>时间范围</span><select id="work-log-time"><option value="all">最近 15 天</option><option value="hour">近 1 小时</option><option value="today">今天</option><option value="day">近 24 小时</option></select></label>
        </section>
        <div class="work-log-workspace">
            <aside class="work-log-index" aria-label="店铺索引">
                <div class="work-log-index-head"><strong>店铺</strong><span id="work-log-visible-stores">${stores.length} 家</span></div>
                <div class="work-log-store-nav" id="work-log-store-nav">${storeNav || `<p class="workspace-empty">还没有已登记店铺。</p>`}</div>
            </aside>
            <section class="work-log-detail" aria-live="polite">
                <div class="work-log-detail-head"><div><h2 id="work-log-detail-title">选择店铺</h2><p id="work-log-detail-meta">左侧选择店铺后查看最近 15 天操作时间线。</p></div><button type="button" class="toolbar-button danger" id="clear-current-log" disabled>删除该店日志</button></div>
                <div class="work-log-timeline" id="work-log-timeline"><p class="workspace-empty">该店铺最近 15 天暂无操作记录。</p></div>
            </section>
        </div>
        <p class="work-log-no-results" id="work-log-no-results" role="status" hidden>没有匹配的日志，请调整搜索词或筛选条件。</p>
    `;
    bindWorkLogControls(stores);
    document.getElementById("refresh-work-log")?.addEventListener("click", () => route());
    document.getElementById("clear-current-log")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        const storeId = button.getAttribute("data-store-id") || "";
        const store = stores.find(item => String(item.storeId) === storeId);
        if (!storeId || !(await confirmWorkLogRemoval(store?.storeName || storeId))) return;
        button.disabled = true;
        try {
            await api("/temu/api/work-log", {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ storeId })
            });
            await route();
        } catch (error) {
            button.disabled = false;
            button.textContent = `删除失败：${error.message}`;
        }
    });
}

function bindWorkLogControls(stores) {
    const search = document.getElementById("work-log-search");
    const outcomeFilter = document.getElementById("work-log-outcome");
    const typeFilter = document.getElementById("work-log-type");
    const timeFilter = document.getElementById("work-log-time");
    const noResults = document.getElementById("work-log-no-results");
    const navButtons = [...document.querySelectorAll("[data-log-store]")];
    const detailTitle = document.getElementById("work-log-detail-title");
    const detailMeta = document.getElementById("work-log-detail-meta");
    const timeline = document.getElementById("work-log-timeline");
    const clearButton = document.getElementById("clear-current-log");
    const visibleStores = document.getElementById("work-log-visible-stores");
    let selectedStoreId = stores[0] ? String(stores[0].storeId) : "";

    const entryMatches = (entry, query, outcome, type, startAt) => {
        const at = Date.parse(String(entry.at || ""));
        const text = [entry.message, entry.jobId, entry.spuId, entry.sourceStoreName, entry.sourceStoreId, entry.type, WORK_LOG_LABEL[entry.type]].filter(Boolean).join(" ").toLocaleLowerCase();
        return (!query || text.includes(query))
            && (!outcome || workLogOutcome(entry) === outcome)
            && (!type || String(entry.type || "") === type)
            && (!startAt || (Number.isFinite(at) && at >= startAt));
    };
    const timeStart = () => {
        const value = timeFilter?.value || "all";
        if (value === "hour") return Date.now() - 60 * 60 * 1000;
        if (value === "day") return Date.now() - 24 * 60 * 60 * 1000;
        if (value === "today") {
            const now = new Date();
            return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        }
        return 0;
    };
    const renderTimeline = (store, visibleEntries) => {
        if (!store) {
            timeline.innerHTML = `<p class="workspace-empty">该店铺最近 15 天暂无操作记录。</p>`;
            return;
        }
        detailTitle.textContent = store.storeName || store.storeId;
        const sourceLabels = workLogStoreSourceLabels(store);
        detailMeta.textContent = `${store.storeId}${sourceLabels.length ? ` · 来源 ${sourceLabels.join("、")}` : ""} · 当前显示 ${visibleEntries.length} 条`;
        if (clearButton) {
            clearButton.disabled = !(store.entries || []).length;
            clearButton.setAttribute("data-store-id", String(store.storeId));
        }
        timeline.innerHTML = visibleEntries.map(entry => {
            const outcome = workLogOutcome(entry);
            const meta = WORK_LOG_OUTCOME[outcome];
            return `<article class="log-event outcome-${meta.className}">
                <span class="log-event-line" aria-hidden="true"></span>
                <div class="log-event-card">
                    <div class="log-event-head"><time datetime="${escapeHtml(entry.at || "")}">${escapeHtml(formatWorkLogTime(entry.at))}</time><span class="log-outcome-badge">${meta.label}</span><strong>${escapeHtml(WORK_LOG_LABEL[entry.type] || entry.type || "操作")}</strong></div>
                    <p>${escapeHtml(entry.message || "无补充说明")}</p>
                    <div class="log-event-meta"><span>任务 ${escapeHtml(entry.jobId || "—")}</span><span>SPU ${escapeHtml(entry.spuId || "—")}</span>${entry.sourceStoreName || entry.sourceStoreId ? `<span>来源 ${escapeHtml(entry.sourceStoreName || entry.sourceStoreId)}</span>` : ""}</div>
                </div>
            </article>`;
        }).join("") || `<p class="workspace-empty">该店铺在最近 15 天内没有符合当前筛选条件的记录。</p>`;
    };
    const applyFilters = () => {
        const query = String(search?.value || "").trim().toLocaleLowerCase();
        const outcome = outcomeFilter?.value || "";
        const type = typeFilter?.value || "";
        const startAt = timeStart();
        let visibleStoreCount = 0;
        let visibleEntryCount = 0;
        const visibleByStore = new Map();
        const hasRecordFilter = Boolean(outcome || type || startAt);
        stores.forEach(store => {
            const storeSearch = [store.storeName, store.storeId, ...workLogStoreSourceLabels(store)].filter(Boolean).join(" ").toLocaleLowerCase();
            const storeMatches = !query || storeSearch.includes(query);
            const matchedEntries = (store.entries || []).filter(entry => entryMatches(entry, query, outcome, type, startAt));
            // 默认保留零日志店铺，便于确认全量店铺是否已接入；启用记录条件后再隐藏无匹配店铺。
            const visibleEntries = storeMatches && !hasRecordFilter ? (store.entries || []) : matchedEntries;
            const showStore = storeMatches && (!hasRecordFilter || visibleEntries.length > 0);
            visibleByStore.set(String(store.storeId), visibleEntries);
            const nav = navButtons.find(button => button.getAttribute("data-log-store") === String(store.storeId));
            if (nav) {
                nav.hidden = !showStore;
                const count = nav.querySelector("[data-store-visible-count]");
                if (count) count.textContent = visibleEntries.length;
            }
            if (showStore) {
                visibleStoreCount += 1;
                visibleEntryCount += visibleEntries.length;
            }
        });
        const selectedStoreVisible = navButtons.find(button => button.getAttribute("data-log-store") === String(selectedStoreId))?.hidden === false;
        if (!selectedStoreVisible) {
            selectedStoreId = stores.find(store => navButtons.find(button => button.getAttribute("data-log-store") === String(store.storeId))?.hidden === false)?.storeId || "";
        }
        navButtons.forEach(button => button.classList.toggle("active", button.getAttribute("data-log-store") === String(selectedStoreId)));
        const selectedStore = stores.find(store => String(store.storeId) === String(selectedStoreId));
        renderTimeline(selectedStore, selectedStore ? visibleByStore.get(String(selectedStore.storeId)) || [] : []);
        if (visibleStores) visibleStores.textContent = `${visibleStoreCount} 家`;
        if (detailMeta && selectedStore) detailMeta.textContent += ` · 共 ${visibleEntryCount} 条结果`;
        if (noResults) noResults.hidden = visibleEntryCount !== 0 || stores.length === 0;
    };
    navButtons.forEach(button => button.addEventListener("click", () => {
        selectedStoreId = button.getAttribute("data-log-store") || "";
        applyFilters();
    }));
    search?.addEventListener("input", applyFilters);
    [outcomeFilter, typeFilter, timeFilter].forEach(control => control?.addEventListener("change", applyFilters));
    applyFilters();
}

/**
 * 我的店铺：认领页。
 * 三态显示——待认领可认领、我认领的可解除、他人认领的仅可见不可操作（按业务要求：可见但不能再次认领）。
 * 认领即建立"店铺→账号"归属，此后该店铺的商品、任务与日志都归到本账号；数据随店铺走，不需要搬移。
 */
/**
 * 店铺页：两个分类 + 搜索 + 红绿灯。
 *
 * 「在线店铺」是插件连接过的全部店铺（可认领，他人已认领的可见但不可再认领）；
 * 「我的店铺」是我认领的店铺（含离线，可解除认领）。
 * 绿点表示插件当前在线（35 秒内有心跳），红点表示离线；在线集中在上，离线在下。
 */
function renderStores(payload = { stores: [] }, successMessage = "", minePayload = { stores: [] }, focusId = "", activeStoreView = activeClaimView) {
    setNav("stores");
    const stores = Array.isArray(payload.stores) ? payload.stores : [];
    const mineStores = Array.isArray(minePayload.stores) ? minePayload.stores : [];
    const counts = payload.counts || {};
    const filters = payload.filters || {};
    const mineFilters = minePayload.filters || {};
    // 当前页出现已被认领的店铺时撤销其旧选择，最终认领权限仍由服务端再次核验。
    for (const store of stores) {
        const id = String(store.storeId);
        if (store.claimState !== "unclaimed") selectedClaimStores.delete(id);
        else if (selectedClaimStores.has(id)) selectedClaimStores.set(id, { storeId: id, storeName: store.storeName || id });
    }
    const unclaimedCount = Number(counts.unclaimed) || 0;
    const othersCount = Number(counts.others) || 0;
    const maskName = (store) => escapeHtml(store.ownerNameMasked || store.ownerName || "—");

    /**
     * 单个店铺行。
     * 信息按"灯 + 店名 / 标识与插件 / 归属账户 / 按钮"四段排布，去掉重复表达：
     * 绿灯已经表示在线，就不再写"在线"二字；归属账户已经写明是谁，就不再写"已绑定账户"。
     * 只有离线店铺额外标出最后在线时间——那是唯一需要解释"为什么是红灯"的信息。
     */
    const rowOf = (store, allowSelection = true) => {
        const state = store.claimState;
        const action = state === "unclaimed"
            ? `<button type="button" class="toolbar-button primary" data-claim-store="${escapeHtml(store.storeId)}" data-claim-name="${escapeHtml(store.storeName || "")}">认领</button>`
            : (state === "mine"
                ? `<button type="button" class="toolbar-button danger" data-release-store="${escapeHtml(store.storeId)}" data-release-name="${escapeHtml(store.storeName || "")}">解除认领</button>`
                : `<button type="button" class="toolbar-button" disabled title="该店铺已被其他账号认领">已被认领</button>`);
        // 灰色底表示"已认领"，让运营一眼看出哪些还没分配。
        const claimed = state === "mine" || state === "others";
        const lastSeen = store.lastSeenAt ? String(store.lastSeenAt).replace("T", " ").slice(0, 16) : "";
        // 归属账户：未认领时明确写"未认领"（这是一个需要行动的状态，不能留空）；已认领写账号。
        const ownerText = state === "unclaimed" ? "未认领" : maskName(store);
        const meta = [escapeHtml(store.storeId)];
        if (store.pluginVersion) meta.push(`插件 ${escapeHtml(store.pluginVersion)}`);
        if (!store.online && lastSeen) meta.push(`最后在线 ${escapeHtml(lastSeen)}`);
        // 选择列必须在所有店铺行中保持可见；已认领店铺禁用勾选，并直接说明不能批量认领的原因。
        const selection = !allowSelection
            ? ""
            : (() => {
                const claimable = state === "unclaimed";
                const lockReason = state === "mine"
                    ? "该店铺已由你认领，无需重复认领"
                    : "该店铺已被其他账号认领，不能批量认领";
                const storeName = store.storeName || store.storeId;
                return `<label class="row-select${claimable ? "" : " row-select-locked"}" title="${claimable ? "选择该店铺" : lockReason}">
                    <input class="store-claim-checkbox" type="checkbox" name="store-claim-selection" value="${escapeHtml(store.storeId)}" data-store-name="${escapeHtml(store.storeName || store.storeId)}" data-claimable="${claimable ? "1" : "0"}" aria-label="${escapeHtml(claimable ? `选择 ${storeName}` : `${storeName}，${lockReason}`)}"${claimable && selectedClaimStores.has(String(store.storeId)) ? " checked" : ""}${claimable ? "" : " disabled"}>
                    <span></span>
                </label>`;
            })();
        return `
            <article class="product-row store-row${claimed ? " store-row-claimed" : ""}${allowSelection ? "" : " store-row-unselectable"}" data-store-row data-claim-state="${state}" data-online="${store.online ? "1" : "0"}" data-store-search="${escapeHtml(`${store.storeName || ""} ${store.storeId} ${store.ownerNameMasked || ""} ${store.ownerName || ""}`.toLowerCase())}">
                ${selection}
                <span class="store-light ${store.online ? "online" : "offline"}" role="img" aria-label="${store.online ? "在线" : "离线"}"></span>
                <div class="store-row-body">
                    <strong>${escapeHtml(store.storeName || store.storeId)}</strong>
                    <span class="store-row-meta">${meta.join(" · ")}</span>
                </div>
                <span class="store-row-owner"><b>归属账户</b>${ownerText}</span>
                <div class="row-actions">${action}</div>
            </article>`;
    };

    const listOf = (rows, emptyText, allowSelection = true) => rows.map((store) => rowOf(store, allowSelection)).join("") || `<div class="catalog-empty">${emptyText}</div>`;
    const allStoreEmptyText = filters.q || filters.online || filters.claimState
        ? "没有符合当前筛选条件的店铺。"
        : "暂无店铺上报，请在紫鸟中打开 Temu 商品列表页。";
    const mineStoreEmptyText = mineFilters.q
        ? "没有符合搜索条件的已认领店铺。"
        : "你还没有认领任何店铺。请到「全部店铺」里认领自己的店铺。";

    app.innerHTML = `
        <div class="top store-compact-top"><h1>店铺认领</h1><p class="lede">认领长期有效，仅限本人认领店铺互传。</p></div>
        <div class="store-navigation-row">
            <div class="task-view-tabs" role="tablist" aria-label="店铺分类">
                <button type="button" class="active" data-store-view-button="online" role="tab" aria-selected="true">全部店铺 <b>${Number(payload.total) || stores.length}</b></button>
                <button type="button" data-store-view-button="mine" role="tab" aria-selected="false">我的店铺 <b>${Number(minePayload.total) || mineStores.length}</b></button>
            </div>
            <div class="store-status-summary"><span><i class="store-light online" aria-hidden="true"></i>在线 ${Number(counts.online) || 0}</span><span><i class="store-light offline" aria-hidden="true"></i>离线 ${Number(counts.offline) || 0}</span>${payload.isAdmin ? `<span>他人认领 ${Number(counts.others) || 0}</span>` : ""}</div>
        </div>
        <p class="store-claim-feedback" id="store-claim-feedback" role="status" hidden></p>
        <section class="store-claim-panel" data-store-panel="online" aria-label="全部店铺">
            <div class="store-toolbar">
                <div class="store-filter-cluster" role="group" aria-label="店铺筛选">
                    <label class="store-filter-field"><span>店铺状态</span><select id="online-store-online-filter" aria-label="店铺状态"><option value="">全部 ${Number(counts.online) + Number(counts.offline)}</option><option value="1"${filters.online === "1" ? " selected" : ""}>在线 ${Number(counts.online) || 0}</option><option value="0"${filters.online === "0" ? " selected" : ""}>离线 ${Number(counts.offline) || 0}</option></select></label>
                    <label class="store-filter-field"><span>认领情况</span><select id="online-store-filter" aria-label="认领情况"><option value="">全部 ${Number(counts.online) + Number(counts.offline)}</option><option value="unclaimed"${filters.claimState === "unclaimed" ? " selected" : ""}>可认领 ${unclaimedCount}</option><option value="mine"${filters.claimState === "mine" ? " selected" : ""}>我认领 ${Number(counts.mine) || 0}</option><option value="others"${filters.claimState === "others" ? " selected" : ""}>他人认领 ${othersCount}</option></select></label>
                    <form class="catalog-search-form store-filter-search" id="online-store-search-form" role="search"><label class="catalog-search"><span class="visually-hidden">搜索店铺</span><input id="online-store-search" type="search" placeholder="店铺、标识或归属账号" autocomplete="off" value="${escapeHtml(storeViews.online.draft)}"></label><button class="toolbar-button" type="submit">搜索</button></form>
                </div>
            </div>
            <div class="store-action-row">
                <div class="store-batch-controls"><label class="select-all store-batch-select-all"><input id="store-claim-select-all" type="checkbox"><span></span>全选本页</label><button type="button" class="toolbar-button primary" id="claim-selected-stores" disabled>批量认领 <b id="store-claim-selected-count">0</b></button><button type="button" class="toolbar-button" id="clear-store-selection">清除选择</button></div>
                ${renderInlinePagination("online-store", storeViews.online.page, storeViews.online.size, Number(payload.total) || 0, "店铺")}
            </div>
            <div class="product-list" id="store-list">${listOf(stores, allStoreEmptyText)}</div>
        </section>
        <section class="store-claim-panel" data-store-panel="mine" aria-label="我的店铺" hidden>
            <p class="store-compact-note">解除认领仅取消访问，不删除数据。</p>
            <form class="catalog-search-form" id="mine-store-search-form" role="search"><label class="catalog-search"><span class="visually-hidden">搜索我的店铺</span><input id="mine-store-search" type="search" placeholder="店铺名称或标识" autocomplete="off" value="${escapeHtml(storeViews.mine.draft)}"></label><button class="toolbar-button" type="submit">搜索</button></form>
            <div class="store-action-row">${renderInlinePagination("mine-store", storeViews.mine.page, storeViews.mine.size, Number(minePayload.total) || 0, "店铺")}</div>
            <div class="product-list" id="mine-store-list">${listOf(mineStores, mineStoreEmptyText, false)}</div>
        </section>`;

    /**
     * 分类切换：横向标签，切换只改 hidden，不重新请求数据。
     * 活动分类保存在独立状态中，分页请求和自动刷新重绘后仍停留在原分类。
     */
    const storeViewButtons = [...app.querySelectorAll("[data-store-view-button]")];
    const showStoreView = (name) => {
        activeClaimView = name;
        storeViewButtons.forEach((button) => {
            const active = button.getAttribute("data-store-view-button") === name;
            button.classList.toggle("active", active);
            button.setAttribute("aria-selected", active ? "true" : "false");
        });
        app.querySelectorAll("[data-store-panel]").forEach((panel) => {
            panel.hidden = panel.getAttribute("data-store-panel") !== name;
        });
    };
    storeViewButtons.forEach((button) => button.addEventListener("click", () => showStoreView(button.getAttribute("data-store-view-button") || "online")));
    showStoreView(activeStoreView);
    if (focusId) {
        window.requestAnimationFrame(() => {
            const input = document.getElementById(focusId);
            if (!input) return;
            input.focus();
            try { input.setSelectionRange(input.value.length, input.value.length); } catch {}
        });
    }

    /** 每次仅替换请求的那一页；请求成功才提交分页状态，失败保留原页和跨页选择。 */
    const reloadStorePage = async (view, changes = {}) => {
        if (storePageBusy || storeClaimBusy) return;
        const routeVersion = routeRequestId;
        const next = { ...storeViews[view], ...changes };
        storePageBusy = true;
        const controls = [...app.querySelectorAll('.store-toolbar select, .store-action-row button, .store-action-row select, .catalog-search-form button, [data-store-view-button], [data-claim-store], [data-release-store], .store-claim-checkbox, #store-claim-select-all')];
        const previousDisabled = controls.map(control => control.disabled);
        controls.forEach(control => { control.disabled = true; });
        try {
            const page = await fetchClaimStorePage(view, next, { cacheMs: 1500 });
            if (routeVersion !== routeRequestId || location.hash !== "#/stores") return;
            // 请求期间仍允许输入草稿，不能用请求开始时的快照覆盖新输入。
            Object.assign(storeViews[view], next, { draft: storeViews[view].draft });
            renderStores(view === "mine" ? payload : page, "", view === "mine" ? page : minePayload, "", view);
        } catch (error) {
            showClaimFeedback(`读取店铺失败：${error.message}`, true);
            for (const [id, key] of [["online-store-online-filter", "online"], ["online-store-filter", "claimState"]]) {
                const element = document.getElementById(id);
                if (element) element.value = storeViews.online[key];
            }
            const sizeSelect = document.getElementById(`${view}-store-page-size`);
            const pageSelect = document.getElementById(`${view}-store-page-buttons`);
            if (sizeSelect) sizeSelect.value = String(storeViews[view].size);
            if (pageSelect) pageSelect.value = String(storeViews[view].page);
        } finally {
            storePageBusy = false;
            controls.forEach((control, index) => { if (control.isConnected) control.disabled = previousDisabled[index]; });
        }
    };
    for (const view of ["online", "mine"]) {
        const prefix = `${view}-store`;
        const search = document.getElementById(`${prefix}-search`);
        search?.addEventListener("input", () => { storeViews[view].draft = search.value; });
        document.getElementById(`${prefix}-search-form`)?.addEventListener("submit", (event) => {
            event.preventDefault();
            void reloadStorePage(view, { q: search.value.trim(), page: 1 });
        });
        document.getElementById(`${prefix}-page-prev`)?.addEventListener("click", () => void reloadStorePage(view, { page: Math.max(1, storeViews[view].page - 1) }));
        document.getElementById(`${prefix}-page-next`)?.addEventListener("click", () => void reloadStorePage(view, { page: storeViews[view].page + 1 }));
        document.getElementById(`${prefix}-page-buttons`)?.addEventListener("change", (event) => void reloadStorePage(view, { page: Number(event.target.value) }));
        document.getElementById(`${prefix}-page-size`)?.addEventListener("change", (event) => void reloadStorePage(view, { size: Number(event.target.value), page: 1 }));
    }
    for (const [id, key] of [["online-store-online-filter", "online"], ["online-store-filter", "claimState"]]) {
        document.getElementById(id)?.addEventListener("change", (event) => void reloadStorePage("online", { [key]: event.target.value, page: 1 }));
    }

    const selectAllClaimable = document.getElementById("store-claim-select-all");
    const claimSelectedButton = document.getElementById("claim-selected-stores");
    const claimFeedback = document.getElementById("store-claim-feedback");
    const visibleClaimableCheckboxes = () => [...document.querySelectorAll('#store-list [data-store-row]:not([hidden]) .store-claim-checkbox[data-claimable="1"]')];
    const showClaimFeedback = (message, isError = false) => {
        if (!claimFeedback) return;
        claimFeedback.textContent = message;
        claimFeedback.classList.toggle("is-error", isError);
        claimFeedback.hidden = !message;
    };
    const syncClaimSelection = () => {
        const visible = visibleClaimableCheckboxes();
        const selected = [...selectedClaimStores.values()];
        document.querySelectorAll("#store-list .store-claim-checkbox").forEach((checkbox) => {
            checkbox.disabled = storeClaimBusy || checkbox.dataset.claimable !== "1";
        });
        document.querySelectorAll("[data-claim-store], [data-release-store]").forEach((button) => {
            button.disabled = storeClaimBusy;
        });
        const claimSelectedCount = document.getElementById("store-claim-selected-count");
        if (claimSelectedCount) claimSelectedCount.textContent = String(selected.length);
        if (claimSelectedButton) claimSelectedButton.disabled = storeClaimBusy || selected.length === 0;
        document.getElementById("clear-store-selection").disabled = storeClaimBusy || selected.length === 0;
        if (selectAllClaimable) {
            const visibleChecked = visible.filter((box) => box.checked).length;
            selectAllClaimable.checked = Boolean(visible.length) && visibleChecked === visible.length;
            selectAllClaimable.indeterminate = visibleChecked > 0 && visibleChecked < visible.length;
            selectAllClaimable.disabled = storeClaimBusy || visible.length === 0;
            selectAllClaimable.title = visible.length ? "选择本页全部可认领店铺" : "本页没有可认领店铺";
        }
    };
    document.querySelectorAll(".store-claim-checkbox").forEach((checkbox) => checkbox.addEventListener("change", () => {
        if (checkbox.checked && checkbox.dataset.claimable === "1") selectedClaimStores.set(String(checkbox.value), { storeId: checkbox.value, storeName: checkbox.dataset.storeName || checkbox.value });
        else selectedClaimStores.delete(String(checkbox.value));
        showClaimFeedback("");
        syncClaimSelection();
    }));
    selectAllClaimable?.addEventListener("change", () => {
        visibleClaimableCheckboxes().forEach((checkbox) => {
            checkbox.checked = selectAllClaimable.checked;
            if (checkbox.checked) selectedClaimStores.set(String(checkbox.value), { storeId: checkbox.value, storeName: checkbox.dataset.storeName || checkbox.value });
            else selectedClaimStores.delete(String(checkbox.value));
        });
        showClaimFeedback("");
        syncClaimSelection();
    });
    // 清除的是所有页的选择，而不是仅当前可见勾选框。
    document.getElementById("clear-store-selection")?.addEventListener("click", () => {
        selectedClaimStores.clear();
        visibleClaimableCheckboxes().forEach(checkbox => { checkbox.checked = false; });
        syncClaimSelection();
    });
    syncClaimSelection();
    if (successMessage) showClaimFeedback(successMessage);

    document.querySelectorAll("[data-claim-store]").forEach((button) => button.addEventListener("click", async () => {
        const storeId = button.dataset.claimStore;
        const storeName = button.dataset.claimName || storeId;
        if (!window.confirm(`确认认领店铺「${storeName}」？\n\n认领后该店铺归你的账号所有，其他账号将无法再认领；该店铺已有的商品、任务与日志也会归到你的账号。`)) return;
        storeClaimBusy = true;
        button.disabled = true;
        button.textContent = "认领中…";
        syncClaimSelection();
        let claimed = false;
        try {
            await api("/temu/api/stores/claim", { method: "POST", body: JSON.stringify({ storeId, storeName }) });
            selectedClaimStores.delete(String(storeId));
            claimed = true;
        } catch (error) {
            window.alert(`认领失败：${error.message}`);
            button.disabled = false;
            button.textContent = "认领";
        } finally {
            storeClaimBusy = false;
            syncClaimSelection();
        }
        if (claimed) await route();
    }));
    document.querySelectorAll("[data-release-store]").forEach((button) => button.addEventListener("click", async () => {
        const storeId = button.dataset.releaseStore;
        const storeName = button.dataset.releaseName || storeId;
        // 解除后数据仍保留但当前账号不可见，必须让操作者明确知道后果。
        if (!window.confirm(`确认解除对「${storeName}」的认领？\n\n解除后你将看不到该店铺的商品、任务与日志（数据不会删除），直到重新认领。`)) return;
        storeClaimBusy = true;
        button.disabled = true;
        button.textContent = "解除中…";
        syncClaimSelection();
        let released = false;
        try {
            await api("/temu/api/stores/release", { method: "POST", body: JSON.stringify({ storeId }) });
            released = true;
        } catch (error) {
            window.alert(`解除失败：${error.message}`);
            button.disabled = false;
            button.textContent = "解除认领";
        } finally {
            storeClaimBusy = false;
            syncClaimSelection();
        }
        if (released) await route();
    }));
    claimSelectedButton?.addEventListener("click", async () => {
        const selected = [...selectedClaimStores.values()];
        if (!selected.length) return;
        const summary = selected.length <= 5
            ? selected.map((store) => `「${store.storeName}」`).join("、")
            : `${selected.slice(0, 5).map((store) => `「${store.storeName}」`).join("、")} 等 ${selected.length} 家店铺`;
        if (!window.confirm(`确认批量认领 ${selected.length} 家店铺？\n\n${summary}\n\n认领后这些店铺归你的账号所有，其他账号将无法再认领；已有商品、任务与日志也会归到你的账号。`)) return;

        storeClaimBusy = true;
        claimSelectedButton.innerHTML = "认领中…";
        showClaimFeedback(`正在认领 ${selected.length} 家店铺，请稍候。`);
        syncClaimSelection();
        let result = null;
        try {
            result = await api("/temu/api/stores/claim", {
                method: "POST",
                body: JSON.stringify({ stores: selected })
            });
        } catch (error) {
            claimSelectedButton.innerHTML = `批量认领 <b id="store-claim-selected-count">${selected.length}</b>`;
            showClaimFeedback(`批量认领失败：${error.message}`, true);
        } finally {
            storeClaimBusy = false;
            syncClaimSelection();
        }
        if (result) {
            selectedClaimStores.clear();
            // 变更后重新走分页路由，确保“我的店铺”计数和当前筛选结果都从服务端刷新。
            await route();
            const feedback = document.getElementById("store-claim-feedback");
            if (feedback) {
                feedback.textContent = `已认领 ${Number(result.claimedCount) || selected.length} 家店铺。`;
                feedback.hidden = false;
            }
        }
    });
}


/**
 * 页面内操作确认：列出影响范围，必要时让操作者选择处理方式。
 * 返回所选 value；取消返回空串。
 *
 * 使用页面 dialog，避免内嵌浏览器静默拒绝原生 confirm；未明确确认、Esc 或路由离开均视为取消。
 */
function confirmAction({ title, details = [], options = [], confirmLabel = "确认删除", destructive = true }) {
    return new Promise((resolve, reject) => {
        const dialog = document.createElement("dialog");
        dialog.className = "confirm-dialog";
        dialog.setAttribute("aria-label", title);
        const optionHtml = options.map((option, index) => `
            <label class="confirm-option">
                <input type="radio" name="confirm-mode" value="${escapeHtml(option.value)}" ${index === 0 ? "checked" : ""}>
                <span class="confirm-option-body">
                    <strong>${escapeHtml(option.label)}</strong>
                    <small>${escapeHtml(option.hint || "")}</small>
                </span>
            </label>`).join("");
        dialog.innerHTML = `
            <form method="dialog">
                <h3>${escapeHtml(title)}</h3>
                ${details.length ? `<pre class="confirm-details">${escapeHtml(details.join("\n"))}</pre>` : ""}
                ${optionHtml ? `<div class="confirm-options">${optionHtml}</div>` : ""}
                <div class="confirm-actions">
                    <button type="button" class="toolbar-button" value="cancel">取消</button>
                    <button type="button" class="toolbar-button ${destructive ? "danger" : "primary"}" value="ok">${escapeHtml(confirmLabel)}</button>
                </div>
            </form>`;
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            window.removeEventListener("hashchange", cancel);
            if (dialog.open) dialog.close();
            dialog.remove();
            resolve(value);
        };
        const cancel = () => finish("");
        dialog.querySelector('[value="cancel"]').addEventListener("click", () => finish(""));
        dialog.querySelector('[value="ok"]').addEventListener("click", () => {
            const checked = dialog.querySelector('input[name="confirm-mode"]:checked');
            finish(checked ? checked.value : "ok");
        });
        // Esc 关闭时按取消处理，避免 Promise 永远挂着。
        dialog.addEventListener("close", () => finish(""), { once: true });
        window.addEventListener("hashchange", cancel, { once: true });
        document.body.append(dialog);
        try { dialog.showModal(); }
        catch (error) {
            settled = true;
            window.removeEventListener("hashchange", cancel);
            dialog.remove();
            reject(error);
        }
    });
}

/**
 * 目标店铺转移控制台：先做资料预检，用户确认后才打开 Temu 新建商品页并截图。
 * 打开页面成功只显示“已探测，未上传”，不会保存草稿或发布。
 */
async function renderTransfers(overview) {
    setNav("transfers");
    let storeResult = null;
    let storeError = null;
    try { storeResult = await api("/temu/api/ziniao/stores?refresh=1"); } catch (error) { storeError = error; }
    let jobs = { jobs: [] };
    try { jobs = await api("/temu/api/transfer-jobs"); } catch {}
    const stores = storeResult && Array.isArray(storeResult.stores) ? storeResult.stores : [];
    app.innerHTML = `
        <div class="top"><div class="top-copy"><h1>转移任务</h1><p class="lede">这是隐藏的探测页，不是当前主流程。确认后只打开 Temu 新建商品页并截图，不会保存草稿、上传图片或发布。</p></div><div class="top-context"><a class="back-link" href="#/">返回查验台</a></div></div>
        <section class="panel transfer-panel">
            <div class="panel-heading"><h2>创建上传预检</h2><button type="button" class="drop-button" id="refresh-stores">刷新店铺</button></div>
            ${storeError ? `<p class="toast error">读取店铺失败：${escapeHtml(storeError.message)}。请确认紫鸟客户端和 ZClaw Bridge 已启动。</p>` : ""}
            <form id="transfer-form" class="transfer-form">
                <label>目标店铺<select id="transfer-store" required><option value="">${stores.length ? "请选择目标店铺" : "暂无店铺"}</option>${stores.map((item) => `<option value="${escapeHtml(item.storeId)}">${escapeHtml(item.name)}${item.platform ? ` · ${escapeHtml(item.platform)}` : ""} (${escapeHtml(item.storeId)})</option>`).join("")}</select></label>
                <label>来源批次<select id="transfer-batch" required><option value="">请选择来源批次</option>${overview.batches.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.label || item.id)} · SPU ${item.counts.spu}</option>`).join("")}</select></label>
                <fieldset><legend>商品（可多选）</legend><div class="transfer-products">${overview.products.map((item) => `<label><input type="checkbox" name="transfer-spu" value="${escapeHtml(item.spuId)}"><span>${escapeHtml(item.title || item.spuId)} · SPU ${escapeHtml(item.spuId)}${item.ready ? "" : "（资料未齐）"}</span></label>`).join("") || `<span class="muted">当前商品库为空，请先导入完整采集包。</span>`}</div></fieldset>
                <button class="toolbar-button primary" type="submit" ${stores.length && overview.products.length ? "" : "disabled"}>创建预检任务</button>
                <span id="transfer-message" class="muted" role="status"></span>
            </form>
        </section>
        <section class="panel"><div class="panel-heading"><h2>任务记录</h2><span class="panel-kicker">${jobs.jobs.length} 条</span></div><div class="transfer-jobs">${jobs.jobs.map(renderTransferJob).join("") || `<p class="muted">还没有转移任务。</p>`}</div></section>
    `;
    document.getElementById("refresh-stores")?.addEventListener("click", () => route());
    document.getElementById("transfer-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("transfer-message");
        const targetStoreId = document.getElementById("transfer-store")?.value || "";
        const sourceBatchId = document.getElementById("transfer-batch")?.value || "";
        const spuIds = [...document.querySelectorAll("input[name=transfer-spu]:checked")].map((input) => input.value);
        if (!message) return;
        message.textContent = "正在做资料预检…";
        try {
            const result = await api("/temu/api/transfer-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetStoreId, sourceBatchId, spuIds }) });
            message.textContent = `任务 ${result.job.id} 已创建：${TRANSFER_STATUS_LABEL[result.job.status] || result.job.status}。确认前不会打开目标店铺。`;
            setTimeout(() => route(), 500);
        } catch (error) { message.textContent = `创建失败：${error.message}`; }
    });
    app.querySelectorAll("[data-transfer-action]").forEach((button) => {
        button.addEventListener("click", async () => {
            const id = button.getAttribute("data-job-id");
            const action = button.getAttribute("data-transfer-action");
            const label = action === "confirm" ? "确认探测" : action === "retry" ? "重试失败项" : "取消";
            if (action === "confirm" && !confirm("确认后会打开目标店铺的新建商品页并截图，但不会保存草稿或发布。是否继续？")) return;
            button.disabled = true;
            button.textContent = "处理中…";
            try {
                await api(`/temu/api/transfer-jobs/${encodeURIComponent(id)}/${action}`, { method: "POST" });
                await route();
            } catch (error) {
                button.disabled = false;
                button.textContent = label;
                alert(`${label}失败：${error.message}`);
            }
        });
    });
}

function transferStatusLabel(status) {
    return TRANSFER_STATUS_LABEL[status] || status || "未知状态";
}

function renderTransferJob(job) {
    const actions = [];
    if (job.status === "awaiting_confirmation") {
        actions.push(`<button type="button" class="toolbar-button primary" data-transfer-action="confirm" data-job-id="${escapeHtml(job.id)}">确认探测</button>`);
        actions.push(`<button type="button" class="toolbar-button" data-transfer-action="cancel" data-job-id="${escapeHtml(job.id)}">取消</button>`);
    }
    if (["failed", "partial", "blocked_page", "running"].includes(job.status)) {
        actions.push(`<button type="button" class="toolbar-button" data-transfer-action="retry" data-job-id="${escapeHtml(job.id)}">重试失败项</button>`);
    }
    if (job.status === "blocked_preflight") {
        actions.push(`<button type="button" class="toolbar-button" data-transfer-action="cancel" data-job-id="${escapeHtml(job.id)}">取消</button>`);
    }
    const items = (job.items || []).map((item) => {
        const shot = item.screenshot ? `<a href="${siteRoot()}/api/transfer-jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(item.spuId)}.png" target="_blank" rel="noreferrer">截图</a>` : "";
        return `<li><span>SPU ${escapeHtml(item.spuId)}</span><span>${escapeHtml(transferStatusLabel(item.status))}</span><span>${escapeHtml(item.reason || "")}</span>${shot}</li>`;
    }).join("");
    return `<article class="transfer-job">
        <strong>${escapeHtml(job.id)}</strong>
        <span>${escapeHtml(job.targetStoreName || job.targetStoreId)}</span>
        <span>${escapeHtml(transferStatusLabel(job.status))}</span>
        <div class="transfer-job-actions">${actions.join("")}</div>
        <small>${escapeHtml(job.adapterName || "未匹配适配器")}。${escapeHtml(job.preflight && job.preflight.note || "")}</small>
        ${items ? `<ul class="transfer-item-list">${items}</ul>` : ""}
    </article>`;
}

/** 首页拖放区和商品库上传按钮共用同一导入流程，成功后进入新批次核验页。 */
async function uploadFiles(fileList, toastId = "toast") {
    const toast = document.getElementById(toastId);
    const body = new FormData();
    [...fileList].forEach((file) => body.append("files", file, file.name));
    if (toast) toast.innerHTML = `<div class="toast">正在上传并识别文件…</div>`;
    try {
        const result = await api("/temu/api/import", { method: "POST", body });
        if (toast) toast.innerHTML = `<div class="toast success">${result.reused ? "这组文件已经入过库。" : "上传完成。"} ${escapeHtml((result.warnings || []).slice(0, 2).join(" "))}</div>`;
        location.hash = `#/batch/${result.batch.id}`;
    } catch (error) {
        if (toast) toast.innerHTML = `<div class="toast error">上传失败：${escapeHtml(error.message)}</div>`;
    }
}

function bindDrop() {
    const drop = document.getElementById("drop");
    const input = document.getElementById("files");
    if (!drop || !input) return;
    input.addEventListener("change", () => {
        if (input.files.length) {
            uploadFiles(input.files);
            input.value = "";
        }
    });
    drop.addEventListener("dragover", (event) => {
        event.preventDefault();
        drop.classList.add("drag");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
    drop.addEventListener("drop", (event) => {
        event.preventDefault();
        drop.classList.remove("drag");
        if (event.dataTransfer.files.length) uploadFiles(event.dataTransfer.files);
    });
}

function escapeHtml(value) {
    return String(value || "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[char]));
}

function hostOf(url) {
    try { return new URL(url).host; } catch { return url || ""; }
}

/** 只渲染 HTTPS 图片地址，完整包中的其他字符串继续以文本方式保存和展示。 */
function safeImageUrl(value) {
    try {
        const url = new URL(String(value || ""));
        return url.protocol === "https:" ? url.href : "";
    } catch {
        return "";
    }
}

function renderProductMedia(product) {
    const urls = Array.isArray(product.images) ? product.images.map(safeImageUrl).filter(Boolean).slice(0, 8) : [];
    if (!urls.length) return `<div class="carton" aria-label="暂无商品图片"><span>待补图</span></div>`;
    return `<div class="product-gallery" aria-label="商品图片">${urls.map((url, index) => `<img src="${escapeHtml(url)}" alt="商品图片 ${index + 1}" loading="lazy">`).join("")}</div>`;
}

let currentAccount = null;

/**
 * 读取当前登录身份并渲染侧栏账户区。
 * 身份由服务端 /api/me 决定，前端不做任何角色推断；管理员入口只在服务端返回 isAdmin 时显示。
 */
async function loadAccount(signal) {
    try {
        currentAccount = await api("/temu/api/me", { signal });
    } catch (error) {
        if (error?.name === "AbortError") throw error;
        currentAccount = null;
    }
    const box = document.getElementById("rail-account");
    const nameEl = document.getElementById("rail-username");
    const roleEl = document.getElementById("rail-role");
    const adminNav = document.getElementById("nav-admin");
    if (box && nameEl && currentAccount?.user) {
        nameEl.textContent = currentAccount.user.username;
        if (roleEl) roleEl.textContent = currentAccount.localMode ? "本机模式" : (currentAccount.isAdmin ? "管理员" : "普通用户");
        box.hidden = false;
    }
    if (adminNav) adminNav.hidden = !currentAccount?.isAdmin;
    return currentAccount;
}

/**
 * 站点可能挂在同域的其他路径下（线上是 /temu，本机直连是根路径）。
 * 按当前地址推导前缀，避免写死 /temu 让本机直连跳到不存在的地址，
 * 也避免用根绝对路径跳出本站落到同域其他站点。
 */
function siteRoot() {
    const match = location.pathname.match(/^(\/[^/]+)\//);
    return match ? match[1] : "";
}

/** 退出登录：清服务端会话后回到登录页；本机模式没有会话，直接刷新。 */
async function logout() {
    try {
        await fetch(`${siteRoot()}/logout`, { method: "POST", credentials: "same-origin" });
    } catch {}
    location.href = `${siteRoot()}/login`;
}

let routeRequestId = 0;
let routeController = null;
let commonPrefetchScheduled = false;
let forceStoreDirectoryRefresh = false;

function routeNavName(hash) {
    if (hash === "#/products" || hash === "#/products/all" || hash.startsWith("#/product/")) return "products";
    if (hash === "#/stores") return "stores";
    if (hash === "#/jobs") return "jobs";
    if (hash === "#/logs") return "logs";
    if (hash === "#/transfers") return "transfers";
    if (hash === "#/import") return "import";
    return "home";
}

function routeLabel(hash) {
    return {
        "#/": "查验台",
        "#/products": "商品库",
        "#/products/all": "全部商品",
        "#/stores": "店铺认领",
        "#/jobs": "任务台",
        "#/logs": "工作日志"
    }[hash] || "页面";
}

function ensureRouteProgress() {
    let progress = document.getElementById("route-progress");
    if (!progress) {
        progress = document.createElement("div");
        progress.id = "route-progress";
        progress.className = "route-progress";
        progress.setAttribute("role", "status");
        progress.setAttribute("aria-live", "polite");
        progress.innerHTML = `<span></span><small>正在加载</small>`;
        document.body.append(progress);
    }
    return progress;
}

function setRoutePending(active, hash = "") {
    document.body.classList.toggle("route-pending", active);
    app.setAttribute("aria-busy", active ? "true" : "false");
    const progress = ensureRouteProgress();
    progress.hidden = !active;
    const label = progress.querySelector("small");
    if (label) label.textContent = active ? `正在加载${routeLabel(hash)}` : "";
}

function renderRouteSkeleton(hash) {
    const label = routeLabel(hash);
    return `
        <div class="route-skeleton" role="status" aria-live="polite">
            <span class="route-skeleton-status">正在加载${escapeHtml(label)}…</span>
            <div class="route-skeleton-title"></div>
            <div class="route-skeleton-copy"></div>
            <div class="route-skeleton-grid">
                <span></span><span></span><span></span><span></span>
            </div>
            <div class="route-skeleton-list">
                <span></span><span></span><span></span>
            </div>
        </div>`;
}

/** 登录后空闲时预载最常用的小型插件目录；完整商品和任务数据仍由目标页面按需获取。 */
function scheduleCommonPrefetch() {
    if (commonPrefetchScheduled) return;
    commonPrefetchScheduled = true;
    const run = () => Promise.allSettled([
        api("/temu/api/agents?limit=100&offset=0", { cacheMs: 3000 }),
        api("/temu/api/ziniao/stores?scope=all&refresh=0&limit=100&offset=0", { cacheMs: 5000 })
    ]);
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 1800 });
    else window.setTimeout(run, 600);
}

async function route(options = {}) {
    const background = Boolean(options.background);
    // 只有人工导航接管页面；后台更新不得废弃翻页请求或清除其忙碌状态。
    if (!background) {
        catalogPageLoadVersion += 1;
        catalogPageLoading = false;
        refreshCatalogView = null;
        refreshCatalogTargets = null;
        refreshTaskPanels = null;
    }
    const hash = location.hash || "#/";
    const forceRefresh = Boolean(options.forceRefresh);
    const forceStoreRefresh = forceStoreDirectoryRefresh;
    forceStoreDirectoryRefresh = false;
    const requestId = background ? routeRequestId : ++routeRequestId;
    if (!background) routeController?.abort();
    const controller = new AbortController();
    const signal = controller.signal;
    if (!background) {
        routeController = controller;
        setNav(routeNavName(hash));
        setRoutePending(true, hash);
    }
    const skeletonTimer = background ? null : window.setTimeout(() => {
        if (requestId === routeRequestId) app.innerHTML = renderRouteSkeleton(hash);
    }, 180);
    /** 后台请求完成后再次核验交互版本，成功才恢复此刻的控件状态，不闪出加载占位。 */
    const commitView = (render) => {
        if (requestId !== routeRequestId || (background && !options.canApply?.())) return false;
        const saved = background ? captureViewState() : null;
        render();
        if (saved) restoreViewState(saved);
        return true;
    };
    try {
        if (hash === "#/logout") {
            await logout();
            return;
        }
        if (!currentAccount) await loadAccount(signal);
        if (requestId !== routeRequestId) return;
        if (hash === "#/" || hash === "#") {
            const [overview, dashboard] = await Promise.all([
                api("/temu/api/overview?productLimit=0", { signal, cacheMs: 5000, force: forceRefresh }),
                api("/temu/api/jobs/dashboard", { signal, cacheMs: 2000, force: forceRefresh }).catch(() => ({}))
            ]);
            if (requestId !== routeRequestId) return;
            return commitView(() => renderHome(overview, dashboard));
        }
        // 框架确认阶段独立渲染，不请求全店数据或借用个人库存冒充汇总结果。
        if (hash === "#/products/all") {
            renderAllProductsFrame();
            return;
        }
        if (hash === "#/products") {
            const [overview, agents] = await Promise.all([
                api(catalogPageUrl(), { signal, cacheMs: 5000, force: forceRefresh }),
                api("/temu/api/agents?online=1&receivable=1&limit=100&offset=0", { signal, cacheMs: 3000, force: forceRefresh }).catch(() => ({ agents: [], total: 0, hasMore: false }))
            ]);
            if (requestId !== routeRequestId) return;
            const lastPage = Math.max(1, Math.ceil((Number(overview.productTotal) || 0) / catalogProductPageSize));
            if (catalogProductPage > lastPage) {
                catalogProductPage = lastPage;
                return await route(options);
            }
            return commitView(() => renderProducts(overview, agents));
        }
        if (hash === "#/stores") {
            // 越界页修正先写入请求快照，后台旧响应不能提前修改用户正在翻页的全局状态。
            const onlineState = { ...storeViews.online };
            const mineState = { ...storeViews.mine };
            const [payload, minePayload] = await Promise.all([
                fetchClaimStorePage("online", onlineState, { signal, cacheMs: 2000, force: forceRefresh }),
                fetchClaimStorePage("mine", mineState, { signal, cacheMs: 2000, force: forceRefresh })
            ]);
            if (requestId !== routeRequestId) return;
            return commitView(() => {
                storeViews.online.page = onlineState.page;
                storeViews.mine.page = mineState.page;
                renderStores(payload, "", minePayload);
            });
        }
        /**
         * 管理控制台已拆成独立页面（/admin），不再作为本 SPA 的一个 hash 页：
         * 管理站只做管理，不该加载商品库、任务台这些业务逻辑。
         * 旧地址保留跳转，避免老书签落到"没有这个页面"；真正权限由服务端在 /admin 路径上校验。
         */
        if (hash === "#/admin") {
            location.href = `${siteRoot()}/admin`;
            return;
        }
        // 导入准备和转移任务仍保留旧地址，不再作为主流程入口。
        if (hash === "#/import") {
            const overview = await api("/temu/api/overview", { signal, cacheMs: 5000, force: forceRefresh });
            if (requestId !== routeRequestId) return;
            renderImport(overview);
            return;
        }
        if (hash === "#/jobs") {
            const storeDirectoryPath = `/temu/api/ziniao/stores?scope=all&limit=100&offset=0&refresh=${forceStoreRefresh ? "1" : "0"}`;
            const [overview, jobs, targetAgents, statusAgents, storeOutcome] = await Promise.all([
                api("/temu/api/overview?productLimit=100&productOffset=0&includeAllBatches=1", { signal, cacheMs: 5000, force: forceRefresh }),
                api("/temu/api/jobs?limit=50&offset=0&includeAgents=0", { signal }).catch(() => ({ jobs: [], agents: [], counts: {}, total: 0, hasMore: false })),
                api("/temu/api/agents?online=1&receivable=1&limit=100&offset=0", { signal, cacheMs: 3000, force: forceRefresh }).catch(() => ({ agents: [], total: 0, hasMore: false })),
                api("/temu/api/agents?limit=100&offset=0", { signal, cacheMs: 3000, force: forceRefresh }).catch(() => ({ agents: [], total: 0, hasMore: false })),
                api(storeDirectoryPath, { signal, cacheMs: 5000, force: forceRefresh })
                    .then((value) => ({ value, error: null }))
                    .catch((error) => ({ value: null, error }))
            ]);
            if (requestId !== routeRequestId) return;
            return commitView(() => renderJobs(overview, storeOutcome.value, storeOutcome.error, jobs, targetAgents, statusAgents));
        }
        if (hash === "#/logs") {
            const storeDirectoryPath = `/temu/api/ziniao/stores?scope=all&refresh=${forceStoreRefresh ? "1" : "0"}`;
            const [payload, agents, storePayload] = await Promise.all([
                api("/temu/api/work-log", { signal }),
                api("/temu/api/agents?limit=100&offset=0", { signal, cacheMs: 3000, force: forceRefresh }).catch(() => ({ agents: [] })),
                api(`${storeDirectoryPath}&limit=100&offset=0`, { signal, cacheMs: 5000, force: forceRefresh }).catch(() => ({ stores: [] }))
            ]);
            if (requestId !== routeRequestId) return;
            return commitView(() => renderWorkLogs(payload, agents, storePayload));
        }
        if (hash === "#/transfers") {
            const overview = await api("/temu/api/overview", { signal, cacheMs: 5000, force: forceRefresh });
            if (requestId !== routeRequestId) return;
            await renderTransfers(overview);
            return;
        }
        const batchMatch = hash.match(/^#\/batch\/([^/]+)/);
        if (batchMatch) {
            const batch = await api(`/temu/api/batches/${batchMatch[1]}`, { signal });
            if (requestId !== routeRequestId) return;
            renderBatch(batch);
            return;
        }
        const productMatch = hash.match(/^#\/product\/([^/]+)/);
        if (productMatch) {
            const product = await api(`/temu/api/products/${productMatch[1]}`, { signal });
            if (requestId !== routeRequestId) return;
            renderProduct(product);
            return;
        }
        app.innerHTML = `<p>没有这个页面。</p>`;
    } catch (error) {
        if (background) throw error;
        if (error?.name === "AbortError" || requestId !== routeRequestId) return;
        app.innerHTML = `<p>读数据失败：${escapeHtml(error.message)}</p>`;
    } finally {
        window.clearTimeout(skeletonTimer);
        if (!background && requestId === routeRequestId) {
            routeController = null;
            setRoutePending(false);
            scheduleCommonPrefetch();
        }
    }
}

window.addEventListener("hashchange", () => {
    if ((location.hash || "#/") !== "#/products") clearCatalogProductSelection();
    if ((location.hash || "#/") !== "#/stores") selectedClaimStores.clear();
    route();
});
document.getElementById("rail-logout")?.addEventListener("click", (event) => {
    event.preventDefault();
    logout();
});
route();

/**
 * SSE 接收账号可见范围的版本通知，正常连接时不再定时请求 /api/live。
 * 被操作阻挡的通知保留在内存，空闲后补同步；断线才启用低频读取兜底。
 */
const LIVE_FALLBACK_MS = 60000;
const AUTO_REFRESH_HASHES = new Set(["#/", "#", "#/products", "#/stores", "#/jobs", "#/logs"]);
let autoRefreshBusy = false;
let lastLive = null;
let lastLiveHash = "";
let latestLive = null;
let eventStream = null;
let liveApplyTimer = null;
let fallbackBusy = false;
let liveAuthExpired = false;
let pendingPaginationRestore = null;
let livePaginationHash = "";
let livePaginationTargets = {};

/** 旧式加载更多列表按已加载数量恢复；商品库和店铺认领已由独立分页状态直接恢复。 */
function takeRestoredPageCount(key) {
    return Math.max(0, Number(pendingPaginationRestore?.[key]) || 0);
}

/** 同一页面可能出现多个同名多选项（商品、目标店铺），用 name+value 组合成唯一键。 */
function controlKey(element) {
    if (!element || !element.tagName) return "";
    // 商品行的勾选框没有 id 和 name，只能按 SPU 定位，否则自动刷新会丢掉正在选择的商品。
    if (element.classList?.contains("product-checkbox")) return `spu:${element.value}`;
    if (element.id) return `#${element.id}`;
    if (element.name) return `@${element.name}:${element.value}`;
    return "";
}

function findControl(key) {
    if (!key) return null;
    if (key.startsWith("spu:")) return app.querySelector(`[data-product-row][data-spu="${CSS.escape(key.slice(4))}"] .product-checkbox`);
    if (key.startsWith("#")) return document.getElementById(key.slice(1));
    const [name, ...rest] = key.slice(1).split(":");
    return app.querySelector(`[name="${CSS.escape(name)}"][value="${CSS.escape(rest.join(":"))}"]`);
}

/** 重绘前保存控件值、勾选、展开状态和提示内容，重绘后恢复，避免自动刷新打断操作。 */
function captureViewState() {
    if (livePaginationHash !== (location.hash || "#/")) {
        livePaginationHash = location.hash || "#/";
        livePaginationTargets = {};
    }
    const controls = [];
    app.querySelectorAll("input, select, textarea").forEach((element) => {
        if (element.type === "file") return;
        const key = controlKey(element);
        if (!key) return;
        controls.push({
            key,
            checked: element.checked,
            value: element.multiple ? [...element.selectedOptions].map((option) => option.value) : element.value
        });
    });
    const panels = {};
    ["toast", "catalog-toast", "job-message", "transfer-message"].forEach((id) => {
        const element = document.getElementById(id);
        if (element && element.innerHTML) panels[id] = element.innerHTML;
    });
    const workLogStore = app.querySelector("[data-log-store].active")?.getAttribute("data-log-store") || "";
    const taskView = app.querySelector("[data-task-view-button].active")?.getAttribute("data-task-view-button") || "";
    // 店铺页的分类标签也要记住，后台数据变化不能把用户打回第一个分类。
    const storeView = app.querySelector("[data-store-view-button].active")?.getAttribute("data-store-view-button") || "";
    const currentPagination = {
        products: catalogProductPage,
        jobProducts: app.querySelectorAll('#job-products input[name="job-spu"]').length,
        storeStatus: app.querySelectorAll("[data-store-runtime-row]").length,
        productTargetAgents: app.querySelectorAll("#batch-target-options .batch-target-option").length,
        jobTargetAgents: app.querySelectorAll('#job-target-options input[type="checkbox"][value]').length
    };
    for (const [key, value] of Object.entries(currentPagination)) {
        // 商品库记录的是页码而不是累计行数，翻回前页时必须覆盖旧页码，不能沿用历史最大值。
        livePaginationTargets[key] = key === "products"
            ? value
            : Math.max(Number(livePaginationTargets[key]) || 0, value);
    }
    const pagination = { ...livePaginationTargets };
    const active = document.activeElement;
    const activeKey = active && app.contains(active) ? controlKey(active) : "";
    return {
        hash: location.hash || "#/",
        scrollY: window.scrollY,
        panels,
        workLogStore,
        taskView,
        storeView,
        pagination,
        controls,
        focus: activeKey ? { key: activeKey, start: active.selectionStart, end: active.selectionEnd } : null
    };
}

function restoreViewState(state) {
    // 页面已经切换时旧状态作废，不能把上一个页面的搜索结果套到新页面。
    if (!state || state.hash !== (location.hash || "#/")) return;
    pendingPaginationRestore = state.pagination || null;
    const paginationRestore = pendingPaginationRestore;
    // 顺序和人工操作一致：先还原筛选和下拉，再触发派生筛选，最后恢复勾选。
    const checks = [];
    for (const item of state.controls) {
        const element = findControl(item.key);
        if (!element) continue;
        // 独立分页状态已恢复且可能已修正越界，旧控件快照不得覆盖新页码或重选已认领店铺。
        if (/^#(?:product-page-|online-store-|mine-store-)/.test(item.key)
            || ["#source-store-filter", "#blocked-filter", "#store-claim-select-all"].includes(item.key)
            || element.name === "store-claim-selection") continue;
        if (element.type === "checkbox" || element.type === "radio") {
            checks.push([element, item.checked]);
            continue;
        }
        if (element.multiple) [...element.options].forEach((option) => { option.selected = item.value.includes(option.value); });
        else element.value = item.value;
    }
    const searchRestoreKeys = {
        "job-product-search": "jobProducts"
    };
    ["work-log-search", "job-product-search", "store-runtime-search"].forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        const restoreCount = searchRestoreKeys[id] ? takeRestoredPageCount(searchRestoreKeys[id]) : 0;
        // 空的非活动列表不应因自动刷新无意义重载；否则“我的店铺”首屏会覆盖已分页的“全部店铺”。
        if (element.value || restoreCount > 0) element.dispatchEvent(new Event("input"));
    });
    // 商品与店铺分页已从独立状态恢复，不模拟筛选 change，否则会回到第一页。
    ["batch-target-stores", "work-log-outcome", "work-log-type", "work-log-time", "job-batch", "job-target-store", "store-runtime-filter", "product-view-mode"].forEach((id) => document.getElementById(id)?.dispatchEvent(new Event("change")));
    checks.forEach(([element, checked]) => {
        if (element.disabled) return;
        element.checked = checked;
        element.dispatchEvent(new Event("change"));
    });
    Object.entries(state.panels).forEach(([id, html]) => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = html;
    });
    if (state.workLogStore) {
        app.querySelector(`[data-log-store="${CSS.escape(state.workLogStore)}"]`)?.click();
    }
    if (state.taskView) {
        app.querySelector(`[data-task-view-button="${CSS.escape(state.taskView)}"]`)?.click();
    }
    if (state.storeView) {
        app.querySelector(`[data-store-view-button="${CSS.escape(state.storeView)}"]`)?.click();
    }
    if (state.focus) {
        const target = findControl(state.focus.key);
        if (target) {
            target.focus({ preventScroll: true });
            try { target.setSelectionRange(state.focus.start, state.focus.end); } catch {}
        }
    }
    window.scrollTo(0, state.scrollY);
    // 只清理分页恢复标记；不能延迟滚回旧位置，否则会打断后续滚动和导航。
    window.setTimeout(() => {
        if (pendingPaginationRestore === paginationRestore) pendingPaginationRestore = null;
    }, 1200);
}

/** 页面只订阅自己使用的数据，避免后台无关日志或扫描状态触发全站重绘。 */
function liveKey(live, hash) {
    const fields = hash === "#/products" ? ["inventory", "claims", "agents"]
        : hash === "#/stores" ? ["claims", "directory"]
        : hash === "#/logs" ? ["logs", "claims", "agents"]
        : hash === "#/jobs" ? ["jobs", "claims", "agents", "bulk"]
        : ["inventory", "claims", "jobs", "logs"];
    return JSON.stringify(fields.map(field => live[field]));
}

/** 商品及整页重绘必须避让用户操作；只改店铺目录的同步不受勾选和弹窗限制。 */
function autoRefreshBlocked() {
    if (routeController) return true;
    if (document.visibilityState !== "visible") return true;
    if (!AUTO_REFRESH_HASHES.has(location.hash || "#/")) return true;
    if (document.querySelector("dialog[open]")) return true;
    if (document.getElementById("inbox-scan")?.disabled) return true;
    if (document.getElementById("drop")?.classList.contains("drag")) return true;
    // 已勾选商品或目标店时暂停整页刷新，避免大规模分页下的跨页选择被自动重绘打断。
    if (catalogSelectedProducts.size > 0) return true;
    if (app.querySelector('input[name="job-spu"]:checked, #job-target-store option:checked, #batch-target-stores option:checked')) return true;
    return singleUploadBusy || batchUploadBusy || inventoryDeletionBusy || storeClaimBusy || storePageBusy || catalogPageLoading;
}

/** 排队只检查本地操作状态，不产生网络轮询；同一时刻只保留最新的一份通知。 */
function scheduleLiveApply(delay = 0) {
    if (liveApplyTimer !== null) return;
    liveApplyTimer = window.setTimeout(() => { liveApplyTimer = null; void applyLiveChanges(); }, delay);
}

async function applyLiveChanges() {
    if (!latestLive || liveAuthExpired || document.visibilityState !== "visible") return;
    const currentHash = location.hash || "#/";
    if (!AUTO_REFRESH_HASHES.has(currentHash)) return;
    if (autoRefreshBusy) {
        scheduleLiveApply(1000);
        return;
    }
    autoRefreshBusy = true;
    const hash = location.hash || "#/";
    const navigationVersion = routeRequestId;
    const interactionVersion = viewInteractionVersion;
    const pageVersion = catalogPageLoadVersion;
    let targetsApplied = hash !== "#/products";
    // 请求发出后仍可能发生翻页、输入或弹窗操作；旧响应只能丢弃，不能抢回页面。
    const canApply = () => hash === (location.hash || "#/") && navigationVersion === routeRequestId
        && interactionVersion === viewInteractionVersion && pageVersion === catalogPageLoadVersion && !autoRefreshBlocked();
    try {
        const live = latestLive;
        // 目标店只做局部更新，不因弹窗、输入或商品勾选暂停；提交期间仍冻结，避免更换任务目标。
        const canApplyTargets = () => hash === (location.hash || "#/") && navigationVersion === routeRequestId
            && !routeController && document.visibilityState === "visible" && !singleUploadBusy && !batchUploadBusy && !inventoryDeletionBusy;
        if (hash === "#/products") {
            targetsApplied = canApplyTargets() && await refreshCatalogTargets?.(live, canApplyTargets) === true;
            if (!targetsApplied) return;
        }
        // 店铺可能经历上线、离线、再上线；先核对独立目录版本，不能被整页旧摘要吞掉。
        if (lastLiveHash === hash && lastLive && liveKey(live, hash) === liveKey(lastLive, hash)) return;
        if (hash === '#/jobs') {
            if (await refreshTaskPanels?.()) { lastLive = live; lastLiveHash = hash; }
            return;
        }
        if (autoRefreshBlocked()) {
            const pending = document.getElementById("catalog-live-pending");
            if (pending && live.inventory !== lastLive?.inventory) pending.hidden = false;
            scheduleLiveApply(1000);
            return;
        }
        if (!canApply()) return;
        // 首次连接与切页也核对当前数据，弥补首屏请求和建立连接之间可能遗漏的变更。
        const previous = lastLiveHash === hash && lastLive ? lastLive : {};
        const applied = hash === "#/products"
            ? await refreshCatalogView?.(live, previous, canApply)
            : await route({ forceRefresh: true, background: true, canApply });
        // 只有成功提交才消费信号；操作冲突或请求失败后，下轮仍会补回此次变化。
        if (applied === true && canApply()) {
            lastLive = live;
            lastLiveHash = hash;
            const pending = document.getElementById("catalog-live-pending");
            if (pending) pending.hidden = true;
        }
    } catch {
        // 读取失败保留旧视图和未消费版本，不用错误页覆盖正在操作的内容。
    } finally {
        autoRefreshBusy = false;
        if (latestLive && (!targetsApplied || lastLiveHash !== hash || !lastLive || liveKey(latestLive, hash) !== liveKey(lastLive, hash))) scheduleLiveApply(3000);
    }
}

/** SSE 和断线兜底使用相同的摘要结构，拒绝异常载荷而不清空已展示的数据。 */
function receiveLiveSnapshot(live) {
    if (!live || !["inventory", "claims", "agents", "jobs", "logs", "directory"].every(key => typeof live[key] === "string")) return;
    latestLive = live;
    scheduleLiveApply();
}

/** 原生 EventSource 自动重连；每次重连服务端发送当前完整版本，不依赖易丢失的增量队列。 */
function connectLiveEvents() {
    if (liveAuthExpired || document.visibilityState !== "visible" || !AUTO_REFRESH_HASHES.has(location.hash || "#/")) return;
    if (eventStream || typeof EventSource === "undefined") return;
    const stream = new EventSource(`${siteRoot()}/api/events`);
    eventStream = stream;
    stream.addEventListener("live", event => {
        if (eventStream !== stream) return;
        try { receiveLiveSnapshot(JSON.parse(event.data)); } catch {}
    });
    stream.addEventListener("auth-expired", () => {
        if (eventStream !== stream) return;
        liveAuthExpired = true;
        closeLiveEvents();
        // 不自动重载页面或丢掉选择；下一次业务请求仍由原有登录校验明确提示。
    });
    stream.onerror = () => {
        // 网络断开保留当前视图，由浏览器按服务端 retry 间隔重连，不能退回高频轮询。
        if (stream.readyState === EventSource.CLOSED && eventStream === stream) eventStream = null;
    };
}

function closeLiveEvents() {
    eventStream?.close();
    eventStream = null;
    window.clearTimeout(liveApplyTimer);
    liveApplyTimer = null;
}

/** 仅在 SSE 不可用时每分钟补读一次，正常连接不产生定时 HTTP 查询。 */
async function fallbackLiveSnapshot() {
    if (liveAuthExpired || fallbackBusy || document.visibilityState !== "visible" || !AUTO_REFRESH_HASHES.has(location.hash || "#/")) return;
    if (eventStream?.readyState === 1) return;
    fallbackBusy = true;
    try { receiveLiveSnapshot(await api("/temu/api/live")); } catch {} finally { fallbackBusy = false; }
    connectLiveEvents();
}

function resumeLiveEvents() {
    if (document.visibilityState !== "visible" || !AUTO_REFRESH_HASHES.has(location.hash || "#/")) closeLiveEvents();
    else { connectLiveEvents(); scheduleLiveApply(); }
}
setInterval(fallbackLiveSnapshot, LIVE_FALLBACK_MS);
document.addEventListener("visibilitychange", resumeLiveEvents);
window.addEventListener("hashchange", resumeLiveEvents);
window.addEventListener("focus", resumeLiveEvents);
window.addEventListener("pagehide", closeLiveEvents);
window.addEventListener("pageshow", resumeLiveEvents);
connectLiveEvents();
