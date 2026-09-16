/**
 * 校验“店铺已删除商品不上传”这一条链：
 * 1) 后台解析商品列表行时按 removeStatus 分离已删除与在店商品，且不按货号判断；
 * 2) 真实 Chromium 里加载未打包插件，夹具页只提供当前页 3 件商品，平台状态返回其中 1 件已删除，
 *    插件必须按当前页 SKC 核验并把它排除，面板期望数量降为 2、跳过数量为 1。
 * 夹具网络整机指向不可用代理，未拦截的请求立即失败，因此不会访问真实 Temu、不会入库。
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptsDir);
const pluginDir = path.resolve(rootDir, "..", "plugin");
const manifest = JSON.parse(readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));

// ---------- 第一部分：后台行解析 ----------
const backgroundSource = readFileSync(path.join(pluginDir, "background.js"), "utf8").split("chrome.runtime.onMessage.addListener")[0];
const backgroundContext = vm.createContext({ importScripts() {}, TextEncoder, URL, console, crypto });
vm.runInContext(backgroundSource, backgroundContext);

const listPayload = {
    success: true,
    result: {
        total: 4,
        pageItems: [
            // 已删除商品：removeStatus=1，且带 30 天自动清理倒计时。
            { productId: 2011043849, productSkcId: 87930835201, extCode: "UAA55", removeStatus: 1, autoDeleteRemainingDays: 29 },
            // 同货号重新建成的在店商品：productId 不同、removeStatus=0，不能因为货号相同被判成已删除。
            { productId: 5233010681, productSkcId: 99112233445, extCode: "UAA55", removeStatus: 0 },
            { productId: 4764369705, productSkcId: 92333181434, extCode: "", removeStatus: 0 },
            // 未验证过的状态值必须当成未知，既不排除也不解除。
            { productId: 1597289621, productSkcId: 88123456789, extCode: "UAA75", removeStatus: 9 },
            // 空值不能经过 Number(null) 被误判成在店状态。
            { productId: 2271483601, productSkcId: 85123456789, extCode: "UAA76", removeStatus: null }
        ]
    }
};

const meta = backgroundContext.getProductMeta(listPayload);
// VM 里返回的是另一 realm 的数组，先复制到本 realm 再比较。
assert.deepEqual(Array.from(meta.removedProductIds), ["2011043849"], "只应把 removeStatus=1 的行判为店铺已删除");
assert.deepEqual(
    Array.from(meta.activeProductIds).sort(),
    ["4764369705", "5233010681"],
    "status=0 的行才是在店商品，未知和空状态值不参与判断"
);
assert.ok(!Array.from(meta.activeProductIds).includes("2271483601"), "null 不能被当成在店状态");
assert.ok(Array.from(meta.activeProductIds).includes("5233010681"), "同货号重建的新商品不能被当成已删除");
assert.ok(!Array.from(meta.removedProductIds).includes("5233010681"), "货号相同不代表同一商品");

// 列表以外的响应即使出现 removeStatus 字段也不提取，避免旁路任务同名字段污染判断。
const unrelated = backgroundContext.getProductMeta({ result: { taskList: [{ taskId: 9, removeStatus: 1 }] } });
assert.deepEqual(Array.from(unrelated.removedProductIds), [], "旁路任务行没有商品 ID，不能产生删除标记");

// ---------- 第二部分：真实浏览器端到端 ----------
function loadPlaywright() {
    const candidates = [
        process.env.PLAYWRIGHT_MODULE,
        "playwright",
        path.join("E:", "project", "chajian", "node_modules", "playwright")
    ].filter(Boolean);
    for (const candidate of candidates) {
        try { return require(candidate); } catch { /* 换下一个候选 */ }
    }
    return null;
}

const playwright = loadPlaywright();
if (!playwright) {
    console.log("removed-product checks passed（后台解析）；插件端到端检查跳过：playwright 不可用");
    process.exit(0);
}

const ROWS = [
    { spuId: "2011043849", skcId: "87930835201", removeStatus: 1 },
    { spuId: "4764369705", skcId: "92333181434", removeStatus: 0 },
    { spuId: "2815277641", skcId: "84254115628", removeStatus: 0 }
];

/** 夹具装出商品表格与网页查询客户端；客户端方法名与插件识别特征一致，但不连真实平台。 */
function fixtureHtml() {
    const rows = ROWS.map(row => `<tr><td><input type="checkbox"></td><td>SPU ID：${row.spuId}<br>SKC ID：${row.skcId}</td><td>商品 ${row.spuId}</td></tr>`).join("");
    return [
        "<!doctype html>",
        '<html lang="zh"><head><meta charset="utf-8"><title>商品列表</title></head><body>',
        `<main><table><tbody>${rows}</tbody></table></main>`,
        "<script>",
        `window.__listRows = ${JSON.stringify(ROWS)};`,
        `window.__removalMode = new URLSearchParams(location.search).get("removal") || "ok";`,
        // 详情与状态查询都走这个假客户端，插件只按调用路径区分。
        `window.chunkLoadingGlobal_temu_sca_goods = [];`,
        `window.chunkLoadingGlobal_temu_sca_goods.push = function (entry) {`,
        `    var callback = entry[2];`,
        `    var client = {`,
        `        mallIdClient: { getMallIdAsync: async function () { return "12345"; } },`,
        `        postWithoutMallId: function () {},`,
        `        post: async function (requestPath, body) {`,
        `            if (requestPath.indexOf("pageQuery") >= 0) {`,
        `                var wanted = (body && body.productSkcIds) || [];`,
                `                var items = window.__listRows.filter(function (row) { return wanted.indexOf(row.skcId) >= 0; }).map(function (row) {`,
                `                    var removeStatus = window.__removalMode === "all-deleted" ? 1 : (window.__removalMode === "invalid-status" && row.skcId === "87930835201" ? null : row.removeStatus);`,
                `                    return { productId: row.spuId, productSkcId: row.skcId, removeStatus: removeStatus, extCode: "" };`,
        `                });`,
        `                return { success: true, result: { total: items.length, pageItems: items } };`,
        `            }`,
        `            return { success: true, result: { productId: String(body && body.productId), productName: "fixture", productSkcList: [] } };`,
        `        }`,
        `    };`,
        `    var runtime = function () { return client; };`,
        // 工厂源码必须带上插件识别的三个特征串，否则插件会拒绝猜测客户端。
        `    runtime.m = { 1: function fakeModule() { return "getMallIdAsync .postWithoutMallId= .mallIdClient="; } };`,
        `    callback(runtime);`,
        `};`,
        // 页面自身的列表请求：插件靠它确认当前页商品已被主列表接口覆盖。
        `window.addEventListener("load", function () {`,
        `    fetch("/visage-agent-seller/product/skc/pageQuery", {`,
        `        method: "POST",`,
        `        headers: { "content-type": "application/json" },`,
        `        body: JSON.stringify({ page: 1, pageSize: 20 })`,
        `    }).catch(function () {});`,
        `});`,
        "</script></body></html>"
    ].join("\n");
}

/** 面板是 closed Shadow DOM，用 CDP 穿透阴影根后调用按钮自身的 click()。 */
async function clickPanelButton(client, className) {
    const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
    const found = [];
    const classNameOf = node => {
        if (Array.isArray(node.attributeList) && node.attributeList.length) {
            return node.attributeList.find(attribute => attribute.name === "class")?.value || "";
        }
        const flat = node.attributes || [];
        const index = flat.indexOf("class");
        return index >= 0 ? String(flat[index + 1] || "") : "";
    };
    (function walk(node) {
        if (!node) return;
        if (node.nodeName === "BUTTON" && classNameOf(node).split(/\s+/).includes(className)) found.push(node.nodeId);
        (node.children || []).forEach(walk);
        (node.shadowRoots || []).forEach(walk);
    })(root);
    assert.equal(found.length, 1, `面板中应恰好有一个 .${className} 按钮，实际 ${found.length} 个`);
    const { object } = await client.send("DOM.resolveNode", { nodeId: found[0] });
    await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { this.click(); }",
        returnByValue: true
    });
}

/** 宿主属性是插件对紫鸟 CLI 公开的只读状态，用它核对跳过数量与剩余目标数量。 */
function pluginStatus(page) {
    // 采集会整页刷新，轮询期间旧执行上下文可能被销毁；这种情况按“本轮无状态”继续等待。
    return page.evaluate(() => {
        const panel = document.querySelector("[data-plugin-presence]");
        if (!panel) return null;
        return {
            version: panel.getAttribute("data-plugin-version"),
            expectedCount: panel.getAttribute("data-expected-count"),
            removedCount: panel.getAttribute("data-removed-count"),
            capturePhase: panel.getAttribute("data-capture-phase")
        };
    }).catch(() => null);
}

async function waitForStatus(page, predicate, description, timeout = 30000) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = await pluginStatus(page);
        if (last && predicate(last)) return last;
        await page.waitForTimeout(150);
    }
    throw new Error(`等待插件状态超时（${description}），最后一次状态：${JSON.stringify(last)}`);
}

const profileDir = mkdtempSync(path.join(os.tmpdir(), "ziniao-plugin-removed-"));
let context = null;
const problems = [];
try {
    context = await playwright.chromium.launchPersistentContext(profileDir, {
        channel: "chromium",
        headless: true,
        proxy: { server: "http://127.0.0.1:9" },
        args: [
            `--disable-extensions-except=${pluginDir}`,
            `--load-extension=${pluginDir}`,
            "--no-first-run",
            "--no-default-browser-check"
        ]
    });
    await context.route("**/*", route => {
        const url = route.request().url();
        if (url.startsWith("https://agentseller.temu.com/goods/list")) {
            return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: fixtureHtml() });
        }
        if (url.includes("/visage-agent-seller/product/skc/pageQuery")) {
            // 页面自身列表响应故意不带 removeStatus，只有插件按当前页 SKC 核验才能发现已删除商品。
            return route.fulfill({
                status: 200,
                contentType: "application/json; charset=utf-8",
                body: JSON.stringify({
                    success: true,
                    result: {
                        total: ROWS.length,
                        pageItems: ROWS.map(row => ({ productId: row.spuId, productSkcId: row.skcId, extCode: "" }))
                    }
                })
            });
        }
        return route.abort();
    });
    if (process.env.REMOVED_DEBUG) {
        await context.addInitScript(() => {
            window.__removedDebugEvents = [];
            window.addEventListener("message", event => {
                const value = event.data;
                if (value?.source !== "temu-shop-transfer-api-v1") return;
                window.__removedDebugEvents.push({
                    kind: String(value.kind || ""),
                    requestId: String(value.requestId || ""),
                    skcIds: Array.isArray(value.skcIds) ? value.skcIds : [],
                    itemCount: Array.isArray(value.payload?.items) ? value.payload.items.length : null,
                    error: String(value.error || "")
                });
            });
        });
    }

    const page = context.pages()[0] || await context.newPage();
    page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
    if (process.env.REMOVED_DEBUG) page.on("console", message => console.log(`[page:${message.type()}] ${message.text()}`));
    await page.goto("https://agentseller.temu.com/goods/list", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });
    // 未点采集前不核验删除状态，保持“只有运行时才读取平台状态”的边界。
    const before = await waitForStatus(page, status => status.expectedCount === String(ROWS.length), "首屏统计完成");
    assert.equal(before.removedCount, "0", `未启动采集时不应核验删除状态：${JSON.stringify(before)}`);
    if (process.env.REMOVED_DEBUG) {
        const domRows = await page.evaluate(() => Array.from(document.querySelectorAll("table tbody > tr")).map(row => String(row.textContent || "").replace(/\s+/g, " ").trim()));
        console.log(`[debug] initial rows: ${JSON.stringify(domRows)}`);
    }

    const client = await context.newCDPSession(page);
    await clickPanelButton(client, "start");
    // 采集会先整页刷新，刷新后夹具重新发出列表请求，插件随后核验当前页 SKC 的删除状态。
    let after;
    try {
        after = await waitForStatus(page, status => status.removedCount === "1" && status.expectedCount === "2", "已删除商品被排除");
    } catch (error) {
        if (process.env.REMOVED_DEBUG) {
            const debugEvents = await page.evaluate(() => window.__removedDebugEvents || []).catch(() => []);
            console.log(`[debug] removal messages: ${JSON.stringify(debugEvents)}`);
            const domRows = await page.evaluate(() => Array.from(document.querySelectorAll("table tbody > tr")).map(row => String(row.textContent || "").replace(/\s+/g, " ").trim())).catch(() => []);
            console.log(`[debug] rows after capture: ${JSON.stringify(domRows)}`);
        }
        throw error;
    }
    assert.equal(after.expectedCount, "2", `期望目标应排除已删除商品：${JSON.stringify(after)}`);
    assert.equal(after.removedCount, "1", `应跳过 1 件已删除商品：${JSON.stringify(after)}`);
    assert.deepEqual(problems, [], "夹具页不应产生脚本错误");

    // 状态接口缺少明确值时必须停止本轮，不能让未知商品继续进入详情和上传队列。
    await page.goto("https://agentseller.temu.com/goods/list?removal=invalid-status", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });
    const blockedClient = await context.newCDPSession(page);
    await clickPanelButton(blockedClient, "start");
    const blocked = await waitForStatus(page, status => status.capturePhase === "待人工确认", "未知删除状态阻止采集");
    assert.equal(blocked.removedCount, "0", `未知状态不能记成已删除：${JSON.stringify(blocked)}`);
    assert.equal(blocked.expectedCount, String(ROWS.length), `未知状态不能静默排除商品：${JSON.stringify(blocked)}`);

    // 当前页全部商品都已删除时，目标数量必须归零并正常结束，不能继续等待详情或上传。
    await page.goto("https://agentseller.temu.com/goods/list?removal=all-deleted", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });
    const allDeletedClient = await context.newCDPSession(page);
    await clickPanelButton(allDeletedClient, "start");
    const allDeleted = await waitForStatus(
        page,
        status => status.capturePhase === "采集完成" && status.removedCount === String(ROWS.length) && status.expectedCount === "0",
        "整页已删除商品归零"
    );
    assert.equal(allDeleted.expectedCount, "0", `整页已删除时不应保留上传目标：${JSON.stringify(allDeleted)}`);
    assert.equal(allDeleted.removedCount, String(ROWS.length), `应记录全部已删除商品：${JSON.stringify(allDeleted)}`);
    console.log(`店铺已删除商品检查通过：当前页 ${ROWS.length} 件中跳过 1 件，剩余目标 2 件`);
} finally {
    await context?.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
}
