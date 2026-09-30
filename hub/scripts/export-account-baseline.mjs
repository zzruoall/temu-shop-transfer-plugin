/**
 * 第 0 步基线导出：按账户 / 店铺 / 轮次统计任务归属，输出可复核的清单。
 *
 * 用途：在引入账户调度字段之前，先固化"现在各账号名下有哪些任务、哪些归属不明"的事实，
 * 供迁移前后对账。只读，不写库、不改任务；敏感凭证（token、claimToken）不进入报告。
 *
 * 用法：
 *   TEMU_MYSQL_CONFIG=<配置> node scripts/export-account-baseline.mjs --out report.json
 * 未配置 MySQL 时按文件模式读取资料目录（ZINIAO_DATA_ROOT）。
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openMysqlDatabase } from "../lib/mysql-database.mjs";
import { createStore } from "../lib/store.mjs";
import { createStoreOwnership } from "../lib/store-ownership.mjs";
import { createDeletedStores } from "../lib/deleted-stores.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const argOf = (name, fallback = "") => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const dataRoot = path.resolve(argOf("--source", process.env.ZINIAO_DATA_ROOT || rootDir));
const outputPath = path.resolve(argOf("--out", path.join(rootDir, "output", `account-baseline-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)));

const database = process.env.TEMU_MYSQL_CONFIG ? await openMysqlDatabase() : null;
const store = createStore(dataRoot, { database });
const ownership = createStoreOwnership(dataRoot, { database });
const deletedStores = createDeletedStores(dataRoot, { database });
const jobQueue = createJobQueue(dataRoot, store, { ownership, deletedStores, database });

/** 分页读全量任务头，不加载快照正文；归属对账只需要标识和状态。 */
async function readAllJobs() {
    const jobs = [];
    for (let offset = 0; offset < 100000; offset += 200) {
        const page = await jobQueue.listJobsPage({ limit: 200, offset });
        const rows = Array.isArray(page?.jobs) ? page.jobs : [];
        jobs.push(...rows);
        if (!page?.hasMore || !rows.length) break;
    }
    return jobs;
}

const assignments = await ownership.listAssignments();
const ownerByStore = new Map(Object.entries(assignments).map(([storeId, entry]) => [storeId, String(entry.ownerId || "")]));

const jobs = await readAllJobs();
// 归属口径：来源店主人为任务的资源所有者；目标店主人单独记录，跨账号投递是合法操作。
const byOwner = new Map();
const unresolved = [];
const crossAccount = [];
for (const job of jobs) {
    const sourceStoreId = String(job.sourceStoreId || "");
    const targetStoreId = String(job.targetStoreId || "");
    const sourceOwner = ownerByStore.get(sourceStoreId) || "";
    const targetOwner = ownerByStore.get(targetStoreId) || "";
    const record = {
        jobId: String(job.id || ""),
        status: String(job.status || ""),
        createdAt: String(job.createdAt || ""),
        sourceStoreId,
        sourceOwnerId: sourceOwner,
        targetStoreId,
        targetOwnerId: targetOwner,
        executionRunId: String(job.executionRunId || ""),
        itemCount: Array.isArray(job.items) ? job.items.length : Number(job.preflight?.productCount || 0),
        // 按轮次统计：未绑定轮次的历史任务单独计数，迁移时不能被自动绑定到当前在线插件。
        runBound: Boolean(job.executionRunId)
    };
    if (!sourceOwner && !targetOwner) unresolved.push(record);
    else {
        const key = sourceOwner || targetOwner;
        if (!byOwner.has(key)) byOwner.set(key, []);
        byOwner.get(key).push(record);
    }
    if (sourceOwner && targetOwner && sourceOwner !== targetOwner) crossAccount.push({ ...record, direction: `${sourceOwner}->${targetOwner}` });
}

const summarize = records => ({
    total: records.length,
    runBound: records.filter(entry => entry.runBound).length,
    runUnbound: records.filter(entry => !entry.runBound).length,
    byStatus: records.reduce((acc, entry) => { acc[entry.status] = (acc[entry.status] || 0) + 1; return acc; }, {}),
    items: records.reduce((sum, entry) => sum + entry.itemCount, 0)
});

const report = {
    generatedAt: new Date().toISOString(),
    dataRoot,
    storage: database ? "mysql" : "file",
    // 账户口径：网站登录账号的稳定 user id，由服务端会话得出，客户端不能传参冒用。
    accountIdSource: "users.json 的 user.id（由会话校验得出）",
    assignments: Object.entries(assignments).map(([storeId, entry]) => ({
        storeId,
        ownerId: String(entry.ownerId || ""),
        ownerName: String(entry.ownerName || ""),
        storeName: String(entry.storeName || ""),
        claimedAt: String(entry.claimedAt || "")
    })),
    totals: summarize(jobs),
    byAccount: Object.fromEntries([...byOwner.entries()].map(([owner, records]) => [owner, summarize(records)])),
    crossAccountJobCount: crossAccount.length,
    crossAccountSamples: crossAccount.slice(0, 20),
    unresolvedJobCount: unresolved.length,
    unresolvedSamples: unresolved.slice(0, 20),
    note: "本报告不含插件令牌、领取凭证或商品正文。归属不明的历史任务在迁移时不得自动绑定当前在线插件。"
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({
    output: outputPath,
    storage: report.storage,
    totalJobs: report.totals.total,
    accounts: Object.keys(report.byAccount).length,
    crossAccount: report.crossAccountJobCount,
    unresolved: report.unresolvedJobCount
}, null, 2));
await database?.close?.();
process.exit(0);
