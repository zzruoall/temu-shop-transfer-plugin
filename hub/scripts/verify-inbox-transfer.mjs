import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInboxWatcher } from "../lib/inbox-watcher.mjs";
import { createTransferManager } from "../lib/transfer-manager.mjs";

function check(condition, message) {
    if (!condition) throw new Error(message);
}

const root = await mkdtemp(path.join(os.tmpdir(), "ziniao-inbox-transfer-"));
const inbox = path.join(root, "inbox");
await mkdir(inbox, { recursive: true });
const packet = {
    schemaVersion: 4,
    kind: "full-capture-packet",
    source: { platform: "temu", pageUrl: "https://agentseller.temu.com/goods/list", shopName: "测试店铺" },
    products: [{ spuId: "7744886733", goodsId: "9001" }],
    records: [{ eventId: "event-1", dataType: "product-list", identity: { productIds: ["7744886733"], goodsIds: ["9001"] } }]
};
let imported = 0;
const watcher = createInboxWatcher({ directories: [inbox], stableMs: 300, intervalMs: 500, importFiles: async (uploads) => {
    imported += uploads.length;
    return { reused: false, batch: { id: "batch-test" } };
} });
const fileName = "temu-full-capture-test.json";
await writeFile(path.join(inbox, fileName), JSON.stringify(packet), "utf8");
await watcher.scan();
await new Promise((resolve) => setTimeout(resolve, 350));
await watcher.scan();
check(imported === 1, "inbox watcher did not import stable packet");
check(watcher.snapshot().recent[0].batchId === "batch-test", "inbox watcher lost batch id");

const store = {
    async listOverview() {
        return { products: [{ spuId: "7744886733", ready: true }] };
    }
};
const transfer = createTransferManager(root, store, { adapters: [{ id: "fake", displayName: "fake", matchesStore: () => true }] });
await mkdir(path.join(root, "data"), { recursive: true });
await writeFile(path.join(root, "data", "transfer.json"), JSON.stringify({ stores: [{ storeId: "store-1", name: "目标店铺", platform: "Temu-中国卖家中心" }], jobs: [] }), "utf8");
const job = await transfer.createJob({ targetStoreId: "store-1", sourceBatchId: "batch-test", spuIds: ["7744886733"] });
assert.equal(job.status, "awaiting_confirmation");
assert.equal(job.preflight.readyCount, 1);
const cancelled = await transfer.cancelJob(job.id);
assert.equal(cancelled.status, "cancelled");
const state = JSON.parse(await readFile(path.join(root, "data", "transfer.json"), "utf8"));
check(state.jobs.length === 1 && state.jobs[0].status === "cancelled", "transfer job state was not persisted");

let inspectCount = 0;
const probingAdapter = {
    id: "fake-probe",
    displayName: "fake-probe",
    matchesStore: () => true,
    async inspectCreatePage({ product, screenshotPath }) {
        inspectCount += 1;
        return {
            submitted: false,
            published: false,
            detected: true,
            pageUrl: "https://agentseller.temu.com/goods/create/category",
            screenshot: screenshotPath,
            blockers: ["不会提交"],
            evidence: { spuId: product.spuId }
        };
    }
};
const readyStore = {
    async listOverview() {
        return { products: [{ spuId: "7744886733", title: "测试商品", ready: true }] };
    },
    async getProduct(spuId) {
        return { product: { spuId, title: "测试商品", ready: true } };
    }
};
const runner = createTransferManager(root, readyStore, { adapters: [probingAdapter] });
const live = await runner.createJob({ targetStoreId: "store-1", sourceBatchId: "batch-test", spuIds: ["7744886733"] });
assert.equal(inspectCount, 0);
const confirmed = await runner.confirmJob(live.id);
assert.equal(confirmed.status, "probed");
assert.equal(confirmed.items[0].status, "probed");
assert.equal(confirmed.items[0].submitted, false);
assert.equal(confirmed.items[0].published, false);
assert.equal(inspectCount, 1);
await assert.rejects(() => runner.confirmJob(live.id), /transfer_job_not_runnable/);
await assert.rejects(() => runner.retryJob(live.id), /transfer_job_not_runnable/);
assert.equal(inspectCount, 1);

let failOnce = true;
const retryAdapter = {
    id: "fake-retry",
    displayName: "fake-retry",
    matchesStore: () => true,
    async inspectCreatePage({ product, screenshotPath }) {
        if (failOnce) {
            failOnce = false;
            throw new Error("page_open_failed");
        }
        return {
            submitted: false,
            published: false,
            detected: true,
            pageUrl: "https://agentseller.temu.com/goods/create/category",
            screenshot: screenshotPath,
            blockers: ["不会提交"],
            evidence: { spuId: product.spuId }
        };
    }
};
const retrier = createTransferManager(root, readyStore, { adapters: [retryAdapter] });
const retryJob = await retrier.createJob({ targetStoreId: "store-1", sourceBatchId: "batch-test", spuIds: ["7744886733"] });
const firstTry = await retrier.confirmJob(retryJob.id);
assert.equal(firstTry.status, "failed");
const secondTry = await retrier.retryJob(retryJob.id);
assert.equal(secondTry.status, "probed");
assert.equal(secondTry.items[0].submitted, false);

const submittingAdapter = {
    id: "fake-submit",
    displayName: "fake-submit",
    matchesStore: () => true,
    async inspectCreatePage() {
        return { submitted: true, published: false, detected: true, pageUrl: "https://example.com", screenshot: "", blockers: [] };
    }
};
const submitter = createTransferManager(root, readyStore, { adapters: [submittingAdapter] });
const submitJob = await submitter.createJob({ targetStoreId: "store-1", sourceBatchId: "batch-test", spuIds: ["7744886733"] });
const submitResult = await submitter.confirmJob(submitJob.id);
assert.equal(submitResult.status, "failed");
assert.equal(submitResult.items[0].status, "failed");
assert.equal(submitResult.items[0].submitted, true);

const blocked = await transfer.createJob({ targetStoreId: "missing-store", sourceBatchId: "batch-test", spuIds: ["7744886733"] });
assert.equal(blocked.status, "blocked_preflight");
await assert.rejects(() => transfer.confirmJob(blocked.id), /transfer_job_not_runnable/);
console.log("inbox and transfer checks passed");
