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
 * 工作日志按目标店铺分组。同一目标店的来源店名只作辅助说明，避免所有店混成一条时间线。
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
    const response = await fetch(path, options);
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
            <article class="product-row" data-product-row data-search="${escapeHtml(searchText)}" data-source-stores="${escapeHtml(sourceStoreIds.join(","))}" data-spu="${escapeHtml(product.spuId)}">
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
                <span class="ticket-status ${product.ready ? "ready" : "pending"}">${product.ready ? (product.completeness?.detailState === "source-empty" ? "已采集 · 源正文为空" : "资料可交付") : missingLabel(product)}</span>
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

function renderHome(overview) {
    setNav("home");
    const productCount = Number(overview.productCount) || 0;
    const readyCount = Number(overview.readyCount) || 0;
    const missingDetailCount = Number(overview.missingDetailCount) || 0;
    const missingImageCount = Number(overview.missingImageCount) || 0;
    app.innerHTML = `
        <div class="top catalog-top">
            <div class="top-copy">
                <h1>查验台</h1>
                <p class="lede">来源店采集完成后，完整包会进入中转仓。这里先看有没有收到、解析出多少商品、资料缺什么。</p>
            </div>
            <div class="top-context"><span class="live-dot"></span>本地仓库运行中</div>
        </div>
        <section class="ingest-card" id="inbox-card" aria-label="采集入库状态">
            <div class="panel-heading"><h2>采集入库</h2><span class="panel-kicker">正在读取监控状态…</span></div>
            <p class="muted">正在读取固定目录监控状态…</p>
        </section>
        <section class="metric-grid" aria-label="商品统计">
            <div class="metric-card metric-primary"><span>当前商品</span><strong>${productCount}</strong><small>去重后的标准商品</small></div>
            <div class="metric-card"><span>资料可交付</span><strong>${readyCount}</strong><small>图片、SKU 和详情资料可核验；发布仍需目标店校验</small></div>
            <div class="metric-card"><span>待采详情</span><strong>${missingDetailCount}</strong><small>另有 ${Number(overview.sourceEmptyDetailCount) || 0} 件已采集但源正文为空</small></div>
            <div class="metric-card"><span>缺图片</span><strong>${missingImageCount}</strong><small>已入库但还没有可用主图</small></div>
        </section>
        <label class="drop" id="drop">
            <span class="drop-symbol" aria-hidden="true">＋</span>
            <span class="drop-copy"><strong>上传采集文件</strong><small>可手动补传完整包。目录监控只自动收取 temu-full-capture 文件</small></span>
            <span class="drop-button">选择文件</span>
            <input class="file-input" id="files" type="file" accept="application/json,.json" multiple>
        </label>
        <div id="toast"></div>
        <section class="section-block" aria-label="批次列表">
            <div class="section-heading"><div><h2>最近批次</h2><p>每个批次保留原始文件和解析结果，便于回溯。</p></div><span class="section-count">${overview.batchCount} 个批次</span></div>
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
            `).join("") || `<div class="board-row"><span>还没有批次</span></div>`}
            </div>
        </section>
    `;
    bindDrop();
    bindInboxCard();
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
    if (!card) return;
    try {
        const status = await api("/temu/api/inbox/status");
        const recent = Array.isArray(status.recent) ? status.recent.slice(0, 8) : [];
        card.innerHTML = `
            <div class="panel-heading"><h2>采集入库</h2><span class="panel-kicker">${status.running ? "监控中" : "已停止"}</span></div>
            <p class="muted">监控目录：${(status.directories || []).map(escapeHtml).join("<br>") || "未配置"}</p>
            <dl class="ingest-meta">
                <div><dt>新文件已入库</dt><dd class="num">${status.imported || 0}</dd></div>
                <div><dt>重复文件</dt><dd class="num">${status.reused || 0}</dd></div>
                <div><dt>失败</dt><dd class="num">${status.failed || 0}</dd></div>
            </dl>
            <div class="recent-files">${recent.map(renderRecentFile).join("") || `<p class="muted">还没有扫描到完整采集包。</p>`}</div>
            <div class="ingest-actions"><button type="button" class="drop-button" id="inbox-scan">立即扫描</button>${status.lastError ? `<span class="toast error">${escapeHtml(status.lastError)}</span>` : ""}</div>
        `;
        card.querySelector("#inbox-scan")?.addEventListener("click", async () => {
            const button = card.querySelector("#inbox-scan");
            if (button) { button.disabled = true; button.textContent = "扫描中…"; }
            try { await api("/temu/api/inbox/scan", { method: "POST" }); await route(); }
            catch (error) { if (button) { button.disabled = false; button.textContent = `扫描失败：${error.message}`; } }
        });
    } catch (error) {
        card.innerHTML = `<div class="panel-heading"><h2>采集入库</h2></div><p class="muted">读取失败：${escapeHtml(error.message)}</p>`;
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
            <label class="catalog-search"><span class="search-symbol" aria-hidden="true"></span><span class="visually-hidden">搜索商品</span><input id="product-search" type="search" placeholder="搜索名称、货号、SPU、SKU、Goods ID" autocomplete="off"><span class="search-count" id="search-count" aria-live="polite">${overview.productCount} 个结果</span></label>
        </div>
        <div class="catalog-connection-row" aria-label="连接店铺状态"><span class="connection-pulse" aria-hidden="true"></span><strong>${targetStores.length} 个目标店铺已连接</strong><span class="muted">在线插件可接收批量上传任务</span><span class="connection-stores">${targetStores.map(store => escapeHtml(store.storeName || store.storeId)).join("、") || "暂无在线店铺"}</span></div>
        <div class="catalog-action-row" aria-label="商品操作">
            <div class="catalog-action-left"><label class="select-all"><input id="select-all-products" type="checkbox"><span></span>全选当前结果</label><button type="button" class="toolbar-button danger" id="delete-selected" disabled>删除</button><button type="button" class="toolbar-button" id="batch-target-trigger" ${targetStores.length ? "" : "disabled"}>选择目标店铺</button><button type="button" class="toolbar-button" id="catalog-upload-button">导入资料</button><input class="visually-hidden" id="catalog-files" type="file" accept="application/json,.json" multiple></div>
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
        selectionCount.textContent = `已选择 ${selected} 个`;
        const targetCount = [...(batchTargetStores?.selectedOptions || [])].filter(option => option.value).length;
        if (batchDirectCreate) batchDirectCreate.disabled = selected === 0 || targetCount === 0;
        updateTargetSummary();
    };
    const filterRows = () => {
        const query = input.value.trim().toLocaleLowerCase();
        const sourceStoreId = String(sourceStoreFilter?.value || "");
        rows.forEach((row) => {
            const matchesQuery = !query || String(row.dataset.search || "").includes(query);
            const matchesStore = !sourceStoreId || String(row.dataset.sourceStores || "").split(",").includes(sourceStoreId);
            row.hidden = !(matchesQuery && matchesStore);
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
            if (!product.ready || !sourceBatch) {
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
 * 任务台只给指定目标店派发领取任务。不会向所有插件广播，也不会在这一页保存草稿或发布。
 */
async function renderJobs(overview) {
    setNav("jobs");
    let storeResult = null;
    let storeError = null;
    try { storeResult = await api("/temu/api/ziniao/stores?refresh=1"); } catch (error) { storeError = error; }
    let jobs = { jobs: [], agents: [] };
    try { jobs = await api("/temu/api/jobs"); } catch {}
    const stores = storeResult && Array.isArray(storeResult.stores) ? storeResult.stores : [];
    const targetAgents = (jobs.agents || []).filter(agent => agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId);
    const readyProducts = (overview.products || []).filter((item) => item.ready);
    app.innerHTML = `
        <div class="top">
            <div class="top-copy">
                <h1>任务台</h1>
                <p class="lede">选择商品和目标店，确认合规后直接调用新增接口，无需填写表单。创建不等于已审核上架；结果待核对时不要重发。</p>
            </div>
            <div class="top-context">${jobs.agents.length} 个已检查店铺窗口</div>
        </div>
        <section class="panel transfer-panel">
            <div class="panel-heading"><h2>创建指定店铺任务</h2><button type="button" class="drop-button" id="refresh-job-stores">刷新店铺</button></div>
            ${storeError ? `<p class="toast error">读取店铺失败：${escapeHtml(storeError.message)}。本机工人和紫鸟客户端需要先启动。</p>` : ""}
            <form id="job-form" class="transfer-form">
                <label>来源店铺<select id="job-source-store" required><option value="">${stores.length ? "请选择来源店铺" : "暂无店铺"}</option>${stores.map((item) => `<option value="${escapeHtml(item.storeId)}">${escapeHtml(item.name)} (${escapeHtml(item.storeId)})</option>`).join("")}</select></label>
                <label>目标店铺（可多选，仅在线插件）<select id="job-target-store" multiple size="${Math.min(6, Math.max(2, targetAgents.length))}" required>${targetAgents.length ? targetAgents.map((item) => `<option value="${escapeHtml(item.storeId)}">${escapeHtml(item.storeName || item.pageStoreName || item.storeId)} (${escapeHtml(item.storeId)})</option>`).join("") : `<option value="">暂无可接收的目标插件</option>`}</select><small class="muted">按住 Ctrl（Windows）或 ⌘（Mac）可选择多个店铺</small></label>
                <label>来源批次<select id="job-batch" required><option value="">请选择来源批次</option>${overview.batches.map((item) => `<option value="${escapeHtml(item.id)}" data-source-store="${escapeHtml(item.sourceStoreId || "")}">${escapeHtml(item.label || item.id)} · ${escapeHtml(item.sourceStoreName || item.shopName || "未知店铺")} · SPU ${item.counts.spu}</option>`).join("")}</select></label>
                <fieldset><legend>商品（可多选）</legend><div class="transfer-products" id="job-products">${overview.products.map((item) => `<label data-batch-ids="${escapeHtml((item.batchIds || []).join(","))}"><input type="checkbox" name="job-spu" value="${escapeHtml(item.spuId)}"><span>${escapeHtml(item.title || item.spuId)} · SPU ${escapeHtml(item.spuId)}${item.ready ? "" : "（资料未齐）"}</span></label>`).join("") || `<span class="muted">当前商品库为空，请先从来源店采集入库。</span>`}</div></fieldset>
                <button class="toolbar-button primary" type="submit" ${targetAgents.length && readyProducts.length ? "" : "disabled"}>确认并接口创建</button>
                <span id="job-message" class="muted" role="status"></span>
            </form>
        </section>
        <section class="panel">
            <div class="panel-heading"><h2>已登记 Agent</h2><span class="panel-kicker">${jobs.agents.length} 个</span></div>
            <div class="transfer-jobs">${(jobs.agents || []).map((agent) => `<article class="transfer-job"><strong>${escapeHtml(agent.storeName || agent.pageStoreName || agent.storeId || "未映射店铺")}</strong><span>${escapeHtml(agent.storeId || "待工人映射")}</span><span>${agent.pluginDetected ? "插件在场" : "未检测到插件"} · ${agent.identityMatched ? "店名匹配" : "店名未核验"}</span><span>${escapeHtml(agent.lastSeenAt || "")}</span><small>${escapeHtml(agent.pluginInstanceId || "无实例")} · ${escapeHtml(agent.pageUrl || "尚未上报页面")}${agent.pageStoreName ? ` · 页头 ${escapeHtml(agent.pageStoreName)}` : ""}</small></article>`).join("") || `<p class="muted">还没有店铺窗口登记。打开两家目标店后，插件会识别店名，本机工人会读取只读状态并映射紫鸟店铺。</p>`}</div>
        </section>
        <section class="panel">
            <div class="panel-heading"><h2>任务记录</h2><span class="panel-kicker">${jobs.jobs.length} 条</span></div>
            <div class="transfer-jobs">${jobs.jobs.map(renderHubJob).join("") || `<p class="muted">还没有跨店任务。</p>`}</div>
        </section>
    `;
    document.getElementById("refresh-job-stores")?.addEventListener("click", () => route());
    const sourceStoreSelect = document.getElementById("job-source-store");
    const batchSelect = document.getElementById("job-batch");
    const syncSourceFromBatch = () => {
        const option = batchSelect?.selectedOptions?.[0];
        const batchStoreId = option?.getAttribute("data-source-store") || "";
        if (sourceStoreSelect && batchStoreId) sourceStoreSelect.value = batchStoreId;
        const batchId = batchSelect?.value || "";
        document.querySelectorAll("#job-products label[data-batch-ids]").forEach((label) => {
            const ids = String(label.getAttribute("data-batch-ids") || "").split(",").filter(Boolean);
            label.hidden = Boolean(batchId) && !ids.includes(batchId);
            if (label.hidden) {
                const input = label.querySelector("input[name=job-spu]");
                if (input) input.checked = false;
            }
        });
    };
    batchSelect?.addEventListener("change", syncSourceFromBatch);
    syncSourceFromBatch();
    document.getElementById("job-form")?.addEventListener("submit", async (event) => {
        event.preventDefault();
        const message = document.getElementById("job-message");
        const sourceStoreId = document.getElementById("job-source-store")?.value || "";
        const targetStoreIds = [...(document.getElementById("job-target-store")?.selectedOptions || [])].map((option) => String(option.value || "")).filter(Boolean);
        const sourceBatchId = document.getElementById("job-batch")?.value || "";
        const sourceStoreName = stores.find((item) => item.storeId === sourceStoreId)?.name || "";
        const selectedTargets = targetAgents.filter((item) => targetStoreIds.includes(String(item.storeId)));
        const targetStoreNames = selectedTargets.map((item) => item.storeName || item.pageStoreName || item.storeId);
        const spuIds = [...document.querySelectorAll("input[name=job-spu]:checked")].map((input) => input.value);
        if (!message) return;
        const selectedBatch = overview.batches.find((item) => item.id === sourceBatchId);
        if (selectedBatch && selectedBatch.sourceStoreId && selectedBatch.sourceStoreId !== sourceStoreId) {
            message.textContent = "来源店必须和该批次采集时的店铺一致。";
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
        return `<li><span>SPU ${escapeHtml(item.spuId)}</span><span>${escapeHtml(DIRECT_ITEM_LABEL[item.directState] || jobStatusLabel(item.status))}</span><span>${escapeHtml(item.reason || "")}</span>${reset}</li>`;
    }).join("");
    return `<article class="transfer-job">
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
        dialog.innerHTML = `<h2 id="work-log-delete-title">删除该店工作日志？</h2><p id="work-log-delete-description">将清除 ${escapeHtml(storeName)} 最近 3 天的操作记录。已发送任务和平台商品不会被撤销。</p><form method="dialog"><button class="toolbar-button" value="cancel" autofocus>取消</button> <button class="toolbar-button danger" value="delete">确认删除</button></form>`;
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

/** 工作日志页按目标店分组展示任务动作，默认收起长时间线，减少运营扫描时的认知负担。 */
async function renderWorkLogs() {
    setNav("logs");
    const payload = await api("/temu/api/work-log");
    const stores = Array.isArray(payload.stores) ? payload.stores : groupWorkLogEntries(payload.entries || []);
    const entries = stores.flatMap((store) => store.entries || []);
    const label = {
        web_task_created: "网页创建发送任务",
        plugin_claimed: "目标插件领取商品",
        plugin_received: "目标插件已接收商品",
        plugin_upload_opened: "操作者打开上传页",
        plugin_uploaded: "操作者确认已上传",
        direct_creating: "新增接口提交中",
        direct_created: "平台创建并回查成功",
        direct_unknown: "结果待核对（禁止重发）",
        direct_preflight_failed: "预检失败（未提交）"
    };
    const storeOptions = stores
        .slice()
        .sort((left, right) => String(left.storeName || left.storeId).localeCompare(String(right.storeName || right.storeId), "zh-CN"))
        .map((store) => `<option value="${escapeHtml(store.storeId)}">${escapeHtml(store.storeName || store.storeId)}</option>`)
        .join("");
    app.innerHTML = `
        <div class="top work-log-top"><div class="top-copy"><h1>工作日志</h1><p class="lede">每个目标店铺单独保存最近 3 天的插件操作。默认收起长日志，展开后再查看明细；删除只清日志，不影响已发送任务。</p></div><div class="top-context">${stores.length} 家目标店 · ${entries.length} 条记录</div></div>
        <section class="panel work-log-controls" aria-label="工作日志筛选">
            <div class="work-log-search-field"><label for="work-log-search">搜索店铺</label><div class="work-log-search-wrap"><span class="search-symbol" aria-hidden="true"></span><input id="work-log-search" type="search" placeholder="店铺名、店铺 ID 或来源店铺" autocomplete="off"></div></div>
            <label class="work-log-store-filter" for="work-log-store-filter"><span>店铺筛选</span><select id="work-log-store-filter"><option value="">全部目标店铺</option>${storeOptions}</select></label>
            <div class="work-log-view-actions"><button type="button" class="drop-button" id="expand-work-logs" ${stores.length ? "" : "disabled"}>展开全部</button><button type="button" class="drop-button" id="collapse-work-logs" ${stores.length ? "" : "disabled"}>收起全部</button><span id="work-log-filter-count" class="work-log-filter-count" aria-live="polite">显示 ${stores.length} 家店铺</span></div>
            <p class="work-log-scope-note">当前提供日志搜索、筛选和清理；在线店铺读取与刷新在 <a href="#/jobs">任务台</a>，暂未提供店铺别名、归档或删除等独立管理。</p>
        </section>
        <div class="work-log-store-list" id="work-log-store-list">
        ${stores.map((store) => {
            // 来源店信息以每条日志为准累积，避免同一目标店接收多个来源店后只保留最后/第一家。
            const sourceLabels = [...new Set([
                store.sourceStoreName,
                store.sourceLabel,
                store.sourceStoreId,
                ...(store.entries || []).flatMap((entry) => [entry.sourceStoreName, entry.sourceStoreId])
            ].map((value) => String(value || "").trim()).filter(Boolean))];
            const sourceName = sourceLabels.join("、");
            const searchIndex = [store.storeName, store.storeId, ...sourceLabels].filter(Boolean).join(" ").toLocaleLowerCase();
            const latestAt = (store.entries || []).map((entry) => entry.at).filter(Boolean).sort().pop() || "";
            return `<details class="panel work-log-store" data-work-log-store data-store-id="${escapeHtml(store.storeId)}" data-search="${escapeHtml(searchIndex)}"><summary class="work-log-store-summary"><span class="work-log-summary-marker" aria-hidden="true"></span><span class="work-log-store-copy"><strong>${escapeHtml(store.storeName || store.storeId)}</strong><small>${escapeHtml(store.storeId)}${sourceName ? ` · 来源 ${escapeHtml(sourceName)}` : ""}</small></span><span class="work-log-summary-meta"><span class="work-log-store-count">${(store.entries || []).length} 条</span>${latestAt ? `<time datetime="${escapeHtml(latestAt)}">最新 ${escapeHtml(formatWorkLogTime(latestAt))}</time>` : ""}</span></summary><div class="work-log-store-body"><div class="work-log-store-tools"><span class="muted">展开查看该店铺的操作时间线</span><button type="button" class="toolbar-button danger" data-clear-store="${escapeHtml(store.storeId)}">删除该店日志</button></div><div class="work-log-list">${(store.entries || []).map((entry) => `<article class="work-log-entry"><time datetime="${escapeHtml(entry.at || "")}">${escapeHtml(formatWorkLogTime(entry.at))}</time><strong>${escapeHtml(label[entry.type] || entry.type || "操作")}</strong><span>任务 ${escapeHtml(entry.jobId || "—")} · SPU ${escapeHtml(entry.spuId || "—")}</span><p>${escapeHtml(entry.message || "")}</p></article>`).join("")}</div></div></details>`;
        }).join("")}
        </div>
        <p class="work-log-no-results" id="work-log-no-results" role="status" hidden>没有匹配的店铺日志，请调整搜索词或筛选条件。</p>
        ${stores.length ? "" : `<section class="panel"><p class="muted">还没有可记录的发送或上传操作。</p></section>`}
        <div class="work-log-actions"><button type="button" class="drop-button" id="refresh-work-log">刷新当前日志</button></div>`;
    bindWorkLogControls(stores.length);
    document.getElementById("refresh-work-log")?.addEventListener("click", () => route());
    document.querySelectorAll("[data-clear-store]").forEach((button) => {
        button.addEventListener("click", async () => {
            const storeId = button.getAttribute("data-clear-store") || "";
            const storeName = button.closest(".work-log-store")?.querySelector(".work-log-store-copy strong")?.textContent || storeId;
            if (!storeId || !(await confirmWorkLogRemoval(storeName))) return;
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
    });
}

/**
 * 工作日志筛选只隐藏店铺分组，不重新请求后端，保证搜索时不会打断正在查看的时间线。
 * 展开/收起操作仅作用于当前筛选可见的店铺，避免用户搜索后误打开隐藏分组。
 */
function bindWorkLogControls(totalStores) {
    const search = document.getElementById("work-log-search");
    const filter = document.getElementById("work-log-store-filter");
    const count = document.getElementById("work-log-filter-count");
    const noResults = document.getElementById("work-log-no-results");
    const stores = [...document.querySelectorAll("[data-work-log-store]")];
    const visibleStores = () => stores.filter((store) => !store.hidden);
    const applyFilter = () => {
        const query = (search?.value || "").trim().toLocaleLowerCase();
        const storeId = filter?.value || "";
        let visible = 0;
        stores.forEach((store) => {
            const matchesQuery = !query || (store.dataset.search || "").includes(query);
            const matchesStore = !storeId || store.dataset.storeId === storeId;
            store.hidden = !(matchesQuery && matchesStore);
            if (!store.hidden) visible += 1;
        });
        if (count) count.textContent = `显示 ${visible} / ${totalStores} 家店铺`;
        if (noResults) noResults.hidden = visible !== 0 || totalStores === 0;
    };
    search?.addEventListener("input", applyFilter);
    filter?.addEventListener("change", applyFilter);
    document.getElementById("expand-work-logs")?.addEventListener("click", () => visibleStores().forEach((store) => { store.open = true; }));
    document.getElementById("collapse-work-logs")?.addEventListener("click", () => visibleStores().forEach((store) => { store.open = false; }));
    applyFilter();
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
            renderHome(await api("/temu/api/overview"));
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
    const details = {};
    app.querySelectorAll("[data-work-log-store]").forEach((element) => {
        details[element.getAttribute("data-store-id") || ""] = element.open;
    });
    const active = document.activeElement;
    const activeKey = active && app.contains(active) ? controlKey(active) : "";
    return {
        hash: location.hash || "#/",
        scrollY: window.scrollY,
        panels,
        details,
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
    ["product-search", "work-log-search"].forEach((id) => document.getElementById(id)?.dispatchEvent(new Event("input")));
    ["source-store-filter", "batch-target-stores", "work-log-store-filter", "job-batch"].forEach((id) => document.getElementById(id)?.dispatchEvent(new Event("change")));
    checks.forEach(([element, checked]) => {
        element.checked = checked;
        element.dispatchEvent(new Event("change"));
    });
    Object.entries(state.panels).forEach(([id, html]) => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = html;
    });
    Object.entries(state.details).forEach(([storeId, open]) => {
        const element = app.querySelector(`[data-work-log-store][data-store-id="${CSS.escape(storeId)}"]`);
        if (element) element.open = open;
    });
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
