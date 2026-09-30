/**
 * 大量商品与店铺分页回归。
 *
 * 重点锁住服务端筛选后再分页：关键词和状态条件必须命中未加载页，
 * 总数、最后一页和越界结果也不能被浏览器当前 DOM 的数量误导。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJobQueue } from "../lib/job-queue.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRODUCT_COUNT = 125;
const STORE_COUNT = 110;
const INSTANCE_ID = `pagination-${Date.now()}`;

async function pickFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const port = server.address()?.port;
            server.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

async function fetchJson(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    assert.equal(response.ok, true, `${url} 返回 HTTP ${response.status}: ${text}`);
    return body;
}

async function waitForServer(child, origin) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < 12000) {
        if (child.exitCode != null) throw new Error(`服务提前退出：${child.exitCode}`);
        try {
            const body = await fetchJson(`${origin}/api/ingest-info`);
            if (body?.instanceId === INSTANCE_ID) return;
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 120));
    }
    throw lastError || new Error("服务未在限定时间内启动");
}

async function stopServer(child) {
    if (!child || child.exitCode != null) return;
    child.kill();
    await new Promise((resolve) => {
        const timer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            resolve();
        }, 4000);
        child.once("exit", () => {
            clearTimeout(timer);
            resolve();
        });
    });
}

const dataRoot = await mkdtemp(path.join(os.tmpdir(), "shop-hub-pagination-"));
const filesDir = path.join(dataRoot, "data", "files");
await mkdir(filesDir, { recursive: true });

const batches = Array.from({ length: PRODUCT_COUNT }, (_, index) => {
    const storeId = `store-${String(index % STORE_COUNT).padStart(3, "0")}`;
    const spuId = String(7000000000 + index);
    return {
        id: `batch-${index}`,
        createdAt: new Date(Date.now() - index * 1000).toISOString(),
        label: `分页批次 ${index}`,
        shopName: storeId,
        sourceStoreId: storeId,
        sourceStoreName: storeId,
        status: "ready-for-map",
        readiness: "可导入",
        files: [],
        counts: { spu: 1 },
        products: [{
            spuId,
            goodsId: String(9000000 + index),
            title: `分页商品 ${index}`,
            articleNo: `CODE-${index}`,
            productExtCodes: [`CODE-${index}`],
            skuExtCodes: [`SKU-${index}`],
            skus: [{ skuId: String(index + 1), extCode: `SKU-${index}` }],
            images: [`https://example.com/${index}.jpg`],
            detail: { detailHtml: `<p>${index}</p>` },
            completeness: { hasSpu: true, hasTitle: true, hasSku: true, hasImages: true, hasPrimaryDetail: true },
            ready: true
        }]
    };
});
const blockedSpu = batches[PRODUCT_COUNT - 1].products[0].spuId;
const blockedStoreId = batches[PRODUCT_COUNT - 1].sourceStoreId;
await writeFile(path.join(dataRoot, "data", "index.json"), JSON.stringify({
    version: 1,
    batches,
    products: [],
    blockedProducts: {
        [`${blockedStoreId}\u0000${blockedSpu}`]: {
            reason: "分页标红验证",
            at: new Date().toISOString()
        }
    }
}, null, 2), "utf8");

const queue = createJobQueue(dataRoot, {
    async listOverview() { return { products: [] }; },
    async getBatch() { return null; }
});
for (let index = 0; index < STORE_COUNT; index += 1) {
    const storeId = `store-${String(index).padStart(3, "0")}`;
    await queue.registerAgent({
        pluginInstanceId: `pagination-agent-${index}`,
        pluginVersion: "10.10.61",
        pluginDetected: true,
        identityMatched: true,
        storeId,
        storeName: storeId,
        pageStoreName: storeId,
        pageUrl: "https://agentseller.temu.com/goods/list",
        source: "verify"
    });
}
// 同一店铺可能残留旧插件实例，目录总数必须仍按店铺计算，不能把旧心跳算成额外目标店。
for (const index of [0, STORE_COUNT - 1]) {
    const storeId = `store-${String(index).padStart(3, "0")}`;
    await queue.registerAgent({
        pluginInstanceId: `pagination-agent-duplicate-${index}`,
        pluginVersion: "10.10.61",
        pluginDetected: true,
        identityMatched: true,
        storeId,
        storeName: storeId,
        pageStoreName: storeId,
        pageUrl: "https://agentseller.temu.com/goods/list",
        source: "verify-duplicate"
    });
}

let child = null;
try {
    const port = await pickFreePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["server.mjs"], {
        cwd: rootDir,
        env: {
            ...process.env,
            ZINIAO_BIND: "127.0.0.1",
            ZINIAO_PORT: String(port),
            ZINIAO_DATA_ROOT: dataRoot,
            ZINIAO_SKIP_SEED: "1",
            ZINIAO_INSTANCE_ID: INSTANCE_ID,
            ZINIAO_WATCH_DIR: path.join(dataRoot, "inbox")
        },
        stdio: ["ignore", "ignore", "ignore"]
    });
    await waitForServer(child, origin);
    if (process.argv.includes("--serve")) {
        console.log(`PAGINATION_FIXTURE_URL=${origin}`);
        await new Promise((resolve) => {
            process.once("SIGINT", resolve);
            process.once("SIGTERM", resolve);
        });
        process.exitCode = 0;
    }

    if (!process.argv.includes("--serve")) {
    const productsFirst = await fetchJson(`${origin}/api/overview?productLimit=50&productOffset=0`);
    assert.equal(productsFirst.productCount, PRODUCT_COUNT, "商品总数必须保持为全库存数量");
    assert.equal(productsFirst.productTotal, PRODUCT_COUNT, "无筛选时商品结果总数应等于库存总数");
    assert.equal(productsFirst.products.length, 50, "商品首屏必须只返回一页");
    assert.equal(productsFirst.productsHasMore, true, "商品首页必须标记还有后续页");

    const productsLast = await fetchJson(`${origin}/api/overview?productLimit=50&productOffset=100`);
    assert.equal(productsLast.products.length, 25, "商品最后一页应只返回剩余记录");
    assert.equal(productsLast.productsHasMore, false, "商品最后一页不能继续标记 hasMore");

    const productsBeyond = await fetchJson(`${origin}/api/overview?productLimit=50&productOffset=500`);
    assert.deepEqual(productsBeyond.products, [], "商品越界页必须为空");
    assert.equal(productsBeyond.productTotal, PRODUCT_COUNT, "越界页仍要返回准确总数");
    assert.equal(productsBeyond.productsHasMore, false, "商品越界页不能标记 hasMore");

    const searched = await fetchJson(`${origin}/api/overview?productLimit=20&productOffset=0&productQ=${encodeURIComponent("分页商品 120")}`);
    assert.equal(searched.productTotal, 1, "商品搜索必须命中未加载页的记录");
    assert.equal(searched.products[0].spuId, batches[120].products[0].spuId, "搜索应返回目标商品");

    const blocked = await fetchJson(`${origin}/api/overview?productLimit=20&productOffset=0&blocked=blocked`);
    assert.equal(blocked.productTotal, 1, "标红筛选必须在服务端统计完整结果");
    assert.equal(blocked.products[0].spuId, blockedSpu, "标红筛选应返回标记商品");

    const storesFirst = await fetchJson(`${origin}/api/stores?view=all&limit=40&offset=0&online=1`);
    assert.equal(storesFirst.total, STORE_COUNT, "店铺筛选总数必须来自完整集合");
    assert.equal(storesFirst.stores.length, 40, "店铺首屏必须只返回一页");
    assert.equal(storesFirst.hasMore, true, "店铺首页必须标记还有后续页");

    const storesLast = await fetchJson(`${origin}/api/stores?view=all&limit=40&offset=100&online=1`);
    assert.equal(storesLast.stores.length, 10, "店铺最后一页应只返回剩余记录");
    assert.equal(storesLast.hasMore, false, "店铺最后一页不能继续标记 hasMore");

    const agents = await fetchJson(`${origin}/api/agents?online=1&receivable=1&limit=40&offset=0`);
    assert.equal(agents.total, STORE_COUNT, "插件目录总数必须覆盖完整在线店铺");
    assert.equal(agents.agents.length, 40, "插件目录必须按页返回");
    assert.equal(agents.hasMore, true, "插件目录必须返回后续页标记");

    const agentsLast = await fetchJson(`${origin}/api/agents?online=1&receivable=1&limit=40&offset=100`);
    assert.equal(agentsLast.agents.length, 10, "目标店铺最后一页应只返回剩余记录");
    assert.equal(agentsLast.hasMore, false, "目标店铺最后一页不能继续标记 hasMore");

    const agentsCapped = await fetchJson(`${origin}/api/agents?online=1&receivable=1&limit=500&offset=0`);
    assert.equal(agentsCapped.limit, 200, "目标店铺分页必须限制单页上限");
    assert.equal(agentsCapped.agents.length, 110, "单页上限超过总数时应返回全部记录");

    console.log("data pagination checks passed（125 商品 / 110 店铺的服务端筛选与分页）");
    }
} finally {
    await stopServer(child);
    await rm(dataRoot, { recursive: true, force: true });
}
