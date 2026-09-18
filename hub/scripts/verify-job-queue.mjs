/**
 * 核对中央任务队列：不能自己传给自己，不能广播给所有插件，目标店身份不符必须失败。
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createJobQueue, makeProductVersion } from "../lib/job-queue.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "shop-hub-jobs-"));
const readyProduct = {
    spuId: "7744886733",
    goodsId: "9001",
    title: "测试商品",
    ready: true,
    images: ["https://example.com/a.jpg"],
    skuIds: ["1"],
    skcIds: ["2"],
    skus: [{ skuId: "1", price: 12.5, specs: [{ name: "规格", value: "单瓶" }] }],
    detail: { detailHtml: "<p>详情正文</p>" }
};
const incompleteProduct = {
    spuId: "5372907865",
    goodsId: "9002",
    title: "未齐商品",
    ready: false,
    images: [],
    skuIds: ["3"],
    skcIds: ["4"]
};
const extraReadyProduct = {
    spuId: "8888888888",
    goodsId: "9003",
    title: "第二件齐商品",
    ready: true,
    images: ["https://example.com/b.jpg"],
    skuIds: ["5"],
    skcIds: ["6"],
    skus: [{ skuId: "5", price: 8, specs: [{ name: "规格", value: "默认" }] }],
    detail: { detailHtml: "<p>第二件</p>" }
};
const store = {
    async listOverview() {
        return { products: [readyProduct, incompleteProduct, extraReadyProduct], shopName: "City Beauty King" };
    },
    async getBatch(id) {
        if (id === "batch-1") {
            return {
                id: "batch-1",
                sourceStoreId: "27565374641388",
                sourceStoreName: "City Beauty King",
                shopName: "City Beauty King",
                products: [readyProduct, incompleteProduct]
            };
        }
        if (id === "batch-2") {
            return {
                id: "batch-2",
                sourceStoreId: "27751811499835",
                sourceStoreName: "Hair removal wax",
                shopName: "Hair removal wax",
                products: [readyProduct, extraReadyProduct]
            };
        }
        return null;
    }
};
const queue = createJobQueue(root, store);
// 领取与核验必须明确携带 10.x 插件证据，旧版仅有面板节点不能通过服务端状态机。
const supportedPlugin = { pluginDetected: true, pluginVersion: "10.1.0", identityMatched: true };

await assert.rejects(
    () => queue.createJob({ sourceStoreId: "A", targetStoreId: "A", sourceBatchId: "b1", spuIds: ["7744886733"] }),
    /来源店和目标店不能相同/
);

await assert.rejects(
    () => queue.createJob({ sourceStoreId: "27565374641388", targetStoreId: "27751811499835", sourceBatchId: "missing", spuIds: ["7744886733"] }),
    /来源批次不存在/
);

await assert.rejects(
    () => queue.createJob({ sourceStoreId: "27565374641388", targetStoreId: "27751811499835", sourceBatchId: "batch-1", spuIds: ["999"] }),
    /来源批次中没有这些 SPU/
);

const created = await queue.createJob({
    sourceStoreId: "27565374641388",
    targetStoreId: "27751811499835",
    sourceStoreName: "City Beauty King",
    targetStoreName: "Hair removal wax",
    sourceBatchId: "batch-1",
    spuIds: ["7744886733"]
});
assert.equal(created.status, "queued");
assert.equal(created.items[0].productVersion, makeProductVersion(readyProduct));
assert.ok(created.items[0].snapshot.detail.detailHtml);

const openedTooSoon = await queue.claimJobs({ storeId: "27751811499835", storeName: "Hair removal wax" });
assert.equal(openedTooSoon.claimed.length, 0);

await assert.rejects(
    () => queue.reportProgress({ jobId: created.id, spuId: "7744886733", storeId: "27751811499835", status: "identity_verified" }),
    /必须先领取任务才能核验身份/
);

const mixed = await queue.createJob({
    sourceStoreId: "27565374641388",
    targetStoreId: "11111111111111",
    sourceStoreName: "City Beauty King",
    targetStoreName: "Other Shop",
    sourceBatchId: "batch-1",
    spuIds: ["7744886733", "5372907865"]
});
assert.equal(mixed.status, "queued");
assert.equal(mixed.items.find((item) => item.spuId === "7744886733").status, "queued");
assert.equal(mixed.items.find((item) => item.spuId === "5372907865").status, "blocked");

const openRequests = await queue.listOpenRequests();
assert.equal(openRequests.requests.some((item) => item.jobId === created.id), true);

const opened = await queue.reportOpenResult({
    jobId: created.id,
    storeId: "27751811499835",
    status: "opened",
    pageUrl: "https://agentseller.temu.com/goods/list"
});
assert.equal(opened.status, "opened");

const other = await queue.claimJobs({ storeId: "111", storeName: "别人的店" });
assert.equal(other.claimed.length, 0);

const wrongName = await queue.claimJobs({ storeId: "27751811499835", storeName: "City Beauty King" });
assert.equal(wrongName.claimed.length, 0);

const mine = await queue.claimJobs({ storeId: "27751811499835", storeName: "Hair removal wax", pageUrl: "https://agentseller.temu.com/goods/list", ...supportedPlugin });
assert.equal(mine.claimed.length, 1);
assert.equal(mine.claimed[0].targetStoreId, "27751811499835");
assert.ok(mine.claimed[0].claimToken);
const duplicateClaim = await queue.claimJobs({ storeId: "27751811499835", storeName: "Hair removal wax" });
assert.equal(duplicateClaim.claimed.length, 0);

await assert.rejects(
    () => queue.reportProgress({ jobId: created.id, spuId: "7744886733", storeId: "111", status: "identity_verified" }),
    /店铺身份与任务目标店不一致/
);

const mismatch = await queue.reportProgress({
    jobId: created.id,
    spuId: "7744886733",
    storeId: "27751811499835",
    status: "identity_mismatch",
    ...supportedPlugin,
    claimToken: mine.claimed[0].claimToken,
    reason: "页面店名不符"
});
assert.equal(mismatch.status, "failed");
assert.equal(mismatch.items[0].submitted, false);
assert.equal(mismatch.items[0].published, false);
await assert.rejects(
    () => queue.reportProgress({ jobId: created.id, spuId: "7744886733", storeId: "27751811499835", status: "failed", claimToken: mine.claimed[0].claimToken }),
    /终态任务不能被迟到消息覆盖/
);

// 即使旧工人把旧面板报成“已检测到”，服务端也不能发放领取凭证或写成身份已核验。
const legacyGuard = await queue.createJob({
    sourceStoreId: "27565374641388",
    targetStoreId: "27751811499835",
    sourceStoreName: "City Beauty King",
    targetStoreName: "Hair removal wax",
    sourceBatchId: "batch-1",
    spuIds: ["7744886733"]
});
await queue.reportOpenResult({ jobId: legacyGuard.id, storeId: "27751811499835", status: "opened" });
const oldPluginClaim = await queue.claimJobs({
    storeId: "27751811499835",
    storeName: "Hair removal wax",
    pluginDetected: true,
    pluginVersion: "9.8.3"
});
assert.equal(oldPluginClaim.claimed.length, 0);
const stale10Claim = await queue.claimJobs({
    storeId: "27751811499835",
    storeName: "Hair removal wax",
    pluginDetected: true,
    pluginVersion: "10.0.3"
});
assert.equal(stale10Claim.claimed.length, 0);
const guardedClaim = await queue.claimJobs({ storeId: "27751811499835", storeName: "Hair removal wax", ...supportedPlugin });
assert.equal(guardedClaim.claimed.length, 1);
const downgraded = await queue.reportProgress({
    jobId: legacyGuard.id,
    spuId: "7744886733",
    storeId: "27751811499835",
    status: "identity_verified",
    claimToken: guardedClaim.claimed[0].claimToken,
    pluginDetected: true,
    pluginVersion: "9.8.3"
});
assert.equal(downgraded.items[0].status, "plugin_missing");
const recoveredClaim = await queue.claimJobs({ storeId: "27751811499835", storeName: "Hair removal wax", ...supportedPlugin });
assert.equal(recoveredClaim.claimed.length, 1);
const recovered = await queue.reportProgress({
    jobId: legacyGuard.id,
    spuId: "7744886733",
    storeId: "27751811499835",
    status: "identity_verified",
    claimToken: recoveredClaim.claimed[0].claimToken,
    ...supportedPlugin
});
assert.equal(recovered.items[0].status, "identity_verified");

// 工人在已打开页面发现旧版或未安装插件时，应立即给运营可见的缺插件状态，不能停留在 opened。
const directMissing = await queue.createJob({
    sourceStoreId: "27565374641388",
    targetStoreId: "27751811499835",
    sourceStoreName: "City Beauty King",
    targetStoreName: "Hair removal wax",
    sourceBatchId: "batch-1",
    spuIds: ["7744886733"]
});
const missingResult = await queue.reportOpenResult({
    jobId: directMissing.id,
    storeId: "27751811499835",
    status: "plugin_missing",
    reason: "未检测到兼容的 10.x 中转插件"
});
assert.equal(missingResult.status, "plugin_missing");
assert.equal(missingResult.items[0].status, "plugin_missing");
await queue.cancelJob(directMissing.id);

const openedThenMissing = await queue.createJob({
    sourceStoreId: "27565374641388",
    targetStoreId: "27751811499835",
    sourceStoreName: "City Beauty King",
    targetStoreName: "Hair removal wax",
    sourceBatchId: "batch-1",
    spuIds: ["7744886733"]
});
await queue.reportOpenResult({ jobId: openedThenMissing.id, storeId: "27751811499835", status: "opened" });
const afterOpenedMissing = await queue.reportOpenResult({
    jobId: openedThenMissing.id,
    storeId: "27751811499835",
    status: "plugin_missing",
    reason: "打开后复查未检测到兼容插件"
});
assert.equal(afterOpenedMissing.items[0].status, "plugin_missing");
const openAfterMissing = await queue.listOpenRequests();
assert.equal(openAfterMissing.requests.some((item) => item.jobId === directMissing.id), false);

const second = await queue.createJob({
    sourceStoreId: "27751811499835",
    targetStoreId: "27565374641388",
    sourceBatchId: "batch-2",
    spuIds: ["7744886733"]
});
await queue.reportOpenResult({
    jobId: second.id,
    storeId: "27565374641388",
    status: "opened"
});
const verified = await queue.claimJobs({ storeId: "27565374641388", storeName: "City Beauty King", ...supportedPlugin });
assert.equal(verified.claimed[0].jobId, second.id);
const done = await queue.reportProgress({
    jobId: second.id,
    spuId: "7744886733",
    storeId: "27565374641388",
    status: "identity_verified",
    ...supportedPlugin,
    claimToken: verified.claimed[0].claimToken,
    pageUrl: "https://agentseller.temu.com/goods/list"
});
assert.equal(done.status, "identity_verified");
assert.equal(done.items[0].published, false);
await assert.rejects(
    () => queue.cancelJob(second.id),
    /已完成、失败、已取消或预检未通过的任务不能再取消/
);

const changed = { ...readyProduct, skus: [{ skuId: "1", price: 99, specs: [{ name: "规格", value: "单瓶" }] }], detail: { detailHtml: "<p>改过的详情</p>" } };
assert.notEqual(makeProductVersion(readyProduct), makeProductVersion(changed));

const sameStoreA = await queue.createJob({
    sourceStoreId: "27751811499835",
    targetStoreId: "27565374641388",
    sourceStoreName: "Hair removal wax",
    targetStoreName: "City Beauty King",
    sourceBatchId: "batch-2",
    spuIds: ["7744886733"]
});
const sameStoreB = await queue.createJob({
    sourceStoreId: "27751811499835",
    targetStoreId: "27565374641388",
    sourceStoreName: "Hair removal wax",
    targetStoreName: "City Beauty King",
    sourceBatchId: "batch-2",
    spuIds: ["8888888888"]
});
await queue.reportOpenResult({
    jobId: sameStoreA.id,
    storeId: "27565374641388",
    status: "opened",
    spuIds: ["7744886733"]
});
await queue.reportOpenResult({
    jobId: sameStoreB.id,
    storeId: "27565374641388",
    status: "opened",
    spuIds: ["8888888888"]
});
const sameStoreClaim = await queue.claimJobs({ storeId: "27565374641388", storeName: "City Beauty King", ...supportedPlugin });
assert.equal(sameStoreClaim.claimed.length, 2);
assert.deepEqual(sameStoreClaim.claimed.map((item) => item.jobId).sort(), [sameStoreA.id, sameStoreB.id].sort());
for (const item of sameStoreClaim.claimed) {
    const result = await queue.reportProgress({
        jobId: item.jobId,
        spuId: item.spuId,
        storeId: "27565374641388",
        status: "identity_verified",
        ...supportedPlugin,
        pageUrl: "https://agentseller.temu.com/goods/list",
        claimToken: item.claimToken
    });
    assert.equal(result.items.find((entry) => entry.spuId === item.spuId).status, "identity_verified");
}

const heartbeat = await queue.registerAgent({
    pluginInstanceId: "plugin-instance-map",
    pageStoreName: "Unique Mapping Shop",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    source: "plugin-heartbeat"
});
assert.equal(heartbeat.pluginInstanceId, "plugin-instance-map");
assert.equal(heartbeat.storeId, "");
const mapped = await queue.registerAgent({
    storeId: "29999999999999",
    storeName: "Unique Mapping Shop-全托",
    pluginInstanceId: "plugin-instance-map",
    pageStoreName: "Unique Mapping Shop",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    identityMatched: true,
    source: "worker-inspect"
});
assert.equal(mapped.storeId, "29999999999999");
// 只凭扩展实例不能安全推断来源店，入库包必须同时带采集页店名作为交叉证据。
assert.equal(await queue.resolveIngestSource({ pluginInstanceId: "plugin-instance-map" }), null);
const ingestSource = await queue.resolveIngestSource({
    pluginInstanceId: "plugin-instance-map",
    pageStoreName: "Unique Mapping Shop"
});
assert.equal(ingestSource.sourceStoreId, "29999999999999");

const nameOnlyIngest = await queue.resolveIngestSource({ pageStoreName: "Unique Mapping Shop" });
assert.equal(nameOnlyIngest.sourceStoreId, "29999999999999");

const siblingA = await queue.registerAgent({
    pluginInstanceId: "plugin-instance-sibling-a",
    pageStoreName: "Hair removal wax",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    source: "plugin-heartbeat"
});
const siblingMapped = await queue.registerAgent({
    pluginInstanceId: "plugin-instance-sibling-a",
    storeId: "27751811499835",
    storeName: "Hair removal wax-全托-若欧",
    pageStoreName: "Hair removal wax",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    identityMatched: true,
    source: "worker-inspect"
});
const siblingB = await queue.registerAgent({
    pluginInstanceId: "plugin-instance-sibling-b",
    pageStoreName: "Hair removal wax",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    source: "plugin-heartbeat"
});
assert.equal(siblingA.pluginInstanceId, "plugin-instance-sibling-a");
assert.equal(siblingMapped.storeId, "27751811499835");
assert.equal(siblingB.pluginInstanceId, "plugin-instance-sibling-b");
assert.equal(siblingB.storeId, "");
const listedAgents = await queue.listJobs();
assert.equal((listedAgents.agents || []).filter((agent) => [
    "plugin-instance-sibling-a",
    "plugin-instance-sibling-b"
].includes(agent.pluginInstanceId)).length, 2);

const siblingSteal = await queue.registerAgent({
    pluginInstanceId: "plugin-instance-sibling-b",
    storeId: "27751811499835",
    storeName: "Hair removal wax-全托-若欧",
    pageStoreName: "Hair removal wax",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    identityMatched: true,
    source: "worker-inspect"
});
assert.equal(siblingSteal.pluginInstanceId, "plugin-instance-sibling-b");
const afterSteal = await queue.listJobs();
const siblingKept = afterSteal.agents.find((agent) => agent.pluginInstanceId === "plugin-instance-sibling-a");
const siblingOwn = afterSteal.agents.find((agent) => agent.pluginInstanceId === "plugin-instance-sibling-b");
assert.equal(siblingKept.pluginInstanceId, "plugin-instance-sibling-a");
assert.equal(siblingKept.storeId, "27751811499835");
assert.equal(siblingOwn.pluginInstanceId, "plugin-instance-sibling-b");
assert.equal(siblingOwn.storeId, "");
assert.notEqual(siblingKept.pluginInstanceId, siblingOwn.pluginInstanceId);

const unboundWindow = await queue.registerAgent({
    storeId: "21111111111111",
    storeName: "Unbound Window",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    source: "worker-inspect"
});
assert.equal(unboundWindow.pluginInstanceId, "");
const boundWindow = await queue.registerAgent({
    pluginInstanceId: "plugin-instance-fill",
    storeId: "21111111111111",
    storeName: "Unbound Window",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    source: "worker-inspect"
});
assert.equal(boundWindow.pluginInstanceId, "plugin-instance-fill");
assert.equal(boundWindow.storeId, "21111111111111");
const afterFill = await queue.listJobs();
assert.equal((afterFill.agents || []).filter((agent) => agent.storeId === "21111111111111").length, 1);

const mismatchClaimJob = await queue.createJob({
    sourceStoreId: "27751811499835",
    targetStoreId: "27565374641388",
    sourceStoreName: "Hair removal wax",
    targetStoreName: "City Beauty King",
    sourceBatchId: "batch-2",
    spuIds: ["8888888888"]
});
await queue.reportOpenResult({ jobId: mismatchClaimJob.id, storeId: "27565374641388", status: "opened" });
const mismatchClaim = await queue.claimJobs({
    storeId: "27565374641388",
    storeName: "City Beauty King",
    pluginDetected: true,
    pluginVersion: "10.1.0",
    identityMatched: false
});
assert.equal(mismatchClaim.claimed.length, 1);
const mismatchReport = await queue.reportProgress({
    jobId: mismatchClaimJob.id,
    spuId: "8888888888",
    storeId: "27565374641388",
    status: "identity_verified",
    claimToken: mismatchClaim.claimed[0].claimToken,
    pluginDetected: true,
    pluginVersion: "10.1.0",
    identityMatched: false
});
assert.equal(mismatchReport.items.find((item) => item.spuId === "8888888888").status, "identity_mismatch");

// 新版网页必须只向近期在线、身份匹配的 10.3 目标插件发送；领取、接收和人工确认三步缺一不可。
const manualTarget = await queue.registerAgent({
    pluginInstanceId: "plugin-instance-manual-target",
    storeId: "30000000000000",
    storeName: "Manual Target Shop",
    pageStoreName: "Manual Target Shop",
    pluginDetected: true,
    pluginVersion: "10.3.0",
    identityMatched: true,
    source: "worker-inspect"
});
assert.equal(manualTarget.canReceiveUploads, true);
const manualJob = await queue.createJob({
    sourceStoreId: "27565374641388",
    targetStoreId: "30000000000000",
    sourceStoreName: "City Beauty King",
    targetStoreName: "Manual Target Shop",
    sourceBatchId: "batch-1",
    spuIds: ["7744886733"],
    requireOnline: true
});
assert.equal(manualJob.mode, "manual-plugin-upload");
assert.equal((await queue.listOpenRequests()).requests.some((item) => item.jobId === manualJob.id), false);
const workerManualClaim = await queue.claimJobs({
    storeId: "30000000000000",
    storeName: "Manual Target Shop",
    pluginInstanceId: "plugin-instance-manual-target",
    pluginDetected: true,
    pluginVersion: "10.3.0",
    identityMatched: true,
    claimManualUploads: false
});
assert.equal(workerManualClaim.claimed.length, 0);
const manualClaim = await queue.claimJobs({
    storeId: "30000000000000",
    storeName: "Manual Target Shop",
    pluginInstanceId: "plugin-instance-manual-target",
    pluginDetected: true,
    pluginVersion: "10.3.0",
    identityMatched: true
});
assert.equal(manualClaim.claimed.length, 1);
assert.equal(manualClaim.claimed[0].snapshot.spuId, "7744886733");
const manualReceived = await queue.reportProgress({
    jobId: manualJob.id,
    spuId: "7744886733",
    storeId: "30000000000000",
    status: "received",
    claimToken: manualClaim.claimed[0].claimToken,
    pluginDetected: true,
    pluginVersion: "10.3.0",
    pluginInstanceId: "plugin-instance-manual-target",
    identityMatched: true,
    pageStoreName: "Manual Target Shop"
});
assert.equal(manualReceived.items[0].status, "received");
const manualOpened = await queue.reportProgress({
    jobId: manualJob.id,
    spuId: "7744886733",
    storeId: "30000000000000",
    status: "upload_opened",
    claimToken: manualClaim.claimed[0].claimToken,
    pluginDetected: true,
    pluginVersion: "10.3.0",
    pluginInstanceId: "plugin-instance-manual-target",
    identityMatched: true,
    pageStoreName: "Manual Target Shop"
});
assert.equal(manualOpened.items[0].status, "upload_opened");
const manualUploaded = await queue.reportProgress({
    jobId: manualJob.id,
    spuId: "7744886733",
    storeId: "30000000000000",
    status: "uploaded",
    claimToken: manualClaim.claimed[0].claimToken,
    pluginDetected: true,
    pluginVersion: "10.3.0",
    pluginInstanceId: "plugin-instance-manual-target",
    identityMatched: true,
    pageStoreName: "Manual Target Shop"
});
assert.equal(manualUploaded.status, "uploaded");
assert.equal(manualUploaded.items[0].submitted, true);
assert.equal(manualUploaded.items[0].published, false);
const uploadedLog = await queue.listActivity();
assert.ok(uploadedLog.entries.some((entry) => entry.jobId === manualJob.id && entry.type === "plugin_uploaded"));
assert.ok(uploadedLog.stores.some((store) => store.storeId === "30000000000000" && store.entries.some((entry) => entry.type === "plugin_uploaded")));
await queue.clearStoreActivity("30000000000000");
const clearedLog = await queue.listActivity();
// 清日志只删除操作记录，不把已登记店铺从索引里移除；运营仍需要看到该店在线状态和空时间线。
assert.equal(clearedLog.stores.some((store) => store.storeId === "30000000000000" && store.entries.length === 0), true);

// 人工上传的“部分完成”仍有未完成商品，必须保持为活跃任务：不能重复派发，并且允许运营取消余项。
const partialManual = await queue.createJob({
    sourceStoreId: "27751811499835",
    targetStoreId: "30000000000000",
    sourceStoreName: "Hair removal wax",
    targetStoreName: "Manual Target Shop",
    sourceBatchId: "batch-2",
    spuIds: ["7744886733", "8888888888"],
    requireOnline: true
});
const partialClaim = await queue.claimJobs({
    storeId: "30000000000000",
    storeName: "Manual Target Shop",
    pluginInstanceId: "plugin-instance-manual-target",
    pluginDetected: true,
    pluginVersion: "10.3.0",
    identityMatched: true
});
const partialFirst = partialClaim.claimed.find((item) => item.jobId === partialManual.id && item.spuId === "7744886733");
assert.ok(partialFirst);
const partialReceived = await queue.reportProgress({
    jobId: partialManual.id,
    spuId: partialFirst.spuId,
    storeId: "30000000000000",
    status: "received",
    claimToken: partialFirst.claimToken,
    pluginDetected: true,
    pluginVersion: "10.3.0",
    pluginInstanceId: "plugin-instance-manual-target",
    identityMatched: true,
    pageStoreName: "Manual Target Shop"
});
assert.equal(partialReceived.status, "partial");
// 服务器不判断平台商品是否重复：目标店插件没有处于提交中时，同店同货号允许再次下发，
// 旧任务里重叠的未完成项在新任务落库的同一把锁内被撤销，避免同一货号在队列里堆积两份。
const reissuedPartial = await queue.createJob({
    sourceStoreId: "27751811499835",
    targetStoreId: "30000000000000",
    sourceBatchId: "batch-2",
    spuIds: ["7744886733"],
    requireOnline: true
});
assert.ok(reissuedPartial.id);
const supersededPartial = await queue.getJob(partialManual.id);
const supersededItem = supersededPartial.items.find((item) => item.spuId === "7744886733");
assert.equal(supersededItem.status, "cancelled");
assert.equal(supersededItem.replacedByJobId, reissuedPartial.id);
const cancelledPartial = await queue.cancelJob(partialManual.id);
assert.equal(cancelledPartial.status, "cancelled");

// 同一店第二个在线插件实例不能领取人工上传快照，即使它伪造同一个店铺 ID。
const guardedManual = await queue.createJob({
    sourceStoreId: "27565374641388",
    targetStoreId: "30000000000000",
    sourceStoreName: "City Beauty King",
    targetStoreName: "Manual Target Shop",
    sourceBatchId: "batch-1",
    spuIds: ["7744886733"],
    requireOnline: true
});
const secondInstanceClaim = await queue.claimJobs({
    storeId: "30000000000000",
    storeName: "Manual Target Shop",
    pluginInstanceId: "plugin-instance-manual-second",
    pluginDetected: true,
    pluginVersion: "10.3.0",
    identityMatched: true
});
assert.equal(secondInstanceClaim.claimed.length, 0);
const guardedManualClaim = await queue.claimJobs({
    storeId: "30000000000000",
    storeName: "Manual Target Shop",
    pluginInstanceId: "plugin-instance-manual-target",
    pluginDetected: true,
    pluginVersion: "10.3.0",
    identityMatched: true
});
assert.equal(guardedManualClaim.claimed.filter((item) => item.jobId === guardedManual.id).length, 1);
await assert.rejects(() => queue.reportProgress({
    jobId: guardedManual.id,
    spuId: "7744886733",
    storeId: "30000000000000",
    status: "received",
    claimToken: guardedManualClaim.claimed.find((item) => item.jobId === guardedManual.id).claimToken,
    pluginDetected: true,
    pluginVersion: "10.3.0",
    pluginInstanceId: "plugin-instance-manual-target",
    identityMatched: false,
    pageStoreName: "Manual Target Shop"
}), /新版目标插件/);

// 覆盖必须产生新任务，并使已领取旧任务的迟到回执无法恢复它。
const replacement = await queue.createJob({
    sourceStoreId: "27565374641388", targetStoreId: "30000000000000",
    sourceBatchId: "batch-1", spuIds: ["7744886733"],
    requireOnline: true, replaceExisting: true
});
assert.notEqual(replacement.id, guardedManual.id);
await assert.rejects(() => queue.reportProgress({
    jobId: guardedManual.id, spuId: "7744886733", storeId: "30000000000000",
    status: "received", claimToken: guardedManualClaim.claimed.find(item => item.jobId === guardedManual.id).claimToken,
    pluginDetected: true, pluginVersion: "10.3.0", pluginInstanceId: "plugin-instance-manual-target",
    identityMatched: true, pageStoreName: "Manual Target Shop"
}), /终态/);
console.log("job queue checks passed");
