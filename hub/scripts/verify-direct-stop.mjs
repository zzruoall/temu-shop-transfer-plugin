/**
 * 锁定“停止接口创建”的真实行为：停止标记必须落盘、刷新后仍生效、只作用于本店，
 * 当前文档显式启用后正常执行，运行中被停止时不得再申请新的创建授权。
 * 这里用假平台运行时驱动真实的 direct-executor.js，不联网、不接触真实 Temu 页面。
 */
import vm from "node:vm";
import assert from "node:assert/strict";

import { directExecutorFixture } from './direct-platform-fixture.mjs';
const source = await directExecutorFixture({ executionRounds: true });
const PRODUCT = "9100894431";

/**
 * 搭一个最小插件后台：存储、页面执行和回执都被记录，便于断言“有没有真的动过手”。
 * pauseDuringPrepare 用来复现“运营在预检过程中点停止”，此时页面侧已经算完但不允许再申请授权。
 */
function createHarness({ storeId = "temu:123", mallId = "123", pauseDuringPrepare = false, pauseDuringPreserve = false, pauseDuringBegin = false, pausedAtStart = false, taskStores = null, staleTask = false } = {}) {
    // 预置已完成握手的轮次；身份、文档和任务必须同轮，不能只伪造启用布尔值。
    const identities = (taskStores || [storeId]).map((id, index) => ({ storeId: id,
        mallId: id === storeId ? mallId : id.slice(5), tabId: index + 1, documentId: `document-${index + 1}`,
        executionRunProtocol: 1, executionRunId: `execution-round-${index + 1}` }));
    const data = Object.fromEntries(identities.map(identity => [`directPause:${identity.storeId}`,
        { ...identity, paused: false, enabledVersion: '10.10.60' }]));
    if (pausedAtStart) data[`directPause:${storeId}`] = { paused: true, at: new Date().toISOString(), reason: "测试预置停止" };
    const phases = [];
    const logs = [];
    let pageRuns = 0;
    let submits = 0;
    const context = vm.createContext({
        console, crypto: globalThis.crypto, Set, Promise, setTimeout, clearTimeout, Date, JSON,
        chrome: {
            runtime: { getManifest: () => ({ version: '10.10.60' }) },
            storage: {
                local: {
                    get: async key => structuredClone(key === null ? data : { [key]: data[key] }),
                    set: async value => Object.assign(data, structuredClone(value)),
                    remove: async key => { delete data[key]; }
                }
            },
            scripting: {
                executeScript: async spec => {
                    if (spec.files) return [];
                    if (!spec.args) {
                        const identity = identities.find(entry => entry.tabId === spec.target.tabId);
                        if (!identity || spec.target.documentIds?.[0] !== identity.documentId) throw Error('页面已变化');
                        return [{ documentId: identity.documentId, result: { visible: true } }];
                    }
                    pageRuns += 1;
                    const [operation] = spec.args;
                    if (operation && typeof operation === "object") return [{ result: { state: "not_found" } }];
                    if (operation === "prepare") {
                        // 模拟操作者在这一步点下“停止接口创建”：标记写进同一个存储。
                        if (pauseDuringPrepare) data[`directPause:${storeId}`] = { paused: true, at: new Date().toISOString(), reason: "预检过程中停止" };
                        return [{ result: { request: { productName: "测试" }, hash: "a".repeat(64), hashLength: 64 } }];
                    }
                    if (operation === 'preserve' && pauseDuringPreserve) data[`directPause:${storeId}`] = { paused: true };
                    if (operation === "submit") { submits += 1; return [{ result: { started: true } }]; }
                    if (operation === "submit-status") return [{ result: { state: "created", productId: "8002250622" } }];
                    if (operation === "verify") return [{ result: { verified: true } }];
                    if (operation === "identity") return [{ result: { mallId } }];
                    return [{ result: {} }];
                }
            }
        },
        getTargetUploadTasks: async () => identities.map(identity => ({
            executionRunId: staleTask ? 'previous-execution-round' : identity.executionRunId,
            jobId: `job-${identity.storeId}`, spuId: PRODUCT, targetStoreId: identity.storeId, claimToken: "secret", directCreate: true, directState: "",
            snapshot: { publicationData: { sourceProduct: { productId: PRODUCT } } }
        })),
        getPluginInstanceId: async () => "instance",
        TemuOperationLog: { append: async entry => { logs.push(entry); } },
        // 创建授权与结果补报已拆分，停止测试须同时提供两条模拟通道。
        TemuDirectReceipts: { send: async body => { phases.push(body.phase); return { attemptId: 'attempt', state: body.phase }; } },
        hubJson: async (_url, body) => {
            phases.push(body.phase);
            if (body.phase === 'begin' && pauseDuringBegin) data[`directPause:${storeId}`] = { paused: true };
            return { attemptId: "attempt" };
        }
    });
    vm.runInContext(source, context);
    return {
        data, phases, logs, context,
        get pageRuns() { return pageRuns; },
        get submits() { return submits; },
        run: (targetStoreId = storeId) => {
            const identity = identities.find(entry => entry.storeId === targetStoreId);
            return vm.runInContext(`runDirectTasks(${identity.tabId},${JSON.stringify(identity)})`, context);
        }
    };
}

// 一、停止标记按目标店落盘，重复读取仍然有效：刷新页面后靠它继续拦截。
{
    const harness = createHarness();
    await vm.runInContext(`writeDirectPause('temu:123',true,'测试停止')`, harness.context);
    assert.equal(harness.data["directPause:temu:123"]?.paused, true, "停止标记必须落在扩展存储里");
    assert.equal(await vm.runInContext(`(async()=>Boolean(await readDirectPause('temu:123')))()`, harness.context), true, "重新读取必须仍能拿到停止标记");
    // 旧布尔入口不能启用，必须经过服务端新轮次握手。
    await assert.rejects(vm.runInContext(`writeDirectPause('temu:123',false)`, harness.context), /启用执行必须/);
    assert.equal(harness.data['directPause:temu:123'].paused, true);
}

// 二、已停止的店铺：刷新页面后再次进入也完全不碰页面、不申请任何授权。
{
    const harness = createHarness({ pausedAtStart: true });
    await harness.run();
    assert.equal(harness.pageRuns, 0, "已停止时不得执行任何页面脚本");
    assert.deepEqual(harness.phases, [], "已停止时不得申请授权或上报阶段");
    assert.equal(harness.submits, 0, "已停止时不得提交商品");
    assert.ok(await vm.runInContext(`(async()=>Boolean(await readDirectPause('temu:123')))()`, harness.context), "刷新后停止标记必须仍然存在");
}

// 三、停止只作用于本店：另一家目标店的任务不受影响。
{
    const harness = createHarness({ pausedAtStart: true, taskStores: ["temu:123", "temu:999"] });
    await harness.run('temu:999');
    assert.ok(harness.pageRuns > 0, "停止 A 店不能挡住 B 店的接口创建");
    // 同一批任务里 A 店被停止：它自己一件都不能动，B 店仍照常走到提交。
    assert.ok(harness.phases.includes("begin"), "B 店在 A 店停止期间仍必须能申请创建授权");
    assert.equal(harness.submits, 1, "B 店在 A 店停止期间仍必须完成提交");
    // B 店跑通不能顺带清掉 A 店的停止标记：同一存储里两家店必须互不影响。
    const runsBeforeA = harness.pageRuns;
    await harness.run();
    assert.equal(harness.pageRuns, runsBeforeA, "A 店仍处于停止状态，不得执行页面脚本");
    assert.equal(harness.submits, 1, "A 店停止期间不得新增提交");
}

// 四、运行过程中停止：不再申请新的创建授权，也不提交，但要留下可核对的停止记录。
{
    const harness = createHarness({ pauseDuringPrepare: true });
    await harness.run();
    assert.equal(harness.pageRuns > 0, true, "停止发生在预检之后，这一轮必须真的跑过页面");
    assert.equal(harness.phases.includes("begin"), false, "停止后不得再申请新的创建授权");
    assert.equal(harness.submits, 0, "停止后不得提交商品");
    const stopped = harness.logs.find(entry => entry.phase === "stopped");
    assert.ok(stopped, "停止必须写进操作日志，运营才能看到停止生效在哪个位置");
    assert.match(String(stopped.reason), /停止接口创建/);
}

// 五、当前文档已启用且任务同轮时，只创建一次；旧轮快照不能继承新轮授权。
{
    const harness = createHarness();
    const storeKey = "temu:123";
    await harness.run();
    assert.ok(harness.phases.includes("begin"), "未停止时必须正常申请创建授权");
    assert.equal(harness.submits, 1, "未停止时必须提交一次");
    assert.equal(harness.data[`directAttempt:job-${storeKey}:${PRODUCT}`]?.done, true, "正常流程仍要落盘完成标记");
}
{
    const harness = createHarness({ staleTask: true });
    await harness.run();
    assert.equal(harness.submits, 0, '旧轮任务不能借当前轮次新增');
    assert.deepEqual(harness.phases, [], '旧轮任务不能申请执行许可');
}

// 授权前校验与授权响应都可能晚于停止操作；这两处不能继续发出平台新增。
for (const phase of ['pauseDuringPreserve', 'pauseDuringBegin']) {
    const harness = createHarness({ [phase]: true });
    await harness.run();
    assert.equal(harness.submits, 0, phase);
    assert.equal(harness.phases.includes('begin'), phase === 'pauseDuringBegin');
    if (phase === 'pauseDuringBegin') {
        assert.ok(harness.phases.includes('preflight_failed'), '许可已拿到但未提交须补报并释放服务端占位');
        assert.equal(harness.data[`directAttempt:job-temu:123:${PRODUCT}`]?.done, true);
    }
}
console.log("接口创建停止检查通过：停止落盘、跨店隔离、预检/授权期间停止不提交、同轮执行与旧轮拒绝");
