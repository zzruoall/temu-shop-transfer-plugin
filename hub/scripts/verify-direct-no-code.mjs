/**
 * 锁定“货号只用于判重、不是上传前提”这条规则：
 * 有商品货号按商品货号比、只有 SKU 货号按 SKU 货号比；两者都没有时不提前阻断，
 * 按“未发现重复”继续真实上传，由平台决定能否创建。
 * 用假页面驱动真实的 direct-executor.js，不联网、不产生任何创建请求。
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../plugin/direct-executor.js", import.meta.url), "utf8");

/** 构造一次判重注入环境：记录页面侧真正发出的查询请求，用于确认“有没有提前阻断”。 */
async function runDuplicateCheck(payload) {
    const queries = [];
    const client = {
        mallIdClient: { getMallIdAsync: async () => "123" },
        post: async (path, body) => {
            queries.push({ path, body });
            // 空页作为分页终止条件；同时证明无货号路径不会拿名称或 SPU 去猜同款。
            return { result: { pageItems: [], total: 0 } };
        }
    };
    const runtime = () => client;
    runtime.m = { only: "getMallIdAsync .postWithoutMallId= .mallIdClient=" };
    const context = vm.createContext({
        console, crypto, Set, Map, String, Number, Object, Array, JSON, Error, Promise, setTimeout,
        location: { origin: "https://agentseller.temu.com", pathname: "/goods/list" },
        window: { chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } },
        chrome: {
            scripting: { executeScript: async spec => [{ result: await spec.func(...spec.args) }] },
            tabs: { get: async () => ({ url: "https://agentseller.temu.com/goods/list" }) }
        }
    });
    vm.runInContext(source, context);
    context.__payload = payload;
    // 测试版可能开启“跳过判重”开关；这里验证的是判重本身的行为，
    // 因此显式走 force 真实检索路径，保证正式逻辑始终被测到。
    return { result: await vm.runInContext("directDuplicateCheck(9, __payload, { force: true })", context), queries };
}

// 一、商品货号与 SKU 货号都为空：不能提前阻断，必须继续上传。
{
    const { result, queries } = await runDuplicateCheck({ mallId: "123", productCodes: [], skuCodes: [], compareMode: "none" });
    assert.equal(result.state, "not_found", "商品没有货号时不能阻断上传");
    assert.equal(result.queryMode, "no_code", "必须如实标记为无货号可比对，不能谎称已按货号确认");
    assert.equal(queries.length, 0, "无货号时不应发起任何检索请求，也不允许用名称/SPU 猜同款");
}

// 二、只有 SKU 货号：按 SKU 货号比对，命中即视为重复并停止上传。
{
    const { result, queries } = await runDuplicateCheck({ mallId: "123", productCodes: [], skuCodes: ["ZWX007"], compareMode: "sku" });
    assert.equal(result.state, "not_found", "SKU 货号未命中时应继续上传");
    assert.ok(queries.some(item => JSON.stringify(item.body).includes("skuExtCodes")), "只有 SKU 货号时必须按 skuExtCodes 查询");
}

// 三、有商品货号：优先按商品货号比对，不能拿 SKU 货号去命中别的商品。
{
    const { result, queries } = await runDuplicateCheck({ mallId: "123", productCodes: ["U5C45"], skuCodes: [], compareMode: "product" });
    assert.equal(result.state, "not_found", "商品货号未命中时应继续上传");
    const usedSkuFilter = queries.some(item => JSON.stringify(item.body).includes("skuExtCodes"));
    assert.equal(usedSkuFilter, false, "有商品货号时不能再用 SKU 货号过滤，否则会误命中目标店其他商品");
}

console.log("direct no-code checks passed（无货号不阻断、SKU 货号判重、商品货号优先）");
