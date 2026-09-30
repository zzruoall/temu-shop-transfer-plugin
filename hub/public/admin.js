/**
 * 管理控制台（独立站，仅管理员可进）。
 *
 * 与业务工作台分开的原因：
 *   1. 这里全是不可逆的账号/店铺操作，混在日常界面里容易误点；
 *   2. 业务工作台是 SPA（hash 路由），管理员站是独立页面，权限由服务端按路径拦截，
 *      不依赖前端隐藏入口——前端隐藏从来不是权限边界。
 *
 * 本文件不引用 app.js：管理站只做管理，不加载商品库、任务台等业务逻辑。
 */

/** 站点挂载前缀：线上是 /temu，本机直连是根路径。 */
function siteRoot() {
    const match = location.pathname.match(/^(\/[^/]+)\//);
    return match ? match[1] : "";
}

async function api(path, options) {
    const requestPath = path.startsWith("/temu/") ? `${siteRoot()}${path.slice("/temu".length)}` : path;
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

function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

const stage = document.getElementById("admin-app");

/**
 * 破坏性操作的确认弹窗：列出影响范围，并让操作者选择处理方式。
 * 返回所选 value；取消返回空串。
 */
function confirmDestructive({ title, details = [], options = [], confirmLabel = "确认删除" }) {
    return new Promise((resolve) => {
        const dialog = document.getElementById("admin-confirm");
        const optionHtml = options.map((option, index) => `
            <label class="confirm-option">
                <input type="radio" name="confirm-mode" value="${escapeHtml(option.value)}" ${index === 0 ? "checked" : ""}>
                <span class="confirm-option-body">
                    <strong>${escapeHtml(option.label)}</strong>
                    <small>${escapeHtml(option.hint || "")}</small>
                </span>
            </label>`).join("");
        dialog.hidden = false;
        dialog.innerHTML = `
            <form method="dialog">
                <h3>${escapeHtml(title)}</h3>
                ${details.length ? `<pre class="confirm-details">${escapeHtml(details.join("\n"))}</pre>` : ""}
                ${optionHtml ? `<div class="confirm-options">${optionHtml}</div>` : ""}
                <div class="confirm-actions">
                    <button type="button" class="admin-btn" value="cancel">取消</button>
                    <button type="button" class="admin-btn danger" value="ok">${escapeHtml(confirmLabel)}</button>
                </div>
            </form>`;
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            try { dialog.close(); } catch {}
            dialog.hidden = true;
            dialog.innerHTML = "";
            resolve(value);
        };
        dialog.querySelector('[value="cancel"]').addEventListener("click", () => finish(""));
        dialog.querySelector('[value="ok"]').addEventListener("click", () => {
            const checked = dialog.querySelector('input[name="confirm-mode"]:checked');
            finish(checked ? checked.value : "ok");
        });
        // Esc 关闭时按取消处理，避免 Promise 永远挂着。
        dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(""); });
        dialog.showModal();
    });
}

/** 管理站退出：走管理站自己的退出端点，退出后回到管理登录页而不是业务登录页。 */
async function logout() {
    try { await fetch(`${siteRoot()}/admin/logout`, { method: "POST", credentials: "same-origin" }); } catch {}
    location.href = `${siteRoot()}/admin`;
}

/** 顶栏身份：不是管理员时说明情况并给出返回入口，不渲染任何管理数据。 */
async function loadIdentity() {
    const me = await api("/temu/api/me");
    const nameEl = document.getElementById("admin-username");
    const roleEl = document.getElementById("admin-role");
    if (nameEl) nameEl.textContent = me.user?.username || "—";
    if (roleEl) roleEl.textContent = me.isAdmin ? "管理员" : "普通用户";
    return me;
}

/** 页面外壳：三个分类面板 + 顶栏计数。 */
function renderShell() {
    stage.innerHTML = `
        <section class="admin-panel" data-admin-panel="stores">
            <div class="admin-panel-head">
                <h2>店铺</h2>
                <label class="admin-switch"><input type="checkbox" id="registration-open">允许自行注册</label>
                <span class="admin-count" id="store-count"></span>
            </div>
            <p class="admin-note">认领由用户自行完成。这里用于员工离职或店铺换人时改派、强制解除归错人的店铺，或删除已注销的店铺记录。</p>
            <div class="admin-toolbar">
                <label class="admin-search">搜索<input id="admin-store-search" type="search" placeholder="店铺名称、标识或归属账户" autocomplete="off"></label>
                <label class="admin-filter">归属<select id="admin-store-filter"><option value="">全部</option><option value="unclaimed">未认领</option><option value="claimed">已认领</option></select></label>
            </div>
            <div class="admin-list" id="admin-store-list"></div>
        </section>
        <section class="admin-panel" data-admin-panel="users" hidden>
            <div class="admin-panel-head"><h2>账号</h2><span class="admin-count" id="user-count"></span></div>
            <p class="admin-note">删除账号时可以选择只删账号（店铺变为未认领、数据保留），或连同名下店铺与商品一起删除。</p>
            <div class="admin-toolbar">
                <label class="admin-search">搜索<input id="admin-user-search" type="search" placeholder="手机号" autocomplete="off"></label>
            </div>
            <div class="admin-list" id="admin-user-list"></div>
        </section>
        <section class="admin-panel" data-admin-panel="products" hidden>
            <div class="admin-panel-head">
                <h2>商品</h2>
                <span class="admin-count" id="product-count"></span>
            </div>
            <p class="admin-note">每行是一件商品及其来源店铺。删除时只清除该店铺那份记录，同一商品在别的店铺的采集仍保留；要连店铺里的商品一起清，请到「店铺」分类删除店铺。</p>
            <div class="admin-toolbar">
                <label class="admin-search">搜索<input id="admin-product-search" type="search" placeholder="商品名称、货号、SPU、来源店铺" autocomplete="off"></label>
                <label class="admin-filter">范围<select id="admin-product-filter"><option value="">全部商品</option><option value="unassigned">仅看无归属店铺</option></select></label>
                <span class="admin-selection" id="admin-product-selected" hidden></span>
                <button type="button" class="admin-btn danger" id="admin-product-delete" disabled>删除选中</button>
            </div>
            <div class="admin-list" id="admin-product-list"></div>
        </section>
        <section class="admin-panel" data-admin-panel="deleted" hidden>
            <div class="admin-panel-head"><h2>已删除的店铺</h2><span class="admin-count" id="deleted-count"></span></div>
            <p class="admin-note">这些店铺已被删除，插件心跳不会再登记它们。恢复只写回店铺记录与归属；商品是否还在取决于删除时选的模式。</p>
            <div class="admin-list" id="admin-deleted-list"></div>
        </section>`;
}

let viewButtons = [];
function showView(name) {
    viewButtons.forEach((button) => {
        const active = button.getAttribute("data-admin-view-button") === name;
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", active ? "true" : "false");
    });
    stage.querySelectorAll("[data-admin-panel]").forEach((panel) => {
        panel.hidden = panel.getAttribute("data-admin-panel") !== name;
    });
}

/** 主渲染：拉数据、画行、绑事件。 */
async function render() {
    const [payload, storePayload, overview] = await Promise.all([
        api("/temu/api/admin/users"),
        api("/temu/api/stores").catch(() => ({ stores: [] })),
        api("/temu/api/overview").catch(() => ({ products: [], batches: [] }))
    ]);
    const deletedPayload = await api("/temu/api/admin/stores/deleted").catch(() => ({ stores: [] }));
    const users = Array.isArray(payload.users) ? payload.users : [];
    const stores = (storePayload.stores || []).filter((store) => store.storeId);
    const deletedStores = Array.isArray(deletedPayload.stores) ? deletedPayload.stores : [];
    const products = Array.isArray(overview.products) ? overview.products : [];
    const batches = Array.isArray(overview.batches) ? overview.batches : [];

    const setText = (id, value) => { const el = document.getElementById(id); if (el) el.textContent = value; };
    setText("tab-count-stores", stores.length);
    setText("tab-count-products", products.length);
    setText("tab-count-users", users.length);
    setText("tab-count-deleted", deletedStores.length);
    setText("store-count", `${stores.length} 家`);
    setText("user-count", `${users.length} 个`);
    setText("deleted-count", `${deletedStores.length} 家`);
    const regToggle = document.getElementById("registration-open");
    if (regToggle) regToggle.checked = Boolean(payload.registrationOpen);

    const userOptions = users.map((user) => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.username)}</option>`).join("");

    // 账号行
    const userRows = users.map((user) => {
        const disabled = Boolean(user.disabled);
        const storesOwned = stores.filter((store) => store.ownerName === user.username && store.claimState !== "unclaimed").length;
        return `
        <article class="admin-row${disabled ? " is-muted" : ""}" data-user-row
            data-user-search="${escapeHtml(`${user.username} ${user.maskedUsername || ""}`.toLowerCase())}">
            <span class="admin-dot ${user.role === "admin" ? "role" : "online"}"></span>
            <div class="admin-row-body">
                <strong>${escapeHtml(user.username)}</strong>
                <span>${user.role === "admin" ? "管理员" : "普通用户"}${disabled ? " · 已停用" : ""} · 创建于 ${escapeHtml(String(user.createdAt || "").slice(0, 10) || "—")}${storesOwned ? ` · 名下店铺 ${storesOwned} 家` : ""}</span>
            </div>
            <span class="admin-row-owner"><b>状态</b>${disabled ? "已停用" : "正常"}</span>
            <div class="admin-row-actions">
                <button type="button" class="admin-btn" data-reset-password="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}">改密码</button>
                <button type="button" class="admin-btn" data-toggle-role="${escapeHtml(user.id)}" data-role="${user.role === "admin" ? "user" : "admin"}">${user.role === "admin" ? "降为普通" : "设为管理员"}</button>
                <button type="button" class="admin-btn ${disabled ? "" : "danger"}" data-toggle-disabled="${escapeHtml(user.id)}" data-disabled="${disabled ? "false" : "true"}">${disabled ? "启用" : "停用"}</button>
                <button type="button" class="admin-btn danger" data-delete-user="${escapeHtml(user.id)}" data-username="${escapeHtml(user.username)}">删除</button>
            </div>
        </article>`;
    }).join("");

    // 店铺行
    const storeRows = stores.map((store) => `
        <article class="admin-row${store.claimState === "unclaimed" ? "" : " is-muted"}" data-admin-store-row
            data-claim-state="${escapeHtml(store.claimState || "unclaimed")}"
            data-store-search="${escapeHtml(`${store.storeName || ""} ${store.storeId} ${store.ownerNameMasked || ""} ${store.ownerName || ""}`.toLowerCase())}">
            <span class="admin-dot ${store.online ? "online" : "offline"}"></span>
            <div class="admin-row-body">
                <strong>${escapeHtml(store.storeName || store.storeId)}</strong>
                <span>${escapeHtml(store.storeId)}${store.pluginVersion ? ` · 插件 ${escapeHtml(store.pluginVersion)}` : ""}${store.online ? "" : " · 离线"}</span>
            </div>
            <span class="admin-row-owner"><b>归属账户</b>${escapeHtml(store.ownerNameMasked || store.ownerName || "未认领")}</span>
            <div class="admin-row-actions">
                <select class="admin-select" data-reassign-target="${escapeHtml(store.storeId)}"><option value="">改派给…</option>${userOptions}</select>
                <button type="button" class="admin-btn" data-reassign-store="${escapeHtml(store.storeId)}">改派</button>
                ${store.claimState !== "unclaimed" ? `<button type="button" class="admin-btn" data-force-release="${escapeHtml(store.storeId)}">解除</button>` : ""}
                <button type="button" class="admin-btn danger" data-delete-store="${escapeHtml(store.storeId)}" data-store-name="${escapeHtml(store.storeName || store.storeId)}">删除</button>
            </div>
        </article>`).join("");

    const deletedRows = deletedStores.map((store) => `
        <article class="admin-row is-muted" data-deleted-store-row>
            <span class="admin-dot offline"></span>
            <div class="admin-row-body">
                <strong>${escapeHtml(store.storeName || store.storeId)}</strong>
                <span>${escapeHtml(store.storeId)} · 删除于 ${escapeHtml(String(store.deletedAt || "").replace("T", " ").slice(0, 16))} · 操作人 ${escapeHtml(store.deletedBy || "—")}</span>
            </div>
            <span class="admin-row-owner"><b>原归属</b>${escapeHtml(store.previousOwnerName || "未认领")}</span>
            <div class="admin-row-actions">
                <button type="button" class="admin-btn" data-restore-store="${escapeHtml(store.storeId)}">恢复</button>
            </div>
        </article>`).join("");

    const fill = (id, html, emptyText) => {
        const list = document.getElementById(id);
        if (list) list.innerHTML = html || `<div class="admin-empty">${emptyText}</div>`;
    };
    fill("admin-store-list", storeRows, "还没有插件上报过店铺。");
    fill("admin-user-list", userRows, "还没有其他账号。");
    fill("admin-deleted-list", deletedRows, "还没有删除过店铺。");
    // 商品一行一件、来源店铺标在行内，见 renderProductList 的说明。
    fill("admin-product-list", renderProductList(products, batches), "商品库还是空的。");

    const productCountEl = document.getElementById("product-count");
    if (productCountEl) productCountEl.textContent = `${products.length} 个`;

    bindEvents({ users, stores, products, batches });
}

/**
 * 商品列表：一行一个商品，来源店铺标在行内。
 *
 * 不做按店铺分组，因为每行本来就是"一个店铺的一个商品"——
 * 商品库按「来源店 + 货号」归并，同一个 SPU 在不同店是两行，行内只有一个来源店，
 * 所以直接把店名写进行里，比多一层分组容器更直接，也省掉一半纵向空间。
 *
 * 布局用表格栅格而不是卡片：这是核对型数据，字段要能纵向扫读对齐。
 */
function renderProductList(products, batches) {
    const nameOf = new Map();
    for (const batch of batches) {
        const id = String(batch.sourceStoreId || "").trim();
        if (id) nameOf.set(id, String(batch.sourceStoreName || batch.shopName || id));
    }
    if (!products.length) {
        return `<div class="admin-empty">商品库还是空的。在业务站采集商品后，这里会按来源店铺列出。</div>`;
    }
    const rows = products.map((product) => {
        const codes = [...new Set([...(product.productExtCodes || []), ...(product.skuExtCodes || [])]
            .map((value) => String(value || "").trim()).filter(Boolean))];
        const storeId = String((product.sourceStoreIds || [])[0] || "").trim();
        const storeName = storeId ? (nameOf.get(storeId) || storeId) : "无归属店铺";
        const state = product.blocked
            ? { label: "标红", cls: "blocked" }
            : (product.ready ? { label: "可交付", cls: "ready" } : { label: "资料不全", cls: "pending" });
        const search = `${product.title || ""} ${product.spuId || ""} ${codes.join(" ")} ${storeName}`.toLowerCase();
        return `
        <label class="admin-product-row" data-product-search="${escapeHtml(search)}" data-store-name="${escapeHtml(storeName)}">
            <span class="admin-product-check"><input type="checkbox" value="${escapeHtml(product.spuId || "")}" data-store-id="${escapeHtml(storeId)}"><span></span></span>
            <span class="admin-product-name" title="${escapeHtml(product.title || "")}">${escapeHtml(product.title || product.spuId || "(无标题)")}</span>
            <span class="admin-product-num">${escapeHtml(product.spuId || "—")}</span>
            <span class="admin-product-codes" title="${escapeHtml(codes.join(" / "))}">${escapeHtml(codes.join(" / ") || "—")}</span>
            <span class="admin-product-store"><i class="admin-dot ${storeId ? "online" : "offline"}"></i>${escapeHtml(storeName)}</span>
            <span class="admin-product-state ${state.cls}">${state.label}</span>
        </label>`;
    }).join("");
    return `
        <div class="admin-product-table">
            <div class="admin-product-thead">
                <span class="admin-product-head-check"><input type="checkbox" id="admin-product-checkall" aria-label="全选当前可见的商品"></span>
                <span>商品</span><span>SPU</span><span>货号</span><span>来源店铺</span><span>状态</span>
            </div>
            <div class="admin-product-body" id="admin-product-body">${rows}</div>
        </div>`;
}

function bindEvents({ users, stores, products = [], batches = [] }) {
    // ---------- 商品列表：勾选、筛选、批量删除 ----------
    const productList = document.getElementById("admin-product-list");
    if (productList) {
        const body = document.getElementById("admin-product-body");
        const rows = () => [...(body?.querySelectorAll(".admin-product-row") || [])];
        const boxOf = (row) => row.querySelector('input[type="checkbox"]');
        const checked = () => rows().map(boxOf).filter((box) => box && box.checked);

        /** 工具栏按钮反映当前选中数；没有选中时禁用，避免点空。 */
        const syncToolbar = () => {
            const count = checked().length;
            const button = document.getElementById("admin-product-delete");
            if (button) {
                button.disabled = count === 0;
                button.textContent = count ? `删除选中 ${count} 个` : "删除选中";
            }
            const counter = document.getElementById("admin-product-selected");
            if (counter) counter.hidden = count === 0;
            if (counter) counter.textContent = `已选 ${count} 个`;
            const all = document.getElementById("admin-product-checkall");
            const visible = rows().filter((row) => !row.hidden).map(boxOf).filter(Boolean);
            const checkedVisible = visible.filter((box) => box.checked);
            if (all) {
                all.checked = visible.length > 0 && checkedVisible.length === visible.length;
                all.indeterminate = checkedVisible.length > 0 && checkedVisible.length < visible.length;
            }
        };

        // 表头全选：只作用于当前筛选后可见的行，避免误删被搜索隐藏的商品。
        document.getElementById("admin-product-checkall")?.addEventListener("change", (event) => {
            for (const row of rows()) {
                const box = boxOf(row);
                if (box && !row.hidden) box.checked = event.target.checked;
            }
            syncToolbar();
        });
        productList.addEventListener("change", (event) => {
            if (event.target instanceof HTMLInputElement && event.target.type === "checkbox") syncToolbar();
        });

        /**
         * 删除选中：按各行自己的来源店分组提交。
         *
         * 商品库按「来源店 + 货号」归并，同一个 SPU 在不同店是两行；
         * 删除时若不带 storeId，会把别的店那份一起清掉（跨店误删）。
         * 因此这里按行上的 data-store-id 分组，每组带上自己的店铺范围。
         */
        productList.addEventListener("click", async (event) => {
            const button = event.target.closest("#admin-product-delete");
            if (!button) return;
            const picked = checked();
            if (!picked.length) return;
            // storeId → { storeName, spuIds }
            const byStore = new Map();
            for (const box of picked) {
                const row = box.closest(".admin-product-row");
                const storeId = box.dataset.storeId || "";
                const storeName = row?.dataset.storeName || (storeId ? storeId : "无归属店铺");
                if (!byStore.has(storeId)) byStore.set(storeId, { storeName, spuIds: [] });
                byStore.get(storeId).spuIds.push(box.value);
            }
            const storeCount = byStore.size;
            const details = [
                `将从商品库、历史批次与原始采集文件中彻底删除 ${picked.length} 个商品。`,
                `删除后无法恢复；同名 SPU 再次上传会作为新内容重新入库。`,
                storeCount > 1
                    ? `涉及 ${storeCount} 家来源店铺（${[...byStore.values()].map((item) => item.storeName).join("、")}）；各自只删本店那份，不波及其他店铺。`
                    : `只删除「${[...byStore.values()][0].storeName}」的商品记录；同一商品在别的店铺的那份会保留。`,
                "该操作不会删除店铺里已经创建的商品。"
            ];
            const confirmed = await confirmDestructive({
                title: `彻底删除 ${picked.length} 个商品？`,
                details,
                options: [],
                confirmLabel: "确认彻底删除"
            });
            if (!confirmed) return;
            button.disabled = true;
            const failed = [];
            try {
                for (const [storeId, group] of byStore) {
                    try {
                        await api("/temu/api/products", {
                            method: "DELETE",
                            body: JSON.stringify({ spuIds: group.spuIds, storeIds: storeId ? [storeId] : [] })
                        });
                    } catch (error) {
                        failed.push(`${group.storeName}：${error.message}`);
                    }
                }
                await render();
                if (failed.length) window.alert(`部分商品删除失败：\n${failed.join("\n")}`);
            } catch (error) {
                window.alert(`删除失败：${error.message}`);
                button.disabled = false;
            }
        });

        // 搜索与归属筛选：只隐藏行，不重新请求数据。
        const search = document.getElementById("admin-product-search");
        const filter = document.getElementById("admin-product-filter");
        const apply = () => {
            const keyword = search?.value.trim().toLowerCase() || "";
            const wanted = filter?.value || "";
            let visible = 0;
            for (const row of rows()) {
                // 无归属商品的行上没有来源店，据此区分，不用单独维护一个分组容器。
                const unassigned = !row.querySelector('input[type="checkbox"]')?.dataset.storeId;
                const matched = (!keyword || String(row.dataset.productSearch || "").includes(keyword))
                    && (!wanted || (wanted === "unassigned" ? unassigned : !unassigned));
                row.hidden = !matched;
                if (matched) visible += 1;
            }
            const count = document.getElementById("product-count");
            if (count) count.textContent = (keyword || wanted) ? `${visible} / ${products.length} 个` : `${products.length} 个`;
            syncToolbar();
        };
        search?.addEventListener("input", apply);
        filter?.addEventListener("change", apply);
        syncToolbar();
    }

    // 店铺搜索与归属筛选：只隐藏行，不重新请求数据。
    const storeSearch = document.getElementById("admin-store-search");
    const storeFilter = document.getElementById("admin-store-filter");
    const storeList = document.getElementById("admin-store-list");
    if (storeSearch && storeList) {
        const apply = () => {
            const keyword = storeSearch.value.trim().toLowerCase();
            const wanted = storeFilter?.value || "";
            let visible = 0;
            for (const row of storeList.querySelectorAll("[data-admin-store-row]")) {
                const claimed = row.dataset.claimState !== "unclaimed";
                const matched = (!keyword || String(row.dataset.storeSearch || "").includes(keyword))
                    && (!wanted || (wanted === "claimed" ? claimed : !claimed));
                row.hidden = !matched;
                if (matched) visible += 1;
            }
            const count = document.getElementById("store-count");
            if (count) count.textContent = (keyword || wanted) ? `${visible} / ${stores.length} 家` : `${stores.length} 家`;
        };
        storeSearch.addEventListener("input", apply);
        storeFilter?.addEventListener("change", apply);
    }
    const userSearch = document.getElementById("admin-user-search");
    const userList = document.getElementById("admin-user-list");
    if (userSearch && userList) {
        userSearch.addEventListener("input", () => {
            const keyword = userSearch.value.trim().toLowerCase();
            let visible = 0;
            for (const row of userList.querySelectorAll("[data-user-row]")) {
                const matched = !keyword || String(row.dataset.userSearch || "").includes(keyword);
                row.hidden = !matched;
                if (matched) visible += 1;
            }
            const count = document.getElementById("user-count");
            if (count) count.textContent = keyword ? `${visible} / ${users.length} 个` : `${users.length} 个`;
        });
    }

    document.getElementById("registration-open")?.addEventListener("change", async (event) => {
        try { await api("/temu/api/admin/registration", { method: "POST", body: JSON.stringify({ open: event.target.checked }) }); }
        catch (error) { window.alert(`修改注册开关失败：${error.message}`); event.target.checked = !event.target.checked; }
    });
    document.querySelectorAll("[data-reset-password]").forEach((button) => button.addEventListener("click", async () => {
        const secret = window.prompt(`为「${button.dataset.username}」设置新密码（至少 8 位）：`);
        if (!secret) return;
        try {
            await api("/temu/api/admin/users/password", { method: "POST", body: JSON.stringify({ userId: button.dataset.resetPassword, newPassword: secret }) });
            window.alert("密码已更新。");
        } catch (error) { window.alert(`改密码失败：${error.message}`); }
    }));
    document.querySelectorAll("[data-toggle-role]").forEach((button) => button.addEventListener("click", async () => {
        try {
            await api("/temu/api/admin/users/role", { method: "POST", body: JSON.stringify({ userId: button.dataset.toggleRole, role: button.dataset.role }) });
            await render();
        } catch (error) { window.alert(`修改角色失败：${error.message}`); }
    }));
    document.querySelectorAll("[data-toggle-disabled]").forEach((button) => button.addEventListener("click", async () => {
        try {
            await api("/temu/api/admin/users/disabled", { method: "POST", body: JSON.stringify({ userId: button.dataset.toggleDisabled, disabled: button.dataset.disabled === "true" }) });
            await render();
        } catch (error) { window.alert(`修改状态失败：${error.message}`); }
    }));

    // 删除账号：先取影响预检，再在弹窗里选"保留店铺"还是"完全删除"。
    document.querySelectorAll("[data-delete-user]").forEach((button) => button.addEventListener("click", async () => {
        const userId = button.dataset.deleteUser;
        const username = button.dataset.username;
        button.disabled = true;
        let impact = null;
        try { impact = await api(`/temu/api/admin/users/impact?userId=${encodeURIComponent(userId)}`); }
        catch (error) { window.alert(`读取影响范围失败：${error.message}`); button.disabled = false; return; }
        button.disabled = false;
        const owned = impact?.stores || [];
        const mode = await confirmDestructive({
            title: `删除账号 ${username}？`,
            details: owned.length
                ? [`该账号名下有 ${owned.length} 家店铺：`, ...owned.map((item) => `  • ${item.storeName}`)]
                : ["该账号名下没有店铺。"],
            options: [
                { value: "keep", label: "只删除账号，保留店铺和产品", hint: "店铺变为「未认领」，其他人可重新认领；商品数据保留。" },
                { value: "purge", label: "完全删除", hint: owned.length ? `账号、名下 ${owned.length} 家店铺记录、以及这些店铺采集的商品（${impact.productCount || 0} 个）一并删除，不可恢复。` : "账号与名下店铺记录一并删除，不可恢复。" }
            ]
        });
        if (!mode) return;
        try {
            await api("/temu/api/admin/users/delete", { method: "POST", body: JSON.stringify({ userId, mode }) });
            await render();
        } catch (error) { window.alert(`删除失败：${error.message}`); }
    }));

    // 删除店铺：同样先预检，再选"保留产品"还是"完全删除"。
    document.querySelectorAll("[data-delete-store]").forEach((button) => button.addEventListener("click", async () => {
        const storeId = button.dataset.deleteStore;
        const storeName = button.dataset.storeName || storeId;
        button.disabled = true;
        let impact = null;
        try { impact = await api(`/temu/api/admin/stores/impact?storeId=${encodeURIComponent(storeId)}`); }
        catch (error) { window.alert(`读取影响范围失败：${error.message}`); button.disabled = false; return; }
        button.disabled = false;
        const shared = Number(impact.sharedProductCount) || 0;
        const details = [
            `该店铺数据：`,
            `  • 采集的商品：${impact.productCount || 0} 个`,
            `  • 关联任务：${impact.jobCount || 0} 个`,
            `  • 工作日志：${impact.logCount || 0} 条`,
            `  • 当前归属：${impact.ownerName || "未认领"}`
        ];
        if (shared) details.push(`  • 其中 ${shared} 个商品同时来自其他店铺，会保留`);
        const mode = await confirmDestructive({
            title: `删除店铺「${storeName}」？`,
            details,
            options: [
                { value: "keep", label: "保留店铺产品", hint: `只删除店铺记录、归属、任务与日志；${impact.productCount || 0} 个商品保留在商品库（店铺已删除，这些商品仅管理员可见）。` },
                { value: "purge", label: "完全删除", hint: `店铺记录、${impact.productCount || 0} 个商品、${impact.jobCount || 0} 个任务、${impact.logCount || 0} 条日志一并删除，不可恢复。` }
            ]
        });
        if (!mode) return;
        try {
            await api("/temu/api/admin/stores/delete", { method: "POST", body: JSON.stringify({ storeId, mode }) });
            await render();
        } catch (error) { window.alert(`删除失败：${error.message}`); }
    }));

    document.querySelectorAll("[data-restore-store]").forEach((button) => button.addEventListener("click", async () => {
        if (!window.confirm("确认恢复该店铺？会写回店铺记录与原来的归属；商品是否还在取决于删除时选的模式。")) return;
        try {
            await api("/temu/api/admin/stores/restore", { method: "POST", body: JSON.stringify({ storeId: button.dataset.restoreStore }) });
            await render();
        } catch (error) { window.alert(`恢复失败：${error.message}`); }
    }));
    document.querySelectorAll("[data-reassign-store]").forEach((button) => button.addEventListener("click", async () => {
        const storeId = button.dataset.reassignStore;
        const select = document.querySelector(`[data-reassign-target="${CSS.escape(storeId)}"]`);
        const userId = String(select?.value || "");
        if (!userId) { window.alert("请先选择要改派到的账号。"); return; }
        try {
            await api("/temu/api/admin/stores/reassign", { method: "POST", body: JSON.stringify({ storeId, userId }) });
            await render();
        } catch (error) { window.alert(`改派失败：${error.message}`); }
    }));
    document.querySelectorAll("[data-force-release]").forEach((button) => button.addEventListener("click", async () => {
        if (!window.confirm("确认解除该店铺的认领？该店铺会回到未认领状态，数据保留。")) return;
        try {
            await api("/temu/api/admin/stores/reassign", { method: "POST", body: JSON.stringify({ storeId: button.dataset.forceRelease, release: true }) });
            await render();
        } catch (error) { window.alert(`解除失败：${error.message}`); }
    }));
}

/** 入口：先验身份，非管理员直接拦下，不渲染任何管理数据。 */
async function boot() {
    document.getElementById("admin-logout")?.addEventListener("click", logout);
    viewButtons = [...document.querySelectorAll("[data-admin-view-button]")];
    viewButtons.forEach((button) => button.addEventListener("click", () => showView(button.getAttribute("data-admin-view-button") || "stores")));

    let me = null;
    try { me = await loadIdentity(); }
    catch (error) {
        stage.innerHTML = `<div class="admin-panel"><div class="admin-empty">读取身份失败：${escapeHtml(error.message)}</div></div>`;
        return;
    }
    if (!me.isAdmin) {
        // 服务端也会拦（/api/admin/* 返回 403），这里只是给一句可读的说明。
        stage.innerHTML = `<div class="admin-panel"><div class="admin-empty">当前账号不是管理员，无法使用管理控制台。<br><br><a href="./">返回工作台</a></div></div>`;
        return;
    }
    renderShell();
    await render();
}

boot();
