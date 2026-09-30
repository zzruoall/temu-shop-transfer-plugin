/**
 * 商品按店铺分组的删除隔离回归。
 *
 * 锁住三条规则：
 *   1. 从某店铺分组删除商品，不得波及别的店铺那份同名 SPU（跨店误删）；
 *   2. 同一店铺内同货号的历史 SPU 仍要一起清掉（原有语义，防止旧 SPU 重新出现）；
 *   3. 普通用户只能删自己认领店铺的商品，管理员可跨店。
 * 全程使用临时目录与假数据，不连真实环境。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createStore } from "../lib/store.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "product-group-"));
const store = createStore(root);
await store.ensure();
const indexPath = path.join(root, "data", "index.json");
const STORE_A = "temu:634418217318103";
const STORE_B = "temu:634418210693849";

const makeBatch = (id, storeId, storeName, spu, code) => ({
    id, createdAt: new Date().toISOString(), sourceStoreId: storeId, sourceStoreName: storeName,
    status: "ready-for-map", readiness: "可导入", files: [],
    products: [{
        spuId: spu, title: `商品 ${spu}`, articleNo: code,
        productExtCodes: [code], skuExtCodes: [code],
        skus: [{ skuId: "1", extCode: code }],
        images: ["https://example.com/a.jpg"], ready: true,
        completeness: { hasSpu: true, hasTitle: true, hasSku: true, hasImages: true, hasPrimaryDetail: true }
    }]
});

/** 直接写批次，避免走解析流程。 */
async function seed(batches) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.batches = batches;
    await writeFile(indexPath, JSON.stringify(index));
}

const list = async () => (await store.listOverview()).products
    .map((product) => `${product.spuId}@${JSON.stringify(product.sourceStoreIds)}`).sort();

// 一、跨店同名 SPU：两个店各有一行，在 A 店分组删除不得碰到 B 店那份。
{
    await seed([
        makeBatch("b1", STORE_A, "A店", "1111111111", "CODE1"),
        makeBatch("b2", STORE_B, "B店", "1111111111", "CODE1"),
        makeBatch("b3", STORE_B, "B店", "2222222222", "CODE2")
    ]);
    const before = await list();
    assert.equal(before.length, 3, "前置条件：三个商品行");
    await store.deleteProducts(["1111111111"], null, { storeIds: [STORE_A] });
    const after = await list();
    assert.equal(after.length, 2, `删除后应剩两行，实际 ${JSON.stringify(after)}`);
    assert.ok(after.some((row) => row.includes("1111111111") && row.includes("634418210693849")),
        "B 店那份同名 SPU 必须保留，否则是跨店误删");
    assert.ok(after.some((row) => row.includes("2222222222")), "B 店其他商品不受影响");
}

// 二、同店内同货号的历史 SPU 仍要一起清掉，否则旧 SPU 会重新参与判重。
{
    await seed([
        makeBatch("b1", STORE_A, "A店", "1111111111", "SAME"),
        makeBatch("b2", STORE_A, "A店", "1111111112", "SAME")
    ]);
    await store.deleteProducts(["1111111111"], null, { storeIds: [STORE_A] });
    const after = await list();
    assert.equal(after.length, 0, `同店同货号应一并清除，实际 ${JSON.stringify(after)}`);
}

// 三、无归属商品（来源店已被删除）：storeIds 传空数组表示"只删无来源的那些行"。
{
    await seed([
        makeBatch("b1", STORE_A, "A店", "1111111111", "C1"),
        makeBatch("b2", "", "", "2222222222", "C2")
    ]);
    await store.deleteProducts(["2222222222"], null, { storeIds: [] });
    const after = await list();
    assert.equal(after.length, 1, `应只剩有归属的那行，实际 ${JSON.stringify(after)}`);
    assert.ok(after[0].includes(STORE_A), "有来源店的商品不能被无归属删除误伤");
}

// 四、不传 storeIds 时退回权限范围：普通用户只能删自己店的，越界整批拒绝。
{
    await seed([
        makeBatch("b1", STORE_A, "A店", "1111111111", "C1"),
        makeBatch("b2", STORE_B, "B店", "2222222222", "C2")
    ]);
    const scopeA = new Set([STORE_A]);
    await assert.rejects(store.deleteProducts(["2222222222"], scopeA), /不属于你的店铺/, "不能删别人店铺的商品");
    // 自己的仍可删（不传 storeIds，走权限范围）
    await store.deleteProducts(["1111111111"], scopeA);
    const after = await list();
    assert.equal(after.length, 1, `自己的商品应删除，实际 ${JSON.stringify(after)}`);
    assert.ok(after[0].includes("2222222222"), "别人的商品必须保留");
}

/**
 * 五、越权的 storeIds 被忽略：权限只有 A 店时，即使 storeIds 里写了 B 店，
 * 也只删 A 店那部分。
 *
 * 注意不能把 B 店的 SPU 放进 spuIds——那会触发权限校验整批拒绝（见用例四），
 * 那是"防越权"的正确行为。这里验证的是"只删权限内、且限定在指定店"的组合语义：
 * 同一个 SPU 在 A、B 各有一行，权限只有 A，请求删除该 SPU 并指定 storeIds 两家店。
 */
{
    await seed([
        makeBatch("b1", STORE_A, "A店", "1111111111", "C1"),
        makeBatch("b2", STORE_B, "B店", "1111111111", "C1")
    ]);
    const scopeA = new Set([STORE_A]);
    await store.deleteProducts(["1111111111"], scopeA, { storeIds: [STORE_A, STORE_B] });
    const after = await list();
    assert.ok(!after.some((row) => row.includes("1111111111") && row.includes("634418217318103")),
        "权限内 A 店那份应删除");
    assert.ok(after.some((row) => row.includes("1111111111") && row.includes("634418210693849")),
        "权限外的 B 店那份不能因 storeIds 越权而被删");
}

console.log("product store-scope checks passed（跨店不误删、同店同货号一并清、无归属仅删无来源、权限边界有效）");
