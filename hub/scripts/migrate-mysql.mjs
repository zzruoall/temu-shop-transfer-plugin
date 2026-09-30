import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { openMysqlDatabase } from "../lib/mysql-database.mjs";
import { initializeMysqlSchema } from "../lib/mysql-schema.mjs";
import { createStore } from "../lib/store.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";
import { createMysqlMap } from "../lib/mysql-map.mjs";

// 显式离线操作，不在网站启动或首次查询中自动迁移，避免业务写入期间产生不一致快照。
const args = process.argv.slice(2);
const source = args[args.indexOf("--source") + 1];
if (!args.includes("--confirm-offline") || !args.includes("--source") || !source) {
    throw new Error("先停止源服务，再使用 --source <资料根目录> --confirm-offline；需配置 TEMU_MYSQL_CONFIG");
}
const root = path.resolve(source);
const database = await openMysqlDatabase();
if (!database) throw new Error("缺少 MySQL 配置");
const inputHashes = {};
async function json(relative, fallback) {
    try {
        const text = await readFile(path.join(root, relative), "utf8");
        inputHashes[relative] = createHash("sha256").update(text).digest("hex");
        return JSON.parse(text);
    } catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
try {
    const index = await json("data/index.json");
    const state = await json("data/jobs.json", { jobs: [], agents: [] });
    if ((state.jobs || []).some(job => (job.items || []).length > 200)) {
        throw new Error("存在超过200件的历史任务，请先处理或拆分后再迁移，不能改写在途任务编号");
    }
    const ownership = await json("store-ownership.json", { assignments: {} });
    const deleted = await json("deleted-stores.json", { deleted: {} });
    // 所有引用的原始资料必须存在；缺文件时失败，不给出成功迁移的假象。
    for (const batch of index.batches || []) for (const file of batch.files || []) {
        if (!file.storedName || path.basename(file.storedName) !== file.storedName) throw new Error("原始资料文件名不合法");
        await stat(path.join(root, "data", "files", file.storedName));
    }
    const logs = [];
    const logDir = path.join(root, "data", "work-logs");
    const names = await readdir(logDir).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const name of names.filter(name => name.endsWith(".json"))) logs.push(await json(`data/work-logs/${name}`));
    await initializeMysqlSchema(database);
    const [[existing]] = await database.query("maintenance", "SELECT COUNT(*) AS n FROM hub_schema");
    const [[occupied]] = await database.query("maintenance", "SELECT (SELECT COUNT(*) FROM hub_jobs)+(SELECT COUNT(*) FROM hub_batches)+(SELECT COUNT(*) FROM hub_agents)+(SELECT COUNT(*) FROM hub_map_entries) AS n");
    if (Number(existing.n) || Number(occupied.n)) throw new Error("目标数据库已包含迁移或业务记录，禁止覆盖；请使用新的空数据库");
    await database.query("maintenance", "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'migrating',?)", [root]);
    const store = createStore(root, { database });
    await store.ensure();
    const inventory = await store.importLegacyIndex(index);
    const queue = createJobQueue(root, store, { database });
    const tasks = await queue.importLegacyState(state, logs);
    for (const [domain, field, value] of [["ownership", "assignments", ownership], ["deleted", "deleted", deleted]]) {
        const map = createMysqlMap(database, domain, field);
        await map.transaction(() => map.write({ [field]: value[field] || {} }));
    }
    const [[counts]] = await database.query("maintenance", `SELECT (SELECT COUNT(*) FROM hub_batches) AS batches,
        (SELECT COUNT(*) FROM hub_products) AS products,(SELECT COUNT(*) FROM hub_jobs) AS jobs,
        (SELECT COUNT(*) FROM hub_job_items) AS items,(SELECT COUNT(*) FROM hub_agents) AS agents`);
    for (const [key, value] of Object.entries({ ...inventory, ...tasks })) if (Number(counts[key]) !== value) throw new Error(`迁移计数不匹配: ${key}`);
    // 迁移期间源文件改变意味着服务未真正停止；拒绝切换，原 JSON 保持原样。
    for (const [relative, before] of Object.entries(inputHashes)) {
        const after = createHash("sha256").update(await readFile(path.join(root, relative), "utf8")).digest("hex");
        if (before !== after) throw new Error(`迁移期间源文件发生变化: ${relative}`);
    }
    const manifest = { at: new Date().toISOString(), counts, inputHashes };
    await database.query("maintenance", "UPDATE hub_schema SET state='ready',manifest=? WHERE id=1", [JSON.stringify(manifest)]);
    console.log(JSON.stringify({ migrated: true, counts, sourceFilesUnchanged: true }));
} finally { await database.close(); }
