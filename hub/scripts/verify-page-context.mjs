/**
 * 核对列表上下文：虚拟滚动不能重置，分页/筛选控件变化才清空已见 SPU。
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const context = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../plugin/page-context.js"));

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const pathKey = "https://agentseller.temu.com/goods/list";
const samePage = context.composePageContextKey({
    path: pathKey,
    labels: "全部",
    filter: "",
    list: "1|20 条/页"
});
const scrolled = context.composePageContextKey({
    path: pathKey,
    labels: "全部",
    filter: "",
    list: "1|20 条/页"
});
const loading = context.composePageContextKey({
    path: pathKey,
    labels: "全部",
    filter: "",
    list: ""
});
const pageTwo = context.composePageContextKey({
    path: pathKey,
    labels: "全部",
    filter: "",
    list: "2|20 条/页"
});
const filtered = context.composePageContextKey({
    path: pathKey,
    labels: "全部",
    filter: "status=draft",
    list: "1|20 条/页"
});

assert(samePage === scrolled, "相同分页指纹被当成不同列表");
assert(context.isGenuineListContextChange(samePage, scrolled) === false, "虚拟滚动被误判为切页");
assert(context.isGenuineListContextChange(samePage, loading) === false, "分页控件短暂消失被误判为切页");
assert(context.isGenuineListContextChange(samePage, pageTwo) === true, "翻页没有重置商品集合");
assert(context.isGenuineListContextChange(samePage, filtered) === true, "筛选条件变化没有重置商品集合");

const hashFiltered = context.collectStableFilterParams("", "#/goods/list?status=draft");
assert(hashFiltered === "status=draft", "Hash 查询没有进入筛选键");
const emptyFilter = context.composePageContextKey({
    path: pathKey,
    labels: "全部",
    filter: "",
    list: "1|20 条/页"
});
assert(context.isGenuineListContextChange(filtered, emptyFilter) === false, "筛选指纹暂时变空被误判为切页");
assert(context.isGenuineListContextChange(emptyFilter, filtered) === true, "从空筛选变成真实筛选没有重置");
assert(context.isStaleRequest(1000, 2000) === true, "切页前发出的请求没有被判为过期");
assert(context.isStaleRequest(3000, 2000) === false, "当前页请求被误判为过期");
assert(context.isStaleRequest(1000, 0) === false, "首屏未建立上下文时把请求判成过期");

const hydrating = context.composePageContextKey({
    path: pathKey,
    labels: "",
    filter: "",
    list: "1|20 条/页"
});
assert(context.isGenuineListContextChange(hydrating, samePage) === false, "页签从空变成全部被误判为切页");

console.log("page context checks passed");
