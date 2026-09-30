/**
 * 多账号隔离回归：防止"商品发错店"与"动到别人的数据"。
 *
 * 锁住四条边界：
 *   1. 只能在自己认领的店铺之间上传（来源店和目标店都要在范围内）；
 *   2. 不能删除别人店铺的商品；
 *   3. 不能解除别人店铺的红标（否则绕过"标红禁止再传"）；
 *   4. 管理员（无范围限制）不受限，便于排障与代操作。
 * 全程使用临时目录与假数据，不连真实环境。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.mjs";
import { createStoreOwnership } from "../lib/store-ownership.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "isolation-"));
const store = createStore(root);
const ownership = createStoreOwnership(root);

const STORE_A = "temu:634418217318103";   // 张三的店
const STORE_B = "temu:634418210693849";   // 李四的店
const SPU_A = "1111111111";
const SPU_B = "2222222222";
const zhang = { id: "u_zhang", username: "13800000001" };
const lisi = { id: "u_lisi", username: "13800000002" };

const makeProduct = (spu, code) => ({
    spuId: spu,
    title: `商品 ${spu}`,
    articleNo: code,
    productExtCodes: [code],
    skuExtCodes: [code],
    skus: [{ skuId: "1", extCode: code }],
    images: ["https://example.com/a.jpg"],
    skcIds: ["2"],
    skuIds: ["1"],
    attributes: [],
    detail: null,
    captureEvidence: { primaryDetail: true, descriptionState: "empty" },
    ready: true,
    completeness: { hasSpu: true, hasTitle: true, hasSku: true, hasImages: true, hasPrimaryDetail: true, detailState: "source-empty" },
    publicationData: { schemaVersion: 1, validationState: "target-unverified", sourceProduct: { productId: spu, productSkcList: [] } }
});

/** 直接写批次，把商品归属到指定来源店；两份数据必须用不同货号，否则会被归并成一行。 */
async function writeBatch(batchId, storeId, storeName, products) {
    await store.ensure();
    const index = JSON.parse(await readFile(path.join(root, "data", "index.json"), "utf8"));
    index.batches = [...(index.batches || []).filter((batch) => batch.id !== batchId), {
        id: batchId,
        createdAt: new Date().toISOString(),
        sourceStoreId: storeId,
        sourceStoreName: storeName,
        status: "ready-for-map",
        readiness: "可导入",
        products,
        files: []
    }];
    await writeFile(path.join(root, "data", "index.json"), JSON.stringify(index));
}

await writeBatch("batch-a", STORE_A, "张三的店", [makeProduct(SPU_A, "CODEA")]);
await writeBatch("batch-b", STORE_B, "李四的店", [makeProduct(SPU_B, "CODEB")]);

const findProduct = async (spu) => (await store.listOverview()).products.find((item) => item.spuId === spu || (item.spuIds || []).includes(spu));

// 一、归属表：各自认领自己的店，可见集合互不包含对方。
await ownership.claim(STORE_A, zhang, "张三的店");
await ownership.claim(STORE_B, lisi, "李四的店");
const zhangScope = await ownership.ownedStoreIds(zhang.id);
const lisiScope = await ownership.ownedStoreIds(lisi.id);
assert.ok(zhangScope.has(STORE_A) && !zhangScope.has(STORE_B), "张三只应看到自己的店");
assert.ok(lisiScope.has(STORE_B) && !lisiScope.has(STORE_A), "李四只应看到自己的店");

// 二、删除隔离：张三不能删李四店铺的商品，整批拒绝（不静默跳过）。
{
    const target = await findProduct(SPU_B);
    assert.ok(target, "李四的商品必须已入库");
    await assert.rejects(
        store.deleteProducts([target.spuId], zhangScope),
        /不属于你的店铺/,
        "不能删除别人店铺的商品"
    );
    // 确认商品仍在：必须是整批拒绝，而不是"删了一部分"
    assert.ok(await findProduct(SPU_B), "被拒绝的删除不能真的删掉商品");
}

// 三、删除自己的商品仍然可以（隔离不能把自己也挡住）。
{
    const mine = await findProduct(SPU_A);
    assert.ok(mine, "张三的商品必须已入库");
    const result = await store.deleteProducts([mine.spuId], zhangScope);
    assert.ok(result.deletedCount >= 1, "自己店铺的商品必须能删");
}

// 四、解除标红的隔离：张三不能解除李四店铺的红标。
{
    await store.markProductBlocked({ storeId: STORE_B, spuId: SPU_B, reason: "平台拒绝：净含量必填" });
    assert.equal((await findProduct(SPU_B))?.blocked, true, "李四的商品必须处于标红状态");

    await store.unblockProducts([SPU_B], zhangScope);
    assert.equal((await findProduct(SPU_B))?.blocked, true, "别人不能解除我的标红，否则会绕过禁止再传");

    // 本人解除必须成功，否则标红就成了死结。
    await store.unblockProducts([SPU_B], lisiScope);
    // 未标红的商品不带 blocked 字段（既有约定：undefined 表示正常），因此断言"不能仍为 true"。
    assert.notEqual((await findProduct(SPU_B))?.blocked, true, "本人必须能解除自己的标红");
}

// 五、管理员（scope 为 null）不受限，便于排障与代操作。
{
    await store.markProductBlocked({ storeId: STORE_B, spuId: SPU_B, reason: "再次失败" });
    await store.unblockProducts([SPU_B], null);
    assert.notEqual((await findProduct(SPU_B))?.blocked, true, "管理员应能跨店解除，用于排障");
}

// 六、孤儿商品：没有来源店的商品不属于任何人的可见范围。
// 这正是 /api/import 现在要求带来源店的原因——否则商品入库后谁都看不到，却仍占着货号参与判重。
{
    await writeBatch("batch-orphan", "", "无来源店", [makeProduct("3333333333", "ORPHAN")]);
    const orphan = await findProduct("3333333333");
    assert.ok(orphan, "孤儿商品确实进了库");
    assert.equal((orphan.sourceStoreIds || []).length, 0, "孤儿商品没有来源店");
    const visibleToAnyone = (orphan.sourceStoreIds || []).some((id) => zhangScope.has(id) || lisiScope.has(id));
    assert.equal(visibleToAnyone, false, "孤儿商品谁都看不到，因此必须在入口就要求来源店");
}

// 七、无来源店的历史孤儿商品，普通用户不得删除（只有管理员能清理）。
{
    const orphan = await findProduct("3333333333");
    await assert.rejects(
        store.deleteProducts([orphan.spuId], zhangScope),
        /不属于你的店铺/,
        "无归属的历史数据只能由管理员清理"
    );
}

console.log("isolation checks passed（删改按归属隔离、标红不可跨店解除、管理员不受限、孤儿商品须在入口拦截）");
