/**
 * 账户类型回归：只使用系统临时目录和合成口令，不访问真实用户表或旧凭证。
 * 覆盖读路径兼容、创建入口边界、显式迁移幂等性、会话连续性和并发去重。
 */
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createUsers } from "../lib/users.mjs";

const previousCredentials = process.env.TEMU_CREDENTIALS;
// 必须在创建用户仓库前隔离旧凭证入口，防止本机环境变量触发真实凭证迁移。
delete process.env.TEMU_CREDENTIALS;
let root;
const password = "temporary-pass-123";

/** 合成存量账户以验证原口令仍可登录；所有口令材料仅用于临时测试库。 */
function fixtureUser(username, index, extra = {}) {
    const salt = String(index).padStart(32, "0");
    return {
        id: `u_fixture_${index}`,
        username,
        salt,
        passwordHash: scryptSync(password, salt, 64).toString("hex"),
        role: "user",
        disabled: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        passwordChangedAt: "",
        ...extra
    };
}

/** 每个场景创建独立的临时用户表，固定会话密钥用于检查迁移是否使已有会话失效。 */
async function fixtureStore(name, users, registrationOpen = true) {
    const directory = path.join(root, name);
    await mkdir(directory);
    const file = path.join(directory, "users.json");
    await writeFile(file, JSON.stringify({
        version: 1,
        sessionSecret: "a".repeat(64),
        registrationOpen,
        users
    }, null, 2), "utf8");
    return { directory, file, users: createUsers(directory) };
}

/** 同时比较内容和修改时间，避免将重复写入相同内容误判为幂等或纯读取。 */
async function snapshot(file) {
    return { content: await readFile(file, "utf8"), mtimeMs: (await stat(file)).mtimeMs };
}

/** 各个对外用户入口必须携带正确类型，但不能泄露口令或签名密钥。 */
function assertPublic(user, accountType) {
    assert.equal(user.accountType, accountType);
    for (const field of ["salt", "passwordHash", "passwordChangedAt", "sessionSecret"]) {
        assert.equal(Object.hasOwn(user, field), false, `对外结构不得泄露 ${field}`);
    }
}

try {
    root = await mkdtemp(path.join(os.tmpdir(), "verify-account-types-"));

    // 默认名单中的旧账户仍为生产类型；包括冷启动会话并发在内的读操作不能偷偷迁移。
    const seeded = [
        fixtureUser("admin", 1, { role: "admin" }),
        fixtureUser("13800000002", 2),
        fixtureUser("13800000003", 3),
        fixtureUser("13800000004", 4, { accountType: "production" }),
        fixtureUser("13800000005", 5, { accountType: "test" })
    ];
    const legacy = await fixtureStore("legacy", seeded);
    const beforeReads = await snapshot(legacy.file);
    const sessions = await Promise.all(seeded.map((user) => legacy.users.signSession(user.id)));
    await Promise.all(Array.from({ length: 120 }, async (_, index) => {
        const userIndex = index % seeded.length;
        assertPublic(await legacy.users.verifySession(sessions[userIndex].value), userIndex === 4 ? "test" : "production");
    }));
    for (const [index, user] of seeded.entries()) {
        const type = index === 4 ? "test" : "production";
        assertPublic(await legacy.users.findById(user.id), type);
        assertPublic(await legacy.users.verify({ username: user.username, password }), type);
        assertPublic(legacy.users.publicUser(user), type);
    }
    assert.deepEqual((await legacy.users.listUsers()).map((user) => user.accountType), ["production", "production", "production", "production", "test"]);
    assert.deepEqual(await snapshot(legacy.file), beforeReads, "读路径不能更改旧账户类型或重写用户表");

    // 显式迁移仅命中三个默认账户；原口令、角色、标识及会话密钥必须保持不变。
    const migrated = await legacy.users.assignInitialTestUsers();
    assert.deepEqual(migrated.map((user) => user.username), seeded.slice(0, 3).map((user) => user.username));
    migrated.forEach((user) => assertPublic(user, "test"));
    const persisted = JSON.parse(await readFile(legacy.file, "utf8"));
    assert.equal(persisted.sessionSecret, "a".repeat(64));
    assert.deepEqual(persisted.users, seeded.map((user, index) => ({ ...user, accountType: index < 3 ? "test" : user.accountType })));
    const afterMigration = await snapshot(legacy.file);
    await Promise.all(Array.from({ length: 10 }, () => legacy.users.assignInitialTestUsers()));
    await legacy.users.assignInitialTestUsers([]);
    await legacy.users.assignInitialTestUsers(["missing", "admin", " ADMIN "]);
    await assert.rejects(legacy.users.assignInitialTestUsers(null), { status: 400 });
    assert.deepEqual(await snapshot(legacy.file), afterMigration, "重复、空名单和缺失账户迁移不能写盘");

    // 重启重新规范化后，原有会话仍有效，测试标记仍保留，管理员也不能被降级。
    const reloaded = createUsers(legacy.directory);
    for (const [index, user] of seeded.entries()) {
        const type = index === 3 ? "production" : "test";
        assertPublic(await reloaded.verifySession(sessions[index].value), type);
        assertPublic(await reloaded.verify({ username: user.username, password }), type);
    }
    assert.equal((await reloaded.findById(seeded[0].id)).role, "admin");
    await assert.rejects(reloaded.setRole(seeded[0].id, "user"), { status: 409 });
    assert.deepEqual(await snapshot(legacy.file), afterMigration);

    // 迁移不能创建缺失账户，也不能按默认名单影响无关账户；自定义名单沿用登录匹配规则。
    const partial = await fixtureStore("partial", [fixtureUser("ADMIN", 6, { role: "admin" })], false);
    assert.equal((await partial.users.assignInitialTestUsers()).length, 1);
    assert.equal((await partial.users.listUsers()).length, 1);
    const unrelated = await legacy.users.assignInitialTestUsers([" 13800000004 ", "missing"]);
    assert.equal(unrelated.length, 1);
    assertPublic(unrelated[0], "test");

    // 未知类型只能回落为生产类型，不能绕过测试边界；规范化本身仍保持纯读取。
    const fallback = await fixtureStore("fallback", [fixtureUser("13900000001", 7, { accountType: "TEST" })]);
    const beforeFallback = await snapshot(fallback.file);
    assertPublic((await fallback.users.listUsers())[0], "production");
    assert.equal((await fallback.users.getState()).users[0].accountType, "production");
    assert.deepEqual(await snapshot(fallback.file), beforeFallback);

    // 两种创建入口都忽略请求中的角色和类型；只有管理端测试创建可绕过关闭注册。
    const freshDirectory = path.join(root, "fresh");
    const users = createUsers(freshDirectory);
    const freshFile = path.join(freshDirectory, "users.json");
    assert.deepEqual(await users.assignInitialTestUsers(), []);
    assert.equal((await users.listUsers()).length, 0);
    const initialEmpty = await snapshot(freshFile);
    await users.assignInitialTestUsers();
    assert.deepEqual(await snapshot(freshFile), initialEmpty);
    const production = await users.register({ username: "13800000002", password, accountType: "test", role: "admin" });
    assertPublic(production, "production");
    assert.equal(production.role, "user");
    assertPublic(await users.verifySession((await users.signSession(production.id)).value), "production");
    const openTest = await users.createTestUser({ username: "13900000002", password });
    assertPublic(openTest, "test");
    await users.setRegistrationOpen(false);
    const beforeRejection = await snapshot(freshFile);
    await assert.rejects(users.register({ username: "13800000003", password, accountType: "test" }), { status: 403 });
    assert.deepEqual(await snapshot(freshFile), beforeRejection);
    const test = await users.createTestUser({ username: " 13800000003 ", password, accountType: "production", role: "admin" });
    assertPublic(test, "test");
    assert.equal(test.role, "user");
    assert.equal(test.username, "13800000003");
    assert.equal(test.maskedUsername, "138****0003");
    assert.equal(test.isPhone, true);
    assert.equal((await users.registrationStatus()).registrationOpen, false);
    const testSession = await users.signSession(test.id);
    assertPublic(await users.verifySession(testSession.value), "test");
    assertPublic(await users.verify({ username: test.username, password }), "test");

    // 手机号、短口令、重复账号规则一致，失败不落盘；跨入口并发不能创建同名账户。
    const beforeInvalid = await snapshot(freshFile);
    for (const username of ["admin", "1380000", "23800000001", "12800000001", ""]) {
        await assert.rejects(users.createTestUser({ username, password }), { status: 400 });
        await assert.rejects(users.register({ username, password }), { status: 400 });
    }
    await assert.rejects(users.createTestUser({ username: "13800000006", password: "short" }), { status: 400 });
    await assert.rejects(users.createTestUser(), { status: 400 });
    await assert.rejects(users.createTestUser({ username: production.username, password }), { status: 409 });
    assert.deepEqual(await snapshot(freshFile), beforeInvalid);
    await users.setRegistrationOpen(true);
    await assert.rejects(users.register({ username: test.username, password }), { status: 409 });
    const concurrent = await Promise.allSettled([
        users.register({ username: "13800000006", password }),
        users.createTestUser({ username: "13800000006", password })
    ]);
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.find((result) => result.status === "rejected").reason.status, 409);
    assert.equal((await users.listUsers()).filter((user) => user.username === "13800000006").length, 1);

    // 后续改密、角色与停用操作不能丢失类型；停用后会话仍须即时失效。
    assertPublic(await users.changePassword(test.id, "changed-temporary-123"), "test");
    assertPublic(await users.setRole(test.id, "admin"), "test");
    assertPublic(await users.setRole(production.id, "admin"), "production");
    assertPublic(await users.setRole(test.id, "user"), "test");
    assertPublic(await users.setDisabled(test.id, true), "test");
    assert.equal(await users.verifySession(testSession.value), null);
    assertPublic(await users.setDisabled(test.id, false), "test");
    const restarted = createUsers(freshDirectory);
    assertPublic(await restarted.findById(production.id), "production");
    assertPublic(await restarted.findById(test.id), "test");
    assertPublic(await restarted.verify({ username: test.username, password: "changed-temporary-123" }), "test");
    assertPublic(await restarted.verifySession(testSession.value), "test");
    const finalState = JSON.parse(await readFile(freshFile, "utf8"));
    assert.ok(finalState.users.every((user) => ["production", "test"].includes(user.accountType)));
    assert.ok(finalState.users.every((user) => !Object.hasOwn(user, "password")));

    console.log("account type checks passed（旧账户兼容、读取不迁移、固定创建类型、关闭注册边界、显式迁移幂等、口令角色及会话保留、并发去重）");
} finally {
    if (previousCredentials === undefined) delete process.env.TEMU_CREDENTIALS;
    else process.env.TEMU_CREDENTIALS = previousCredentials;
    // 只清理本脚本由 mkdtemp 创建的目录，不接受外部路径，不接触线上数据。
    if (root) await rm(root, { recursive: true, force: true });
}
