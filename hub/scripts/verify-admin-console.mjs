/**
 * 管理员控制台回归：删除店铺与删除账号的两种模式。
 *
 * 锁住四条规则：
 *   1. 删店铺后数据真的清干净（归属、任务、日志、商品，按模式区分）；
 *   2. 删店铺后插件心跳不能把店登记回来（否则"删了又回来"）；
 *   3. 恢复店铺写回归属，商品是否还在如实反映删除时的模式；
 *   4. 删账号自动释放名下店铺，不留孤儿归属（当前实现的缺陷）。
 * 全程使用临时目录与假数据，不连真实环境。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";
import { createStoreOwnership } from "../lib/store-ownership.mjs";
import { createDeletedStores } from "../lib/deleted-stores.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "admin-console-"));
const store = createStore(root);
const ownership = createStoreOwnership(root);
const deletedStores = createDeletedStores(root);
const queue = createJobQueue(root, store, { ownership, deletedStores });

const STORE_A = "temu:634418217318103";
const STORE_B = "temu:634418210693849";
const zhang = { id: "u_zhang", username: "13800000001" };

/** 造一份采集批次，商品归属到指定来源店。 */
async function seedBatch(batchId, storeId, storeName, spu, code) {
    await store.ensure();
    const indexPath = path.join(root, "data", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.batches = [...(index.batches || []).filter((batch) => batch.id !== batchId), {
        id: batchId,
        createdAt: new Date().toISOString(),
        sourceStoreId: storeId,
        sourceStoreName: storeName,
        status: "ready-for-map",
        readiness: "可导入",
        products: [{
            spuId: spu, title: `商品 ${spu}`, articleNo: code,
            productExtCodes: [code], skuExtCodes: [code],
            skus: [{ skuId: "1", extCode: code }],
            images: ["https://example.com/a.jpg"], skcIds: ["2"], skuIds: ["1"],
            attributes: [], detail: null,
            captureEvidence: { primaryDetail: true, descriptionState: "empty" },
            ready: true,
            completeness: { hasSpu: true, hasTitle: true, hasSku: true, hasImages: true, hasPrimaryDetail: true, detailState: "source-empty" },
            publicationData: { schemaVersion: 1, validationState: "target-unverified", sourceProduct: { productId: spu, productSkcList: [] } }
        }],
        files: []
    }];
    await (await import("node:fs/promises")).writeFile(indexPath, JSON.stringify(index));
}

await seedBatch("batch-a", STORE_A, "甲的店", "1111111111", "CODEA");
await seedBatch("batch-b", STORE_B, "乙的店", "2222222222", "CODEB");
await ownership.claim(STORE_A, zhang, "甲的店");
await ownership.claim(STORE_B, zhang, "乙的店");

// 心跳登记：两个店都注册过插件。
const identityFor = (storeId, name) => ({
    storeId, storeName: name, pageStoreName: name,
    pluginInstanceId: `inst-${storeId.slice(-4)}`,
    pluginVersion: "10.10.50", identityMatched: true, pluginDetected: true,
    executionMode: "plugin-api", mallId: storeId.replace("temu:", "")
});
await queue.registerAgent(identityFor(STORE_A, "甲的店"));
await queue.registerAgent(identityFor(STORE_B, "乙的店"));
const agentsAfterSeed = (await queue.listJobs()).agents.filter((agent) => agent.storeId).length;
assert.equal(agentsAfterSeed, 2, "两个店铺都应登记成功");

// 一、影响预检：如实报告商品数，供确认弹窗展示。
{
    const impact = await store.storeDataImpact(STORE_A);
    assert.equal(impact.productCount, 1, "影响预检必须报告该店商品数");
    assert.equal(impact.batchCount, 1, "影响预检必须报告批次");
    const record = await queue.storeRecordImpact(STORE_A);
    assert.ok(record.agentCount >= 1, "影响预检必须报告心跳记录");
}

// 二、保留模式：只删店铺记录，商品留在库中且仅管理员可见。
{
    const data = await store.deleteStoreData(STORE_A, { keepProducts: true });
    assert.equal(data.mode, "keep");
    assert.equal(data.deletedProductCount, 0, "保留模式不应删除商品");
    const products = (await store.listOverview()).products || [];
    assert.ok(products.some((item) => (item.spuIds || []).includes("1111111111")), "保留模式下商品必须还在库中");

    const record = await queue.deleteStoreRecord(STORE_A);
    assert.ok(record.deletedAgents >= 1, "删除店铺记录必须清掉心跳条目");
    await ownership.forceRelease(STORE_A).catch(() => {});
    await deletedStores.markDeleted({ storeId: STORE_A, storeName: "甲的店", mode: "keep", previousOwnerId: zhang.id, previousOwnerName: zhang.username, deletedBy: "admin" });

    // 心跳拦截：插件再连上来时不能被重新登记，否则"删了又回来"。
    const revived = await queue.registerAgent(identityFor(STORE_A, "甲的店"));
    assert.equal(revived.deleted, true, "已删除店铺的心跳必须被拦截");
    const agentsNow = (await queue.listJobs()).agents.filter((agent) => agent.storeId === STORE_A).length;
    assert.equal(agentsNow, 0, "被拦截的心跳不能写回店铺记录");
}

// 三、恢复：写回归属，商品仍在（因为删除时选了保留）。
{
    const restored = await queue.restoreDeletedStore(STORE_A);
    assert.equal(restored.restored, true, "恢复必须成功");
    assert.equal(await deletedStores.isDeleted(STORE_A), false, "恢复后不应还在删除名单里");
    const owner = await ownership.findOwner(STORE_A);
    assert.equal(owner?.ownerId, zhang.id, "恢复时必须写回原归属");
    const products = (await store.listOverview()).products || [];
    assert.ok(products.some((item) => (item.spuIds || []).includes("1111111111")), "保留模式删除后恢复，商品应当仍在");
    // 恢复后心跳可以重新登记。
    const again = await queue.registerAgent(identityFor(STORE_A, "甲的店"));
    assert.notEqual(again.deleted, true, "恢复后心跳不应再被拦截");
}

// 四、彻底删除：商品随店铺一起消失。
{
    await store.deleteStoreData(STORE_A, { keepProducts: false });
    const products = (await store.listOverview()).products || [];
    assert.equal(products.some((item) => (item.spuIds || []).includes("1111111111")), false, "彻底删除必须清掉商品");
    const impact = await store.storeDataImpact(STORE_A);
    assert.equal(impact.productCount, 0, "彻底删除后该店商品数应为 0");
}

// 五、删账号自动释放名下店铺：不能留下无人能认领的孤儿归属。
{
    // 先确认乙的店仍在张三名下。
    assert.equal((await ownership.findOwner(STORE_B))?.ownerId, zhang.id, "前置条件：乙的店属于张三");
    const released = await ownership.releaseByOwner(zhang.id);
    assert.ok(released.released.some((item) => item.storeId === STORE_B), "释放结果必须包含名下店铺");
    assert.equal(await ownership.findOwner(STORE_B), null, "删账号后店铺必须回到未认领");
    // 释放后别人可以认领——这正是"不留孤儿"的判据。
    const other = { id: "u_other", username: "13800000002" };
    const claimed = await ownership.claim(STORE_B, other, "乙的店");
    assert.equal(claimed.ownerId, other.id, "释放后其他账号必须能重新认领");
}

// 六、管理员删除店铺的标红清理：店铺都没了，标红不该留着占位。
{
    await store.markProductBlocked({ storeId: STORE_B, spuId: "2222222222", reason: "平台拒绝" });
    const before = await store.storeDataImpact(STORE_B);
    assert.equal(before.blockedCount, 1, "前置条件：应有一条标红");
    const data = await store.deleteStoreData(STORE_B, { keepProducts: true });
    assert.equal(data.clearedBlockedCount, 1, "删除店铺必须清掉该店的标红记录");
    const after = await store.storeDataImpact(STORE_B);
    assert.equal(after.blockedCount, 0, "标红记录必须被清除");
}

console.log("admin console checks passed（影响预检、保留/彻底两种删除、心跳拦截、恢复写回归属、删账号释放店铺、标红清理）");
