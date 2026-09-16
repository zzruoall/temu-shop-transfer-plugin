/**
 * 核对自动入库队列：后一次任务不得覆盖前一次，失败后要按退避时间等待，而不是立刻丢掉。
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const extensionDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../plugin");
const queue = require(path.join(extensionDir, "ingest-queue.js"));
const endpoint = require(path.join(extensionDir, "ingest-endpoint.js"));
const fs = require("node:fs");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

const now = Date.parse("2026-08-26T04:00:00.000Z");
const first = queue.normalizeJob({
    eventIds: ["a"],
    allowedSpuIds: ["1"],
    createdAt: "2026-08-26T03:59:00.000Z"
}, now);
const second = queue.normalizeJob({
    eventIds: ["b"],
    allowedSpuIds: ["2"],
    createdAt: "2026-08-26T04:00:00.000Z"
}, now);
let jobs = queue.upsertJob([], first, now);
jobs = queue.upsertJob(jobs, second, now);
assert(jobs.length === 2, "后一次采集覆盖了前一次失败任务");

const legacy = queue.migrateLegacyJobs(jobs, {
    eventIds: ["legacy"],
    allowedSpuIds: ["9"],
    createdAt: "2026-08-26T03:58:00.000Z"
}, now);
assert(legacy.length === 3, "旧的单任务字段没有迁进队列");

const due = queue.nextDueJob(jobs, now);
assert(due && due.allowedSpuIds[0] === "1", "到期任务没有按创建时间先出旧任务");

const retried = queue.markRetry(due, "Failed to fetch", now);
assert(retried.attempts === 1, "失败后没有增加重试次数");
assert(Date.parse(retried.nextAttemptAt) === now + 30000, "失败后没有写入退避时间");
assert(!queue.nextDueJob([retried], now), "刚失败的任务被立刻再次执行");
assert(queue.nextWakeAt([retried], now) === now + 30000, "没有按退避时间安排下一次唤醒");

const exhausted = queue.markRetry({ ...due, attempts: 4 }, "Failed to fetch", now);
assert(exhausted.attempts === 5, "达到上限后仍未记满次数");
assert(!queue.nextDueJob([exhausted], now + 24 * 60 * 60 * 1000), "达到上限的任务仍会被取出");

const remaining = queue.removeJob(jobs, first.id);
assert(remaining.length === 1 && remaining[0].allowedSpuIds[0] === "2", "成功任务没有只移除自己");

const overflowSeed = [];
for (let index = 0; index < 10; index += 1) {
    overflowSeed.push(queue.normalizeJob({
        eventIds: [`old-${index}`],
        allowedSpuIds: [String(index + 1)],
        createdAt: `2026-08-26T03:5${index}:00.000Z`
    }, now));
}
const overflowed = queue.upsertJobWithEviction(overflowSeed, {
    eventIds: ["new-job"],
    allowedSpuIds: ["99"],
    createdAt: "2026-08-26T04:01:00.000Z"
}, now);
assert(overflowed.jobs.length === 10, "队列没有维持 10 个任务上限");
assert(overflowed.evicted.length === 1 && overflowed.evicted[0].allowedSpuIds[0] === "1", "第 11 个任务没有显式淘汰最早任务");
assert(!overflowed.jobs.some((job) => job.allowedSpuIds[0] === "1"), "被淘汰任务仍留在队列里");

const doneOutcome = queue.upsertOutcome([], {
    fingerprint: first.fingerprint,
    jobId: first.id,
    status: "done",
    batchId: "abcd1234"
}, now);
assert(doneOutcome.length === 1 && doneOutcome[0].status === "done", "成功终态没有写入");
const replaced = queue.upsertOutcome(doneOutcome, {
    fingerprint: first.fingerprint,
    jobId: first.id,
    status: "error",
    error: "retry_exhausted"
}, now + 1000);
assert(replaced.length === 1 && replaced[0].status === "error", "同一 fingerprint 的终态没有被后一次覆盖");
assert(queue.findOutcome(replaced, first.fingerprint).error === "retry_exhausted", "找不到当前任务终态");
assert(!queue.findOutcome(replaced, second.fingerprint), "串到了其他任务的终态");

const emptyPacket = queue.outcomeStatusFromPushResult({ skipped: true, reason: "empty_packet" });
assert(emptyPacket.status === "error" && emptyPacket.reason === "empty_packet", "空包被记成已入库");
const noProducts = queue.outcomeStatusFromPushResult({ skipped: true, reason: "no_products" });
assert(noProducts.status === "error" && noProducts.reason === "no_products", "无商品被记成已入库");
const reused = queue.outcomeStatusFromPushResult({ reused: true, batchId: "batch-1" });
assert(reused.status === "done" && reused.reason === "reused", "仓库复用回执没有记成成功");
const ingested = queue.outcomeStatusFromPushResult({ batchId: "batch-2" });
assert(ingested.status === "done" && ingested.reason === "ingested", "真实批次号没有记成成功");

assert(endpoint.matchesConfiguredEndpoint("http://127.0.0.1:17380/api/ingest", {
    ingestPath: "/api/ingest",
    endpoints: ["http://127.0.0.1:17380/api/ingest"]
}), "正确直推路径测试失败");
assert(!endpoint.matchesConfiguredEndpoint("http://127.0.0.1:17380/api/wrong", {
    ingestPath: "/api/ingest",
    endpoints: ["http://127.0.0.1:17380/api/ingest"]
}), "错误 endpoint 路径测试仍然通过");

const retriedJob = queue.markRetry(first, "Failed to fetch", now);
let retryJobs = queue.upsertJob([], retriedJob, now);
retryJobs = queue.upsertJob(retryJobs, {
    eventIds: first.eventIds,
    allowedSpuIds: first.allowedSpuIds,
    attempts: 0,
    lastError: "",
    nextAttemptAt: new Date(now).toISOString()
}, now);
assert(retryJobs[0].attempts === 1, "同 fingerprint 再次入队清空了重试次数");
assert(retryJobs[0].nextAttemptAt === retriedJob.nextAttemptAt, "同 fingerprint 再次入队清空了退避时间");
assert(retryJobs[0].lastError === "Failed to fetch", "同 fingerprint 再次入队清掉了 lastError");
assert(!queue.nextDueJob(retryJobs, now), "同 fingerprint 再次入队后被立刻执行");

const contentApp = fs.readFileSync(path.join(extensionDir, "content-app.js"), "utf8");
assert(contentApp.includes("无法确认是否入队"), "消息通道失败没有改成无法确认是否入队");
assert(contentApp.includes("rememberIngestFingerprint"), "消息发出前没有记住本次 fingerprint");
assert(!/autoPushFullPacket[\s\S]*已交给后台排队重试/.test(contentApp), "消息通道失败仍宣称已经后台排队");
const manifest = fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8");
assert(manifest.includes("ingest-queue.js"), "页面脚本没有加载与后台相同的队列指纹模块");

console.log("ingest queue checks passed");
