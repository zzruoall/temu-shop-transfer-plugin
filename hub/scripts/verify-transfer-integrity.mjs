/** 仅使用临时仓库与模拟浏览器存储，验证未知结构传输及损坏拦截，不调用真实平台。 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transferHash, transferManifest, verifyTransferManifest } from "../lib/transfer-integrity.mjs";
import { createStore } from "../lib/store.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";
import { redactSensitive } from "../lib/parse-capture.mjs";

const root = await mkdtemp(path.join(tmpdir(), "temu-transfer-integrity-"));
let database, admin, databaseName;
try {
    // 可选 MySQL 验证严格限定专用测试端口及随机库，绝不读取生产连接配置。
    if (process.argv.includes("--mysql")) {
        const mysql = (await import("mysql2/promise")).default;
        admin = await mysql.createConnection({ host: "127.0.0.1", port: 33917, user: "root" });
        databaseName = `temu_integrity_${Date.now()}`;
        await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        const config = path.join(root, "mysql.json");
        await writeFile(config, JSON.stringify({ host: "127.0.0.1", port: 33917, user: "root", database: databaseName }));
        database = await (await import("../lib/mysql-database.mjs")).openMysqlDatabase(config);
        await (await import("../lib/mysql-schema.mjs")).initializeMysqlSchema(database);
    }
    let nested = { value: null, values: [false, 0, "", { custom: "完整原值" }] };
    for (let i = 0; i < 30; i++) nested = { next: nested };
    const source = { productId: "1234567890", arbitrary: nested, goodsLayerDecorationVOList: [{ lang: "zh", key: "DecImage", type: "image", contentList: [{ imgUrl: "https://example.com/a.jpg", text: null }] }] };
    const packet = { kind: "full-capture-packet", schemaVersion: 5, source: { sourceStoreId: "temu:111", shopName: "source" }, products: [{ spuId: source.productId }], records: [{ dataType: "product-detail", identity: { productIds: [source.productId] }, source: { pageProductId: source.productId, requestUrl: "https://agentseller.temu.com/visage-agent-seller/product/query" }, payload: { success: true, result: source } }] };
    const manifest = transferManifest(packet);
    assert.equal(verifyTransferManifest(packet, manifest), true);
    assert.equal(verifyTransferManifest(packet, null), false);
    assert.throws(() => verifyTransferManifest({ ...packet, schemaVersion: 9 }, manifest), /摘要/);
    assert.equal(transferHash({ z: null, a: [1, 2] }), transferHash({ a: [1, 2], z: null }));
    assert.notEqual(transferHash([1, 2]), transferHash([2, 1]));
    assert.deepEqual(redactSensitive(source), source, "深层未知字段不能被截断");
    const store = createStore(root, { database });
    const { batch } = await store.importFiles([{ originalName: "temu-full-capture-integrity.json", payload: packet }]);
    assert.equal(batch.products.length, 1);
    const product = batch.products[0];
    assert.equal(product.ready, false, "故意不提供标题、SKU和固定详情字段");
    assert.deepEqual(product.publicationData.sourceProduct, source);
    await store.verifyBatchTransfer(batch, batch.products);
    const changed = structuredClone(product);
    changed.publicationData.sourceProduct.arbitrary = "损坏";
    await assert.rejects(store.verifyBatchTransfer(batch, [changed]), /不一致/);
    const legacy = structuredClone(changed);
    legacy.publicationData.schemaVersion = 1;
    const [recovered] = await store.verifyBatchTransfer(batch, [legacy]);
    assert.deepEqual(recovered.publicationData.sourceProduct, source, "旧派生快照从原包重建，不能把错误字段继续下发");
    assert.equal(recovered.publicationData.restoredFromOriginal, true);
    await assert.rejects(store.verifyBatchTransfer({ ...batch, sourceStoreId: "temu:wrong" }, [product]), /来源店铺/);
    await assert.rejects(store.verifyBatchTransfer({ ...batch, files: [] }, [product]), /原始采集文件/);
    const queue = createJobQueue(root, store, { database });
    const identity = { storeId: "temu:222", storeName: "target", pageStoreName: "target", pluginInstanceId: "integrity-test", pluginVersion: "10.10.65", schedulingProtocol: 1, pluginDetected: true, identityMatched: true, executionMode: "plugin-api", mallId: "222" };
    await queue.registerAgent(identity);
    const input = { sourceStoreId: "temu:111", targetStoreId: identity.storeId, targetStoreName: "target", sourceBatchId: batch.id, spuIds: [source.productId], requireOnline: true, directCreate: true, complianceVersion: "V2.0" };
    await assert.rejects(queue.createJob({ ...input, sourceStoreId: "wrong" }), /来源店/);
    const job = await queue.createJob({ ...input, requestId: 'manual-click-integrity-1' });
    assert.equal((await queue.createJob({ ...input, requestId: 'manual-click-integrity-1' })).id, job.id, '同次请求重传复用原任务');
    assert.equal(job.items[0].status, "queued", "ready=false 仍必须可以下发");
    const { claimed } = await queue.claimJobs({ ...identity, claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: 0, pendingUploadBytes: 0 });
    assert.equal(claimed.length, 1);
    const task = claimed[0];
    assert.equal(verifyTransferManifest(task.snapshot, task.transferIntegrity), true);
    assert.deepEqual(task.snapshot.publicationData.sourceProduct, source);
    const base = { ...identity, jobId: job.id, spuId: product.spuId, claimToken: task.claimToken };
    const begin = { ...base, phase: "begin", requestHash: "a".repeat(64), mallId: "222", authorizationKey: "integrity-once-key" };
    await assert.rejects(queue.directProgress(begin), /完整接收/);
    await assert.rejects(queue.reportProgress({ ...base, status: "received" }), /摘要/);
    await assert.rejects(queue.reportProgress({ ...base, status: "received", snapshotSha256: "0".repeat(64) }), /摘要/);
    await queue.reportProgress({ ...base, status: "received", snapshotSha256: task.transferIntegrity.sha256 });
    assert.ok((await queue.directProgress(begin)).attemptId);

    // 新点击不覆盖旧任务，即使旧商品正在提交；执行安全仍由各自尝试凭证保护。
    const previous = await queue.getJob(job.id);
    const resend = await queue.createJob({ ...input, requestId: 'manual-click-integrity-2' });
    assert.notEqual(resend.id, job.id);
    assert.deepEqual(await queue.getJob(job.id), previous);
    assert.equal((await queue.createJob({ ...input, requestId: 'manual-click-integrity-2' })).id, resend.id);

    const helper = await readFile(new URL("../../plugin/transfer-integrity.js", import.meta.url), "utf8");
    const background = await readFile(new URL("../../plugin/background.js", import.meta.url), "utf8");
    const start = background.indexOf("async function saveTargetUploadTasks(");
    const end = background.indexOf("async function updateDirectTaskProgress", start);
    assert.ok(start > 0 && end > start);
    const storage = {};
    let corruptRead = false;
    const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder, console, TARGET_UPLOAD_TASKS_KEY: "tasks", MAX_TARGET_UPLOAD_TASKS: 30, MAX_TARGET_UPLOAD_TASKS_BYTES: 4 * 1024 * 1024,
        getUtf8ByteLength: text => Buffer.byteLength(text), getTargetUploadTasks: async () => structuredClone(storage.tasks || []),
        chrome: { storage: { local: { set: async data => Object.assign(storage, structuredClone(data)), get: async key => ({ [key]: corruptRead ? [] : structuredClone(storage[key]) }), remove: async () => {} } } } });
    vm.runInContext(helper + "\n" + background.slice(start, end), context);
    assert.equal(await context.TemuTransferIntegrity.hash(packet), manifest.sha256, "两端使用相同规范摘要");
    context.incoming = structuredClone([task]);
    await vm.runInContext("receiveTargetUploadTasks(incoming, 'temu:222')", context);
    assert.equal(storage.tasks[0].transferIntegrity.sha256, task.transferIntegrity.sha256);
    context.incoming[0].snapshot.publicationData.sourceProduct.extra = "损坏";
    await assert.rejects(vm.runInContext("receiveTargetUploadTasks(incoming, 'temu:222')", context), /摘要/);
    assert.equal(storage.tasks[0].snapshot.publicationData.sourceProduct.extra, undefined);
    context.incoming = structuredClone([task]);
    corruptRead = true;
    await assert.rejects(vm.runInContext("receiveTargetUploadTasks(incoming, 'temu:222')", context), /回读/);
    const originalFile = path.join(store.filesDir, batch.files[0].storedName);
    await writeFile(originalFile, JSON.stringify({ ...packet, corrupted: true }));
    await assert.rejects(store.verifyBatchTransfer(batch, [product]), /校验失败/);
    if (database) {
        const { gzipSync } = await import("node:zlib");
        await admin.query(`UPDATE ${databaseName}.hub_inventory_payloads SET body=?`, [gzipSync(JSON.stringify({ changed: true }))]);
        await assert.rejects(store.getBatch(batch.id), /校验|摘要|损坏/);
    }
    // 删除店铺记录不能引用回执局部变量；曾有补丁误放在该分支。
    await queue.deleteStoreRecord(identity.storeId);
    console.log("PASS: unknown/deep fields, ready=false dispatch, source identity, receive receipt, persisted snapshot, corruption guards; real platform calls=0");
} finally {
    if (database) await database.close();
    if (admin) { if (databaseName) await admin.query(`DROP DATABASE ${databaseName}`); await admin.end(); }
    await rm(root, { recursive: true, force: true });
}
