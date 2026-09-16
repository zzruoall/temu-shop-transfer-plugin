import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, utimes, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboxWatcher } from "../lib/inbox-watcher.mjs";
import { createDownloadDirectoryDiscovery } from "../lib/ziniao-downloads.mjs";
import { createStore } from "../lib/store.mjs";

// 全部文件写入独立临时目录，验证真实下载目录链路时不触碰正式仓库与用户删除记录。
const root = await mkdtemp(path.join(os.tmpdir(), "ziniao-download-discovery-"));
const folder = path.join(root, "shop", "temu-local-dataset");
await mkdir(folder, { recursive: true });
const packet = { kind: "full-capture-packet", records: [] };
const writePacket = name => writeFile(path.join(folder, name), JSON.stringify(packet));
await writePacket("temu-full-capture-old.json");
const old = new Date(Date.now() - 3 * 86400000);
await utimes(path.join(folder, "temu-full-capture-old.json"), old, old);
await writePacket("temu-full-capture-current.json");
await writeFile(path.join(folder, "temu-capture-logs.json"), "{}");
await writeFile(path.join(folder, "temu-full-capture-fake.json"), "{}");
await writeFile(path.join(folder, "temu-full-capture-partial.json.crdownload"), "{");
let cliFails = false;
let queried = 0;
const discovery = createDownloadDirectoryDiscovery(async args => {
    if (cliFails) throw new Error("offline");
    queried++;
    assert.deepEqual(args.slice(0, 2), ["page", "extract"]);
    const data = args.includes("running") ? { items: [{ storeId: "123" }, { storeId: "bad&command" }] }
        : { downloadFolderPath: path.dirname(folder), running: true, storeId: "123" };
    return { stdout: JSON.stringify({ ok: true, data }) };
});
assert.deepEqual((await discovery()).directories, [folder]);
assert.equal(queried, 2);
let imports = [];
const options = { directories: [], checkpointPath: path.join(root, "checkpoint.json"),
    discoverDirectories: discovery, discoveryIntervalMs: 500, stableMs: 300,
    importFiles: async uploads => {
        imports.push(uploads[0].originalName);
        return { batch: { id: "test", products: [{ spuId: "123" }] } };
    } };
const pause = () => new Promise(resolve => setTimeout(resolve, 350));
const watcher = createInboxWatcher(options);
await watcher.scan();
await pause();
await watcher.scan();
await pause();
await watcher.scan();
assert.deepEqual(imports, ["temu-full-capture-current.json"]);
assert.equal(watcher.snapshot().failed, 1);
assert.equal(watcher.snapshot().skipped, 1);
assert.equal(watcher.snapshot().recent.find(item => item.status === "imported").productCount, 1);
await watcher.scan();
assert.equal(watcher.snapshot().failed, 1, "无效文件失败重试必须退避");
// 重启后不重新入库；离线时新文件仍从已保存目录进入，不依赖店铺持续打开。
cliFails = true;
const restarted = createInboxWatcher(options);
await restarted.scan();
await pause();
await writePacket("temu-full-capture-next.json");
await restarted.scan();
await pause();
await restarted.scan();
assert.deepEqual(imports, ["temu-full-capture-current.json", "temu-full-capture-next.json"]);
assert.match(restarted.snapshot().discoveryError, /CLI/);
const checkpoint = JSON.parse(await readFile(options.checkpointPath));
assert.ok(checkpoint.entries.some(([, entry]) => entry.reason === "historical_before_onboarding"));
const explicitFolder = path.join(root, "explicit-only");
const explicit = createInboxWatcher({ ...options, directories: [explicitFolder], discoverDirectories: null });
await explicit.scan();
assert.deepEqual(explicit.snapshot().directories, [explicitFolder], "显式目录不得恢复旧监控范围");
const anotherExplicit = createInboxWatcher({ ...options, directories: [path.join(root, "explicit-B")], discoverDirectories: null });
await anotherExplicit.scan();
assert.deepEqual(anotherExplicit.snapshot().directories, [path.join(root, "explicit-B")]);
// 损坏的检查点必须阻止自动重放，不自动删除或重置。
await copyFile(options.checkpointPath, `${options.checkpointPath}.test-backup`);
await writeFile(options.checkpointPath, "broken");
await assert.rejects(() => createInboxWatcher(options).scan());
const corruptWatcher = createInboxWatcher(options);
await corruptWatcher.start();
assert.ok(corruptWatcher.snapshot().lastError, "检查点错误需公开而不阻止网站启动");
corruptWatcher.stop();
assert.equal(imports.length, 2);
// 用真实仓库验证彻底删除后同包可重新入库：旧批次和文件已清除，不会再用旧指纹拦截新内容。
const store = createStore(path.join(root, "real-store"));
const realPacket = { kind: "full-capture-packet", schemaVersion: 4,
    products: [{ spuId: "7744886733", title: "测试商品" }],
    records: [{ dataType: "product-list", responseBody: { spuId: "7744886733", productName: "测试商品" } }] };
const upload = [{ originalName: "temu-full-capture-real.json", payload: realPacket }];
await store.importFiles(upload, {
    source: "local-inbox",
    sourceStoreId: "store-real",
    sourceStoreName: "真实验证店"
});
const beforeDelete = await store.listOverview();
assert.ok(beforeDelete.productCount > 0);
await store.deleteProducts(beforeDelete.products.map(item => item.spuId));
assert.equal((await store.listOverview()).productCount, 0);
const repeated = await store.importFiles(upload, {
    source: "local-inbox",
    sourceStoreId: "store-real",
    sourceStoreName: "真实验证店"
});
assert.equal(repeated.reused, false);
assert.equal((await store.listOverview()).productCount, 1);
console.log("download directory discovery, history guard, restart, offline, packet validation checks passed");
