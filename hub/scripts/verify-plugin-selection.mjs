/**
 * 在真实 Chromium 中加载未打包插件，用本地夹具页面核对“勾选商品后选择性采集”的跨页与刷新行为。
 * 夹具通过路由拦截伪造商品列表，且整机网络指向不可用代理，因此不会访问真实 Temu、不会入库、不会登记心跳。
 * 缺少 playwright 时跳过，不阻断其他验证。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptsDir);
const pluginDir = path.resolve(rootDir, "..", "plugin");
const manifest = JSON.parse(readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));

// playwright 只用于本轮实测，不进 hub 依赖；按环境变量、常规解析、本机既有安装依次尝试。
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
    console.log("plugin selection checks skipped: playwright 不可用");
    process.exit(0);
}

const PAGE_ONE_SPUS = ["6220828213", "5886465868", "5248761746"];
const PAGE_TWO_SPUS = ["4211980377", "3901775221"];
const SELECTED_SPUS = [PAGE_ONE_SPUS[0], PAGE_TWO_SPUS[0]];

/** 夹具只保留插件识别商品行所需的结构：表格行 + 行内复选框 + “SPU ID：数字”。 */
function fixtureHtml() {
    const rows = pageSpus => pageSpus
        .map(spu => `<tr><td><input type="checkbox" aria-label="select ${spu}"></td><td>SPU ID：${spu}</td><td>商品 ${spu}</td></tr>`)
        .join("");
    return [
        "<!doctype html>",
        '<html lang="zh"><head><meta charset="utf-8"><title>商品列表</title>',
        "<style>body{margin:0;padding:16px 460px 16px 16px;font:14px/1.6 sans-serif}table{border-collapse:collapse;width:100%}td{border:1px solid #ddd;padding:6px}</style>",
        "</head><body>",
        `<main><table><tbody id="rows">${rows(PAGE_ONE_SPUS)}</tbody></table></main>`,
        "<script>",
        `try { window.__loads = Number(localStorage.getItem("fixtureLoads") || 0) + 1; localStorage.setItem("fixtureLoads", String(window.__loads)); } catch (error) { window.__loads = 1; }`,
        `window.__page = 1;`,
        `window.__renderRows = function (spus, page) {`,
        `    window.__page = page || 1;`,
        `    document.getElementById("rows").innerHTML = spus.map(function (spu) {`,
        `        return '<tr><td><input type="checkbox" aria-label="select ' + spu + '"></td><td>SPU ID：' + spu + '</td><td>商品 ' + spu + '</td></tr>';`,
        `    }).join("");`,
        `};`,
        `window.__pageTwo = ${JSON.stringify(PAGE_TWO_SPUS)};`,
        "</script></body></html>"
    ].join("\n");
}

/** 面板是 closed Shadow DOM，CLI 只能读宿主属性；这里同样以宿主属性为插件公开状态的真值。 */
function pluginStatus(page) {
    return page.evaluate(() => {
        const panel = document.querySelector("[data-plugin-presence]");
        if (!panel) return null;
        const attribute = name => panel.getAttribute(name);
        return {
            version: attribute("data-plugin-version"),
            expectedCount: attribute("data-expected-count"),
            completedCount: attribute("data-completed-count"),
            capturePhase: attribute("data-capture-phase"),
            ingestPhase: attribute("data-ingest-phase"),
            loads: window.__loads || 0
        };
    });
}

async function waitForStatus(page, predicate, description, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = await pluginStatus(page);
        if (last && predicate(last)) return last;
        await page.waitForTimeout(150);
    }
    throw new Error(`等待插件状态超时（${description}），最后一次状态：${JSON.stringify(last)}`);
}

/**
 * closed Shadow DOM 无法用普通选择器命中，改用 CDP 穿透阴影根并按 class 定位面板按钮。
 * 命中后调用元素自身的 click()，面板注册的监听器仍会收到事件。
 */
async function clickPanelButton(client, className) {
    const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
    const found = [];
    // CDP 的 attributes 是扁平数组 [名字, 值, 名字, 值...]；attributeList 才是成对结构。
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

async function selectedSpuCheckboxes(page) {
    return page.evaluate(() => Array.from(document.querySelectorAll("table tbody tr")).map(row => ({
        spu: (row.textContent.match(/SPU\s*ID\s*[：:#]?\s*([0-9]{4,20})/) || [])[1] || null,
        checked: Boolean(row.querySelector("input[type='checkbox']")?.checked),
        // 平台隐藏了真实复选框，插件用行标记提供可见反馈，测试同时核对这条可见证据。
        marked: row.getAttribute("data-temu-selected-capture") === "1"
    })));
}

/**
 * 等待表格重绘成指定商品页，并可附加勾选恢复条件。
 * 插件扫描有 180ms 防抖，表格换页后必须等它重新映射复选框，不能在旧状态上断言。
 */
async function waitForRows(page, spus, predicate = null, timeout = 20000) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = await selectedSpuCheckboxes(page);
        const matched = last.length === spus.length && last.every((row, index) => row.spu === spus[index]);
        if (matched && (!predicate || predicate(last))) return last;
        await page.waitForTimeout(100);
    }
    throw new Error(`等待商品行超时（期望 ${spus.join(",")} 且满足勾选条件），实际：${JSON.stringify(last)}`);
}

const profileDir = mkdtempSync(path.join(os.tmpdir(), "ziniao-plugin-selection-"));
let context = null;
const problems = [];
try {
    context = await playwright.chromium.launchPersistentContext(profileDir, {
        channel: "chromium",
        headless: true,
        // 不可用代理让任何未被拦截的请求立即失败，测试进程不可能写入真实云仓或触发心跳登记。
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
        return route.abort();
    });

    const page = context.pages()[0] || await context.newPage();
    page.on("pageerror", error => problems.push(`pageerror: ${error.message}`));
    page.on("console", message => {
        if (message.type() === "error") problems.push(`console: ${message.text()}`);
    });

    await page.goto("https://agentseller.temu.com/goods/list", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });
    const client = await context.newCDPSession(page);
    // 插件完成首屏扫描后宿主属性会写出当前页商品数，用它确认面板已进入可交互状态。
    const firstScan = await waitForStatus(page, status => status.expectedCount === String(PAGE_ONE_SPUS.length), "首屏统计完成");
    assert.equal(firstScan.capturePhase, "未启动", `未点击前不应在采集：${JSON.stringify(firstScan)}`);

    // 普通采集必须锁定点击时的当前分页，不能通过刷新回到第一页。
    const loadsBeforeCurrentPage = await page.evaluate(() => window.__loads || 0);
    await page.evaluate(() => window.__renderRows(window.__pageTwo, 2));
    await waitForRows(page, PAGE_TWO_SPUS);
    await clickPanelButton(client, "start");
    const currentPageCapture = await waitForStatus(
        page,
        status => status.expectedCount === String(PAGE_TWO_SPUS.length),
        "第二页普通采集"
    );
    assert.equal(
        await page.evaluate(() => window.__loads || 0),
        loadsBeforeCurrentPage,
        "采集当前页不应刷新页面"
    );
    assert.equal(currentPageCapture.capturePhase, "待人工确认", "夹具缺少 SKC 时应在删除状态核验处停止");

    // 回到干净页面后继续验证跨页勾选；不能用普通采集留下的待确认状态启动选择性采集。
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });
    await waitForStatus(page, status => status.expectedCount === String(PAGE_ONE_SPUS.length), "重载后的第一页统计");

    // 第一页勾选第 1 件商品。
    await page.locator("table tbody tr").first().locator("input[type='checkbox']").click();
    assert.deepEqual(
        (await selectedSpuCheckboxes(page)).map(row => row.checked),
        [true, false, false],
        "第一页只应勾选第 1 件商品"
    );

    // 翻到第二页再勾选第 1 件商品；第一页的选择必须保留在选择清单里。
    await page.evaluate(() => window.__renderRows(window.__pageTwo, 2));
    await page.locator("table tbody tr").first().locator("input[type='checkbox']").click();
    assert.deepEqual(
        (await selectedSpuCheckboxes(page)).map(row => row.checked),
        [true, false],
        "第二页只应勾选第 1 件商品"
    );

    const loadsBeforeSelected = await page.evaluate(() => window.__loads || 0);
    // 触发选择性采集：插件会写入选择清单开关并刷新页面。
    await clickPanelButton(client, "start-selected");
    await page.waitForFunction(loads => (window.__loads || 0) > loads, loadsBeforeSelected, { timeout: 30000 });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });

    // 刷新后采集范围必须来自选择清单（2 件），而不是刷新后第一页的 3 件。
    const afterReload = await waitForStatus(page, status => status.expectedCount === String(SELECTED_SPUS.length), "刷新后恢复锁定勾选清单");
    assert.equal(afterReload.loads, loadsBeforeSelected + 1, "选择性采集应刷新一次页面");

    // 刷新回第一页后，已锁定的商品必须重新显示为勾选，未勾选商品不能被误勾。
    const rows = await waitForRows(page, PAGE_ONE_SPUS, list => list[0].checked);
    assert.equal(rows[0].checked, true, `${SELECTED_SPUS[0]} 刷新后应恢复勾选`);
    assert.equal(rows[1].checked, false, `${PAGE_ONE_SPUS[1]} 未被选择，不应被勾选`);
    assert.equal(rows[2].checked, false, `${PAGE_ONE_SPUS[2]} 未被选择，不应被勾选`);
    assert.deepEqual(rows.map(row => row.marked), [true, false, false], "刷新后只有锁定商品带可见锁定标记");

    // 采集进行中再翻到第二页：锁定的第二页商品重新出现时也必须恢复勾选，证明清单按 SPU 保存而不是按页码保存。
    await page.evaluate(() => window.__renderRows(window.__pageTwo, 2));
    const pageTwoRows = await waitForRows(page, PAGE_TWO_SPUS, list => list[0].checked);
    assert.equal(pageTwoRows[0].checked, true, `${SELECTED_SPUS[1]} 重新出现时应恢复勾选`);
    assert.equal(pageTwoRows[1].checked, false, `${PAGE_TWO_SPUS[1]} 未被选择，不应被勾选`);
    assert.deepEqual(pageTwoRows.map(row => row.marked), [true, false], "第二页只有锁定商品带可见锁定标记");
    assert.equal((await pluginStatus(page)).expectedCount, "2", "翻页不应改变锁定的采集范围");

    // 结束后停止本次采集，避免夹具环境下继续空转到超时。
    await clickPanelButton(client, "stop").catch(() => {});

    const fatal = problems.filter(message => !/favicon|ERR_ABORTED|ERR_PROXY|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::/i.test(message));
    assert.deepEqual(fatal, [], `页面脚本不应报错：${fatal.join(" | ")}`);

    console.log(JSON.stringify({
        result: "selected capture survives pagination and reload",
        version: manifest.version,
        selectedSpus: SELECTED_SPUS,
        pageAfterReload: rows
    }));
} finally {
    if (context) await context.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
}
