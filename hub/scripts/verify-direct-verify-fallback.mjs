/**
 * 锁定“提交成功后回查失败”的真实行为：详情回查拿不到结果时，必须能按提交时的货号回目标店列表确认商品已创建，
 * 报告 created 而不是结果未知；列表也无法确认时仍停在 unknown，且任何情况下都不能再次提交同一件商品。
 * 这里用假平台运行时驱动真实的 direct-executor.js，不联网、不接触真实 Temu 页面。
 */
import vm from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../plugin/direct-executor.js", import.meta.url), "utf8");
const PRODUCT = "9294042985";
const CREATED_ID = "8002250622";
const EXTS = ["UAD05*2"];

/**
 * 搭一个最小插件后台。verifyFails 控制详情回查是否“拿不到结果”，listConfirms 控制货号回查能否在目标店列表命中。
 * 定时器被压缩到 1ms，让有限重试窗口在测试里快速跑完，同时保留真实的等待/重试逻辑。
 */
function createHarness({ verifyFails = false, verifyErrorText = "", listConfirms = true } = {}) {
    const data = {};
    const calls = [];
    const logs = [];
    const progress = [];
    let duplicateChecks = 0;
    let submits = 0;
    const context = vm.createContext({
        console, crypto: globalThis.crypto, Set, Map, Promise, Date, JSON, structuredClone,
        setTimeout: (fn, ms) => globalThis.setTimeout(fn, Math.min(1, Number(ms) || 0)),
        clearTimeout,
        chrome: {
            runtime: { getManifest: () => ({ version: "10.10.35" }) },
            tabs: { get: async () => ({ url: "https://agentseller.temu.com/goods/list" }) },
            storage: {
                local: {
                    get: async key => ({ [key]: data[key] }),
                    set: async value => Object.assign(data, structuredClone(value)),
                    remove: async key => { delete data[key]; }
                }
            },
            scripting: {
                executeScript: async spec => {
                    if (spec.files) return [];
                    const [operation] = spec.args;
                    // 对象载荷是页面内的重复检索：第一次是提交前的目标店判重，之后是回查失败时的货号兜底确认。
                    if (operation && typeof operation === "object") {
                        duplicateChecks += 1;
                        calls.push({ kind: "duplicate", payload: operation });
                        if (duplicateChecks === 1 || !listConfirms) return [{ result: { state: "not_found", queryMode: "skuExtCodes", scanned: 0 } }];
                        return [{ result: { state: "exists", productId: CREATED_ID, matchedBy: "extCode" } }];
                    }
                    calls.push({ kind: operation });
                    if (operation === "prepare") return [{ result: { request: { productName: "测试商品", productSkcReqs: [{ productSkuReqs: [{ extCode: EXTS[0] }] }] }, hash: "a".repeat(64), hashLength: 64 } }];
                    if (operation === "submit") { submits += 1; return [{ result: { started: true } }]; }
                    if (operation === "submit-status") return [{ result: { state: "created", productId: CREATED_ID } }];
                    if (operation === "identity") return [{ result: { mallId: "123" } }];
                    // verifyFails 时注入返回空条目：等价于文档正在重载、注入拿不到结果。
                    // verifyErrorText 时注入抛出错误：等价于内容比对不通过（SKU 数量、主图数量、价格、净含量、成分）。
                    if (operation === "verify") {
                        if (verifyErrorText) return [{ error: { message: verifyErrorText } }];
                        return verifyFails ? [{}] : [{ result: { verified: true } }];
                    }
                    return [{ result: {} }];
                }
            }
        },
        getTargetUploadTasks: async () => [{
            jobId: "job-verify",
            spuId: PRODUCT,
            targetStoreId: "temu:123",
            claimToken: "secret",
            directCreate: true,
            directState: "",
            snapshot: { publicationData: { sourceProduct: { productId: PRODUCT, productSkcList: [{ extCode: EXTS[0], productSkuList: [] }] } } }
        }],
        getPluginInstanceId: async () => "instance",
        updateDirectTaskProgress: async (_storeId, _jobId, _spuId, patch) => { progress.push(patch); },
        notifyDirectCreateProgress: async () => {},
        TemuOperationLog: { append: async entry => { logs.push(entry); } },
        hubJson: async (url, body) => { calls.push({ kind: "hub", url, body }); return { attemptId: "attempt" }; }
    });
    vm.runInContext(source, context);
    return {
        data, calls, logs, progress, context,
        lastState: () => progress.filter(patch => patch.directState).at(-1)?.directState || "",
        get submits() { return submits; },
        reports: () => calls.filter(call => call.kind === "hub").map(call => call.body),
        run: () => vm.runInContext(`runDirectTasks(7,{storeId:'temu:123',mallId:'123'})`, context)
    };
}

// 一、详情回查拿不到结果，但货号能在目标店列表查到：必须报告创建成功，且不重复提交。
{
    const harness = createHarness({ verifyFails: true, listConfirms: true });
    await harness.run();
    assert.equal(harness.submits, 1, "回查失败不能触发第二次新增请求");
    const reports = harness.reports();
    const created = reports.find(report => report.phase === "created");
    assert.ok(created, "货号兜底确认成功后必须报告 created，不能停在结果未知");
    assert.equal(created.productId, CREATED_ID);
    assert.equal(created.verified, true);
    assert.match(String(created.reason), /按货号/, "回查失败时的结论必须写明是按货号确认的");
    // 结论里必须带出回查的真实原因，否则运营无法区分“页面重载没读到”和“内容比对不通过”。
    assert.match(String(created.reason), /详情回查未通过/, "结论必须保留回查失败的真实原因");
    assert.match(String(created.reason), /verify/, "原因文本必须来自回查阶段本身");
    // 兜底确认只能查目标店列表，不得再调用新增接口。
    assert.equal(reports.filter(report => report.phase === "begin").length, 1, "同一个商品只允许申请一次创建授权");
    assert.ok(harness.logs.some(entry => entry.status === "succeeded"), "创建成功必须写进操作日志");
    assert.equal(harness.data[`directAttempt:job-verify:${PRODUCT}`]?.done, true, "确认成功后要落盘完成标记，避免心跳再次进入");
    // 确认成功后必须立刻收手，不能把重试窗口跑满。
    // 10.10.42 起判重载荷按商品/SKU 两级货号传递（productCodes/skuCodes），不再是扁平 extCodes；
    // 用旧字段名过滤会统计到 0 次，让"确认成功后立即收手"这条断言永远失败。
    const confirms = harness.calls.filter(call => call.kind === "duplicate" && (call.payload?.productCodes || call.payload?.skuCodes));
    assert.ok(confirms.length >= 1 && confirms.length <= 4, `确认成功后应立即停止重试，实际货号回查 ${confirms.length} 次`);
}

// 二、平台已返回商品ID（创建成功）但我们的回查确认不了：必须按平台结果上报 created，绝不重发。
// 回查（详情查询与货号列表）是插件自己的核对手段，不能反过来推翻平台已经给出的成功结果，
// 否则平台创建成功的商品会被判成失败并标红，运营还得去重抓一件好商品。
{
    const harness = createHarness({ verifyFails: true, listConfirms: false });
    await harness.run();
    assert.equal(harness.submits, 1, "无法确认时同样不能重发新增请求");
    const reports = harness.reports();
    const created = reports.find(report => report.phase === "created");
    assert.ok(created, "平台已返回商品ID时必须以 created 上报，不能改判为结果未知");
    assert.equal(created.productId, CREATED_ID, "上报的商品ID必须来自平台新增响应");
    // 回查未通过的真实原因必须保留，运营才能区分“只是没读到”和“确实有内容差异”。
    assert.match(String(created.reason), /回查未通过/, "结论里必须保留回查未通过的原因");
    assert.equal(reports.some(report => report.phase === "unknown"), false, "平台已给出成功结果时不得再上报结果未知");
    // 创建成功要落盘完成标记，心跳据此不再重复创建同一件商品。
    assert.equal(harness.data[`directAttempt:job-verify:${PRODUCT}`]?.done, true, "上报 created 后必须落盘完成标记，防止心跳重发");
    assert.ok(harness.logs.some(entry => entry.status === "succeeded"), "创建成功必须写进操作日志");
    // 注入失败属于瞬时故障，窗口内必须真的重试过；同时必须收在次数上限内，不能无限循环。
    const verifyCalls = harness.calls.filter(call => call.kind === "verify").length;
    assert.ok(verifyCalls > 2, `注入拿不到结果时必须在窗口内重试，实际 verify ${verifyCalls} 次`);
    assert.ok(verifyCalls <= 40, `重试必须有上限，实际 verify ${verifyCalls} 次`);
}

// 三、内容比对不通过（回查返回的商品与请求不一致）：商品确实已创建，仍要按货号确认成功，并把比对不通过的原因写进结论。
{
    const harness = createHarness({ verifyErrorText: "主图数量不一致", listConfirms: true });
    await harness.run();
    assert.equal(harness.submits, 1, "内容比对失败不能触发第二次新增请求");
    const created = harness.reports().find(report => report.phase === "created");
    assert.ok(created, "内容比对不通过但货号能确认存在时，仍必须报告创建成功");
    assert.match(String(created.reason), /主图数量不一致/, "结论必须带出内容比对不通过的真实原因，便于运营定位");
    // 兜底确认成功后立即收手：不能把 20 秒重试窗口跑满。
    const verifyCalls = harness.calls.filter(call => call.kind === "verify").length;
    assert.ok(verifyCalls <= 4, `确认成功后不得继续重试回查，实际 verify ${verifyCalls} 次`);
}

console.log("回查兜底检查通过：平台已返回商品ID即按创建成功上报，回查未通过只记原因，绝不重复提交");
