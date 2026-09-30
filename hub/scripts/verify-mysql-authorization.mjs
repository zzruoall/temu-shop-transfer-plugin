import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";
import { openMysqlDatabase } from "../lib/mysql-database.mjs";
import { initializeMysqlSchema } from "../lib/mysql-schema.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";
import { createStoreOwnership } from "../lib/store-ownership.mjs";
import { createUsers } from "../lib/users.mjs";

// 只允许已有隔离 MySQL 实例；不读取正式配置，随机测试库避免与父进程回归互相覆盖。
const admin = await mysql.createConnection({ host: "127.0.0.1", port: 33917, user: "root", connectTimeout: 3000 });
const name = `temu_auth_test_${randomUUID().replaceAll("-", "")}`;
let database;
let child;
let created = false;
let success = false;
const originalCredentials = process.env.TEMU_CREDENTIALS;
try {
    const [[instance]] = await admin.query("SELECT @@datadir AS dataRoot");
    assert.match(instance.dataRoot.replaceAll("\\", "/"), /\/mysql-isolated[^/]*\/?$/i, "拒绝在非隔离数据库实例执行测试");
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    created = true;
    const root = await mkdtemp(path.join(tmpdir(), "temu-mysql-auth-"));
    const config = path.join(root, "mysql.json");
    const credentials = path.join(root, "credentials.json");
    await writeFile(config, JSON.stringify({ host: "127.0.0.1", port: 33917, user: "root", database: name }));
    await writeFile(credentials, JSON.stringify({ deviceToken: "authorization-test-device" }));
    process.env.TEMU_CREDENTIALS = credentials;
    database = await openMysqlDatabase(config);
    await initializeMysqlSchema(database);
    await database.query("maintenance", "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    const users = createUsers(root);
    const alice = await users.register({ username: "13800000001", password: "test-password" });
    const bob = await users.register({ username: "13800000002", password: "test-password" });
    const administrator = await users.register({ username: "13800000003", password: "test-password" });
    await users.setRole(administrator.id, "admin");
    const ownership = createStoreOwnership(root, { database });
    for (const [id, owner] of [["source-a", alice], ["target-a", alice], ["source-b", bob], ["target-b", bob]]) {
        await ownership.claim(id, owner);
    }
    // 直推来源必须带可核对身份的原始资料对象，否则会被传输校验拦下。
    let products = Array.from({ length: 201 }, (_, i) => ({ spuId: String(8000000000 + i), ready: true, title: "权限测试商品", images: ["https://invalid.test/a"], skuIds: ["1"], skcIds: ["2"], publicationData: { sourceProduct: { productId: String(8000000000 + i) } } }));
    let blockedSources = 0;
    const store = {
        getBatch: async id => ({ sourceStoreId: id === "batch-b" ? "source-b" : "source-a", products }),
        listOverview: async () => ({ products: [] }),
        // 直推下发前服务端要核对来源原包；桩只做一致性透传，真实校验由传输完整性用例覆盖。
        verifyBatchTransfer: async (_batch, items) => items,
        markProductBlocked: async () => { blockedSources += 1; }
    };
    const queue = createJobQueue(root, store, { database, ownership });
    const accessA = { userId: alice.id };
    const accessB = { userId: bob.id };
    const inputA = { sourceStoreId: "source-a", targetStoreId: "target-a", sourceBatchId: "batch-a", spuIds: [products[0].spuId] };
    const inputB = { sourceStoreId: "source-b", targetStoreId: "target-b", sourceBatchId: "batch-b", spuIds: [products[0].spuId] };
    const jobA = await queue.createJob(inputA, accessA);
    const jobB = await queue.createJob(inputB, accessB);

    // 权限失败不能写任务、删除日志或改变 SSE 版本；正文伪造账号不能替代服务端 access 参数。
    const before = await queue.liveSignature(null);
    await assert.rejects(queue.reportOpenResult({ jobId: jobB.id, storeId: "target-b", status: "failed", userId: bob.id }, accessA), { status: 403 });
    await assert.rejects(queue.clearStoreActivity("target-b", accessA), { status: 403 });
    assert.equal((await queue.getJob(jobB.id)).items[0].status, "queued");
    assert.deepEqual(await queue.liveSignature(null), before);
    await queue.reportOpenResult({ jobId: jobA.id, storeId: "target-a", status: "opened" }, accessA);
    assert.equal((await queue.getJob(jobA.id)).items[0].status, "opened");

    // 明细上界按去重后的 SPU 计算，200 件允许，201 件在读取商品批次之前拒绝。
    await assert.rejects(queue.createJob({ ...inputA, spuIds: products.map(p => p.spuId) }, accessA), {
        status: 400, message: "单个任务最多200件，请分批下发"
    });
    const capped = await queue.createJob({ ...inputA, spuIds: [...products.slice(0, 200).map(p => p.spuId), products[0].spuId] }, accessA);
    assert.equal(capped.items.length, 200);
    // 本用例核对的是授权边界，不是容量：目标店另有"待处理不超过200件"的容量保护，
    // 200 件任务已占满名额，后续用例需要先取消它，否则会被容量而不是权限拦下。
    await queue.cancelJob(capped.id, accessA);

    // SQL 人工任务与接口任务不能被旧工人打开回传改写，管理员绕过归属也不能绕过模式约束。
    const identity = { storeId: "target-a", storeName: "Target A", pageStoreName: "Target A", pluginInstanceId: "authorization-instance-a", pluginVersion: "10.10.61", schedulingProtocol: 1, pluginDetected: true, identityMatched: true };
    await queue.registerAgent(identity);
    const manual = await queue.createJob({ ...inputA, targetStoreName: identity.storeName, requireOnline: true }, accessA);
    for (const access of [accessA, null]) {
        await assert.rejects(queue.reportOpenResult({ jobId: manual.id, storeId: "target-a", status: "opened" }, access), { status: 409 });
    }
    assert.equal((await queue.getJob(manual.id)).items[0].status, "queued");

    // 按需解压后阻断超大单件，正常后继仍可领取；来源商品不能因此被标红。
    products = [{ ...products[0], spuId: "huge", publicationData: { sourceProduct: { productId: "huge" } }, detail: { text: "x".repeat(4 * 1024 * 1024) } }, { ...products[1], spuId: "small", publicationData: { sourceProduct: { productId: "small" } } }];
    const sized = await queue.createJob({ ...inputA, spuIds: ["huge", "small"], targetStoreName: identity.storeName, requireOnline: true }, accessA);
    const claimed = await queue.claimJobs({ ...identity, manualUploadsOnly: true });
    assert.ok(claimed.claimed.some(item => item.spuId === "small" && item.snapshot));
    assert.ok(!claimed.claimed.some(item => item.spuId === "huge"));
    const oversized = (await queue.getJob(sized.id)).items.find(item => item.spuId === "huge");
    assert.equal(oversized.status, "blocked");
    assert.equal(oversized.reason, "商品资料超过插件单次接收额度，请精简后重新下发");
    assert.equal(blockedSources, 0);

    // 只拥有目标店也可以清理该店日志，来源店属于其他账号不应阻止合法清理。
    await ownership.reassign("source-a", bob);
    await assert.rejects(queue.reportOpenResult({ jobId: capped.id, storeId: "target-a", status: "failed" }, accessA), { status: 403 });
    await queue.clearStoreActivity("target-a", accessA);
    const [[remaining]] = await database.query("query", "SELECT COUNT(*) AS n FROM hub_work_logs WHERE store_id='target-a'");
    assert.equal(Number(remaining.n), 0);

    // 改派持有归属行锁时发起删除，删除必须在同一事务等待并按提交后的新归属拒绝。
    const connection = admin;
    await connection.beginTransaction();
    await connection.query(`UPDATE ${name}.hub_map_entries SET body=JSON_SET(body,'$.ownerId',?) WHERE domain='ownership' AND entry_key='target-b'`, [alice.id]);
    let settled = false;
    const pending = queue.clearStoreActivity("target-b", accessB).then(
        () => { settled = true; return null; },
        error => { settled = true; return error; }
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    const waited = !settled;
    await connection.commit();
    assert.equal((await pending)?.status, 403);
    assert.ok(waited, "日志删除必须等待归属锁，不能在另一连接提前鉴权");
    await ownership.reassign("target-b", bob);

    // 实际 HTTP 会话覆盖所有插件入口；插件令牌使用隔离目录内的既有令牌，不触发外部注册。
    const token = `pt_${randomUUID().replaceAll("-", "")}`;
    const identityB = { ...identity, storeId: "target-b", storeName: "Target B", pageStoreName: "Target B", pluginInstanceId: "authorization-instance-b" };
    await queue.registerAgent(identityB);
    await writeFile(path.join(root, "plugin-tokens.json"), JSON.stringify({ [token]: { instanceId: identityB.pluginInstanceId, issuedAt: Date.now(), disabled: false } }));
    const env = { ...process.env, TEMU_MYSQL_CONFIG: config, TEMU_CREDENTIALS: credentials, TEMU_BASE_PATH: "", TEMU_PLUGIN_TOKENS: path.join(root, "plugin-tokens.json"), ZINIAO_DATA_ROOT: root, ZINIAO_BIND: "127.0.0.1", ZINIAO_INSTANCE_ID: name, ZINIAO_TEST_EPHEMERAL: "1", ZINIAO_SEED: "0", ZINIAO_WATCH_DIR: path.join(root, "inbox") };
    child = fork(fileURLToPath(new URL("../server.mjs", import.meta.url)), [], { env, windowsHide: true, silent: true });
    let errors = "";
    child.stderr.on("data", chunk => { errors += String(chunk); });
    child.stdout.resume();
    const ready = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`测试服务启动超时: ${errors}`)), 15000);
        child.once("error", error => { clearTimeout(timer); reject(error); });
        child.once("exit", code => { clearTimeout(timer); reject(new Error(`测试服务提前退出 ${code}: ${errors}`)); });
        child.on("message", message => { if (message.type === "listening" && message.instanceId === name) { clearTimeout(timer); resolve(message); } });
    });
    const origin = `http://127.0.0.1:${ready.port}`;
    const headersA = { cookie: `temu_session=${(await users.signSession(alice.id)).value}` };
    const headersB = { cookie: `temu_session=${(await users.signSession(bob.id)).value}` };
    const headersAdmin = { cookie: `temu_session=${(await users.signSession(administrator.id)).value}` };
    const pluginHeaders = { authorization: `Bearer ${token}` };
    /** 只访问本次 IPC 返回的临时端口，请求设超时以便异常时仍能清理子进程。 */
    async function request(route, body, headers, expected, method = "POST") {
        const response = await fetch(`${origin}${route}`, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "manual" });
        const payload = await response.json();
        assert.equal(response.status, expected, `${route}: ${JSON.stringify(payload)}`);
        return payload;
    }
    for (const route of ["/api/agents/register", "/api/jobs/claim", "/api/jobs/report", "/api/jobs/target-task-states", "/api/jobs/direct-progress"]) {
        await request(route, { ...identityB, jobId: jobB.id, spuId: "8000000000", status: "failed", tasks: [], userId: bob.id }, headersA, 403);
        await request(route, { ...identityB, storeId: "", userId: bob.id }, headersA, 403);
    }
    await request("/api/jobs/open-result", { jobId: jobB.id, storeId: "target-b", status: "failed", userId: bob.id }, headersA, 403);
    await request("/api/work-log", { storeId: "target-b", userId: bob.id }, headersA, 403, "DELETE");
    await request("/api/jobs/open-result", { jobId: jobB.id, storeId: "target-b", status: "opened" }, headersB, 200);
    await request("/api/jobs/open-result", { jobId: manual.id, storeId: "target-a", status: "opened" }, headersAdmin, 409);
    await request("/api/agents/register", identityB, headersB, 200);
    await request("/api/agents/register", identityB, pluginHeaders, 200);
    await request("/api/agents/register", { ...identityB, pluginInstanceId: "forged-instance" }, pluginHeaders, 403);
    await request("/api/jobs/target-task-states", { ...identityB, tasks: [{ jobId: jobB.id, spuId: "8000000000" }] }, pluginHeaders, 200);
    const claimB = await request("/api/jobs/claim", identityB, pluginHeaders, 200);
    assert.equal(claimB.claimed.length, 1);
    await request("/api/jobs/report", { ...identityB, ...claimB.claimed[0], status: "identity_verified" }, pluginHeaders, 200);
    await request("/api/jobs/direct-progress", { ...identityB, jobId: jobB.id, spuId: "8000000000", phase: "begin" }, pluginHeaders, 409);
    await request("/api/work-log", { storeId: "target-b" }, pluginHeaders, 403, "DELETE");
    await request("/api/work-log", { storeId: "target-b" }, headersAdmin, 200, "DELETE");
    await request("/api/agents/register", identityB, { authorization: "Bearer authorization-test-device" }, 200);
    success = true;
    console.log(JSON.stringify({ passed: true, sessionRoutes: 5, transactionalOwnership: true, legacyIdentity: true, manualOpenDenied: true, pluginTokenCompatible: true, sqlItemLimit: 200, oversizedBlockedWithoutSourceMark: true }));
} finally {
    if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill();
        await stopped;
    }
    await admin.rollback().catch(() => {});
    if (database) await database.close();
    // 只删除本脚本创建且已验证通过的随机测试库，失败库保留定位；不删除任何用户目录。
    if (created && success) await admin.query(`DROP DATABASE ${name}`);
    else if (created) console.error(`保留隔离失败库: ${name}`);
    await admin.end();
    if (originalCredentials === undefined) delete process.env.TEMU_CREDENTIALS;
    else process.env.TEMU_CREDENTIALS = originalCredentials;
}
