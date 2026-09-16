/**
 * 在真实 Chromium 中加载未打包插件，核对面板壳层的三个状态：
 * 折叠（只留采集区）、展开（工具区可见，含导出操作日志）、贴边小球。
 * 夹具整机指向不可用代理，因此不会访问真实 Temu、不会入库、不会登记心跳。
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
    console.log("plugin panel shell checks skipped: playwright 不可用");
    process.exit(0);
}

/**
 * 夹具只需要插件识别为商品列表页；面板壳层不依赖真实商品数据。
 * 假运行时只实现“店铺身份探测”用到的客户端特征，不实现任何商品接口，因此停止按钮之外不会有真实写入。
 */
// 假运行时返回的商城ID同时决定任务与停止标记的归属键，测试各处必须引用同一常量，避免夹具和断言各写一份数字。
// 刻意使用合成的商城ID和店名：夹具万一联网也不能落到任何真实店铺名下。
const FIXTURE_MALL_ID = "999000000000001";
const FIXTURE_STORE_ID = `temu:${FIXTURE_MALL_ID}`;
const FIXTURE_STORE_NAME = "自动化测试店铺";

function fixtureHtml() {
    return [
        "<!doctype html>",
        '<html lang="zh"><head><meta charset="utf-8"><title>商品列表</title></head><body>',
        `<header><span class="shop-name">${FIXTURE_STORE_NAME}</span></header>`,
        '<main><table><tbody><tr><td><input type="checkbox" aria-label="select 6220828213"></td><td>SPU ID：6220828213</td></tr></tbody></table></main>',
        "<script>",
        "(function () {",
        "  function fakeClientModule() { return '.postWithoutMallId= .mallIdClient= getMallIdAsync'; }",
        `  const runtime = function () { return { mallIdClient: { getMallIdAsync: async () => '${FIXTURE_MALL_ID}' } }; };`,
        "  runtime.m = { 4242: fakeClientModule };",
        "  const chunks = [];",
        "  const nativePush = Array.prototype.push;",
        "  chunks.push = function (entry) { if (entry && typeof entry[2] === 'function') entry[2](runtime); return nativePush.call(this, entry); };",
        "  window.chunkLoadingGlobal_temu_sca_goods = chunks;",
        "}());",
        "</script>",
        "</body></html>"
    ].join("\n");
}

/** 扩展后台在 MV3 下是 Service Worker，只有它能直接读写 chrome.storage，面板断言因此以它为准。 */
async function backgroundWorker(context) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        const worker = context.serviceWorkers().find(entry => entry.url().includes("background.js"));
        if (worker) return worker;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("未找到扩展后台 Service Worker，无法核对停止标记的落盘状态");
}

/**
 * 面板只在“本页已映射到商城店铺”后才展示待办与停止状态，映射来自中转仓登记。
 * 夹具的代理不可用、登记必然失败，所以直接写入同一份绑定，让刷新后的停止态可以被断言。
 */
async function seedBoundStore(context) {
    const worker = await backgroundWorker(context);
    return worker.evaluate(async binding => {
        await chrome.storage.local.set({ boundStoreV1: binding });
        return Object.keys(await chrome.storage.local.get(null));
    }, { storeId: FIXTURE_STORE_ID, storeName: FIXTURE_STORE_NAME });
}

/** 逐店停止标记的落盘键。刷新后仍存在，才说明“刷新页面不再自动继续上传”是真的。 */
async function pauseKeys(context) {
    const worker = await backgroundWorker(context);
    return worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)).filter(key => key.startsWith("directPause:")));
}

/** 面板是 closed Shadow DOM，普通选择器无法命中；统一用 CDP 穿透阴影根取节点。 */
async function shadowNodes(client) {
    const { root } = await client.send("DOM.getDocument", { depth: -1, pierce: true });
    const collected = [];
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
        collected.push({ nodeId: node.nodeId, name: node.nodeName, className: classNameOf(node) });
        (node.children || []).forEach(walk);
        (node.shadowRoots || []).forEach(walk);
    })(root);
    return collected;
}

/**
 * 面板内同类元素必须唯一，否则断言读到的可能是别的按钮。
 * CDP 的 nodeId 只在同一次 DOM.getDocument 快照内有效，因此调用方必须复用同一份快照。
 */
function uniqueNodeId(nodes, className) {
    const matched = nodes.filter(node => node.className.split(/\s+/).includes(className));
    assert.equal(matched.length, 1, `面板中应恰好有一个 .${className}，实际 ${matched.length} 个`);
    return matched[0].nodeId;
}

/** 现取一份快照再点按钮，避免复用已被后续快照作废的 nodeId。 */
async function clickPanelNode(client, className) {
    await clickNode(client, uniqueNodeId(await shadowNodes(client), className));
}

async function clickNode(client, nodeId) {
    const { object } = await client.send("DOM.resolveNode", { nodeId });
    await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: "function () { this.click(); }",
        returnByValue: true
    });
}

/**
 * 在面板根节点上一次性读出全部断言值。
 * 面板渲染由消息往返驱动，分多次 CDP 往返取数会读到不同渲染批次的状态（曾出现按钮文案已更新、可见性还是上一帧），
 * 因此这里必须单次取数，保证同一帧内自洽。
 */
async function panelSnapshot(client, expression) {
    const panel = uniqueNodeId(await shadowNodes(client), "panel");
    const { object } = await client.send("DOM.resolveNode", { nodeId: panel });
    const { result } = await client.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function () { ${expression} }`,
        returnByValue: true
    });
    assert.ok(result.value, "面板快照应返回对象");
    return result.value;
}

/** 面板壳层的可断言状态：折叠/小球类名、真实宽度、按钮文案与工具区可见性。 */
async function panelState(client) {
    return panelSnapshot(client, `
        const toggle = this.querySelector('.toggle');
        const mini = this.querySelector('.mini');
        const tools = this.querySelector('.tools');
        const logs = this.querySelector('.logs');
        return {
            collapsed: this.classList.contains('collapsed'),
            compact: this.classList.contains('compact'),
            width: Math.round(this.getBoundingClientRect().width),
            toggleText: toggle ? toggle.textContent.trim() : '',
            toggleTitle: toggle ? toggle.title : '',
            miniVisible: Boolean(mini && mini.getClientRects().length),
            toolsVisible: Boolean(tools && tools.getClientRects().length),
            logsVisible: Boolean(logs && logs.getClientRects().length)
        };
    `);
}

/**
 * 停止接口创建按钮的真实状态。
 * 判定依据必须是渲染结果而不是按钮是否存在：按钮一直在 DOM 里，未识别到本店任务时靠 hidden 收敛，
 * 因此这里同时读它的可见性、文案，以及进度块的暂停配色和标题栏阶段文案是否一致。
 */
async function stopButtonState(client) {
    const snapshot = await panelSnapshot(client, `
        const button = this.querySelector('.transfer-pause');
        const progress = this.querySelector('.transfer-progress');
        const headStage = this.querySelector('.head-stage');
        const message = this.querySelector('.message');
        return {
            visible: Boolean(button && button.getClientRects().length),
            text: button ? button.textContent.trim() : '',
            disabled: Boolean(button && button.disabled),
            progressVisible: Boolean(progress && progress.getClientRects().length),
            progressPaused: Boolean(progress && progress.classList.contains('paused')),
            headStage: headStage ? headStage.textContent.trim() : '',
            message: message ? message.textContent.trim() : ''
        };
    `);
    assert.ok(snapshot.text, "面板中应存在 .transfer-pause 停止按钮");
    return snapshot;
}

/** 面板渲染是消息往返后的结果，断言前先等到期望文案，避免用固定 sleep 猜延迟。 */
async function waitForStopText(client, expected, timeout = 15000) {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() < deadline) {
        last = await stopButtonState(client);
        if (last.text === expected) return last;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`停止按钮未在 ${timeout}ms 内变成「${expected}」，最后状态 ${JSON.stringify(last)}`);
}

const profileDir = mkdtempSync(path.join(os.tmpdir(), "ziniao-panel-shell-"));
let context = null;
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
    await page.goto("https://agentseller.temu.com/goods/list", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });
    const client = await context.newCDPSession(page);
    // 先补齐店铺映射再断言：停止状态与待办都按商城店铺归属，没有映射时面板按设计不展示这些内容。
    assert.ok((await seedBoundStore(context)).includes("boundStoreV1"), "店铺绑定未写入扩展存储");

    // 初始必须停在折叠态：只显示采集区，工具区含导出操作日志在内的按钮都不可见。
    const initial = await panelState(client);
    assert.equal(initial.collapsed, true, `初始应折叠，实际 ${JSON.stringify(initial)}`);
    assert.equal(initial.compact, false, `初始不应是小球，实际 ${JSON.stringify(initial)}`);
    assert.equal(initial.toolsVisible, false, "折叠时工具区不应可见");
    assert.equal(initial.logsVisible, false, "折叠时导出操作日志不应可见");
    assert.equal(initial.toggleText, "展开", `折叠态按钮文案应为展开，实际 ${initial.toggleText}`);
    assert.equal(initial.miniVisible, true, "折叠态应能看到收缩为小球的入口");

    // 关键回归：点的必须是“展开工具”，而不是把整块面板收缩成小球。
    await clickPanelNode(client, "toggle");
    const expanded = await panelState(client);
    assert.equal(expanded.collapsed, false, `点展开后应展开，实际 ${JSON.stringify(expanded)}`);
    assert.equal(expanded.compact, false, "展开工具不应顺带进入小球态");
    assert.equal(expanded.toolsVisible, true, "展开后工具区必须可见");
    assert.equal(expanded.logsVisible, true, "展开后必须能点到导出操作日志");
    assert.equal(expanded.toggleText, "收起", `展开态按钮文案应为收起，实际 ${expanded.toggleText}`);

    // 再点一次只收回工具区，运行状态仍留在主面板。
    await clickPanelNode(client, "toggle");
    const recollapsed = await panelState(client);
    assert.equal(recollapsed.collapsed, true, "再点一次应收回工具区");
    assert.equal(recollapsed.compact, false, "收回工具区不等于收缩为小球");

    // 收缩为小球：贴边、只留箭头，并隐藏收缩入口自身。
    await clickPanelNode(client, "mini");
    const compact = await panelState(client);
    assert.equal(compact.compact, true, `点收缩后应是小球，实际 ${JSON.stringify(compact)}`);
    assert.ok(compact.width <= 44, `小球宽度应贴近 42px，实际 ${compact.width}`);
    assert.equal(compact.miniVisible, false, "小球态不应再显示收缩入口");
    assert.ok(["‹", "›"].includes(compact.toggleText), `小球只应保留方向箭头，实际 ${compact.toggleText}`);
    assert.equal(compact.logsVisible, false, "小球态不应显示工具区按钮");

    // 点小球还原：回到收缩前的折叠态，宽度和文案都要恢复。
    await clickPanelNode(client, "toggle");
    const restored = await panelState(client);
    assert.equal(restored.compact, false, "点小球应退出小球态");
    assert.equal(restored.collapsed, true, "点小球应回到收缩前的折叠态");
    assert.ok(restored.width > 300, `还原后应恢复完整面板宽度，实际 ${restored.width}`);
    assert.equal(restored.toggleText, "展开", `还原后按钮文案应为展开，实际 ${restored.toggleText}`);
    assert.equal(restored.miniVisible, true, "还原后应重新显示收缩入口");

    // 停止接口创建按钮：没有本店待办时不应占位，否则面板长期挂一个点了没反应的按钮。
    const idle = await stopButtonState(client);
    assert.equal(idle.visible, false, `无本店任务时停止按钮不应可见，实际 ${JSON.stringify(idle)}`);
    assert.equal(idle.text, "停止接口创建", `无任务时按钮文案应为停止接口创建，实际 ${idle.text}`);
    assert.equal(idle.disabled, false, "无任务时按钮不应被禁用，否则后台恢复后点不动");
    assert.deepEqual(await pauseKeys(context), [], "初始不应存在任何停止标记");

    /*
     * 真实走一遍停止链路：面板按钮 → 内容脚本 → 扩展后台身份核验并落盘。
     * 面板在折叠态也必须能点到这个按钮，所以这一步刻意不展开工具区。
     */
    await clickPanelNode(client, "transfer-pause");
    const stopped = await waitForStopText(client, "继续接口创建");
    assert.equal(stopped.visible, true, `停止后按钮必须可见，实际 ${JSON.stringify(stopped)}`);
    assert.equal(stopped.progressVisible, true, "停止后进度块必须可见，操作者要能看到处于停止状态");
    assert.equal(stopped.progressPaused, true, "停止后进度块应切换为暂停配色");
    assert.equal(stopped.headStage, "已停止接口创建", `标题栏应显示已停止，实际 ${stopped.headStage}`);
    // 停止必须落到扩展存储：只有内存标记的话，刷新页面就会重新开始上传。
    assert.deepEqual(await pauseKeys(context), [`directPause:${FIXTURE_STORE_ID}`], "停止后应在扩展存储中留下本店停止标记");

    // 用户反馈的核心问题：刷新页面后自动上传还在继续。停止标记必须落盘，刷新后仍然是停止态。
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(version => Boolean(document.querySelector(`[data-plugin-version="${version}"]`)), manifest.version, { timeout: 20000 });
    const afterReload = await waitForStopText(client, "继续接口创建");
    assert.equal(afterReload.text, "继续接口创建", `刷新后必须仍是停止态，实际 ${JSON.stringify(afterReload)}`);
    assert.equal(afterReload.visible, true, "刷新后停止态按钮必须可见");
    assert.equal(afterReload.progressPaused, true, "刷新后进度块应保持暂停配色");
    assert.equal(afterReload.headStage, "已停止接口创建", `刷新后标题栏应仍显示已停止，实际 ${afterReload.headStage}`);
    assert.deepEqual(await pauseKeys(context), [`directPause:${FIXTURE_STORE_ID}`], "刷新后停止标记必须仍然存在");

    // 恢复：同一个按钮再点一次，后台清标记并把本店待办重新纳入自动创建。
    await clickPanelNode(client, "transfer-pause");
    const resumed = await waitForStopText(client, "停止接口创建");
    assert.equal(resumed.progressPaused, false, "恢复后进度块不应再有暂停配色");
    assert.equal(resumed.visible, false, "恢复且无待办后按钮应收起，不占面板位置");
    assert.deepEqual(await pauseKeys(context), [], "恢复后必须清除本店停止标记");

    console.log(JSON.stringify({
        result: "panel shell toggles tools and compacts independently",
        version: manifest.version,
        initial,
        expanded,
        compact,
        restored,
        stop: { idle, stopped, afterReload, resumed }
    }));
} finally {
    if (context) await context.close().catch(() => {});
    rmSync(profileDir, { recursive: true, force: true });
}
