/**
 * 登录跳转目标（next 参数）的白名单回归。
 *
 * 为什么需要白名单：登录页如果无条件跳回请求参数指定的地址，
 * 就成了开放重定向——攻击者构造 /temu/login?next=https://evil.example，
 * 受害者看到的是我们的域名、却会被带去钓鱼站；同域其他路径（如 /temuadmin）
 * 也可能被误当成"我们站内的页面"而把用户送过去。
 *
 * 这个能力本身是必要的：管理员从 /temu/admin 被送来登录，
 * 登录成功必须回到 /temu/admin，否则他会以为管理界面不存在。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../cloud-auth.mjs", import.meta.url), "utf8");
// 从源码里取出 safeNext 单独执行：它是纯函数，不需要起服务。
const start = source.indexOf("function safeNext");
const end = source.indexOf("async function handleLogin");
assert.ok(start >= 0 && end > start, "必须能在 cloud-auth.mjs 中找到 safeNext");
const safeNext = new Function(`return ${source.slice(start, end).trim()}`)();

// 一、站内页面必须通过，并带上正确的挂载前缀。
for (const basePrefix of ["/temu", ""]) {
    assert.equal(safeNext("/temu/admin", "/temu"), "/temu/admin", "站内页面必须通过");
    assert.equal(safeNext("/admin", "/temu"), "/temu/admin", "缺前缀的写法要补回前缀");
    assert.equal(safeNext("/temu/", "/temu"), "/temu/", "首页必须通过");
    assert.equal(safeNext("/admin", ""), "/admin", "根路径部署时不应凭空加前缀");
}

// 二、开放重定向必须拒绝：外部地址、协议相对地址、反斜杠绕过。
for (const evil of ["https://evil.example/x", "http://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
    assert.equal(safeNext(evil, "/temu"), "", `危险目标必须拒绝：${evil}`);
}

// 三、同域其他路径不能被误当前缀：/temuadmin 不是 /temu 下的页面。
{
    const result = safeNext("/temuadmin", "/temu");
    assert.notEqual(result, "/temuadmin", "/temuadmin 不应被当作站内返回目标");
    assert.equal(result, "/temu/temuadmin", "非同前缀路径按普通站内路径处理并补前缀");
}

// 四、回到登录/注册/会话这些页面没有意义，应当拒绝（避免登录后原地打转）。
for (const pointless of ["/temu/login", "/login", "/temu/register", "/register", "/temu/session", "/session"]) {
    assert.equal(safeNext(pointless, "/temu"), "", `不应跳回 ${pointless}`);
}

// 五、空值与其他非法输入一律当作"没有指定"，由调用方回首页。
for (const blank of ["", "   ", null, undefined]) {
    assert.equal(safeNext(blank, "/temu"), "", "空值必须视为未指定");
}

console.log("login next checks passed（站内页面放行、开放重定向拒绝、同前缀站点不误判、回登录页无意义）");
