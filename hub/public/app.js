/**
 * 商品库负责选品发送，店铺认领保留在线、绑定和归属管理；不展示平台执行统计。
 */
const app = document.getElementById("app");

/**
 * 商品库的单商品/批量上传和库存删除进行中时冻结结构重绘，错误资格仍独立同步。
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
// 两个库共享呈现逻辑，但请求、选择和实时订阅必须具有不同的范围。
const isCatalogRoute = hash => hash === '#/products' || hash === '#/products/mine';
let catalogLibrary = location.hash === '#/products/mine' ? 'personal' : 'shared';
function libraryParams() { return catalogLibrary === 'personal' ? 'library=personal' : 'library=shared'; }
/** 同 SPU 在多个来源店是不同商品行，选择和发送必须按来源商品键识别。 */
function catalogKey(product) { return String(product?.productKey || JSON.stringify([product?.sourceStoreIds || [], product?.spuId])); }
function catalogRowProduct(products, row) { return products.find(product => catalogKey(product) === row?.dataset.productKey); }
/** 详情链接携带来源与库范围；同 SPU 的不同来源不能靠服务端默认顺序决定。 */
function productDetailLink(product) {
    return `#/product/${encodeURIComponent(product.spuId)}?${new URLSearchParams({ sourceStoreId: product.sourceStoreIds?.[0] || '', library: catalogLibrary })}`;
}
/** 管理入口只控制展示，写权限仍由服务端归属与分类检查决定。 */
function canManageCatalog() { return catalogLibrary === 'personal' || currentAccount?.isAdmin || currentAccount?.localMode; }
/** 删除只认可当前响应的写权限，不用共享/个人页面或管理员标签代替来源店权限。 */
function canDeleteProduct(product) { return product?.canDelete === true; }
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
// 错误状态独立补读，勾选、输入和发送不能阻止新的禁传资格生效。
let refreshCatalogStatus = null;
let viewInteractionVersion = 0;
for (const type of ["pointerdown", "keydown", "input", "change"]) {
    app.addEventListener(type, (event) => { if (event.isTrusted) viewInteractionVersion += 1; }, true);
}

/** 商品请求始终使用已提交的条件，避免未点击搜索的草稿被翻页带入。 */
function catalogPageUrl(page = catalogProductPage) {
    const params = new URLSearchParams({ productLimit: String(catalogProductPageSize), productOffset: String((page - 1) * catalogProductPageSize) });
    params.set('library', catalogLibrary);
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


const apiCache = new Map();

/**
 * GET 请求可短时复用成功结果；写入后清缓存，批量状态 POST 显式声明只读，不污染业务缓存。
 */
async function api(path, options = {}) {
    // 调用方按线上挂载前缀 /temu 书写路径；这里替换成当前地址的真实前缀，
    // 使线上（/temu）、本机直连（根路径）都能命中，且请求不会跳出本站。
    const { cacheMs = 0, force = false, readOnly = false, signal, ...fetchOptions } = options;
    const requestPath = path.startsWith("/temu/") ? `${siteRoot()}${path.slice("/temu".length)}` : path;
    const method = String(fetchOptions.method || "GET").toUpperCase();
    const cacheKey = `${method}:${requestPath}`;
    const cached = cacheMs > 0 && !force && method === "GET" ? apiCache.get(cacheKey) : null;
    if (cached && Date.now() - cached.at <= cacheMs) return cached.data;

    // 只读请求设置截止时间，网络悬挂不能永久锁住分页或轮询；写入请求不自动中断或重试。
    const readController = method === "GET" || readOnly ? new AbortController() : null;
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
        else if (method !== "GET" && !readOnly) apiCache.clear();
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

/** 列表只展示当前商品标识及错误状态，不在网页参与目标店判重或平台执行。 */
function renderProductRows(products, selectable = false, transferStores = [], sourceBatches = []) {
    const rows = Array.isArray(products) ? products : [];
    if (!rows.length) {
        // 商品库空态由 renderCatalogEmpty 区分库存为空与筛选无结果。
        return selectable ? "" : `<div class="catalog-empty">没有可显示的商品。</div>`;
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
            <article class="product-row${product.blocked || product.sendBlocked ? " product-row-blocked" : ""}" data-product-row data-search="${escapeHtml(searchText)}" data-source-stores="${escapeHtml(sourceStoreIds.join(","))}" data-blocked="${product.blocked || product.sendBlocked ? "1" : "0"}" data-spu="${escapeHtml(product.spuId)}" data-product-key="${escapeHtml(catalogKey(product))}">
                ${selectable ? `<label class="row-select" aria-label="选择 SPU ${escapeHtml(product.spuId)}"><input type="checkbox" class="product-checkbox" value="${escapeHtml(product.spuId)}"><span></span></label>` : ""}
                <a class="product-thumb" href="${productDetailLink(product)}" aria-label="查看 ${escapeHtml(product.title || product.spuId)}">
                    ${image ? `<img src="${escapeHtml(image)}" alt="" loading="lazy">` : `<span>无图</span>`}
                </a>
                <a class="product-row-main" href="${productDetailLink(product)}">
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
                <div data-product-status>${TemuProductErrorUI.statusMarkup(product, escapeHtml)}</div>
                ${selectable ? `<div class="row-actions"><button type="button" class="row-send" data-transfer-spu="${escapeHtml(product.spuId)}" aria-label="上传 SPU ${escapeHtml(product.spuId)}" ${!product.sendBlocked && !product.blocked && productBatches.length ? "" : "disabled"} title="${product.sendBlocked || product.blocked ? "商品已标红，解除标记后才能发送" : productBatches.length ? "选择任务类型和目标店铺" : "缺少可追溯的来源批次"}">上传</button><a href="${productDetailLink(product)}" class="row-detail">详情</a><button type="button" class="row-delete" ${canDeleteProduct(product) ? "" : "hidden"} data-delete-spu="${escapeHtml(product.spuId)}" aria-label="删除 SPU ${escapeHtml(product.spuId)}">删除</button></div>` : ""}
            </article>`;
    }).join("");
}

function setNav(name) {
    document.querySelectorAll("[data-nav]").forEach((link) => {
        if (link.dataset.nav === name) link.setAttribute("aria-current", "page");
        else link.removeAttribute("aria-current");
    });
}

/** 在线/绑定不改变，只在拆分任务的目标选择中排除无法识别新动作协议的旧插件。 */
function canReceiveSplitUpload(agent) {
    const version = /^11\.(\d+)\.(\d+)$/.exec(String(agent?.pluginVersion || ''));
    return Boolean(version && (Number(version[1]) > 0 || Number(version[2]) >= 4)
        && agent.online && agent.pluginDetected && agent.identityMatched && agent.canReceiveUploads && agent.storeId);
}

/**
 * 商品库只列出近期在线、店名已核验且支持接收快照的目标插件。
 * 不能根据紫鸟店铺列表直接假定插件在线，否则“发送”会变成没有接收方的假成功。
 */
function renderProducts(overview, agentResult = { agents: [], total: 0, hasMore: false }) {
    setNav("products");
    const productTotal = Math.max(0, Number(overview.productTotal ?? overview.productCount) || 0);
    const loadedProductCount = Array.isArray(overview.products) ? overview.products.length : 0;
    const targetStores = (agentResult.agents || []).filter(canReceiveSplitUpload)
        .map(agent => ({ storeId: agent.storeId, storeName: agent.storeName || agent.pageStoreName || agent.storeId }));
    const targetStoreTotal = Math.max(targetStores.length, Number(agentResult.total) || 0);
    const targetStoresHaveMore = Boolean(agentResult.hasMore);
    const sourceStores = Array.isArray(overview.sourceStores) && overview.sourceStores.length
        ? overview.sourceStores.map((store) => [String(store.storeId), store.storeName || store.storeId])
        : [...new Map((overview.batches || []).filter(batch => batch.sourceStoreId).map(batch => [String(batch.sourceStoreId), batch.sourceStoreName || batch.shopName || batch.sourceStoreId])).entries()];
    app.innerHTML = `
        <div class="top catalog-top">
            <div class="top-copy">
                <div class="catalog-title-line"><h1 class="visually-hidden">${catalogLibrary === 'personal' ? '个人商品库' : '商品库'}</h1><nav class="catalog-library-tabs" aria-label="商品库范围"><a href="#/products" ${catalogLibrary === 'shared' ? 'aria-current="page"' : ''}>商品库</a><a href="#/products/mine" ${catalogLibrary === 'personal' ? 'aria-current="page"' : ''}>个人商品库</a></nav></div>
                <p class="lede">先核对已入库资料，再批量上传到目标店插件。商品是否重复由目标店插件在店铺会话内判断。</p>
            </div>
            <div class="catalog-top-stats"><span><b id="catalog-product-total">${overview.productCount}</b> 个商品</span><span><b id="product-target-store-total">${targetStoreTotal}</b> 个目标店在线</span></div>
        </div>
        <div class="catalog-filter-bar" aria-label="商品筛选和搜索">
            <label class="catalog-filter"><span>来源店铺</span><select id="source-store-filter"><option value="">全部来源店铺</option>${sourceStores.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join("")}</select></label>
            <label class="catalog-filter"><span>标红状态</span><select id="blocked-filter"><option value="">全部商品</option><option value="blocked">仅看标红（处理异常）</option><option value="normal">仅看未标红</option></select></label>
            <form class="catalog-search-form" id="product-search-form" role="search"><label class="catalog-search"><span class="visually-hidden">搜索商品</span><input id="product-search" type="search" placeholder="名称、货号、SPU、SKU" title="搜索名称、货号、SPU、SKU、Goods ID" autocomplete="off" value="${escapeHtml(catalogFilters.draft)}"></label><button class="toolbar-button" type="submit">搜索</button><span class="visually-hidden" id="search-count" aria-live="polite">本页 ${loadedProductCount} / 共 ${productTotal} 个</span></form>
        </div>
        <div class="catalog-action-row" aria-label="商品操作">
            <div class="catalog-action-left"><label class="select-all"><input id="select-all-products" type="checkbox"><span></span>全选本页</label><button type="button" class="toolbar-button" id="clear-product-selection" disabled>清除选择</button><button type="button" class="toolbar-button danger" id="delete-selected" disabled>删除</button><button type="button" class="toolbar-button" id="unblock-selected" disabled>解除标红</button><button type="button" class="toolbar-button" id="batch-target-trigger" ${targetStores.length ? "" : "disabled"}>选择目标店铺</button><span id="catalog-live-pending" class="muted" role="status" hidden>有商品更新</span></div>
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
                <div class="upload-dialog-body">
                <div class="batch-dialog-head"><div><h2 id="single-target-dialog-title">选择目标店铺</h2><p>本次商品：<strong id="single-target-spu">当前商品</strong></p></div><button type="submit" value="cancel" class="dialog-close" aria-label="关闭">×</button></div>
                <fieldset class="upload-target-fields" id="upload-target-fields"><legend>本账户绑定的在线店铺</legend>
                <label class="batch-dialog-search"><span class="search-symbol" aria-hidden="true"></span><span class="visually-hidden">搜索上传店铺</span><input id="single-target-search" type="search" placeholder="搜索店铺名称或 ID" autocomplete="off"></label>
                <label class="batch-dialog-select-all"><input id="single-target-select-all" type="checkbox"><span></span>全选当前店铺</label>
                <div class="batch-target-options" id="single-target-options">${targetStores.map(store => `<label class="batch-target-option" data-store-search="${escapeHtml(`${store.storeName || store.storeId} ${store.storeId}`.toLocaleLowerCase())}"><input type="checkbox" value="${escapeHtml(store.storeId)}"><span class="batch-target-check"></span><strong>${escapeHtml(store.storeName || store.storeId)}</strong><small>${escapeHtml(store.storeId)} · 在线，可接收上传任务</small></label>`).join("") || `<p class="muted">暂无在线目标店铺。</p>`}</div>
                <div class="task-load-more" id="single-target-load-more-wrap" ${targetStoresHaveMore ? "" : "hidden"}><button type="button" class="toolbar-button" id="single-target-load-more">加载更多目标店铺</button><span id="single-target-load-more-status">已显示 ${targetStores.length} / ${targetStoreTotal} 家</span></div>
                </fieldset>
                <p class="upload-task-notice" id="upload-product-compliance">点击“上架商品”即表示确认本次商品符合适用要求，并同意平台《商品合规声明》V2.0；创建不等于审核上架。</p>
                <p class="upload-task-notice">任务发出不代表执行成功。离开本页将停止剩余发送，已发内容不撤回。</p>
                </div>
                <div class="batch-dialog-footer"><span id="single-target-count" aria-live="polite">已选择 0 家店铺</span><div class="single-target-dialog-actions"><button type="submit" value="product_create" class="toolbar-button primary" disabled>上架商品</button><button type="submit" value="qualification_upload" class="toolbar-button" disabled>补全资质</button></div></div>
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
    // 解除标红沿用原入口范围；删除独立按来源权限展示，自己的商品在共享库也能管理。
    if (!canManageCatalog()) document.getElementById('unblock-selected').hidden = true;
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

/** 选择数量是当前库存快照的预览，实际交接仍由服务端重读标红状态，避免并发错误通知漏过滤。 */
function prepareBulkSelection(products, sourceBatchForProduct) {
    const groups = new Map(), blocked = [], missing = [];
    for (const product of products) {
        if (product.statusStale) { missing.push(String(product.spuId)); continue; }
        if (product.sendBlocked || product.blocked) { blocked.push(String(product.spuId)); continue; }
        const sourceBatch = sourceBatchForProduct(product);
        if (!sourceBatch) { missing.push(String(product.spuId)); continue; }
        const group = groups.get(sourceBatch.id) || { sourceBatch, spuIds: [] };
        group.spuIds.push(String(product.spuId));
        groups.set(sourceBatch.id, group);
    }
    return { groups: [...groups.values()], blocked, missing, eligible: [...groups.values()].reduce((n, g) => n + g.spuIds.length, 0) };
}

/** 店铺间最多两条当前传输，同店分段有序；离页停止未发出的分段，不撤回已交付商品、不自动重试。 */
async function submitBulkManifest(groups, targets, { canSend = () => true, productForId = null, actionType = 'product_create' } = {}) {
    // 任务类型贯穿所有店铺及分段，补全资质不得回落为商品创建。
    if (!['product_create', 'qualification_upload'].includes(actionType)) throw Error('请选择有效的上传任务类型。');
    let sent = 0;
    const errors = [];
    const skippedBlocked = [];
    const skippedStale = [];
    const uniqueTargets = [...new Map(targets.map(target => [String(target.storeId), target])).values()];
    let nextTarget = 0, stopped = false;
    const sendTarget = async (target) => {
        // 同一次人工发送的分段共享标识，暂停插件不能把后续分段误认为另一轮替换。
        const manualSendId = crypto.randomUUID();
        for (const group of groups) {
            for (let offset = 0; offset < group.spuIds.length; offset += 10) {
                if (!canSend()) { stopped = true; return; }
                // 分段开始前重读网页已同步的资格；只过滤未交付部分，不取消或重放已发送请求。
                const spuIds = group.spuIds.slice(offset, offset + 10).filter(spuId => {
                    if (!productForId) return true;
                    const product = productForId(spuId, group);
                    if (!product || product.statusStale) { skippedStale.push(spuId); return false; }
                    if (product?.blocked || product?.sendBlocked) {
                        skippedBlocked.push({ spuId, productCodes: productExtCodes(product) });
                        return false;
                    }
                    return true;
                });
                if (!spuIds.length) continue;
                try {
                    const result = await api('/temu/api/relay/send', { method: 'POST', headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ ...group, spuIds, manualSendId, actionType, targetStoreId: target.storeId, sameStoreConfirmed: true }) });
                    sent += Number(result.sent) || 0;
                    skippedBlocked.push(...(result.skippedBlocked || []));
                } catch (error) {
                    errors.push(`${target.storeName || target.storeId} / ${spuIds.join('、')}：${error.message}`);
                }
            }
        }
    };
    const worker = async () => {
        while (nextTarget < uniqueTargets.length) {
            if (!canSend()) { stopped = true; return; }
            await sendTarget(uniqueTargets[nextTarget++]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(2, uniqueTargets.length) }, worker));
    const result = { sent, skippedBlocked, skippedStale, stopped };
    if (errors.length) throw Error(`${transferResultText(result)}以下发送失败，未自动重发：${errors.join('；')}`);
    return result;
}

/** 跳过是商品资格变化，不冒充上传失败；明确展示实际未交付的货号与份数。 */
function blockedTransferText(result) {
    const codes = [...new Set((result.skippedBlocked || []).flatMap(item => item.productCodes?.length ? item.productCodes : [`SPU ${item.spuId}`]))];
    return codes.length ? `已跳过禁传 ${result.skippedBlocked.length} 份：${codes.join('、')}` : '';
}

/** 只展示发出与跳过，不把网络写出成功说成插件创建成功；离页不暗示已发内容被撤回。 */
function transferResultText(result) {
    return `实际发出 ${result.sent} 份。${blockedTransferText(result)}${result.skippedStale?.length ? `已跳过来源变化 ${result.skippedStale.length} 份：${[...new Set(result.skippedStale)].join('、')}。` : ''}${result.stopped ? '已停止剩余发送，已发内容未撤回。' : ''}`;
}

/** 能力响应必须明确支持所选任务；旧服务未声明拆分协议时禁止误按创建发送资质。 */
function assertUploadCapability(capability, actionType) {
    if (!['product_create', 'qualification_upload'].includes(actionType)
        || !Array.isArray(capability?.actionTypes) || !capability.actionTypes.includes(actionType)) {
        throw Error('后台尚未启用所选上传任务类型，请联系管理员更新发送服务及目标店插件（最低 11.0.4）。');
    }
}

/** 单商品与批量共用传输及禁传校验；资质补全只交付任务，不代表上架。 */
async function submitSingleProduct({ product, sourceBatch, targets, button, toast, actionType }) {
    const spuId = String(product?.spuId || "");
    const routeVersion = routeRequestId;
    const routeHash = location.hash;
    const canSend = () => routeVersion === routeRequestId && routeHash === location.hash && button?.isConnected !== false;
    if (product?.statusStale) throw Error('商品来源已变化，请刷新列表后重新选择。');
    if (product?.sendBlocked || product?.blocked) throw Error('该商品因资料错误已停止分发，请先核对具体原因并解除标记。');
    // 发送资格由原始来源关联及服务端传输校验决定，不由类目模板字段决定。
    if (!sourceBatch) throw new Error("该商品尚无可追溯的完整来源资料，请使用插件重新采集并上传，确认来源店铺。");
    const capability = await api("/temu/api/direct-create-capability");
    // 等待资格响应期间已离开商品页时，不在新页面补弹确认窗。
    if (!canSend()) return;
    assertUploadCapability(capability, actionType);
    if (!targets.length) throw new Error("请至少选择一个在线且身份已匹配的目标店插件。");
    if (!await confirmSourceStoreTargets([sourceBatch], targets)) {
        if (toast) toast.innerHTML = `<div class="toast">已取消发送，未创建任务。</div>`;
        return;
    }
    // 离开页面前不再发起新操作；已经发出的内容不声称撤回或收妥。
    if (!canSend()) return;
    if (button) {
        button.disabled = true;
        button.dataset.sending = '1';
        button.textContent = "发送中…";
    }
    if (toast) toast.innerHTML = `<div class="toast">正在向 ${escapeHtml(String(targets.length))} 家目标店发送${actionType === 'qualification_upload' ? '补全资质' : '上传商品'}任务，SPU ${escapeHtml(spuId)}…</div>`;
    try {
        const result = await submitBulkManifest([{ sourceStoreId: sourceBatch.sourceStoreId, sourceBatchId: sourceBatch.id, spuIds: [spuId] }], targets,
            { canSend, productForId: () => product, actionType });
        if (toast && canSend()) toast.innerHTML = `<div class="toast success">${escapeHtml(transferResultText(result))}</div>`;
    } finally {
        if (button) {
            delete button.dataset.sending;
            button.disabled = Boolean(product?.statusStale || product?.sendBlocked || product?.blocked);
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
    // 两个命令共用店铺草稿和权限边界，点击的按钮才决定发送哪条插件流程。
    const uploadCommandButtons = [...singleTargetDialog.querySelectorAll('button[value="product_create"], button[value="qualification_upload"]')];
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
    // 发送捕获的快照不随翻页或取消勾选消失，否则后续分段看不到新红标。
    const activeSendingProducts = new Set();
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
    /** 商品选择按来源商品键跨页保存快照，同 SPU 的他人来源不能覆盖已选中的记录。 */
    const setProductSelected = (product, selected) => {
        const spuId = catalogKey(product);
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
        // 在线状态只更新目标店选择；无在线店仍可打开任务弹窗，不替换商品行或分页焦点。
        for (const row of rows) {
            const product = catalogRowProduct(overview.products, row);
            const button = row.querySelector("[data-transfer-spu]");
            if (!button || !product) continue;
            const hasBatch = (overview.batches || []).some((batch) => (product.batchIds || []).includes(batch.id) && batch.sourceStoreId);
            // 在线目录更新不能覆盖商品禁传或当前发送互斥，否则旧红标按钮会被心跳重新启用。
            const blocked = product.statusStale || product.sendBlocked || product.blocked;
            button.disabled = Boolean(blocked || !hasBatch || singleUploadBusy || batchUploadBusy || button.dataset.sending);
            button.title = product.statusStale ? "来源已变化，请刷新列表后重新选择" : blocked ? "商品已标红，解除标记后才能发送" : !hasBatch ? "缺少可追溯的来源批次" : "选择任务类型和目标店铺";
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
        scheduleLiveApply();
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
    /** 共用弹窗只形成店铺草稿；两种命令都必须实时重算禁传资格。 */
    const syncSingleDialogCount = () => {
        const visibleOptions = singleTargetOptions.filter(option => !option.hidden);
        const checkedVisible = visibleOptions.filter(option => option.querySelector("input")?.checked).length;
        if (singleTargetSelectAll) {
            singleTargetSelectAll.checked = Boolean(visibleOptions.length) && checkedVisible === visibleOptions.length;
            singleTargetSelectAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleOptions.length;
        }
        const targetCount = singleTargetOptions.filter(option => option.querySelector("input")?.checked).length;
        if (singleTargetCount) singleTargetCount.textContent = `已选择 ${targetCount} 家店铺`;
        const products = singleTargetDialog.dataset.mode === 'batch' ? [...catalogSelectedProducts.values()]
            : overview.products.filter(product => catalogKey(product) === singleTargetDialog.dataset.productKey);
        const selection = prepareBulkSelection(products, sourceBatchForProduct);
        if (singleTargetSpu) singleTargetSpu.textContent = singleTargetDialog.dataset.mode === 'batch'
            ? `已选择 ${products.length} 个，可发送 ${selection.eligible} 个，标红跳过 ${selection.blocked.length} 个，缺少来源 ${selection.missing.length} 个。`
            : singleTargetDialog.dataset.spu || '当前商品';
        uploadCommandButtons.forEach(button => {
            button.disabled = !targetCount || !selection.eligible || singleUploadBusy || batchUploadBusy;
        });
    };
    const resetSingleDialog = () => {
        if (singleTargetSearch) singleTargetSearch.value = "";
        singleTargetOptions.forEach(option => {
            option.hidden = false;
            const checkbox = option.querySelector("input");
            if (checkbox) checkbox.checked = selectedTargetOptions().some(option => String(option.value) === String(checkbox.value));
        });
        syncSingleDialogCount();
    };
    /** 单商品和批量仅切换上下文，不嵌套确认窗；预选店铺带入后仍可调整。 */
    const openUploadDialog = (mode, product = null) => {
        singleTargetDialog.dataset.mode = mode;
        singleTargetDialog.dataset.spu = String(product?.spuId || '');
        singleTargetDialog.dataset.productKey = product ? catalogKey(product) : '';
        singleTargetDialog.returnValue = '';
        resetSingleDialog();
        singleTargetDialog.showModal();
        singleTargetSearch?.focus();
    };
    // 提交边界再次重算，在线店离线或商品刚标红时，即使触发提交事件也不能发出任务。
    singleTargetDialog.querySelector('form').addEventListener('submit', event => {
        if (event.submitter?.value === 'cancel') return;
        syncSingleDialogCount();
        if (!uploadCommandButtons.includes(event.submitter) || event.submitter.disabled) event.preventDefault();
    });
    // 搜索框的回车只用于查找，不能隐式提交表单触发上架或补全资质。
    singleTargetSearch?.addEventListener('keydown', event => {
        if (event.key === 'Enter') event.preventDefault();
    });
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
        if (!singleTargetDialog.isConnected || !isCatalogRoute(location.hash)) return;
        const mode = singleTargetDialog.dataset.mode;
        const actionType = singleTargetDialog.returnValue;
        if (!uploadCommandButtons.some(button => button.value === actionType)) {
            resetSingleDialog();
            return;
        }
        if (singleUploadBusy || batchUploadBusy) {
            resetSingleDialog();
            return;
        }
        const targetIds = singleTargetOptions.filter(option => option.querySelector("input")?.checked).map(option => String(option.querySelector("input")?.value || "")).filter(Boolean);
        const targets = (targetStores || []).filter(item => targetIds.includes(String(item.storeId)));
        if (!targets.length) { resetSingleDialog(); return; }
        // 批量只在点击底部命令后进入分段发送；开窗、选择店铺和关闭都不创建任务。
        if (mode === 'batch') {
            [...batchTargetStores.options].forEach(option => { option.selected = targetIds.includes(String(option.value)); });
            updateTargetSummary();
            await sendBatchProducts(actionType, targets);
            if (singleTargetDialog.isConnected) resetSingleDialog();
            return;
        }
        singleUploadBusy = true;
        const product = overview.products.find(item => catalogKey(item) === singleTargetDialog.dataset.productKey);
        const sourceBatchId = product?.publicationData?.sourceBatchId;
        const sourceBatch = (overview.batches || []).find(batch => batch.id === sourceBatchId && (product?.batchIds || []).includes(batch.id) && batch.sourceStoreId);
        const row = rows.find(item => item.dataset.productKey === singleTargetDialog.dataset.productKey);
        const button = row?.querySelector("[data-transfer-spu]");
        const toast = document.getElementById("catalog-toast");
        if (product) activeSendingProducts.add(product);
        syncSelection();
        try {
            await submitSingleProduct({ product, sourceBatch, targets, button, toast, actionType });
        } catch (error) {
            if (toast) toast.innerHTML = `<div class="toast error">上传失败：${escapeHtml(error.message)}</div>`;
        } finally {
            activeSendingProducts.clear();
            singleUploadBusy = false;
            if (singleTargetDialog.isConnected) {
                updateTargetAgentPagination();
                syncSelection();
                singleTargetDialog.dataset.spu = "";
                resetSingleDialog();
            }
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
                .filter(canReceiveSplitUpload)
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
            if (box) box.checked = catalogSelectedProducts.has(row.dataset.productKey);
        });
        const visibleBoxes = visibleRows().map((row) => row.querySelector(".product-checkbox")).filter(Boolean);
        const checkedVisible = visibleBoxes.filter((box) => box.checked).length;
        const selected = catalogSelectedProducts.size;
        selectAll.disabled = visibleBoxes.length === 0;
        selectAll.checked = Boolean(visibleBoxes.length) && checkedVisible === visibleBoxes.length;
        selectAll.indeterminate = checkedVisible > 0 && checkedVisible < visibleBoxes.length;
        const deletable = [...catalogSelectedProducts.values()].filter(canDeleteProduct).length;
        deleteSelected.disabled = deletable === 0;
        deleteSelected.title = selected > deletable ? `仅删除有权限的 ${deletable} 个商品，其他所选商品不会删除` : '删除所选商品';
        const unblockButton = document.getElementById("unblock-selected");
        if (unblockButton) unblockButton.disabled = ![...catalogSelectedProducts.values()].some((product) => product?.blocked || product?.sendBlocked);
        if (clearProductSelection) clearProductSelection.disabled = selected === 0;
        const selection = prepareBulkSelection([...catalogSelectedProducts.values()], sourceBatchForProduct);
        selectionCount.textContent = `已选择 ${selected} 个 · 可发送 ${selection.eligible} 个 · 标红跳过 ${selection.blocked.length} 个${selection.missing.length ? ` · 缺来源 ${selection.missing.length} 个` : ''}`;
        if (batchDirectCreate) batchDirectCreate.disabled = batchUploadBusy || singleUploadBusy || selection.eligible === 0;
        updateTargetAgentPagination();
        updateTargetSummary();
        syncSingleDialogCount();
        scheduleLiveApply();
    };
    let filterRequestId = 0;
    let productPageBusy = false;
    let statusPatchRevision = 0;
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
        const statusRevision = statusPatchRevision;
        const requestedPage = Math.max(1, Number(page) || 1);
        if (!background) setProductPageBusy(true);
        try {
            const pagePayload = await api(catalogPageUrl(requestedPage), { cacheMs: 2500, force: background });
            if (requestId !== filterRequestId || loadVersion !== catalogPageLoadVersion || !productList?.isConnected || !canApply()) return false;
            // 旧列表读取不能盖掉并发已生效的局部红标；放弃本次结构重绘，保留待处理通知再读。
            if (background && statusRevision !== statusPatchRevision) return false;
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
                const spuId = catalogKey(product);
                for (const sending of activeSendingProducts) {
                    if (catalogKey(sending) === spuId && sending.sourceIdentity && sending.sourceIdentity !== product.sourceIdentity) sending.statusStale = true;
                }
                if (spuId && catalogSelectedProducts.has(spuId)) {
                    const previous = catalogSelectedProducts.get(spuId);
                    // 删除重导不能把旧勾选静默移到新商品；旧发送引用同时失效。
                    if (previous.sourceIdentity && previous.sourceIdentity !== product.sourceIdentity) {
                        previous.statusStale = true;
                        catalogSelectedProducts.delete(spuId);
                    } else catalogSelectedProducts.set(spuId, product);
                }
            }
            if (productList && (!background || rowsChanged)) {
                productList.innerHTML = renderProductRows(nextProducts, true, targetStores, overview.batches) || renderCatalogEmpty(overview);
                rows = [...productList.querySelectorAll("[data-product-row]")];
            }
            // 绑定函数自行记录已绑定状态，调用方提前标记会使新页所有行跳过事件注册。
            rows.forEach(bindProductRow);
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
    /** 列表增删、排序仍避让操作；错误状态与店铺在线状态不依赖结构重绘。 */
    refreshCatalogView = async (live, previous, canApply) => {
        if (!productList?.isConnected) return false;
        const inventoryChanged = live.inventory !== previous.inventory || live.claims !== previous.claims;
        if (inventoryChanged && !await loadProductPage({ background: true, canApply })) return false;
        return canApply();
    };
    let appliedStatusVersion = '';
    /** 状态局部更新只动资格与错误单元格，保留行、图片、输入、弹窗和跨页勾选。 */
    refreshCatalogStatus = async (live, canApply, catchup) => {
        const references = () => [...new Map([...activeSendingProducts, ...catalogSelectedProducts.values(), ...overview.products]
            .filter(product => product.sourceIdentity && product.productKey && !product.statusStale)
            .map(product => [catalogKey(product), { spuId: String(product.spuId), sourceIdentity: product.sourceIdentity, productKey: product.productKey }])).values()]
            .sort((a, b) => a.spuId.localeCompare(b.spuId));
        const refs = references();
        const version = JSON.stringify([live.inventory, live.claims, catchup, refs]);
        if (version === appliedStatusVersion) return true;
        const replies = [];
        // 接口保留单批 SPU 唯一约束；同 SPU 的不同来源分到不同批，不能静默丢掉一个引用。
        const batches = [];
        for (const ref of refs) {
            let batch = batches.find(items => items.length < 100 && !items.some(item => item.spuId === ref.spuId));
            if (!batch) { batch = []; batches.push(batch); }
            batch.push(ref);
        }
        for (const batch of batches) {
            if (!canApply() || !productList.isConnected) return false;
            const response = await api('/temu/api/products/status-read?' + libraryParams(), { method: 'POST', readOnly: true,
                headers: { 'content-type': 'application/json' }, body: JSON.stringify({ products: batch }) });
            // 不完整响应不能吞掉待同步版本，也不能把缺失项误当成已删除。
            if (!Array.isArray(response.products) || !Array.isArray(response.staleIds)) throw Error('商品状态响应无效');
            const requested = new Map(batch.map(ref => [ref.spuId, ref.sourceIdentity]));
            const seen = new Set();
            for (const status of response.products) {
                if (!requested.has(status.spuId) || requested.get(status.spuId) !== status.sourceIdentity || seen.has(status.spuId)
                    || typeof status.blocked !== 'boolean' || typeof status.sendBlocked !== 'boolean') throw Error('商品状态响应无效');
                seen.add(status.spuId);
            }
            for (const id of response.staleIds) {
                if (!requested.has(id) || seen.has(id)) throw Error('商品状态响应无效');
                seen.add(id);
            }
            if (seen.size !== batch.length) throw Error('商品状态响应不完整');
            replies.push({ products: response.products.map(status => ({ ...status, productKey: batch.find(ref => ref.spuId === status.spuId).productKey })),
                staleKeys: response.staleIds.map(id => batch.find(ref => ref.spuId === id).productKey) });
        }
        if (!canApply() || !productList.isConnected || JSON.stringify(refs) !== JSON.stringify(references())) return false;
        const current = new Map(replies.flatMap(reply => reply.products).map(status => [status.productKey, status]));
        const stale = new Set(replies.flatMap(reply => reply.staleKeys));
        // 原位更新当前页、跨页选择和发送快照，确认窗及未发分段也能看到新的禁传状态。
        for (const product of new Set([...overview.products, ...catalogSelectedProducts.values(), ...activeSendingProducts])) {
            const id = catalogKey(product), status = current.get(id);
            if (status && status.sourceIdentity === product.sourceIdentity) {
                for (const key of ['blocked', 'sendBlocked', 'blockedReason', 'blockedAt', 'errorNotice']) product[key] = status[key];
            } else if (stale.has(id)) {
                product.statusStale = true;
                catalogSelectedProducts.delete(id);
            }
        }
        for (const row of rows) {
            const product = catalogRowProduct(overview.products, row);
            if (!product) continue;
            const blocked = !product.statusStale && Boolean(product.blocked || product.sendBlocked);
            row.classList.toggle('product-row-blocked', blocked);
            row.dataset.blocked = blocked ? '1' : '0';
            const cell = row.querySelector('[data-product-status]');
            const markup = product.statusStale ? '<span class="ticket-status">来源已变化，请刷新列表</span>'
                : TemuProductErrorUI.statusMarkup(product, escapeHtml);
            // 已标红行只改原因文字，保留正在聚焦的详情按钮；状态切换也不触碰商品图片。
            if (cell && cell.dataset.markup !== markup) {
                const template = document.createElement('template'); template.innerHTML = markup;
                if (cell.querySelector('.product-error-status') && template.content.querySelector('.product-error-status')) {
                    for (const selector of ['.ticket-status', '.product-error-summary']) {
                        cell.querySelector(selector).textContent = template.content.querySelector(selector).textContent;
                    }
                } else {
                    const hadFocus = cell.contains(document.activeElement);
                    cell.replaceChildren(template.content);
                    if (hadFocus) row.querySelector('.product-checkbox')?.focus({ preventScroll: true });
                }
                cell.dataset.markup = markup;
            }
        }
        appliedStatusVersion = JSON.stringify([live.inventory, live.claims, catchup, references()]);
        statusPatchRevision += 1;
        syncSelection();
        return true;
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
            const nextStores = agents.filter(canReceiveSplitUpload)
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
            const product = catalogRowProduct(overview.products, row);
            if (product) setProductSelected(product, box.checked);
        });
        syncSelection();
    });
    clearProductSelection?.addEventListener("click", () => {
        clearCatalogProductSelection();
        syncSelection();
    });
    deleteSelected.addEventListener("click", () => deleteInventoryProducts([...catalogSelectedProducts.values()].map(product => product.spuId), [...catalogSelectedProducts.values()]));
    document.getElementById("unblock-selected")?.addEventListener("click", async (event) => {
        const button = event.currentTarget;
        // 只解除选中的标红商品：未标红的商品无需处理，避免把正常商品也写一遍。
        const targets = [...new Set([...catalogSelectedProducts.values()]
            .filter((product) => product?.blocked || product?.sendBlocked)
            .map((product) => String(product.spuId || ""))
            .filter(Boolean))];
        if (!targets.length) return;
        if (!window.confirm(`确认解除 ${targets.length} 个商品的标红？解除后这些商品可以再次上传。`)) return;
        button.disabled = true;
        button.textContent = "解除中…";
        try {
            // 新禁传按当前实际实例解除；旧接口只能清历史红标，不能顺便解除新标记。
            const notices = [...catalogSelectedProducts.values()].filter(product => product.sendBlocked && product.errorNotice);
            const groups = new Map();
            for (const product of notices) {
                const notice = product.errorNotice;
                const group = groups.get(notice.sourceStoreId) || { sourceStoreId: notice.sourceStoreId, spuIds: [], sourceInstanceIds: [], noticeEpochs: [] };
                group.spuIds.push(notice.spuId); group.sourceInstanceIds.push(notice.sourceInstanceId);
                group.noticeEpochs.push(notice.noticeEpoch);
                groups.set(notice.sourceStoreId, group);
            }
            for (const group of groups.values()) await api('/temu/api/products/error-unblock', { method: 'POST', body: JSON.stringify(group) });
            const legacy = [...catalogSelectedProducts.values()].filter(product => product.blocked).map(product => String(product.spuId));
            if (legacy.length) await api("/temu/api/products/unblock", { method: "POST", body: JSON.stringify({ spuIds: legacy }) });
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
        // 详情加载沿用本行来源身份，不能只靠货号或可猜 SPU 读取别店的错误。
        const displayedProduct = catalogRowProduct(overview.products, row);
        const sendButton = row.querySelector('[data-transfer-spu]');
        if (sendButton && displayedProduct?.sendBlocked) sendButton.disabled = true;
        row.addEventListener('click', event => {
            const trigger = event.target.closest('[data-product-error]');
            if (!trigger) return;
            const product = catalogRowProduct(overview.products, row);
            if (!product || product.statusStale) return;
            void TemuProductErrorUI.open(product, trigger, (notice, signal) => api(
                '/temu/api/products/error-details?' + new URLSearchParams({ library: catalogLibrary, sourceStoreId: notice.sourceStoreId,
                    spuId: notice.spuId, sourceInstanceId: notice.sourceInstanceId }), { signal }));
        });
        row.querySelector(".product-checkbox")?.addEventListener("change", (event) => {
            const box = event.currentTarget;
            const product = catalogRowProduct(overview.products, row);
            if (product) setProductSelected(product, box.checked);
            syncSelection();
        });
        row.querySelector("[data-delete-spu]")?.addEventListener("click", (event) => {
            event.stopPropagation();
            const product = catalogRowProduct(overview.products, row);
            if (product) deleteInventoryProducts([product.spuId], [product]);
        });
        row.querySelector("[data-transfer-spu]")?.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            const button = event.currentTarget;
            const product = catalogRowProduct(overview.products, row);
            const toast = document.getElementById("catalog-toast");
            // 事件入口也核对当前商品，不能只靠按钮外观阻止迟到点击。
            if (product?.statusStale || product?.sendBlocked || product?.blocked) {
                if (toast) toast.innerHTML = `<div class="toast error">该商品已标红，解除标记后才能发送。</div>`;
                return;
            }
            if (singleUploadBusy || batchUploadBusy) {
                if (toast) toast.innerHTML = `<div class="toast">已有单商品上传正在处理中，请等待当前任务完成。</div>`;
                return;
            }
            openUploadDialog('single', product);
        });
    };
    rows.forEach(bindProductRow);
    batchDirectCreate?.addEventListener("click", () => {
        if (batchUploadBusy || singleUploadBusy || !prepareBulkSelection([...catalogSelectedProducts.values()], sourceBatchForProduct).eligible) return;
        openUploadDialog('batch');
    });
    /** 批量提交沿用来源分组、实时资格、两店并发及离页中断，类型在确认时固定。 */
    const sendBatchProducts = async (actionType, targets) => {
        const toast = document.getElementById("catalog-toast");
        if (batchUploadBusy || singleUploadBusy) {
            if (toast) toast.innerHTML = `<div class="toast">批量上传正在处理中，请等待当前任务完成。</div>`;
            return;
        }
        const selectedIds = [...catalogSelectedProducts.keys()];
        if (!selectedIds.length || !targets.length) {
            if (toast) toast.innerHTML = `<div class="toast error">请先选择商品和在线目标店铺。</div>`;
            return;
        }
        const products = selectedIds.map(spuId => catalogSelectedProducts.get(spuId)).filter(Boolean);
        const { groups, blocked, missing: skipped, eligible: total } = prepareBulkSelection(products, sourceBatchForProduct);
        if (!groups.length) {
            if (toast) toast.innerHTML = `<div class="toast error">没有可发送商品；标红跳过 ${blocked.length} 个，缺少来源 ${skipped.length} 个。</div>`;
            return;
        }
        batchUploadBusy = true;
        products.forEach(product => activeSendingProducts.add(product));
        syncSelection();
        const routeVersion = routeRequestId;
        const routeHash = location.hash;
        const canSend = () => routeVersion === routeRequestId && routeHash === location.hash && batchDirectCreate.isConnected;
        batchDirectCreate.disabled = true;
        // 共用弹窗已完成类型和店铺确认，同来源店确认仍在首个写请求之前执行。
        try {
        if (!canSend()) return;
        if (!await confirmSourceStoreTargets(groups.map(group => group.sourceBatch), targets)) {
            if (toast) toast.innerHTML = `<div class="toast">已取消发送到来源店铺，本次未创建任务。</div>`;
            return;
        }
        if (!canSend()) return;
        batchDirectCreate.textContent = "检查中…";
        if (toast) toast.innerHTML = `<div class="toast">正在检查发送服务…</div>`;
        const capability = await api("/temu/api/direct-create-capability");
        assertUploadCapability(capability, actionType);
        if (!canSend()) return;
        batchDirectCreate.textContent = "发送中…";
        if (toast) toast.innerHTML = `<div class="toast">正在向 ${escapeHtml(String(targets.length))} 家目标店发送 ${escapeHtml(String(total))} 个${actionType === 'qualification_upload' ? '补全资质' : '上传商品'}任务…</div>`;
            const sendingProducts = new Map(products.map(product => [JSON.stringify([product.publicationData?.sourceBatchId, String(product.spuId)]), product]));
            const result = await submitBulkManifest(groups.map(group => ({ sourceStoreId: group.sourceBatch.sourceStoreId, sourceBatchId: group.sourceBatch.id, spuIds: group.spuIds })), targets,
                { canSend, actionType, productForId: (spuId, group) => sendingProducts.get(JSON.stringify([group.sourceBatchId, String(spuId)])) });
            // 旧页面结果不能清除用户重新进入商品库后勾选的新商品。
            if (!canSend()) return;
            if (toast) toast.innerHTML = `<div class="toast success">${escapeHtml(transferResultText(result))}发送前已跳过 ${blocked.length} 个标红商品。${skipped.length ? `跳过 ${skipped.length} 个无来源批次商品。` : ''}</div>`;
            clearCatalogProductSelection();
            syncSelection();
        } catch (error) {
            if (toast) toast.innerHTML = `<div class="toast error">批量发送失败：${escapeHtml(error.message)}</div>`;
        } finally {
            activeSendingProducts.clear();
            batchUploadBusy = false;
            if (canSend()) {
                batchDirectCreate.textContent = "一键上架";
                syncSelection();
            }
        }
    };
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
async function deleteInventoryProducts(spuIds, products = null) {
    // 混选共享商品只删除有权限的来源行；不回退到省略来源的整仓删除请求。
    if (!Array.isArray(products)) return;
    const selectedCount = products.length;
    products = products.filter(canDeleteProduct);
    spuIds = products.map(product => product.spuId);
    const ids = [...new Set((spuIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!ids.length) return;
    const description = `${products.length === 1 ? `SPU ${ids[0]}` : `${products.length} 个所选商品`}${selectedCount > products.length ? `（另有 ${selectedCount - products.length} 个商品无删除权限，不会删除）` : ''}`;
    if (inventoryDeletionBusy || !await confirmInventoryRemoval(description)) return;
    inventoryDeletionBusy = true;
    const toast = document.getElementById("catalog-toast");
    if (toast) toast.innerHTML = `<div class="toast">正在删除 ${description}…</div>`;
    try {
        // 每组精确限定来源店，共享库同 SPU 的其他来源不能随着当前行一起删除。
        const groups = new Map();
        for (const product of products || []) for (const storeId of product.sourceStoreIds || []) {
            if (!groups.has(storeId)) groups.set(storeId, []);
            groups.get(storeId).push(product.spuId);
        }
        for (const [storeId, selected] of groups.size ? groups : [[null, ids]]) await api('/temu/api/products', {
            method: 'DELETE', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ spuIds: selected, ...(storeId ? { storeIds: [storeId] } : {}) })
        });
        // 删除可能连同同货号的其他 SPU 一并清理，跨页选择已不再完整，重绘前统一清空。
        clearCatalogProductSelection();
        if (location.hash.startsWith("#/product/")) location.hash = catalogLibrary === 'personal' ? '#/products/mine' : '#/products';
        else await route();
    } catch (error) {
        if (toast) toast.innerHTML = `<div class="toast error">删除失败：${escapeHtml(error.message)}</div>`;
    } finally {
        inventoryDeletionBusy = false;
    }
}


function renderProduct(payload) {
    setNav("products");
    const product = payload.product;
    // 详情页仅按资料顺序展示已有字段；完整度不再决定正文模块或阻挡查看。
    app.innerHTML = `
        <div class="top product-detail-top"><div class="top-copy"><h1>商品详情</h1><p class="detail-meta">SPU ${escapeHtml(product.spuId)}${product.category ? ` · ${escapeHtml(product.category)}` : ""}${identifierText(product.skcIds) ? ` · SKC ${escapeHtml(identifierText(product.skcIds))}` : ""}</p></div><div class="detail-actions"><a class="back-link" href="#/products">返回商品库</a><button type="button" class="toolbar-button danger" id="delete-current-product">删除商品</button></div></div>
        ${window.ProductDetailView.render(product)}
    `;
    document.getElementById("delete-current-product")?.addEventListener("click", () => deleteInventoryProducts([product.spuId], [product]));
    const back = app.querySelector('.back-link');
    if (back) back.href = catalogLibrary === 'personal' ? '#/products/mine' : '#/products';
    if (!canDeleteProduct(product)) document.getElementById('delete-current-product').hidden = true;
}

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
        if (!window.confirm(`确认认领店铺「${storeName}」？\n\n认领后该店铺归你的账号所有，其他账号将无法再认领；该店铺已有的商品也会归到你的账号。`)) return;
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
        if (!window.confirm(`确认解除对「${storeName}」的认领？\n\n解除后你将看不到该店铺的商品（数据不会删除），直到重新认领。`)) return;
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
        if (!window.confirm(`确认批量认领 ${selected.length} 家店铺？\n\n${summary}\n\n认领后这些店铺归你的账号所有，其他账号将无法再认领；已有商品也会归到你的账号。`)) return;

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
        if (roleEl) roleEl.textContent = currentAccount.localMode ? '本机模式' : `${currentAccount.user.accountType === 'test' ? '测试账户' : '正式账户'} · ${currentAccount.isAdmin ? '管理员' : '普通用户'}`;
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
    if (isCatalogRoute(hash) || hash === "#/products/all" || hash.startsWith("#/product/")) return "products";
    if (hash === "#/stores") return "stores";
    if (hash === "#/import") return "import";
    return "home";
}

function routeLabel(hash) {
    return {
        "#/": "商品库",
        "#/products": "商品库",
        "#/stores": "店铺认领",
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

/** 登录后空闲时预载小型插件目录；完整商品仍由目标页面按需获取。 */
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
    // 导航或库存版本变化时关闭旧详情，避免删除/解除后仍展示已经失效的禁传状态。
    TemuProductErrorUI.close();
    // 已删除的查验页和未接入数据的预览书签回商品库，不扩展跨账户库存权限。
    if (["", "#", "#/", "#/jobs", "#/logs", "#/transfers", "#/import", "#/products/all"].includes(location.hash)
        || /^#\/batch\/[^/]+\/?$/.test(location.hash)) history.replaceState(null, "", "#/products");
    const background = Boolean(options.background);
    // 只有人工导航接管页面；后台更新不得废弃翻页请求或清除其忙碌状态。
    if (!background) {
        catalogPageLoadVersion += 1;
        catalogPageLoading = false;
        refreshCatalogView = null;
        refreshCatalogTargets = null;
        refreshCatalogStatus = null;
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
        if (isCatalogRoute(hash)) {
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
        const productMatch = hash.match(/^#\/product\/([^/?]+)/);
        if (productMatch) {
            const params = new URLSearchParams(hash.split('?')[1] || '');
            catalogLibrary = params.get('library') === 'personal' ? 'personal' : 'shared';
            const product = await api(`/temu/api/products/${productMatch[1]}?${params}`, { signal });
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
    const nextLibrary = location.hash === '#/products/mine' ? 'personal' : 'shared';
    if (!isCatalogRoute(location.hash) || nextLibrary !== catalogLibrary) clearCatalogProductSelection();
    if (isCatalogRoute(location.hash) && nextLibrary !== catalogLibrary) {
        catalogLibrary = nextLibrary;
        catalogProductPage = 1;
        Object.assign(catalogFilters, { q: '', draft: '', sourceStoreId: '', blocked: '' });
        // 切换范围时销毁旧订阅和摘要，旧响应不得刷新新库。
        closeLiveEvents(); latestLive = null; lastLive = null; lastLiveHash = '';
    }
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
const AUTO_REFRESH_HASHES = new Set(["#/products", "#/products/mine", "#/stores"]);
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
    if (element.classList?.contains("product-checkbox")) return `product:${element.closest('[data-product-row]')?.dataset.productKey}`;
    if (element.id) return `#${element.id}`;
    if (element.name) return `@${element.name}:${element.value}`;
    return "";
}

function findControl(key) {
    if (!key) return null;
    if (key.startsWith("product:")) return app.querySelector(`[data-product-row][data-product-key="${CSS.escape(key.slice(8))}"] .product-checkbox`);
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
    ["toast", "catalog-toast"].forEach((id) => {
        const element = document.getElementById(id);
        if (element && element.innerHTML) panels[id] = element.innerHTML;
    });
    // 店铺页的分类标签也要记住，后台数据变化不能把用户打回第一个分类。
    const storeView = app.querySelector("[data-store-view-button].active")?.getAttribute("data-store-view-button") || "";
    const currentPagination = {
        products: catalogProductPage,
        productTargetAgents: app.querySelectorAll("#batch-target-options .batch-target-option").length
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
    // 商品与店铺分页已从独立状态恢复，不模拟筛选 change，否则会回到第一页。
    document.getElementById("batch-target-stores")?.dispatchEvent(new Event("change"));
    checks.forEach(([element, checked]) => {
        if (element.disabled) return;
        element.checked = checked;
        element.dispatchEvent(new Event("change"));
    });
    Object.entries(state.panels).forEach(([id, html]) => {
        const element = document.getElementById(id);
        if (element) element.innerHTML = html;
    });
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
    const fields = isCatalogRoute(hash) ? ["inventory", "claims", "agents"]
        : hash === "#/stores" ? ["claims", "directory"]
        : ["inventory", "claims", "agents", "directory"];
    return JSON.stringify(fields.map(field => live[field]));
}

/** 商品结构及整页重绘避让用户操作；错误资格和店铺目录的局部同步不受勾选和弹窗限制。 */
function autoRefreshBlocked() {
    if (routeController) return true;
    if (document.visibilityState !== "visible") return true;
    if (!AUTO_REFRESH_HASHES.has(location.hash || "#/")) return true;
    if (document.querySelector("dialog[open]")) return true;
    // 已勾选商品或目标店时暂停整页刷新，避免大规模分页下的跨页选择被自动重绘打断。
    if (catalogSelectedProducts.size > 0) return true;
    if (app.querySelector('#batch-target-stores option:checked')) return true;
    return singleUploadBusy || batchUploadBusy || inventoryDeletionBusy || storeClaimBusy || storePageBusy || catalogPageLoading;
}

/** 合并通知与本地重绘等待；正常同版本不补读网络，读取失败才保留版本重试。 */
function scheduleLiveApply(delay = 0) {
    if (liveApplyTimer !== null) return;
    liveApplyTimer = window.setTimeout(() => { liveApplyTimer = null; void applyLiveChanges(); }, delay);
}

let catalogStatusBusy = false;
let liveStatusCatchup = 0;
/** 商品状态使用独立读通道，目录读取慢或结构刷新被操作挡住时仍能标红；失败只补读，不发送商品。 */
async function applyCatalogStatus() {
    if (catalogStatusBusy || !latestLive || liveAuthExpired || !refreshCatalogStatus || routeController
        || !isCatalogRoute(location.hash) || document.visibilityState !== 'visible' || catalogPageLoading) return;
    catalogStatusBusy = true;
    const live = latestLive, navigation = routeRequestId, page = catalogPageLoadVersion, catchup = liveStatusCatchup, hash = location.hash;
    const canApply = () => location.hash === hash && navigation === routeRequestId && page === catalogPageLoadVersion
        && !routeController && document.visibilityState === 'visible' && !catalogPageLoading
        && live.inventory === latestLive?.inventory && live.claims === latestLive?.claims && catchup === liveStatusCatchup;
    let applied = false;
    try { applied = await refreshCatalogStatus(live, canApply, catchup) === true; }
    catch { /* 只读同步失败保留原状态与未消费版本，下次通知或补读继续核对。 */ }
    finally {
        catalogStatusBusy = false;
        if (!applied || !canApply()) scheduleLiveApply(3000);
    }
}

async function applyLiveChanges() {
    void applyCatalogStatus();
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
    const live = latestLive;
    let targetsApplied = !isCatalogRoute(hash);
    // 请求发出后仍可能发生翻页、输入或弹窗操作；旧响应只能丢弃，不能抢回页面。
    const viewUnchanged = () => hash === (location.hash || "#/") && navigationVersion === routeRequestId
        && interactionVersion === viewInteractionVersion && pageVersion === catalogPageLoadVersion;
    const canApply = () => viewUnchanged() && !autoRefreshBlocked()
        && liveKey(live, hash) === liveKey(latestLive, hash);
    try {
        // 目标店只做局部更新，不因弹窗、输入或商品勾选暂停；提交期间仍冻结，避免更换任务目标。
        const canApplyTargets = () => hash === (location.hash || "#/") && navigationVersion === routeRequestId
            && !routeController && document.visibilityState === "visible" && !singleUploadBusy && !batchUploadBusy && !inventoryDeletionBusy;
        if (isCatalogRoute(hash)) {
            targetsApplied = canApplyTargets() && await refreshCatalogTargets?.(live, canApplyTargets) === true;
            if (!targetsApplied) return;
        }
        // 店铺可能经历上线、离线、再上线；先核对独立目录版本，不能被整页旧摘要吞掉。
        if (lastLiveHash === hash && lastLive && liveKey(live, hash) === liveKey(lastLive, hash)) return;
        if (autoRefreshBlocked()) {
            const pending = document.getElementById("catalog-live-pending");
            if (pending && live.inventory !== lastLive?.inventory) pending.hidden = false;
            scheduleLiveApply(1000);
            return;
        }
        if (!canApply()) return;
        // 首次连接与切页也核对当前数据，弥补首屏请求和建立连接之间可能遗漏的变更。
        const previous = lastLiveHash === hash && lastLive ? lastLive : {};
        const applied = isCatalogRoute(hash)
            ? await refreshCatalogView?.(live, previous, canApply)
            : await route({ forceRefresh: true, background: true, canApply });
        // 提交前检查操作保护，提交后只核对视图版本；新DOM的读取占位不能把已提交更新判为失败。
        // 导航、用户交互和翻页变化仍不消费旧信号，读取失败则继续保留待处理版本。
        if (applied === true && viewUnchanged()) {
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
    if (!live || !["inventory", "claims", "agents", "directory"].every(key => typeof live[key] === "string")) return;
    latestLive = live;
    scheduleLiveApply();
}

/** 原生 EventSource 自动重连；每次重连服务端发送当前完整版本，不依赖易丢失的增量队列。 */
function connectLiveEvents() {
    if (liveAuthExpired || document.visibilityState !== "visible" || !AUTO_REFRESH_HASHES.has(location.hash || "#/")) return;
    if (eventStream || typeof EventSource === "undefined") return;
    const stream = new EventSource(`${siteRoot()}/api/events?${libraryParams()}`);
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
    const hash = location.hash;
    try { const live = await api('/temu/api/live?' + libraryParams()); if (hash === location.hash) receiveLiveSnapshot(live); } catch {} finally { fallbackBusy = false; }
    connectLiveEvents();
}

function resumeLiveEvents() {
    if (document.visibilityState !== "visible" || !AUTO_REFRESH_HASHES.has(location.hash || "#/")) closeLiveEvents();
    else { liveStatusCatchup += 1; connectLiveEvents(); scheduleLiveApply(); }
}
setInterval(fallbackLiveSnapshot, LIVE_FALLBACK_MS);
document.addEventListener("visibilitychange", resumeLiveEvents);
window.addEventListener("hashchange", resumeLiveEvents);
window.addEventListener("focus", resumeLiveEvents);
// BFCache离页也使发送许可失效；浏览器保留DOM不表示可以继续发送后续店铺或分段。
window.addEventListener("pagehide", () => { routeRequestId += 1; closeLiveEvents(); });
window.addEventListener("pageshow", resumeLiveEvents);
connectLiveEvents();
