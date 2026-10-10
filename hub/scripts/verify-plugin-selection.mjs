/**
 * 在真实 Chromium 中加载未打包插件，核对实时勾选、固定批次及失败/刷新后的选择行为。
 * 夹具通过路由拦截伪造商品列表，且整机网络指向不可用代理，因此不会访问真实 Temu、不会入库、不会登记心跳。
 * 缺少 playwright 时跳过，不阻断其他验证。
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptsDir);
const pluginDir = path.resolve(rootDir, "..", "plugin");
const manifest = JSON.parse(readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));
const screenshotDir = path.resolve(rootDir, "..", "output", "playwright");

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
        `<main><table><thead><tr><th><input id="select-all" type="checkbox" aria-label="全选"></th></tr></thead><tbody id="rows">${rows(PAGE_ONE_SPUS)}</tbody></table><div class="ant-pagination"><span class="ant-pagination-item-active" id="page-number">1</span></div></main>`,
        "<script>",
        `try { window.__loads = Number(localStorage.getItem("fixtureLoads") || 0) + 1; localStorage.setItem("fixtureLoads", String(window.__loads)); } catch (error) { window.__loads = 1; }`,
        `window.__page = 1;`,
        `window.__renderRows = function (spus, page) {`,
        `    window.__page = page || 1;`,
        `    document.getElementById("page-number").textContent = String(window.__page);`,
        `    document.getElementById("rows").innerHTML = spus.map(function (spu) {`,
        `        return '<tr><td><input type="checkbox" aria-label="select ' + spu + '"></td><td>SPU ID：' + spu + '</td><td>商品 ' + spu + '</td></tr>';`,
        `    }).join("");`,
        `};`,
        `window.__pageTwo = ${JSON.stringify(PAGE_TWO_SPUS)};`,
        `document.getElementById('select-all').addEventListener('change', event => document.querySelectorAll('#rows input').forEach(input => { input.checked = event.target.checked; }));`,
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
            selectedCount: attribute("data-selected-count"),
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
        // 新逻辑不能用锁定行标记把当前选择伪装成任务范围。
        marked: row.getAttribute("data-temu-selected-capture") === "1"
    })));
}

/**
 * 等待表格重绘成指定商品页；选择同步与扫描有防抖，不能在旧状态上断言。
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

    // 回到干净页面验证选择性采集；刷新只使用当前原生勾选，不恢复历史清单。
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

    await waitForStatus(page, status => status.selectedCount === "1", "首次实时勾选");
    const loadsBeforeSelected = await page.evaluate(() => window.__loads || 0);
    // 夹具缺 SKC 会停止；失败后的修改仍只影响当前选择，不得改旧批次或强制勾回。
    await clickPanelButton(client, "start-selected");
    await waitForStatus(page, status => status.expectedCount === "1" && status.capturePhase === "待人工确认", "选择批次失败保留快照");
    assert.equal(await page.evaluate(() => window.__loads), loadsBeforeSelected, "选择性采集不能刷新页面");
    await page.locator("table tbody tr").first().locator("input[type='checkbox']").uncheck();
    await waitForStatus(page, status => status.selectedCount === "0", "失败后实时取消选择");
    assert.equal((await pluginStatus(page)).expectedCount, "1", "取消选择不能改旧批次");
    await page.waitForTimeout(700);
    assert.deepEqual((await selectedSpuCheckboxes(page)).map(row => row.checked), [false, false, false]);
    await page.locator("#select-all").check();
    await waitForStatus(page, status => status.selectedCount === "3", "表头全选");
    assert.equal((await pluginStatus(page)).expectedCount, "1");
    await page.locator("#select-all").uncheck();
    await waitForStatus(page, status => status.selectedCount === "0", "表头取消全选");
    // 模拟受控组件只改属性、不发送 change；轮询仍须同步数量。
    await page.evaluate(() => { document.querySelector('#rows input').checked = true; });
    await waitForStatus(page, status => status.selectedCount === "1", "无事件勾选同步");
    const rows = await selectedSpuCheckboxes(page);
    assert.ok(rows.every(row => !row.marked), "插件不得伪造旧锁定标记");
    // 真实切页必须隔离原选择与 SKC；下一页的原生选择由页面决定。
    await page.evaluate(() => window.__renderRows(window.__pageTwo, 2));
    await waitForStatus(page, status => status.selectedCount === "0" && status.expectedCount === "2", "切页隔离");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForStatus(page, status => status.selectedCount === "0" && status.expectedCount === "3", "刷新只读当前选择");
    assert.deepEqual((await selectedSpuCheckboxes(page)).map(row => row.checked), [false, false, false]);

    // 原始页面刚刷新没有勾选；注入离线客户端并挂起删除核验，验证真正运行中也不改范围。
    await page.evaluate(() => {
        document.querySelectorAll("#rows tr").forEach((row, index) => {
            row.lastElementChild.textContent += ` SKC ID：${9000000000 + index}`;
        });
        function factory() { return ".postWithoutMallId= .mallIdClient= getMallIdAsync"; }
        const runtime = () => ({ mallIdClient: { getMallIdAsync: async () => "999000000000001" },
            post: async (url, input) => {
                window.__removalInput = input;
                return new Promise(resolve => { window.__finishRemoval = () => resolve({ success: false, errorCode: 1234 }); });
            } });
        runtime.m = { 4242: factory };
        const chunks = [];
        chunks.push = entry => { entry[2](runtime); return 1; };
        window.chunkLoadingGlobal_temu_sca_goods = chunks;
    });
    await page.locator("#rows input").nth(0).check();
    await page.locator("#rows input").nth(1).check();
    await waitForStatus(page, status => status.selectedCount === "2", "运行前选择两件");
    await clickPanelButton(client, "start-selected");
    await page.waitForFunction(() => typeof window.__finishRemoval === "function");
    assert.equal((await pluginStatus(page)).expectedCount, "2");
    await page.locator("#rows input").nth(0).uncheck();
    await page.locator("#rows input").nth(1).uncheck();
    await page.locator("#rows input").nth(2).check();
    await waitForStatus(page, status => status.selectedCount === "1" && status.expectedCount === "2", "运行中当前选择一件而批次两件");
    assert.deepEqual(await page.evaluate(() => window.__removalInput.productSkcIds), ["9000000000", "9000000001"]);
    mkdirSync(screenshotDir, { recursive: true });
    for (const [name, viewport] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 375, height: 800 }]]) {
        await page.setViewportSize(viewport);
        await page.screenshot({ path: path.join(screenshotDir, `selection-snapshot-${name}.png`) });
    }
    await page.evaluate(() => window.__finishRemoval());
    await waitForStatus(page, status => status.capturePhase === "待人工确认" && status.selectedCount === "1" && status.expectedCount === "2", "核验失败仍分离选择与批次");

    // 结束后停止本次采集，避免夹具环境下继续空转到超时。
    await clickPanelButton(client, "stop").catch(() => {});

    const fatal = problems.filter(message => !/favicon|ERR_ABORTED|ERR_PROXY|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|net::/i.test(message));
    assert.deepEqual(fatal, [], `页面脚本不应报错：${fatal.join(" | ")}`);

    console.log(JSON.stringify({
        result: "live selection is separate from fixed capture snapshot",
        version: manifest.version,
        fixedSpus: [PAGE_ONE_SPUS[0]],
        realtimeRows: rows,
        runningSnapshotVerified: true,
        realPlatformCalls: 0
    }));
} finally {
    if (context) await context.close().catch(() => {});
    // 递归清理只允许本脚本刚创建的系统临时目录，不能跨出约定父目录。
    assert.equal(path.dirname(path.resolve(profileDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(profileDir).startsWith("ziniao-plugin-selection-"));
    rmSync(profileDir, { recursive: true, force: true });
}
