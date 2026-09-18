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
    created: "已创建并回查",
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
    partial: "部分失败",
    failed: "失败",
    cancelled: "已取消"
};

async function api(path, options) {
    // 线上由 /temu 反向代理提供页面，本地直连时后端根路径没有 /temu 前缀。
    const API_PREFIX = "/temu/api";
    const requestPath = path.startsWith(API_PREFIX) && !location.pathname.startsWith("/temu/")
        ? `/api${path.slice(API_PREFIX.length)}`
        : path;
    const response = await fetch(requestPath, options);
    let data = {};
    try {
        const text = await response.text();
        data = text ? JSON.parse(text) : {};
    } catch {
        data = { error: `服务器返回了无法解析的响应（HTTP ${response.status}）` };
    }
    if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
    return data;
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
                <span class="ticket-status ${product.blocked ? "blocked" : (product.ready ? "ready" : "pending")}">${product.blocked ? "上传失败 · 需修正后重采" : (product.ready ? (product.completeness?.detailState === "source-empty" ? "已采集 · 源正文为空" : "资料可交付") : missingLabel(product))}</span>
                ${selectable ? `<div class="row-actions"><button type="button" class="row-send" data-transfer-spu="${escapeHtml(product.spuId)}" aria-label="上传 SPU ${escapeHtml(product.spuId)}" ${transferStores.length && productBatches.length && !product.blocked ? "" : "disabled"} title="${product.blocked ? `上次上传失败已标红，需在来源店修正资料后重新采集覆盖：${escapeHtml(product.blockedReason || "")}` : (transferStores.length && productBatches.length ? "选择目标店铺后上传" : (productBatches.length ? "等待在线目标店铺插件" : "缺少可追溯的来源批次"))}">上传</button><a href="#/product/${encodeURIComponent(product.spuId)}" class="row-detail">详情</a><button type="button" class="row-delete" data-delete-spu="${escapeHtml(product.spuId)}" aria-label="删除 SPU ${escapeHtml(product.spuId)}">删除</button></div>` : ""}
            </article>`;
    }).join("");
}

function setNav(name) {
    document.querySelectorAll("[data-nav]").forEach((link) => {
        if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });
}

/** 首页经营数据按上海自然日汇总，避免浏览器时区与服务端任务时间产生跨日统计偏差。 */
function shanghaiDayKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Shanghai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
    }).formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** 首页只展示可解释的经营口径：发送按任务创建，上传成功和异常按商品项的最近回执时间统计。 */
function buildHomeDashboard(overview, jobsPayload) {
    const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
    const today = shanghaiDayKey(Date.now());
    const productCounts = new Map();
    const sourceCounts = new Map();
    let todaySent = 0;
    let todayUploaded = 0;
    let todayAttention = 0;

    for (const job of jobs) {
        const items = Array.isArray(job.items) ? job.items : [];
        const jobDay = shanghaiDayKey(job.createdAt);
        if (jobDay === today) todaySent += items.length;

        const sourceId = String(job.sourceStoreId || job.sourceStoreName || "unknown-source");
        const source = sourceCounts.get(sourceId) || {
            id: sourceId,
            name: String(job.sourceStoreName || job.sourceStoreId || "未知来源店"),
            count: 0
        };
        source.count += items.length;
        sourceCounts.set(sourceId, source);

        for (const item of items) {
            const productId = String(item.spuId || "unknown-product");
            const product = productCounts.get(productId) || {
                id: productId,
                name: String(item.title || item.spuId || "未命名商品"),
                count: 0
            };
            product.count += 1;
            productCounts.set(productId, product);

            const resultDay = shanghaiDayKey(item.directUpdatedAt || job.updatedAt);
            if (resultDay !== today) continue;
            if (item.directState === "created" || item.status === "uploaded") todayUploaded += 1;
            if (["unknown", "preflight_failed", "rejected"].includes(String(item.directState || ""))
                || ["failed", "identity_mismatch"].includes(String(item.status || ""))) todayAttention += 1;
        }
    }

    const descending = (left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN");
    return {
        todaySent,
        todayUploaded,
        todayAttention,
        activeJobs: jobs.filter((job) => ["active", "attention"].includes(jobRecordGroup(job))).length,
        topProducts: [...productCounts.values()].sort(descending).slice(0, 8),
        topSources: [...sourceCounts.values()].sort(descending).slice(0, 8)
    };
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

async function renderHome(overview) {
    setNav("home");
    let jobsPayload = { jobs: [] };
    try { jobsPayload = await api("/temu/api/jobs"); } catch { /* 任务读取失败时保留仓库和入库统计。 */ }
    const dashboard = buildHomeDashboard(overview, jobsPayload);
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
            <div class="home-sync"><span class="live-dot"></span><strong>数据自动更新</strong><small>任务和日志每 3 秒检查一次</small></div>
        </div>
        <section class="dashboard-metrics" aria-label="今日经营汇总">
            <article class="dashboard-metric metric-inventory"><span>仓库商品</span><strong>${productCount}</strong><small>${readyCount} 件资料可交付</small></article>
            <article class="dashboard-metric metric-sent"><span>今日发送商品</span><strong>${dashboard.todaySent}</strong><small>${dashboard.activeJobs} 个任务仍在处理或需核对</small></article>
            <article class="dashboard-metric metric-uploaded"><span>今日上传成功</span><strong>${dashboard.todayUploaded}</strong><small>已由目标店插件确认创建</small></article>
            <article class="dashboard-metric metric-attention"><span>今日异常</span><strong>${dashboard.todayAttention}</strong><small>结果未知、预检失败或商品失败</small></article>
        </section>
        <section class="dashboard-rankings" aria-label="累计流转排名">
            <section class="ranking-panel">
                <div class="workspace-heading"><div><h2>发送最多的商品</h2><p>按进入目标店任务商品包的次数降序排列。</p></div><span class="section-count">前 ${dashboard.topProducts.length} 项</span></div>
                ${renderDashboardRanking(dashboard.topProducts, "还没有商品发送记录。", "product")}
            </section>
            <section class="ranking-panel">
                <div class="workspace-heading"><div><h2>发送最多的来源店铺</h2><p>按来源批次累计发送的商品项数量降序排列。</p></div><span class="section-count">前 ${dashboard.topSources.length} 项</span></div>
                ${renderDashboardRanking(dashboard.topSources, "还没有来源店铺发送记录。", "source")}
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

/**
 * 商品库只列出近期在线、店名已核验且支持接收快照的目标插件。
 * 不能根据紫鸟店铺列表直接假定插件在线，否则“发送”会变成没有接收方的假成功。
 */
async function renderProducts(overview) {
    setNav("products");
    let agentResult = { agents: [] };
    try { agentResult = await api("/temu/api/jobs"); } catch {}
    const targetStores = (agentResult.agents || []).filter(agent => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId)
        .map(agent => ({ storeId: agent.storeId, storeName: agent.storeName || agent.pageStoreName || agent.storeId }));
    const readyCount = Number(overview.readyCount) || 0;
    const incompleteCount = Math.max(0, Number(overview.productCount) - readyCount);
    const sourceStores = [...new Map((overview.batches || []).filter(batch => batch.sourceStoreId).map(batch => [String(batch.sourceStoreId), batch.sourceStoreName || batch.shopName || batch.sourceStoreId])).entries()];
    app.innerHTML = `
        <div class="top catalog-top">
            <div class="top-copy">
                <h1>商品库</h1>
                <p class="lede">先核对已入库资料，再批量上传到目标店插件。商品是否重复由目标店插件在店铺会话内判断。</p>
            </div>
            <div class="catalog-top-stats"><span><b>${overview.productCount}</b> 个商品</span><span><b>${targetStores.length}</b> 个目标店在线</span></div>
        </div>
        <div class="catalog-filter-bar" aria-label="商品筛选和搜索">
            <label class="catalog-filter"><span>来源店铺</span><select id="source-store-filter"><option value="">全部来源店铺</option>${sourceStores.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("")}</select></label>
            <label class="catalog-filter"><span>标红状态</span><select id="blocked-filter"><option value="">全部商品</option><option value="blocked">仅看标红（上传失败）</option><option value="normal">仅看未标红</option></select></label>
            <label class="catalog-search"><span class="search-symbol" aria-hidden="true"></span><span class="visually-hidden">搜索商品</span><input id="product-search" type="search" placeholder="搜索名称、货号、SPU、SKU、Goods ID" autocomplete="off"><span class="search-count" id="search-count" aria-live="polite">${overview.productCount} 个结果</span></label>
        </div>
        <div class="catalog-connection-row" aria-label="连接店铺状态"><span class="connection-pulse" aria-hidden="true"></span><strong>${targetStores.length} 个目标店铺已连接</strong><span class="muted">在线插件可接收批量上传任务</span><span class="connection-stores">${targetStores.map(store => escapeHtml(store.storeName || store.storeId)).join("、") || "暂无在线店铺"}</span></div>
        <div class="catalog-action-row" aria-label="商品操作">
            <div class="catalog-action-left"><label class="select-all"><input id="select-all-products" type="checkbox"><span></span>全选当前结果</label><button type="button" class="toolbar-button danger" id="delete-selected" disabled>删除</button><button type="button" class="toolbar-button" id="unblock-selected" disabled>解除标红</button><button type="button" class="toolbar-button" id="batch-target-trigger" ${targetStores.length ? "" : "disabled"}>选择目标店铺</button><button type="button" class="toolbar-button" id="catalog-upload-button">导入资料</button><input class="visually-hidden" id="catalog-files" type="file" accept="application/json,.json" multiple></div>
            <span class="selection-count" id="selection-count">已选择 0 个</span><span class="catalog-count-total">共 ${overview.productCount} 个商品</span>
        </div>
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
                <div class="batch-dialog-footer"><span id="batch-dialog-count">已选择 0 家店铺</span><button type="submit" value="apply" class="toolbar-button primary">完成选择</button></div>
            </form>
        </dialog>
        <dialog id="single-target-dialog" class="batch-target-dialog" aria-labelledby="single-target-dialog-title">
            <form method="dialog">
                <div class="batch-dialog-head"><div><h2 id="single-target-dialog-title">选择上传店铺</h2><p>为 <strong id="single-target-spu">当前商品</strong> 选择一个或多个已连接店铺。点击“确定上传”即表示确认该商品符合适用要求，并同意平台《商品合规声明》V2.0；重复检索由目标店插件完成。</p></div><button type="submit" value="cancel" class="dialog-close" aria-label="关闭">×</button></div>
                <label class="batch-dialog-search"><span class="search-symbol" aria-hidden="true"></span><span class="visually-hidden">搜索上传店铺</span><input id="single-target-search" type="search" placeholder="搜索店铺名称或 ID" autocomplete="off"></label>
                <label class="batch-dialog-select-all"><input id="single-target-select-all" type="checkbox"><span></span>全选当前店铺</label>
                <div class="batch-target-options" id="single-target-options">${targetStores.map(store => `<label class="batch-target-option" data-store-search="${escapeHtml(`${store.storeName || store.storeId} ${store.storeId}`.toLocaleLowerCase())}"><input type="checkbox" value="${escapeHtml(store.storeId)}"><span class="batch-target-check"></span><strong>${escapeHtml(store.storeName || store.storeId)}</strong><small>${escapeHtml(store.storeId)} · 在线，可接收上传任务</small></label>`).join("") || `<p class="muted">暂无在线目标店铺。</p>`}</div>
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
    bindProductInventory(overview, targetStores);
}

/** 商品库为空时只提示入库路径，不再描述已经废弃的排除状态。 */
function renderCatalogEmpty() {
    return `<div class="catalog-empty">还没有解析出商品。插件采集完成后需要成功推送到入库台，或在这里上传完整采集包。</div>`;
}

/**
 * 单商品上传只接收弹窗确认后的目标店列表，并按店铺逐个创建任务；重复判断仍由目标店插件执行。
 * 这样商品行不再承载多选框，用户可以先明确目标，再一次性确认本次上传。
 */
async function submitSingleProduct({ product, sourceBatch, targets, button, toast }) {
    const spuId = String(product?.spuId || "");
    if (!product?.ready) throw new Error(`SPU ${spuId} 资料未齐，暂不能发送。请先补齐详情、图片和 SKU。`);
    if (!sourceBatch) throw new Error("该商品尚无可追溯的完整来源资料，请重新导入完整采集包并确认来源店铺。");
    const capability = await api("/temu/api/direct-create-capability").catch(() => null);
    if (!capability?.directCreate) throw new Error("后台尚未启用接口创建，请重启本地网站及连接器后再试。");
    if (!targets.length) throw new Error("请至少选择一个在线且身份已匹配的目标店插件。");
    if (button) {
        button.disabled = true;
        button.textContent = "上传中…";
    }
    if (toast) toast.innerHTML = `<div class="toast">正在向 ${escapeHtml(String(targets.length))} 家目标店上传 SPU ${escapeHtml(spuId)}…</div>`;
    try {
        const results = [];
        const failures = [];
        // 多店单商品任务逐店创建，保留每家店独立的任务编号和失败原因，避免一店异常阻断其他店。
        for (const target of targets) {
            try {
                const result = await api("/temu/api/jobs", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        sourceStoreId: sourceBatch.sourceStoreId,
                        sourceStoreName: sourceBatch.sourceStoreName || sourceBatch.shopName,
                        targetStoreId: target.storeId,
                        targetStoreName: target.storeName,
                        sourceBatchId: sourceBatch.id,
                        spuIds: [spuId],
                        requireOnline: true,
                        replaceExisting: true,
                        directCreate: true,
                        complianceVersion: "V2.0"
                    })
                });
                results.push(`${target.storeName}：${result.job.id}`);
            } catch (error) {
                failures.push(`${target.storeName}：${error.message}`);
            }
        }
        if (!results.length) throw new Error(failures.join("；") || "没有目标店任务创建成功");
        if (toast) toast.innerHTML = `<div class="toast ${failures.length ? "error" : "success"}">SPU ${escapeHtml(spuId)} 已向 ${escapeHtml(String(results.length))} 家目标店排队：${escapeHtml(results.join("；"))}${failures.length ? `；失败：${escapeHtml(failures.join("；"))}` : ""}。插件会在目标店页面内检索重复。</div>`;
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = "上传";
        }
    }
}

/**
 * 商品库筛选只作用于已经入库的本地集合，避免把搜索词误当成新的服务器查询条件；
 * 这样离线查看和后续接入分页接口时，仓库数据边界仍然清楚。
 */
function bindProductInventory(overview, targetStores) {
    const input = document.getElementById("product-search");
    const sourceStoreFilter = document.getElementById("source-store-filter");
    const rows = [...document.querySelectorAll("[data-product-row]")];
    const selectAll = document.getElementById("select-all-products");
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
    const batchTargetOptions = [...document.querySelectorAll("#batch-target-options .batch-target-option")];
    const batchStoreSummary = document.getElementById("batch-store-summary");
    const batchDialogCount = document.getElementById("batch-dialog-count");
    const singleTargetDialog = document.getElementById("single-target-dialog");
    const singleTargetSpu = document.getElementById("single-target-spu");
    const singleTargetSearch = document.getElementById("single-target-search");
    const singleTargetSelectAll = document.getElementById("single-target-select-all");
    const singleTargetOptions = [...document.querySelectorAll("#single-target-options .batch-target-option")];
    const singleTargetCount = document.getElementById("single-target-count");
    if (!input || !selectAll || !deleteSelected) return;
    selectAll.disabled = rows.length === 0;

    const visibleRows = () => rows.filter((row) => !row.hidden);
    const checkedBoxes = () => rows.map((row) => row.querySelector(".product-checkbox")).filter((box) => box && box.checked);
    const selectedTargetOptions = () => [...(batchTargetStores?.selectedOptions || [])].filter(option => option.value);
    const updateTargetSummary = () => {
        const selected = selectedTargetOptions();
        if (batchStoreSummary) batchStoreSummary.textContent = selected.length
            ? `已选择 ${selected.length} 家店铺：${selected.map(option => option.textContent.trim()).join("、")}`
            : "尚未选择目标店铺";
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
    batchTargetOptions.forEach(option => option.querySelector("input")?.addEventListener("change", syncDialogCount));
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
    singleTargetOptions.forEach(option => option.querySelector("input")?.addEventListener("change", syncSingleDialogCount));
    singleTargetDialog?.addEventListener("close", async () => {
        const spuId = String(singleTargetDialog.dataset.spu || "");
        if (singleTargetDialog.returnValue !== "apply" || !spuId) {
            resetSingleDialog();
            return;
        }
        if (singleUploadBusy) {
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
            singleTargetDialog.dataset.spu = "";
            resetSingleDialog();
        }
    });
    resetSingleDialog();
    const syncSelection = () => {
        const visibleBoxes = visibleRows().map((row) => row.querySelector(".product-checkbox")).filter(Boolean);
        const checkedVisible = visibleBoxes.filter((box) => box.checked).length;
        const selected = checkedBoxes().length;
        selectAll.checked = Boolean(visibleBoxes.length) && checkedVisible === visibleBoxes.length;
        selectAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleBoxes.length;
        deleteSelected.disabled = selected === 0;
        // 解除标红只对当前选中的标红商品有意义；没有选中标红商品时按钮保持禁用。
        // 标红状态记在行上（checkedBoxes 返回的是 checkbox），必须回到行元素读取。
        const unblockButton = document.getElementById("unblock-selected");
        if (unblockButton) unblockButton.disabled = checkedBoxes().filter((box) => box.closest("[data-product-row]")?.dataset.blocked === "1").length === 0;
        selectionCount.textContent = `已选择 ${selected} 个`;
        const targetCount = [...(batchTargetStores?.selectedOptions || [])].filter(option => option.value).length;
        if (batchDirectCreate) batchDirectCreate.disabled = selected === 0 || targetCount === 0;
        updateTargetSummary();
    };
    const filterRows = () => {
        const query = input.value.trim().toLocaleLowerCase();
        const sourceStoreId = String(sourceStoreFilter?.value || "");
        // 标红与店铺是两个独立维度，必须同时生效：先按店铺缩小范围，再按标红状态筛选。
        const blockedFilter = String(document.getElementById("blocked-filter")?.value || "");
        rows.forEach((row) => {
            const matchesQuery = !query || String(row.dataset.search || "").includes(query);
            const matchesStore = !sourceStoreId || String(row.dataset.sourceStores || "").split(",").includes(sourceStoreId);
            const isBlocked = String(row.dataset.blocked || "0") === "1";
            const matchesBlocked = !blockedFilter || (blockedFilter === "blocked" ? isBlocked : !isBlocked);
            row.hidden = !(matchesQuery && matchesStore && matchesBlocked);
            // “全选当前结果”只对当前可见筛选结果负责；换搜索词时自动取消隐藏行，避免误删上一轮选择。
            if (row.hidden) {
                const box = row.querySelector(".product-checkbox");
                if (box) box.checked = false;
            }
        });
        searchCount.textContent = `${visibleRows().length} 个结果`;
        syncSelection();
    };
    input.addEventListener("input", filterRows);
    sourceStoreFilter?.addEventListener("change", filterRows);
    document.getElementById("blocked-filter")?.addEventListener("change", filterRows);
    rows.forEach((row) => row.querySelector(".product-checkbox")?.addEventListener("change", syncSelection));
    batchTargetStores?.addEventListener("change", syncSelection);
    selectAll.addEventListener("change", () => {
        visibleRows().forEach((row) => {
            const box = row.querySelector(".product-checkbox");
            if (box) box.checked = selectAll.checked;
        });
        syncSelection();
    });
    deleteSelected.addEventListener("click", () => deleteInventoryProducts(checkedBoxes().map((box) => box.value)));
    document.getElementById("unblock-selected")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        // 只解除选中的标红商品：未标红的商品无需处理，避免把正常商品也写一遍。
        const targets = [...new Set(checkedBoxes()
            .filter((box) => box.closest("[data-product-row]")?.dataset.blocked === "1")
            .map((box) => box.value))];
        if (!targets.length) return;
        if (!window.confirm(`确认解除 ${targets.length} 个商品的标红？解除后这些商品可以再次上传。`)) return;
        button.disabled = true;
        button.textContent = "解除中…";
        try {
            await api("/temu/api/products/unblock", { method: "POST", body: JSON.stringify({ spuIds: targets }) });
            await refresh();
        } catch (error) {
            window.alert(`解除标红失败：${error.message}`);
        } finally {
            button.disabled = false;
            button.textContent = "解除标红";
        }
    });
    rows.forEach((row) => row.querySelector("[data-delete-spu]")?.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteInventoryProducts([event.currentTarget.dataset.deleteSpu]);
    }));
    rows.forEach((row) => row.querySelector("[data-transfer-spu]")?.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const button = event.currentTarget;
        const spuId = String(button.dataset.transferSpu || "");
        const product = (overview.products || []).find(item => String(item.spuId) === spuId);
        const toast = document.getElementById("catalog-toast");
        if (singleUploadBusy) {
            if (toast) toast.innerHTML = `<div class="toast">已有单商品上传正在处理中，请等待当前任务完成。</div>`;
            return;
        }
        if (!product?.ready) {
            if (toast) toast.innerHTML = `<div class="toast error">SPU ${escapeHtml(spuId)} 资料未齐，暂不能上传。请先补齐详情、图片和 SKU。</div>`;
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
    }));
    batchDirectCreate?.addEventListener("click", async () => {
        const toast = document.getElementById("catalog-toast");
        if (batchUploadBusy) {
            if (toast) toast.innerHTML = `<div class="toast">批量上传正在处理中，请等待当前任务完成。</div>`;
            return;
        }
        const selectedIds = checkedBoxes().map(box => String(box.value || "")).filter(Boolean);
        const targetIds = [...(batchTargetStores?.selectedOptions || [])].map(option => String(option.value || "")).filter(Boolean);
        const targets = (targetStores || []).filter(store => targetIds.includes(String(store.storeId)));
        if (!selectedIds.length || !targets.length) return;
        const products = selectedIds.map(spuId => (overview.products || []).find(item => String(item.spuId) === spuId)).filter(Boolean);
        const groups = new Map();
        const skipped = [];
        for (const product of products) {
            const sourceBatchId = product?.publicationData?.sourceBatchId;
            const sourceBatch = (overview.batches || []).find(batch => batch.id === sourceBatchId && (product.batchIds || []).includes(batch.id) && batch.sourceStoreId);
            // 标红商品即使被手工勾选也不能下发：必须先在来源店修正资料并重新采集覆盖。
            if (!product.ready || product.blocked || !sourceBatch) {
                skipped.push(String(product.spuId));
                continue;
            }
            const group = groups.get(sourceBatch.id) || { sourceBatch, spuIds: [] };
            group.spuIds.push(String(product.spuId));
            groups.set(sourceBatch.id, group);
        }
        if (!groups.size) {
            if (toast) toast.innerHTML = `<div class="toast error">所选商品没有可发送的完整来源批次${skipped.length ? `：${escapeHtml(skipped.join("、"))}` : ""}。</div>`;
            return;
        }
        batchUploadBusy = true;
        const capability = await api("/temu/api/direct-create-capability").catch(() => null);
        if (!capability?.directCreate) {
            batchUploadBusy = false;
            if (toast) toast.innerHTML = `<div class="toast error">后台尚未启用接口创建，请重启网站及连接器。</div>`;
            return;
        }
        const total = [...groups.values()].reduce((count, group) => count + group.spuIds.length, 0);
        if (!confirm(`将 ${total} 个商品发送到 ${targets.length} 家目标店？\n\n系统会按来源批次拆分任务，每家店独立接收；目标店插件会逐商品检索重复，结果待核对时不要重发。`)) {
            batchUploadBusy = false;
            return;
        }
        batchDirectCreate.disabled = true;
        const created = [];
        const failures = [];
        if (toast) toast.innerHTML = `<div class="toast">正在向 ${escapeHtml(String(targets.length))} 家目标店上传 ${escapeHtml(String(total))} 个商品…</div>`;
        try {
            // 一个接口任务只能引用一个来源批次；这里按“目标店 × 来源批次”拆分并逐个提交，避免混批导致服务器拒绝。
            for (const target of targets) {
                for (const group of groups.values()) {
                    try {
                        const result = await api("/temu/api/jobs", {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: JSON.stringify({
                                sourceStoreId: group.sourceBatch.sourceStoreId,
                                sourceStoreName: group.sourceBatch.sourceStoreName || group.sourceBatch.shopName,
                                targetStoreId: target.storeId,
                                targetStoreName: target.storeName,
                                sourceBatchId: group.sourceBatch.id,
                                spuIds: group.spuIds,
                                requireOnline: true,
                                replaceExisting: true,
                                directCreate: true,
                                complianceVersion: "V2.0"
                            })
                        });
                        created.push(`${target.storeName} / ${group.spuIds.length} 个：${result.job.id}`);
                    } catch (error) {
                        failures.push(`${target.storeName} / ${group.spuIds.length} 个：${error.message}`);
                    }
                }
            }
            if (!created.length) throw new Error(failures.join("；") || "没有任务创建成功");
                if (toast) toast.innerHTML = `<div class="toast ${failures.length || skipped.length ? "error" : "success"}">已创建批量上传任务，包含 ${escapeHtml(String(total - skipped.length))} 个商品；插件接收后会在工作日志显示进度。任务：${escapeHtml(created.join("；"))}${failures.length ? `；失败：${escapeHtml(failures.join("；"))}` : ""}${skipped.length ? `；跳过未完成资料：${escapeHtml(skipped.join("、"))}` : ""}</div>`;
            checkedBoxes().forEach(box => { box.checked = false; });
            syncSelection();
        } catch (error) {
            if (toast) toast.innerHTML = `<div class="toast error">批量发送失败：${escapeHtml(error.message)}</div>`;
        } finally {
            batchUploadBusy = false;
            batchDirectCreate.disabled = false;
        }
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
    syncSelection();
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

/** 删除前冻结所选 ID 并要求确认；接口成功后重新读取仓库，避免只做视觉移除。 */
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
        const result = await api("/temu/api/products", {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ spuIds: ids })
        });
        if (location.hash.startsWith("#/product/")) location.hash = "#/products";
        else await route();
        const nextToast = document.getElementById("catalog-toast");
        if (nextToast) {
            const missing = Array.isArray(result.missingIds) && result.missingIds.length ? `，${result.missingIds.length} 个已不在库存中` : "";
            // 商品库按货号合并成一行，删一行会连同同货号的其他 SPU 一起彻底删除，必须在回执里说明。
            const merged = Number(result.deletedCount) > Number(result.requestedCount || 0) ? `（含同货号的其他 SPU）` : "";
            nextToast.innerHTML = `<div class="toast success">已彻底删除 ${result.deletedCount} 个商品${merged}${missing}，仓库剩余 ${result.productCount} 个。</div>`;
        }
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
            <a href="/temu/api/files/${encodeURIComponent(file.storedName)}">下载</a>
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
function storeRuntimeSummary(agent, jobs, directoryStore = null) {
    const storeId = String(directoryStore?.storeId || agent?.storeId || "");
    const storeJobs = (jobs || []).filter((job) => String(job.targetStoreId || "") === storeId);
    const activeJobs = storeJobs.filter((job) => ["active", "attention"].includes(jobRecordGroup(job)));
    const items = activeJobs.flatMap((job) => (job.items || []).map((item) => ({ job, item })));
    const queued = items.filter(({ item }) => ["queued", "opening", "opened", "claimed", "retry_wait"].includes(String(item.status || ""))).length;
    const uploading = items.filter(({ item }) => ["received", "upload_opened"].includes(String(item.status || "")) || String(item.directState || "") === "creating").length;
    const failures = items.filter(({ item }) => ["failed", "identity_mismatch"].includes(String(item.status || ""))
        || ["unknown", "preflight_failed", "rejected"].includes(String(item.directState || ""))).length;
    const version = String(agent?.pluginVersion || "");
    const versionReady = /^10\.(?:9|[1-9]\d)\./.test(version);
    const deployTone = !agent?.pluginDetected ? "danger" : (!versionReady || !agent?.identityMatched || !agent?.canReceiveUploads ? "warn" : "ok");
    const deployText = !agent?.pluginDetected
        ? "插件未部署"
        : (!versionReady ? `版本待升级 ${version || "未知版"}` : (!agent?.identityMatched ? "店名未核验" : "已部署可接收"));
    const onlineTone = agent?.online ? "ok" : "idle";
    const sendTone = failures ? "danger" : (queued ? "active" : "ok");
    const sendText = failures ? `${failures} 项异常` : (queued ? `${queued} 项待发送` : "无待发送");
    const uploadTone = failures ? "danger" : (uploading || Number(agent?.pendingUploadCount || 0) ? "active" : "ok");
    const uploadText = failures ? `${failures} 项异常` : (uploading || Number(agent?.pendingUploadCount || 0)
        ? `${uploading + Number(agent?.pendingUploadCount || 0)} 项处理中`
        : "无上传任务");
    const runtimeTone = failures ? "danger" : (activeJobs.length ? "active" : (agent?.online ? "ok" : "idle"));
    const current = activeJobs[0];
    const currentText = current ? `${jobStatusLabel(current.status)} · ${current.id}` : "空闲";
    const errorTone = failures ? "danger" : "ok";
    const lastActivity = activeJobs.map((job) => job.updatedAt).filter(Boolean).sort().pop() || agent?.lastSeenAt || "";
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
        activeCount: activeJobs.length,
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
async function renderJobs(overview) {
    setNav("jobs");
    let storeResult = null;
    let storeError = null;
    try { storeResult = await api("/temu/api/ziniao/stores?scope=all&refresh=1"); } catch (error) { storeError = error; }
    let jobs = { jobs: [], agents: [] };
    try { jobs = await api("/temu/api/jobs"); } catch {}
    const stores = storeResult && Array.isArray(storeResult.stores) ? storeResult.stores : [];
    const directoryError = String(storeResult?.error || "");
    const targetAgents = (jobs.agents || []).filter(agent => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId);
    // 标红商品禁止再次上传，不能进入“创建任务”的可选清单；解除条件是重新采集覆盖，不是改这里的过滤。
    const readyProducts = (overview.products || []).filter((item) => item.ready && !item.blocked);
    const toneRank = { danger: 0, warn: 1, active: 2, ok: 3, idle: 4 };
    const agentByStore = new Map((jobs.agents || []).filter((agent) => agent.storeId).map((agent) => [String(agent.storeId), agent]));
    const directoryStores = (storeResult?.stores || []).filter((store) => store.storeId);
    const runtimeStores = [
        ...directoryStores.map((store) => ({ directoryStore: store, agent: agentByStore.get(String(store.storeId)) || null })),
        ...(jobs.agents || [])
            .filter((agent) => agent.storeId && !directoryStores.some((store) => String(store.storeId) === String(agent.storeId)))
            .map((agent) => ({ directoryStore: null, agent }))
    ];
    const runtimeRows = runtimeStores
        .map(({ directoryStore, agent }) => storeRuntimeSummary(agent, jobs.jobs || [], directoryStore))
        .sort((left, right) => toneRank[left.runtimeTone] - toneRank[right.runtimeTone]
            || right.failures - left.failures
            || left.storeName.localeCompare(right.storeName, "zh-CN"));
    const activeJobCount = (jobs.jobs || []).filter((job) => jobRecordGroup(job) === "active").length;
    const attentionJobCount = (jobs.jobs || []).filter((job) => jobRecordGroup(job) === "attention").length;
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
            <label class="task-product-option" data-batch-ids="${escapeHtml((item.batchIds || []).join(","))}" data-ready="${item.ready ? "1" : "0"}" data-search="${escapeHtml(searchText)}" ${item.ready ? "" : "hidden"}>
                <input type="checkbox" name="job-spu" value="${escapeHtml(item.spuId)}">
                <span class="task-product-check" aria-hidden="true"></span>
                <span class="task-product-copy"><strong>${escapeHtml(item.title || item.spuId)}</strong><small>SPU ${escapeHtml(item.spuId)} · 货号 ${escapeHtml(productCodes.join(" / ") || "—")}</small></span>
                <span class="task-product-state ${item.ready ? "ready" : "pending"}">${item.ready ? "资料可交付" : missingLabel(item)}</span>
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
            <button type="button" data-task-view-button="create" aria-selected="false">创建任务 <b>${readyProducts.length}</b></button>
            <button type="button" data-task-view-button="records" aria-selected="false">任务记录 <b>${(jobs.jobs || []).length}</b></button>
        </nav>
        <section class="task-view-panel live-status-panel" data-task-panel="status">
            <div class="live-status-toolbar">
                <label class="task-search"><span class="search-symbol" aria-hidden="true"></span><input id="store-runtime-search" type="search" placeholder="搜索店铺、ID 或当前任务" autocomplete="off"></label>
                <label><span>状态</span><select id="store-runtime-filter"><option value="all">全部状态</option><option value="danger">只看异常</option><option value="active">只看处理中</option><option value="offline">只看离线</option></select></label>
                <span class="live-status-note"><i></i>每 3 秒自动更新</span>
            </div>
            <div class="live-status-table-wrap">
                <table class="live-status-table">
                    <thead><tr><th>店铺</th><th>在线</th><th>插件部署</th><th>发送队列</th><th>商品上传</th><th>当前任务</th><th>异常</th><th>最后活动</th></tr></thead>
                    <tbody id="store-runtime-body">${renderStoreRuntimeRows(runtimeRows)}</tbody>
                </table>
            </div>
            <p class="live-status-empty" id="store-runtime-empty" role="status" hidden>没有匹配的店铺状态。</p>
        </section>
        <section class="task-view-panel task-create-panel" data-task-panel="create" hidden>
            <form id="job-form" class="task-layout">
                <div class="task-composer">
                    <section class="task-step">
                        <div class="task-step-heading"><span class="task-step-index">1</span><div><h2>来源与批次</h2><p>批次已经绑定采集店铺，来源店只用于提交前核对。</p></div></div>
                        <div class="task-field-grid">
                            <label>来源批次<select id="job-batch" required><option value="">请选择来源批次</option>${overview.batches.map((item) => `<option value="${escapeHtml(item.id)}" data-source-store="${escapeHtml(item.sourceStoreId || "")}">${escapeHtml(item.label || item.id)} · ${escapeHtml(item.sourceStoreName || item.shopName || "未知店铺")} · SPU ${item.counts.spu}</option>`).join("")}</select></label>
                            <label>识别到的来源店铺<select id="job-source-store" disabled aria-describedby="job-source-note"><option value="">选择批次后自动识别</option>${stores.map((item) => `<option value="${escapeHtml(item.storeId)}">${escapeHtml(item.name)} (${escapeHtml(item.storeId)})</option>`).join("")}</select><small id="job-source-note" class="field-note">来源店铺由批次采集信息锁定，避免选错店铺。</small></label>
                        </div>
                    </section>
                    <section class="task-step">
                        <div class="task-step-heading"><span class="task-step-index">2</span><div><h2>目标店铺</h2><p>只显示在线、插件在场且店名已核验的目标店。</p></div><button type="button" class="toolbar-button" id="job-target-trigger" ${targetAgents.length ? "" : "disabled"}>选择目标店铺</button></div>
                        <select id="job-target-store" class="visually-hidden" multiple aria-hidden="true" tabindex="-1">${targetAgents.map((item) => `<option value="${escapeHtml(item.storeId)}">${escapeHtml(item.storeName || item.pageStoreName || item.storeId)}</option>`).join("")}</select>
                        <div class="selection-chips" id="job-target-chips"><span class="selection-empty">尚未选择目标店铺</span></div>
                    </section>
                    <section class="task-step">
                        <div class="task-step-heading"><span class="task-step-index">3</span><div><h2>选择商品</h2><p>默认只看资料可交付商品；可以按名称、货号或 SPU 搜索。</p></div><span class="selection-count" id="job-product-visible-count">0 个可见</span></div>
                        <div class="task-product-tools">
                            <label class="task-search"><span class="search-symbol" aria-hidden="true"></span><input id="job-product-search" type="search" placeholder="搜索商品名称、货号或 SPU" autocomplete="off"></label>
                            <label class="task-check-toggle"><input id="job-ready-only" type="checkbox" checked><span>仅看资料可交付</span></label>
                            <label class="task-check-toggle"><input id="job-select-visible" type="checkbox"><span>全选当前结果</span></label>
                        </div>
                        <div class="transfer-products task-product-list" id="job-products">${productOptions || `<span class="workspace-empty">当前商品库为空，请先从来源店采集入库。</span>`}</div>
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
                    <button class="toolbar-button primary task-submit" id="job-submit" type="submit" ${targetAgents.length && readyProducts.length ? "" : "disabled"}>确认并接口创建</button>
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
                <div class="target-dialog-footer"><span id="job-target-dialog-count">已选择 0 家店铺</span><button type="submit" value="apply" class="toolbar-button primary">完成选择</button></div>
            </form>
        </dialog>
        <section class="task-view-panel task-records-panel" data-task-panel="records" hidden>
            <div class="task-record-toolbar">
                <div><h2>任务记录</h2><p>${jobs.jobs.length} 条任务，按处理结果筛选后查看商品级状态。</p></div>
                <div class="record-filters" role="group" aria-label="任务状态筛选">
                    <button type="button" class="filter-chip active" data-job-filter="attention">需处理</button>
                    <button type="button" class="filter-chip" data-job-filter="active">进行中</button>
                    <button type="button" class="filter-chip" data-job-filter="done">已完成</button>
                    <button type="button" class="filter-chip" data-job-filter="all">全部</button>
                </div>
            </div>
            <div class="transfer-jobs" id="job-records">${jobs.jobs.map(renderHubJob).join("") || `<p class="workspace-empty">还没有跨店任务。</p>`}</div>
        </section>
    `;
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
    document.getElementById("refresh-job-stores")?.addEventListener("click", () => route());
    const sourceStoreSelect = document.getElementById("job-source-store");
    const batchSelect = document.getElementById("job-batch");
    const targetDialog = document.getElementById("job-target-dialog");
    const targetStoreSelect = document.getElementById("job-target-store");
    const targetChecks = [...targetDialog.querySelectorAll('input[type="checkbox"][value]')];
    const productChecks = [...document.querySelectorAll('input[name="job-spu"]')];
    const productLabels = [...document.querySelectorAll("#job-products .task-product-option")];
    const productSearch = document.getElementById("job-product-search");
    const readyOnly = document.getElementById("job-ready-only");
    const selectVisible = document.getElementById("job-select-visible");
    const targetDialogCount = document.getElementById("job-target-dialog-count");
    const targetDialogSelectAll = document.getElementById("job-target-select-all");
    const summaryProducts = document.getElementById("job-summary-products");
    const summaryStores = document.getElementById("job-summary-stores");
    const summaryJobs = document.getElementById("job-summary-jobs");
    const submitButton = document.getElementById("job-submit");
    const selectedTargetIds = () => [...targetStoreSelect.selectedOptions].map(option => String(option.value || "")).filter(Boolean);
    const updateTaskSummary = () => {
        const productCount = productChecks.filter(input => input.checked).length;
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
    const applyProductVisibility = () => {
        const batchId = batchSelect?.value || "";
        const query = String(productSearch?.value || "").trim().toLocaleLowerCase();
        const onlyReady = Boolean(readyOnly?.checked);
        let visible = 0;
        productLabels.forEach(label => {
            const batchIds = String(label.dataset.batchIds || "").split(",").filter(Boolean);
            const matchesBatch = !batchId || batchIds.includes(batchId);
            const matchesReady = !onlyReady || label.dataset.ready === "1";
            const matchesQuery = !query || String(label.dataset.search || "").includes(query);
            label.hidden = !(matchesBatch && matchesReady && matchesQuery);
            if (!label.hidden) visible += 1;
        });
        const visibleInputs = productLabels.filter(label => !label.hidden).map(label => label.querySelector("input"));
        if (selectVisible) {
            const checked = visibleInputs.filter(input => input?.checked).length;
            selectVisible.checked = visibleInputs.length > 0 && checked === visibleInputs.length;
            selectVisible.indeterminate = checked > 0 && checked < visibleInputs.length;
        }
        const count = document.getElementById("job-product-visible-count");
        if (count) count.textContent = `${visible} 个可见`;
    };
    const syncSourceFromBatch = () => {
        const option = batchSelect?.selectedOptions?.[0];
        const batchStoreId = option?.getAttribute("data-source-store") || "";
        if (sourceStoreSelect && batchStoreId) sourceStoreSelect.value = batchStoreId;
        const batchId = batchSelect?.value || "";
        document.querySelectorAll("#job-products label[data-batch-ids]").forEach((label) => {
            const ids = String(label.getAttribute("data-batch-ids") || "").split(",").filter(Boolean);
            const mismatched = Boolean(batchId) && !ids.includes(batchId);
            if (mismatched) {
                const input = label.querySelector("input[name=job-spu]");
                if (input) input.checked = false;
            }
        });
        applyProductVisibility();
        updateTaskSummary();
    };
    batchSelect?.addEventListener("change", syncSourceFromBatch);
    productSearch?.addEventListener("input", applyProductVisibility);
    readyOnly?.addEventListener("change", applyProductVisibility);
    selectVisible?.addEventListener("change", () => {
        productLabels.filter(label => !label.hidden).forEach(label => {
            const input = label.querySelector('input[name="job-spu"]');
            if (input) input.checked = Boolean(selectVisible.checked);
        });
        updateTaskSummary();
    });
    productChecks.forEach(input => input.addEventListener("change", () => { applyProductVisibility(); updateTaskSummary(); }));
    document.getElementById("job-target-trigger")?.addEventListener("click", () => {
        applyTargetDialogFilter();
        targetDialog.showModal();
    });
    document.getElementById("job-target-search")?.addEventListener("input", applyTargetDialogFilter);
    targetChecks.forEach(input => input.addEventListener("change", () => {
        const option = [...targetStoreSelect.options].find(item => String(item.value) === String(input.value));
        if (option) option.selected = input.checked;
        renderTargetSelection();
        applyTargetDialogFilter();
    }));
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
    syncSourceFromBatch();
    applyProductVisibility();
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
        const spuIds = [...document.querySelectorAll("input[name=job-spu]:checked")].map((input) => input.value);
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
        if (targetStoreIds.includes(sourceStoreId)) {
            message.textContent = "来源店不能同时作为目标店，请取消该选择。";
            return;
        }
        const capability = await api("/temu/api/direct-create-capability").catch(()=>null);
        if (!capability?.directCreate) { message.textContent = "后台尚未启用接口创建，请重启网站及连接器。"; return; }
        if (!spuIds.length) { message.textContent = "请至少选择一个商品。"; return; }
        if (!confirm(`将 ${spuIds.length} 个商品直接创建到 ${targetStoreNames.join("、")}？\n确认表示这些商品符合适用要求，并同意平台《商品合规声明》V2.0。\n创建不等于上架，结果待核对时不要重发。`)) return;
        message.textContent = `正在为 ${targetStoreNames.length} 家目标店创建任务…`;
        try {
            const created = [];
            const failed = [];
            // 多店任务逐店提交，某一家店离线时不会影响其他已选店铺。
            for (const target of selectedTargets) {
                try {
                    const result = await api("/temu/api/jobs", {
                        method: "POST",
                        headers: { "content-type": "application/json" },
                        // 批量发送同样仅覆盖重叠待办，不影响旧批次中的其他商品。
                        body: JSON.stringify({ sourceStoreId, targetStoreId: target.storeId, sourceStoreName, targetStoreName: target.storeName || target.pageStoreName || target.storeId, sourceBatchId, spuIds, requireOnline: true, replaceExisting: true, directCreate: true, complianceVersion: "V2.0" })
                    });
                    created.push(`${target.storeName || target.storeId}：${result.job.id}`);
                } catch (error) {
                    failed.push(`${target.storeName || target.storeId}：${error.message}`);
                }
            }
            if (!created.length) throw new Error(failed.join("；") || "没有目标店任务创建成功");
            message.textContent = `已创建 ${created.length} 家目标店任务${failed.length ? `，失败 ${failed.length} 家` : ""}。${created.join("；")}${failed.length ? `；失败：${failed.join("；")}` : ""}`;
            setTimeout(() => route(), 400);
        } catch (error) {
            message.textContent = `创建失败：${error.message}`;
        }
    });
    app.querySelectorAll("[data-job-filter]").forEach(button => {
        button.addEventListener("click", () => {
            app.querySelectorAll("[data-job-filter]").forEach(item => item.classList.toggle("active", item === button));
            const filter = button.getAttribute("data-job-filter") || "all";
            app.querySelectorAll("#job-records .job-record").forEach(record => {
                record.hidden = filter !== "all" && record.getAttribute("data-job-group") !== filter;
            });
        });
        if (button.getAttribute("data-job-filter") === "attention") button.click();
    });
    app.querySelectorAll("[data-job-action]").forEach((button) => {
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
    const itemStates = (job?.items || []).map(item => String(item.directState || ""));
    if (itemStates.some(state => ["unknown", "preflight_failed", "rejected"].includes(state))
        || ["failed", "partial", "blocked_preflight", "identity_mismatch"].includes(status)) return "attention";
    if (itemStates.includes("creating")) return "active";
    // 接口任务完成后 job.status 仍可能停在 received，实际是否结束要看商品项的 directState。
    if (itemStates.length && itemStates.every(state => ["created", "duplicate_exists"].includes(state))) return "done";
    if (ACTIVE_ITEM_STATUSES.has(status)) return "active";
    return "done";
}

function renderHubJob(job) {
    const actions = [];
    if (["queued", "blocked_preflight"].includes(job.status)) {
        actions.push(`<button type="button" class="toolbar-button" data-job-action="cancel" data-job-id="${escapeHtml(job.id)}">取消</button>`);
    }
    // 项目已经停下却仍在占位的任务（partial）同样要能取消，否则同店同货号会被永久挡住。
    const stuckItems = (job.items || []).filter((item) => ACTIVE_ITEM_STATUSES.has(String(item.status || "")));
    const blockedFromCancel = (job.items || []).some((item) => ["creating", "unknown"].includes(String(item.directState || "")));
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
    return `<article class="transfer-job job-record" data-job-group="${jobRecordGroup(job)}">
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
    direct_created: "平台创建并回查成功",
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
    if (["direct_unknown", "direct_preflight_failed", "failed", "blocked", "web_task_replaced"].includes(type)) return "attention";
    if (["direct_created", "plugin_uploaded"].includes(type)) return "done";
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
async function renderWorkLogs() {
    setNav("logs");
    const [payload, jobsPayload, storePayload] = await Promise.all([
        api("/temu/api/work-log"),
        api("/temu/api/jobs").catch(() => ({ jobs: [], agents: [] })),
        api("/temu/api/ziniao/stores?scope=all&refresh=1").catch(() => ({ stores: [] }))
    ]);
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
                <span class="auto-refresh-note"><i></i>每 3 秒自动更新</span>
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
        const shot = item.screenshot ? `<a href="/temu/api/transfer-jobs/${encodeURIComponent(job.id)}/artifacts/${encodeURIComponent(item.spuId)}.png" target="_blank" rel="noreferrer">截图</a>` : "";
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

async function route() {
    const hash = location.hash || "#/";
    try {
        if (hash === "#/" || hash === "#") {
            await renderHome(await api("/temu/api/overview"));
            return;
        }
        if (hash === "#/products") {
            await renderProducts(await api("/temu/api/overview"));
            return;
        }
        // 导入准备和转移任务仍保留旧地址，不再作为主流程入口。
        if (hash === "#/import") {
            renderImport(await api("/temu/api/overview"));
            return;
        }
        if (hash === "#/jobs") {
            await renderJobs(await api("/temu/api/overview"));
            return;
        }
        if (hash === "#/logs") {
            await renderWorkLogs();
            return;
        }
        if (hash === "#/transfers") {
            await renderTransfers(await api("/temu/api/overview"));
            return;
        }
        const batchMatch = hash.match(/^#\/batch\/([^/]+)/);
        if (batchMatch) {
            renderBatch(await api(`/temu/api/batches/${batchMatch[1]}`));
            return;
        }
        const productMatch = hash.match(/^#\/product\/([^/]+)/);
        if (productMatch) {
            renderProduct(await api(`/temu/api/products/${productMatch[1]}`));
            return;
        }
        app.innerHTML = `<p>没有这个页面。</p>`;
    } catch (error) {
        app.innerHTML = `<p>读数据失败：${escapeHtml(error.message)}</p>`;
    }
}

window.addEventListener("hashchange", route);
route();

/**
 * 自动刷新控制器：轮询服务器的变化信号，只有数据真的变了才整页重绘。
 * 轮询只读 /api/live 的紧凑签名，避免为了刷新反复拉取完整商品库和任务列表；
 * 首页、商品库、任务台和工作日志都在覆盖范围内，详情页保留操作者当前的阅读位置。
 */
const AUTO_REFRESH_MS = 3000;
const AUTO_REFRESH_HASHES = new Set(["#/", "#", "#/products", "#/jobs", "#/logs"]);
let autoRefreshBusy = false;
let lastLiveKey = "";

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
    const active = document.activeElement;
    const activeKey = active && app.contains(active) ? controlKey(active) : "";
    return {
        hash: location.hash || "#/",
        scrollY: window.scrollY,
        panels,
        workLogStore,
        taskView,
        controls,
        focus: activeKey ? { key: activeKey, start: active.selectionStart, end: active.selectionEnd } : null
    };
}

function restoreViewState(state) {
    // 页面已经切换时旧状态作废，不能把上一个页面的搜索结果套到新页面。
    if (!state || state.hash !== (location.hash || "#/")) return;
    // 顺序和人工操作一致：先还原筛选和下拉，再触发派生筛选，最后恢复勾选。
    const checks = [];
    for (const item of state.controls) {
        const element = findControl(item.key);
        if (!element) continue;
        if (element.type === "checkbox" || element.type === "radio") {
            checks.push([element, item.checked]);
            continue;
        }
        if (element.multiple) [...element.options].forEach((option) => { option.selected = item.value.includes(option.value); });
        else element.value = item.value;
    }
    ["product-search", "work-log-search", "job-product-search", "store-runtime-search"].forEach((id) => document.getElementById(id)?.dispatchEvent(new Event("input")));
    ["source-store-filter", "batch-target-stores", "work-log-outcome", "work-log-type", "work-log-time", "job-batch", "job-target-store", "store-runtime-filter"].forEach((id) => document.getElementById(id)?.dispatchEvent(new Event("change")));
    checks.forEach(([element, checked]) => {
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
    if (state.focus) {
        const target = findControl(state.focus.key);
        if (target) {
            target.focus({ preventScroll: true });
            try { target.setSelectionRange(state.focus.start, state.focus.end); } catch {}
        }
    }
    window.scrollTo(0, state.scrollY);
}

/** 任何一项变化都代表页面已展示的内容需要重新读取。 */
function liveKey(live) {
    return [live.inbox, live.inventory, live.agents, live.jobs, live.logs].join("|");
}

/** 自动刷新不能覆盖用户正在进行的操作：弹窗、拖拽、扫描、上传和删除都要让路。 */
function autoRefreshBlocked() {
    if (document.visibilityState !== "visible") return true;
    if (!AUTO_REFRESH_HASHES.has(location.hash || "#/")) return true;
    if (document.querySelector("dialog[open]")) return true;
    if (document.getElementById("inbox-scan")?.disabled) return true;
    if (document.getElementById("drop")?.classList.contains("drag")) return true;
    return singleUploadBusy || batchUploadBusy || inventoryDeletionBusy;
}

async function pollLiveChanges() {
    if (autoRefreshBusy || autoRefreshBlocked()) return;
    autoRefreshBusy = true;
    try {
        const key = liveKey(await api("/temu/api/live"));
        if (!lastLiveKey) {
            lastLiveKey = key;
            return;
        }
        if (key === lastLiveKey) return;
        lastLiveKey = key;
        const saved = captureViewState();
        await route();
        restoreViewState(saved);
    } catch {
        // 轮询失败保持静默：不清空页面已有内容，也不覆盖已有的错误提示，下一次轮询自然重试。
    } finally {
        autoRefreshBusy = false;
    }
}

setInterval(pollLiveChanges, AUTO_REFRESH_MS);
// 切回标签页或窗口重新获得焦点时立即核对一次，避免操作者盯着后台期间留下的过期信息。
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") pollLiveChanges(); });
window.addEventListener("focus", pollLiveChanges);
