/** 直接执行插件真实函数，验证实时选择与批次快照隔离；全部通信为内存夹具，不访问平台和云仓。 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import test from "node:test";

let source = await readFile(new URL("../../plugin/content-app.js", import.meta.url), "utf8");
// 只在测试内存中退化关键实现，确认验收能抓住回归，不修改插件文件。
if (process.env.SELECTION_TEST_MUTATION === "live-targets") {
    source = source.replace("state.captureTargetIds === null ? state.pageProductIds : state.captureTargetIds",
        "state.selectionMode ? state.selectedProductIds : state.pageProductIds");
}
if (process.env.SELECTION_TEST_MUTATION === "clear-skc") {
    source = source.replace("if (!preservePageIndex) {", "state.rowSkcIds.clear(); if (!preservePageIndex) {");
}

/** 按源码顶层边界提取真实函数；禁止复制业务实现到测试中使反例失去作用。 */
function sourceFunction(name) {
    const matches = [...source.matchAll(new RegExp(`^    (?:async )?function ${name}\\(`, "gm"))];
    assert.equal(matches.length, 1, `${name} 必须在源码中唯一`);
    const tail = source.slice(matches[0].index);
    const end = /^    }\r?$/m.exec(tail);
    assert.ok(end, `${name} 缺少函数结束边界`);
    return tail.slice(0, end.index + end[0].length);
}

/** 行夹具记录每一次 checked 写入，用来识别插件偷偷勾回原生复选框的回归。 */
function makeRow(id, checked = false) {
    const row = { id: String(id), skcIds: [String(900000 + Number(id))], writes: 0, attributes: new Map() };
    class Checkbox {
        constructor() { this.type = "checkbox"; this.value = checked; }
        get checked() { return this.value; }
        set checked(value) { this.value = value; row.writes++; }
        closest(selector) { return selector.startsWith("thead") ? null : row; }
    }
    row.checkbox = new Checkbox();
    row.querySelector = () => row.checkbox;
    row.removeAttribute = name => row.attributes.delete(name);
    return row;
}

/** 外部依赖只模拟浏览器消息和界面；选择、重置、启动及详情入队使用真实函数。 */
function harness(rows = []) {
    const messages = [], rendered = [];
    let key = "fixture||全部||||", gate = null;
    const ctx = vm.createContext({
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        location: { href: "https://fixture.invalid/goods/list", origin: "https://fixture.invalid" },
        document: { querySelectorAll: () => rows.filter(row => row.attributes.has("data-temu-selected-capture")), getElementById: () => null },
        getPageContextKey: () => key, getProductScanRoots: () => [{}], getProductTableRows: () => rows,
        readSpuIdFromRow: row => row?.id || null, readSkcIdsFromRow: row => row.skcIds,
        normalizeProductId: value => String(value || ""), countVisibleProductCards: () => rows.length,
        readDeclaredProductCount: () => null, updateDomDiagnosticsSummary: () => {},
        isWorkPage: () => true, clearCompletionTimers: () => {}, setIngestState: () => {},
        matchPendingProductIds: () => {}, evaluateCompletion: () => {}, scheduleCompletionCheck: () => {},
        render: () => rendered.push({ selected: ctx.api?.state.selectedProductIds.size, expected: ctx.api?.expectedProductCount() }),
        send: async (type, input) => {
            messages.push({ type, input: structuredClone(input) });
            if (type === "setCaptureEnabled" && input.enabled) {
                if (gate) await gate.promise;
                return { ok: true, enabled: true, captureToken: "fixture-token" };
            }
            if (type === "beginDetailSupplement") return { active: true, mode: "api", total: input.input.spuIds.length };
            return { ok: true };
        },
        verifyRemovedProducts: async () => ({ checked: true, removed: 0 }),
        runApiDetailQueue: async () => {}, makeRunSummary: () => ({}),
        beginRun: () => { ctx.api.state.runGeneration++; ctx.api.state.pageScanReady = true; },
        waitForCurrentPageScan: async () => { ctx.api.scanPageProducts(); return true; },
        finishCapture: () => { throw new Error("非预期终止"); }, setToolsExpanded: () => {},
        HTMLInputElement: rows[0]?.checkbox.constructor || class {},
    });
    const start = source.indexOf("    const state = {");
    const end = source.indexOf("    let ingestSettings", start);
    assert.ok(start >= 0 && end > start);
    const names = ["readSelectedProductIds", "handleNativeProductSelection", "clearLockedRowMarkers", "syncLiveSelection",
        "refreshExpectedProducts", "scanPageProducts", "captureProductIds", "applyRemovalToExpectedProducts", "applyRemovalStatuses",
        "resetPageContext", "resetDetailRuntimeForNewCapture", "syncPageContext", "startCaptureBatch",
        "startCapture", "startSelectedCapture", "startDetailSupplement", "expectedProductCount"];
    vm.runInContext(`${source.slice(start, end)}
        const LOCKED_ROW_ATTRIBUTE = 'data-temu-selected-capture', LOCKED_ROW_STYLE_ID = 'temu-selected-capture-locked-style';
        let pageContextStartedAt = 0, ingestFingerprint = '', ingestQueue = { pendingCount: 0, maxAttempts: 3 };
        ${names.map(sourceFunction).join("\n")}
        globalThis.api = { state, ${names.join(",")} };`, ctx);
    return { api: ctx.api, ctx, messages, rendered,
        setRows: next => { rows = next; },
        setKey: next => { key = next; },
        delayEnable: () => { let resolve; const promise = new Promise(done => { resolve = done; }); gate = { promise, resolve }; return gate; } };
}

function ids(values) { return [...values].sort(); }

/** 使用真实删除核验函数，页面回执由内存消息桥提供，绝不调用平台接口。 */
function installRemovalVerifier(h, responder) {
    const listeners = new Set();
    const bridge = {
        addEventListener: (_, listener) => listeners.add(listener),
        removeEventListener: (_, listener) => listeners.delete(listener),
        postMessage: request => responder(request, payload => {
            for (const listener of listeners) listener({ source: bridge, origin: h.ctx.location.origin,
                data: { source: "temu-shop-transfer-api-v1", kind: "removal-result", requestId: request.requestId, payload } });
        })
    };
    h.ctx.window = bridge;
    h.ctx.crypto = { randomUUID: () => "fixture-removal-request" };
    vm.runInContext(`${sourceFunction("verifyRemovedProducts")}\napi.verifyRemovedProducts = verifyRemovedProducts;`, h.ctx);
}

test("启动回执期间改变选择，批次与详情队列仍锁定点击时的清单", async () => {
    const rows = [makeRow(1001, true), makeRow(1002, true), makeRow(1003)];
    const h = harness(rows), gate = h.delayEnable();
    const pending = h.api.startSelectedCapture();
    await Promise.resolve(); await Promise.resolve();
    rows[0].checkbox.value = false; rows[2].checkbox.value = true;
    h.api.syncLiveSelection();
    assert.deepEqual(ids(h.api.state.selectedProductIds), ["1002", "1003"]);
    assert.deepEqual(ids(h.api.captureProductIds()), ["1001", "1002"]);
    gate.resolve(); await pending;
    assert.deepEqual(h.messages.find(message => message.type === "beginDetailSupplement").input.input.spuIds.sort(), ["1001", "1002"]);
    assert.equal(h.api.expectedProductCount(), 2);
    assert.equal(h.api.state.selectedProductIds.size, 2);
    assert.ok(h.rendered.some(view => view.selected === 2 && view.expected === 2));
});

test("运行中全部取消选择，不回退整页，不勾回，不改变详情目标", async () => {
    const rows = [makeRow(1001, true), makeRow(1002)];
    const h = harness(rows);
    await h.api.startSelectedCapture();
    rows[0].checkbox.value = false;
    h.api.scanPageProducts();
    assert.equal(h.api.state.selectedProductIds.size, 0);
    assert.deepEqual(ids(h.api.captureProductIds()), ["1001"]);
    assert.equal(h.api.expectedProductCount(), 1);
    assert.equal(rows[0].checkbox.checked, false);
    assert.equal(rows.reduce((sum, row) => sum + row.writes, 0), 0);
    const returned = h.api.captureProductIds(); returned.clear();
    assert.equal(h.api.captureProductIds().size, 1, "调用方也不能修改原快照");
});

test("失败后选择新的商品，再启动只使用新的清单", async () => {
    const rows = [makeRow(1001, true), makeRow(1002)];
    const h = harness(rows);
    h.ctx.verifyRemovedProducts = async () => ({ checked: false, reason: "测试缺少 SKC" });
    await h.api.startSelectedCapture();
    assert.equal(h.api.state.phase, "待人工确认");
    rows[0].checkbox.value = false; rows[1].checkbox.value = true;
    h.api.scanPageProducts();
    assert.deepEqual(ids(h.api.state.selectedProductIds), ["1002"]);
    assert.deepEqual(ids(h.api.captureProductIds()), ["1001"]);
    h.ctx.verifyRemovedProducts = async () => ({ checked: true });
    await h.api.startSelectedCapture();
    assert.deepEqual(ids(h.api.captureProductIds()), ["1002"]);
    assert.deepEqual(h.messages.find(message => message.type === "beginDetailSupplement").input.input.spuIds, ["1002"]);
});

test("50 件已见行缩为 15 件挂载行，同页启动不丢 SKC 与选择", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => makeRow(1001 + index, true));
    const h = harness(rows); h.api.scanPageProducts();
    h.setRows(rows.slice(0, 15));
    await h.api.startSelectedCapture();
    assert.equal(h.api.state.captureTargetIds.size, 50);
    assert.equal(h.api.state.rowSkcIds.size, 50);
    assert.equal(h.api.state.domProductIds.size, 50, "启动不能清空实时页面索引");
    assert.equal(h.messages.find(message => message.type === "beginDetailSupplement").input.input.spuIds.length, 50);
    installRemovalVerifier(h, (request, reply) => {
        assert.equal(request.skcIds.length, 50);
        reply({ items: rows.map(row => ({ productId: row.id, productSkcId: row.skcIds[0], removeStatus: 0 })) });
    });
    assert.equal((await h.api.verifyRemovedProducts(h.api.captureProductIds())).checked, true);
});

test("删除核验晚回执不污染停止后的下一轮状态", async () => {
    const h = harness([makeRow(1001, true)]); h.api.scanPageProducts();
    let reply;
    installRemovalVerifier(h, (_, deliver) => { reply = deliver; });
    const pending = h.api.verifyRemovedProducts(new Set(["1001"]));
    h.api.state.runGeneration++;
    reply({ items: [{ productId: "1001", productSkcId: "901001", removeStatus: 1 }] });
    assert.equal((await pending).checked, false);
    assert.equal(h.api.state.removedProductIds.size, 0);
    assert.equal(h.api.state.removalKnownProductIds.size, 0);
});

test("原生表头取消全选清理离屏选择，但保留采集范围", async () => {
    const rows = [makeRow(1001, true), makeRow(1002, true)];
    const h = harness(rows); await h.api.startSelectedCapture();
    h.setRows(rows.slice(0, 1));
    const header = new rows[0].checkbox.constructor(); header.value = false;
    header.closest = selector => selector.startsWith("thead") ? {} : null;
    h.api.handleNativeProductSelection({ target: header });
    rows[0].checkbox.value = false; h.api.scanPageProducts();
    assert.equal(h.api.state.selectedProductIds.size, 0);
    assert.equal(h.api.captureProductIds().size, 2);
});

test("真实切页清空选择、元数据和批次；启动晚回执不能跨页继续", async () => {
    const h = harness([makeRow(1001, true)]), gate = h.delayEnable();
    const pending = h.api.startSelectedCapture();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    h.setKey("fixture||已删除||||"); h.api.syncPageContext();
    gate.resolve(); await pending;
    assert.equal(h.api.state.captureTargetIds, null);
    assert.equal(h.api.state.selectedProductIds.size, 0);
    assert.equal(h.api.state.rowSkcIds.size, 0);
    assert.equal(h.api.state.enabled, false);
    assert.equal(h.messages.some(message => message.type === "beginDetailSupplement"), false);
});

test("明确空快照与全部已删除批次都显示 0，不回退可见行数", () => {
    const h = harness([makeRow(1001, true)]); h.api.scanPageProducts();
    h.api.state.captureTargetIds = new Set();
    assert.equal(h.api.expectedProductCount(), 0);
    h.api.state.captureTargetIds.add("1001");
    h.api.applyRemovalStatuses({ removedProductIds: ["1001"] });
    assert.equal(h.api.captureProductIds().size, 0);
    assert.equal(h.api.expectedProductCount(), 0);
    assert.deepEqual(ids(h.api.state.captureTargetIds), ["1001"], "删除过滤不能修改原始快照");
});

test("普通采集也冻结范围，且不清空实时勾选", async () => {
    const rows = [makeRow(1001, true), makeRow(1002)];
    const h = harness(rows); await h.api.startCapture();
    assert.deepEqual(ids(h.api.state.selectedProductIds), ["1001"]);
    h.setRows([...rows, makeRow(1003, true)]); h.api.scanPageProducts();
    assert.deepEqual(ids(h.api.captureProductIds()), ["1001", "1002"]);
    assert.deepEqual(ids(h.api.state.selectedProductIds), ["1001", "1003"]);
});

test("选择批次失败后改为普通采集，新批使用整页索引而不是旧选择快照", async () => {
    const h = harness([makeRow(1001, true), makeRow(1002)]);
    h.ctx.verifyRemovedProducts = async () => ({ checked: false });
    await h.api.startSelectedCapture();
    assert.deepEqual(ids(h.api.captureProductIds()), ["1001"]);
    h.ctx.verifyRemovedProducts = async () => ({ checked: true });
    await h.api.startCapture();
    assert.deepEqual(ids(h.api.captureProductIds()), ["1001", "1002"]);
});

test("虚拟列表选择批次失败后普通采集，仍保留同页已见的 50 件范围", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => makeRow(1001 + index, index < 2));
    const h = harness(rows); h.api.scanPageProducts(); h.setRows(rows.slice(0, 15));
    h.ctx.verifyRemovedProducts = async () => ({ checked: false });
    await h.api.startSelectedCapture();
    assert.equal(h.api.captureProductIds().size, 2);
    h.ctx.verifyRemovedProducts = async () => ({ checked: true });
    await h.api.startCapture();
    assert.equal(h.api.captureProductIds().size, 50);
    assert.equal(h.api.state.rowSkcIds.size, 50);
});

test("详情入队期间停止，旧回执不回写队列或重新运行", async () => {
    const h = harness([makeRow(1001, true)]);
    let release, entered;
    const arrived = new Promise(resolve => { entered = resolve; });
    const waiting = new Promise(resolve => { release = resolve; });
    const send = h.ctx.send;
    h.ctx.send = async (type, input) => {
        if (type === "beginDetailSupplement") { entered(); await waiting; }
        return send(type, input);
    };
    const pending = h.api.startSelectedCapture();
    await arrived;
    h.api.state.enabled = false; h.api.state.runGeneration++;
    release(); await pending;
    assert.equal(h.api.state.detailQueue, null);
    assert.equal(h.api.state.enabled, false);
});

test("同 URL 切店也淘汰旧选择和 SKC；短暂店名为空不误判切店", async () => {
    const h = harness([makeRow(1001, true)]);
    let name = "夹具店 A";
    h.ctx.TemuStoreIdentity = { readPageIdentity: () => ({ storeName: name }) };
    await h.api.startSelectedCapture();
    name = ""; assert.equal(h.api.syncPageContext(), false);
    assert.equal(h.api.captureProductIds().size, 1);
    name = "夹具店 B"; assert.equal(h.api.syncPageContext(), true);
    assert.equal(h.api.state.captureTargetIds, null);
    assert.equal(h.api.state.selectedProductIds.size, 0);
    assert.equal(h.api.state.rowSkcIds.size, 0);
});

test("无 change 和 DOM 变更事件的 checked 更新，也能被实时同步", () => {
    const rows = [makeRow(1001)]; const h = harness(rows);
    h.api.scanPageProducts(); rows[0].checkbox.value = true;
    h.api.syncLiveSelection();
    assert.deepEqual(ids(h.api.state.selectedProductIds), ["1001"]);
    assert.equal(h.rendered.at(-1).selected, 1);
});

test("刷新只读当前页面，不读持久化选择，也没有强制勾回逻辑", () => {
    assert.doesNotMatch(source, /getSelectedCaptureIntent|saveSelectedCaptureIntent|restoreVisibleProductCheckboxes|persistSelectedProductIds/);
    assert.doesNotMatch(source, /checkbox\.checked\s*=/);
    assert.match(source, /当前选择/);
    assert.match(source, /data-selected-count/);
});
