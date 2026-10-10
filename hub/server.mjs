/**
 * 店铺中转仓 API：只收存来源商品并定向发送，MySQL 保存商品与身份目录。
 * 平台创建、暂停和错误分类由插件独立完成；服务端仅接收受限商品异常通知并过滤禁传，不保存上架运行状态。
 * 未配置 MySQL 的离线调试仍兼容文件存储，不在运行失败时自动切换数据源。
 */
import http from "node:http";
import { createHash, randomUUID as cryptoRandomId } from "node:crypto";
import { createLiveEvents } from "./lib/live-events.mjs";
import { createIngestAdmission } from "./lib/ingest-admission.mjs";
import { createSchedulingController, schedulingError } from './lib/scheduling.mjs';
import { createRuntimeResourceBudget, readCgroupSample, readDiskSample } from './lib/runtime-resource-budget.mjs';
import { relayResourceCapacity } from './lib/relay-resource-capacity.mjs';
import { createIngestProtocol } from './lib/ingest-protocol.mjs';
import { createAccountResolver } from './lib/account-resolver.mjs';
import { createCloudAuth } from "./cloud-auth.mjs";
import { createReadStream } from "node:fs";
import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from "node:url";
import { createStore } from "./lib/store.mjs";
import { parseImportedFiles, redactSensitive } from "./lib/parse-capture.mjs";
import { TRANSFER_HASH_ALGORITHM, transferHash, verifyTransferManifest } from "./lib/transfer-integrity.mjs";
import { openMysqlDatabase } from "./lib/mysql-database.mjs";
import { assertMysqlReady } from "./lib/mysql-schema.mjs";
import { createTransferManager } from "./lib/transfer-manager.mjs";
import { createJobQueue, canonicalProductSnapshot } from "./lib/job-queue.mjs";
import { qualificationReferences, readQualificationAsset, verifyQualificationBatchTransfer } from './lib/product-qualifications.mjs';
import { createOneShotRelay } from "./lib/one-shot-relay.mjs";
import { installWebsocketRelay } from "./lib/websocket-relay.mjs";
import { hasRelayPlugin, pluginVersionAtLeast } from './lib/plugin-version.mjs';
import { createProductNoticeTokens, parseProductErrorNotice } from './lib/product-notice-token.mjs';
import { transferManifest } from "./lib/transfer-integrity.mjs";
import { createStoreOwnership } from "./lib/store-ownership.mjs";
import { projectSourceStoreNames, sourceStoreDisplayName, sourceStoreDirectory } from './lib/source-store-display.mjs';
import { canDeleteCatalogProduct, projectCatalogPermissions } from './lib/catalog-permissions.mjs';
import { createDeletedStores } from "./lib/deleted-stores.mjs";
import { isLocalMachineRequest, isValidIngestToken, loadIngestAuth, readBearerToken, resolveBasePath, resolveRequestBasePath, stripRequestBasePath } from "./lib/ingest-auth.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(rootDir, "public");
const fixturesDir = path.join(rootDir, "fixtures");
// 集成测试可把数据目录指到临时路径，避免写入正式仓库。
const dataRoot = path.resolve(process.env.ZINIAO_DATA_ROOT || rootDir);
const database = await openMysqlDatabase();
if (database) await assertMysqlReady(database, dataRoot);
const store = createStore(dataRoot, { database });
const auth = await loadIngestAuth(dataRoot);
const noticeTokens = await createProductNoticeTokens(dataRoot);
const cloudAuthEnabled = Boolean(String(process.env.TEMU_CREDENTIALS || "").trim());
// 云端认证含用户表与插件令牌：插件令牌只放行插件侧接口，用户数据接口必须带用户会话。
const cloudAuth = createCloudAuth({ dataRoot, credentialPath: String(process.env.TEMU_CREDENTIALS || "").trim(), basePath: String(process.env.TEMU_BASE_PATH || "").trim() });
const deviceToken = cloudAuth.getDeviceToken();
const { issuePluginToken, disablePluginInstance } = cloudAuth;
const HOST = auth.bindHost;
const PORT = auth.port;
// 完整商品包会同时携带多条已脱敏响应，允许大于结构样本的上传。默认只绑本机；紫鸟直推时再绑局域网，仍不要把该上限开放给公网。
const MAX_BODY = 256 * 1024 * 1024;
// 入库最多接收两份在途请求，总正文预算 64 MiB；数据库模式按来源店加锁，文件模式仍串行写索引。
const MAX_INGEST_BODY = 64 * 1024 * 1024;
// 上传与发送共用有界账户公平准入；只限制当前网络工作，不持有插件执行名额。
const transportMax = Number(process.env.ZINIAO_ELASTIC_BUSINESS_MAX || 2);
if (!Number.isInteger(transportMax) || transportMax < 1 || transportMax > 64) throw Error('transport_capacity_invalid');
const ingestAdmission = createIngestAdmission({ limit: transportMax,
    capacity: () => relayResourceCapacity({ budget: latestBudget, sampledAt: budgetSampledAt,
        sample: rawResourceSample, active: ingestAdmission.snapshotActive(), max: transportMax, database: Boolean(database) }) });

/** 排队请求断开立即撤销；许可覆盖读取、解析和持久化，不能读完整包后才限流。 */
async function acquireIngest(req, res) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    const cleanup = () => { req.off("aborted", cancel); res.off("close", cancel); };
    try {
        const length = req.headers["content-length"] === undefined ? MAX_INGEST_BODY : Number(req.headers["content-length"]);
        let owner = req.temuUser?.id || req.temuPluginInstanceId || 'local';
        // 旧式插件直传也按已登记店铺的认领账号分享额度，不能多开实例抢占账户份额。
        if (!req.temuUser && req.temuPluginInstanceId) {
            const agents = (await jobQueue.listAgents()).agents.filter(agent => agent.pluginInstanceId === req.temuPluginInstanceId && agent.identityMatched);
            const accounts = new Set(await Promise.all(agents.map(agent => accountResolver.resolve(agent.storeId))));
            if (accounts.size === 1 && [...accounts][0]) owner = [...accounts][0];
        }
        const release = await ingestAdmission.acquire(length, abort.signal, owner);
        return () => { cleanup(); release(); };
    } catch (error) { cleanup(); throw error; }
}
// 仅集成测试使用：调用方用这个一次性身份确认连到的是刚拉起的进程，而不是占用同端口的其他入库台。
const instanceId = String(process.env.ZINIAO_INSTANCE_ID || "").trim();
const MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    // 字体缺失会让浏览器按默认字体渲染；给错 MIME 则会被拒绝加载，所以必须列全。
    ".ttf": "font/ttf",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
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
    res.setHeader("access-control-allow-headers", "authorization,content-type,x-ingest-label,x-ingest-filename,x-ingest-permit,x-plugin-instance");
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

/**
 * 插件令牌（pt_*）只代表"某个扩展实例"，不代表某个用户。
 * 它只能走插件侧接口；用户数据接口必须由用户会话或设备令牌访问。
 * 这里在路由层再兜一道：即便某条路由忘了判断身份，插件令牌也无法读写用户数据。
 */
function isPluginScopedRequest(req) {
    return req.temuPluginToken === true;
}

/** 插件注册、上传和接收共用令牌绑定，阻止一个实例冒充另一个实例。 */
function requirePluginInstance(req, res, body) {
    if (!isPluginScopedRequest(req)) return true;
    if (req.temuPluginInstanceId && String(body?.pluginInstanceId || "").trim() === req.temuPluginInstanceId) return true;
    send(res, 403, { error: "plugin_instance_mismatch", message: "插件令牌与请求实例不匹配，请重新连接插件" });
    return false;
}

/** 需要用户身份的接口统一用它拦；插件令牌访问返回 403，而不是静默放行。 */
function requireUserAccess(req, res) {
    if (isPluginScopedRequest(req)) {
        send(res, 403, { error: "plugin_scope_denied", message: "插件令牌不能访问用户数据接口" });
        return false;
    }
    if (!canAccessWarehouseApi(req)) {
        send(res, 401, { error: "warehouse_unauthorized" });
        return false;
    }
    return true;
}

/** 管理员专属操作（用户管理、店铺改派、插件吊销）。 */
function requireAdminAccess(req, res) {
    if (isPluginScopedRequest(req)) {
        send(res, 403, { error: "plugin_scope_denied" });
        return false;
    }
    if (!canAccessWarehouseApi(req)) {
        send(res, 401, { error: "warehouse_unauthorized" });
        return false;
    }
    // 本机模式没有账号体系，沿用原有的设备令牌即管理员语义。
    if (req.temuLocalMode === true || req.temuDeviceBearer === true || req.temuIsAdmin === true) return true;
    send(res, 403, { error: "admin_required", message: "该操作仅限管理员" });
    return false;
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

const transferManager = createTransferManager(dataRoot, store);
// 店铺归属表继续用于商品、批次和目录权限，不因删除上架状态而改变认领关系。
const ownership = createStoreOwnership(dataRoot, { database });
// 启动前完成一次性账户分类迁移；监听请求前冻结店铺数据分类，避免分类一半时被读取。
await ownership.initializeAccountTypes(cloudAuth.users, async () => {
    if (store.inventoryVersions) return [...(await store.inventoryVersions()).stores.keys()];
    return [...new Set((await store.listOverview()).batches.map(batch => batch.sourceStoreId).filter(Boolean))];
});
// 店铺删除名单：被管理员删除的店铺不再被插件心跳重新登记，避免"删了又回来"。
const deletedStores = createDeletedStores(dataRoot, { database });
// 身份目录沿用原有心跳、删除名单和恢复归属规则。
// 降载分母必须用**本服务限额**（cgroup memory.max），不能用整机内存——
// 整机内存会让"本服务已接近自己的上限"被算成很小的比例，等于永不降载（方案 D4）。
// 这里缓存最近一次采样：采样是异步的，而 scheduling 的压力回调是同步的。
let serviceMemoryRatio = null, latestBudget = null, budgetSampledAt = 0;
let rawResourceSample = {}, samplingBudget = null;
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const resourceBudget = createRuntimeResourceBudget({ probe: async () => {
    let sample = await readCgroupSample({ dataPath: dataRoot });
    const declared = Number(process.env.ZINIAO_SERVICE_MEMORY_BYTES || 0);
    // 本地只接受显式限额并标明来源，不能以本地进程采样冒充生产cgroup容量证明。
    if (!sample.ok && process.platform !== 'linux' && declared > 0) sample = {
        ok: true, source: 'explicit-local-process', memoryMaxBytes: declared,
        memoryCurrentBytes: process.memoryUsage().rss, ...await readDiskSample({ path: dataRoot })
    };
    const result = { ...sample, measuredAt: Date.now(), dbWaitMs: database?.pressure().dbWaitMs || 0, loopLagMs: loopDelay.percentile(95) / 1e6 };
    rawResourceSample = result;
    loopDelay.reset();
    return result;
} });
const refreshResourceBudget = async () => {
    // 慢采样共享同一Promise，防止旧样本晚到后覆盖较新的降载判断。
    if (samplingBudget) return samplingBudget;
    samplingBudget = (async () => {
    const result = await resourceBudget.sample();
    latestBudget = result; budgetSampledAt = Date.now();
    serviceMemoryRatio = Number.isFinite(result.memoryRatio) ? result.memoryRatio : null;
    ingestAdmission.refreshCapacity();
    if (!result.canStartNewWork && result.reasonCode) {
        // 只记录原因，不改写任何已提交任务：预算只做准入。
        console.warn(`[resource-budget] ${result.mode} ${result.reasonCode} limit=${result.processLimit}`);
    }
    return result;
    })();
    try { return await samplingBudget; }
    catch (error) { throw error; }
    finally { samplingBudget = null; }
};
refreshResourceBudget().catch(() => {});
const budgetTimer = setInterval(() => { refreshResourceBudget().catch(() => {}); }, 5000);
budgetTimer.unref();
const scheduler = createSchedulingController({
    pressure: () => database?.pressure() || {},
    // 采样不可用时返回 null：由预算侧按 budget_unknown 拒绝启用新模式，
    // 而不是在这里退回整机内存假装健康。
    memoryRatioProvider: () => serviceMemoryRatio
});
// 账户解析只用于上传准入公平性；绑定和认领仍从原归属表读取。
const accountResolver = createAccountResolver({ listAssignments: () => ownership.listAssignments() });
// 资源只覆盖当前上传或发送；不再建立逐商品执行工作、进程或平台许可。
const ingestProtocol = createIngestProtocol({ database, admission: ingestAdmission,
    resolveAccount: async storeId => accountResolver.resolve(storeId) });
const jobQueue = createJobQueue(dataRoot, store, { ownership, deletedStores, database, scheduler, accountResolver });
// 归属锁与来源锁只覆盖实际交接，不在等候目标插件连接期间占用数据库连接。
const relay = createOneShotRelay({ handoff: (claimed, deliver) => {
    const expected = claimed[0]?.deliveryOwners;
    const check = connection => store.withNoticeDelivery(claimed, result => deliver({ ...result,
        claimed: result.claimed.map(({ deliveryOwners, ...item }) => item) }), connection);
    return expected ? ownership.withStableOwners(expected, check) : check(null);
} });
const relayAdmission = ingestAdmission;
// 通知正文很小，但仍限全局在途和每实例速率，避免错误风暴抢光收发资源或扩大内存。
const noticeRates = new Map();
let noticesActive = 0;
function acquireNotice(instance) {
    const now = Date.now();
    for (const [key, entry] of noticeRates) if (now - entry.start >= 60000) noticeRates.delete(key);
    const entry = noticeRates.get(instance) || { start: now, count: 0 };
    if (noticesActive >= 8 || entry.count >= 60 || (!noticeRates.has(instance) && noticeRates.size >= 1024)) {
        throw Object.assign(Error('error_notice_rate_limited'), { status: 429, retryAfter: 2 });
    }
    entry.count++; noticeRates.set(instance, entry); noticesActive++;
    return () => { noticesActive--; };
}

/** 通知只携带不可逆版本，不把商品、任务或日志标识泄露到长连接。 */
const liveDigest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let liveInventoryVersion = "";
let liveInventoryPromise = null;
let liveInventoryScopes = new Map();

/** 缓存只保留各店的内容摘要，不让长连接长期持有整个仓库的商品发布资料。 */
async function inventoryVersions() {
    if (store.inventoryVersions) return store.inventoryVersions();
    const overview = await store.listOverview();
    const stores = new Map();
    const all = [];
    const append = (ids, item) => {
        const digest = liveDigest(item);
        all.push(digest);
        for (const id of new Set(ids.map(String))) {
            if (!stores.has(id)) stores.set(id, []);
            stores.get(id).push(digest);
        }
    };
    for (const product of overview.products || []) append(product.sourceStoreIds || [], product);
    for (const batch of overview.batches || []) append([batch.sourceStoreId || ""], batch);
    return { all: liveDigest(all), stores: new Map([...stores].map(([id, values]) => [id, liveDigest(values)])) };
}

/** 按真实会话重验长连接，账户停用、过期及角色变更均在下一次推送前生效。 */
async function authorizeLiveRequest(req) {
    if (req.temuLocalMode) return "local";
    if (req.temuDeviceBearer) return readBearerToken(req) === cloudAuth.getDeviceToken() ? "device" : null;
    const cookie = String(req.headers.cookie || "").split(";").map(value => value.trim()).find(value => value.startsWith("temu_session="))?.slice("temu_session=".length) || "";
    const user = await cloudAuth.users.verifySession(cookie);
    if (!user) return null;
    req.temuUser = user;
    req.temuIsAdmin = user.role === "admin";
    return `${user.id}:${user.role}:${user.accountType}`;
}

/** 库存只在文件版本变化时重建一次，随后复用每个可见店铺范围的摘要。 */
async function liveSnapshot(req) {
    const scope = await inventoryReadScope(req);
    const version = await store.indexSignature();
    if (!liveInventoryPromise || liveInventoryVersion !== version) {
        liveInventoryVersion = version;
        liveInventoryScopes = new Map();
        liveInventoryPromise = inventoryVersions();
        // 失败的 Promise 不能永久缓存，否则一次磁盘错误就会阻断后续同步。
        const pending = liveInventoryPromise;
        pending.catch(() => { if (liveInventoryPromise === pending) liveInventoryPromise = null; });
    }
    const scopeKey = scope ? JSON.stringify([...scope].sort()) : "all";
    const inventoryCache = liveInventoryScopes;
    if (!inventoryCache.has(scopeKey)) {
        const versions = await liveInventoryPromise;
        if (inventoryCache.size >= 500) inventoryCache.clear();
        inventoryCache.set(scopeKey, scope ? liveDigest([...scope].sort().map(id => [id, versions.stores.get(id) || ""])) : versions.all);
    }
    const inventory = inventoryCache.get(scopeKey);
    const assignments = await ownership.listAssignments();
    const owned = Object.entries(assignments).filter(([id]) => !scope || scope.has(id)).sort(([a], [b]) => a.localeCompare(b));
    const visibleAgents = (await jobQueue.listAgents({ scope: await targetStoreScope(req) })).agents;
    const allAgents = (await jobQueue.listAgents()).agents;
    const domains = await ownership.listDataDomains();
    const inDirectory = id => req.temuLocalMode || req.temuDeviceBearer || !domains[id] || domains[id] === requestAccountType(req);
    const agentVersion = agents => agents.map(a => [a.storeId, a.pluginInstanceId, a.online, a.identityMatched, a.canReceiveUploads, a.storeName, a.pluginVersion]);
    return {
        inventory,
        claims: liveDigest(owned),
        agents: liveDigest(agentVersion(visibleAgents)),
        // 认领目录仍显示未分类的新店，但另一分类的在线状态和归属不参与当前摘要。
        directory: liveDigest([agentVersion(allAgents.filter(a => inDirectory(a.storeId))), Object.entries(assignments).filter(([id]) => inDirectory(id))])
    };
}

const liveEvents = createLiveEvents({ rootDir: dataRoot, snapshot: liveSnapshot, authorize: authorizeLiveRequest });
// 数据库事务提交后唤醒 SSE；心跳若没有可见状态变化，摘要相同就不会让页面刷新。
database?.subscribe(() => liveEvents.notify());


/**
 * 写入权限仍限本人店铺；管理员管理操作可处理所选分类，不能把共享可读范围当成可写范围。
 * 返回 null 表示"不过滤"，避免为每个接口都构造一份全集。
 */
async function visibleStoreScope(req) {
    if (req.temuLocalMode === true || req.temuDeviceBearer === true) return null;
    if (req.temuIsAdmin === true) return categoryStoreScope(req);
    if (!req.temuUser) return null;
    return await ownership.ownedStoreIds(req.temuUser.id);
}

/** 分类由会话决定；只有管理员管理页能显式选择正式/测试范围，不接受普通用户伪造分类。 */
function requestAccountType(req) {
    const url = new URL(req.url, 'http://local');
    const requested = url.searchParams.get('accountType');
    return req.temuIsAdmin && ['production', 'test', 'unclassified'].includes(requested) ? requested : (req.temuUser?.accountType || 'production');
}
async function categoryStoreScope(req) {
    if (req.temuLocalMode || req.temuDeviceBearer) return null;
    const type = requestAccountType(req);
    return new Set(Object.entries(await ownership.listDataDomains()).filter(([, value]) => value === type).map(([id]) => id));
}
/** 共享库按分类读取，个人库再求本人店铺交集；解除归属不会改变共享数据分类。 */
async function inventoryReadScope(req) {
    const scope = await categoryStoreScope(req);
    if (!scope || new URL(req.url, 'http://local').searchParams.get('library') !== 'personal') return scope;
    const owned = await ownership.ownedStoreIds(req.temuUser?.id);
    return new Set([...scope].filter(id => owned.has(id)));
}
/** 发送目标必须同时属于本人和当前数据分类，管理员切到测试库也不能投递正式店。 */
async function targetStoreScope(req) {
    if (req.temuLocalMode || req.temuDeviceBearer) return null;
    const owned = await ownership.ownedStoreIds(req.temuUser?.id), category = await categoryStoreScope(req);
    return new Set([...owned].filter(id => category.has(id)));
}

/** 商品行是否属于可见范围：来源店命中任一可见店铺即可见。 */
function productInScope(product, scope) {
    if (!scope) return true;
    const stores = Array.isArray(product?.sourceStoreIds) ? product.sourceStoreIds : [];
    return stores.some((storeId) => scope.has(String(storeId)));
}

/**
 * 按可见范围裁剪仓库总览。只过滤来源数据；目标店相关统计不在本函数处理。
 * 范围在入口按账户分类和库类型生成；解绑仍保留分类，共享库可继续读取同类来源。
 */
function scopeOverview(overview, scope) {
    if (!scope) return overview;
    const products = (overview.products || []).filter((product) => productInScope(product, scope));
    const allowedIds = new Set(products.flatMap((product) => [product.spuId, ...(product.spuIds || [])]).map(String));
    const batches = (overview.batches || []).filter((batch) => scope.has(String(batch.sourceStoreId || "")));
    const batchIds = new Set(batches.map((batch) => batch.id));
    return {
        ...overview,
        productCount: products.length,
        readyCount: products.filter((item) => item.ready).length,
        missingDetailCount: products.filter((item) => !item.completeness?.hasDetail && !item.completeness?.hasPrimaryDetail).length,
        sourceEmptyDetailCount: products.filter((item) => item.completeness?.detailState === "source-empty").length,
        missingImageCount: products.filter((item) => !(item.completeness && item.completeness.hasImages)).length,
        incompleteCount: products.filter((item) => !item.ready).length,
        blockedCount: products.filter((item) => item.blocked).length,
        batchCount: batches.length,
        fileCount: batches.reduce((sum, batch) => sum + (Number(batch.fileCount) || (batch.files || []).length), 0),
        products,
        batches
    };
}

/** 只信任已验证会话产生的管理身份，不能让请求正文指定或跳过权限范围。 */
function taskAccess(req) {
    return req.temuLocalMode || req.temuDeviceBearer || req.temuIsAdmin ? null : { userId: req.temuUser?.id || "unauthorized" };
}

/** 用户会话调用插件接口仍须拥有正文店铺；插件令牌继续由实例绑定和领取凭证约束。 */
async function requirePluginStoreAccess(req, res, body) {
    if (isPluginScopedRequest(req) || !req.temuUser || !taskAccess(req)) return true;
    const storeId = String(body?.storeId || "").trim();
    const scope = await ownership.ownedStoreIds(req.temuUser.id);
    if (storeId && scope.has(storeId)) return true;
    send(res, 403, { error: "store_not_claimed", message: "只能操作当前账号名下的店铺" });
    return false;
}

/** 详情与下载沿用共享/个人读取范围；可猜 ID 不能绕过测试正式分类。 */
async function resourceVisible(req, stores) {
    const scope = await inventoryReadScope(req);
    return !scope || (stores.length > 0 && stores.every(id => scope.has(String(id || ""))));
}

/** 附件插件读权限绑定令牌实例和当前认领目标；共享来源可读，但测试正式分类不能由查询参数切换。 */
async function qualificationAssetScope(req, sourceStoreId) {
    if (!isPluginScopedRequest(req)) return inventoryReadScope(req);
    // GET 没有请求正文承载实例声明；若显式携带实例头，必须与令牌绑定一致，不能借他店实例读取材料。
    if (req.headers['x-plugin-instance'] && req.headers['x-plugin-instance'] !== req.temuPluginInstanceId) {
        throw Object.assign(Error('qualification_asset_instance_mismatch'), { status: 403 });
    }
    const agents = (await jobQueue.listAgents()).agents.filter(agent => agent.pluginInstanceId === req.temuPluginInstanceId
        && agent.identityMatched && agent.online && agent.storeId);
    const domains = await ownership.listDataDomains();
    for (const agent of agents) {
        if (await deletedStores.isDeleted(agent.storeId)) continue;
        const owner = await ownership.findOwner(agent.storeId);
        const user = owner && await cloudAuth.users.findById(owner.ownerId);
        if (!user || user.disabled) continue;
        const type = user.accountType === 'test' ? 'test' : 'production';
        if (domains[agent.storeId] === type && domains[sourceStoreId] === type) {
            return new Set(Object.entries(domains).filter(([, value]) => value === type).map(([id]) => id));
        }
    }
    throw Object.assign(Error('qualification_asset_target_not_claimed'), { status: 403 });
}

/** 认证模块白名单不可在本次越界修改；仅精确附件 GET 借用插件认领认证，路由仍独立核验数据权限。 */
async function authenticateQualificationRequest(req, res) {
    const requestUrl = req.url;
    const url = new URL(requestUrl, 'http://local');
    const pathname = stripRequestBasePath(req, url.pathname);
    const assetRead = req.method === 'GET' && /^\/api\/qualification-assets\/\d{6,20}\/[a-f0-9]{64}$/.test(pathname);
    try {
        if (assetRead && readBearerToken(req).startsWith('pt_')) {
            const prefix = resolveRequestBasePath(req, url.pathname);
            req.url = `${prefix}/api/jobs/claim`;
        }
        return await cloudAuth.authenticate(req, res);
    } finally {
        req.url = requestUrl;
        if (assetRead) req.headers['x-temu-path'] = pathname;
    }
}

/** 商品搜索覆盖列表可见和判重会使用的标识，避免只搜到当前页而漏掉后续页商品。 */
function overviewProductSearchText(product = {}) {
    return [
        product.title,
        product.spuId,
        ...(product.spuIds || []),
        product.goodsId,
        product.category,
        product.articleNo,
        ...(product.productExtCodes || []),
        ...(product.skuExtCodes || []),
        ...(product.skus || []).map((sku) => sku && sku.extCode)
    ].map((value) => String(value || "").trim()).filter(Boolean).join(" ").toLocaleLowerCase();
}

/** 商品筛选在服务端完成后再切页，搜索不会只作用于浏览器当前已加载的行。 */
function paginateOverview(overview, url) {
    const query = String(url.searchParams.get("productQ") || "").trim().toLocaleLowerCase();
    const sourceStoreId = String(url.searchParams.get("sourceStoreId") || "").trim();
    const sourceBatchId = String(url.searchParams.get("sourceBatchId") || "").trim();
    const blockedFilter = String(url.searchParams.get("blocked") || "").trim();
    const readyOnly = ["1", "true", "yes"].includes(String(url.searchParams.get("readyOnly") || "").toLocaleLowerCase());
    const includeAllBatches = url.searchParams.get("includeAllBatches") === "1";
    const hasFilter = Boolean(query || sourceStoreId || sourceBatchId || blockedFilter || readyOnly);
    const hasPaging = url.searchParams.has("productLimit") || url.searchParams.has("productOffset") || hasFilter;
    if (!hasPaging) return overview;
    const allProducts = Array.isArray(overview.products) ? overview.products : [];
    const products = allProducts.filter((product) => {
        if (sourceStoreId && !(product.sourceStoreIds || []).map(String).includes(sourceStoreId)) return false;
        if (sourceBatchId && !(product.batchIds || []).map(String).includes(sourceBatchId)) return false;
        if (blockedFilter === "blocked" && !product.blocked) return false;
        if (blockedFilter === "normal" && product.blocked) return false;
        if (readyOnly && !product.ready) return false;
        return !query || overviewProductSearchText(product).includes(query);
    });
    const requestedLimit = Number(url.searchParams.get("productLimit"));
    const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(0, requestedLimit)) : 100;
    const offset = Math.max(0, Number(url.searchParams.get("productOffset")) || 0);
    const pageProducts = limit > 0 ? products.slice(offset, offset + limit) : [];
    const pageBatchIds = new Set(pageProducts.flatMap((product) => (product.batchIds || []).map(String)));
    // 目录先从全范围批次生成，再裁当前商品页，解绑或当前页没有该店也不能丢失已有名称。
    const sourceStores = sourceStoreDirectory(overview.batches || []);
    return {
        ...overview,
        productCount: allProducts.length,
        productTotal: products.length,
        filteredReadyCount: products.filter((product) => product.ready).length,
        productOffset: offset,
        productPageSize: limit,
        productsHasMore: limit > 0 && offset + limit < products.length,
        products: pageProducts,
        sourceStores,
        productFilters: { query, sourceStoreId, sourceBatchId, blocked: blockedFilter, readyOnly },
        // 首页摘要仍使用完整批次；分页商品库只带当前页关联批次，减少大仓库重复传输。
        batches: limit > 0 && !includeAllBatches
            ? (overview.batches || []).filter((batch) => pageBatchIds.has(String(batch.id)))
            : (overview.batches || [])
    };
}


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
    /**
     * 本机直连时页面地址带 /temu 前缀（/temu/app.js），线上由 nginx 剥掉前缀后是 /app.js。
     * 这里统一剥掉前缀再定位文件，让两种部署都能正确加载静态资源。
     */
    const relativePath = stripRequestBasePath(req, url.pathname);
    /**
     * 无扩展名的干净路径映射到对应页面，让地址栏里是 /admin 而不是 /admin.html。
     * 管理站是独立页面而非 SPA 的一个 hash 页：它只做管理，
     * 因此不需要（也不应该）加载业务工作台那一整套逻辑。
     */
    const PAGE_ROUTES = { "/admin": "admin.html" };
    const mapped = PAGE_ROUTES[relativePath.replace(/\/+$/, "") || relativePath];
    const requested = relativePath === "/"
        ? path.join(root, "index.html")
        : path.join(root, decodeURIComponent(mapped || relativePath));
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
        const stream = createReadStream(target);
        /**
         * 必须在写响应头之前处理流错误：文件在 stat 之后被删除、或并发过高导致
         * 打开失败时，流错误发生在 writeHead 之后就无法再改成 4xx/5xx，
         * 浏览器只会收到一个被截断的响应，表现为页面样式或脚本凭空消失。
         */
        stream.once("error", () => {
            if (!res.headersSent) notFound(res);
            else res.destroy();
        });
        res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
        stream.pipe(res);
    } catch {
        notFound(res);
    }
}

const server = http.createServer(async (req, res) => {
    try {
        // 预检不读写资料，仅为指定机器接口声明跨域许可；真正请求仍必须通过独立认证。
        if(req.method==="OPTIONS" && /^\/api\/(ingest(?:\/prepare|\/requests\/[a-zA-Z0-9-]{16,80}(?:\/cancel)?)?|agents\/register|jobs\/claim)$/.test(stripRequestBasePath(req, String(req.url).split('?')[0]))) {
            writeIngestCors(req,res);res.writeHead(204);res.end();return;
        }
        if (cloudAuthEnabled) {
            if (!await authenticateQualificationRequest(req,res)) return;
            // 用户会话与设备令牌才代表"人可以操作数据"；插件令牌是受限身份，只能走插件侧接口。
            req.temuAuthenticated = Boolean(req.temuUser || req.temuDeviceBearer);
        } else {
            // 本地服务不依赖云端账号文件：回环页面免登录，非回环请求必须携带本机入库令牌。
            // /api/ingest 仍会再次校验令牌，避免错误令牌借本机连接绕过直推鉴权。
            const localAuthorized = isLocalMachineRequest(req)
                || isValidIngestToken(readBearerToken(req), auth.token);
            if (!localAuthorized) return send(res, 401, { error: "local_auth_required" });
            req.temuAuthenticated = true;
            // 本机模式没有账号体系，按本机管理员处理，保持原有全量权限。
            req.temuLocalMode = true;
            req.temuIsAdmin = true;
        }
        const url = new URL(req.url, `http://${HOST}:${PORT}`);
        /**
         * 路由判定统一用"无前缀"路径：线上 nginx 剥掉 /temu 后本来就是无前缀，
         * 本机直连时浏览器带 /temu，这里补齐成同一种形态，避免同一份路由写两套。
         */
        url.pathname = stripRequestBasePath(req, url.pathname);
        if (req.method === "POST" && url.pathname === "/api/plugin/register") {
            const body=JSON.parse((await readBody(req,16*1024)).toString("utf8"));
            // 已认证的插件只能为自身实例续领；无令牌的旧插件首次接入流程保持兼容。
            if (!requirePluginInstance(req, res, body)) return;
            const token=issuePluginToken(body.pluginInstanceId);
            if(!token)return send(res,400,{error:"invalid_plugin_instance"});
            return send(res,200,{ok:true,token,expiresIn:86400,scope:"plugin-transfer",pluginInstanceId:String(body.pluginInstanceId)});
        }
        if (req.method === "POST" && url.pathname === "/api/admin/plugins/disable") {
            if (!requireAdminAccess(req, res)) return;
            const body=JSON.parse((await readBody(req,16*1024)).toString("utf8"));
            return send(res,200,{ok:true,disabled: disablePluginInstance(body.pluginInstanceId)});
        }
        if (req.method === "OPTIONS" && url.pathname === "/api/ingest") {
            writeIngestCors(req, res);
            res.writeHead(204);
            res.end();
            return;
        }
        if (req.method === "OPTIONS" && (url.pathname === "/api/agents/register" || url.pathname === "/api/jobs/claim")) {
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
                ingestPath: "/api/ingest",
                accountExecutionProtocol: 0, relayProtocol: 1
            });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/me") {
            // 前端用它渲染页头身份与管理员入口；插件令牌拿不到这里。
            if (!requireUserAccess(req, res)) return;
            send(res, 200, {
                user: req.temuUser || { id: "local", username: "本机管理员", role: "admin", disabled: false },
                isAdmin: req.temuLocalMode === true || req.temuDeviceBearer === true || req.temuIsAdmin === true,
                localMode: req.temuLocalMode === true
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/me/password") {
            if (!requireUserAccess(req, res)) return;
            if (!req.temuUser) return send(res, 400, { error: "local_mode_no_password" });
            const body = JSON.parse(stripBom((await readBody(req, 8 * 1024)).toString("utf8")));
            const current = await cloudAuth.users.verify({ username: req.temuUser.username, password: body?.currentPassword });
            if (!current) return send(res, 401, { error: "current_password_incorrect", message: "当前密码不正确" });
            send(res, 200, { ok: true, user: await cloudAuth.users.changePassword(req.temuUser.id, body?.newPassword) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/admin/users") {
            if (!requireAdminAccess(req, res)) return;
            const registration = await cloudAuth.users.registrationStatus();
            const users = await cloudAuth.users.listUsers();
            send(res, 200, { users, ...registration, userCount: users.filter(user => user.accountType === requestAccountType(req)).length,
                counts: { production: registration.userCount, test: registration.testUserCount } });
            return;
        }
        // 管理端注册固定生成测试普通账户，不复用公开注册的身份参数或注册开关。
        if (req.method === 'POST' && url.pathname === '/api/admin/users/test') {
            if (!requireAdminAccess(req, res)) return;
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: 'registration_origin_denied' });
            const body = JSON.parse(stripBom((await readBody(req, 8 * 1024)).toString('utf8')));
            send(res, 201, { user: await cloudAuth.users.createTestUser(body) });
            liveEvents.notify();
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/admin/users/password") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 8 * 1024)).toString("utf8")));
            send(res, 200, { ok: true, user: await cloudAuth.users.changePassword(body?.userId, body?.newPassword) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/admin/users/disabled") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 8 * 1024)).toString("utf8")));
            send(res, 200, { ok: true, user: await cloudAuth.users.setDisabled(body?.userId, body?.disabled) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/admin/users/role") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 8 * 1024)).toString("utf8")));
            send(res, 200, { ok: true, user: await cloudAuth.users.setRole(body?.userId, body?.role) });
            return;
        }
        /**
         * 删除账号前的数据预检：列出该账号名下的店铺，供确认弹窗展示。
         * 账号和店铺是两份数据，删账号不自动动店铺——必须让管理员先看到会影响哪些店，
         * 再选择"保留店铺"还是"连店铺一起删"。
         */
        if (req.method === "GET" && url.pathname === "/api/admin/users/impact") {
            if (!requireAdminAccess(req, res)) return;
            const userId = String(url.searchParams.get("userId") || "").trim();
            const target = await cloudAuth.users.findById(userId);
            if (!target) return send(res, 404, { error: "user_not_found", message: "目标用户不存在" });
            const assignments = await ownership.listAssignments();
            const owned = Object.entries(assignments)
                .filter(([, entry]) => entry.ownerId === userId)
                .map(([storeId, entry]) => ({ storeId, storeName: entry.storeName || storeId }));
            // 完全删除模式下还会连带删除这些店铺采集的商品，把总量一并给出。
            let productCount = 0;
            for (const item of owned) {
                const impact = await store.storeDataImpact(item.storeId).catch(() => null);
                productCount += Number(impact?.productCount) || 0;
            }
            send(res, 200, { user: target, stores: owned, storeCount: owned.length, productCount });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/admin/users/delete") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 8 * 1024)).toString("utf8")));
            const userId = String(body?.userId || "").trim();
            // mode=purge 表示连该账号名下的店铺与商品一并删除；默认 keep 只删账号。
            const purge = String(body?.mode || "keep") === "purge";
            const target = await cloudAuth.users.findById(userId);
            if (!target) return send(res, 404, { error: "user_not_found", message: "目标用户不存在" });
            const assignments = await ownership.listAssignments();
            const owned = Object.entries(assignments)
                .filter(([, entry]) => entry.ownerId === userId)
                .map(([storeId, entry]) => ({ storeId, storeName: entry.storeName || storeId }));
            // 先删账号：账号是这次操作的主体，失败时不应留下"店铺已删但账号还在"的半成品。
            const removed = await cloudAuth.users.removeUser(userId);
            const purged = [];
            if (purge) {
                for (const item of owned) {
                    await jobQueue.deleteStoreRecord(item.storeId).catch(() => {});
                    await store.deleteStoreData(item.storeId, { keepProducts: false }).catch(() => {});
                    await deletedStores.markDeleted({
                        storeId: item.storeId,
                        storeName: item.storeName,
                        mode: "purge",
                        previousOwnerId: userId,
                        previousOwnerName: target.username,
                        deletedBy: req.temuUser?.username || "admin"
                    }).catch(() => {});
                    purged.push(item.storeId);
                }
                // 归属记录随店铺一起消失，避免留下指向已删店铺的孤儿条目。
                await ownership.releaseByOwner(userId).catch(() => {});
            } else {
                // 只删账号：店铺回到"未认领"，其他人可重新认领，商品数据保留。
                // 不释放就会留下孤儿归属（ownerId 指向已不存在的账号），店铺永远认领不了。
                await ownership.releaseByOwner(userId).catch(() => {});
            }
            send(res, 200, {
                ok: true,
                ...removed,
                mode: purge ? "purge" : "keep",
                releasedStores: owned.map((item) => item.storeName || item.storeId),
                purgedStores: purged
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/admin/registration") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 8 * 1024)).toString("utf8")));
            send(res, 200, { ok: true, ...(await cloudAuth.users.setRegistrationOpen(body?.open)) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/overview") {
            if (!requireUserAccess(req, res)) return;
            const scope = await inventoryReadScope(req);
            if (store.listOverviewPage) {
                const overview = await store.listOverviewPage(scope, url);
                send(res, 200, projectCatalogPermissions(projectSourceStoreNames(overview, await ownership.listAssignments(), scope), await visibleStoreScope(req)));
                return;
            }
            // 默认同分类共享商品；个人库保持本人认领店铺的来源范围。
            const overview = scopeOverview(await store.listOverview(), scope);
            send(res, 200, projectCatalogPermissions(projectSourceStoreNames(paginateOverview(overview, url), await ownership.listAssignments(), scope), await visibleStoreScope(req)));
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/stores") {
            /**
             * 店铺页数据源，分两类：
             *   online —— 插件连接过的所有店铺（供认领，别人已认领的也可见但不可再认领）；
             *   mine   —— 我已认领的店铺（含当前离线的，用于解除认领）。
             * 两份数据合并自"插件心跳表"与"归属表"：归属表保证认领过的店永不消失，
             * 心跳表保证只看插件连过一次就被记住，即使它之后再没上线。
             */
            if (!requireUserAccess(req, res)) return;
            const assignments = await ownership.listAssignments();
            const agents = (await jobQueue.listAgents()).agents || [];
            const domains = await ownership.listDataDomains();
            const category = requestAccountType(req);
            const isAdmin = req.temuLocalMode === true || req.temuDeviceBearer === true || req.temuIsAdmin === true;
            const meId = req.temuUser?.id || "";
            const byStore = new Map();
            for (const agent of agents) {
                const storeId = String(agent.storeId || "").trim();
                if (!storeId) continue;
                const current = byStore.get(storeId) || { storeId, storeName: "", online: false, lastSeenAt: "", pluginVersion: "", pageStoreName: "" };
                // 取最近心跳的实例作为该店展示信息，避免旧实例的离线状态覆盖在线状态。
                if (!current.lastSeenAt || String(agent.lastSeenAt || "") > current.lastSeenAt) {
                    current.storeName = String(agent.storeName || agent.pageStoreName || storeId);
                    current.pageStoreName = String(agent.pageStoreName || "");
                    current.lastSeenAt = String(agent.lastSeenAt || "");
                    current.pluginVersion = String(agent.pluginVersion || "");
                }
                current.online = current.online || Boolean(agent.online);
                byStore.set(storeId, current);
            }
            // 归属表里的店铺即使心跳记录已被轮换掉，也必须继续显示——认领过就永久保留。
            for (const [storeId, entry] of Object.entries(assignments)) {
                if (byStore.has(storeId)) continue;
                byStore.set(storeId, { storeId, storeName: entry.storeName || storeId, online: false, lastSeenAt: "", pluginVersion: "", pageStoreName: "" });
            }
            // 旧数据已经解绑且没有在线实例时，管理员仍需能找到它并显式归类，不让资料永久隐身。
            if (req.temuIsAdmin && category === 'unclassified') for (const [storeId, type] of Object.entries(domains)) {
                if (type === 'unclassified' && !byStore.has(storeId)) byStore.set(storeId, { storeId, storeName: storeId, online: false });
            }
            const maskPhone = cloudAuth.users.maskPhone || ((value) => value);
            const stores = [...byStore.values()].filter(item => req.temuLocalMode || req.temuDeviceBearer
                || (category === 'unclassified' ? domains[item.storeId] === category : !domains[item.storeId] || domains[item.storeId] === category)).map((store) => {
                const owner = assignments[store.storeId] || null;
                return {
                    ...store,
                    accountType: domains[store.storeId] || '',
                    // 三态：unclaimed 待认领、mine 我认领的、others 他人认领（可见但不可再认领）
                    claimState: !owner ? "unclaimed" : (owner.ownerId === meId ? "mine" : "others"),
                    // 页面要显示"谁认领的"，但完整手机号只对本人与管理员可见，其余一律脱敏。
                    ownerName: owner ? ((isAdmin || owner.ownerId === meId) ? owner.ownerName : maskPhone(owner.ownerName)) : "",
                    ownerNameMasked: owner ? maskPhone(owner.ownerName) : "",
                    ownerId: isAdmin ? (owner?.ownerId || "") : "",
                    claimedAt: owner?.claimedAt || ""
                };
            });
            /**
             * 排序：在线（绿灯）集中在上，离线（红灯）在下。
             * 同一组内按店铺名排序，保证列表稳定，不会因心跳时间抖动而跳来跳去。
             */
            const collator = new Intl.Collator("zh-Hans-CN", { numeric: true, sensitivity: "base" });
            const byName = (left, right) => collator.compare(String(left.storeName || left.storeId), String(right.storeName || right.storeId));
            stores.sort((left, right) => (left.online === right.online) ? byName(left, right) : (left.online ? -1 : 1));
            const mine = stores.filter((store) => store.claimState === "mine");
            const counts = {
                unclaimed: stores.filter((store) => store.claimState === "unclaimed").length,
                mine: mine.length,
                others: stores.filter((store) => store.claimState === "others").length,
                online: stores.filter((store) => store.online).length,
                offline: stores.filter((store) => !store.online).length
            };
            const hasStoreQuery = ["limit", "offset", "view", "q", "online", "claimState"]
                .some((key) => url.searchParams.has(key));
            if (hasStoreQuery) {
                const view = String(url.searchParams.get("view") || "all").trim().toLocaleLowerCase();
                const query = String(url.searchParams.get("q") || "").trim().toLocaleLowerCase();
                const onlineFilter = String(url.searchParams.get("online") || "").trim();
                const claimFilter = String(url.searchParams.get("claimState") || "").trim();
                const requestedLimit = Number(url.searchParams.get("limit"));
                const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 50;
                const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
                const filtered = stores.filter((store) => {
                    if (view === "mine" && store.claimState !== "mine") return false;
                    if (onlineFilter === "1" && !store.online) return false;
                    if (onlineFilter === "0" && store.online) return false;
                    if (claimFilter && store.claimState !== claimFilter) return false;
                    if (!query) return true;
                    return [
                        store.storeName,
                        store.storeId,
                        store.pageStoreName,
                        store.ownerName,
                        store.ownerNameMasked,
                        store.pluginVersion
                    ].map((value) => String(value || "").toLocaleLowerCase()).join(" ").includes(query);
                });
                const page = filtered.slice(offset, offset + limit);
                send(res, 200, {
                    stores: page,
                    online: page.filter((store) => store.online),
                    offline: page.filter((store) => !store.online),
                    mine: page.filter((store) => store.claimState === "mine"),
                    isAdmin,
                    counts,
                    total: filtered.length,
                    offset,
                    limit,
                    hasMore: offset + page.length < filtered.length,
                    filters: { view, q: query, online: onlineFilter, claimState: claimFilter }
                });
                return;
            }
            send(res, 200, {
                stores,
                // 两个分类分开返回，前端直接渲染，避免前端各自实现一遍筛选口径。
                online: stores.filter((store) => store.online),
                offline: stores.filter((store) => !store.online),
                mine,
                isAdmin,
                counts
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/stores/claim") {
            if (!requireUserAccess(req, res)) return;
            if (!req.temuUser) return send(res, 400, { error: "local_mode_no_claim" });
            // 批量认领允许一次选择多家店铺，保留独立上限但覆盖百店级请求。
            const body = JSON.parse(stripBom((await readBody(req, 256 * 1024)).toString("utf8")));
            const agents = (await jobQueue.listAgents()).agents || [];
            const requested = Array.isArray(body?.stores) && body.stores.length
                ? body.stores
                : (Array.isArray(body?.storeIds) ? body.storeIds : [body?.storeId])
                    .map((storeId) => ({ storeId, storeName: body?.storeName }));
            const normalized = requested.map((item) => {
                const storeId = String(item?.storeId || "").trim();
                const agent = agents.find((candidate) => String(candidate.storeId || "") === storeId);
                return {
                    storeId,
                    storeName: String(item?.storeName || agent?.storeName || agent?.pageStoreName || "").trim()
                };
            }).filter((item) => item.storeId);
            const claims = await ownership.claimMany(normalized, req.temuUser);
            send(res, 200, {
                ok: true,
                claimedCount: claims.length,
                claims,
                // 保留旧单店响应字段，避免已安装页面或脚本升级不同步时拿不到回执。
                claim: claims.length === 1 ? claims[0] : undefined
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/stores/release") {
            if (!requireUserAccess(req, res)) return;
            if (!req.temuUser) return send(res, 400, { error: "local_mode_no_claim" });
            const body = JSON.parse(stripBom((await readBody(req, 16 * 1024)).toString("utf8")));
            send(res, 200, { ok: true, ...(await ownership.release(String(body?.storeId || "").trim(), req.temuUser.id)) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/admin/stores/reassign") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 16 * 1024)).toString("utf8")));
            if (body?.release === true) {
                send(res, 200, { ok: true, ...(await ownership.forceRelease(String(body?.storeId || "").trim())) });
                return;
            }
            const target = await cloudAuth.users.findById(body?.userId);
            if (!target) return send(res, 404, { error: "user_not_found", message: "目标用户不存在" });
            const agents = (await jobQueue.listAgents()).agents || [];
            const storeId = String(body?.storeId || "").trim();
            const agent = agents.find((item) => String(item.storeId || "") === storeId);
            send(res, 200, { ok: true, reassign: await ownership.reassign(storeId, target, String(body?.storeName || agent?.storeName || agent?.pageStoreName || "")) });
            return;
        }
        /**
         * 删除店铺的影响预检：商品数、任务数、日志数、当前归属。
         * 删除不可逆，弹窗必须先摆出"会删掉什么"再让管理员确认。
         * 单独一个端点而不是塞进列表接口：列表页没必要为每个店铺预先统计一遍。
         */
        if (req.method === "GET" && url.pathname === "/api/admin/stores/impact") {
            if (!requireAdminAccess(req, res)) return;
            const storeId = String(url.searchParams.get("storeId") || "").trim();
            if (!storeId) return send(res, 400, { error: "store_missing", message: "缺少店铺标识" });
            const [data, record] = await Promise.all([
                store.storeDataImpact(storeId).catch(() => null),
                jobQueue.storeRecordImpact(storeId).catch(() => null)
            ]);
            const owner = await ownership.findOwner(storeId);
            send(res, 200, {
                storeId,
                storeName: owner?.storeName || "",
                productCount: Number(data?.productCount) || 0,
                batchCount: Number(data?.batchCount) || 0,
                blockedCount: Number(data?.blockedCount) || 0,
                jobCount: Number(record?.jobCount) || 0,
                logCount: Number(record?.logCount) || 0,
                ownerName: owner?.ownerName || ""
            });
            return;
        }
        /**
         * 删除店铺记录。mode=purge 连商品一并物理删除；默认 keep 只删店铺记录与任务日志。
         *
         * 删除后写入名单：插件心跳不会再把这个店登记回来，
         * 否则 8 秒后它就会重新出现在列表里，管理员会以为删除没生效。
         * 名单可在"已删除"分类里手动恢复。
         */
        if (req.method === "POST" && url.pathname === "/api/admin/stores/delete") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 16 * 1024)).toString("utf8")));
            const storeId = String(body?.storeId || "").trim();
            if (!storeId) return send(res, 400, { error: "store_missing", message: "缺少店铺标识" });
            const purge = String(body?.mode || "keep") === "purge";
            const owner = await ownership.findOwner(storeId);
            const agents = (await jobQueue.listAgents()).agents || [];
            const named = agents.find((item) => String(item.storeId || "") === storeId);
            const storeName = String(owner?.storeName || named?.storeName || named?.pageStoreName || storeId);
            // 顺序：先清数据、再清记录、最后解除归属。任一步中断，店铺仍在列表里可见，管理员可重试。
            const data = await store.deleteStoreData(storeId, { keepProducts: !purge });
            const record = await jobQueue.deleteStoreRecord(storeId);
            await ownership.forceRelease(storeId).catch(() => {});
            await deletedStores.markDeleted({
                storeId,
                storeName,
                mode: purge ? "purge" : "keep",
                previousOwnerId: owner?.ownerId || "",
                previousOwnerName: owner?.ownerName || "",
                deletedBy: req.temuUser?.username || "admin"
            });
            send(res, 200, { ok: true, mode: purge ? "purge" : "keep", storeId, storeName, data, record });
            return;
        }
        /** 恢复已删除的店铺：移出名单并写回归属；商品是否还在取决于删除时选的模式。 */
        if (req.method === "POST" && url.pathname === "/api/admin/stores/restore") {
            if (!requireAdminAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 16 * 1024)).toString("utf8")));
            const storeId = String(body?.storeId || "").trim();
            if (!storeId) return send(res, 400, { error: "store_missing", message: "缺少店铺标识" });
            send(res, 200, { ok: true, ...(await jobQueue.restoreDeletedStore(storeId)) });
            return;
        }
        /** 已删除店铺列表：含删除时间、操作人与当时归属，供恢复前核对。 */
        if (req.method === "GET" && url.pathname === "/api/admin/stores/deleted") {
            if (!requireAdminAccess(req, res)) return;
            const scope = await categoryStoreScope(req);
            send(res, 200, { stores: (await jobQueue.listDeletedStores()).filter(item => !scope || scope.has(item.storeId)) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/ziniao/stores") {
            if (!requireUserAccess(req, res)) return;
            const scope = await targetStoreScope(req);
            // 普通用户只看得到自己认领的店铺；否则这个接口会把全公司的店铺目录泄露给每个账号。
            const inScope = (storeId) => !scope || scope.has(String(storeId || ""));
            const agents=(await jobQueue.listAgents()).agents.filter((agent) => inScope(agent.storeId));
            if (url.searchParams.get("scope") === "all") {
                let directory = { stores: [], updatedAt: null };
                let directoryError = "";
                try {
                    // 正常页面读取缓存目录，避免首屏被紫鸟 CLI 阻塞；只有显式刷新按钮才等待全量更新。
                    directory = await transferManager.listStores();
                    const forceRefresh = url.searchParams.get("refresh") === "1";
                    if (forceRefresh || !directory.stores?.length) {
                        directory = await transferManager.refreshStores({ maxAgeMs: forceRefresh ? 0 : 60000 });
                    }
                } catch (error) {
                    directoryError = String(error && error.message || error).slice(0, 300);
                }
                const agentByStore = new Map(agents.filter((agent) => agent.storeId).map((agent) => [String(agent.storeId), agent]));
                const stores = directory.stores.filter((item) => inScope(item.storeId)).map((item) => {
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
                if (url.searchParams.has("limit") || url.searchParams.has("offset")
                    || url.searchParams.has("q") || url.searchParams.has("online")) {
                    const query = String(url.searchParams.get("q") || "").trim().toLocaleLowerCase();
                    const onlineFilter = String(url.searchParams.get("online") || "").trim();
                    const requestedLimit = Number(url.searchParams.get("limit"));
                    const limit = Number.isFinite(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
                    const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
                    const filtered = stores.filter((store) => {
                        if (onlineFilter === "1" && !store.online) return false;
                        if (onlineFilter === "0" && store.online) return false;
                        if (!query) return true;
                        return [store.name, store.storeId, store.platform]
                            .map((value) => String(value || "").toLocaleLowerCase()).join(" ").includes(query);
                    });
                    const page = filtered.slice(offset, offset + limit);
                    send(res, 200, {
                        stores: page,
                        updatedAt: directory.updatedAt,
                        error: directoryError,
                        total: filtered.length,
                        offset,
                        limit,
                        hasMore: offset + page.length < filtered.length,
                        counts: {
                            total: stores.length,
                            online: stores.filter((store) => store.online).length,
                            offline: stores.filter((store) => !store.online).length
                        }
                    });
                    return;
                }
                send(res, 200, { stores, updatedAt: directory.updatedAt, error: directoryError });
                return;
            }
            // 店铺选择只展示近期心跳且身份已核验的实例，避免离线旧窗口或测试 Agent 污染来源店列表。
            send(res, 200, {stores:agents.filter(a=>a.storeId&&a.online&&a.identityMatched).map(a=>({storeId:a.storeId,name:a.storeName||a.pageStoreName}))});
            return;
        }
        // 商品库与店铺认领共用原有插件目录；在线与绑定状态保持独立自动更新。
        if (req.method === "GET" && url.pathname === "/api/agents") {
            if (!requireUserAccess(req, res)) return;
            send(res, 200, await jobQueue.listAgents({
                scope: await targetStoreScope(req),
                query: String(url.searchParams.get("q") || "").trim(),
                online: url.searchParams.has("online") ? url.searchParams.get("online") === "1" : null,
                receivable: url.searchParams.has("receivable") ? url.searchParams.get("receivable") === "1" : null,
                limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null,
                offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : null
            }));
            return;
        }
        // SSE 与断线兜底共用同一权限和版本语义，插件令牌不能订阅用户事件。
        if (req.method === "GET" && url.pathname === "/api/events") {
            if (!requireUserAccess(req, res)) return;
            liveEvents.connect(req, res);
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/live") {
            if (!requireUserAccess(req, res)) return;
            send(res, 200, await liveSnapshot(req));
            return;
        }
        // 网页可核对传输协议版本；不宣称插件已接收或平台已创建。
        if (req.method === "GET" && url.pathname === "/api/direct-create-capability") {
            if (!requireUserAccess(req, res)) return;
            return send(res, 200, { directCreate: true, relayProtocol: 1, minimumPluginVersion: "11.0.4",
                actionTypes: ['product_create', 'qualification_upload'],
                errorNoticeProtocol: 2, errorNoticeMinimumPluginVersion: '10.10.72' });
        }
        // 仅过滤来源商品禁传并处理当前发送；异常凭证不建立执行任务或成功回执。
        if (req.method === "POST" && url.pathname === "/api/relay/send") {
            if (!requireUserAccess(req, res)) return;
            let input;
            try { input = JSON.parse(stripBom((await readBody(req, 256 * 1024)).toString("utf8"))); }
            catch (error) { if (error.status) throw error; return send(res, 400, { error: "发送请求不是合法 JSON" }); }
            if (!input || typeof input !== 'object' || Array.isArray(input)) return send(res, 400, { error: "发送请求需要对象" });
            // 操作类型由人工选择，服务端仅校验白名单并转发，不根据资质正文猜测执行流程。
            const actionType = Object.hasOwn(input, 'actionType') ? input.actionType : 'product_create';
            if (!['product_create', 'qualification_upload'].includes(actionType)) return send(res, 400, { error: '上传操作类型无效' });
            if (input.manualSendId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.manualSendId)) return send(res, 400, { error: "发送标识无效" });
            const scope = await categoryStoreScope(req);
            const targetScope = await targetStoreScope(req);
            const sourceStoreId = String(input.sourceStoreId || ""), targetStoreId = String(input.targetStoreId || "");
            if ((scope && !scope.has(sourceStoreId)) || (targetScope && !targetScope.has(targetStoreId))) return send(res, 403, { error: "store_not_claimed" });
            const deliveryOwners = await ownership.snapshotDeliveryOwners([...new Set([sourceStoreId, targetStoreId])], targetStoreId, targetScope ? req.temuUser?.id : null);
            const abort = new AbortController();
            const cancel = () => abort.abort();
            req.once("aborted", cancel); res.once("close", cancel);
            let release;
            try {
                if (await deletedStores.isDeleted(sourceStoreId) || await deletedStores.isDeleted(targetStoreId)) throw Object.assign(Error("店铺已删除"), { status: 409 });
                const batch = await store.getBatch(String(input.sourceBatchId || ""));
                if (!batch || batch.sourceStoreId !== sourceStoreId) throw Object.assign(Error("来源店与商品批次不符"), { status: 400 });
                const ids = [...new Set(Array.isArray(input.spuIds) ? input.spuIds.map(String) : [])];
                if (!ids.length || ids.length > 10) throw Object.assign(Error("每次传输1至10件商品"), { status: 400 });
                if (sourceStoreId === targetStoreId && input.sameStoreConfirmed !== true) throw Object.assign(Error("请确认发送到来源店铺"), { status: 409 });
                const products = (batch.products || []).filter(p => ids.includes(String(p.spuId)));
                if (products.length !== ids.length) throw Object.assign(Error("来源商品不存在"), { status: 404 });
                const references = await store.noticeRefs(sourceStoreId, ids);
                const refs = new Map(references.map(ref => [String(ref.spuId), ref]));
                const skippedBlocked = [], eligible = [];
                for (const product of products) {
                    const ref = refs.get(String(product.spuId));
                    if (!ref || ref.sourceVersion !== transferHash(canonicalProductSnapshot(product))) {
                        throw Object.assign(Error('来源商品版本已变化，请刷新后重新选择'), { status: 409 });
                    }
                    if (ref.sendBlocked) skippedBlocked.push({ spuId: String(product.spuId), productCodes: ref.productCodes || [] });
                    else eligible.push(product);
                }
                if (!eligible.length) return send(res, 200, { sent: 0, skippedBlocked, deliveryConfirmed: false });
                release = await relayAdmission.acquire(4 * 1024 * 1024, abort.signal, req.temuUser?.id || "local");
                const target = (await jobQueue.listAgents()).agents.find(a => a.storeId === targetStoreId);
                // 展示为不支持的插件同样不能通过实际发送入口，版本不替代原有身份和会话校验。
                if (!target?.online || !target.identityMatched || !hasRelayPlugin(target)
                    || target.canReceiveUploads !== true || !target.relaySessionId) throw Object.assign(Error("目标店未连接新版插件"), { status: 409 });
                if (!pluginVersionAtLeast(target.pluginVersion, [11, 0, 4])) throw Object.assign(Error('请将目标店插件更新到11.0.4或更新版本，旧插件不支持商品与资质独立任务'), { status: 409 });
                const verified = await verifyQualificationBatchTransfer(store, batch, eligible);
                // 标识仅随当前传输转发，由插件合并同一次点击的分段；服务端不记忆或判重。
                const jobId = input.manualSendId || cryptoRandomId();
                const claimed = verified.map(product => {
                    const snapshot = canonicalProductSnapshot(product);
                    // 商品任务不携带资质，旧页面请求也只能得到商品任务；补全资质保留静态归档引用。
                    if (actionType === 'product_create') delete snapshot.qualifications;
                    const sourceNoticeRef = refs.get(String(product.spuId));
                    return { jobId, spuId: String(product.spuId), title: product.title, snapshot,
                        // 同次点击可以包含多个来源的同SPU；来源身份只是无状态任务隔离，不记录运行情况。
                        sourceTaskId: createHash('sha256').update(JSON.stringify([sourceStoreId, batch.id, targetStoreId])).digest('hex'),
                        transferIntegrity: transferManifest(snapshot), sourceStoreId, targetStoreId,
                        sourceBatchId: batch.id, mode: "manual-plugin-upload", directCreate: true, actionType,
                        transportOnly: true, executionRunId: target.relaySessionId, sourceNoticeRef, deliveryOwners,
                        // 货号集合不是授权依据；不把可能很大的 SKU 集合塞入签名，避免正常投递被凭证长度阻塞。
                        noticeToken: noticeTokens.issue({ sourceStoreId, spuId: String(product.spuId),
                            sourceInstanceId: sourceNoticeRef.sourceInstanceId, sourceVersion: sourceNoticeRef.sourceVersion,
                            noticeEpoch: sourceNoticeRef.noticeEpoch, targetStoreId,
                            pluginInstanceId: target.pluginInstanceId, relaySessionId: target.relaySessionId,
                            owners: deliveryOwners }) };
                });
                if (Buffer.byteLength(JSON.stringify(claimed)) > 4 * 1024 * 1024) throw Object.assign(Error("单批传输超过4MiB，请减少选择"), { status: 413 });
                const result = await relay.send({ storeId: targetStoreId, pluginInstanceId: target.pluginInstanceId, relaySessionId: target.relaySessionId }, claimed, req.temuUser?.id || "local", abort.signal);
                return send(res, 200, { ...result, skippedBlocked: [...skippedBlocked, ...(result.skippedBlocked || []).map(item => ({
                    spuId: String(item.spuId), productCodes: item.productCodes || item.sourceNoticeRef?.productCodes || []
                }))], deliveryConfirmed: false });
            } finally { release?.(); req.off("aborted", cancel); res.off("close", cancel); }
        }
        // 只接收商品错误通知；服务器校验授权与协议码，不查询平台或建立执行状态。
        if (req.method === 'POST' && url.pathname === '/api/products/error-notice') {
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: 'ingest_unauthorized' });
            const instance = req.temuPluginInstanceId || String(req.headers['x-plugin-instance'] || 'device');
            const releaseNotice = acquireNotice(instance);
            try {
                let body;
                try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); }
                catch (error) { if (error.status) throw error; return send(res, 400, { error: 'error_notice_body_invalid' }); }
                if (!requirePluginInstance(req, res, body)) return;
                const error = parseProductErrorNotice(body), grant = noticeTokens.verify(body.noticeToken);
                if (grant.pluginInstanceId !== body.pluginInstanceId) return send(res, 403, { error: 'plugin_instance_mismatch' });
                const agent = (await jobQueue.listAgents()).agents.find(item => item.storeId === grant.targetStoreId);
                if (!agent?.identityMatched || agent.pluginInstanceId !== grant.pluginInstanceId
                    || agent.relaySessionId !== grant.relaySessionId) return send(res, 403, { error: 'error_notice_session_changed' });
                const currentScope = await visibleStoreScope(req);
                if (currentScope && (!currentScope.has(grant.sourceStoreId) || !currentScope.has(grant.targetStoreId))) {
                    return send(res, 403, { error: 'store_not_claimed' });
                }
                const result = await ownership.withStableOwners(grant.owners, connection => error.mark
                    ? store.recordErrorNotice(grant, { ...error, targetStoreId: grant.targetStoreId,
                        targetStoreName: String(agent.storeName || '').slice(0, 255) }, connection)
                    : { status: 'not_product_error' });
                if (result.status === 'marked') liveEvents.notify();
                return send(res, 200, { ok: true, status: result.status });
            } finally { releaseNotice(); }
        }
        // 局部状态同步不写任务、不回传执行确认；范围与商品库相同，旧实例不能读取新商品的状态。
        if (req.method === 'POST' && url.pathname === '/api/products/status-read') {
            if (!requireUserAccess(req, res)) return;
            let body;
            try { body = JSON.parse((await readBody(req, 32 * 1024)).toString('utf8')); }
            catch (error) { if (error.status) throw error; return send(res, 400, { error: 'product_status_invalid' }); }
            const refs = body?.products;
            if (!body || Object.keys(body).some(key => key !== 'products') || !Array.isArray(refs) || !refs.length || refs.length > 100
                || refs.some(ref => !ref || Object.keys(ref).some(key => !['spuId', 'sourceIdentity', 'productKey'].includes(key))
                    || typeof ref.spuId !== 'string' || !ref.spuId.trim() || ref.spuId.length > 255
                    || typeof ref.sourceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sourceIdentity)
                    || typeof ref.productKey !== 'string' || !/^[a-f0-9]{64}$/.test(ref.productKey))
                || new Set(refs.map(ref => ref.spuId)).size !== refs.length) {
                return send(res, 400, { error: 'product_status_invalid' });
            }
            return send(res, 200, await store.readProductStatuses(refs, await inventoryReadScope(req)));
        }
        // 详情沿用商品权限，实例编号只是定位而不是可绕过账户隔离的读取凭证。
        if (req.method === 'GET' && url.pathname === '/api/products/error-details') {
            if (!requireUserAccess(req, res)) return;
            const sourceStoreId = String(url.searchParams.get('sourceStoreId') || '');
            const scope = await inventoryReadScope(req);
            if (!sourceStoreId || (scope && !scope.has(sourceStoreId))) return send(res, 403, { error: 'store_not_claimed' });
            const result = await store.errorDetails({ sourceStoreId, spuId: String(url.searchParams.get('spuId') || ''),
                sourceInstanceId: String(url.searchParams.get('sourceInstanceId') || '') });
            return result ? send(res, 200, result) : send(res, 404, { error: 'error_notice_not_found' });
        }
        // 新禁传解除必须提交有效实例；旧解除接口只能清除历史展示标记。
        if (req.method === 'POST' && url.pathname === '/api/products/error-unblock') {
            if (!requireUserAccess(req, res)) return;
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: 'unblock_origin_denied' });
            let body;
            try { body = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8')); }
            catch (error) { if (error.status) throw error; return send(res, 400, { error: 'error_unblock_invalid' }); }
            const scope = await visibleStoreScope(req);
            if (!body?.sourceStoreId || (scope && !scope.has(body.sourceStoreId))) return send(res, 403, { error: 'store_not_claimed' });
            const owner = await ownership.findOwner(body.sourceStoreId);
            const result = await ownership.withStableOwners({ [body.sourceStoreId]: { ownerId: owner?.ownerId || '', claimId: owner?.claimId || '' } },
                connection => store.unblockErrorProducts(body, connection));
            liveEvents.notify();
            return send(res, 200, { ok: true, ...result });
        }
        // 认证仍由原入口隔离；旧插件请求只收到停用状态，不解析正文、不占写入许可，也不改历史红标或通知版本。
        if (req.method === "POST" && url.pathname === "/api/products/failure") {
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            return send(res, 410, { error: "product_failure_retired", message: "商品失败回执已停用" });
        }
        if (req.method === "POST" && url.pathname === "/api/agents/register") {
            writeIngestCors(req, res);
            // 本机工人从 127.0.0.1 代领；紫鸟内插件仍必须带直推令牌。
            // 插件侧接口：允许插件令牌、设备令牌与用户会话；插件令牌的权限仅限这些接口。
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "注册请求不是合法 JSON" }); }
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            send(res, 200, { ok: true, agent: await jobQueue.registerAgent(body || {}) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/claim") {
            writeIngestCors(req, res);
            // 插件侧接口：允许插件令牌、设备令牌与用户会话；插件令牌的权限仅限这些接口。
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "领取请求不是合法 JSON" }); }
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            if (body.relayProtocol !== 1) return send(res, 426, { error: "请安装10.10.69或更新插件" });
            const target = (await jobQueue.listAgents()).agents.find(a => a.storeId === body.storeId);
            // 旧HTTP接收只保留已支持的协议版本，不能借兼容入口绕过推送通道的能力门槛。
            if (!hasRelayPlugin(target) || target.canReceiveUploads !== true) return send(res, 426, { error: 'unsupported_plugin' });
            if (!target?.online || !target.identityMatched || target.pluginInstanceId !== body.pluginInstanceId
                || target.relaySessionId !== body.relaySessionId) return send(res, 409, { error: "接收页面已变化" });
            const abort = new AbortController(), cancel = () => abort.abort();
            req.once("aborted", cancel); res.once("close", cancel);
            try { send(res, 200, { ok: true, ...await relay.receive(body, abort.signal) }); }
            finally { req.off("aborted", cancel); res.off("close", cancel); }
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/batches/")) {
            if (!requireUserAccess(req, res)) return;
            const batch = await store.getBatch(url.pathname.split("/").pop());
            if (!batch) return notFound(res);
            if (!await resourceVisible(req, [batch.sourceStoreId])) return send(res, 403, { error: "store_not_claimed" });
            send(res, 200, batch);
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/products/")) {
            if (!requireUserAccess(req, res)) return;
            const product = await store.getProduct(decodeURIComponent(url.pathname.split("/").pop()), await inventoryReadScope(req), url.searchParams.get('sourceStoreId') || '');
            if (!product) return notFound(res);
            if (!await resourceVisible(req, product.product?.sourceStoreIds || [])) return send(res, 403, { error: "store_not_claimed" });
            // 旧索引没有归档标记，响应时补充真实状态；不改原包，也不将附件字节放进商品详情。
            send(res, 200, { ...product, product: { ...product.product,
                canDelete: canDeleteCatalogProduct(product.product, await visibleStoreScope(req)),
                ...(product.product.qualifications ? { qualifications: qualificationReferences(product.product.qualifications) } : {}),
                ...(product.product.qualificationCaptures ? { qualificationCaptures: qualificationReferences(product.product.qualificationCaptures) } : {}) } });
            return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/qualification-assets/')) {
            if (!isPluginScopedRequest(req) && !requireUserAccess(req, res)) return;
            const match = url.pathname.match(/^\/api\/qualification-assets\/(\d{6,20})\/([a-f0-9]{64})$/);
            const sourceStoreId = String(url.searchParams.get('sourceStoreId') || '').trim();
            // 不接受客户端 URL 或磁盘路径；来源店是必填消歧字段，不允许通过省略来源读取另一个库。
            if (!match || !sourceStoreId || sourceStoreId.length > 255
                || [...url.searchParams.keys()].some(key => !['sourceStoreId', 'library', 'accountType'].includes(key))) {
                return send(res, 400, { error: 'qualification_asset_request_invalid' });
            }
            const scope = await qualificationAssetScope(req, sourceStoreId);
            if (scope && !scope.has(sourceStoreId)) return send(res, 403, { error: 'store_not_claimed' });
            if (await deletedStores.isDeleted(sourceStoreId)) return notFound(res);
            const asset = await readQualificationAsset(store, { spuId: match[1], sha256: match[2], sourceStoreId, scope });
            if (!asset) return notFound(res);
            // 归属可在磁盘读取期间变化；发送字节前再次检查目标认领与来源读取范围。
            const currentScope = await qualificationAssetScope(req, sourceStoreId);
            if (currentScope && !currentScope.has(sourceStoreId)) return send(res, 403, { error: 'store_not_claimed' });
            return send(res, 200, asset.data, { 'content-type': asset.mimeType, 'content-length': String(asset.bytes),
                'content-disposition': `attachment; filename="qualification-${asset.sha256.slice(0, 16)}.bin"; filename*=UTF-8''${encodeURIComponent(Buffer.from(asset.name).toString('utf8'))}`,
                'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'" });
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
            if (!requireUserAccess(req, res)) return;
            const scope = await inventoryReadScope(req);
            if (scope) {
                const name = decodeURIComponent(url.pathname.split("/").pop());
                const related = await store.fileStoreIds(name);
                if (!related.length || related.some(id => !scope.has(id))) return send(res, 403, { error: "store_not_claimed" });
            }
            const file = await store.readStoredFile(decodeURIComponent(url.pathname.split("/").pop()));
            send(res, 200, file.json, {
                "content-disposition": `attachment; filename="${file.name}"`
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/import") {
            if (!requireUserAccess(req, res)) return;
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: "import_origin_denied" });
            // 手动导入与插件上传共用接收额度，不建立上架执行任务。
            const release = await acquireIngest(req, res);
            try {
            const buffer = await readBody(req, MAX_INGEST_BODY);
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
            /**
             * 网页手工上传必须指定来源店，否则会造出"没有归属的商品"：
             * 它进不了任何人的可见范围（各账号都看不到），却仍占着货号参与判重，
             * 表现为"明明没传过却提示重复"。这里从文件内容里取来源店，
             * 并校验它属于当前账号；管理员仍只能操作当前所选数据分类。
             */
            const declaredStoreId = String(files.map((file) => file.payload?.source?.sourceStoreId || file.payload?.sourceStoreId || "").find(Boolean) || "").trim();
            if (!declaredStoreId) {
                return send(res, 400, {
                    error: "import_source_store_required",
                    message: "上传文件里没有来源店铺信息。请从目标店铺用插件采集导出后再上传，避免商品没有归属、谁都看不到。"
                });
            }
            const scope = await visibleStoreScope(req);
            if (scope && !scope.has(declaredStoreId)) {
                return send(res, 403, {
                    error: "store_not_claimed",
                    message: `文件来源店铺（${declaredStoreId}）不属于当前账号，不能入库。请先在“店铺认领”里认领该店铺。`
                });
            }
            // 一个批次只接受同一来源；权限已验证后才能用目录补名，不能把第一份文件的名称套给另一店。
            const declaredIds = files.map(file => String(file.payload?.source?.sourceStoreId || file.payload?.sourceStoreId || '').trim()).filter(Boolean);
            if (declaredIds.some(id => id !== declaredStoreId)) return send(res, 400, { error: 'import_source_store_mismatch' });
            const declaredStoreName = sourceStoreDisplayName(declaredStoreId,
                files.flatMap(file => [file.payload?.source?.sourceStoreName, file.payload?.source?.shopName, file.payload?.source?.pageStoreName]),
                await ownership.listAssignments(), scope);
            const result = await store.importFiles(files, {
                source: "upload",
                sourceStoreId: declaredStoreId,
                sourceStoreName: declaredStoreName,
                shopName: declaredStoreName
            });
            send(res, 200, result);
            return;
            } finally { release(); }
        }
        if (req.method === "POST" && url.pathname === "/api/products/unblock") {
            if (!requireUserAccess(req, res)) return;
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: "unblock_origin_denied" });
            // 解除标红只接受明确的 SPU 数组：平台抖动造成的假失败不需要重新采集来源商品。
            const buffer = await readBody(req, 256 * 1024);
            let body;
            try {
                body = JSON.parse(stripBom(buffer.toString("utf8")));
            } catch {
                return send(res, 400, { error: "解除标红请求不是合法 JSON" });
            }
            // 只允许解除自己店铺的标红：否则任何登录用户都能解除别人的红标，绕过"标红禁止再传"。
            const result = await store.unblockProducts(body && body.spuIds, await visibleStoreScope(req));
            send(res, 200, { ok: true, ...result });
            return;
        }
        if (req.method === "DELETE" && url.pathname === "/api/products") {
            if (!requireUserAccess(req, res)) return;
            if (!isTrustedImportOrigin(req)) return send(res, 403, { error: "delete_origin_denied" });
            // 删除请求只有 SPU 数组，单独限制为 256 KiB，不能占用完整采集包的 256 MiB 内存额度。
            const buffer = await readBody(req, 256 * 1024);
            let body;
            try {
                body = JSON.parse(stripBom(buffer.toString("utf8")));
            } catch {
                return send(res, 400, { error: "删除请求不是合法 JSON" });
            }
            // 删除接口只接受明确的 SPU 数组，避免一个模糊条件误删整仓商品；
            // 同时按归属过滤：只能删自己店铺的商品，防止跨账号误删。
            /**
             * storeIds 限定删除作用的店铺范围。
             * 商品库按"来源店 + 货号"归并行，同一个 SPU 在别的店可能另有一行；
             * 管理站按店铺分组删除时必须带上该组的 storeId，否则会把其他店那份一起删掉。
             * 服务端会把它与调用方的权限范围求交，越权部分忽略。
             */
            const result = await store.deleteProducts(body && body.spuIds, await visibleStoreScope(req), {
                storeIds: Array.isArray(body?.storeIds) ? body.storeIds : null
            });
            send(res, 200, { ok: true, ...result });
            return;
        }
        const ingestRequestRoute = url.pathname.match(/^\/api\/ingest\/requests\/([a-zA-Z0-9-]{16,80})(\/cancel)?$/);
        if (ingestRequestRoute && ((req.method === 'GET' && !ingestRequestRoute[2]) || (req.method === 'POST' && ingestRequestRoute[2]))) {
            writeIngestCors(req, res);
            if (!isValidIngestToken(readBearerToken(req), auth.token) && !isPluginScopedRequest(req)) return send(res, 401, { error: 'ingest_unauthorized' });
            const owner = req.temuPluginInstanceId || String(req.headers['x-plugin-instance'] || '');
            if (!owner || !database) return send(res, 403, { error: 'ingest_instance_required' });
            // 查询/撤销走保留控制通道，不受新业务预算门控影响；身份只取认证实例。
            return send(res, 200, ingestRequestRoute[2]
                ? await ingestProtocol.cancel(owner, ingestRequestRoute[1])
                : await ingestProtocol.status(owner, ingestRequestRoute[1]));
        }
        if (req.method === 'POST' && url.pathname === '/api/ingest/prepare') {
            writeIngestCors(req, res);
            if (!isValidIngestToken(readBearerToken(req), auth.token) && !isPluginScopedRequest(req)) return send(res, 401, { error: 'ingest_unauthorized' });
            const body = JSON.parse((await readBody(req, 4096)).toString('utf8'));
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            if (scheduler.snapshot().paused) throw Object.assign(Error('ingest_capacity_wait'), { status: 429, retryAfter: 30 });
            const source = await jobQueue.resolveIngestSource(body);
            if (!source || source.sourceStoreId !== body.storeId) throw Object.assign(Error('ingest_source_mismatch'), { status: 403 });
            return send(res, 200, await ingestProtocol.prepare(req.temuPluginInstanceId || body.pluginInstanceId, body));
        }
        if (req.method === "POST" && url.pathname === "/api/ingest") {
            writeIngestCors(req, res);
            // 采集包上传走插件令牌或设备令牌：插件令牌由 /api/plugin/register 自动领取，
            // 云端模式下 auth.token 就是设备令牌，两者都必须放行，否则插件推送会全部 401。
            const ingestAuthorized = isValidIngestToken(readBearerToken(req), auth.token) || isPluginScopedRequest(req);
            if (!ingestAuthorized) {
                send(res, 401, { error: "ingest_unauthorized" });
                return;
            }
            // 上传额度只覆盖当前收包与入库，完成后释放，不等待任何目标店执行。
            const permitOwner = req.temuPluginInstanceId || String(req.headers['x-plugin-instance'] || '');
            const lease = req.headers['x-ingest-permit'] ? await ingestProtocol.consume(permitOwner, req.headers['x-ingest-permit'], Number(req.headers['content-length'])) : null;
            const release = lease ? lease.finish : await acquireIngest(req, res);
            try {
            req.setTimeout(120000, () => req.destroy());
            const buffer = await readBody(req, MAX_INGEST_BODY);
            let body;
            try {
                body = JSON.parse(stripBom(buffer.toString("utf8")));
            } catch {
                send(res, 400, { error: "不是合法 JSON" });
                return;
            }
            const upload = extractIngestUpload(body, req);
            // 外层元数据不能覆盖原包的来源；这里只守住绑定归属，不限定商品业务字段。
            if (upload.payload.source?.sourceStoreId && upload.sourceStoreId !== String(upload.payload.source.sourceStoreId).trim()) throw Object.assign(Error('ingest_source_mismatch'), { status: 403 });
            if (req.temuPluginInstanceId && upload.pluginInstanceId !== req.temuPluginInstanceId) throw Object.assign(Error('plugin_instance_mismatch'), { status: 403 });
            if (Array.isArray(upload.payload.products) && upload.payload.products.length > 1000) throw Object.assign(Error('单个采集包最多1000件商品，请拆分上传'), { status: 413 });
            // 新插件在发送前计算整包摘要；旧包保留导入兼容，但不能冒充已由来源端验证。
            const incomingVerified = verifyTransferManifest(upload.payload, body.kind ? null : body.transferIntegrity);
            const mapped = await jobQueue.resolveIngestSource({
                pluginInstanceId: upload.pluginInstanceId,
                pageStoreName: upload.pageStoreName,
                storeName: upload.sourceStoreName || upload.shopName,
                storeId: upload.sourceStoreId
            });
            // 插件令牌只代表已绑定实例，不能凭任意采集包写入另一个店铺的商品。
            if (req.temuPluginInstanceId && (!mapped || (upload.sourceStoreId && upload.sourceStoreId !== mapped.sourceStoreId))) throw Object.assign(Error('ingest_source_mismatch'), { status: 403 });
            // 许可绑定认证来源店，不能申请A店许可却写入B店商品。
            if (lease) {
                if ((upload.sourceStoreId || mapped?.sourceStoreId) !== lease.storeId || upload.pluginInstanceId !== lease.owner) throw Object.assign(Error('ingest_source_mismatch'), { status: 403 });
                await ingestProtocol.begin(lease, transferHash(upload.payload));
            }
            // 身份校验完成后才按确切来源 ID 补名称；归属读取在库存事务外，避免小连接池嵌套自等待。
            const sourceStoreId = upload.sourceStoreId || mapped?.sourceStoreId || '';
            const sourceStoreName = sourceStoreDisplayName(sourceStoreId,
                [upload.sourceStoreName, mapped?.sourceStoreName, upload.shopName, upload.pageStoreName],
                await ownership.listAssignments());
            const result = await store.importFiles([
                { originalName: upload.originalName, payload: upload.payload }
            ], {
                label: upload.label,
                shopName: upload.shopName || sourceStoreName,
                sourceStoreId,
                sourceStoreName,
                pluginInstanceId: upload.pluginInstanceId || (mapped && mapped.pluginInstanceId) || "",
                pageStoreName: upload.pageStoreName,
                source: "extension-ingest",
                ingestRequestId: lease?.id,
                ingestMaxProducts: 1000,
                confirmIngest: verifyIngestResult
            });
            async function verifyIngestResult(result) {
            const storedFile = result.batch?.files?.[0];
            const storedPacket = storedFile ? (await store.readStoredFile(storedFile.storedName)).json : null;
            if (storedFile?.contentSha256 && transferHash(storedPacket) !== storedFile.contentSha256) throw Object.assign(new Error("入库文件回读校验失败"), { status: 422 });
            // 新存储核对脱敏后完整原包；去重复用核对每件来源对象，不能用任意旧文件存在来证明本次入库。
            if (!result.reused && transferHash(storedPacket) !== transferHash(redactSensitive(upload.payload))) throw Object.assign(new Error("入库原包与接收内容不一致"), { status: 422 });
            if (incomingVerified && result.reused) {
                const incoming = parseImportedFiles([{ originalName: upload.originalName, payload: redactSensitive(upload.payload) }]);
                const sources = incoming.products.filter(product => product.publicationData?.sourceProduct);
                const saved = sources.map(product => result.batch.products.find(item => item.spuId === product.spuId));
                if (saved.some((product, index) => !product || transferHash(product.publicationData?.sourceProduct) !== transferHash(sources[index].publicationData.sourceProduct))) throw Object.assign(new Error("复用批次与本次来源商品不一致"), { status: 422 });
                if (saved.length) await store.verifyBatchTransfer(result.batch, saved);
                else if (transferHash({ ...storedPacket, exportedAt: null }) !== transferHash({ ...redactSensitive(upload.payload), exportedAt: null })) throw Object.assign(new Error("复用原包与本次采集内容不一致"), { status: 422 });
            }
            const receipt = {
                ok: true,
                transferIntegrity: { algorithm: TRANSFER_HASH_ALGORITHM, receivedSha256: transferHash(upload.payload), storedSha256: storedPacket ? transferHash(storedPacket) : null, verified: incomingVerified && Boolean(storedPacket) },
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
            };
            return receipt;
            }
            send(res, 200, result.ingestReceipt || await verifyIngestResult(result));
            return;
            } catch (error) {
                if (lease) await ingestProtocol.failed(lease).catch(() => {});
                throw error;
            } finally { req.setTimeout(0); await release(); }
        }
        await serveStatic(req, res, url);
    } catch (error) {
        /**
         * 未预期的异常必须留痕：此前只把消息回给浏览器，服务端日志一片空白，
         * 线上出现间歇性 500 时无从查起（只能靠 nginx 访问日志反推）。
         */
        if (!error || !error.status || error.status >= 500) {
            console.error(`[${new Date().toISOString()}] ${req.method} ${req.url} -> ${error && error.stack || error}`);
        }
        if (res.destroyed || res.writableEnded) return;
        if (error.retryAfter) res.setHeader("retry-after", String(error.retryAfter));
        send(res, error.status || 500, { error: error.message || "server_error", scheduling: schedulingError(error) });
    }
});

await store.ensure();
/** 长连接认证复用原令牌边界；凭证只在首帧传递，不进入 URL、访问日志或商品正文。 */
async function authenticateRelaySocket(req, message) {
    if (typeof message.token !== 'string' || !message.token || message.token.length > 1024) throw Error('authentication_required');
    const identity = message.identity;
    if (!identity || identity.storeId !== `temu:${identity.mallId}` || !/^\d{1,20}$/.test(String(identity.mallId))
        || typeof identity.relaySessionId !== 'string' || !/^[\w-]{8,100}$/.test(identity.relaySessionId)
        || identity.relayProtocol !== 1 || identity.executionMode !== 'plugin-api' || identity.identityMatched !== true
        || !/^https:\/\/agentseller\.temu\.com\/goods\/list(?:[?#]|$)/.test(String(identity.pageUrl || ''))
        || !/^[\w-]{8,100}$/.test(String(message.pluginInstanceId || ''))) throw Error('invalid_identity');
    // 每次重新核验都使用干净请求，不能保留上一次已认证标记而绕过撤销或过期检查。
    const request = { url: req.url, method: 'GET', socket: req.socket,
        headers: { ...req.headers, cookie: '', authorization: `Bearer ${message.token}`, 'x-plugin-instance': message.pluginInstanceId } };
    const response = { writeHead() {}, end() {}, setHeader() {} };
    if (cloudAuthEnabled) {
        if (!await cloudAuth.authenticate(request, response) || (!request.temuPluginToken && !request.temuDeviceBearer)) throw Error('authentication_failed');
    } else {
        if (!isValidIngestToken(message.token, auth.token)) throw Error('authentication_failed');
        request.temuAuthenticated = true; request.temuLocalMode = true;
    }
    if (!requirePluginInstance(request, response, message)
        || !await requirePluginStoreAccess(request, response, identity)
        || await deletedStores.isDeleted(identity.storeId)) throw Error('permission_changed');
    if (!hasRelayPlugin({ ...identity, pluginDetected: true })) throw Error('unsupported_plugin');
    return { auth: { req, message }, identity: { ...identity, pluginInstanceId: message.pluginInstanceId, pluginDetected: true } };
}

installWebsocketRelay(server, {
    relay, pathMatches: req => {
        try { const url = new URL(req.url, 'http://localhost'); return !url.search && stripRequestBasePath(req, url.pathname) === '/api/relay/socket'; }
        catch { return false; }
    },
    authenticate: authenticateRelaySocket,
    register: identity => jobQueue.registerAgent(identity),
    validate: async (verified, identity) => {
        await authenticateRelaySocket(verified.req, verified.message);
        const agent = (await jobQueue.listAgents()).agents.find(item => item.storeId === identity.storeId);
        if (!hasRelayPlugin(agent) || agent.canReceiveUploads !== true
            || agent.pluginInstanceId !== identity.pluginInstanceId || agent.relaySessionId !== identity.relaySessionId) throw Error('permission_changed');
    }
});

// 上架没有后台恢复或结果维护；服务启动只接收新的人工发送。
if (database) {
    // 只维护商品文件，不读取或恢复旧上架任务。
    let cleaning = false;
    const cleanup = async () => {
        if (cleaning) return;
        cleaning = true;
        try {
            await store.cleanupInventory?.(128);
        } catch (error) { console.error("维护清理失败", error.code || error.name); }
        finally { cleaning = false; }
    };
    const timer = setInterval(cleanup, 60 * 1000);
    timer.unref();
    await cleanup();
}
// 测试启动不要灌入 fixtures，否则会把示例商品写进临时仓库，干扰直推断言。
// 正式仓库禁止默认导入 fixtures，避免测试商品混进真实库存。只有明确设置 ZINIAO_SEED=1 才灌入。
const enableSeed = /^(1|true|yes)$/i.test(String(process.env.ZINIAO_SEED || ""));
if (enableSeed) await seedIfEmpty();
// 云端不扫描服务器其他项目的目录，也不尝试在服务器调用本机紫鸟CLI。
// 隔离测试由系统原子分配端口，经 IPC 回传，避免先探测空闲端口再绑定的抢占窗口。
server.listen(instanceId && process.env.ZINIAO_TEST_EPHEMERAL === "1" ? 0 : PORT, HOST, () => {
    if (instanceId && process.send) process.send({ type: "listening", port: server.address().port, instanceId });
    console.log(database ? "存储模式 MySQL：商品入库与一次性传输" : "存储模式 文件：保留兼容与离线调试");
    console.log(`中转仓 ${auth.origins[0] || `http://${HOST}:${PORT}`}`);
    for (const origin of auth.origins) console.log(`直推地址 ${origin}/api/ingest`);
    console.log("云端认证已启用，凭证不会写入运行日志");
    if (HOST === "127.0.0.1") console.log("紫鸟若访问不到本机，请用 ZINIAO_BIND=0.0.0.0 启动并填写局域网地址。");
});
