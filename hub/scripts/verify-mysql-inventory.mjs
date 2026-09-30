import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import mysql from "mysql2/promise";
import { openMysqlDatabase } from "../lib/mysql-database.mjs";
import { initializeMysqlSchema } from "../lib/mysql-schema.mjs";
import { createStore } from "../lib/store.mjs";
import { createMysqlInventory } from "../lib/mysql-inventory.mjs";

// 只连接固定隔离实例；随机测试库和临时目录由本脚本创建，不读取任何生产配置。
const admin = await mysql.createConnection({ host: "127.0.0.1", port: 33917, user: "root" });
const name = `temu_test_inventory_${Date.now()}_${process.pid}`;
assert.match(name, /^temu_test_inventory_\d+_\d+$/);
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
const root = await mkdtemp(path.join(tmpdir(), "temu-inventory-test-"));
const config = path.join(root, "mysql.json");
await writeFile(config, JSON.stringify({ host: "127.0.0.1", port: 33917, user: "root", database: name }));
const db = await openMysqlDatabase(config);
let racePool;
const files = path.join(root, "data", "files");
let success = false;
let abortBeforeCommit = false;
let pauseCleanup = false;
let mutationPayloadIds = new Set();
let inspectMutation = false;
let gate = null;
let fileGate = null;

/** 注入事务末尾失败和清理停机；代理仅用于测试，不改变运行时数据库接口。 */
const instrumented = {
    ...db,
    query: async (lane, sql, params) => {
        if (pauseCleanup && lane === "maintenance") throw new Error("测试模拟提交后清理中断");
        return db.query(lane, sql, params);
    },
    transaction: (lane, fn) => db.transaction(lane, async conn => {
        const wrapped = new Proxy(conn, {
            get(target, property) {
                if (property !== "query") return typeof target[property] === "function" ? target[property].bind(target) : target[property];
                return async (sql, params = []) => {
                    if (inspectMutation && lane === "ingest" && sql.startsWith("SELECT id,body FROM hub_inventory_payloads")) {
                        for (const id of params[0]) mutationPayloadIds.add(id);
                    }
                    if (gate && lane === "ingest" && sql.startsWith("SELECT id,body FROM hub_batches") && params[0]?.includes("A")) {
                        const current = gate;
                        gate = null;
                        current.entered();
                        await current.wait;
                    }
                    const result = await target.query(sql, params);
                    if (fileGate && lane === "ingest" && sql.startsWith("INSERT INTO hub_inventory_file_locks")) {
                        const current = fileGate;
                        fileGate = null;
                        current.entered();
                        await current.wait;
                    }
                    return result;
                };
            }
        });
        const result = await fn(wrapped);
        if (abortBeforeCommit && lane === "ingest") throw new Error("测试模拟 COMMIT 前中断");
        return result;
    })
};

/** 最小商品正文不依赖外部平台，来源区分和红标投影仍经过真实仓库代码。 */
function product(spuId, title = spuId) {
    return { spuId, title, articleNo: spuId, productExtCodes: [spuId], skuExtCodes: [spuId],
        skus: [{ skuId: `${spuId}1`, extCode: spuId }], skuIds: [`${spuId}1`], skcIds: [`${spuId}2`],
        images: ["https://example.invalid/item.jpg"], publicationData: { sourceProduct: { productId: spuId } },
        completeness: { hasPrimaryDetail: true, hasImages: true }, captureEvidence: { primaryDetail: true } };
}

/** 原始采集包走正常入库解析，避免测试只覆盖迁移专用通道。 */
function upload(storeId, spuId) {
    return [{ originalName: `${storeId}-${spuId}.json`, payload: {
        kind: "full-capture-packet", source: { sourceStoreId: storeId },
        records: [{ payload: { result: { pageItems: [{ productId: spuId, goodsId: `${spuId}1`, productName: `${storeId}-${spuId}` }] } } }]
    } }];
}

/** 只等待本测试的确定事件；超时会报错，不把锁阻塞误判为成功。 */
async function bounded(promise, message) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 4000); })]); }
    finally { clearTimeout(timer); }
}

/** 可选五千件单店基准；正文为合成数据，分别报告迁移、在线操作与事件循环停顿。 */
async function verifyScale5000(store) {
    const source = "SCALE-5000";
    const count = 5000;
    const timings = {};
    const loop = monitorEventLoopDelay({ resolution: 10 });
    let peakRss = process.memoryUsage().rss;
    const rssBefore = peakRss;
    const sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
    loop.enable();
    // 每个阶段只记录完成后的实测耗时，失败不输出伪成功的容量结论。
    const measure = async (label, fn) => {
        const start = performance.now();
        const result = await fn();
        timings[label] = Math.round(performance.now() - start);
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
        console.log(JSON.stringify({ scalePhase: label, elapsedMs: timings[label] }));
        return result;
    };
    try {
        const products = Array.from({ length: count }, (_, n) => {
            const item = product(String(9700000000 + n), `规模商品-${n}`);
            item.publicationData.sourceProduct.description = `${n}:` + "scale-data-".repeat(205);
            return item;
        });
        const index = { version: 1, batches: [{ id: "scale-5000", sourceStoreId: source,
            createdAt: new Date().toISOString(), products, files: [] }], products: [] };
        const inputBytes = Buffer.byteLength(JSON.stringify(index));
        const migrated = await measure("migrationMs", () => store.importLegacyIndex(index));
        assert.equal(migrated.products, count);
        const scope = new Set([source]);
        const pageTimes = [];
        for (let n = 0; n < 22; n++) {
            const start = performance.now();
            const page = await store.listOverviewPage(scope, new URL(`http://local/?productLimit=100&productOffset=${(n % 5) * 1000}`));
            assert.equal(page.productCount, count);
            assert.equal(page.products.length, 100);
            if (n >= 2) pageTimes.push(performance.now() - start);
        }
        pageTimes.sort((a, b) => a - b);
        timings.pageP50Ms = Math.round(pageTimes[9]);
        timings.pageP95Ms = Math.round(pageTimes[18]);
        await measure("markOneMs", () => store.markProductBlocked({ storeId: source, spuId: "9700000000", reason: "五千件下单商品标红" }));
        assert.equal((await store.getProduct("9700000000")).product.blocked, true);
        await measure("incrementOneMs", () => store.importFiles(upload(source, "9700050001"), { sourceStoreId: source }));
        assert.equal((await store.listOverviewPage(scope, new URL("http://local/?productLimit=0"))).productCount, count + 1);
        mutationPayloadIds = new Set();
        inspectMutation = true;
        try {
            await measure("otherSourceOneMs", () => store.importFiles(upload("SCALE-OTHER", "9800000001"), { sourceStoreId: "SCALE-OTHER" }));
        } finally { inspectMutation = false; }
        assert.equal(mutationPayloadIds.size, 0, "异店入库不能载入五千件来源或任何已有正文");
        return { products: count, inputBytes, pageSamples: 20, ...timings,
            otherSourcePayloadReads: mutationPayloadIds.size, eventLoopMaxMs: Math.round(loop.max / 1e6),
            rssBeforeMB: Math.round(rssBefore / 1048576), peakRssMB: Math.round(peakRss / 1048576) };
    } finally {
        inspectMutation = false;
        loop.disable();
        clearInterval(sampler);
    }
}

try {
    await initializeMysqlSchema(db);
    await mkdir(files, { recursive: true });
    await writeFile(path.join(files, "shared.json"), JSON.stringify({ evidence: true }));
    const store = createStore(root, { database: instrumented });
    await store.ensure();
    const initial = { version: 1, batches: ["A", "B"].map((id, n) => ({
        id: `batch-${id}`, sourceStoreId: id, createdAt: new Date(Date.now() - n * 1000).toISOString(),
        products: [product(String(10001 + n))], files: [{ storedName: process.platform === "win32" && id === "B" ? "SHARED.JSON" : "shared.json", originalName: "shared.json" }]
    })), products: [] };
    await store.importLegacyIndex(structuredClone(initial));
    // 留下故意过期的 JSON；所有 SQL 标红、解红、删店必须忽略它。
    const legacyPath = path.join(root, "data", "index.json");
    const legacyText = JSON.stringify({ version: 1, batches: [], products: [] });
    await writeFile(legacyPath, legacyText);
    await store.importFiles(upload("A", "11001"), { sourceStoreId: "A" });
    const [beforeMark] = await db.query("query", "SELECT id,digest FROM hub_batches WHERE store_id='A' ORDER BY id");
    await store.markProductBlocked({ storeId: "A", spuId: "11001", reason: "隔离标红" });
    const [afterMark] = await db.query("query", "SELECT id,digest FROM hub_batches WHERE store_id='A' ORDER BY id");
    assert.deepEqual(afterMark, beforeMark, "只改红标不能使未修改批次摘要发生变化");
    assert.equal((await store.getProduct("11001")).product.blocked, true);
    assert.ok(await store.getBatch("batch-B"));
    await store.clearProductBlocked("A", ["11001"]);
    assert.notEqual((await store.getProduct("11001")).product.blocked, true);
    await store.markProductBlocked({ storeId: "A", spuId: "11001", reason: "再次标红" });
    assert.equal((await store.unblockProducts(["11001"], new Set(["B"]))).cleared, 0);
    assert.equal((await store.unblockProducts(["11001"], new Set(["A"]))).cleared, 1);
    assert.equal(await readFile(legacyPath, "utf8"), legacyText);
    await rm(legacyPath);
    await store.markProductBlocked({ storeId: "A", spuId: "11001", reason: "旧 JSON 缺失" });
    await store.deleteStoreData("A", { keepProducts: true });
    assert.notEqual((await store.getProduct("11001")).product.blocked, true);
    assert.equal((await store.storeDataImpact("A")).productCount, 2);

    // 其他来源的正文损坏也不应影响 A 入库；同时记录实际解压的 payload 集合。
    const [foreign] = await db.query("query", `SELECT p.id,p.body FROM hub_inventory_payloads p WHERE p.id IN (
        SELECT payload_id FROM hub_products WHERE store_id='B' UNION
        SELECT p.payload_id FROM hub_batch_products p JOIN hub_batches b ON p.batch_id=b.id WHERE b.store_id='B')`);
    for (const row of foreign) await db.query("maintenance", "UPDATE hub_inventory_payloads SET body=? WHERE id=?", [Buffer.from("invalid-gzip"), row.id]);
    inspectMutation = true;
    await store.importFiles(upload("A", "11002"), { sourceStoreId: "A" });
    await store.markProductBlocked({ storeId: "A", spuId: "11002", reason: "只读 A 正文" });
    inspectMutation = false;
    for (const row of foreign) {
        assert.equal(mutationPayloadIds.has(row.id), false, "不应读取其他来源的压缩正文");
        await db.query("maintenance", "UPDATE hub_inventory_payloads SET body=? WHERE id=?", [row.body, row.id]);
    }
    await assert.rejects(store.importFiles(upload("B", "11002"), { sourceStoreId: "B" }), /SPU来源店冲突/);
    assert.equal(await readFile(legacyPath, "utf8").catch(error => error.code), "ENOENT");

    // A 已获取来源锁并停在读取前时，B 必须能独立入库并提交。
    let entered;
    let release;
    const enteredPromise = new Promise(resolve => { entered = resolve; });
    gate = { entered, wait: new Promise(resolve => { release = resolve; }) };
    const waitingA = store.importFiles(upload("A", "11003"), { sourceStoreId: "A" });
    try {
        await bounded(enteredPromise, "A 未进入来源事务");
        const other = createStore(root, { database: db });
        await other.ensure();
        await bounded(other.importFiles(upload("B", "12001"), { sourceStoreId: "B" }), "无关来源 B 被 A 的全局锁阻塞");
    } finally { release(); await waitingA; }

    // 业务回滚必须保留原引用和文件，待清理项也必须一并回滚。
    const doomed = await store.importFiles(upload("C", "13001"), { sourceStoreId: "C" });
    const doomedFile = path.join(files, doomed.batch.files[0].storedName);
    abortBeforeCommit = true;
    await assert.rejects(store.deleteStoreData("C", { keepProducts: false }), /COMMIT 前中断/);
    abortBeforeCommit = false;
    await access(doomedFile);
    assert.ok(await store.getProduct("13001"));
    const [[pendingRollback]] = await db.query("query", "SELECT COUNT(*) AS n FROM hub_inventory_file_gc WHERE stored_name=?", [doomed.batch.files[0].storedName]);
    assert.equal(Number(pendingRollback.n), 0);

    // 模拟提交后进程退出：引用已删而文件仍在，新实例启动必须消费持久化队列。
    pauseCleanup = true;
    await store.deleteStoreData("C", { keepProducts: false });
    assert.equal(await store.getProduct("13001"), null);
    await access(doomedFile);
    const [[pendingCrash]] = await db.query("query", "SELECT COUNT(*) AS n FROM hub_inventory_file_gc WHERE stored_name=?", [doomed.batch.files[0].storedName]);
    assert.equal(Number(pendingCrash.n), 1);
    // 物理删除失败不得丢弃候选或让已提交删除恢复成业务失败。
    await createMysqlInventory(db, { removeFile: async () => { throw new Error("测试模拟文件暂不可删"); } }).cleanup();
    const [[pendingFailure]] = await db.query("query", "SELECT COUNT(*) AS n FROM hub_inventory_file_gc WHERE stored_name=?", [doomed.batch.files[0].storedName]);
    assert.equal(Number(pendingFailure.n), 1);
    pauseCleanup = false;
    await createStore(root, { database: db }).ensure();
    await assert.rejects(access(doomedFile), { code: "ENOENT" });

    // 删除一边的共享文件引用不能删另一来源证据，最后一个引用消失后才允许删除。
    await store.deleteProducts(["10001"], new Set(["A"]));
    await access(path.join(files, "shared.json"));
    assert.ok(await store.getProduct("10002"));
    await store.deleteProducts(["10002"], new Set(["B"]));
    await assert.rejects(access(path.join(files, "shared.json")), { code: "ENOENT" });

    // 队列尚未清理时再次引用同一原文件，恢复清理必须保留新引用。
    const again = await store.importFiles(upload("D", "14001"), { sourceStoreId: "D" });
    pauseCleanup = true;
    await store.deleteStoreData("D", { keepProducts: false });
    let fileEntered;
    let releaseFile;
    const fileEnteredPromise = new Promise(resolve => { fileEntered = resolve; });
    fileGate = { entered: fileEntered, wait: new Promise(resolve => { releaseFile = resolve; }) };
    const reimport = store.importFiles(upload("D", "14001"), { sourceStoreId: "D" });
    let concurrentCleanup;
    try {
        await bounded(fileEnteredPromise, "重新引用没有取得文件锁");
        concurrentCleanup = createMysqlInventory(db, { removeFile: storedName => rm(path.join(files, storedName), { force: true }) }).cleanup(128);
    } finally { releaseFile(); await reimport; }
    await bounded(concurrentCleanup, "提交后并发清理没有结束");
    pauseCleanup = false;
    await store.cleanupInventory(128);
    await access(path.join(files, again.batch.files[0].storedName));
    assert.ok(await store.getProduct("14001"));
    // 迁移保留历史跨店同 SPU；限定 X 删除时连 Y 的压缩正文也不应读取。
    await store.importLegacyIndex({ version: 1, batches: ["X", "Y"].map(id => ({
        id: `history-${id}`, sourceStoreId: id, createdAt: new Date().toISOString(),
        products: [product("15001", id)], files: []
    })), products: [] });
    assert.equal((await store.storeDataImpact("X")).sharedProductCount, 1);
    const [otherSource] = await db.query("query", "SELECT id,body FROM hub_inventory_payloads WHERE id IN (SELECT payload_id FROM hub_products WHERE store_id='Y')");
    for (const row of otherSource) await db.query("maintenance", "UPDATE hub_inventory_payloads SET body=? WHERE id=?", [Buffer.from("invalid-gzip"), row.id]);
    await store.deleteProducts(["15001"], null, { storeIds: ["X"] });
    for (const row of otherSource) await db.query("maintenance", "UPDATE hub_inventory_payloads SET body=? WHERE id=?", [row.body, row.id]);
    assert.ok(await store.getBatch("history-Y"));
    assert.equal(await store.getBatch("history-X"), null);

    // 未映射批次只能按实例回填；回填后投影、来源索引和红标读写应在新店内闭合。
    const pending = upload("", "16001");
    const captured = await store.importFiles(pending, { source: "extension-ingest", pluginInstanceId: "pending-instance" });
    assert.equal((await store.attachSourceStore({ sourceStoreId: "M", pluginInstanceId: "wrong-instance" })).updated, 0);
    assert.equal((await store.attachSourceStore({ sourceStoreId: "M", pluginInstanceId: "pending-instance" })).updated, 1);
    assert.equal((await store.getBatch(captured.batch.id)).sourceStoreId, "M");
    await store.markProductBlocked({ storeId: "M", spuId: "16001", reason: "回填后仍可标红" });
    assert.equal((await store.getProduct("16001")).product.blocked, true);

    // 两百个真实并发请求共用已有锁行，验证没有 INSERT IGNORE 的共享锁升级死锁。
    racePool = mysql.createPool({ host: "127.0.0.1", port: 33917, user: "root", database: name, connectionLimit: 16, queueLimit: 0 });
    const raceDatabase = {
        query: (_lane, sql, params) => racePool.query(sql, params),
        transaction: async (_lane, fn) => {
            const conn = await racePool.getConnection();
            try {
                await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
                await conn.beginTransaction();
                const result = await fn(conn);
                await conn.commit();
                return result;
            } catch (error) { await conn.rollback(); throw error; }
            finally { conn.release(); }
        }
    };
    const contender = createMysqlInventory(raceDatabase);
    const concurrent = await Promise.allSettled(Array.from({ length: 200 }, () => contender.runMutation(
        () => contender.protectFile("lock-contention.json"), ["same-source"], ["same-spu"]
    )));
    assert.equal(concurrent.filter(item => item.status === "rejected").length, 0, JSON.stringify(concurrent.filter(item => item.status === "rejected").map(item => item.reason.message)));
    const marks = await Promise.all(Array.from({ length: 24 }, () => store.markProductBlocked({ storeId: "M", spuId: "16001", reason: "并发累计" })));
    assert.equal(Math.max(...marks.map(mark => mark.count)), 25, "来源锁必须防止并发红标计数丢失");
    const [[dangling]] = await db.query("query", `SELECT COUNT(*) AS n FROM hub_batch_products b LEFT JOIN hub_inventory_payloads p ON p.id=b.payload_id WHERE p.id IS NULL`);
    assert.equal(Number(dangling.n), 0);
    const scale = process.argv.includes("--scale-5000") ? await verifyScale5000(store) : undefined;
    success = true;
    console.log(JSON.stringify({ passed: true, staleJsonIgnored: true, noForeignPayloadRead: true,
        independentSourceTransactions: true, rollbackKeepsFiles: true, restartCleanup: true,
        sharedReferencesSafe: true, rereferenceSafe: true, concurrentLocks: 200, concurrentMarks: 24, ...(scale ? { scale } : {}) }));
} finally {
    if (racePool) await racePool.end();
    await db.close();
    if (success) {
        await admin.query(`DROP DATABASE ${name}`);
        // 只清理本脚本 mkdtemp 创建的目录，拒绝扩大到系统临时目录本身。
        const resolved = path.resolve(root);
        assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
        assert.ok(path.basename(resolved).startsWith("temu-inventory-test-"));
        await rm(resolved, { recursive: true, force: true });
    } else console.error(`保留隔离失败库与目录: ${name} ${root}`);
    await admin.end();
}
