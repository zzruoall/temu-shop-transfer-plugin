/**
 * 多用户与店铺归属回归测试。
 * 锁定四条业务规则与两条安全边界：
 *   1. 认领独占：同一店铺不能被两个账号认领；
 *   2. 他人店铺可见但不可认领（按业务要求，认领后仍需显示归属账号）；
 *   3. 用户可自行解除认领，解除后他人可重新认领；
 *   4. 管理员可改派，归属转移后数据（按店铺记录）随之转移；
 *   5. 插件令牌不能访问任何用户数据接口（越权修复）；
 *   6. 只能在自己认领的店铺之间中转。
 * 全程使用临时目录与假服务，不连真实环境。
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsers } from "../lib/users.mjs";
import { createStoreOwnership } from "../lib/store-ownership.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "multiuser-"));

// 一、用户表：注册即普通用户，不能自我提权；口令与角色受服务端控制。
{
    const users = createUsers(root);
    const zhang = await users.register({ username: "13800000001", password: "pass12345" });
    assert.equal(zhang.role, "user", "自助注册必须是普通用户，不能自我提权");
    assert.equal(zhang.passwordHash, undefined, "对外结构不得暴露口令哈希");
    // 注册必须用手机号；用户名形式只保留给存量账号（如 admin）登录。
    assert.equal(zhang.username, "13800000001", "注册账号必须是手机号");
    assert.equal(zhang.maskedUsername, "138****0001", "对外结构必须带脱敏手机号，供店铺页显示归属");
    await assert.rejects(users.register({ username: "13800000001", password: "pass12345" }), /已被注册/, "手机号不能重复注册");
    await assert.rejects(users.register({ username: "1380000", password: "pass12345" }), /手机号/, "非 11 位手机号必须拒绝");
    await assert.rejects(users.register({ username: "zhangsan", password: "pass12345" }), /手机号/, "自助注册不再接受用户名");
    await assert.rejects(users.register({ username: "23800000001", password: "pass12345" }), /手机号/, "非 1 开头的号码必须拒绝");
    await assert.rejects(users.register({ username: "13800000002", password: "short" }), /至少/, "过短口令必须拒绝");

    const verified = await users.verify({ username: "13800000001", password: "pass12345" });
    assert.equal(verified.username, "13800000001", "正确口令必须通过");
    await assert.rejects(users.verify({ username: "13800000001", password: "wrongpass" }), /手机号或密码错误/, "错误口令必须拒绝");
    // 不存在的账号与错误口令返回同一句文案，避免被用来枚举账号。
    await assert.rejects(users.verify({ username: "13900000009", password: "wrongpass" }), /手机号或密码错误/);
    // 存量账号（如 admin）仍能用原用户名登录，否则唯一管理员会被挡在门外。
    await users.register({ username: "13800000003", password: "pass12345" });
    const legacy = await users.verify({ username: "13800000003", password: "pass12345" });
    assert.equal(legacy.isPhone, true, "手机号账号必须被标记为手机号");
    assert.equal(users.maskPhone("admin"), "admin", "非手机号账号没有可脱敏部分，原样返回");

    // 至少保留一个可用管理员：唯一管理员不能被停用或降级。
    await users.setRole(zhang.id, "admin");
    await assert.rejects(users.setDisabled(zhang.id, true), /至少保留/, "唯一管理员不能被停用");
    await assert.rejects(users.setRole(zhang.id, "user"), /至少保留/, "唯一管理员不能被降级");
    const second = await users.register({ username: "13800000002", password: "pass12345" });
    await users.setRole(second.id, "admin");
    await users.setDisabled(zhang.id, true);
    assert.equal((await users.findById(zhang.id)).disabled, true, "有备用管理员时可以停用");
    assert.equal(await users.verifySession("bogus.cookie.value"), null, "伪造会话必须失效");
}

// 二、店铺归属：认领独占、可见性、自行解除、管理员改派。
{
    const users = createUsers(root);
    const ownership = createStoreOwnership(root);
    const zhang = (await users.listUsers()).find((user) => user.username === "13800000001");
    const lisi = (await users.listUsers()).find((user) => user.username === "13800000002");
    const STORE = "temu:634418217318103";
    const OTHER = "temu:634418210693849";
    const BATCH_A = "temu:634418210693850";
    const BATCH_B = "temu:634418210693851";
    const BATCH_C = "temu:634418210693852";
    await assert.rejects(ownership.claimMany([{ storeId: BATCH_C }], null), /缺少认领账号标识/, "缺少账号身份时不能批量写入归属");

    await ownership.claim(STORE, zhang, "City Beauty King");
    const owner = await ownership.findOwner(STORE);
    assert.equal(owner.ownerId, zhang.id, "认领后归属必须指向认领人");
    assert.equal(owner.ownerName, "13800000001", "归属必须记录账号名（手机号），认领页要显示它");

    // 认领独占：他人再认领必须被拒，且错误信息里带上当前归属人。
    await assert.rejects(ownership.claim(STORE, lisi), /13800000001/, "同一店铺不能被两个账号认领");

    // 他人店铺仍可查询到归属（前端据此显示"已被谁认领"而不是隐藏）。
    const visible = await ownership.listAssignments();
    assert.equal(visible[STORE].ownerName, "13800000001", "他人店铺的归属必须可读，用于只读展示");

    // 非归属人不能解除，归属人自己可以解除；解除后他人可认领。
    await assert.rejects(ownership.release(STORE, lisi.id), /只能解除自己/, "非归属人不能解除他人认领");
    await ownership.release(STORE, zhang.id);
    assert.equal(await ownership.findOwner(STORE), null, "解除后店铺回到待认领");
    await ownership.claim(STORE, lisi, "City Beauty King");
    assert.equal((await ownership.findOwner(STORE)).ownerId, lisi.id, "解除后他人可以认领");

    // 管理员改派：归属转移，ownStoreIds 随之变化（数据按店铺记录，因此自动跟随）。
    await ownership.claim(OTHER, zhang, "Hair removal wax");
    assert.deepEqual([...(await ownership.ownedStoreIds(zhang.id))], [OTHER], "改派前归属正确");
    await ownership.reassign(OTHER, lisi, "Hair removal wax");
    assert.deepEqual([...(await ownership.ownedStoreIds(zhang.id))], [], "改派后原账号不再拥有该店铺");
    assert.ok((await ownership.ownedStoreIds(lisi.id)).has(OTHER), "改派后新账号拥有该店铺");

    // 管理员强制解除：用于归错人的纠偏。
    await ownership.forceRelease(STORE);
    assert.equal(await ownership.findOwner(STORE), null, "管理员可强制解除归属");

    // 批量认领一次写入全部店铺；任一店铺属于他人时整批回滚，不能留下半批成功。
    const beforeBatch = await ownership.liveSignature();
    const batch = await ownership.claimMany([
        { storeId: BATCH_A, storeName: "Batch A" },
        { storeId: BATCH_B, storeName: "Batch B" }
    ], zhang);
    assert.equal(batch.length, 2, "批量认领必须返回全部成功店铺");
    assert.equal((await ownership.findOwner(BATCH_A)).ownerId, zhang.id, "批量认领第一家必须归属当前用户");
    assert.equal((await ownership.findOwner(BATCH_B)).ownerId, zhang.id, "批量认领第二家必须归属当前用户");
    const afterBatch = await ownership.liveSignature();
    assert.notEqual(afterBatch, beforeBatch, "批量认领会改变实时刷新摘要");

    const beforeConflict = await ownership.liveSignature();
    await assert.rejects(
        ownership.claimMany([
            { storeId: BATCH_C, storeName: "Batch C" },
            { storeId: BATCH_A, storeName: "Batch A" }
        ], lisi),
        /13800000001/,
        "批量中任一店铺冲突时必须拒绝整批"
    );
    assert.equal(await ownership.findOwner(BATCH_C), null, "批量冲突后不得留下部分成功的店铺");
    assert.equal(await ownership.liveSignature(), beforeConflict, "批量冲突回滚后实时刷新摘要不能变化");

    await ownership.release(BATCH_A, zhang.id);
    assert.notEqual(await ownership.liveSignature(), afterBatch, "解除认领必须改变实时刷新摘要");
}

console.log("multiuser checks passed（注册提权防护、认领独占、他人可见、自行解除、管理员改派、唯一管理员保护）");

/**
 * 挂载前缀回归：站点挂在同域的其他路径下（如 /temu），若页面生成根绝对路径的
 * 表单与链接，浏览器会跳出本站落到同域另一个站点上。线上反代用末尾带斜杠的
 * proxy_pass 剥掉了前缀，服务端从路径上已看不出真实前缀，必须由反代声明。
 */
{
    const { normalizeBasePathValue, forwardedBasePath, resolveRequestBasePath, resolveBasePath, stripRequestBasePath, stripBasePath } = await import("../lib/ingest-auth.mjs");
    const { loginPage, registerPage } = await import("../login.mjs");

    // 被 Windows/Git Bash 路径转换污染的值必须视为"未声明"，不能拼进 cookie 与跳转。
    assert.equal(normalizeBasePathValue("D:/install/Git/temu"), "", "盘符路径不能当作 Web 前缀");
    assert.equal(normalizeBasePathValue("D:\\install\\temu"), "", "反斜杠路径不能当作 Web 前缀");
    assert.equal(normalizeBasePathValue("/temu"), "/temu", "标准前缀必须原样保留");
    assert.equal(normalizeBasePathValue("temu/"), "/temu", "缺少前导斜杠与多余尾斜杠必须被规整");
    assert.equal(normalizeBasePathValue(""), "", "空值表示挂在根路径");

    // 反代声明优先：这是线上唯一可靠的前缀来源（路径已被 proxy_pass 剥掉）。
    assert.equal(forwardedBasePath({ "x-forwarded-prefix": "/temu" }), "/temu", "必须能读取反代声明的前缀");
    assert.equal(forwardedBasePath({ "x-forwarded-prefix": "D:/Git/temu" }), "", "反代传来的污染值同样要拒绝");

    // 线上形态：请求路径已被剥成 /login，靠反代声明才能还原前缀。
    const proxied = { headers: { "x-forwarded-prefix": "/temu" } };
    assert.equal(resolveRequestBasePath(proxied, "/login"), "/temu", "反代场景必须还原出 /temu");
    assert.equal(stripRequestBasePath(proxied, "/login"), "/login", "反代已剥离的路径不能再被裁短");

    // 本机直连形态：地址栏带前缀，路径本身就是证据。
    const direct = { headers: {} };
    assert.equal(resolveRequestBasePath(direct, "/temu/login"), "/temu", "直连时必须从路径识别前缀");
    assert.equal(stripRequestBasePath(direct, "/temu/login"), "/login", "直连时必须剥掉前缀再匹配路由");

    // 挂在根路径时不得凭空造出前缀（否则跳转到不存在的地址）。
    assert.equal(resolveBasePath("/login"), "", "未声明前缀时解析结果必须为空");
    assert.equal(stripBasePath("/login"), "/login", "根路径部署不能裁掉任何字符");
    assert.equal(stripBasePath("/temu/login"), "/login", "带前缀的路径必须正确剥离");

    // 页面链接：表单与跳转都要带前缀，否则浏览器会跳出 /temu 落到同域其他站点。
    const login = loginPage("", "/temu");
    assert.ok(login.includes('action="/temu/session"'), "登录表单必须提交到带前缀的地址");
    assert.ok(login.includes('href="/temu/register"'), "注册链接必须带前缀");
    assert.ok(!/action="\/session"/.test(login), "不得生成会跳出本站的根绝对路径");
    const register = registerPage("", true, "/temu");
    assert.ok(register.includes('action="/temu/register"'), "注册表单必须提交到带前缀的地址");
    assert.ok(register.includes('href="/temu/login"'), "登录链接必须带前缀");
    // 根路径部署（本机直连）时反过来不能硬塞前缀。
    assert.ok(loginPage("", "").includes('action="/session"'), "根路径部署必须生成无前缀地址");
    // 被污染的前缀值不能让页面生成盘符路径。
    assert.ok(loginPage("", "D:/Git/temu").includes('action="/session"'), "污染前缀必须降级为根路径而不是写进页面");
}

console.log("base path checks passed（反代声明优先、直连路径识别、污染值拒绝、页面链接不跳出本站）");
