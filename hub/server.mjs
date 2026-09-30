/**
 * 店铺中转仓 API：入库、分发和反馈独立限额；MySQL 保存业务索引与任务，原始采集资料保留文件。
 * 商品快照只定向交给已核验的目标插件；平台创建与回查在店铺插件执行，服务器记录真实回执。
 * 未配置 MySQL 的离线调试仍兼容文件存储，不在运行失败时自动切换数据源。
 */
import http from "node:http";
import { createHash } from "node:crypto";
import { createLiveEvents } from "./lib/live-events.mjs";
import { createIngestAdmission } from "./lib/ingest-admission.mjs";
import { createSchedulingController, schedulingError } from './lib/scheduling.mjs';
import { createRuntimeResourceBudget, readCgroupSample, readDiskSample, assertBudgetReadyForService } from './lib/runtime-resource-budget.mjs';
import { createIngestProtocol } from './lib/ingest-protocol.mjs';
import { createAccountResolver } from './lib/account-resolver.mjs';
import { createCloudAuth } from "./cloud-auth.mjs";
import { createReadStream } from "node:fs";
import { stat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { fileURLToPath } from "node:url";
import { createStore } from "./lib/store.mjs";
import { parseImportedFiles, redactSensitive } from "./lib/parse-capture.mjs";
import { TRANSFER_HASH_ALGORITHM, transferHash, verifyTransferManifest } from "./lib/transfer-integrity.mjs";
import { openMysqlDatabase } from "./lib/mysql-database.mjs";
import { assertMysqlReady, assertAccountProcessMode, normalizeAccountProcessMode } from "./lib/mysql-schema.mjs";
import { createInboxWatcher } from "./lib/inbox-watcher.mjs";
import { createDownloadDirectoryDiscovery } from "./lib/ziniao-downloads.mjs";
import { createTransferManager } from "./lib/transfer-manager.mjs";
import { createJobQueue } from "./lib/job-queue.mjs";
import { createBulkDispatch } from "./lib/bulk-dispatch.mjs";
import { createAccountWorkRepository, DIRECTIONS } from "./lib/account-work-repository.mjs";
import { createAccountDispatcher } from "./lib/account-dispatcher.mjs";
import { createAccountRuntime } from "./lib/account-runtime.mjs";
import { createElasticAllocation, readElasticAllocationConfig } from './lib/elastic-allocation.mjs';
import { assertElasticWorkSlotsReady, assertElasticDisabledSafe } from './lib/elastic-work-slots.mjs';
import { createIngestStaging } from "./lib/ingest-staging.mjs";
import { createAccountPublishBridge } from "./lib/account-publish-bridge.mjs";
import { receiveAccountCapture } from './lib/stream-ingest.mjs';
import { createStagingBudget } from './lib/staging-budget.mjs';
import { createAccountIngest } from "./lib/account-ingest.mjs";
import { createStoreOwnership } from "./lib/store-ownership.mjs";
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
// 回调在请求阶段读取预算；字节与大包解析上限仍独立保留，不随人数放宽。
const ingestAdmission = createIngestAdmission(String(process.env.ZINIAO_ELASTIC_MODE || '').trim() === 'on'
    ? { limit: 64, capacity: () => elastic.snapshot().businessLimit } : {});

/** 排队请求断开立即撤销；许可覆盖读取、解析和持久化，不能读完整包后才限流。 */
async function acquireIngest(req, res) {
    const abort = new AbortController();
    const cancel = () => abort.abort();
    req.once("aborted", cancel);
    res.once("close", cancel);
    const cleanup = () => { req.off("aborted", cancel); res.off("close", cancel); };
    try {
        const length = req.headers["content-length"] === undefined ? MAX_INGEST_BODY : Number(req.headers["content-length"]);
        const release = await ingestAdmission.acquire(length, abort.signal);
        return () => { cleanup(); release(); };
    } catch (error) { cleanup(); throw error; }
}
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

/** 插件注册、领取和回传共用令牌绑定，阻止一个实例冒充另一个实例处理任务。 */
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

const inboxWatcher = createInboxWatcher({
    directories: watchDirectories,
    checkpointPath: path.join(dataRoot, "data", "inbox-checkpoint.json"),
    discoverDirectories: process.env.ZINIAO_WATCH_DIR ? null : createDownloadDirectoryDiscovery(),
    importFiles: (uploads, options) => {
        // 本地目录没有插件轮次和可信提交人，新模式下不能绕过账户队列直接写库存。
        if (ACCOUNT_PROCESS_MODE === 'on') throw Object.assign(Error('account_mode_requires_plugin_ingest'), { status: 409 });
        return store.importFiles(uploads, options);
    }
});
const transferManager = createTransferManager(dataRoot, store);
// 店铺归属表：商品、批次、任务、日志都按来源店记录，因此过滤只需对照这张表。
const ownership = createStoreOwnership(dataRoot, { database });
// 店铺删除名单：被管理员删除的店铺不再被插件心跳重新登记，避免"删了又回来"。
const deletedStores = createDeletedStores(dataRoot, { database });
// 归属表与删除名单要注入任务队列：心跳需要按名单拦截，恢复店铺需要写回归属。
//
// 降载分母必须用**本服务限额**（cgroup memory.max），不能用整机内存——
// 整机内存会让"本服务已接近自己的上限"被算成很小的比例，等于永不降载（方案 D4）。
// 这里缓存最近一次采样：采样是异步的，而 scheduling 的压力回调是同步的。
let serviceMemoryRatio = null, latestBudget = null, budgetSampledAt = 0;
// 弹性模式显式启用；业务槽迁移必须先离线完成，不能在服务启动时猜测旧任务归属。
const elasticMode = String(process.env.ZINIAO_ELASTIC_MODE || 'off').trim();
if (!['off', 'on'].includes(elasticMode)) throw Error('elastic_mode_invalid');
if (elasticMode === 'on' && (!database || String(process.env.ZINIAO_ACCOUNT_PROCESS_MODE).trim() !== 'on')) throw Error('elastic_requires_account_mode_on');
const elastic = elasticMode === 'on' ? createElasticAllocation({ config: readElasticAllocationConfig() }) : null;
if (!elastic && database) await assertElasticDisabledSafe(database);
let elasticSchemaReady = false, rawResourceSample = {}, samplingBudget = null, lastElasticState = '';
const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();
const resourceBudget = createRuntimeResourceBudget({ config: elastic ? { processLimit: elastic.config.processMax, publishLimit: elastic.config.publishMax } : {}, probe: async () => {
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
    if (elastic && elasticSchemaReady) {
        const [[usage]] = await database.query('control', `SELECT
            (SELECT COUNT(*) FROM hub_elastic_work_slots) AS business,
            (SELECT COUNT(*) FROM hub_process_leases WHERE state IN ('reserved','live')) AS processes`);
        const allocation = elastic.update({ ...rawResourceSample, ...result,
            ok: rawResourceSample.ok === true && Date.now() - rawResourceSample.measuredAt < 15000,
            activeBusiness: Number(usage.business), activeProcesses: Number(usage.processes) });
        const state = JSON.stringify({ business: allocation.businessLimit, account: allocation.perAccountLimit,
            process: allocation.processLimit, publish: allocation.publishLimit, reason: allocation.reason });
        if (state !== lastElasticState) { console.log(`[elastic-allocation] ${state}`); lastElasticState = state; }
        ingestAdmission.refreshCapacity();
    }
    latestBudget = result; budgetSampledAt = Date.now();
    serviceMemoryRatio = Number.isFinite(result.memoryRatio) ? result.memoryRatio : null;
    if (!result.canStartNewWork && result.reasonCode) {
        // 只记录原因，不改写任何已提交任务：预算只做准入。
        console.warn(`[resource-budget] ${result.mode} ${result.reasonCode} limit=${result.processLimit}`);
    }
    return result;
    })();
    try { return await samplingBudget; }
    catch (error) { elastic?.update({ ok: false }); throw error; }
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
// 账户解析：店铺 → 认领账号。上传准入、执行名额、分发调度都用它做账户维度判定，
// 带 30 秒缓存避免每次调度都读认领文件；查不到账号时退回按店铺处理。
const accountResolver = createAccountResolver({ listAssignments: () => ownership.listAssignments() });
const ingestProtocol = createIngestProtocol({ database, admission: ingestAdmission, elastic,
    // 调度身份取认领该店铺的网站账号：插件本身不带会话，店铺归属就是账号的可信来源。
    resolveAccount: async storeId => accountResolver.resolve(storeId),
    // 配额归当前可信认领账户；查询失败或未认领都不能退回插件实例获取另一份额度。
    reserveStorage: async (storeId, bytes) => {
        if (ACCOUNT_PROCESS_MODE !== 'on') return '';
        const [[row]] = await database.query('control', "SELECT body FROM hub_map_entries WHERE domain='ownership' AND entry_key=?", [storeId]);
        const assignment = typeof row?.body === 'string' ? JSON.parse(row.body) : row?.body;
        if (!assignment?.ownerId || !assignment.claimedAt) throw Object.assign(Error('source_store_ownership_unconfirmed'), { status: 403 });
        return { storageId: await stagingBudget.reserve(assignment.ownerId, bytes),
            accountContext: { accountId: assignment.ownerId, ownershipGeneration: assignment.claimedAt } };
    }, releaseStorage: id => stagingBudget.release(id) });

/**
 * 账户执行链接入。
 *
 * 三条边界（对应方案步骤2/4）：
 * - 只有 **on** 模式才启用；off 时全部为空，任何调用方都必须先判空，不能假设一定存在；
 * - 启动前用 `assertAccountProcessMode` 校验表与列齐全，缺表就拒绝启用而不是运行中报错；
 * - 预算读不到服务限额时拒绝启用（`budget_unknown`），不按整机内存放开。
 */
const ACCOUNT_MODE_RAW = String(process.env.ZINIAO_ACCOUNT_PROCESS_MODE || 'off').trim();
const ACCOUNT_MODE = normalizeAccountProcessMode(ACCOUNT_MODE_RAW);
// 模式失真保护：非法取值直接拒绝启动，不猜运维意图。
if (ACCOUNT_MODE.invalid) {
    throw new Error(`账户进程模式取值非法：${ACCOUNT_MODE.raw}（只接受 off/shadow/on）`);
}
const ACCOUNT_PROCESS_MODE = ACCOUNT_MODE.mode;
/** 账户运行时就绪状态：新业务门控读它，而不是各自判断对象是否为空。 */
const accountRuntime = { mode: ACCOUNT_PROCESS_MODE, ready: false, reason: '' };
let accountWorkRepo = null;
let accountDispatcher = null;
let accountRuntimeHandle = null;
// 暂存：接收段与业务入库段分开；off 模式不使用它。
const ingestStaging = createIngestStaging({ dataRoot, maxBytes: MAX_INGEST_BODY });
const stagingBudget = database && ACCOUNT_PROCESS_MODE === 'on' ? createStagingBudget({ database, stagingDir: ingestStaging.stagingDir }) : null;
const accountIngest = database ? createAccountIngest({ database, staging: ingestStaging, store, stagingBudget }) : null;
// 上传和上架共享预算；弹性模式逐店工作保留占用，准备进程完成后可交给下一店。
const accountPublish = database && ACCOUNT_PROCESS_MODE === 'on'
    ? createAccountPublishBridge({ database, staging: ingestStaging, stagingBudget, elastic, maxUnsettledPublishes: elastic?.config.publishMax || 2,
        canStart: () => Date.now() - budgetSampledAt < 15000 && latestBudget?.canAuthorizeBusiness === true }) : null;
const jobQueue = createJobQueue(dataRoot, store, { ownership, deletedStores, database, scheduler, accountResolver,
    accountExecution: accountPublish });
/**
 * 唤醒运行器：入队后立即推进，不让新任务白等一个扫描周期。
 * 定义在模块作用域，避免在声明之前被调用（TDZ）。
 * 唤醒失败不影响受理结果——扫描循环下一轮仍会取到它。
 */
function wakeRuntime() { void accountRuntimeHandle?.wake().catch(() => {}); }
if (database && ACCOUNT_PROCESS_MODE !== 'off') {
    try {
        const modeCheck = await assertAccountProcessMode(database, ACCOUNT_PROCESS_MODE);
        if (elastic) { await assertElasticWorkSlotsReady(database); elasticSchemaReady = true; }
        // 预算就绪：Linux 上读 cgroup；读不到时**不按整机内存放开**，
        // 只接受运维显式声明的服务预算（ZINIAO_SERVICE_MEMORY_BYTES）。
        // 显式声明是必要条件——否则本地/容器外环境会安静地用一个假的分母。
        const declaredMemory = Number(process.env.ZINIAO_SERVICE_MEMORY_BYTES || 0);
        const budgetCheck = assertBudgetReadyForService({
            mode: ACCOUNT_PROCESS_MODE,
            sample: await readCgroupSample(),
            explicitBudget: declaredMemory > 0 ? { memoryMaxBytes: declaredMemory } : null
        });
        accountWorkRepo = createAccountWorkRepository(database, { elastic });
        // dispatcher 在两种模式都要有：shadow 用它只做候选计算与观测，不写可执行队列。
        accountDispatcher = createAccountDispatcher({ database, elastic });
        /**
         * 只在 on 创建运行器：shadow 不 fork、不签发许可。
         *
         * 运行器是**唯一**的账户执行入口——它负责发现候选、精确领取、启动进程与结算回执。
         * 之前只创建了仓库/分发器/监督器三个对象却没有执行循环，
         * 任务因此永远停在 queued（部署审核的 P1）。
         */
        accountRuntimeHandle = ACCOUNT_PROCESS_MODE === 'on'
            ? createAccountRuntime({
                database, mode: ACCOUNT_PROCESS_MODE, elastic,
                // 0.6核灰度先只开一个准备进程；两个插件可在外部平台并行，计算进程不必跟着常驻。
                maxAccountProcesses: elastic?.config.processMax || 1,
                workerPath: path.join(rootDir, 'workers', 'account-worker.mjs'),
                // 源根显式传入：worker 只接受相对引用，绝对路径由它独立拦截。
                sourceRoot: String(process.env.ZINIAO_WORKER_SOURCE_ROOT || dataRoot),
                canStart: () => Date.now() - budgetSampledAt < 15000 && latestBudget?.canStartNewWork === true,
                onTrace: (type, fields) => {
                    // 只在排障关心的阶段打日志，不刷屏。
                    // 带上被拒绝的回执：否则"任务停在 running/failed"无法定位原因。
                    if (/settle|start|claim-miss|stop|reply-rejected|spawn-miss/.test(type)) {
                        console.log(`[account-runtime] ${type} ${JSON.stringify(fields)}`);
                    }
                },
                /**
                 * 执行成功后提交业务结果。
                 *
                 * 业务行**只在**这里写入：暂存阶段不产生任何商品记录，
                 * 因此"工作没执行完"与"商品已入库"不会同时成立。
                 */
                validateWork: (connection, work) => work.direction === 'publish'
                    ? accountPublish.validateWork(connection, work) : accountIngest.validateWork(connection, work),
                onFailure: args => args.work.direction === 'publish' ? accountPublish.onFailure(args) : accountIngest.failed(args),
                onCommit: args => accountIngest.commit(args),
                onPrepared: args => accountPublish.onPrepared(args)
            })
            : null;
        accountRuntime.ready = true;
        console.log(`账户执行链已启用 mode=${ACCOUNT_PROCESS_MODE} tables=${modeCheck.checked ? 'ok' : 'off'} budget=${budgetCheck.source || 'n/a'}`);
    } catch (error) {
        // 初始化失败：**不**清空对象继续走旧路径收单。
        // 保留失败原因，由门控对新业务返回 503；历史回执/停止入口不受影响。
        accountRuntime.ready = false;
        accountRuntime.reason = String(error.code || error.message || error);
        accountWorkRepo = null; accountDispatcher = null; accountRuntimeHandle = null;
        console.error(`账户执行链启用失败：${accountRuntime.reason}`);
    }
}

/**
 * 新业务准入门控：受理上传、创建任务、签发平台许可前都必须先过这里。
 *
 * 为什么不能"失败就继续":on 已配置却初始化失败时，旧路径仍在监听，
 * 会让新工作悄悄绕过账户门控执行。宁可明确 503 让客户端按 Retry-After 等待。
 * 历史回执与停止入口**不**走这里——它们的鉴权独立，且不该被新业务的门控拖住。
 */
function assertNewBusinessAllowed() {
    if (ACCOUNT_PROCESS_MODE === 'off') return;
    if (accountRuntime.ready) return;
    throw Object.assign(new Error('account_runtime_unavailable'), {
        status: 503, retryAfter: 5, code: 'account_runtime_unavailable',
        detail: accountRuntime.reason
    });
}
/** shadow 模式只观测：不写可执行工作、不 fork、不签新许可。 */
const accountShadowOnly = () => ACCOUNT_PROCESS_MODE === 'shadow';

/**
 * 取某店铺的**所有权代次**（用认领时间表示）。
 *
 * 为什么需要代次：认领关系变化（换人、解除后重认领）必须让旧授权失效。
 * 只比较 storeId 无法发现"店铺还是那家、主人换了"。
 * 取不到时返回空字符串——留空表示"无代次证据"，不编造值。
 */
async function ownershipGenerationOf(storeId) {
    const store = String(storeId || '').trim();
    if (!store) return '';
    try {
        const assignments = await ownership.listAssignments();
        return String(assignments?.[store]?.claimedAt || '');
    } catch {
        // 查不到不是致命错误：代次留空会被后续授权复核视为"缺证据"。
        return '';
    }
}

/**
 * 把一次成功入库的商品登记到账户工作账本。
 *
 * 只有**已认领**的店铺才登记：归属不明的来源店在账本里没有可信账户，
 * 硬塞一个猜测值会让公平份额算到错误的账户上。返回统计供调用方如实上报。
 */
async function enqueueAccountWorkForIngest({ sourceStoreId, products, requestId, batchId,
    actorId = '', ownershipGeneration = '', sourceRef = '', sourceHash = '', sourceHashAlgorithm = 'sha256', expectedBytes = 0 }) {
    if (!accountWorkRepo) return { enabled: false, enqueued: 0 };
    // shadow 只观测：可以算出"本来会登记什么"，但不写可执行队列，
    // 否则影子数据会被未来的运行器当成真任务执行。
    if (accountShadowOnly()) {
        return { enabled: true, enqueued: 0, shadow: true, reason: 'shadow_mode_observes_only' };
    }
    // 用严格解析区分两种情况：未认领（进待确认）与查询故障（503 让客户端重试）。
    // 用宽松的 resolve() 会把数据库抖动当成"这店没人认领"，商品静默丢进待确认。
    const ownership = await accountResolver.classify(sourceStoreId);
    if (ownership.status === 'unavailable') {
        throw Object.assign(new Error('ownership_lookup_failed'), {
            status: 503, retryAfter: 5, code: 'ownership_lookup_failed', detail: ownership.reason
        });
    }
    if (ownership.status !== 'owned') return { enabled: true, enqueued: 0, reason: 'source_store_unclaimed' };
    const accountId = ownership.accountId;
    if (!products.length) return { enabled: true, enqueued: 0, reason: 'no_products' };
    /**
     * 缺来源证据的工作**不得登记为可执行**。
     *
     * 没有 sourceRef/sourceHash 就无法证明 worker 该读哪份文件、读到的内容对不对。
     * 把它登记成 queued，等于制造一条"缺证据却可执行"的工作——
     * 第三次复核明确指出这是不允许的（升级前批次曾可能落到这里）。
     * 不登记并给出原因，由调用方/运维处理，而不是让它看起来可跑。
     */
    if (!sourceRef || !sourceHash) {
        return { enabled: true, enqueued: 0, reason: 'missing_source_evidence',
            detail: '缺少源文件引用或摘要，拒绝登记为可执行工作' };
    }
    let enqueued = 0, skipped = 0, lastError = '', firstWorkId = '';
    for (const product of products || []) {
        const spuId = String(product?.spuId || '').trim();
        if (!spuId) { skipped += 1; continue; }
        try {
            const row = await accountWorkRepo.enqueue({
                accountId, storeId: sourceStoreId, direction: DIRECTIONS.ingest,
                jobId: batchId || '', spuId,
                // 幂等键按"请求 + 批次 + 商品"绑定：同一批重传不会产生第二件工作。
                requestId: `${requestId || ''}:${batchId || ''}`,
                // 持久上下文必须在这里填全：撤销、授权复核与"来源版本"都要靠它，
                // 留空会让后续无法判断这件工作属于哪个轮次/哪次认领。
                runId: '', actorId, ownershipGeneration,
                sourceRef, sourceHash, sourceHashAlgorithm, expectedBytes
            });
            if (!firstWorkId && row?.work_id) firstWorkId = row.work_id;
            enqueued += 1;
        } catch (error) {
            // 单件冲突/失败不阻断其他商品；数量如实返回，不谎报全部成功。
            // 保留最后一条错误原因：只报 skipped 数量会让排障无从下手。
            skipped += 1; lastError = `${error.code || ''} ${error.message || error}`.trim();
        }
    }
    // workId 必须随回执返回：客户端与验收都要用它把"受理"与"执行"绑成同一条因果链。
    return { enabled: true, enqueued, skipped, accountId,
        ...(firstWorkId ? { workId: firstWorkId } : {}), ...(lastError ? { lastError } : {}) };
}
/** 后台续跑不沿用过期会话的权限；每个分片重新校验账户启用状态和店铺归属。 */
const bulkDispatch = createBulkDispatch({ database, store, queue: jobQueue, authorize: async (owner, ids) => {
    if (!owner) return null;
    const user = await cloudAuth.users.findById(owner);
    if (!user || user.disabled) throw Object.assign(Error("批量任务账户不存在或已停用"), { status: 403 });
    if (user.role === 'admin') return null;
    const scope = await ownership.ownedStoreIds(owner);
    if (ids.some(id => !scope.has(id))) throw Object.assign(Error("批量任务来源店或目标店已不属于当前账户"), { status: 403 });
    return { userId: owner };
} });

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
    return `${user.id}:${user.role}`;
}

/** 库存只在文件版本变化时重建一次，随后复用每个可见店铺范围的摘要。 */
async function liveSnapshot(req) {
    const scope = await visibleStoreScope(req);
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
    const live = await jobQueue.liveSignature(scope);
    return {
        inventory,
        claims: liveDigest(owned),
        agents: liveDigest(live.agents),
        jobs: liveDigest(live.jobs),
        bulk: bulkDispatch ? await bulkDispatch.version(req.temuUser?.id || '') : '',
        logs: liveDigest(live.logs),
        // 店铺认领页本就允许查看全部店铺目录；其变更独立通知，不触发个人商品列表更新。
        directory: liveDigest([live.directory, Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b))])
    };
}

const liveEvents = createLiveEvents({ rootDir: dataRoot, snapshot: liveSnapshot, authorize: authorizeLiveRequest });
// 数据库事务提交后唤醒 SSE；心跳若没有可见状态变化，摘要相同就不会让页面刷新。
database?.subscribe(() => liveEvents.notify());


/**
 * 按当前身份取"可见店铺集合"。管理员与本机模式看全部，普通用户只看自己认领的店铺。
 * 返回 null 表示"不过滤"，避免为每个接口都构造一份全集。
 */
async function visibleStoreScope(req) {
    if (req.temuLocalMode === true || req.temuDeviceBearer === true || req.temuIsAdmin === true) return null;
    if (!req.temuUser) return null;
    return await ownership.ownedStoreIds(req.temuUser.id);
}

/** 商品行是否属于可见范围：来源店命中任一可见店铺即可见。 */
function productInScope(product, scope) {
    if (!scope) return true;
    const stores = Array.isArray(product?.sourceStoreIds) ? product.sourceStoreIds : [];
    return stores.some((storeId) => scope.has(String(storeId)));
}

/**
 * 按可见范围裁剪仓库总览。只过滤来源数据；目标店相关统计不在本函数处理。
 * 未归属店铺（尚未被任何人认领）对普通用户不可见，避免看到或误传别人的商品。
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
        fileCount: batches.reduce((sum, batch) => sum + (batch.files || []).length, 0),
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

/** 资源详情必须按实际归属校验；ID 可猜测，登录并不代表拥有全仓权限。 */
async function resourceVisible(req, stores) {
    const scope = await visibleStoreScope(req);
    return !scope || (stores.length > 0 && stores.every(id => scope.has(String(id || ""))));
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
    const sourceStores = [...new Map((overview.batches || [])
        .filter((batch) => batch.sourceStoreId)
        .map((batch) => [String(batch.sourceStoreId), String(batch.sourceStoreName || batch.shopName || batch.sourceStoreId)])
    ).entries()].map(([storeId, storeName]) => ({ storeId, storeName }));
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
        if(req.method==="OPTIONS" && /^\/api\/(ingest(?:\/prepare|\/requests\/[a-zA-Z0-9-]{16,80}(?:\/cancel)?)?|agents\/register|jobs\/(claim|report|target-task-states|direct-progress|execution-run))$/.test(stripRequestBasePath(req, String(req.url).split('?')[0]))) {
            writeIngestCors(req,res);res.writeHead(204);res.end();return;
        }
        if (cloudAuthEnabled) {
            if (!await cloudAuth.authenticate(req,res)) return;
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
        if (req.method === "OPTIONS" && (url.pathname === "/api/agents/register" || url.pathname === "/api/jobs/claim" || url.pathname === "/api/jobs/report" || url.pathname === "/api/jobs/target-task-states" || url.pathname === "/api/jobs/direct-progress" || url.pathname === "/api/jobs/execution-run")) {
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
                accountExecutionProtocol: ACCOUNT_PROCESS_MODE === 'on' ? 1 : 0
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
            send(res, 200, { users: await cloudAuth.users.listUsers(), ...registration });
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
            if (store.listOverviewPage) {
                send(res, 200, await store.listOverviewPage(await visibleStoreScope(req), url));
                return;
            }
            // 普通用户只看到自己认领店铺的商品与批次；管理员和本机模式看全部。
            const overview = scopeOverview(await store.listOverview(), await visibleStoreScope(req));
            send(res, 200, paginateOverview(overview, url));
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
            const maskPhone = cloudAuth.users.maskPhone || ((value) => value);
            const stores = [...byStore.values()].map((store) => {
                const owner = assignments[store.storeId] || null;
                return {
                    ...store,
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
            send(res, 200, { stores: await jobQueue.listDeletedStores() });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/inbox/status") {
            if (!requireUserAccess(req, res)) return;
            send(res, 200, inboxWatcher.snapshot());
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/inbox/scan") {
            if (!requireUserAccess(req, res)) return;
            send(res, 200, await inboxWatcher.scan());
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/ziniao/stores") {
            if (!requireUserAccess(req, res)) return;
            const scope = await visibleStoreScope(req);
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
        if (req.method === "GET" && url.pathname === "/api/transfer-jobs") {
            if (!requireUserAccess(req, res)) return;
            send(res, 200, { jobs: [], disabled: true, note: "旧探测链路已停用，请使用任务台 /api/jobs。" });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/jobs") {
            if (!requireUserAccess(req, res)) return;
            const scope = await visibleStoreScope(req);
            // 带分页参数时只返回当前页；旧调用不带参数时保留完整列表兼容现有客户端。
            if (url.searchParams.has("limit") || url.searchParams.has("offset")) {
                send(res, 200, await jobQueue.listJobsPage({
                    scope,
                    limit: Number(url.searchParams.get("limit")) || 50,
                    offset: Number(url.searchParams.get("offset")) || 0,
                    includeAgents: url.searchParams.get("includeAgents") !== "0"
                }));
                return;
            }
            const jobs = await jobQueue.listJobs();
            if (!scope) { send(res, 200, jobs); return; }
            // 普通用户只看与自己店铺相关的任务；agents 里也只保留自己店铺的心跳。
            const related = (job) => scope.has(String(job.sourceStoreId || "")) || scope.has(String(job.targetStoreId || ""));
            send(res, 200, {
                ...jobs,
                jobs: (jobs.jobs || []).filter(related),
                agents: (jobs.agents || []).filter((agent) => scope.has(String(agent.storeId || "")))
            });
            return;
        }
        // 轻量插件目录：商品库和工作日志只需要它，不再为了在线状态下载完整任务记录。
        if (req.method === "GET" && url.pathname === "/api/agents") {
            if (!requireUserAccess(req, res)) return;
            send(res, 200, await jobQueue.listAgents({
                scope: await visibleStoreScope(req),
                query: String(url.searchParams.get("q") || "").trim(),
                online: url.searchParams.has("online") ? url.searchParams.get("online") === "1" : null,
                receivable: url.searchParams.has("receivable") ? url.searchParams.get("receivable") === "1" : null,
                limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null,
                offset: url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : null
            }));
            return;
        }
        // 首页经营汇总在服务端计算，浏览器只接收聚合数字和排行，不再下载全部任务明细。
        if (req.method === "GET" && url.pathname === "/api/jobs/dashboard") {
            if (!requireUserAccess(req, res)) return;
            send(res, 200, await jobQueue.listDashboard({ scope: await visibleStoreScope(req) }));
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
        // 工作日志只回放任务状态变更，不返回商品快照，供运营确认是否真正送达目标插件。
        if (req.method === "GET" && url.pathname === "/api/work-log") {
            if (!requireUserAccess(req, res)) return;
            const scope = await visibleStoreScope(req);
            // SQL 必须先按账号范围过滤再分页；默认值和分页上限由仓库统一处理。
            const activity = await jobQueue.listActivity({
                scope,
                limit: url.searchParams.get("limit"),
                offset: url.searchParams.get("offset")
            });
            if (!scope) { send(res, 200, activity); return; }
            // 普通用户只看自己店铺的日志：来源店或目标店命中即可见。
            const entries = (activity.entries || []).filter((entry) => scope.has(String(entry.sourceStoreId || "")) || scope.has(String(entry.storeId || "")));
            const stores = (activity.stores || []).filter((store) => scope.has(String(store.storeId || "")));
            send(res, 200, { ...activity, entries, stores });
            return;
        }
        if (req.method === "DELETE" && url.pathname === "/api/work-log") {
            if (!requireUserAccess(req, res)) return;
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "删除工作日志请求不是合法 JSON" }); }
            send(res, 200, { ok: true, ...(await jobQueue.clearStoreActivity((body || {}).storeId, taskAccess(req))) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/jobs/open-requests") {
            if (!requireUserAccess(req, res)) return;
            const scope = await visibleStoreScope(req);
            const result = await jobQueue.listOpenRequests();
            if (!scope) { send(res, 200, result); return; }
            // 待打开列表按目标店过滤：否则本机工人会去打开别人店铺的页面。
            send(res, 200, {
                ...result,
                requests: (result.requests || []).filter((request) => scope.has(String(request.targetStoreId || "")) || scope.has(String(request.sourceStoreId || "")))
            });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/open-result") {
            if (!requireUserAccess(req, res)) return;
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "打开回传不是合法 JSON" }); }
            send(res, 200, { ok: true, job: await jobQueue.reportOpenResult(body || {}, taskAccess(req)) });
            return;
        }
        if (req.method === "GET" && url.pathname === "/api/direct-create-capability") {
            if (!requireUserAccess(req, res)) return;
            return send(res, 200, {directCreate:true, minimumPluginVersion:"10.10.56", complianceVersion:"V2.0", bulkDispatch: Boolean(bulkDispatch), executionConcurrency: scheduler.snapshot().limit, scheduling: scheduler.snapshot()});
        }
        if (url.pathname === '/api/bulk-dispatch' || /^\/api\/bulk-dispatch\/[a-f0-9]{64}(?:\/(?:resume|cancel|failures))?$/.test(url.pathname)) {
            if (!requireUserAccess(req, res)) return;
            if (!bulkDispatch) return send(res, 503, { error: '批量分发需要 MySQL 存储' });
            const owner = req.temuUser?.id || '';
            const [, , , id, action] = url.pathname.split('/');
            // 明细分页只读，并在仓储层再次检查批次归属，不能跨账号查看商品错误。
            if (req.method === 'GET' && action === 'failures') return send(res, 200, await bulkDispatch.failures(id, owner, url.searchParams.get('offset')));
            if (req.method === 'GET') return send(res, 200, id ? { batch: await bulkDispatch.get(id, owner) } : await bulkDispatch.list(owner, url.searchParams.get('offset')));
            if (req.method === 'POST' && id && action) {
                // resume 会让批次重新进入可分发状态，属于新业务；cancel 是收尾动作，
                // 必须在新模式未就绪时**仍然可用**（否则积压批次无法停止）。
                if (action === 'resume') assertNewBusinessAllowed();
                return send(res, 200, { batch: await bulkDispatch.control(id, action, owner) });
            }
            if (req.method === 'POST' && !id) {
                // 创建批量任务属于新业务：门控必须在读取大正文之前。
                assertNewBusinessAllowed();
                const input = JSON.parse(stripBom((await readBody(req, 2 * 1024 * 1024)).toString('utf8')));
                return send(res, 202, { batch: await bulkDispatch.submit(input, owner) });
            }
            return send(res, 405, { error: '不支持的批量操作' });
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/direct-progress") {
            // 允许目标插件申请创建许可与回传；队列继续校验目标店、领取凭证及创建尝试，不代理平台请求。
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const body = JSON.parse(stripBom((await readBody(req, 64 * 1024)).toString("utf8")));
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            /**
             * 只对 `phase=begin`（申请新的平台创建许可）过门控。
             *
             * 这个接口同时承担"开始授权"与"结果回传"两种职责：
             * 一律封锁会让**已在平台提交的结果无法回传**，那是更严重的数据损失。
             * 因此按阶段区分：新的执行授权要过门控，既有事实的回执不受影响。
             */
            /**
             * 阶段必须**先归一化**再判定，且只归一化一次、供门控与业务共用。
             *
             * 复核实测：门控只认严格等于 'begin'，而业务层用 `asText(input.phase)`
             * （会 trim），于是 `" begin "` 能跳过门控、径直进入后续身份校验（返回 409 而非 503）。
             * 带空格的值会被业务层当成 begin 处理，门控却放行了它——两边规则必须一致。
             * 这里用与业务层相同的 trim 语义判定，并在归一化后写回 body，
             * 避免下游再各自解释一遍。
             */
            const normalizedPhase = String(body?.phase ?? '').trim();
            if (body && typeof body === 'object') body.phase = normalizedPhase;
            if (normalizedPhase === 'begin') assertNewBusinessAllowed();
            return send(res, 200, {ok:true, ...await jobQueue.directProgress(body)});
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/direct-retry") {
            // 仅网页人工确认入口可重置结果未知项；插件不能自行把 unknown 解锁成新尝试。
            if (!requireUserAccess(req, res)) return;
            const body = JSON.parse(stripBom((await readBody(req, 64 * 1024)).toString("utf8")));
            return send(res, 200, { ok: true, ...await jobQueue.directRetry(body || {}, taskAccess(req)) });
        }
        /**
         * 插件面板的"取消任务"：只取消本店未提交的待传项，已提交的保留结果证据。
         * 与"停止并清理"的区别：停止终止轮次，取消是主动丢弃还没提交的任务。
         */
        if (req.method === "POST" && url.pathname === "/api/jobs/cancel-store-tasks") {
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const body = JSON.parse(stripBom((await readBody(req, 64 * 1024)).toString("utf8")));
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            return send(res, 200, { ok: true, ...await jobQueue.cancelStoreTasks(body || {}) });
        }
        if (req.method === "POST" && url.pathname === "/api/jobs") {
            if (!requireUserAccess(req, res)) return;
            // 创建任务属于新业务：先过门控，再读正文与创建任何持久行。
            assertNewBusinessAllowed();
            const buffer = await readBody(req, 512 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "创建任务请求不是合法 JSON" }); }
            /**
             * 业务硬约束：只能在自己名下的店铺之间中转。
             * 来源店与目标店都必须已被当前用户认领，否则拒绝——这既防止把别人的商品传出去，
             * 也防止把商品传进别人的店铺。管理员与设备令牌不受此限，便于运维排障。
             */
            const scope = await visibleStoreScope(req);
            if (scope) {
                const sourceStoreId = String(body?.sourceStoreId || "").trim();
                const targetStoreId = String(body?.targetStoreId || "").trim();
                const outside = [sourceStoreId, targetStoreId].filter((storeId) => storeId && !scope.has(storeId));
                if (outside.length) {
                    return send(res, 403, {
                        error: "store_not_claimed",
                        message: `只能在自己认领的店铺之间上传；以下店铺不属于当前账号：${outside.join("、")}。请先在“我的店铺”认领。`
                    });
                }
            }
            if (ACCOUNT_PROCESS_MODE === 'on' && body?.directCreate !== true) return send(res, 409, {
                error: 'account_mode_requires_direct_job', message: '账户执行模式只接受明确确认的一键上架任务。'
            });
            // 管理员代操作保持其真实身份，但执行配额始终归目标店所属账户，不接受正文指定身份。
            const access = taskAccess(req) || { actorId: req.temuUser?.id || (req.temuDeviceBearer ? 'authenticated-device' : 'local-service'), privileged: true };
            const job = await jobQueue.createJob(body || {}, access);
            send(res, 201, { ok: true, job });
            return;
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
        // 页面轮次只允许当前插件实例管理；沿用店铺授权边界，不暴露任意任务取消接口。
        if (req.method === "POST" && url.pathname === "/api/jobs/execution-run") {
            writeIngestCors(req, res);
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "轮次请求不是合法 JSON" }); }
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            return send(res, 200, { ok: true, ...(await jobQueue.controlExecutionRun(body)) });
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/claim") {
            writeIngestCors(req, res);
            // 插件侧接口：允许插件令牌、设备令牌与用户会话；插件令牌的权限仅限这些接口。
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            // 领取意味着签发新的执行许可：属于新业务，先过门控。
            // 注意：**停止与历史回执不走这里**，它们必须在新模式未就绪时仍可用。
            assertNewBusinessAllowed();
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "领取请求不是合法 JSON" }); }
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            send(res, 200, { ok: true, ...(await jobQueue.claimJobs(body || {})) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/report") {
            writeIngestCors(req, res);
            // 插件侧接口：允许插件令牌、设备令牌与用户会话；插件令牌的权限仅限这些接口。
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "回传请求不是合法 JSON" }); }
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            send(res, 200, { ok: true, job: await jobQueue.reportProgress(body || {}) });
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/jobs/target-task-states") {
            writeIngestCors(req, res);
            // 插件侧接口：允许插件令牌、设备令牌与用户会话；插件令牌的权限仅限这些接口。
            if (!canAccessWarehouseApi(req) && !isPluginScopedRequest(req)) return send(res, 401, { error: "ingest_unauthorized" });
            const buffer = await readBody(req, 64 * 1024);
            let body;
            try { body = JSON.parse(stripBom(buffer.toString("utf8"))); } catch { return send(res, 400, { error: "任务状态查询不是合法 JSON" }); }
            if (!requirePluginInstance(req, res, body)) return;
            if (!await requirePluginStoreAccess(req, res, body)) return;
            send(res, 200, { ok: true, ...(await jobQueue.listTargetTaskStates(body || {})) });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/jobs\/[^/]+\/cancel$/)) {
            if (!requireUserAccess(req, res)) return;
            const id = url.pathname.split("/")[3];
            send(res, 200, { ok: true, job: await jobQueue.cancelJob(id, taskAccess(req)) });
            return;
        }
        if (req.method === "GET" && url.pathname.match(/^\/api\/jobs\/[^/]+$/)) {
            if (!requireUserAccess(req, res)) return;
            const job = await jobQueue.getJob(url.pathname.split("/").pop());
            if (!job) return notFound(res);
            if (!await resourceVisible(req, [job.sourceStoreId, job.targetStoreId])) return send(res, 403, { error: "store_not_claimed" });
            send(res, 200, job);
            return;
        }
        if (req.method === "POST" && url.pathname === "/api/transfer-jobs") {
            if (!requireUserAccess(req, res)) return;
            send(res, 409, { error: "旧探测链路已停用，请使用任务台创建指定店铺任务。" });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/cancel$/)) {
            if (!requireUserAccess(req, res)) return;
            send(res, 409, { error: "旧探测链路已停用" });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/confirm$/)) {
            if (!requireUserAccess(req, res)) return;
            send(res, 409, { error: "旧探测链路已停用" });
            return;
        }
        if (req.method === "POST" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/retry$/)) {
            if (!requireUserAccess(req, res)) return;
            send(res, 409, { error: "旧探测链路已停用" });
            return;
        }
        if (req.method === "GET" && url.pathname.match(/^\/api\/transfer-jobs\/[^/]+\/artifacts\/[^/]+$/)) {
            if (!requireUserAccess(req, res)) return;
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
            if (!requireUserAccess(req, res)) return;
            const job = await transferManager.getJob(url.pathname.split("/").pop());
            if (!job) return notFound(res);
            send(res, 200, job);
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
            const product = await store.getProduct(decodeURIComponent(url.pathname.split("/").pop()));
            if (!product) return notFound(res);
            if (!await resourceVisible(req, product.product?.sourceStoreIds || [])) return send(res, 403, { error: "store_not_claimed" });
            send(res, 200, product);
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/files/")) {
            if (!requireUserAccess(req, res)) return;
            const scope = await visibleStoreScope(req);
            if (scope) {
                const overview = store.listOverviewPage ? await store.listOverviewPage(null, new URL("http://local/?productLimit=0&includeAllBatches=1")) : await store.listOverview();
                const name = decodeURIComponent(url.pathname.split("/").pop());
                const related = (overview.batches || []).filter(batch => (batch.files || []).some(file => file.storedName === name));
                if (!related.length || related.some(batch => !scope.has(String(batch.sourceStoreId || "")))) return send(res, 403, { error: "store_not_claimed" });
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
            // 文件表单尚无持久提交轮次，显式拒绝而非暗中绕开新账户串行约束。
            if (ACCOUNT_PROCESS_MODE === 'on') return send(res, 409, {
                error: 'account_mode_requires_plugin_ingest', message: '账户执行模式请通过来源店铺插件上传，文件导入暂不支持此模式。'
            });
            // 门控先于申请接收额度：on 未就绪时不该先占用接收槽。
            assertNewBusinessAllowed();
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
             * 并校验它属于当前账号；管理员不受限，便于代传与排障。
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
            const declaredStoreName = String(files.map((file) => file.payload?.source?.sourceStoreName || file.payload?.source?.shopName || "").find(Boolean) || "").trim();
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
            // 上传准备许可属于新业务：申请它之前先过门控。
            assertNewBusinessAllowed();
            if (ACCOUNT_PROCESS_MODE === 'on' && body.accountExecutionProtocol !== 1) return send(res, 428, { error: 'account_plugin_upgrade_required' });
            if (ACCOUNT_PROCESS_MODE === 'on' && (Date.now() - budgetSampledAt >= 15000 || latestBudget?.canAcceptNewStaging !== true)) {
                throw Object.assign(Error('ingest_resource_budget_wait'), { status: 429, retryAfter: 15 });
            }
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
            // 门控必须在**消费许可、申请接收额度、读取正文之前**。
            // 之前它放在 JSON.parse 之后，即使最后返回 503，也已经消耗了接收槽、
            // 内存与解析 CPU——"先付费后拒单"与注释里写的顺序正好相反。
            assertNewBusinessAllowed();
            const permitOwner = req.temuPluginInstanceId || String(req.headers['x-plugin-instance'] || '');
            if (ACCOUNT_PROCESS_MODE === 'on' && !req.headers['x-ingest-permit']) return send(res, 428, { error: 'account_ingest_permit_required' });
            const lease = req.headers['x-ingest-permit'] ? await ingestProtocol.consume(permitOwner, req.headers['x-ingest-permit'], Number(req.headers['content-length'])) : null;
            const release = lease ? lease.finish : await acquireIngest(req, res);
            try {
            req.setTimeout(120000, () => req.destroy());
            if (ACCOUNT_PROCESS_MODE === 'on') {
                // 接收与规范化仅落盘；单商品解析及库存写入必须等账户运行器取得业务槽。
                await ingestProtocol.begin(lease, lease.sha256);
                const received = await receiveAccountCapture({ request: req, lease, stagingDir: ingestStaging.stagingDir,
                    linkReservation: stagingBudget.link, maxBytes: MAX_INGEST_BODY });
                const accepted = await accountIngest.accept({ lease, received, verified: true });
                wakeRuntime();
                return send(res, 202, accepted);
            }
            const buffer = await readBody(req, MAX_INGEST_BODY);
            let body;
            try {
                body = JSON.parse(stripBom(buffer.toString("utf8")));
            } catch {
                send(res, 400, { error: "不是合法 JSON" });
                return;
            }
            const upload = extractIngestUpload(body, req);
            if (Array.isArray(upload.payload.products) && upload.payload.products.length > 1000) throw Object.assign(Error('单个采集包最多1000件商品，请拆分上传'), { status: 413 });
            // 新插件在发送前计算整包摘要；旧包保留导入兼容，但不能冒充已由来源端验证。
            const incomingVerified = verifyTransferManifest(upload.payload, body.kind ? null : body.transferIntegrity);
            const mapped = await jobQueue.resolveIngestSource({
                pluginInstanceId: upload.pluginInstanceId,
                pageStoreName: upload.pageStoreName,
                storeName: upload.sourceStoreName || upload.shopName,
                storeId: upload.sourceStoreId
            });
            // 许可绑定认证来源店，不能申请A店许可却写入B店商品。
            if (lease) {
                if ((upload.sourceStoreId || mapped?.sourceStoreId) !== lease.storeId || upload.pluginInstanceId !== lease.owner) throw Object.assign(Error('ingest_source_mismatch'), { status: 403 });
                await ingestProtocol.begin(lease, transferHash(upload.payload));
            }
            const result = await store.importFiles([
                { originalName: upload.originalName, payload: upload.payload }
            ], {
                label: upload.label,
                shopName: upload.shopName || (mapped && mapped.sourceStoreName) || "",
                sourceStoreId: upload.sourceStoreId || (mapped && mapped.sourceStoreId) || "",
                sourceStoreName: upload.sourceStoreName || (mapped && mapped.sourceStoreName) || upload.shopName,
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
            // 入库成功后登记账户工作账本：这是"上传进入账户执行链"的落点。
            // 放在 receipt 之前，账本数量随回执一起返回，调用方能区分"入库成功"与"已进账户队列"。
            const storedForWork = result.batch?.files?.[0];
            const accountWork = await enqueueAccountWorkForIngest({
                sourceStoreId: upload.sourceStoreId || (mapped && mapped.sourceStoreId) || '',
                products: result.batch?.products || [],
                requestId: lease?.id || '',
                batchId: result.batch?.id || '',
                // 上下文取服务端可信值：actor 取当前操作者，归属代次取认领记录，
                // 源引用与摘要取已落盘的不可变文件——不接受客户端自报。
                actorId: req.temuUser?.id || upload.pluginInstanceId || '',
                // 所有权代次用认领时间：认领变化会产生新时间戳，旧授权据此失效。
                // 取不到就留空——不编造一个假的代次。
                ownershipGeneration: await ownershipGenerationOf(upload.sourceStoreId || (mapped && mapped.sourceStoreId) || ''),
                // 三项都取**实际落盘事实**，不用写入前的估算：
                // - sourceRef 必须含目录（worker 以受控源根解析，只有 basename 会 ENOENT）；
                // - sourceHash 是文件字节 SHA-256，与 canonical JSON 摘要是不同语义；
                // - expectedBytes 是磁盘字节数（两空格缩进后的长度）。
                sourceRef: storedForWork?.sourceRef || '',
                sourceHash: storedForWork?.fileSha256 || '',
                sourceHashAlgorithm: storedForWork?.fileSha256Algorithm || 'sha256',
                expectedBytes: Number(storedForWork?.fileBytes || 0)
            }).catch(error => {
                // 归属查询故障必须让客户端知道并重试，不能吞成 enqueued:0 假装正常。
                if (error?.code === 'ownership_lookup_failed') {
                    throw Object.assign(new Error('ownership_lookup_failed'), { status: 503, retryAfter: 5, code: 'ownership_lookup_failed' });
                }
                return { enabled: true, enqueued: 0, error: String(error?.message || error) };
            });
            // 真正登记成功才唤醒：不把"没入队"也当成有活可干。
            if (accountWork?.enqueued > 0) wakeRuntime();
            const receipt = {
                ok: true,
                transferIntegrity: { algorithm: TRANSFER_HASH_ALGORITHM, receivedSha256: transferHash(upload.payload), storedSha256: storedPacket ? transferHash(storedPacket) : null, verified: incomingVerified && Boolean(storedPacket) },
                reused: result.reused,
                // 账本登记结果如实随回执返回：0 与"未启用"是两种不同的情况，不能混为一谈。
                accountWork: { enabled: accountWork.enabled, enqueued: accountWork.enqueued || 0,
                    // workId 必须透传：客户端与验收靠它把"受理"与"执行"绑成同一条因果链。
                    // 只报 enqueued 数量会让调用方无法定位具体是哪件工作。
                    ...(accountWork.workId ? { workId: accountWork.workId } : {}),
                    ...(accountWork.skipped ? { skipped: accountWork.skipped } : {}),
                    ...(accountWork.shadow ? { shadow: true } : {}),
                    ...(accountWork.reason ? { reason: accountWork.reason } : {}),
                    ...(accountWork.lastError ? { lastError: accountWork.lastError } : {}),
                    ...(accountWork.error ? { error: accountWork.error } : {}) },
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
/**
 * 后台批量分发的启动条件。
 *
 * 隔离读取服务不执行后台分发；正式进程仅续跑已被用户持久化确认的清单。
 * 另外：新模式开启（shadow/on）时**不启动旧分发器**——否则旧路径会独立签发
 * 平台执行许可，绕开新账户门控，"新模式"名存实亡。
 * 这里不是"停止功能"，而是要求新模式自己接管后由账户运行器负责推进。
 */
if (process.env.ZINIAO_TEST_EPHEMERAL !== "1") {
    if (ACCOUNT_PROCESS_MODE === 'off') {
        bulkDispatch?.start();
    } else if (accountRuntimeHandle) {
        // on：由账户运行器接管推进；旧分发器不得同时运行，
        // 否则两条链会各自签发平台许可，同一件商品可能被处理两次。
        accountRuntimeHandle.start();
        console.log(`账户运行器已启动（mode=${ACCOUNT_PROCESS_MODE}）`);
    } else {
        // 明确记录：新模式未就绪时不启动旧分发器，避免"半切换"。
        console.log(`账户运行器未就绪（mode=${ACCOUNT_PROCESS_MODE}）：新业务门控返回 503`);
    }
}
// 独立回收失联许可，不依赖网页打开；隔离只读启动不运行任何任务维护。
if (process.env.ZINIAO_TEST_EPHEMERAL !== '1') {
    let expiring = false;
    const expire = async () => {
        if (expiring) return;
        expiring = true;
        try { await jobQueue.expireDirectPermits(); }
        catch (error) { console.error('创建许可维护失败', error.code || error.name); }
        finally { expiring = false; }
    };
    setInterval(expire, 30000).unref();
    await expire();
}
if (database) {
    // 日志清理与请求分离，每轮有删除上限，不能因历史日志过多拖住回执。
    let cleaning = false;
    const cleanup = async () => {
        if (cleaning) return;
        cleaning = true;
        try {
            // 先终结未绑定页面轮次的历史直推任务：它们没有可撤销的授权，留着就是"刷新后仍自动上传"的来源。
            await jobQueue.retireLegacyDirectJobs?.();
            await jobQueue.cleanupLogs();
            await jobQueue.cleanupPayloads?.();
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
    console.log(database ? "存储模式 MySQL：入库、分发、反馈连接额度已分离" : "存储模式 文件：保留兼容与离线调试");
    console.log(`中转仓 ${auth.origins[0] || `http://${HOST}:${PORT}`}`);
    for (const origin of auth.origins) console.log(`直推地址 ${origin}/api/ingest`);
    console.log("云端认证已启用，凭证不会写入运行日志");
    if (HOST === "127.0.0.1") console.log("紫鸟若访问不到本机，请用 ZINIAO_BIND=0.0.0.0 启动并填写局域网地址。");
});
