/**
 * 核对工人读取已打开店铺时的身份规则：页头短名可以对上紫鸟长名，短词不能通过，没有插件不能写成身份已核验。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_INSPECT_SCRIPT, evaluateStoreIdentity, hasRequiredPlugin, parseInspectPayload } from "../lib/page-identity.mjs";

const hair = evaluateStoreIdentity({
    expectedName: "Hair removal wax-全托-若欧",
    pageStoreName: "",
    snippet: "Beta 服务市场 Hair removal wax 新建商品",
    url: "https://agentseller.temu.com/goods/create/category",
    pluginDetected: true,
    pluginVersion: "10.1.0"
});
assert.equal(hair.identityMatched, true);
assert.equal(hair.pluginDetected, true);

const city = evaluateStoreIdentity({
    expectedName: "City Beauty King-HAOSHI",
    pageStoreName: "",
    snippet: "欢迎来到Seller central全球 City Beauty King 首页",
    url: "https://agentseller.temu.com/",
    pluginDetected: true
});
assert.equal(city.identityMatched, true);

const missingPlugin = evaluateStoreIdentity({
    expectedName: "City Beauty King-HAOSHI",
    snippet: "City Beauty King 首页",
    url: "https://agentseller.temu.com/",
    pluginDetected: false
});
assert.equal(missingPlugin.identityMatched, true);
assert.equal(missingPlugin.pluginDetected, false);
assert.match(missingPlugin.reason, /未检测到.*中转插件/);

const legacyPanel = evaluateStoreIdentity({
    expectedName: "City Beauty King-HAOSHI",
    snippet: "City Beauty King 首页",
    url: "https://agentseller.temu.com/",
    pluginPanelPresent: true,
    pluginDetected: false,
    pluginVersion: ""
});
assert.equal(legacyPanel.pluginDetected, false);
assert.match(legacyPanel.reason, /旧版或不兼容/);

const shortName = evaluateStoreIdentity({
    expectedName: "City Beauty King-HAOSHI",
    snippet: "City 欢迎",
    url: "https://agentseller.temu.com/",
    pluginDetected: true
});
assert.equal(shortName.identityMatched, false);

const parsed = parseInspectPayload({
    data: {
        data: {
            result: JSON.stringify({
                url: "https://agentseller.temu.com/goods/list",
                pluginPanelPresent: true,
                pluginPresence: "temu-local-capture",
                pluginDetected: true,
                pluginVersion: "10.1.0",
                pluginInstanceId: "plugin-instance-1",
                snippet: "Hair removal wax"
            })
        }
    }
});
assert.equal(parsed.pluginDetected, true);
assert.equal(parsed.pluginVersion, "10.1.0");
assert.equal(parsed.pluginInstanceId, "plugin-instance-1");
assert.equal(hasRequiredPlugin("temu-local-capture", "10.0.0"), false);
assert.equal(hasRequiredPlugin("temu-local-capture", "10.0.1"), false);
assert.equal(hasRequiredPlugin("temu-local-capture", "10.0.2"), false);
assert.equal(hasRequiredPlugin("temu-local-capture", "10.0.3"), false);
assert.equal(hasRequiredPlugin("temu-local-capture", "10.1.0"), true);
assert.equal(hasRequiredPlugin("", "10.0.0"), false);
assert.equal(hasRequiredPlugin("temu-local-capture", "9.8.3"), false);
assert.equal(parseInspectPayload({ pluginDetected: true, pluginVersion: "10.1.0" }).pluginDetected, false);
assert.equal(parseInspectPayload({
    pluginPresence: "temu-local-capture",
    pluginDetected: true,
    pluginVersion: "10.0.3"
}).pluginDetected, false);

/** 页面脚本脱离 Node 运行，仍用最小 DOM 模拟执行一次，防止字符串转义把 10.x 正则写坏。 */
const previousDocument = globalThis.document;
const previousLocation = globalThis.location;
globalThis.document = {
    title: "店铺测试",
    body: { innerText: "Hair removal wax" },
    getElementById(id) {
        if (id !== "temu-local-dataset-panel") return null;
        return {
            getAttribute(name) {
                return {
                    "data-plugin-presence": "temu-local-capture",
                    "data-plugin-version": "10.1.0",
                    "data-plugin-instance-id": "plugin-instance-1",
                    "data-bound-store-id": "27751811499835",
                    "data-bound-store-name": "Hair removal wax-全托-若欧",
                    "data-mapped-store-id": "27751811499835",
                    "data-mapped-store-name": "Hair removal wax-全托-若欧",
                    "data-page-store-name": "Hair removal wax",
                    "data-page-type": "goods-list"
                }[name] || "";
            }
        };
    }
};
globalThis.location = { href: "https://agentseller.temu.com/goods/list" };
const liveScriptResult = JSON.parse(eval(PAGE_INSPECT_SCRIPT));
if (previousDocument === undefined) delete globalThis.document;
else globalThis.document = previousDocument;
if (previousLocation === undefined) delete globalThis.location;
else globalThis.location = previousLocation;
assert.equal(liveScriptResult.pluginDetected, true);
assert.equal(liveScriptResult.pluginVersion, "10.1.0");
assert.equal(liveScriptResult.pluginInstanceId, "plugin-instance-1");

/** 页面检查脚本必须自己拒绝 10.0.x，不能把旧面板的 pluginDetected 交给工人再二次过滤。 */
globalThis.document = {
    title: "店铺测试",
    body: { innerText: "Hair removal wax" },
    getElementById(id) {
        if (id !== "temu-local-dataset-panel") return null;
        return {
            getAttribute(name) {
                return {
                    "data-plugin-presence": "temu-local-capture",
                    "data-plugin-version": "10.0.3",
                    "data-plugin-instance-id": "",
                    "data-page-store-name": "Hair removal wax"
                }[name] || "";
            }
        };
    }
};
globalThis.location = { href: "https://agentseller.temu.com/goods/list" };
const staleScriptResult = JSON.parse(eval(PAGE_INSPECT_SCRIPT));
if (previousDocument === undefined) delete globalThis.document;
else globalThis.document = previousDocument;
if (previousLocation === undefined) delete globalThis.location;
else globalThis.location = previousLocation;
assert.equal(staleScriptResult.pluginDetected, false);
assert.equal(staleScriptResult.pluginVersion, "10.0.3");
assert.equal(staleScriptResult.pluginPanelPresent, true);

/** 两个隔离世界无法直接共享常量，因此发布前从源码核对页面钩子与内容脚本的事件协议一致。 */
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginDirectory = path.resolve(scriptDirectory, "../../plugin");
const [contentAppSource, pageHookSource, backgroundSource] = await Promise.all([
    readFile(path.join(pluginDirectory, "content-app.js"), "utf8"),
    readFile(path.join(pluginDirectory, "page-hook.js"), "utf8"),
    readFile(path.join(pluginDirectory, "background.js"), "utf8")
]);
assert.match(contentAppSource, /SOURCE = "temu-shop-transfer-v10"/);
assert.match(pageHookSource, /SOURCE = "temu-shop-transfer-v10"/);
assert.match(pageHookSource, /HOOK_MARKER = "__temuShopTransferV10HookInstalled__"/);
assert.match(contentAppSource, /pluginVersion: PLUGIN_VERSION/);
assert.match(backgroundSource, /pluginVersion: String\(payload\.pluginVersion \|\| chrome\.runtime\.getManifest\(\)\.version\)/);

console.log("page identity checks passed");
