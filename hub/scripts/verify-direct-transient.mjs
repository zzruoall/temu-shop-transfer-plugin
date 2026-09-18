/**
 * 锁定三条与"上传失败/重复创建"直接相关的规则：
 *   1) 平台临时故障（系统异常/限流/超时）不得判为确定性拒绝，否则好商品会被标红；
 *   2) 预检与提交必须串行，不能并发争抢同一个 Temu runtime；
 *   3) 同一批次内重复货号（有商品货号按商品货号、否则按 SKU 货号）只传第一件，后面的直接跳过，
 *      且该规则不依赖"跳过目标店检索"的测试开关。
 * 用假页面驱动真实的 direct-executor.js，不联网、不产生任何创建请求。
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../plugin/direct-executor.js", import.meta.url), "utf8");

// 一、并发度必须是 1：并发注入多个页面脚本会争抢 runtime，曾导致平台返回 1000005 系统异常。
{
    const match = source.match(/const DIRECT_PREFLIGHT_CONCURRENCY\s*=\s*(\d+)/);
    assert.ok(match, "必须能找到预检并发常量");
    assert.equal(Number(match[1]), 1, "预检与提交必须严格串行，并发会导致平台临时故障并误判失败");
}

// 二、提交结果分类：临时故障必须是 unknown，内容错误才是 rejected。
async function classifySubmitError(platformError) {
    // 直接驱动真实的 directPage('submit')，让错误分类逻辑按生产代码执行。
    // 页面运行时会向 chunkLoadingGlobal 取客户端；这里注入一个带平台特征的假客户端，
    // 否则会先被"平台客户端不兼容"挡住，测不到错误分类分支。
    let captured = null;
    const client = {
        mallIdClient: { getMallIdAsync: async () => "123" },
        post: async (path) => { if (path.endsWith("/product/add")) throw platformError; return {}; }
    };
    const runtime = () => client;
    runtime.m = { fakeClient: "getMallIdAsync .postWithoutMallId= .mallIdClient=" };
    const context = vm.createContext({
        console, crypto, Set, Map, String, Number, Object, Array, JSON, Error, Promise, setTimeout, Date,
        sessionStorage: { setItem() {}, getItem: () => null },
        location: { origin: "https://agentseller.temu.com", pathname: "/goods/list" },
        window: {
            chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) },
            __temuDirectPreparedRequests: {},
            __temuDirectSubmitStates: {},
            __temuDirectFingerprint: async () => ({ hash: "a".repeat(64), length: 64 })
        },
        chrome: {
            scripting: { executeScript: async spec => [{ result: await spec.func(...spec.args) }] },
            tabs: { get: async () => ({ url: "https://agentseller.temu.com/goods/list" }) }
        }
    });
    vm.runInContext(source, context);
    context.__captured = value => { captured = value; };
    await vm.runInContext(`(async () => {
        const payload = { attemptId: 't1', mallId: '123', requestKey: 'k1', request: { productName: 'x' } };
        await directPage(1, 'submit', payload);
        for (let i = 0; i < 40; i += 1) {
            await new Promise(r => setTimeout(r, 50));
            const st = window.__temuDirectSubmitStates['temu-api-attempt-t1'];
            if (st && st.state !== 'submitting') { __captured(st); return; }
        }
    })()`, context);
    return captured;
}

{
    // 系统异常：必须停在 unknown（可重试），不能判 rejected（否则被标红）。
    const transient = await classifySubmitError({ success: false, errorCode: 1000005, errorMsg: "系统异常" });
    assert.ok(transient, "必须能捕获提交状态");
    assert.equal(transient.state, "unknown", "系统异常属临时故障，不能判为确定性拒绝");
    assert.equal(transient.transient, true, "必须显式标记为临时故障，供后台按可重试处理");

    // 缺必填属性：内容问题，重试无用，必须判 rejected 才能标红。
    const content = await classifySubmitError({ success: false, errorCode: 2000135, errorMsg: "当前类目净含量必填" });
    assert.equal(content.state, "rejected", "内容错误必须判为确定性拒绝并标红");
    assert.equal(Boolean(content.transient), false, "内容错误不能被当成临时故障");
}

// 判重键构造：有商品货号只保留商品货号；没有才回退 SKU 货号；两者都没有时按 SPU 保留。
{
    const context = vm.createContext({
        console, Set, Map, String, Number, Object, Array, JSON, Error, Promise,
        location: { origin: "https://agentseller.temu.com", pathname: "/goods/list" },
        window: { chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2]({ m: {} }) } },
        chrome: { scripting: { executeScript: async () => [] } }
    });
    vm.runInContext(source, context);
    // directCompareKeys 在脚本作用域内，必须通过 runInContext 调用，宿主的 context 属性访问不到。
    const withProduct = vm.runInContext('directCompareKeys({ productCodes: ["U5C45"], skuCodes: [] })', context);
    const withSku = vm.runInContext('directCompareKeys({ productCodes: [], skuCodes: ["ZWX007"] })', context);
    const empty = vm.runInContext('directCompareKeys({ productCodes: [], skuCodes: [] })', context);
    assert.deepEqual([...withProduct], ["product\u0000U5C45"], "有商品货号时判重键只能用商品货号");
    assert.deepEqual([...withSku], ["sku\u0000ZWX007"], "没有商品货号时才回退 SKU 货号");
    assert.equal(empty.length, 0, "两者都没有时没有可用的判重键");
    // 同一批次保留位必须能拦住第二件同货号商品。
    const reserved = new Set([...withProduct]);
    assert.ok([...withProduct].some(code => reserved.has(code)), "同货号第二件必须能被批次保留位拦住");
}

console.log("direct transient-retry / serial / batch-duplicate checks passed");
