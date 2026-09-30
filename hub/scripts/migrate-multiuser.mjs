/**
 * 多用户迁移：把现有单账号数据归到管理员名下。
 *
 * 迁移只做三件事，不移动任何商品/批次文件：
 *   1. 生成 users.json（旧 credentials.json 的账号成为管理员，由 users.mjs 自动完成）；
 *   2. 生成 store-ownership.json，把当前所有活跃店铺的归属写为管理员；
 *   3. 若旧索引残留 excludedSpuIds 等历史字段，保持原样交给 store.mjs 自行迁移。
 *
 * 必须停机执行：运行中的服务会改写 jobs.json，边跑边迁移会丢数据。
 * 幂等：重复执行不会覆盖已有归属，也不会重复创建用户。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createUsers } from "../lib/users.mjs";
import { createStoreOwnership } from "../lib/store-ownership.mjs";

const dataRoot = path.resolve(process.argv[2] || process.env.ZINIAO_DATA_ROOT || "");
if (!dataRoot) {
    console.error("用法: node scripts/migrate-multiuser.mjs <数据根目录>");
    process.exit(1);
}

async function readJson(file, fallback) {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { return fallback; }
}

const users = createUsers(dataRoot);
const ownership = createStoreOwnership(dataRoot);

// 1. 用户表：首次调用 readState 会把旧 credentials.json 迁成管理员并补出 sessionSecret。
const state = await users.getState();
const admin = state.users.find((user) => user.role === "admin");
if (!admin) {
    console.error("没有可用的管理员账号：请确认 TEMU_CREDENTIALS 指向旧的 credentials.json。");
    process.exit(1);
}
console.log(`管理员账号: ${admin.username}（${admin.id}）`);
console.log(`用户总数: ${state.users.length}`);

// 2. 店铺归属：把 jobs.json 里出现过的店铺全部归到管理员，避免升级后无人可见。
const jobs = await readJson(path.join(dataRoot, "data", "jobs.json"), { agents: [] });
const storeIds = new Set();
for (const agent of jobs.agents || []) {
    const storeId = String(agent.storeId || "").trim();
    if (storeId) storeIds.add(storeId);
}
const existing = await ownership.listAssignments();
let assigned = 0;
for (const storeId of storeIds) {
    if (existing[storeId]) continue;
    const agent = (jobs.agents || []).find((item) => String(item.storeId || "") === storeId) || {};
    await ownership.reassign(storeId, { id: admin.id, username: admin.username }, String(agent.storeName || agent.pageStoreName || ""));
    assigned += 1;
}
console.log(`店铺归属: 发现 ${storeIds.size} 个店铺，新归属 ${assigned} 个（已有归属保持不变）`);

// 3. 汇总，便于部署时核对。
const finalState = await users.getState();
await mkdir(dataRoot, { recursive: true });
await writeFile(path.join(dataRoot, "migration-report.json"), JSON.stringify({
    migratedAt: new Date().toISOString(),
    admin: { id: admin.id, username: admin.username },
    userCount: finalState.users.length,
    storeCount: storeIds.size,
    newlyAssigned: assigned,
    registrationOpen: finalState.registrationOpen
}, null, 2), "utf8");
console.log("迁移完成，报告写入 migration-report.json");
