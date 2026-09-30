/**
 * 登录后静态资源间歇性 500 的回归测试。
 *
 * 现场症状：登录成功后页面主内容区一片空白（侧栏是 HTML 静态内容所以仍在），
 * nginx 访问日志里 app.js / styles.css / favicon.svg 夹杂 500，且都紧跟在登录请求之后。
 *
 * 根因：用户表读取路径每次都会落盘（writeState 要删备份再把 users.json 改名为 .bak），
 * 而每个请求的会话校验都会读它；并发请求落在改名窗口时读不到主文件，兜底读的又是同一个
 * 被移走的文件，于是抛错 -> 500。这里用并发会话校验复现，并确认读取路径不再写盘。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsers } from "../lib/users.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "users-race-"));

await writeFile(path.join(root, "users.json"), JSON.stringify({
    version: 1,
    sessionSecret: "a".repeat(64),
    registrationOpen: true,
    users: [{
        id: "u_probe000001",
        username: "racer",
        salt: "b".repeat(32),
        passwordHash: "c".repeat(128),
        role: "user",
        disabled: false,
        createdAt: new Date().toISOString(),
        passwordChangedAt: ""
    }]
}, null, 2), "utf8");

const stateFile = path.join(root, "users.json");
const before = await stat(stateFile);

const users = createUsers(root);
const session = await users.signSession("u_probe000001");

// 先做一次读，让状态进入缓存（真实场景里服务启动后必然已经读过）。
await users.verifySession(session.value);

/**
 * 并发会话校验：这正是登录后浏览器同时拉取 app.js、styles.css、overview 的真实时序。
 * 若读取路径仍会写盘，这里就会命中改名窗口而抛出异常。
 */
const concurrent = await Promise.allSettled(
    Array.from({ length: 120 }, () => users.verifySession(session.value))
);
const failed = concurrent.filter((item) => item.status === "rejected");
assert.equal(failed.length, 0, `并发会话校验不得失败，实际失败 ${failed.length} 个：${failed[0] && failed[0].reason && failed[0].reason.message}`);

const verified = concurrent.filter((item) => item.status === "fulfilled").map((item) => item.value).filter(Boolean);
assert.equal(verified.length, 120, "并发校验必须全部识别出登录用户");

// 纯读取不能改动文件：mtime 与大小都应保持不变。
const afterReads = await stat(stateFile);
assert.equal(afterReads.mtimeMs, before.mtimeMs, "会话校验属于纯读取，不得写盘（写盘会制造改名窗口并让并发请求 500）");
assert.equal(afterReads.size, before.size, "纯读取不得改变用户表大小");

// 备份与临时文件都不该被读路径制造出来。
for (const leftover of [`${stateFile}.bak`, `${stateFile}.tmp`]) {
    await assert.rejects(stat(leftover), /ENOENT/, `纯读取不得产生 ${path.basename(leftover)}`);
}

// 真正写操作仍然要落盘，并让后续读取看到新数据（缓存必须同步更新）。
await users.register({ username: "13800000009", password: "newcomer12345" });
const persisted = JSON.parse(await readFile(stateFile, "utf8"));
assert.equal(persisted.users.length, 2, "注册必须落盘，否则重启后账号丢失");
assert.ok(persisted.users.some((user) => user.username === "13800000009"), "新账号必须写入用户表");

// 写后读取要立即看到新账号，不能被旧缓存盖住。
const listed = await users.listUsers();
assert.equal(listed.length, 2, "写入后读取必须反映最新状态");

// 停用后会话立即失效；这条依赖读缓存与磁盘一致。
const target = listed.find((user) => user.username === "13800000009");
const second = await users.signSession(target.id);
assert.ok(await users.verifySession(second.value), "新账号的会话应当有效");
await users.setDisabled(target.id, true);
assert.equal(await users.verifySession(second.value), null, "停用后会话必须立即失效");

console.log("users state race checks passed（读取不写盘、并发会话校验不失败、写后缓存同步、停用即时生效）");
