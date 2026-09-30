/**
 * 存量账号兼容回归：登录改成手机号后，已有的 admin（非手机号）必须仍能登录并管理账号。
 *
 * 这是上线前的硬约束：线上只有一个 admin 账号，它的用户名不是手机号。
 * 如果新校验把非手机号账号一律拒绝，唯一管理员会被挡在门外，没人能再管理账号与店铺。
 * 同时锁住"新注册必须是手机号"与"对外结构必须带脱敏字段"这两条新规则。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scryptSync, randomBytes } from "node:crypto";
import { createUsers, maskPhone } from "../lib/users.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "legacy-admin-"));

// 造一份"存量用户表"：只有一个非手机号的管理员，模拟线上现状。
const salt = randomBytes(16).toString("hex");
await writeFile(path.join(root, "users.json"), JSON.stringify({
    version: 1,
    sessionSecret: randomBytes(32).toString("hex"),
    registrationOpen: true,
    users: [{
        id: "u_legacy_admin",
        username: "admin",
        salt,
        passwordHash: scryptSync("legacy-password-123", salt, 64).toString("hex"),
        role: "admin",
        disabled: false,
        createdAt: new Date().toISOString(),
        passwordChangedAt: ""
    }]
}, null, 2), "utf8");

const users = createUsers(root);

// 一、存量管理员必须能登录，且角色与脱敏字段正确。
{
    const admin = await users.verify({ username: "admin", password: "legacy-password-123" });
    assert.equal(admin.username, "admin", "存量管理员必须能用原用户名登录");
    assert.equal(admin.role, "admin", "角色必须保持管理员");
    assert.equal(admin.isPhone, false, "非手机号账号必须被标记");
    assert.equal(admin.maskedUsername, "admin", "非手机号账号没有可脱敏部分，原样返回便于识别");
}

// 二、错误口令仍然拒绝，不能因为兼容旧账号就放宽校验。
{
    await assert.rejects(users.verify({ username: "admin", password: "wrong-password" }), /手机号或密码错误/);
    // 不存在的账号与错误口令返回同一句文案，避免被用来枚举账号。
    await assert.rejects(users.verify({ username: "13800000000", password: "wrong-password" }), /手机号或密码错误/);
}

// 三、管理员功能仍然可用：改密、停用、改角色、注册开关。
{
    await users.setRegistrationOpen(false);
    assert.equal((await users.registrationStatus()).registrationOpen, false, "管理员必须能关闭注册");
    await users.setRegistrationOpen(true);

    const created = await users.register({ username: "13800000088", password: "newpass12345" });
    await users.changePassword(created.id, "changed12345");
    await users.verify({ username: "13800000088", password: "changed12345" });
    await users.setDisabled(created.id, true);
    await assert.rejects(users.verify({ username: "13800000088", password: "changed12345" }), /停用/, "停用必须生效");
}

// 四、新注册必须是手机号；用户名形式只保留给存量账号登录。
{
    await assert.rejects(users.register({ username: "someone", password: "newpass12345" }), /手机号/, "自助注册不再接受用户名");
    await assert.rejects(users.register({ username: "1380000000", password: "newpass12345" }), /手机号/, "位数不足必须拒绝");
    await assert.rejects(users.register({ username: "23800000088", password: "newpass12345" }), /手机号/, "非 1 开头必须拒绝");
    const ok = await users.register({ username: "13800000099", password: "newpass12345" });
    assert.equal(ok.maskedUsername, "138****0099", "手机号注册后必须返回脱敏形式");
}

// 五、脱敏函数本身：手机号遮蔽中间四位，非手机号原样返回。
{
    assert.equal(maskPhone("13812345678"), "138****5678");
    assert.equal(maskPhone("13912345678"), "139****5678");
    assert.equal(maskPhone("admin"), "admin");
    assert.equal(maskPhone(""), "");
}

// 六、会话仍然可用（改口令不影响其他人的会话，因为签名密钥独立）。
{
    const session = await users.signSession("u_legacy_admin");
    const restored = await users.verifySession(session.value);
    assert.equal(restored.username, "admin", "存量管理员的会话必须可用");
    assert.equal(await users.verifySession("bogus.cookie.value"), null, "伪造会话必须失效");
}

console.log("legacy admin checks passed（存量管理员可登录、管理功能可用、新注册限手机号、脱敏正确）");
