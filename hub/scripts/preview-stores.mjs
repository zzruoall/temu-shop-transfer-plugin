/**
 * 本地预览店铺页：造几个店铺与归属，用真实服务渲染，供浏览器人工核对外观。
 * 只用于开发验收，跑完 Ctrl+C 结束，不写任何真实数据（数据目录是临时目录）。
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUsers } from "../lib/users.mjs";

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await mkdtemp(path.join(os.tmpdir(), "preview-"));
const credentialPath = path.join(tmp, "credentials.json");
await writeFile(credentialPath, JSON.stringify({ deviceToken: "d", passwordHash: "p", salt: "s" }), "utf8");

const users = createUsers(tmp);
const account = await users.register({ username: "13800000001", password: "preview12345" });
// 预览管理页需要管理员身份：把这个账号提升为管理员。
await users.setRole(account.id, "admin");

const now = Date.now();
const agent = (storeId, storeName, { online, agoMs, version }) => ({
    storeId, storeName, pageStoreName: storeName,
    pluginInstanceId: `inst-${storeId.slice(-4)}`, pluginVersion: version,
    online, lastSeenAt: new Date(now - agoMs).toISOString(),
    identityMatched: true, pluginDetected: true, executionMode: "plugin-api",
    mallId: storeId.replace("temu:", "")
});
const agents = [
    agent("temu:634418217318103", "City Beauty King", { online: true, agoMs: 0, version: "10.10.49" }),
    agent("temu:634418210693849", "Hair removal wax", { online: true, agoMs: 5000, version: "10.10.49" }),
    agent("temu:999900001111222", "Radiant Renewal Bodycare", { online: false, agoMs: 3600_000, version: "10.10.48" }),
    agent("temu:888877776666555", "Sunrise Home Goods", { online: false, agoMs: 86_400_000, version: "10.10.47" })
];
// 状态文件都在 <dataRoot>/data/ 下：服务端按这个路径读写，放错位置等于没造数据。
const dataDir = path.join(tmp, "data");
await mkdir(dataDir, { recursive: true });
const jobsPath = path.join(dataDir, "jobs.json");
await writeFile(jobsPath, JSON.stringify({ version: 1, jobs: [], agents }), "utf8");
/**
 * 在线判定是"35 秒内有心跳"，静态时间戳会随时间自然变红。
 * 这里每 5 秒把标记为在线的店铺心跳刷新一次，模拟真实插件持续上报，
 * 让人工验收时能稳定看到绿灯。
 */
const onlineIds = new Set(agents.filter((item) => item.online).map((item) => item.storeId));
const heartbeat = setInterval(() => {
    const next = { version: 1, jobs: [], agents: agents.map((item) => onlineIds.has(item.storeId) ? { ...item, lastSeenAt: new Date().toISOString() } : item) };
    writeFile(jobsPath, JSON.stringify(next), "utf8").catch(() => {});
}, 5000);

// 一条自己的归属（显示脱敏后的本人号码），一条别人的（用于验证脱敏）。
await writeFile(path.join(tmp, "store-ownership.json"), JSON.stringify({
    version: 1,
    assignments: {
        "temu:634418217318103": { ownerId: account.id, ownerName: "13800000001", storeName: "City Beauty King", claimedAt: new Date().toISOString(), claimedBySelf: true },
        "temu:888877776666555": { ownerId: "u_someone_else", ownerName: "13912345678", storeName: "Sunrise Home Goods", claimedAt: new Date().toISOString(), claimedBySelf: true }
    }
}, null, 2), "utf8");

const port = Number(process.env.PREVIEW_PORT || 20900);
const env = {
    ...process.env,
    ZINIAO_PORT: String(port),
    ZINIAO_BIND: "127.0.0.1",
    ZINIAO_DATA_ROOT: tmp,
    TEMU_CREDENTIALS: credentialPath,
    ZINIAO_INSTANCE_ID: "preview"
};
delete env.TEMU_BASE_PATH;
const child = spawn(process.execPath, ["server.mjs"], { cwd: hubDir, env, stdio: ["ignore", "pipe", "pipe"] });
child.stdout.on("data", (data) => process.stdout.write(String(data)));
child.stderr.on("data", (data) => process.stdout.write(`[err] ${data}`));

console.log(`预览地址 http://127.0.0.1:${port}/login`);
console.log(`登录账号 13800000001 / preview12345`);
console.log(`数据目录 ${tmp}（临时目录，退出即弃）`);
process.on("SIGINT", () => { clearInterval(heartbeat); child.kill(); process.exit(0); });
await new Promise(() => {});
