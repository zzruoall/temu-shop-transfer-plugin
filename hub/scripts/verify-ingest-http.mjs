/**
 * 启动临时入库台，核对直推 HTTP：令牌错误要 401，正确包要返回批次号。
 * 数据写到临时目录，不碰正式 data/。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKEN = "http-ingest-verify-token";
const INSTANCE_ID = randomBytes(8).toString("hex");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

/** 先占一个本机空闲端口再交给子进程，避免写死 17401 撞上其他入库台。 */
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

/** 等子进程退出；超时后返回 false，由调用方再强杀，避免 Windows 上残留占用端口。 */
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
    const response = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(8000)
    });
    const text = await response.text();
    let body = null;
    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        throw new Error(`${url} 返回了非 JSON：HTTP ${response.status}`);
    }
    return { status: response.status, ok: response.ok, body };
}

/**
 * 必须对上本次 instanceId，才能证明连到的是刚 spawn 的进程。
 * 只看 HTTP 200 会把占用同端口的旧入库台误当成测试对象。
 */
async function waitForServer(child, origin, timeoutMs = 12000) {
    const started = Date.now();
    let lastError = "";
    while (Date.now() - started < timeoutMs) {
        if (child.exitCode != null) throw new Error(`server exited ${child.exitCode}: ${lastError}`);
        try {
            const response = await fetch(`${origin}/api/ingest-info`, { signal: AbortSignal.timeout(1500) });
            const text = await response.text();
            let body = null;
            try {
                body = text ? JSON.parse(text) : null;
            } catch {
                body = null;
            }
            if (body && body.service === "shop-hub" && body.instanceId === INSTANCE_ID) {
                return body;
            }
            throw new Error(`port occupied by other service: status=${response.status} instanceId=${body && body.instanceId || "missing"}`);
        } catch (error) {
            lastError = String(error && error.message || error);
            if (/port occupied by other service/.test(lastError)) throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`server did not start: ${lastError}`);
}

const packet = {
    schemaVersion: 4,
    kind: "full-capture-packet",
    exportMode: "full-capture",
    source: {
        pageUrl: "https://agentseller.temu.com/goods/list",
        allowedSpuIds: ["7744886733"],
        sourceStoreId: "source-http",
        sourceStoreName: "HTTP 验证店"
    },
    products: [{ spuId: "7744886733", goodsId: "9001" }],
    records: [{
        identity: { productIds: ["7744886733"], goodsIds: ["9001"] },
        payload: {
            result: {
                pageItems: [{
                    productId: 7744886733,
                    goodsId: 9001,
                    productName: "HTTP verify",
                    productSkuSummaries: [{ productSkuId: 79322547323 }]
                }]
            }
        }
    }]
};

const tempRoot = await mkdtemp(path.join(tmpdir(), "ziniao-http-"));
let child = null;
let output = "";
try {
    // 关闭探测端口到真正 listen 之间可能被别的进程抢走，最多换 3 次端口。
    let info = null;
    let origin = "";
    for (let attempt = 0; attempt < 3 && !info; attempt += 1) {
        const PORT = String(await pickFreePort());
        origin = `http://127.0.0.1:${PORT}`;
        output = "";
        child = spawn(process.execPath, ["server.mjs"], {
            cwd: rootDir,
            env: {
                ...process.env,
                ZINIAO_BIND: "127.0.0.1",
                ZINIAO_PORT: PORT,
                ZINIAO_INGEST_TOKEN: TOKEN,
                ZINIAO_DATA_ROOT: tempRoot,
                ZINIAO_SKIP_SEED: "1",
                ZINIAO_INSTANCE_ID: INSTANCE_ID
            },
            stdio: ["ignore", "pipe", "pipe"]
        });
        child.stdout.on("data", (chunk) => { output += chunk.toString(); });
        child.stderr.on("data", (chunk) => { output += chunk.toString(); });
        try {
            info = await waitForServer(child, origin);
        } catch (error) {
            const message = String(error && error.message || error);
            await stopChild(child);
            child = null;
            const retryable = /port occupied by other service|server exited|EADDRINUSE/.test(message);
            if (!retryable || attempt === 2) throw error;
        }
    }
    assert(info.ingestPath === "/api/ingest", "ingest-info 没有返回标准直推路径");
    assert(info.authorized === false, "无令牌时 ingest-info.authorized 应为 false");

    const unauthorized = await fetchJson(`${origin}/api/ingest`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer wrong-token" },
        body: JSON.stringify({ packet, fileName: "verify.json" })
    });
    assert(unauthorized.status === 401, `错误令牌应返回 401，实际 ${unauthorized.status}`);
    assert(unauthorized.body && unauthorized.body.error === "ingest_unauthorized", "错误令牌没有返回 ingest_unauthorized");

    const authorizedInfo = await fetchJson(`${origin}/api/ingest-info`, {
        headers: { authorization: `Bearer ${TOKEN}` }
    });
    assert(authorizedInfo.status === 200, `带令牌的 ingest-info 应返回 200，实际 ${authorizedInfo.status}`);
    assert(authorizedInfo.body && authorizedInfo.body.authorized === true, "正确令牌时 ingest-info.authorized 应为 true");

    const created = await fetchJson(`${origin}/api/ingest`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`,
            "x-ingest-filename": "temu-full-capture-http-verify.json"
        },
        body: JSON.stringify({ packet, fileName: "temu-full-capture-http-verify.json" })
    });
    assert(created.status === 200, `直推应返回 200，实际 ${created.status}`);
    assert(created.body && created.body.ok === true && created.body.batchId, "直推没有返回批次号");
    assert(created.body.reused === false, "首次直推被记成复用");

    const overview = await fetchJson(`${origin}/api/overview`);
    assert(overview.status === 200, `overview 应返回 200，实际 ${overview.status}`);
    assert(Array.isArray(overview.body && overview.body.products), "overview 没有返回 products 数组");
    assert(overview.body.products.some((item) => item.spuId === "7744886733"), "直推后库存里没有该 SPU");
    assert(overview.body.excludedCount === 0, "首次直推后不应出现已删除商品");

    const deleted = await fetchJson(`${origin}/api/products`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spuIds: ["7744886733"] })
    });
    assert(deleted.status === 200, `删除商品应返回 200，实际 ${deleted.status}`);
    assert(deleted.body && deleted.body.deletedCount === 1, `删除计数应为 1，实际 ${deleted.body && deleted.body.deletedCount}`);
    assert(Array.isArray(deleted.body.deletedIds) && deleted.body.deletedIds.includes("7744886733"), "删除结果没有返回该 SPU");
    assert(Array.isArray(deleted.body.missingIds) && deleted.body.missingIds.length === 0, "删除结果不应包含缺失 SPU");
    assert(deleted.body.productCount === 0, "删除后库存商品数应为 0");

    const afterDelete = await fetchJson(`${origin}/api/overview`);
    assert(afterDelete.status === 200, `删除后 overview 应返回 200，实际 ${afterDelete.status}`);
    assert(Array.isArray(afterDelete.body && afterDelete.body.products), "删除后 overview 没有返回 products 数组");
    assert(!afterDelete.body.products.some((item) => item.spuId === "7744886733"), "删除后库存里仍有该 SPU");
    assert(afterDelete.body.excludedCount === 0, "彻底删除后不应留下排除记录");

    const replay = await fetchJson(`${origin}/api/ingest`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${TOKEN}`
        },
        body: JSON.stringify({ packet })
    });
    assert(replay.status === 200, `插件重放应返回 200，实际 ${replay.status}`);
    assert(replay.body && replay.body.reused === false, "旧批次已清除，同 SPU 再次上传应创建新批次");
    const afterReplay = await fetchJson(`${origin}/api/overview`);
    assert(afterReplay.status === 200, `重放后 overview 应返回 200，实际 ${afterReplay.status}`);
    assert(Array.isArray(afterReplay.body && afterReplay.body.products), "重放后 overview 没有返回 products 数组");
    assert(afterReplay.body.products.some((item) => item.spuId === "7744886733"), "彻底删除后同 SPU 新上传仍被阻断");
    assert(afterReplay.body.excludedCount === 0, "同 SPU 新上传后不应产生排除记录");

    await writeFile(path.join(tempRoot, "ok.json"), JSON.stringify({
        batchId: created.body.batchId,
        ingestPath: info.ingestPath
    }), "utf8");
    console.log("ingest http checks passed", created.body.batchId);
} catch (error) {
    console.error(output.slice(-2000));
    throw error;
} finally {
    try {
        await stopChild(child);
    } catch (error) {
        console.error(String(error && error.message || error));
    }
    await rm(tempRoot, { recursive: true, force: true });
}
