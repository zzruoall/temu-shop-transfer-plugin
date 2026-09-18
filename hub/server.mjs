/**
 * 店铺中转仓本地服务。商品入库仍只服务本机页面和 JSON 文件；
 * 紫鸟内插件通常访问不到本机中转仓，所以本机工人先读取已打开目标店并核验插件身份。
 * 商品快照只定向交给在线目标插件；接口创建须用户明确确认合规，由本机连接器单次提交并回查。
 */
import http from "node:http";
import {cloudAuthenticate,deviceToken,issuePluginToken,disablePluginInstance} from "./cloud-auth.mjs";
import { createReadStream } from "node:fs";
import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createStore } from "./lib/store.mjs";
import { createInboxWatcher } from "./lib/inbox-watcher.mjs";
import { createDownloadDirectoryDiscovery } from "./lib/ziniao-downloads.mjs";
import { createTransferManager } from "./lib/transfer-manager.mjs";
import { createJobQueue } from "./lib/job-queue.mjs";
import { isLocalMachineRequest, isValidIngestToken, loadIngestAuth, readBearerToken } from "./lib/ingest-auth.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");
const fixturesDir = path.join(rootDir, "fixtures");
// 集成测试可把数据目录指到临时路径，避免写入正式仓库。
const dataRoot = path.resolve(process.env.ZINIAO_DATA_ROOT || rootDir);
const store = createStore(dataRoot);
const auth = await loadIngestAuth(dataRoot);
const cloudAuthEnabled = Boolean(String(process.env.TEMU_CREDENTIALS || "").trim());
const HOST = auth.bindHost;
const PORT = auth.port;
// 完整商品包会同时携带多条已脱敏响应，允许大于结构样本的上传。默认只绑本机；紫鸟直推时再绑局域网，仍不要把该上限开放给公网。
const MAX_BODY = 256 * 1024 * 1024;
// 仅集成测试使用：调用方用这个一次性身份确认连到的是刚拉起的进程，而不是占用同端口的其他入库台。
const instanceId = String(process.env.ZINIAO_INSTANCE_ID || "").trim();
// 默认目录之外，服务通过只读 CLI 自动接入紫鸟店铺的实际下载子目录；显式配置目录时不额外发现。
const defaultWatchDirectories = [
    path.join(os.homedir(), "Downloads", "temu-local-dataset"),
    path.join(dataRoot, "data", "inbox")
];
const watchDirectories = String(process.env.ZINIAO_WATCH_DIR || defaultWatchDirectories.join(";"))
    .split(/[;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon"
};

function send(res, status, body, headers = {}) {
    const payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
        "content-type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
        "cache-control": "no-store",
        ...headers
    });
    res.end(payload);
}

function notFound(res) {
    send(res, 404, { error: "not_found" });
}

async function readBody(req, maxBytes = MAX_BODY) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) {
            const error = new Error("payload_too_large");
            error.status = 413;
            throw error;
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

function stripBom(text) {
    return String(text || "").replace(/^\uFEFF/, "");
}

function parseMultipart(buffer, contentType) {
    const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!match) return [];
    const boundary = `--${match[1] || match[2]}`;
    const text = buffer.toString("latin1");
    const parts = text.split(boundary).slice(1);
    const files = [];
    for (const part of parts) {
        if (part.startsWith("--")) break;
        const splitAt = part.indexOf("\r\n\r\n");
        if (splitAt < 0) continue;
        const header = part.slice(0, splitAt);
        const body = part.slice(splitAt + 4).replace(/\r\n$/, "");
        const name = (header.match(/filename="([^"]+)"/i) || [])[1];
        if (!name) continue;
        files.push({
            originalName: name,
            text: Buffer.from(body, "latin1").toString("utf8")
        });
    }
    return files;
}

async function seedIfEmpty() {
    const overview = await store.listOverview();
    if (overview.batchCount > 0) return;
    let names = [];
    try {
        names = await readdir(fixturesDir);
    } catch {
        return;
    }
    const uploads = [];
    for (const name of names.filter((item) => item.endsWith(".json"))) {
        const text = await readFile(path.join(fixturesDir, name), "utf8");
        uploads.push({ originalName: name, payload: JSON.parse(stripBom(text)) });
    }
    if (uploads.length) {
        await store.importFiles(uploads, { label: "City Beauty King 实测页", shopName: "City Beauty King", seed: true });
    }
}

function writeIngestCors(req, res) {
    const origin = String(req.headers.origin || "").trim();
    // 直推口给插件后台使用，不依赖浏览器 CORS；预检只为扩展页或本机调试保留。
    res.setHeader("access-control-allow-origin", origin || "*");
    res.setHeader("access-control-allow-headers", "authorization,content-type,x-ingest-label,x-ingest-filename");
    res.setHeader("access-control-allow-methods", "POST,OPTIONS");
    res.setHeader("access-control-max-age", "600");
}

/**
 * 仓库页面默认只给运行入库台的本机使用；绑定 0.0.0.0 后，其他局域网设备读取批次或原始文件必须提供直推令牌。
 * 紫鸟扩展只访问 /api/ingest，原有 Bearer 鉴权不受本机页面免登录规则影响。
 */
function canAccessWarehouseApi(req) {
    return req.temuAuthenticated === true;
}

/** 同源网页导入才允许省略 Bearer，阻止恶意网站借本机浏览器用 multipart form 污染仓库。 */
function isTrustedImportOrigin(req) {
    const rawOrigin = String(req.headers.origin || "").trim();
    if (!rawOrigin) return true;
    try {
        const origin = new URL(rawOrigin);
        const known = new Set(auth.origins);
        known.add("https://www.ruofei.com.cn");
        known.add(`http://localhost:${PORT}`);
        return known.has(origin.origin);
    } catch {
        return false;
    }
}

function stampFileName(prefix) {
    return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

const inboxWatcher = createInboxWatcher({
    directories: watchDirectories,
    checkpointPath: path.join(dataRoot, "data", "inbox-checkpoint.json"),
    discoverDirectories: process.env.ZINIAO_WATCH_DIR ? null : createDownloadDirectoryDiscovery(),
    importFiles: (uploads, options) => store.importFiles(uploads, options)
});
const transferManager = createTransferManager(dataRoot, store);
const jobQueue = createJobQueue(dataRoot, store);


/**
 * 插件直推和网页上传共用同一套识别规则：body 可以是完整商品包本身，
 * 也可以包一层 packet/label，避免两边各写一套字段。
 */
function extractIngestUpload(body, req) {
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        const error = new Error("需要 JSON 对象");
        error.status = 400;
        throw error;
    }
    const packet = body.kind ? body : (body.packet && typeof body.packet === "object" ? body.packet : null);
    if (!packet || typeof packet !== "object" || Array.isArray(packet)) {
        const error = new Error("需要完整商品包或其他已支持的采集 JSON");
        error.status = 400;
        throw error;
    }
    const headerName = String(req.headers["x-ingest-filename"] || "").trim();
    const originalName = headerName
        || String(body.fileName || body.originalName || "").trim()
        || stampFileName(packet.kind === "full-capture-packet" ? "temu-full-capture" : "temu-ingest");
    const label = String(req.headers["x-ingest-label"] || body.label || (packet.source && packet.source.shopName) || "").trim();
    const shopName = String(body.shopName || (packet.source && packet.source.shopName) || "").trim();
    const sourceStoreId = String(body.sourceStoreId || (packet.source && packet.source.sourceStoreId) || "").trim();
    const sourceStoreName = String(body.sourceStoreName || (packet.source && packet.source.sourceStoreName) || shopName).trim();
    const pluginInstanceId = String(body.pluginInstanceId || (packet.source && packet.source.pluginInstanceId) || "").trim();
    const pageStoreName = String(body.pageStoreName || (packet.source && packet.source.pageStoreName) || shopName).trim();
    return { originalName, payload: packet, label, shopName, sourceStoreId, sourceStoreName, pluginInstanceId, pageStoreName };
}

async function serveStatic(req, res, url) {
    const root = path.resolve(publicDir);
    const requested = url.pathname === "/" ? path.join(root, "index.html") : path.join(root, decodeURIComponent(url.pathname));
    const filePath = path.resolve(requested);
    if (filePath !== root && !filePath.toLowerCase().startsWith((root + path.sep).toLowerCase())) {
        notFound(res);
        return;
    }
    try {
        let target = filePath;
        const info = await stat(target);
        if (info.isDirectory()) target = path.join(target, "index.html");
        const ext = path.extname(target);
        res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
        createReadStream(target).pipe(res);
    } catch {
        notFound(res);
    }
}

const server = http.createServer(async (req, res) => {
    try {
        // 预检不读写资料，仅为指定机器接口声明跨域许可；真正请求仍必须通过独立认证。
        if(req.method==="OPTIONS" && /^\/api\/(ingest|agents\/register|jobs\/(claim|report|target-task-states))$/.test(String(req.url).split('?')[0])) {
            writeIngestCors(req,res);res.writeHead(204);res.end();return;
        }
        if (cloudAuthEnabled) {
            if (!await cloudAuthenticate(req,res)) return;
            req.temuAuthenticated = true;
            // 通过云端认证后统一交给原有设备接口；不把原始浏览器口令传给业务模块。
            req.headers.authorization = `Bearer ${deviceToken}`;
        } else {
            // 本地服务不依赖云端账号文件：回环页面免登录，非回环请求必须携带本机入库令牌。
            // /api/ingest 仍会再次校验令牌，避免错误令牌借本机连接绕过直推鉴权。
            const localAuthorized = isLocalMachineRequest(req)
                || isValidIngestToken(readBearerToken(req), auth.token);
            if (!localAuthorized) return send(res, 401, { error: "local_auth_required" });
            req.temuAuthenticated = true;
        }
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        if (req.method === "POST" && url.pathname === "/api/plugin/register") {
            const body=JSON.parse((await readBody(req,16*1024)).toString("utf8"));
            const token=issuePluginToken(body.pluginInstanceId);
            if(!token)return send(res,400,{error:"invalid_plugin_instance"});
            return send(res,200,{ok:true,token,expiresIn:86400,scope:"plugin-transfer",pluginInstanceId:String(body.pluginInstanceId)});
        }
        if (req.method === "POST" && url.pathname === "/api/admin/plugins/disable") {
            if (req.temuDeviceBearer !== true) return send(res,403,{error:"admin_required"});
            const body=JSON.parse((await readBody(req,16*1024)).toString("utf8"));
            return send(res,200,{ok:true,disabled: disablePluginInstance(body.pluginInstanceId)});
        }
        if (req.method === "OPTIONS" && url.pathname === "/api/ingest") {
            writeIngestCors(req, res);
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "OPTIONS" && (url.pathname === "/api/agents/register" || url.pathname === "/api/jobs/claim" || url.pathname === "/api/jobs/report" || url.pathname === "/api/jobs/target-task-states")) {
            writeIngestCors(req, res);
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/ingest-info") {
            send(res, 200, {
                service: "shop-hub",
                ...(instanceId ? { instanceId } : {}),
                bindHost: HOST,
                port: PORT,
                origins: ["https://www.ruofei.com.cn/temu"],
                endpoints: ["https://www.ruofei.com.cn/temu/api/ingest"],
                tokenSource: auth.tokenSource,
                token: null,
                // 设置页的“测试连接”必须同时验证令牌，不能只证明端口上恰好有一个 HTTP 服务。
                authorized: isValidIngestToken(readBearerToken(req), auth.token),
                // 插件测试连接必须拿标准直推路径去核对用户填写的 endpoint，不能只证明 /api/ingest-info 能通。
                ingestPath: "/api/ingest"
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/overview") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 200, await store.listOverview());
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/inbox/status") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 200, inboxWatcher.snapshot());
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/inbox/scan") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 200, await inboxWatcher.scan());
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/ziniao/stores") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const agents=(await jobQueue.listJobs()).agents;
            if (url.searchParams.get("scope") === "all") {
                let directory = { stores: [], updatedAt: null };
                let directoryError = "";
                try {
                    // 全量目录用于任务台和日志索引；60 秒缓存兼顾百家店铺规模与状态新鲜度。
                    directory = await transferManager.refreshStores({ maxAgeMs: 60000 });
                } catch (error) {
                    directoryError = String(error && error.message || error).slice(0, 300);
                }
                const agentByStore = new Map(agents.filter((agent) => agent.storeId).map((agent) => [String(agent.storeId), agent]));
                const stores = directory.stores.map((item) => {
                    const agent = agentByStore.get(String(item.storeId));
                    return {
                        storeId: String(item.storeId),
                        name: String(agent?.storeName || agent?.pageStoreName || item.name || item.storeId),
                        platform: item.platform || "",
                        online: Boolean(agent?.online),
                        lastSeenAt: agent?.lastSeenAt || ""
                    };
                });
                const knownIds = new Set(stores.map((item) => String(item.storeId)));
                for (const agent of agents) {
                    const storeId = String(agent.storeId || "");
                    if (!storeId || knownIds.has(storeId)) continue;
                    stores.push({
                        storeId,
                        name: String(agent.storeName || agent.pageStoreName || storeId),
                        platform: "",
                        online: Boolean(agent.online),
                        lastSeenAt: agent.lastSeenAt || ""
                    });
                }
                send(res, 200, { stores, updatedAt: directory.updatedAt, error: directoryError });
                return;
            }
            // 店铺选择只展示近期心跳且身份已核验的实例，避免离线旧窗口或测试 Agent 污染来源店列表。
            send(res, 200, {stores:agents.filter(a=>a.storeId&&a.online&&a.identityMatched).map(a=>({storeId:a.storeId,name:a.storeName||a.pageStoreName}))});
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/transfer-jobs") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 200, { jobs: [], disabled: true, note: "旧探测链路已停用，请使用任务台 /api/jobs。" });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/jobs") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 200, await jobQueue.listJobs());
            return;
        }
        // 自动刷新信号：网页只比较这份紧凑签名决定是否重绘，不用为了刷新反复拉取完整商品库和任务列表。
        if (req.method === "GET" && url.pathname === "/api/live") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const inbox = inboxWatcher.snapshot();
            const live = await jobQueue.liveSignature();
            send(res, 200, {
                // 入库计数覆盖新包、重复包和失败，任何一项变化都代表查验台内容需要重读。
                inbox: [inbox.imported, inbox.reused, inbox.failed, inbox.skipped, inbox.lastImportAt || "", inbox.running ? 1 : 0].join(":"),
                inventory: await store.indexSignature(),
                agents: live.agents,
                jobs: live.jobs,
                logs: live.logs
            });
            return;
        }
        // 工作日志只回放任务状态变更，不返回商品快照，供运营确认是否真正送达目标插件。
        if (req.method === "GET" && url.pathname === "/api/work-log") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 200, await jobQueue.listActivity());
            return;
        }
        if (req.method === "DELETE" && url.pathname === "/api/work-log") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "删除工作日志请求不是合法 JSON" }); }
            send(res, 200, { ok: true, ...(await jobQueue.clearStoreActivity((body || {}).storeId)) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/jobs/open-requests") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 200, await jobQueue.listOpenRequests());
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/open-result") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "打开回传不是合法 JSON" }); }
            send(res, 200, { ok: true, job: await jobQueue.reportOpenResult(body || {}) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/direct-create-capability") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            return send(res, 200, {directCreate:true, minimumPluginVersion:"10.9.0", complianceVersion:"V2.0"});
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/direct-progress") {
            // 只供已认证本机连接器回传；不开放跨域发布代理或任意 Temu URL。
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const body = JSON.parse(stripBom((await readBody(req, 64 * 1024)).toString("utf8")));
            return send(res, 200, {ok:true, ...await jobQueue.directProgress(body)});
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/direct-retry") {
            // 仅网页人工确认入口可重置结果未知项；插件不能自行把 unknown 解锁成新尝试。
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const body = JSON.parse(stripBom((await readBody(req, 64 * 1024)).toString("utf8")));
            return send(res, 200, { ok: true, ...await jobQueue.directRetry(body || {}) });
        }
        if (req.method === "POST" && url.pathname === "/api/jobs") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const buffer = await readBody(req, 512 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "创建任务请求不是合法 JSON" }); }
            const job = await jobQueue.createJob(body || {});
            send(res, 201, { ok: true, job });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/agents/register") {
            writeIngestCors(req, res);
            // 本机工人从 127.0.0.1 代领；紫鸟内插件仍必须带直推令牌。
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "注册请求不是合法 JSON" }); }
            send(res, 200, { ok: true, agent: await jobQueue.registerAgent(body || {}) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/claim") {
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "领取请求不是合法 JSON" }); }
            send(res, 200, { ok: true, ...(await jobQueue.claimJobs(body || {})) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/report") {
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "回传请求不是合法 JSON" }); }
            send(res, 200, { ok: true, job: await jobQueue.reportProgress(body || {}) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/target-task-states") {
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "任务状态查询不是合法 JSON" }); }
            send(res, 200, { ok: true, ...(await jobQueue.listTargetTaskStates(body || {})) });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/jobs\/[^/]+\/cancel$/)) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const id = url.pathname.split("/")[3];
            send(res, 200, { ok: true, job: await jobQueue.cancelJob(id) });
            return;
        }
        if (req.method === "GET" && url.pathname.match(/^\/api\/jobs\/[^/]+$/)) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const job = await jobQueue.getJob(url.pathname.split("/").pop());
            if (!job) return notFound(res);
            send(res, 200, job);
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/transfer-jobs") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 409, { error: "旧探测链路已停用，请使用任务台创建指定店铺任务。" });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/cancel$/)) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 409, { error: "旧探测链路已停用" });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/confirm$/)) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 409, { error: "旧探测链路已停用" });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/retry$/)) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            send(res, 409, { error: "旧探测链路已停用" });
            return;
        }
        if (req.method === "GET" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/artifacts\/[^/]+$/)) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const parts = url.pathname.split("/");
            const filePath = transferManager.artifactPath(parts[3], parts[5]);
            if (!filePath) return notFound(res);
            try {
                const info = await stat(filePath);
                if (!info.isFile()) return notFound(res);
                res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
                createReadStream(filePath).pipe(res);
            } catch {
                notFound(res);
            }
            return;
        }
        if (req.method === "GET" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+$/)) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const job = await transferManager.getJob(url.pathname.split("/").pop());
            if (!job) return notFound(res);
            send(res, 200, job);
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/batches/")) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const batch = await store.getBatch(url.pathname.split("/").pop());
            if (!batch) return notFound(res);
            send(res, 200, batch);
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/products/")) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const product = await store.getProduct(decodeURIComponent(url.pathname.split("/").pop()));
            if (!product) return notFound(res);
            send(res, 200, product);
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            const file = await store.readStoredFile(decodeURIComponent(url.pathname.split("/").pop()));
            send(res, 200, file.json, {
                "content-disposition": `attachment; filename="${file.name}"`
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/import") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: "import_origin_denied" });
            const buffer = await readBody(req);
            const uploaded = parseMultipart(buffer, req.headers["content-type"]);
            if (!uploaded.length) {
                send(res, 400, { error: "需要至少一个 JSON 文件" });
                return;
            }
            const files = [];
            for (const item of uploaded) {
                try {
                    files.push({ originalName: item.originalName, payload: JSON.parse(stripBom(item.text)) });
                } catch {
                    send(res, 400, { error: `${item.originalName} 不是合法 JSON` });
                    return;
                }
            }
            const result = await store.importFiles(files, { source: "upload" });
            send(res, 200, result);
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/products/unblock") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: "unblock_origin_denied" });
            // 解除标红只接受明确的 SPU 数组：平台抖动造成的假失败不需要重新采集来源商品。
            const buffer = await readBody(req, 256 * 1024);
            let body;
            try {
                body = JSON.parse(stripBom(buffer.toString("utf8")));
            } catch {
                return send(res, 400, { error: "解除标红请求不是合法 JSON" });
            }
            const result = await store.unblockProducts(body && body.spuIds);
            send(res, 200, { ok: true, ...result });
            return;
        }
        if (req.method === "DELETE" && url.pathname === "/api/products") {
            if (!canAccessWarehouseApi(req)) return send(res, 401, { error: "warehouse_unauthorized" });
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: "delete_origin_denied" });
            // 删除请求只有 SPU 数组，单独限制为 256 KiB，不能占用完整采集包的 256 MiB 内存额度。
            const buffer = await readBody(req, 256 * 1024);
            let body;
            try {
                body = JSON.parse(stripBom(buffer.toString("utf8")));
            } catch {
                return send(res, 400, { error: "删除请求不是合法 JSON" });
            }
            // 删除接口只接受明确的 SPU 数组，避免一个模糊条件误删整仓商品。
            const result = await store.deleteProducts(body && body.spuIds);
            send(res, 200, { ok: true, ...result });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/ingest") {
            writeIngestCors(req, res);
            if (!isValidIngestToken(readBearerToken(req), auth.token)) {
                send(res, 401, { error: "ingest_unauthorized" });
                return;
            }
            const buffer = await readBody(req);
            let body;
            try {
                body = JSON.parse(stripBom(buffer.toString("utf8")));
            } catch {
                send(res, 400, { error: "不是合法 JSON" });
                return;
            }
            const upload = extractIngestUpload(body, req);
            const mapped = await jobQueue.resolveIngestSource({
                pluginInstanceId: upload.pluginInstanceId,
                pageStoreName: upload.pageStoreName,
                storeName: upload.sourceStoreName || upload.shopName,
                storeId: upload.sourceStoreId
            });
            const result = await store.importFiles([
                { originalName: upload.originalName, payload: upload.payload }
            ], {
                label: upload.label,
                shopName: upload.shopName || (mapped && mapped.sourceStoreName) || "",
                sourceStoreId: upload.sourceStoreId || (mapped && mapped.sourceStoreId) || "",
                sourceStoreName: upload.sourceStoreName || (mapped && mapped.sourceStoreName) || upload.shopName,
                pluginInstanceId: upload.pluginInstanceId || (mapped && mapped.pluginInstanceId) || "",
                pageStoreName: upload.pageStoreName,
                source: "extension-ingest"
            });
            send(res, 200, {
                ok: true,
                reused: result.reused,
                batchId: result.batch && result.batch.id,
                batch: {
                    id: result.batch && result.batch.id,
                    status: result.batch && result.batch.status,
                    readiness: result.batch && result.batch.readiness,
                    counts: result.batch && result.batch.counts,
                    productCount: result.batch && result.batch.products ? result.batch.products.length : 0
                },
                warnings: result.warnings || []
            });
            return;
        }
        await serveStatic(req, res, url);
    } catch (error) {
        send(res, error.status || 500, { error: error.message || "server_error" });
    }
});

await store.ensure();
// 测试启动不要灌入 fixtures，否则会把示例商品写进临时仓库，干扰直推断言。
// 正式仓库禁止默认导入 fixtures，避免测试商品混进真实库存。只有明确设置 ZINIAO_SEED=1 才灌入。
const enableSeed = /^(1|true|yes)$/i.test(String(process.env.ZINIAO_SEED || ""));
if (enableSeed) await seedIfEmpty();
// 云端不扫描服务器其他项目的目录，也不尝试在服务器调用本机紫鸟CLI。
server.listen(PORT, HOST, () => {
    console.log(`中转仓 ${auth.origins[0] || `http://${HOST}:${PORT}`}`);
    for (const origin of auth.origins) console.log(`直推地址 ${origin}/api/ingest`);
    console.log("云端认证已启用，凭证不会写入运行日志");
    if (HOST === "127.0.0.1") console.log("紫鸟若访问不到本机，请用 ZINIAO_BIND=0.0.0.0 启动并填写局域网地址。");
});
