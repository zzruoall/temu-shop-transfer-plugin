/**
 * 标红回归：上传失败不再自动标红来源商品，各类失败原因都不能触发标红。
 *
 * 这条线以前踩过坑：插件自己判不了、查不成、读不到的情况，一旦被当成商品问题标红，
 * 运营就得去重新采集一件本来完好的商品，而且这件商品还会被连带禁止发往其他目标店。
 * 判重是辅助手段，它的失败绝不能被解读成"商品缺内容"。
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobQueue } from "../lib/job-queue.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "block-exempt-"));
const spuId = "9100894431";

/** 每个场景用独立的队列实例，避免任务之间的并发互斥互相干扰。 */
async function runScenario(reason) {
    const blocked = [];
    const store = {
        getBatch: async () => ({ sourceStoreId: "11111111", products: [{ spuId, ready: true, title: "测试", images: ["x"], skuIds: ["1"], skcIds: ["2"], publicationData: { sourceProduct: { productId: spuId } } }] }),
        // 此测试只隔离标红分类；原包核验由 verify-transfer-integrity 独立覆盖。
        verifyBatchTransfer: async (_batch, products) => products,
        listOverview: async () => ({}),
        markProductBlocked: async (input) => { blocked.push(input); return { blocked: true }; }
    };
    const queue = createJobQueue(root, store);
    // 直推创建要求目标店以插件 API 模式登记，且 storeId 与 mallId 同源一致。
    const identity = { storeId: "temu:222", mallId: "222", storeName: "target", pageStoreName: "target", executionMode: "plugin-api", pluginInstanceId: "test", pluginDetected: true, identityMatched: true, pluginVersion: "10.10.61" };
    await queue.registerAgent(identity);
    const job = await queue.createJob({ sourceStoreId: "11111111", targetStoreId: "temu:222", targetStoreName: "target", sourceBatchId: "batch", spuIds: [spuId], requireOnline: true, directCreate: true, complianceVersion: "V2.0" });
    await queue.reportOpenResult({ jobId: job.id, storeId: identity.storeId, status: "opened" });
    const { claimed } = await queue.claimJobs({ ...identity, claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: 0, pendingUploadBytes: 0 });
    const base = { ...identity, jobId: job.id, spuId, claimToken: claimed[0].claimToken };
    await queue.reportProgress({ ...base, status: "received", snapshotSha256: claimed[0].transferIntegrity.sha256 });
    await queue.directProgress({ ...base, phase: "preflight_failed", reason });
    return blocked;
}

// 一、判重命中：目标店已有同款是正常结果，不是商品缺内容。
assert.equal((await runScenario("商品传输摘要不一致，已停止处理，请重新发送原始资料")).length, 0, "传输失败不能全局标红来源商品");
{
    const blocked = await runScenario("目标店已存在商品 6220828213，按商品货号确认，未创建");
    assert.equal(blocked.length, 0, "判重命中不能标红");
}

// 二、判重未确认（检索失败/分页重复/超上限）：我们没查成，不是商品的问题。
{
    for (const reason of [
        "商品检索失败，无法确认目标店是否已有该商品：分页请求失败",
        "商品检索分页重复，无法确认目标商品是否已存在",
        "商品检索超过分页上限，无法确认目标商品是否已存在",
        "目标店重复检索未确认（检索未完成），已继续上传，由平台判定"
    ]) {
        const blocked = await runScenario(reason);
        assert.equal(blocked.length, 0, `判重未确认不能标红：${reason}`);
    }
}

// 三、批次内自我去重：同一批次出现相同货号，跳过第二件是正常去重。
{
    const blocked = await runScenario("同一批次已有相同货号，本件跳过，避免批次内重复创建");
    assert.equal(blocked.length, 0, "批次内去重不能标红");
}

// 四、预检环境问题：页面未就绪等，重试即可。
{
    const blocked = await runScenario("prepare: 缺少必填属性：香味（阶段=prepare，页面=https://agentseller.temu.com/goods/list）");
    assert.equal(blocked.length, 0, "预检环境问题不能标红");
}

// 五、回查未通过：平台已创建成功，只是我们没读到。
{
    const blocked = await runScenario("插件接口已创建（商品 8002250622），但回查未通过，请人工核对：详情回查超时");
    assert.equal(blocked.length, 0, "回查未通过不能标红");
}

// 六、平台明确拒绝商品内容：也不再自动标红。
// 平台拒绝只属于本次商品版本与这个目标店；自动标红会把一件商品在全部目标店一并禁掉，
// 因此红标改为只由运营人工设置或重新采集覆盖来管理。
{
    const blocked = await runScenario("当前类目净含量必填（错误码 2000135）");
    assert.equal(blocked.length, 0, "平台拒绝不得再自动标红来源商品");
}

console.log("block exemption checks passed（上传失败一律不自动标红；红标只由人工设置或重新采集覆盖管理）");
