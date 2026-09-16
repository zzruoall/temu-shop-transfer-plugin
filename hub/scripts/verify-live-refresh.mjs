/**
 * 核对网站自动刷新信号：在线店铺、新入库商品、任务和工作日志的变化必须能被比较出来，
 * 没有变化时必须保持稳定。信号抖动会让网页被自己的轮询反复重绘，漏报则退回手动刷新。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJobQueue } from "../lib/job-queue.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SOURCE_STORE_ID = "27565374641388";
const TARGET_STORE_ID = "27751811499835";
const INSTANCE_ID = randomBytes(8).toString("hex");
const TOKEN = "live-refresh-verify-token";

/** 先占一个本机空闲端口再交给子进程，避免和正在运行的入库台抢占同一端口。 */
async function pickFreePort() {
    return await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port = address && address.port;
            server.close((error) => {
                if (error) reject(error);
                else if (!port) reject(new Error("未能分配测试端口"));
                else resolve(port);
            });
        });
    });
}

function waitForExit(child, timeoutMs) {
    return new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode != null) {
            resolve(true);
            return;
        }
        const timer = setTimeout(() => resolve(false), timeoutMs);
        child.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
        });
    });
}

async function stopChild(child) {
    if (!child || child.exitCode != null || child.signalCode != null) return;
    try { child.kill(); } catch {}
    if (await waitForExit(child, 5000)) return;
    try { child.kill("SIGKILL"); } catch {}
    if (await waitForExit(child, 3000)) return;
    if (process.platform === "win32" && child.pid) {
        await new Promise((resolve) => {
            const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
            killer.once("exit", resolve);
            killer.once("error", resolve);
        });
        if (await waitForExit(child, 3000)) return;
    }
    throw new Error(`测试服务未能退出 pid=${child.pid}`);
}

async function fetchJson(url, options = {}) {
    const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(8000) });
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`${url} 返回了非 JSON：HTTP ${response.status}`);
    }
    return { status: response.status, ok: response.ok, body };
}

/** 必须对上本次 instanceId，才能证明连到的是刚 spawn 的进程而不是同端口的旧服务。 */
async function waitForServer(child, origin, timeoutMs = 12000) {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < timeoutMs) {
        if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${lastError}`);
        try {
            const { body } = await fetchJson(`${origin}/api/ingest-info`);
            if (body && body.service === "shop-hub" && body.instanceId === INSTANCE_ID) return body;
            throw new Error(`port occupied by other service: instanceId=${body && body.instanceId || "missing"}`);
        } catch (error) {
            lastError = String(error && error.message || error);
            if (/port occupied by other service/.test(lastError)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`server did not start: ${lastError}`);
}

// ---------- 第一段：任务队列信号（不依赖 HTTP） ----------

const queueRoot = await mkdtemp(path.join(os.tmpdir(), "shop-hub-live-queue-"));
const readyProduct = {
    spuId: "7744886733",
    goodsId: "9001",
    title: "测试商品",
    ready: true,
    images: ["https://example.com/a.jpg"],
    skuIds: ["1"],
    skcIds: ["2"],
    skus: [{ skuId: "1", price: 12.5, specs: [{ name: "规格", value: "单瓶" }] }],
    detail: { detailHtml: "<p>详情正文</p>" }
};
const liveStore = {
    async listOverview() {
        return { products: [readyProduct] };
    },
    async getBatch(id) {
        if (id !== "batch-1") return null;
        return {
            id: "batch-1",
            sourceStoreId: SOURCE_STORE_ID,
            sourceStoreName: "City Beauty King",
            shopName: "City Beauty King",
            products: [readyProduct]
        };
    }
};

try {
    const queue = createJobQueue(queueRoot, liveStore);
    const heartbeat = {
        pluginInstanceId: "live-refresh-verify",
        pluginVersion: "10.10.37",
        pluginDetected: true,
        identityMatched: true,
        storeId: TARGET_STORE_ID,
        storeName: "Hair removal wax",
        pageUrl: "https://agentseller.temu.com/goods/list",
        source: "plugin"
    };

    const empty = await queue.liveSignature();
    assert.equal(empty.agents, "", "没有登记插件时在线店铺信号应为空");
    assert.equal(empty.jobs, "", "没有任务时任务信号应为空");
    assert.equal(empty.logs, "", "没有日志时日志信号应为空");
    assert.deepEqual(await queue.liveSignature(), empty, "没有任何变化时信号必须保持稳定");

    await queue.registerAgent(heartbeat);
    const online = await queue.liveSignature();
    assert.notEqual(online.agents, empty.agents, "插件上线必须改变在线店铺信号");
    assert.ok(online.agents.includes(`${TARGET_STORE_ID}:1:`), "在线店铺信号必须标记该店在线且可接收上传");

    // 插件每 8 秒心跳一次；信号必须忽略 lastSeenAt，否则商品库会被无意义地反复重绘。
    await queue.registerAgent({ ...heartbeat });
    assert.deepEqual(await queue.liveSignature(), online, "重复心跳只刷新 lastSeenAt，不能改变刷新信号");

    // 心跳停止超过在线窗口后没有任何写入，信号仍必须自行翻转为离线。
    const statePath = path.join(queueRoot, "data", "jobs.json");
    const persisted = JSON.parse(await readFile(statePath, "utf8"));
    persisted.agents[0].lastSeenAt = new Date(Date.now() - 90 * 1000).toISOString();
    await writeFile(statePath, JSON.stringify(persisted, null, 2), "utf8");
    const offline = await queue.liveSignature();
    assert.notEqual(offline.agents, online.agents, "心跳超时后必须被识别为离线");
    assert.ok(offline.agents.includes(`${TARGET_STORE_ID}:0:`), "离线店铺必须标记为不在线");
    assert.deepEqual(await queue.liveSignature(), offline, "离线状态必须稳定，不能每次轮询都变化");

    const created = await queue.createJob({
        sourceStoreId: SOURCE_STORE_ID,
        targetStoreId: TARGET_STORE_ID,
        sourceStoreName: "City Beauty King",
        targetStoreName: "Hair removal wax",
        sourceBatchId: "batch-1",
        spuIds: ["7744886733"]
    });
    const afterJob = await queue.liveSignature();
    assert.notEqual(afterJob.jobs, offline.jobs, "新建任务必须改变任务信号");
    assert.ok(afterJob.jobs.includes(created.id), "任务信号必须包含新建任务编号");
    assert.notEqual(afterJob.logs, offline.logs, "创建任务写下工作日志后，日志信号必须变化");
    assert.deepEqual(await queue.liveSignature(), afterJob, "任务稳定后信号必须保持稳定");
    console.log("live signal checks passed（店铺在线、掉线、任务与日志）");
} finally {
    await rm(queueRoot, { recursive: true, force: true });
}

// ---------- 第二段：HTTP 侧 /api/live 与入库信号 ----------

const packet = {
    schemaVersion: 4,
    kind: "full-capture-packet",
    exportMode: "full-capture",
    source: {
        pageUrl: "https://agentseller.temu.com/goods/list",
        allowedSpuIds: ["7744886733"],
        sourceStoreId: "source-live",
        sourceStoreName: "自动刷新验证店"
    },
    products: [{ spuId: "7744886733", goodsId: "9001" }],
    records: [{
        identity: { productIds: ["7744886733"], goodsIds: ["9001"] },
        payload: {
            result: {
                pageItems: [{
                    productId: 7744886733,
                    goodsId: 9001,
                    productName: "live refresh verify",
                    productSkuSummaries: [{ productSkuId: 79322547323 }]
                }]
            }
        }
    }]
};

const httpRoot = await mkdtemp(path.join(os.tmpdir(), "ziniao-live-"));
let child = null;
try {
    let origin = "";
    let started = false;
    for (let attempt = 0; attempt < 3 && !started; attempt += 1) {
        const port = String(await pickFreePort());
        origin = `http://127.0.0.1:${port}`;
        child = spawn(process.execPath, ["server.mjs"], {
            cwd: rootDir,
            env: {
                ...process.env,
                ZINIAO_BIND: "127.0.0.1",
                ZINIAO_PORT: port,
                ZINIAO_INGEST_TOKEN: TOKEN,
                ZINIAO_DATA_ROOT: httpRoot,
                ZINIAO_SKIP_SEED: "1",
                ZINIAO_INSTANCE_ID: INSTANCE_ID,
                ZINIAO_WATCH_DIR: path.join(httpRoot, "inbox")
            },
            stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", () => {});
        child.stderr.on("data", () => {});
        try {
            await waitForServer(child, origin);
            started = true;
        } catch (error) {
            const message = String(error && error.message || error);
            await stopChild(child);
            child = null;
            if (!/port occupied by other service|server exited|EADDRINUSE/.test(message) || attempt === 2) throw error;
        }
    }

    const before = await fetchJson(`${origin}/api/live`);
    assert.equal(before.status, 200, `/api/live 应可读取，实际 ${before.status}`);
    for (const field of ["inbox", "inventory", "agents", "jobs", "logs"]) {
        assert.equal(typeof before.body[field], "string", `/api/live 缺少 ${field} 字段`);
    }
    const beforeAgain = await fetchJson(`${origin}/api/live`);
    assert.deepEqual(beforeAgain.body, before.body, "没有变化时 /api/live 必须返回同一份信号");

    // 线上是插件直接推送采集包，商品库信号必须能识别这次推送带来的新商品。
    const ingested = await fetchJson(`${origin}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ packet, fileName: "live-refresh-verify.json" })
    });
    assert.equal(ingested.status, 200, `插件直推应成功，实际 ${ingested.status}：${JSON.stringify(ingested.body)}`);

    const after = await fetchJson(`${origin}/api/live`);
    assert.notEqual(after.body.inventory, before.body.inventory, "新商品入库必须改变商品库信号");
    assert.deepEqual((await fetchJson(`${origin}/api/live`)).body, after.body, "入库完成后信号必须重新稳定");
    console.log("live http checks passed（/api/live 字段、稳定性和插件直推入库变化）");
} finally {
    if (child) await stopChild(child);
    await rm(httpRoot, { recursive: true, force: true });
}
