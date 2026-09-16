/**
 * 直接执行插件注入到目标店页面的回查函数，锁定“商品ID不参与对比”这条规则。
 * 平台在创建时给每个店铺随机分配商品ID，同一件商品在不同店铺ID必然不同，用ID比对只会把创建成功误判成失败。
 * 全程使用假页面与假接口，不访问 Temu，也不产生任何创建请求。
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../plugin/direct-executor.js", import.meta.url), "utf8");
const REQUEST = { productName: "测试商品", productSkcReqs: [{ productSkuReqs: [{ extCode: "UAD05*2" }] }] };

/** 构造一次注入执行环境：saved 决定回查接口返回什么，checkFails 决定内容完整性检查是否不通过。 */
async function runVerify({ saved, checkFails = false }) {
    const calls = [];
    const client = {
        mallIdClient: { getMallIdAsync: async () => "123" },
        post: async (path, body) => {
            calls.push({ path, body });
            if (path.endsWith("/product/query")) return saved;
            throw Error(`回查阶段不应调用 ${path}`);
        }
    };
    const runtime = () => client;
    runtime.m = { only: "getMallIdAsync .postWithoutMallId= .mallIdClient=" };
    const context = vm.createContext({
        console, crypto, Set, Map, String, Number, Object, Array, JSON, Error, Promise, setTimeout,
        location: { origin: "https://agentseller.temu.com", pathname: "/goods/list" },
        window: {
            chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) },
            __temuDirectCheck: () => {
                if (checkFails) throw Error("SKU数量不一致");
                return true;
            }
        },
        chrome: {
            scripting: { executeScript: async spec => [{ result: await spec.func(...spec.args) }] },
            tabs: { get: async () => ({ url: "https://agentseller.temu.com/goods/list" }) }
        }
    });
    vm.runInContext(source, context);
    context.__payload = { mallId: "123", productId: "8002250622", request: REQUEST };
    let result = null;
    let failure = "";
    try {
        result = await vm.runInContext("directPage(9, 'verify', __payload)", context);
    } catch (error) {
        failure = String(error?.message || error);
    }
    return { result, failure, calls };
}

// 一、回查返回的商品ID与查询用的ID不同：这是平台的正常行为，必须照样判定回查成功。
{
    const { result, failure } = await runVerify({
        saved: { productId: "9999999999", productName: REQUEST.productName, productSkcList: [{}] }
    });
    assert.equal(failure, "", `商品ID不同不得导致回查失败，实际失败：${failure}`);
    assert.equal(result?.verified, true, "内容一致时必须判定回查成功");
}

// 二、回查返回的商品名称与请求不同：名称是设置好的可比信息，必须拦住。
{
    const { failure } = await runVerify({
        saved: { productId: "8002250622", productName: "被改过的名称", productSkcList: [{}] }
    });
    assert.match(failure, /名称不一致/, "名称不一致必须判为回查失败");
}

// 三、回查没有返回商品：不能把空结果当成通过。
{
    const { failure } = await runVerify({ saved: null });
    assert.match(failure, /没有返回商品/, "回查拿不到商品时必须失败");
}

// 四、内容完整性检查不通过：仍然如实失败，不能因为不比对ID就放宽内容校验。
{
    const { failure } = await runVerify({
        saved: { productId: "8002250622", productName: REQUEST.productName, productSkcList: [{}] },
        checkFails: true
    });
    assert.match(failure, /SKU数量不一致/, "内容不一致必须如实上报失败原因");
}

// 五、回查阶段只允许调用查询接口，不能出现任何新增请求。
{
    const { calls } = await runVerify({
        saved: { productId: "9999999999", productName: REQUEST.productName, productSkcList: [{}] }
    });
    assert.equal(calls.every(call => call.path.endsWith("/product/query")), true, "回查阶段不得调用新增等写接口");
}

console.log("回查对比检查通过：不比商品ID、按名称与内容判定、空结果与内容不一致如实失败、只调用查询接口");
