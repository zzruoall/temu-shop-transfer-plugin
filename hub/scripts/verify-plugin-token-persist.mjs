/**
 * 插件令牌持久化回归。
 *
 * 令牌是 7 天的长期凭证：只写文件、启动时不读回，会让每次部署与重启都作废所有插件的令牌，
 * 每台机器都得重新注册，期间请求全部 401，现场表现为"插件莫名掉线"。
 * 同理，状态文件若落在发布目录内，每次部署换新发布目录也会清空令牌。
 * 测试用真实进程跑两遍（前一次签发、后一次重启后校验），并锁住权限边界不被恢复逻辑放宽。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = await mkdtemp(path.join(os.tmpdir(), "token-persist-"));
const credentialPath = path.join(tmp, "credentials.json");
await writeFile(credentialPath, JSON.stringify({ deviceToken: "test-device-token", passwordHash: "x", salt: "y" }), "utf8");

/** 起一个真实服务进程并等待就绪；端口独立，避免与其它测试互相占用。 */
async function startServer(port, tag) {
    const env = {
        ...process.env,
        ZINIAO_PORT: String(port),
        ZINIAO_BIND: "127.0.0.1",
        ZINIAO_DATA_ROOT: tmp,
        TEMU_CREDENTIALS: credentialPath,
        ZINIAO_INSTANCE_ID: tag
    };
    // 显式清掉可能来自外界的前缀与令牌路径，确保测的是默认行为。
    delete env.TEMU_BASE_PATH;
    delete env.TEMU_PLUGIN_TOKENS;
    const child = spawn(process.execPath, ["server.mjs"], { cwd: hubDir, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 80; i += 1) {
        await wait(200);
        try {
            // 用未登录也可见的登录页探活：/api/* 在云端认证下需要身份，不适合做就绪探测。
            const probe = await fetch(`http://127.0.0.1:${port}/login`);
            if (probe.ok) return child;
        } catch { /* 未就绪，继续等 */ }
    }
    child.kill("SIGKILL");
    throw new Error(`服务未能启动（${tag}）：${stderr.slice(-400)}`);
}

async function stopServer(child) {
    child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 700));
}

const port = 19800 + Math.floor(Math.random() * 150);
const pluginInstanceId = "token-persist-regression";
const registrationHeaders = { "content-type": "application/json", origin: "chrome-extension://efojbbfhfniieifmppafmigfmndbledc" };

const first = await startServer(port, "token-persist-first");
let base = `http://127.0.0.1:${port}`;
const registered = await fetch(`${base}/api/plugin/register`, {
    method: "POST",
    headers: registrationHeaders,
    body: JSON.stringify({ pluginInstanceId })
});
const issued = await registered.json();
assert.equal(registered.status, 200, "首次注册必须成功");
assert.ok(String(issued.token || "").startsWith("pt_"), "注册必须返回插件令牌");

// 状态文件必须落在共享数据目录，不能在发布目录里（否则部署换目录就清空）。
const stateFile = path.join(tmp, "plugin-tokens.json");
const persisted = JSON.parse(await readFile(stateFile, "utf8"));
assert.ok(persisted[issued.token], "令牌必须写入数据目录下的状态文件");
assert.equal(persisted[issued.token].instanceId, pluginInstanceId, "状态文件必须记录实例标识");

await stopServer(first);

// 重启：换一个端口重新拉起，验证令牌能从磁盘恢复。
const second = await startServer(port + 300, "token-persist-second");
base = `http://127.0.0.1:${port + 300}`;

const reused = await fetch(`${base}/api/agents/register`, {
    method: "POST",
    headers: { ...registrationHeaders, "x-forwarded-prefix": "/temu", authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ storeId: "persist-store", storeName: "persist-store", pluginInstanceId })
});
assert.equal(reused.status, 200, "重启后旧令牌必须仍然有效，否则每次部署都会让所有插件掉线");

// 恢复令牌不能放宽权限边界：插件令牌依旧读不了用户数据。
const escalated = await fetch(`${base}/api/overview`, {
    headers: { authorization: `Bearer ${issued.token}`, "x-forwarded-prefix": "/temu" }
});
assert.equal(escalated.status, 403, "恢复后的插件令牌依旧不能访问用户数据接口");

// 同一实例重复注册必须复用同一令牌，否则插件每次刷新都会换新令牌、留下大量僵尸凭证。
const repeat = await fetch(`${base}/api/plugin/register`, {
    method: "POST",
    headers: registrationHeaders,
    body: JSON.stringify({ pluginInstanceId })
});
const repeatBody = await repeat.json();
assert.equal(repeatBody.token, issued.token, "同一插件实例重复注册必须复用已有令牌");

await stopServer(second);

console.log("plugin token persist checks passed（令牌跨重启保持有效、状态文件在数据目录、权限边界不放宽、同实例复用令牌）");
