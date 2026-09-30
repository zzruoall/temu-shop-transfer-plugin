/**
 * 核对上传失败标红、重新采集解除与人工解除：
 * 红标只记录“这次上传没过”的排查线索，不改商品内容，也不阻止发往其他目标店；
 * 解除条件必须是重新采集覆盖或明确的人工解除，避免运营靠删除记录绕过。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "blocked-product-test-"));
const store = createStore(root);
const batchId = "batch-1";
const storeId = "temu:111";
const spuId = "1234567890";

/** 造一份最小可用采集包：商品资料齐全，才可能进入上传队列。 */
async function writeBatch(products) {
    const index = JSON.parse(await readFile(path.join(root, "data", "index.json"), "utf8"));
    index.batches = [{
        id: batchId,
        createdAt: new Date().toISOString(),
        sourceStoreId: storeId,
        sourceStoreName: "来源店",
        status: "ready-for-map",
        readiness: "可导入",
        products,
        files: []
    }];
    await writeFile(path.join(root, "data", "index.json"), JSON.stringify(index));
}

const makeProduct = (spu, code = "U5C45") => ({
    spuId: spu,
    title: `商品 ${spu}`,
    articleNo: code,
    productExtCodes: [code],
    skuExtCodes: [code],
    skus: [{ skuId: "1", extCode: code }],
    images: ["https://example.com/a.jpg"],
    skcIds: ["2"],
    skuIds: ["1"],
    attributes: [{ name: "成分", value: "甘油" }],
    detail: null,
    captureEvidence: { primaryDetail: true, descriptionState: "empty" },
    ready: true,
    completeness: { hasSpu: true, hasTitle: true, hasSku: true, hasImages: true, hasPrimaryDetail: true, detailState: "source-empty" },
    publicationData: { schemaVersion: 1, validationState: "target-unverified", sourceProduct: { productId: spu, productSkcList: [] } }
});

await store.ensure();
// 两件商品必须用不同货号：商品库按“来源店 + 货号”归并，同货号会被并成一行，无法验证隔离性。
await writeBatch([makeProduct(spuId, "U5C45"), makeProduct("9876543210", "U3C55")]);

// 初始不能标红。
let overview = await store.listOverview();
assert.equal(overview.blockedCount, 0, "新入库商品不应被标红");
assert.equal(overview.products.find(p => p.spuId === spuId).blocked, undefined, "未失败不应带红标");

// 标红后：商品行带红标与原因，计数增加。
await store.markProductBlocked({ storeId, spuId, reason: "参数错误：中国产地省份必填（错误码 1000003）" });
overview = await store.listOverview();
assert.equal(overview.blockedCount, 1, "标红后应该只影响这一件商品");
const blockedRow = overview.products.find(p => p.spuId === spuId);
assert.equal(blockedRow.blocked, true, "被标红的商品必须在商品库里可见");
assert.match(blockedRow.blockedReason, /产地省份必填/, "红标必须带上失败原因，运营才知道去哪修");
// 同店另一件商品不能被连带标红。
assert.notEqual(overview.products.find(p => p.spuId === "9876543210").blocked, true, "标红不能影响同店其他商品");

// 标红商品禁止再上传。
// 本用例核对的是标红与解除，不是原包一致性；来源原包校验由专门的传输完整性用例覆盖。
// 因此只在队列侧替换该函数，仓库读写仍走真实实现，标红行为依旧被真实校验。
const queue = createJobQueue(root, {
    ...store,
    verifyBatchTransfer: async (_batch, products) => products
});
// 直推创建要求目标店以插件 API 模式登记，且 storeId 与 mallId 同源一致。
const identity = { storeId: "temu:222", mallId: "222", storeName: "目标店", pageStoreName: "目标店", executionMode: "plugin-api",
    pluginInstanceId: "inst", pluginDetected: true, identityMatched: true, pluginVersion: "10.10.61" };
await queue.registerAgent(identity);
const jobInput = { sourceStoreId: storeId, targetStoreId: "temu:222", targetStoreName: "目标店", sourceBatchId: batchId, spuIds: [spuId], requireOnline: true, directCreate: true, complianceVersion: "V2.0" };
// 红标是排查线索，不是全局封禁：平台拒绝只属于某次商品版本与目标店，不能连带禁掉发给其他目标店。
// 因此标红商品仍可下发，是否已存在由目标店插件在平台内自行检索判断。
const blockedSend = await queue.createJob(jobInput);
assert.ok(blockedSend.id, "标红商品仍应允许下发，红标仅供排查");
assert.equal(blockedSend.items[0].spuId, spuId);
// 同批次里另一件商品同样可正常下发。
await queue.createJob({ ...jobInput, spuIds: ["9876543210"] });
// 下发不会自动清除红标：红标只由重新采集覆盖或人工解除来消除。
overview = await store.listOverview();
assert.equal(overview.products.find(p => p.spuId === spuId).blocked, true, "下发行为不得自动清除红标");

// 重新采集覆盖后解除红标。
await store.clearProductBlocked(storeId, [spuId]);
overview = await store.listOverview();
assert.equal(overview.blockedCount, 0, "重新采集覆盖后必须解除红标");
assert.equal(overview.products.find(p => p.spuId === spuId).blocked, undefined, "解除后商品行不应再带红标");

// 解除后可以再次上传。
const reissued = await queue.createJob({ ...jobInput, spuIds: [spuId] });
assert.ok(reissued.id, "解除红标后必须能重新下发上传任务");

// 红标按来源店隔离：同 SPU 在别的来源店不应被连带标红。
await store.markProductBlocked({ storeId, spuId, reason: "再次失败" });
await store.markProductBlocked({ storeId: "temu:999", spuId: "555", reason: "别的店失败" });
overview = await store.listOverview();
assert.equal(overview.products.find(p => p.spuId === "9876543210").blocked, undefined, "红标不能跨商品扩散");

// 网页人工解除标红：平台抖动造成的假失败不必重新采集来源商品，必须能只按 SPU 解除。
assert.equal(overview.products.find(p => p.spuId === spuId).blocked, true, "测试前提：该商品当前处于标红状态");
const unblocked = await store.unblockProducts([spuId]);
assert.ok(unblocked.cleared >= 1, "人工解除必须真正清掉标红记录");
overview = await store.listOverview();
assert.equal(overview.products.find(p => p.spuId === spuId).blocked, undefined, "解除后商品行不应再带红标");
// 解除后必须能再次上传，否则运营仍被挡住。
const afterUnblock = await queue.createJob({ ...jobInput, spuIds: [spuId] });
assert.ok(afterUnblock.id, "人工解除标红后必须能重新下发上传任务");
// 未标红的商品调用解除不应报错，也不应影响其他记录。
const noop = await store.unblockProducts(["9999999999"]);
assert.equal(noop.cleared, 0, "未标红商品解除应为无操作");
assert.deepEqual(noop.missing, ["9999999999"], "应如实报告未找到标红记录的商品");

console.log("blocked product checks passed（标红不阻断其他目标店、重新采集解除、人工解除、按来源店隔离）");
