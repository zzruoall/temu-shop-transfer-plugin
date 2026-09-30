import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { namesCompatible, taskIdentityMatches } from "./store-names.mjs";
import { replaceFile } from "./atomic-file.mjs";
import { createMysqlJobRepository } from "./mysql-job-repository.mjs";
import { assertCapturedSource, transferManifest, verifyTransferManifest } from "./transfer-integrity.mjs";
import { jobRequestIdentity } from "./job-idempotency.mjs";
import { supportsScheduling } from './scheduling.mjs';

function asText(value) {
    return String(value || "").trim();
}

/**
 * 队列不信任“页面上有面板”这一类客户端布尔值。只有当前 10.x 插件同时上报版本和在场标记，
 * 才能领取或把任务写为身份已核验，避免旧版同名面板越过中转安全边界。
 */
function hasSupportedPlugin(input = {}) {
    const parts = asText(input.pluginVersion).split(".").map(part => Number(part));
    return Boolean(input.pluginDetected)
        && parts.length === 3
        && parts.every(Number.isInteger)
        && parts.every(part => part >= 0)
        && parts[0] === 10
        // 10.1.0 才公开 pluginInstanceId 和自动店名，10.0.x 不能被登记为可领取的中转 Agent。
        && parts[1] > 0;
}

function unique(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((item) => asText(item)).filter(Boolean))];
}

const CLAIM_LEASE_MS = 5 * 60 * 1000;
const OPEN_LEASE_MS = 3 * 60 * 1000;
// 插件每 8 秒发送一次心跳；超过这个窗口的实例不能被网页误认为可接收任务。
const AGENT_ONLINE_MS = 35 * 1000;
const MAX_JOBS = 200;
// 运营可能维护上百家店铺，Agent 索引不能沿用早期的 50 家上限，否则旧店铺会被静默淘汰。
const MAX_AGENTS = 500;
const MAX_MANUAL_TARGET_TASKS = 30;
const MAX_MANUAL_TARGET_TASK_BYTES = 4 * 1024 * 1024;
// 旧插件保留三店兼容上限；新协议由独立调度控制器调节，不以连接池数量代替执行上限。
const MAX_DIRECT_PUBLISH_STORES = 3;
const WORK_LOG_RETENTION_MS = 15 * 24 * 60 * 60 * 1000;
const MAX_STORE_WORK_LOG_ENTRIES = 2000;
// 轮次撤销是不可逆终态：停止通知先到、启动请求后到时，也必须靠这份记录拦住迟到启动。
const MAX_RUN_REVOCATIONS = 50;
const RUN_REVOCATION_TTL_MS = 6 * 60 * 60 * 1000;
// 外部终止（刷新页面、插件更新、切店、关闭页面）要彻底清走该轮任务；只有操作者
// 主动点暂停（manual_stop）才保留任务。两者都停止执行，区别只在任务是否留下。
// 这里列出已知的外部原因，仅用于把原因写进日志；判定本身以"非 manual_stop 即外部"为准，
// 这样旧插件不发 stopReason 时也会按清除处理，不会留下无人认领的旧任务。
const EXTERNAL_STOP_REASONS = new Set(["page_refresh", "plugin_upgrade", "store_switch", "page_close", "document_changed"]);
// 获得创建许可十分钟后仍无结果则转待核对；窗口远大于插件的提交和回查等待，
// 只释放全局预算，保留本店隔离、原尝试及回执凭证，不自动重新排队。
const DIRECT_STALE_MS = 10 * 60 * 1000;
const TERMINAL_JOB_STATUSES = new Set(["cancelled", "failed", "identity_verified", "uploaded", "completed"]);
const ACTIVE_ITEM_STATUSES = new Set(["queued", "opening", "opened", "claimed", "received", "upload_opened", "plugin_missing", "retry_wait"]);
// 会真正走到平台提交、或已被插件接手准备提交的状态；人工重试据此保证同店同货号只有一个在途项。
const DIRECT_IN_FLIGHT_STATUSES = new Set(["queued", "opening", "opened", "claimed", "received", "retry_wait"]);
const TERMINAL_ITEM_STATUSES = new Set(["identity_verified", "identity_mismatch", "uploaded", "failed", "cancelled", "blocked", "skipped"]);
const ITEM_TRANSITIONS = {
    queued: ["opening", "opened", "plugin_missing", "retry_wait", "failed", "cancelled"],
    opening: ["opening", "opened", "plugin_missing", "queued", "retry_wait", "failed", "cancelled"],
    opened: ["opened", "claimed", "plugin_missing", "queued", "retry_wait", "failed", "cancelled"],
    // received 表示完整商品快照已送到目标插件，之后仍需操作者点击上传并确认结果。
    claimed: ["claimed", "received", "identity_verified", "identity_mismatch", "plugin_missing", "queued", "failed", "cancelled"],
    received: ["upload_opened", "uploaded", "failed", "cancelled"],
    upload_opened: ["uploaded", "received", "failed", "cancelled"],
    plugin_missing: ["queued", "claimed", "opening", "opened", "failed", "cancelled"],
    retry_wait: ["queued", "opening", "failed", "cancelled"],
    identity_verified: [],
    identity_mismatch: [],
    failed: [],
    cancelled: [],
    blocked: []
};

/** 只有所有可处理商品项都进入终态时，任务才算真正结束；partial 可能仍有 queued 项。 */
function isTerminalJob(job = {}) {
    if (!job || typeof job !== "object") return false;
    if (TERMINAL_JOB_STATUSES.has(asText(job.status)) || asText(job.status) === "blocked_preflight") return true;
    if (asText(job.status) !== "partial") return false;
    const actionable = (Array.isArray(job.items) ? job.items : [])
        .filter((item) => item.status !== "blocked" && item.status !== "cancelled");
    return actionable.length > 0 && actionable.every((item) => TERMINAL_ITEM_STATUSES.has(item.status));
}

function canTransitionItem(from, to) {
    return (ITEM_TRANSITIONS[asText(from)] || []).includes(asText(to));
}

function stableJson(value) {
    if (Array.isArray(value)) return value.map(stableJson);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
    }
    return value == null ? "" : value;
}

function snapshotSkus(skus = []) {
    return (Array.isArray(skus) ? skus : []).map((sku) => ({
        skuId: asText(sku && sku.skuId),
        extCode: asText(sku && sku.extCode),
        specs: Array.isArray(sku && sku.specs) ? sku.specs.map((spec) => ({
            name: asText(spec && spec.name),
            value: asText(spec && spec.value)
        })) : [],
        price: sku && sku.price != null ? sku.price : null,
        currency: asText(sku && sku.currency),
        weight: sku && sku.weight != null ? sku.weight : null,
        netWeight: sku && sku.netWeight != null ? sku.netWeight : null,
        thumbUrl: asText(sku && sku.thumbUrl)
    })).sort((left, right) => asText(left.skuId).localeCompare(asText(right.skuId)));
}

/**
 * 任务版本必须覆盖真正会传输的字段。标题/图片相同但详情、价格、规格变化时，必须生成新版本。
 */
export function canonicalProductSnapshot(product = {}) {
    const snapshot = stableJson({
        spuId: asText(product.spuId),
        goodsId: asText(product.goodsId),
        title: asText(product.title),
        category: asText(product.category),
        articleNo: asText(product.articleNo),
        productExtCodes: unique(product.productExtCodes).sort(),
        skuExtCodes: unique(product.skuExtCodes).sort(),
        images: unique(product.images).sort(),
        skuIds: unique(product.skuIds).sort(),
        skcIds: unique(product.skcIds).sort(),
        skus: snapshotSkus(product.skus),
        attributes: Array.isArray(product.attributes) ? product.attributes.map((item) => ({
            name: asText(item && item.name),
            value: asText(item && item.value),
            unit: asText(item && item.unit)
        })) : [],
        detail: product.detail && typeof product.detail === "object" ? product.detail : null,
        ready: Boolean(product.ready)
    });
    // 原始发布资料不能经过旧摘要的 null→空串转换；成分变化也必须参与任务版本计算。
    if (product.publicationData) snapshot.publicationData = structuredClone(product.publicationData);
    return snapshot;
}

/**
 * 计算商品任务版本。同一 SPU 资料变化后必须生成新版本，避免目标店领取到过期包。
 */
export function makeProductVersion(product = {}) {
    return createHash("sha256").update(JSON.stringify(canonicalProductSnapshot(product))).digest("hex").slice(0, 16);
}

function httpError(message, status) {
    const error = new Error(message);
    error.status = status;
    return error;
}

/**
 * 服务端领取容量要按插件真正落盘的对象估算，而不是只计算 snapshot。
 * 否则临近 4MB 时服务端会放行、插件却因 jobId/领取凭证等包装字段拒绝整批保存。
 */
function manualTargetTaskStorageBytes(job, item, claimToken, receivedAt) {
    const storedTask = {
        executionRunId: String(job.executionRunId || ''),
        jobId: String(job && job.id || ""),
        spuId: String(item && item.spuId || ""),
        title: String(item && item.title || ""),
        claimToken: String(claimToken || ""),
        sourceStoreId: String(job && job.sourceStoreId || ""),
        targetStoreId: String(job && job.targetStoreId || ""),
        sourceBatchId: String(job && job.sourceBatchId || ""),
        snapshot: item && item.snapshot || null,
        ...(item?.transferIntegrity ? { transferIntegrity: item.transferIntegrity } : {}),
        directCreate: Boolean(job.directCreate),
        directRetrySequence: Math.max(0, Number(item.directRetrySequence || 0)),
        receivePending: true,
        status: "received",
        receivedAt: String(receivedAt || ""),
        uploadOpenedAt: ""
    };
    return Buffer.byteLength(JSON.stringify(storedTask), "utf8");
}

/** 只有近期心跳的插件实例才可作为网页“在线目标店”显示。 */
function isAgentOnline(agent, nowMs = Date.now()) {
    const seenAt = Date.parse(asText(agent && agent.lastSeenAt));
    return Boolean(agent && Number.isFinite(seenAt) && nowMs - seenAt >= 0 && nowMs - seenAt <= AGENT_ONLINE_MS);
}

/** 10.3 起插件支持接收商品快照并提供人工上传按钮，旧版本仅能做身份核验。 */
function hasManualTransferPlugin(input = {}) {
    const parts = asText(input.pluginVersion).split(".").map(part => Number(part));
    return hasSupportedPlugin(input)
        && parts[0] === 10
        && (parts[1] > 3 || (parts[1] === 3 && parts[2] >= 0));
}

/** 工作日志按目标店铺分文件保存，文件名只用店铺 ID 的哈希，避免路径穿越。 */
function workLogFileName(storeId) {
    return `${createHash("sha1").update(asText(storeId) || "unknown-store").digest("hex")}.json`;
}

/** 超过 15 天的操作不再展示，也不再写回店铺日志文件。 */
function isWorkLogFresh(entry, nowMs = Date.now()) {
    const at = Date.parse(asText(entry && entry.at));
    return Number.isFinite(at) && nowMs - at >= 0 && nowMs - at <= WORK_LOG_RETENTION_MS;
}

function pruneWorkLogEntries(entries, nowMs = Date.now()) {
    return (Array.isArray(entries) ? entries : [])
        .filter((entry) => isWorkLogFresh(entry, nowMs))
        .sort((left, right) => String(left.at).localeCompare(String(right.at)))
        .slice(-MAX_STORE_WORK_LOG_ENTRIES);
}

function isSameWorkLog(left, right) {
    return Boolean(left && right
        && left.type === right.type
        && left.spuId === right.spuId
        && left.storeId === right.storeId
        && left.jobId === right.jobId
        && left.message === right.message);
}

async function writeJsonAtomic(filePath, value) {
    const temp = `${filePath}.tmp`;
    await writeFile(temp, JSON.stringify(value, null, 2), "utf8");
    // 日志查询与回执写入也会并行，不能在替换失败时暴露半截 JSON。
    await replaceFile(temp, filePath);
}

function summarizeAgent(agent) {
    const runActive = Boolean(agent.executionRun?.active && agent.executionRun.storeId === agent.storeId && Date.parse(agent.executionRun.expiresAt) > Date.now());
    return {
        pluginInstanceId: agent.pluginInstanceId || "",
        storeId: agent.storeId || "",
        storeName: agent.storeName || "",
        mallId: agent.mallId || "",
        executionMode: agent.executionMode || "",
        executionRunProtocol: agent.executionRunProtocol || 0,
        executionRunLastId: agent.executionRun?.id || "",
        executionRunId: runActive ? agent.executionRun.id : "",
        pageUrl: agent.pageUrl || "",
        pageType: agent.pageType || "",
        pluginVersion: agent.pluginVersion || "",
        lastSeenAt: agent.lastSeenAt,
        lastClaimedJobId: agent.lastClaimedJobId || "",
        pluginDetected: Boolean(agent.pluginDetected),
        identityMatched: Boolean(agent.identityMatched),
        pageStoreName: agent.pageStoreName || "",
        nameSource: agent.nameSource || "",
        nameConfidence: agent.nameConfidence || "",
        expectedCount: agent.expectedCount == null ? null : agent.expectedCount,
        completedCount: agent.completedCount == null ? null : agent.completedCount,
        capturePhase: agent.capturePhase || "",
        ingestPhase: agent.ingestPhase || "",
        pendingUploadCount: Number.isInteger(agent.pendingUploadCount) ? agent.pendingUploadCount : 0,
        source: agent.source || "",
        online: isAgentOnline(agent),
        onlineWindowMs: AGENT_ONLINE_MS,
        canReceiveUploads: hasManualTransferPlugin(agent) && hasTransferIntegrityPlugin(agent) && (agent.executionRunProtocol !== 1 || runActive)
    };
}

/**
 * 用插件实例或店名回填紫鸟店铺。插件心跳可以没有 storeId，工人巡检必须带 storeId。
 */
export function resolveAgentStore(agents = [], input = {}) {
    const instanceId = asText(input.pluginInstanceId);
    const storeId = asText(input.storeId);
    const pageStoreName = asText(input.pageStoreName || input.storeName);
    const list = Array.isArray(agents) ? agents : [];
    // 心跳和工人都必须先按实例合并。店名只给入库回填做兜底，避免两家店被合成一条。
    if (instanceId) {
        const byInstance = list.find((item) => asText(item.pluginInstanceId) === instanceId);
        if (byInstance) return byInstance;
        if (storeId) {
            // 工人可能先用空实例登记窗口。只允许补上还没有 pluginInstanceId 的记录，不能把别人的实例改掉。
            const unbound = list.find((item) => asText(item.storeId) === storeId && !asText(item.pluginInstanceId));
            if (unbound) return unbound;
        }
        return null;
    }
    if (storeId) {
        const byStore = list.find((item) => asText(item.storeId) === storeId);
        if (byStore) return byStore;
    }
    if (pageStoreName) {
        const byName = list.find((item) => namesCompatible(item.pageStoreName || item.storeName, pageStoreName) && asText(item.storeId));
        if (byName) return byName;
    }
    return null;
}

function summarizeJob(job) {
    const items = Array.isArray(job.items) ? job.items : [];
    return {
        ...job,
        counts: {
            total: items.length,
            queued: items.filter((item) => item.status === "queued").length,
            opening: items.filter((item) => item.status === "opening").length,
            claimed: items.filter((item) => item.status === "claimed").length,
            received: items.filter((item) => item.status === "received").length,
            uploadOpened: items.filter((item) => item.status === "upload_opened").length,
            uploaded: items.filter((item) => item.status === "uploaded").length,
            opened: items.filter((item) => item.status === "opened").length,
            verified: items.filter((item) => item.status === "identity_verified").length,
            pluginMissing: items.filter((item) => item.status === "plugin_missing").length,
            failed: items.filter((item) => item.status === "failed" || item.status === "identity_mismatch").length
            , skipped: items.filter(item => item.status === "skipped").length
            , unknown: items.filter(item => item.status !== "cancelled" && item.directState === "unknown").length
            , rejected: items.filter(item => item.status !== "cancelled" && item.directState === "rejected").length
        }
    };
}

/** 新任务要求摘要校验与可靠回执版本；旧实例仍可补报已授权尝试，不能领取新的创建许可。 */
function hasTransferIntegrityPlugin(input = {}) {
    const [major, minor, patch] = asText(input.pluginVersion).split(".").map(Number);
    return major === 10 && (minor > 10 || (minor === 10 && patch >= 56));
}

/** 任务页和汇总接口共用同一分组口径，避免前端筛选与服务端统计出现两套结论。 */
function jobRecordGroup(job) {
    const status = asText(job?.status);
    if (status === "cancelled") return "done";
    const itemStates = (Array.isArray(job?.items) ? job.items : []).filter(item => item.status !== "cancelled").map((item) => asText(item.directState));
    if (itemStates.some((state) => ["unknown", "preflight_failed", "rejected"].includes(state))
        || (job.items || []).some(item => ["failed", "identity_mismatch", "blocked"].includes(item.status))
        || ["failed", "blocked_preflight", "identity_mismatch"].includes(status)) return "attention";
    if (itemStates.includes("creating")) return "active";
    if (itemStates.length && itemStates.every((state) => ["created", "duplicate_exists"].includes(state))) return "done";
    if (ACTIVE_ITEM_STATUSES.has(status) || (job.items || []).some(item => ACTIVE_ITEM_STATUSES.has(item.status))) return "active";
    return "done";
}

const SHANGHAI_DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
});

/** 汇总按上海自然日计算，与网页展示的经营口径保持一致。 */
function shanghaiDayKey(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return "";
    const parts = SHANGHAI_DAY_FORMATTER.formatToParts(date);
    const pick = (type) => parts.find((part) => part.type === type)?.value || "";
    return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function jobInVisibleScope(job, scope) {
    if (!scope) return true;
    return scope.has(asText(job?.sourceStoreId)) || scope.has(asText(job?.targetStoreId));
}

function agentInVisibleScope(agent, scope) {
    return !scope || scope.has(asText(agent?.storeId));
}

/**
 * 按商品项汇总任务状态。已齐和未齐商品必须分开，不能因为混选就把整单锁死。
 */
function refreshJobStatus(job) {
    const items = Array.isArray(job.items) ? job.items : [];
    const actionable = items.filter((item) => item.status !== "blocked" && item.status !== "cancelled");
    const failed = actionable.filter((item) => item.status === "failed" || item.status === "identity_mismatch");
    const verified = actionable.filter((item) => item.status === "identity_verified");
    const received = actionable.filter((item) => item.status === "received");
    const uploadOpened = actionable.filter((item) => item.status === "upload_opened");
    const uploaded = actionable.filter((item) => item.status === "uploaded");
    const claimed = actionable.filter((item) => item.status === "claimed");
    const opened = actionable.filter((item) => item.status === "opened");
    const opening = actionable.filter((item) => item.status === "opening");
    const queued = actionable.filter((item) => item.status === "queued");
    const pluginMissing = actionable.filter((item) => item.status === "plugin_missing");
    const retryWait = actionable.filter((item) => item.status === "retry_wait");
    const hasBlocked = items.some((item) => item.status === "blocked");
    const allItemsTerminal = items.length > 0 && items.every((item) => TERMINAL_ITEM_STATUSES.has(item.status));
    if (!actionable.length) job.status = items.some((item) => item.status === "blocked") ? "blocked_preflight" : "cancelled";
    else if (uploaded.length === actionable.length && !hasBlocked) job.status = "uploaded";
    else if (verified.length === actionable.length && !hasBlocked) job.status = "identity_verified";
    else if (failed.length && (verified.length || uploaded.length)) job.status = "partial";
    else if (failed.length && !verified.length && failed.length === actionable.length) job.status = "failed";
    else if (allItemsTerminal) job.status = failed.length || hasBlocked ? "partial" : "completed";
    else if (uploaded.length || uploadOpened.length || received.length) job.status = "partial";
    else if (actionable.every((item) => TERMINAL_ITEM_STATUSES.has(item.status))) job.status = "partial";
    else if (pluginMissing.length && !queued.length && !opening.length && !opened.length && !claimed.length && !retryWait.length) job.status = "plugin_missing";
    else if (claimed.length) job.status = "claimed";
    else if (opened.length) job.status = "opened";
    else if (opening.length) job.status = "opening";
    else if (retryWait.length) job.status = "retry_wait";
    else if (queued.length) job.status = "queued";
    else job.status = "partial";
}

/**
 * 打开租约和领取租约到期后必须回到 queued，否则本机工人不会再处理，任务会停在 opened。
 */
function expireStaleLeases(job, nowMs = Date.now()) {
    let changed = false;
    for (const item of job.items || []) {
        if (item.status === "opening" && item.openingAt && nowMs - Date.parse(item.openingAt) > OPEN_LEASE_MS) {
            item.status = "queued";
            item.reason = "打开超时，已重新排队";
            changed = true;
        }
        if (item.status === "opened" && item.openedAt && nowMs - Date.parse(item.openedAt) > CLAIM_LEASE_MS) {
            item.status = "queued";
            item.claimedByStoreId = "";
            item.claimedAt = "";
            item.claimExpiresAt = "";
            item.claimToken = "";
            item.reason = "打开后无人领取，已重新排队";
            changed = true;
        }
        if (item.status === "claimed" && item.claimExpiresAt && Date.parse(item.claimExpiresAt) < nowMs) {
            item.status = "queued";
            item.claimedByStoreId = "";
            item.claimedAt = "";
            item.claimExpiresAt = "";
            item.claimToken = "";
            item.reason = "领取租约已过期，已重新排队";
            changed = true;
        }
        if (item.status === "plugin_missing" && item.pluginMissingAt && nowMs - Date.parse(item.pluginMissingAt) > OPEN_LEASE_MS) {
            item.status = "queued";
            item.claimedByStoreId = "";
            item.claimedAt = "";
            item.claimExpiresAt = "";
            item.claimToken = "";
            item.reason = "未检测到插件，已重新排队等待复查";
            changed = true;
        }
        if (item.status === "retry_wait" && item.retryAt && Date.parse(item.retryAt) <= nowMs) {
            item.status = "queued";
            item.reason = "可重试失败已到期，已重新排队";
            changed = true;
        }
    }
    refreshJobStatus(job);
    return changed;
}

/**
 * 中央任务队列。任务必须绑定来源店、目标店、SPU、商品版本和数据哈希。
 * 插件只能领取 targetStoreId 与当前页面店铺一致的任务，禁止向所有插件广播。
 */
export function createJobQueue(rootDir, store, options = {}) {
    // on模式显式注入账户执行桥；不允许文件模式承诺跨账本原子性，默认null完全保留旧协议。
    const accountExecution = options.accountExecution || null;
    if (accountExecution && !options.database) throw Object.assign(new Error('account_publish_requires_database'), { status: 503 });
    const sql = options.database ? createMysqlJobRepository(options.database, { summarizeJob, jobRecordGroup, summarizeAgent, refreshJobStatus,
        // 同账户串行需要"该账户名下有哪些店铺"，由认领关系提供（任务表不存账号）。
        storesOfAccount: options.ownership?.ownedStoreIds ? accountId => options.ownership.ownedStoreIds(accountId) : null,
        accountExecution }) : null;
    const dataDir = path.join(rootDir, "data");
    const filePath = path.join(dataDir, "jobs.json");
    const workLogDir = path.join(dataDir, "work-logs");
    // 删除名单与归属表由外部注入：任务队列需要它们做"已删除店铺不再登记"和"恢复时写回归属"。
    // 做成可选依赖，测试里只传 store 也能照常工作。
    const deletedStores = options.deletedStores || null;
    const ownership = options.ownership || null;
    // 账户解析用于"一个账户同时只执行一家店"；未注入时退回按店铺判定。
    const accountResolver = options.accountResolver || null;
    let mutation = Promise.resolve();
    /** 人工管理任务按当前归属复核，不依赖网页传来的店铺 ID 或过期的列表权限。 */
    async function assertJobAccess(job, access) {
        if (!access?.userId) return;
        if (sql) return sql.assertAccess(job, access);
        const scope = await ownership?.ownedStoreIds(access.userId);
        if (!scope || !scope.has(job.sourceStoreId) || !scope.has(job.targetStoreId)) throw httpError("任务来源店或目标店不属于当前账号", 403);
    }

    function workLogPath(storeId) {
        return path.join(workLogDir, workLogFileName(storeId));
    }

    async function readStoreWorkLog(storeId) {
        await mkdir(workLogDir, { recursive: true });
        try {
            const value = JSON.parse(await readFile(workLogPath(storeId), "utf8"));
            if (!value || typeof value !== "object") {
                return { storeId: asText(storeId), storeName: "", sourceStoreId: "", sourceStoreName: "", entries: [] };
            }
            return {
                storeId: asText(value.storeId) || asText(storeId),
                storeName: asText(value.storeName),
                sourceStoreId: asText(value.sourceStoreId),
                sourceStoreName: asText(value.sourceStoreName),
                entries: Array.isArray(value.entries) ? value.entries : []
            };
        } catch (error) {
            if (error && error.code !== "ENOENT") throw error;
            return { storeId: asText(storeId), storeName: "", sourceStoreId: "", sourceStoreName: "", entries: [] };
        }
    }

    async function writeStoreWorkLog(log) {
        await mkdir(workLogDir, { recursive: true });
        const nowMs = Date.now();
        const entries = pruneWorkLogEntries(log.entries, nowMs);
        if (!entries.length) {
            await rm(workLogPath(log.storeId), { force: true });
            return { ...log, entries: [] };
        }
        const next = {
            storeId: asText(log.storeId),
            storeName: asText(log.storeName),
            sourceStoreId: asText(log.sourceStoreId),
            sourceStoreName: asText(log.sourceStoreName),
            updatedAt: new Date(nowMs).toISOString(),
            entries
        };
        await writeJsonAtomic(workLogPath(next.storeId), next);
        return next;
    }

    /**
     * 工作日志按目标店铺单独落盘。任务对象不再堆积操作记录，删除日志也不影响发送任务。
     */
    async function appendJobActivity(job, type, input = {}) {
        const storeId = asText(input.storeId || (job && job.targetStoreId));
        if (!storeId) return;
        const next = {
            at: new Date().toISOString(),
            type: asText(type),
            spuId: asText(input.spuId),
            storeId,
            actor: asText(input.actor),
            message: asText(input.message).slice(0, 240),
            jobId: asText(job && job.id),
            sourceStoreId: asText(job && job.sourceStoreId),
            sourceStoreName: asText(job && job.sourceStoreName),
            targetStoreId: asText(job && job.targetStoreId) || storeId,
            targetStoreName: asText(job && job.targetStoreName)
        };
        if (sql) { await sql.appendLog(next); return; }
        const log = await readStoreWorkLog(storeId);
        log.storeName = next.targetStoreName || log.storeName;
        log.sourceStoreId = next.sourceStoreId || log.sourceStoreId;
        log.sourceStoreName = next.sourceStoreName || log.sourceStoreName;
        const previous = log.entries[log.entries.length - 1];
        if (isSameWorkLog(previous, next)) {
            previous.at = next.at;
            previous.actor = next.actor;
            previous.sourceStoreName = next.sourceStoreName || previous.sourceStoreName;
            previous.targetStoreName = next.targetStoreName || previous.targetStoreName;
        } else {
            log.entries.push(next);
        }
        await writeStoreWorkLog(log);
    }

    async function readState() {
        if (sql) return sql.readState();
        await mkdir(dataDir, { recursive: true });
        try {
            const value = JSON.parse(await readFile(filePath, "utf8"));
            return value && typeof value === "object"
                ? { jobs: [], agents: [], ...value }
                : { jobs: [], agents: [] };
        } catch (error) {
            if (error && error.code !== "ENOENT") throw error;
            return { jobs: [], agents: [] };
        }
    }

    async function writeState(state) {
        if (sql) return sql.writeState(state);
        // 任务文件先写临时文件再替换，避免进程中途退出把 jobs.json 写成半截。
        const temp = `${filePath}.tmp`;
        await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
        await replaceFile(temp, filePath);
    }

    async function withLock(executor) {
        if (sql) {
            if (!sql.inContext()) throw new Error("任务操作缺少数据库事务边界");
            return executor();
        }
        const run = mutation.then(executor);
        mutation = run.catch(() => {});
        return run;
    }

    async function listJobs() {
        const state = await readState();
        return withLock(async () => {
            const current = await readState();
            let changed = false;
            for (const job of current.jobs || []) {
                if (expireStaleLeases(job)) changed = true;
            }
            if (changed) await writeState(current);
            return { jobs: (current.jobs || []).map(summarizeJob), agents: (current.agents || []).map(summarizeAgent) };
        });
    }

    /**
     * 商品库和工作日志只需要在线插件目录，不应为了取 agents 下载完整任务 JSON。
     * 这个接口仍受用户可见店铺范围约束，普通账号不会看到其他店铺心跳。
     */
    async function listAgents(options = {}) {
        const scope = options.scope instanceof Set ? options.scope : null;
        const query = asText(options.query).toLocaleLowerCase();
        const hasQuery = options.limit != null || options.offset != null || Boolean(query)
            || options.online != null || options.receivable != null;
        const state = await readState();
        const latestByStore = new Map();
        for (const agent of (state.agents || [])
            .filter((agent) => agentInVisibleScope(agent, scope))
            .map(summarizeAgent)) {
            // 同一店铺可能残留多个插件实例；目录分页必须按店铺去重，否则总数和实际可选店铺不一致。
            const key = asText(agent.storeId) || `instance:${asText(agent.pluginInstanceId)}`;
            const current = latestByStore.get(key);
            const newer = !current
                || (Boolean(agent.online) && !Boolean(current.online))
                || (Boolean(agent.online) === Boolean(current.online)
                    && String(agent.lastSeenAt || "").localeCompare(String(current.lastSeenAt || "")) > 0);
            if (newer) latestByStore.set(key, agent);
        }
        let agents = [...latestByStore.values()]
            .filter((agent) => {
                // 没有绑定紫鸟 storeId 的实例无法出现在店铺目录或作为目标店，不能计入分页总数。
                if (!asText(agent.storeId)) return false;
                if (options.online != null && Boolean(agent.online) !== Boolean(options.online)) return false;
                if (options.receivable != null && Boolean(agent.canReceiveUploads) !== Boolean(options.receivable)) return false;
                if (!query) return true;
                return [
                    agent.storeName,
                    agent.pageStoreName,
                    agent.storeId,
                    agent.pluginVersion
                ].map((value) => asText(value).toLocaleLowerCase()).join(" ").includes(query);
            });
        if (!hasQuery) return { agents };
        // 目录分页不能随心跳时间重排；版本覆盖可见资格，跨页变化时前端保留旧选择并重读。
        agents.sort((left, right) => asText(left.storeId).localeCompare(asText(right.storeId)));
        const directoryVersion = createHash("sha256").update(JSON.stringify(agents.map(agent => [
            agent.storeId, agent.storeName, agent.pageStoreName, agent.online,
            agent.pluginDetected, agent.identityMatched, agent.canReceiveUploads
        ]))).digest("hex");
        const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
        const offset = Math.max(0, Number(options.offset) || 0);
        const total = agents.length;
        agents = agents.slice(offset, offset + limit);
        return {
            agents,
            directoryVersion,
            total,
            offset,
            limit,
            hasMore: offset + agents.length < total
        };
    }

    /**
     * 任务记录按页返回，首屏只传必要的一页；状态表所需的进行中和异常任务单独返回紧凑记录。
     * 分页在服务端完成，避免数据达到数百条后仍把整份任务集合发送给浏览器。
     */
    async function listJobsPage(options = {}) {
        const limit = Math.min(200, Math.max(1, Number(options.limit) || 50));
        const offset = Math.max(0, Number(options.offset) || 0);
        const scope = options.scope instanceof Set ? options.scope : null;
        return withLock(async () => {
            const state = await readState();
            let changed = false;
            for (const job of state.jobs || []) {
                if (expireStaleLeases(job)) changed = true;
            }
            if (changed) await writeState(state);

            const currentJobs = (state.jobs || []).filter((job) => jobInVisibleScope(job, scope));
            const summaries = currentJobs
                .map(summarizeJob)
                .sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
            const counts = {
                total: summaries.length,
                active: summaries.filter((job) => jobRecordGroup(job) === "active").length,
                attention: summaries.filter((job) => jobRecordGroup(job) === "attention").length,
                done: summaries.filter((job) => jobRecordGroup(job) === "done").length
            };
            const page = summaries.slice(offset, offset + limit);
            return {
                jobs: page,
                activeJobs: summaries.filter((job) => ["active", "attention"].includes(jobRecordGroup(job))),
                agents: options.includeAgents === false ? [] : (state.agents || [])
                    .filter((agent) => agentInVisibleScope(agent, scope))
                    .map(summarizeAgent),
                counts,
                total: counts.total,
                offset,
                limit,
                hasMore: offset + page.length < counts.total
            };
        });
    }

    /**
     * 首页只返回经营汇总和排行，不再把完整任务集合交给浏览器逐项计算。
     * 排行仍读取完整队列以保证累计值正确，但响应体积保持在 KB 级。
     */
    async function listDashboard(options = {}) {
        const scope = options.scope instanceof Set ? options.scope : null;
        return withLock(async () => {
            const state = await readState();
            let changed = false;
            for (const job of state.jobs || []) {
                if (expireStaleLeases(job)) changed = true;
            }
            if (changed) await writeState(state);

            const jobs = (state.jobs || []).filter((job) => jobInVisibleScope(job, scope));
            const today = shanghaiDayKey(Date.now());
            const productCounts = new Map();
            const sourceCounts = new Map();
            let todaySent = 0;
            let todayUploaded = 0;
            let todayAttention = 0;
            for (const job of jobs) {
                const items = Array.isArray(job.items) ? job.items : [];
                if (shanghaiDayKey(job.createdAt) === today) todaySent += items.length;
                const sourceId = asText(job.sourceStoreId || job.sourceStoreName || "unknown-source");
                const source = sourceCounts.get(sourceId) || {
                    id: sourceId,
                    name: asText(job.sourceStoreName || job.sourceStoreId || "未知来源店"),
                    count: 0
                };
                source.count += items.length;
                sourceCounts.set(sourceId, source);

                for (const item of items) {
                    const productId = asText(item.spuId || "unknown-product");
                    const product = productCounts.get(productId) || {
                        id: productId,
                        name: asText(item.title || item.spuId || "未命名商品"),
                        count: 0
                    };
                    product.count += 1;
                    productCounts.set(productId, product);

                    if (shanghaiDayKey(item.directUpdatedAt || job.updatedAt) !== today) continue;
                    if (item.directState === "created" || item.status === "uploaded") todayUploaded += 1;
                    if (["unknown", "preflight_failed", "rejected"].includes(asText(item.directState))
                        || ["failed", "identity_mismatch"].includes(asText(item.status))) todayAttention += 1;
                }
            }
            const descending = (left, right) => right.count - left.count || left.name.localeCompare(right.name, "zh-CN");
            return {
                todaySent,
                todayUploaded,
                todayAttention,
                activeJobs: jobs.filter((job) => ["active", "attention"].includes(jobRecordGroup(job))).length,
                topProducts: [...productCounts.values()].sort(descending).slice(0, 8),
                topSources: [...sourceCounts.values()].sort(descending).slice(0, 8)
            };
        });
    }

    async function getJob(id) {
        const state = await readState();
        const job = (state.jobs || []).find((item) => item.id === asText(id));
        return job ? summarizeJob(job) : null;
    }

    /**
     * 插件心跳可以只带 pluginInstanceId 和页面店名；工人巡检必须带紫鸟 storeId。
     * 两边交叉写入同一 Agent，上传时才能按实例回填来源店。
     */
    async function registerAgent(input = {}) {
        return withLock(async () => {
            const pluginInstanceId = asText(input.pluginInstanceId);
            let storeId = asText(input.storeId);
            if (!pluginInstanceId && !storeId) throw httpError("pluginInstanceId 或 storeId 不能为空", 400);
            /**
             * 已删除的店铺不能被心跳重新登记。
             * 插件每 8 秒心跳一次，没有这道拦截，管理员删掉的店会在几秒后原地复活。
             * 这里直接返回"已删除"而不写任何状态，插件侧据此停止为该店登记。
             */
            if (storeId && deletedStores && await deletedStores.isDeleted(storeId)) {
                return { deleted: true, storeId, storeName: asText(input.storeName || input.pageStoreName) };
            }
            const state = await readState();
            const now = new Date().toISOString();
            const pluginDetected = hasSupportedPlugin(input);
            let existing = resolveAgentStore(state.agents, input);
            // API绑定不能被旧CLI心跳重新映射；旧连接器仅能继续管理旧模式实例。
            if(existing?.executionMode === "plugin-api" && input.executionMode !== "plugin-api") throw httpError("API插件绑定不可被旧连接器覆盖",409);
            const pageStoreName = asText(input.pageStoreName || input.storeName);
            /**
             * 本次请求要写入的店铺身份。这三项必须同源：它们共同描述"这条记录属于哪个店"，
             * 任何一个用了别的来源，记录就会自相矛盾（见下面占用分支的处理）。
             */
            let requestedStoreName = asText(input.storeName);
            let requestedPageStoreName = pageStoreName;
            let requestedMallId = asText(input.mallId);
            // API插件使用真实商城命名空间，旧CLI账号不得冒充该商城。
            if (input.executionMode === "plugin-api" && (!/^\d+$/.test(asText(input.mallId)) || storeId !== `temu:${input.mallId}`)) throw httpError("商城绑定不匹配", 409);
            // 同一扩展实例切到另一家店时，页面店名已变化而 storeId 尚未重新核验，必须先解除旧店绑定。
            // 否则新店采集包会按 pluginInstanceId 被错误归入上一家来源店。
            const pageChanged = Boolean(pluginInstanceId && existing && !storeId && pageStoreName
                && asText(existing.pageStoreName || existing.storeName)
                && !namesCompatible(pageStoreName, asText(existing.pageStoreName || existing.storeName)));
            /**
             * 紫鸟店铺已被另一个插件实例占用时，不能把同一 storeId 写到后到的实例上。
             * 旧实例已离线时才释放映射，避免浏览器重开后永久无法由新实例接管。
             *
             * 关键：退回 storeId 时必须把店名一起退回。
             * 只改 storeId 会让一次请求写入两个店铺的身份——storeId 指向上一个店、
             * 店名和 mallId 却来自当前页，记录自相矛盾。网站按 storeId 匹配行、按店名核验身份，
             * 两者对不上时状态就落不到正确的店铺行上，表现为"连上了但状态不更新"。
             */
            if (pluginInstanceId && storeId) {
                const occupied = (state.agents || []).find((item) => asText(item.storeId) === storeId
                    && asText(item.pluginInstanceId)
                    && asText(item.pluginInstanceId) !== pluginInstanceId);
                if (occupied && isAgentOnline(occupied)) {
                    // 目标店已被在线实例占用：这个实例只能留在它原有的店铺上，
                    // 因此店名、商城 ID、页面店名一并退回旧记录，保持整条记录自洽。
                    const fallback = existing && asText(existing.storeId) ? existing : null;
                    storeId = fallback ? asText(fallback.storeId) : "";
                    if (fallback) {
                        requestedStoreName = asText(fallback.storeName) || asText(fallback.pageStoreName);
                        requestedMallId = asText(fallback.mallId);
                        requestedPageStoreName = asText(fallback.pageStoreName) || requestedStoreName;
                    } else {
                        // 没有可退回的旧店：不能凭空绑定到别人占着的店上，本次只上报心跳不落店铺。
                        requestedStoreName = "";
                        requestedMallId = "";
                        requestedPageStoreName = "";
                    }
                } else if (occupied) {
                    occupied.storeId = "";
                    occupied.storeName = "";
                    occupied.identityMatched = false;
                    occupied.lastClaimedJobId = "";
                    existing = resolveAgentStore(state.agents, input);
                }
            }
            const agent = {
                pluginInstanceId: pluginInstanceId || (existing && existing.pluginInstanceId) || "",
                storeId: pageChanged ? "" : (storeId || (existing && existing.storeId) || ""),
                storeName: requestedStoreName || (pageChanged ? "" : (existing && existing.storeName) || ""),
                pageUrl: asText(input.pageUrl) || (existing && existing.pageUrl) || "",
                pageType: asText(input.pageType) || (existing && existing.pageType) || "",
                pluginVersion: asText(input.pluginVersion) || (existing && existing.pluginVersion) || "",
                lastSeenAt: now,
                lastClaimedJobId: pageChanged ? "" : (existing && existing.lastClaimedJobId || ""),
                pluginDetected,
                identityMatched: Boolean(input.identityMatched),
                schedulingProtocol: supportsScheduling(input) ? 1 : 0,
                executionRunProtocol: input.executionRunProtocol === 1 || existing?.executionRunProtocol === 1 ? 1 : 0,
                pageStoreName: requestedPageStoreName || (existing && existing.pageStoreName) || "",
                nameSource: asText(input.nameSource) || (existing && existing.nameSource) || "",
                nameConfidence: asText(input.nameConfidence) || (existing && existing.nameConfidence) || "",
                expectedCount: Number.isInteger(input.expectedCount) ? input.expectedCount : (existing && existing.expectedCount),
                completedCount: Number.isInteger(input.completedCount) ? input.completedCount : (existing && existing.completedCount),
                capturePhase: asText(input.capturePhase) || (existing && existing.capturePhase) || "",
                ingestPhase: asText(input.ingestPhase) || (existing && existing.ingestPhase) || "",
                pendingUploadCount: Number.isInteger(input.pendingUploadCount) ? input.pendingUploadCount : (existing && existing.pendingUploadCount) || 0,
                source: asText(input.source) || (existing && existing.source) || ""
                ,mallId: requestedMallId || existing?.mallId || "", executionMode: asText(input.executionMode) || existing?.executionMode || ""
                // 撤销记录不随心跳重建：清空它会让刚停止的轮次在下次心跳后重新可被启动。
                ,runRevocations: existing?.runRevocations || []
            };
            const index = existing
                ? (state.agents || []).indexOf(existing)
                : -1;
            if (index >= 0) state.agents[index] = { ...existing, ...agent };
            else state.agents = [agent, ...(state.agents || [])].slice(0, sql ? undefined : MAX_AGENTS);
            await writeState(state);
            const saved = index >= 0 ? state.agents[index] : agent;
            // 队列也可独立运行；只有配置仓库时才回填来源身份。
            if (saved.storeId && store && typeof store.attachSourceStore === "function") {
                await store.attachSourceStore({
                    pluginInstanceId: saved.pluginInstanceId,
                    sourceStoreId: saved.storeId,
                    sourceStoreName: saved.storeName || saved.pageStoreName,
                    pageStoreName: saved.pageStoreName
                }).catch(() => {});
            }
            return summarizeAgent(saved);
        });
    }

    /**
     * 创建跨店任务：服务器只负责接收、存储、下发，不解读平台返回值、也不判断商品是否重复。
     * 去重只针对同一操作编号的请求重传；人工再次发送生成独立任务，不撤销旧凭证。
     * 同店同货号的重复判断由目标店插件按货号自行检索完成，投递与平台执行名额分离。
     */
    async function createJob(input = {}, access = null) {
        return withLock(async () => {
            const sourceStoreId = asText(input.sourceStoreId);
            const targetStoreId = asText(input.targetStoreId);
            const targetStoreName = asText(input.targetStoreName);
            await assertJobAccess({ sourceStoreId, targetStoreId }, access);
            const requestIdentity = jobRequestIdentity(input, access);
            // 幂等检查先于来源读取与在线校验：已提交但响应丢失后，重放不能新建或覆盖原任务。
            const state = await readState();
            const existing = requestIdentity && state.jobs.find(job => job.id === requestIdentity.id);
            if (existing) {
                if (existing.requestHashKey !== requestIdentity.hash) throw httpError("发送请求编号已用于不同内容", 409);
                return summarizeJob(existing);
            }
            // requireOnline 由新版网页明确传入；保留旧任务台接口的“只核验”语义，确保升级不改变历史任务。
            const manualDelivery = input.requireOnline === true;
            // 新增接口必须由本次操作明确授权；升级程序不会把历史任务变成自动创建。
            const directCreate = input.directCreate === true;
            if (directCreate && (!manualDelivery || input.complianceVersion !== "V2.0")) throw httpError("请确认商品合规声明后再创建", 400);
            const sourceBatchId = asText(input.sourceBatchId);
            const requestedIds = unique(input.spuIds);
            // SQL 状态机仍按任务汇总明细；限制单任务规模，避免回执在持锁期间无界读取。
            if (sql && requestedIds.length > 200) throw httpError("单个任务最多200件，请分批下发", 400);
            if (!sourceStoreId || !targetStoreId || !sourceBatchId || !requestedIds.length) {
                throw httpError("sourceStoreId、targetStoreId、sourceBatchId、spuIds 不能为空", 400);
            }
            const batch = await store.getBatch(sourceBatchId);
            if (!batch) throw Object.assign(httpError("来源批次不存在", 404), { code: 'bulk_product_invalid' });
            const batchStoreId = asText(batch.sourceStoreId);
            if (!batchStoreId) throw httpError("该批次没有来源店记录，请用来源店插件重新采集后再创建任务", 409);
            if (batchStoreId !== sourceStoreId) {
                throw httpError("来源店与该批次记录的采集店铺不一致", 409);
            }
            if (deletedStores && (await deletedStores.isDeleted(sourceStoreId) || await deletedStores.isDeleted(targetStoreId))) {
                throw httpError("来源或目标店铺已删除，不能继续下发", 409);
            }
            // 同店发送是合法操作，但必须由网页在本次发送前单独确认，旧页面不能静默绕过提示。
            if (batchStoreId === targetStoreId && input.sameStoreConfirmed !== true) {
                throw httpError(`请确认是否发送到商品来源店铺「${asText(batch.sourceStoreName || batch.shopName) || batchStoreId}」`, 409);
            }
            let batchProducts = (batch.products || []).filter((product) => requestedIds.includes(asText(product.spuId)));
            const missingIds = requestedIds.filter((id) => !batchProducts.some((product) => asText(product.spuId) === id));
            // 人工下发只检查来源资料未丢失，不用字段完整度替平台做发布判断；旧身份核验任务沿用历史状态。
            const notReadyIds = manualDelivery ? [] : batchProducts.filter((product) => !product.ready).map((product) => asText(product.spuId));
            const overview = store.transferRows
                ? await store.transferRows(requestedIds, sourceStoreId)
                : await store.listOverview();
            if (missingIds.length) throw Object.assign(httpError(`来源批次中没有这些 SPU：${missingIds.join("、")}`, 400), { code: 'bulk_product_invalid' });
            if (manualDelivery) {
                if (!store.verifyBatchTransfer) throw httpError("仓库未启用来源原包一致性核验", 503);
                batchProducts = await store.verifyBatchTransfer(batch, batchProducts);
                batchProducts.forEach(assertCapturedSource);
            }
            if (input.expectedVersions && batchProducts.some(product => input.expectedVersions[product.spuId] !== makeProductVersion(product))) {
                throw Object.assign(httpError("来源商品在批量确认后已变化，请重新确认新版本后发送", 409), { code: 'bulk_product_invalid' });
            }
            // 历史来源红标仅供排查；平台拒绝只属于本次商品版本和目标店，不能封禁其他目标店。
            // 网页只允许下发给已登记核验身份、且近期仍在心跳的新版插件。
            // 这条检查是“选择目标店”与“实际能接收到商品包”之间的必要因果约束。
            const targetAgent = (state.agents || []).find((agent) => asText(agent.storeId) === targetStoreId);
            if (directCreate && targetAgent?.executionRunProtocol === 1) {
                const run = requireExecutionRun(targetAgent, input.bulkId ? input.executionRunId : targetAgent.executionRun?.id);
                input = { ...input, executionRunId: run.id };
            }
            // 离线是可恢复的接收条件，返回503让持久化分发退避；身份与版本错误仍须人工处理。
            if (manualDelivery && (!targetAgent || !isAgentOnline(targetAgent) || !targetAgent.pluginDetected)) throw Object.assign(httpError("目标店插件暂时离线，等待恢复连接", 503), { code: 'target_offline' });
            if (directCreate && !/^10\.(?:9|[1-9]\d)\./.test(asText(targetAgent?.pluginVersion))) throw httpError("接口创建需要目标店安装 10.9.0 或更新的 10.x 插件", 409);
            if (manualDelivery) {
                if (!hasTransferIntegrityPlugin(targetAgent || {})) throw httpError("请将目标店插件更新至 10.10.56 或更新的 10.x 版本，以启用统一结果状态和判重等待保护", 409);
            }
            if (manualDelivery && (!targetAgent || !isAgentOnline(targetAgent) || !targetAgent.pluginDetected || !targetAgent.identityMatched || !hasManualTransferPlugin(targetAgent))) {
                throw httpError("目标店插件不在线、身份未核验或版本不支持接收上传任务", 409);
            }
            if (targetAgent && (directCreate || targetStoreName && asText(targetAgent.storeName)) && !taskIdentityMatches({ targetStoreId, targetStoreName, directCreate }, targetAgent)) {
                throw httpError("目标店身份与已检测插件不一致", 409);
            }
            // 新点击是独立投递，不按历史 SPU 拦截或覆盖旧任务；同次请求仍由 requestIdentity 去重。
            // 保留旧任务的执行凭证和回执，目标店是否已有商品由插件检查。
            const now = new Date().toISOString();
            const items = batchProducts.map((product) => {
                const snapshot = canonicalProductSnapshot(product);
                const version = makeProductVersion(product);
                return {
                    spuId: asText(product.spuId),
                    title: asText(product.title),
                    productVersion: version,
                    dataHash: version,
                    snapshot,
                    ...(manualDelivery ? { transferIntegrity: transferManifest(snapshot) } : {}),
                    directCreate,
                    status: manualDelivery || product.ready ? "queued" : "blocked",
                    reason: manualDelivery || product.ready ? "" : "历史核验任务资料未齐",
                    claimedByStoreId: "",
                    claimedAt: "",
                    claimExpiresAt: "",
                    claimToken: "",
                    openingAt: "",
                    openedAt: "",
                    verifiedAt: "",
                    pluginMissingAt: "",
                    retryAt: "",
                    pluginDetected: false,
                    submitted: false,
                    published: false
                };
            });
            const job = {
                executionRunId: directCreate ? asText(input.executionRunId) : "",
                id: requestIdentity?.id || randomUUID().slice(0, 12),
                ...(requestIdentity ? { requestHashKey: requestIdentity.hash } : {}),
                ...(input.bulkId ? { bulkId: asText(input.bulkId).slice(0, 80) } : {}),
                createdAt: now,
                updatedAt: now,
                status: missingIds.length ? "blocked_preflight" : (items.some((item) => item.status === "queued") ? "queued" : "blocked_preflight"),
                mode: manualDelivery ? "manual-plugin-upload" : "identity-open-only",
                directCreate,
                complianceVersion: directCreate ? "V2.0" : "",
                complianceConfirmedAt: directCreate ? now : "",
                // 记录本次同店发送的明确确认，便于追溯；不改写或自动重试历史任务。
                sameStoreConfirmed: batchStoreId === targetStoreId && input.sameStoreConfirmed === true,
                sameStoreConfirmedAt: batchStoreId === targetStoreId ? now : "",
                sourceStoreId,
                sourceStoreName: asText(input.sourceStoreName || batch.sourceStoreName || batch.shopName || overview.shopName || ""),
                targetStoreId,
                targetStoreName: asText(input.targetStoreName),
                sourceBatchId,
                spuIds: requestedIds,
                items,
                preflight: {
                    missingIds,
                    notReadyIds,
                    readyCount: items.filter((item) => item.status === "queued").length,
                    productCount: items.length,
                    note: manualDelivery
                        ? (directCreate ? "已授权按合规声明通过新增接口创建；接收后自动处理，结果不明禁止重试，创建不等于站点上架。" : "历史手动任务：插件接收后由操作者填写，升级不会自动创建。")
                        : "历史核验任务：本机工人读取已打开目标店后可代领，核验页面店名并检测采集插件；不保存草稿、不发布。"
                }
            };
            // job与逐商品工作共享sql.run事务；来源快照先暂存，冻结的归属/轮次由桥接复核。
            if (accountExecution && directCreate) await accountExecution.enqueueJob({
                connection: sql.transactionConnection(), job, access, targetAgent
            });
            await appendJobActivity(job, manualDelivery ? "web_task_created" : "legacy_task_created", {
                actor: "warehouse-web",
                storeId: targetStoreId,
                message: manualDelivery ? `网页已把 ${items.length} 个商品排队给已检测的目标插件` : `历史任务已创建，等待本机工人核验`
            });
            // 任务历史达到上限时只淘汰已结束记录；若全是活跃任务则明确拒绝，不能丢掉可领取快照。
            const nextJobs = [job, ...(state.jobs || [])];
            while (!sql && nextJobs.length > MAX_JOBS) {
                const removableOffset = [...nextJobs].reverse().findIndex((entry) => isTerminalJob(entry));
                if (removableOffset < 0) throw httpError("任务历史已达到上限，请先处理或取消已结束任务", 409);
                const removableIndex = nextJobs.length - 1 - removableOffset;
                nextJobs.splice(removableIndex, 1);
            }
            state.jobs = nextJobs;
            await writeState(state);
            return summarizeJob(job);
        });
    }

    /** 原子记录一次性创建许可；提交后不释放重试权，防止超时导致重复商品。 */
    async function directProgress(input = {}) {
        return withLock(async () => {
            const state = await readState();
            const job = state.jobs.find(j => j.id === asText(input.jobId) && j.targetStoreId === asText(input.storeId));
            const item = job?.items.find(i => i.spuId === asText(input.spuId));
            const agent = state.agents.find(a => a.storeId === asText(input.storeId) && a.pluginInstanceId === asText(input.pluginInstanceId));
            // 结果属于签发时的尝试，不属于此刻打开的商城；切店后仍允许原实例凭原许可补报。
            const authorizedReceipt = input.phase !== 'begin' && item?.directAttemptId && item.directAttemptId === input.attemptId
                && item.directPluginInstanceId === input.pluginInstanceId && item.targetMallId === asText(input.mallId);
            // 轮次已经失效时先报轮次原因：此时身份检查也会失败，但不能让用户误以为是店铺身份问题。
            // 不要求 claimToken 仍匹配，也不要求任务仍在队列里——停止时凭证被清空、外部终止还会把
            // 任务整条清走，这两条路径都必须给出"轮次已结束"而不是模糊的身份错误。
            const requestedPhase = asText(input.phase) === "transient" ? "unknown" : asText(input.phase);
            const runId = asText(input.executionRunId) || asText(job?.executionRunId);
            if (requestedPhase === 'begin' && runId && (job ? job.directCreate : true)
                && (isRevoked(agent, runId) || !agent?.executionRun?.active
                    || agent.executionRun?.id !== runId
                    || !(Date.parse(agent?.executionRun?.expiresAt) > Date.now()))) {
                throw runInactive();
            }
            if (!job?.directCreate || job.complianceVersion !== "V2.0" || !item || !item.claimToken || item.claimToken !== input.claimToken
                || (!authorizedReceipt && (!agent?.identityMatched || !agent.pluginDetected || !taskIdentityMatches(job, agent, input)))) throw httpError("接口创建身份或授权不匹配", 409);
            // 旧插件仍可能把网络超时上报 transient；不确定平台是否受理时只能隔离，不能生成第二次提交。
            // 兼容旧插件两条确定的判重文案；新插件直接发送 duplicate_exists，不再靠宽泛关键词猜失败原因。
            const oldDuplicate = input.phase === "preflight_failed" && !input.attemptId
                && (/^目标店已存在商品 .+，按(?:SKU货号|商品货号)确认，未创建/.test(input.reason || "")
                    || input.reason === "同一批次已有相同货号，本件跳过，避免批次内重复创建");
            const phase = oldDuplicate ? "duplicate_exists" : asText(input.phase) === "transient" ? "unknown" : asText(input.phase);
            let accountAttemptId = '';
            // 只有新增许可受页面轮次约束；旧轮已提交的结果仍可通过原凭证补报。
            if (phase === 'begin' && (agent.executionRunProtocol === 1 || job.executionRunId)) {
                requireExecutionRun(agent, input.executionRunId);
                if (job.executionRunId !== input.executionRunId) throw runInactive();
            }
            // 旧回执队列只认识 preflight_failed；回复兼容状态以确认收妥，数据库仍使用准确的拒绝/跳过状态。
            const receiptState = () => input.phase === 'preflight_failed' && ['rejected', 'duplicate_exists'].includes(item.directState) ? 'preflight_failed' : item.directState;
            if (job.status === "cancelled" || item.status === "cancelled") throw httpError("任务已取消，不能补写执行状态", 409);
            if (input.directRetrySequence !== undefined && Number(input.directRetrySequence) !== Number(item.directRetrySequence || 0)) throw httpError("回执重试轮次已失效", 409);
            const receiptId = asText(input.receiptId);
            if (receiptId && !/^[a-zA-Z0-9-]{16,80}$/.test(receiptId)) throw httpError("回执编号不合法", 400);
            const receiptHash = createHash("sha256").update(JSON.stringify([oldDuplicate ? 'preflight_failed' : phase, input.attemptId || "", input.productId || "", input.verified === true, input.reason || ""])).digest("hex");
            const savedReceipt = (item.directReceipts || []).find(receipt => receipt.id === receiptId);
            if (receiptId && savedReceipt) {
                if (savedReceipt.hash !== receiptHash) throw httpError("回执编号已绑定其他结果", 409);
                return { attemptId: item.directAttemptId || "", state: receiptState(), acknowledged: true };
            }
            /** 回执与业务状态同事务提交；响应丢失后重传相同编号只确认，不重复改状态或写日志。 */
            const rememberReceipt = () => {
                if (receiptId) item.directReceipts = [...(item.directReceipts || []), { id: receiptId, hash: receiptHash }].slice(-16);
            };
            // 旧版曾把临时故障排成自动重试；升级不能把这类未核对请求当成第一次新增。
            if (phase === "begin" && item.lastTransientAttemptId && !item.directAttemptId && !Number(item.directRetrySequence || 0)) {
                item.directAttemptId = item.lastTransientAttemptId;
                item.directState = "unknown";
                item.status = "upload_opened";
                item.reason = "历史平台临时故障结果尚未核对，升级后停止自动重发，请先核对目标店";
                item.directUpdatedAt = new Date().toISOString();
                job.updatedAt = item.directUpdatedAt;
                refreshJobStatus(job);
                await appendJobActivity(job, "direct_unknown", { actor: "server", storeId: job.targetStoreId, message: item.reason });
                await writeState(state);
                return { attemptId: item.directAttemptId, state: "unknown", resumed: true };
            }
            // 新任务只有收到目标插件的存储摘要回执才发创建许可；历史已授权任务保持恢复兼容。
            if (phase === "begin" && item.transferIntegrity && item.receivedSnapshotSha256 !== item.transferIntegrity.sha256) throw httpError("目标插件尚未确认商品数据完整接收，请更新插件或等待重新领取", 409);
            // 恢复授权只返回原尝试且标记恢复，客户端不能把它当成新的提交许可。
            if (phase === "begin" && input.authorizationKey && item.authorizationKey === input.authorizationKey
                && item.directPluginInstanceId === input.pluginInstanceId && item.requestHash === input.requestHash
                && item.targetMallId === asText(input.mallId) && item.directAttemptId) return {attemptId:item.directAttemptId,state:item.directState,resumed:true};
            if (phase === "begin" && !hasTransferIntegrityPlugin(agent)) throw httpError("请更新目标插件至 10.10.56 后继续创建，旧版本仍可补报执行结果", 409);
            // 已授权尝试被平台明确拒绝的终态回执：商品确定没有创建，必须把平台原文写进任务，
            // 不能因为“已授权过”而判为重复提交，否则运营在工作日志里只会看到旧原因，问题无法定位。
            const attemptRejected = ["preflight_failed", "rejected"].includes(phase) && item.directAttemptId
                && item.directAttemptId === asText(input.attemptId) && item.directPluginInstanceId === input.pluginInstanceId
                && ["creating", "unknown"].includes(item.directState);
            if (attemptRejected) {
                item.directState = "rejected";
                item.status = "failed";
                item.reason = asText(input.reason).slice(0, 1000);
                item.directUpdatedAt = new Date().toISOString();
                await appendJobActivity(job, "direct_rejected", {actor:"local-cli",storeId:job.targetStoreId,spuId:item.spuId,message:item.reason});
                refreshJobStatus(job);
                job.updatedAt = item.directUpdatedAt;
                rememberReceipt();
                await writeState(state);
                return {attemptId:item.directAttemptId, state:receiptState()};
            }
            // 已授权回执允许短时离线后补传；只有新授权必须核验在线状态。
            if (phase === "begin" && !isAgentOnline(agent)) throw httpError("目标插件离线，不能开始创建", 409);
            // 完成回执重传只接受同一实例、尝试和商品编号，不能覆盖既有结果。
            if (phase === "created" && item.directState === "created"
                && item.directPluginInstanceId === input.pluginInstanceId && item.directAttemptId === input.attemptId
                && item.createdProductId === asText(input.productId) && input.verified === true) {
                rememberReceipt();
                await writeState(state);
                return {attemptId:item.directAttemptId, state:item.directState};
            }
            if (["begin", "preflight_failed", "duplicate_exists"].includes(phase)) {
                if (!/^10\.(?:9|[1-9]\d)\./.test(asText(agent.pluginVersion))) throw httpError("目标插件需要升级到10.9.0", 409);
                // unknown 不是失败：即使插件查不到货号，也不能从回执通道自动解锁新 attempt。
                // 人工确认重试必须先调用 directRetry，让旧 attempt 留痕并把任务重新排到队尾。
                if (item.status !== "received" || item.directState) throw httpError("任务尚未明确结束，不能重复提交；结果未知请人工确认重试", 409);
                // 排队之前也检查授权键与请求指纹，畸形请求不能占据公平队列的前排。
                if (phase === 'begin' && (!/^[a-f0-9]{64}$/.test(asText(input.requestHash)) || !/^\d+$/.test(asText(input.mallId))
                    || !/^[a-zA-Z0-9-]{16,80}$/.test(asText(input.authorizationKey)))) throw httpError('新增请求指纹、商城或稳定授权键缺失', 400);
                if (accountExecution) {
                    // 预检失败/判重也只能结束当前授权工作；begin另取包含unknown的持久全局许可。
                    if (!await accountExecution.canClaim({ connection: sql.transactionConnection(), job, item })) {
                        throw httpError('publish_work_not_authorized', 409);
                    }
                    if (phase === 'begin') {
                        const policy = options.scheduler?.snapshot() || { limit: 2, paused: false };
                        const permit = await accountExecution.begin({ connection: sql.transactionConnection(), job, item,
                            attemptId: randomUUID(), limit: policy.limit, paused: policy.paused });
                        if (!permit.granted) {
                            options.scheduler?.demand();
                            const scheduling = { protocol: 1, action: 'wait', reasonCode: 'direct_capacity_wait', retryAfterMs: 15000 };
                            if (supportsScheduling(input)) return { state: 'waiting', scheduling };
                            throw Object.assign(httpError('direct_capacity_wait', 429), { retryAfter: 15 });
                        }
                        accountAttemptId = permit.attemptId;
                    }
                } else if (phase === "begin") {
                    const scheduled = supportsScheduling(input) && supportsScheduling(agent);
                    const policy = options.scheduler?.snapshot() || { limit: 4, paused: false };
                    const limit = scheduled ? policy.limit : Math.min(MAX_DIRECT_PUBLISH_STORES, policy.limit);
                    const occupied = new Set(state.jobs.filter(j => j.status !== "cancelled" && j.items.some(i => i !== item && !TERMINAL_ITEM_STATUSES.has(i.status)
                        && ["creating", "unknown"].includes(i.directState))).map(j => j.targetStoreId));
                    const executing = new Set(state.jobs.filter(j => j.status !== "cancelled" && j.items.some(i => i !== item && !TERMINAL_ITEM_STATUSES.has(i.status) && i.directState === "creating")).map(j => j.targetStoreId));
                    // 账户维度：同一账户同时只允许一家店在执行，账户内部其余店铺排队等待。
                    // 这样 A 账户的多家店不会占满全局名额，B 账户仍能并行工作。
                    const jobAccount = accountResolver ? await accountResolver.resolve(job.targetStoreId) : '';
                    const accountBusy = await accountHasRunningStore(state, job, item, executing, jobAccount);
                    // SQL 模式看不到同账户其他店铺的行，由 canBeginDirect 返回 'account' 指出真实原因。
                    const sqlVerdict = sql ? await sql.canBeginDirect(job.targetStoreId, limit, scheduled, jobAccount) : true;
                    const waitingOnAccount = accountBusy || sqlVerdict === 'account';
                    if (occupied.has(job.targetStoreId) || waitingOnAccount || policy.paused || (!sql && executing.size >= limit)
                        || (sql && sqlVerdict !== true)) {
                        options.scheduler?.demand();
                        if (scheduled) {
                            const scheduling = { protocol: 1, action: 'wait', reasonCode:
                                occupied.has(job.targetStoreId) || waitingOnAccount ? 'store_execution_wait' : policy.reasonCode || 'direct_capacity_wait', retryAfterMs: 15000 };
                            if (item.scheduling?.reasonCode !== scheduling.reasonCode) {
                                item.scheduling = scheduling;
                                item.reason = occupied.has(job.targetStoreId) ? '等待本店上一件结果核对'
                                    : waitingOnAccount ? '同一账户的另一家店正在执行，排队等待' : '等待服务端执行名额，自动继续';
                                job.updatedAt = new Date().toISOString(); await writeState(state);
                            }
                            return { state: 'waiting', scheduling };
                        }
                        // 尚未生成 attempt 的等待是调度状态，不标红、不修改领取凭证，插件稍后重新申请。
                        const error = httpError("direct_capacity_wait", 429);
                        error.retryAfter = 15;
                        throw error;
                    }
                }
                if (phase === "begin" && agent.executionMode === "plugin-api") {
                    if (agent.mallId !== asText(input.mallId) || job.targetStoreId !== `temu:${input.mallId}`) throw httpError("目标商城不匹配",409);
                    if (!/^[a-zA-Z0-9-]{16,80}$/.test(asText(input.authorizationKey))) throw httpError("缺少稳定授权键",400);
                }
                if (phase === "begin" && (!/^[a-f0-9]{64}$/.test(asText(input.requestHash)) || !/^\d+$/.test(asText(input.mallId)))) throw httpError("新增请求指纹或目标商城标识缺失", 400);
                item.directState = phase === "begin" ? "creating" : phase;
                delete item.scheduling;
                item.status = phase === "begin" ? "upload_opened" : phase === "duplicate_exists" ? "skipped" : "failed";
                item.directAttemptId = accountAttemptId || randomUUID();
                item.directPluginInstanceId = input.pluginInstanceId;
                item.authorizationKey = asText(input.authorizationKey);
                item.requestHash = asText(input.requestHash);
                item.targetMallId = asText(input.mallId);
            } else {
                if (item.directPluginInstanceId !== input.pluginInstanceId) throw httpError("创建结果插件实例不匹配", 409);
                if (!["created", "unknown"].includes(phase) || !["creating", "unknown"].includes(item.directState) || item.directAttemptId !== input.attemptId) throw httpError("接口结果不能覆盖当前任务", 409);
                if (phase === "created" && (!/^\d{6,20}$/.test(asText(input.productId)) || input.verified !== true)) throw httpError("缺少平台回查的新商品编号", 400);
                // 服务器只记录插件上报的结果，不解读平台返回值、也不替插件下结论。
                item.directState = phase;
                item.status = phase === "created" ? "uploaded" : "upload_opened";
                if (/^\d{6,20}$/.test(asText(input.productId))) item.createdProductId = asText(input.productId);
                item.submitted = phase === "created";
                item.published = false;
            }
            item.reason = asText(input.reason).slice(0, 1000);
            item.directUpdatedAt = new Date().toISOString();
            await appendJobActivity(job, `direct_${item.directState}`, {actor:"local-cli",storeId:job.targetStoreId,spuId:item.spuId,message:item.reason});
            refreshJobStatus(job);
            job.updatedAt = item.directUpdatedAt;
            rememberReceipt();
            await writeState(state);
            return {attemptId:item.directAttemptId, state:receiptState()};
        });
    }

    /**
     * 人工确认后重置一个卡住的商品。旧 attempt 永不复用，商品会带着新的排队序号回到队尾，
     * 由插件重新做货号检索；服务器只维护内部任务互斥，不替代目标店页面的重复判断。
     *
     * 允许重置的范围必须覆盖所有“插件侧已经停下、服务器却仍在占位”的情况，否则这些项目会永久
     * 挡住同店同货号的下一次下发，而界面上没有任何入口能了结它们：
     * - unknown / preflight_failed / rejected：本次尝试已结束，只是结果未知或平台拒绝；
     * - received 且无 directState：快照已送达插件但预检从未开始，平台侧没有产生任何提交；
     * - creating 且长时间无进度：提交中途插件掉线，需要确认后才允许重置。
     */
    async function directRetry(input = {}, access = null) {
        return withLock(async () => {
            const state = await readState();
            const job = (state.jobs || []).find(entry => entry.id === asText(input.jobId) && entry.targetStoreId === asText(input.storeId));
            const item = job?.items.find(entry => entry.spuId === asText(input.spuId));
            if (!job?.directCreate || !item) throw httpError("任务不存在", 404);
            await assertJobAccess(job, access);
            // 新账本的work身份绑定真实轮次；人工重试须先核对原许可，不能复活终态或释放unknown。
            if (accountExecution) throw httpError('publish_retry_requires_new_job_after_reconciliation', 409);
            if (input.confirmed !== true) throw httpError("必须人工确认后才能重试", 400);
            // 人工核对后允许把这一项交给新轮次；自动领取和旧清单没有这条重新授权路径。
            if (job.executionRunId) {
                const agent = state.agents.find(a => a.storeId === job.targetStoreId);
                job.executionRunId = requireExecutionRun(agent, agent?.executionRun?.id).id;
            }
            const now = new Date().toISOString();
            const directState = asText(item.directState);
            // 已取消的项目带着历史 directState 残留在任务记录里，人工重试绝不能让它们复活，
            // 否则运营取消过的商品会被重新排进上传队列。
            if (item.status === "cancelled") throw httpError("任务已取消，不能人工重试", 409);
            // 结果未知、平台明确拒绝或上传前预检失败都已结束旧 attempt；人工确认后才允许重新排队。
            const finishedAttempt = ["unknown", "preflight_failed", "rejected"].includes(directState);
            // 快照已送达、预检未开始：任务还没在平台侧留下任何痕迹，重新排队不会造成重复创建。
            const neverSubmitted = item.status === "received" && !directState;
            // 提交中断的项目只有超过静默窗口才允许重置，避免把仍在页面里跑着的提交判成失败。
            const abandonedSubmit = directState === "creating"
                && Date.parse(asText(item.directUpdatedAt)) < Date.now() - DIRECT_STALE_MS;
            if (!finishedAttempt && !neverSubmitted && !abandonedSubmit) throw httpError("当前任务尚未结束，不能人工重试", 409);
            // 历史任务里同一个货号可能同时挂在多个任务下（同店同商品被多次下发）。逐个重试时必须保持
            // 同店同货号只有一个在途项，否则两件都会通过插件的货号对比并各自提交，重复创建就是这么来的。
            const conflicting = (state.jobs || []).flatMap(entry => entry.targetStoreId === job.targetStoreId
                ? (entry.items || []).filter(other => other !== item
                    && other.spuId === item.spuId
                    && !TERMINAL_ITEM_STATUSES.has(asText(other.status))
                    && (DIRECT_IN_FLIGHT_STATUSES.has(asText(other.status)) || asText(other.directState) === "creating"))
                : []);
            if (conflicting.length) throw httpError("同店同货号已有任务在排队或提交中，请等它结束后再重试该商品", 409);
            // 人工重试改变当前许可，但必须保留旧提交的最小证据，不能清理成从未执行过。
            if (item.directAttemptId) item.directAttemptHistory = [...(item.directAttemptHistory || []), {
                attemptId: item.directAttemptId, state: item.directState, productId: item.createdProductId || '',
                pluginInstanceId: item.directPluginInstanceId, mallId: item.targetMallId, requestHash: item.requestHash,
                retrySequence: Number(item.directRetrySequence || 0), closedAt: now
            }];
            item.directRetrySequence = Number.isFinite(Number(item.directRetrySequence)) ? Number(item.directRetrySequence) + 1 : 1;
            item.directRetryRequestedAt = now;
            item.directState = "";
            // 先进入短暂等待，让当前队列中的商品先行；到点后 expireStaleLeases 会把它放回队尾可领取区。
            item.status = "retry_wait";
            item.retryAt = new Date(Date.now() + 1000).toISOString();
            item.reason = neverSubmitted
                ? "已人工确认，未提交到平台的商品重新排队等待插件处理"
                : "已人工确认，重新排队等待插件货号复核";
            item.directAttemptId = "";
            item.directPluginInstanceId = "";
            item.authorizationKey = "";
            item.requestHash = "";
            item.targetMallId = "";
            item.submitted = false;
            item.published = false;
            item.directUpdatedAt = now;
            await appendJobActivity(job, "direct_manual_retry", { actor: "warehouse-web", storeId: job.targetStoreId, spuId: item.spuId, message: item.reason });
            refreshJobStatus(job);
            job.updatedAt = now;
            await writeState(state);
            return { jobId: job.id, spuId: item.spuId, state: "queued_for_retry", retrySequence: item.directRetrySequence };
        });
    }

    /**
     * 该任务所属账户是否已有别的店铺在执行中。
     *
     * 规则：一个账户同时只处理自己的一家店，其余店铺排队等待；账户之间互不挤占。
     * 判定依据是店铺认领关系（任务不存账号），未认领店铺退回按店铺处理——
     * 那种情况由"同店互斥"负责，不能因为查不到账号就拒绝服务。
     */
    async function accountHasRunningStore(state, job, item, executing, account = '') {
        if (!accountResolver || !account) return false;
        const targetStore = asText(job?.targetStoreId);
        // 只看正在执行的店铺（executing 已排除 cancelled 与终态项）。
        for (const storeId of executing) {
            if (storeId === targetStore) continue;
            const other = await accountResolver.resolve(storeId);
            if (other && other === account) return true;
        }
        return false;
    }

    /** 页面轮次不是登录会话；短租约失效后必须重新人工启用，不能用心跳复活。 */
    function runInactive() {
        return Object.assign(httpError('本轮任务已结束，请在目标店启用新一轮后重新发送', 409), { code: 'execution_run_inactive' });
    }
    /**
     * 终结引入轮次之前创建的直推任务：它们没有可撤销的授权，也判断不出页面是否还在同一轮，
     * 放任留着只会变成"刷新后仍自动上传"的来源。归属证据（已提交尝试）一律保留。
     * 返回被终结的任务数与被保留的证据项数。
     */
    /**
     * 终结引入轮次之前创建的直推任务：它们没有可撤销的授权，也判断不出页面是否还在同一轮，
     * 放任留着只会变成"刷新后仍自动上传"的来源。归属证据（已提交尝试）一律保留。
     *
     * 判定依据是**目标店是否已启用轮次协议**，不是"任务有没有轮次"：
     * 旧协议店铺（未发轮次声明）本来就用无轮次任务工作，它的任务是现役的，不能终结。
     * 只有店铺已经进入轮次语义、任务却仍无轮次时，才说明这是升级前留下的遗留任务。
     */
    async function retireLegacyDirectJobs(state, storeId = "") {
        const only = asText(storeId);
        // 判定依据是目标店是否已启用轮次协议：升级到轮次的店铺，升级前留下的无轮次任务才终结。
        const runProtocolStores = new Set((state.agents || [])
            .filter(agent => agent.executionRunProtocol === 1 && asText(agent.storeId))
            .map(agent => asText(agent.storeId)));
        if (only) {
            if (!runProtocolStores.has(only)) return { retired: 0, kept: 0, cancelled: 0 };
            runProtocolStores.clear();
            runProtocolStores.add(only);
        }
        let retired = 0, kept = 0, cancelled = 0;
        const survivors = [];
        for (const job of state.jobs || []) {
            // 只处理"目标店已进入轮次协议、任务却没有轮次"的遗留记录。
            if (!job.directCreate || asText(job.executionRunId) || !runProtocolStores.has(asText(job.targetStoreId))) {
                survivors.push(job);
                continue;
            }
            let inFlight = 0;
            for (const item of job.items || []) {
                if (item.directAttemptId || ["creating", "unknown"].includes(item.directState)) { inFlight++; continue; }
                if (TERMINAL_ITEM_STATUSES.has(item.status)) continue;
                Object.assign(item, { status: "cancelled", reason: "历史任务未绑定页面轮次，已终止；请重新发送", claimToken: "",
                    claimedByStoreId: "", claimedAt: "", claimExpiresAt: "" });
                delete item.scheduling;
                cancelled++;
            }
            if (!inFlight) { retired++; continue; }
            kept += inFlight;
            job.updatedAt = new Date().toISOString();
            refreshJobStatus(job);
            survivors.push(job);
        }
        state.jobs = survivors;
        return { retired, kept, cancelled };
    }
    /**
     * 撤销记录按实例保存，不按店铺：同店换插件实例后，旧实例的撤销不能拦住新实例的合法启用。
     * 记录只增不改；容量上限按最旧优先淘汰，淘汰只影响防重放时长，不影响当前轮次状态。
     */
    function revocationList(agent) {
        const stored = Array.isArray(agent.runRevocations) ? agent.runRevocations : [];
        const nowMs = Date.now();
        return stored.filter(entry => entry && asText(entry.id) && nowMs - Date.parse(entry.at || "") < RUN_REVOCATION_TTL_MS);
    }
    function rememberRevocation(agent, id, reason) {
        const others = revocationList(agent).filter(entry => entry.id !== id);
        agent.runRevocations = [{ id, at: new Date().toISOString(), reason }, ...others].slice(0, MAX_RUN_REVOCATIONS);
    }
    function isRevoked(agent, id) {
        return revocationList(agent).some(entry => entry.id === id);
    }
    /** 到期只可由人工start建立新轮次，touch与领取不能把过期轮次续活。 */
    function requireExecutionRun(agent, id) {
        const run = agent?.executionRun;
        if (!run?.active || run.id !== id || run.storeId !== agent.storeId || !(Date.parse(run.expiresAt) > Date.now())) throw runInactive();
        return run;
    }
    /** 取消尚无平台执行许可的项；未知或已获许可项只保留回执，绝不能伪称撤回成功。 */
    async function clearUnstartedRun(state, storeId, keepRunId = '') {
        let cancelled = 0;
        for (const job of state.jobs.filter(job => job.directCreate && job.targetStoreId === storeId && (!keepRunId || job.executionRunId !== keepRunId))) {
            let count = 0;
            for (const item of job.items || []) {
                if (TERMINAL_ITEM_STATUSES.has(item.status) || item.directAttemptId || ['creating', 'unknown'].includes(item.directState)) continue;
                Object.assign(item, { status: 'cancelled', reason: '页面执行轮次已结束，未提交项已取消', claimToken: '', claimedByStoreId: '', claimedAt: '', claimExpiresAt: '' });
                delete item.scheduling;
                count++;
            }
            if (!count) continue;
            cancelled += count;
            job.updatedAt = new Date().toISOString();
            refreshJobStatus(job);
            await appendJobActivity(job, 'execution_run_cancelled', { actor: 'target-plugin', storeId, message: `页面轮次结束，取消${count}个未提交项` });
        }
        return cancelled;
    }
    /**
     * 外部终止时把该轮任务整条移出队列：未提交项作废，已提交/结果未知的项保留结果证据，
     * 因此不能整条删除记录——否则会丢掉平台可能已创建的凭证，造成同一商品重复创建。
     * 返回 {removed, kept}：removed 是可以完全消失的任务数，kept 是仍有在途结果的项数。
     */
    async function purgeRunJobs(state, storeId, runId, reason) {
        let removed = 0, kept = 0, cancelled = 0;
        const survivors = [];
        for (const job of state.jobs || []) {
            // 只清理本次终止轮次的任务；手动暂停走 clearUnstartedRun，不调用这里。
            if (!job.directCreate || job.targetStoreId !== storeId || asText(job.executionRunId) !== asText(runId)) {
                survivors.push(job);
                continue;
            }
            let inFlight = 0;
            for (const item of job.items || []) {
                // 已提交或结果未知的项必须留证据：它们可能已经在平台建成商品。
                if (item.directAttemptId || ["creating", "unknown"].includes(item.directState)) { inFlight++; continue; }
                if (TERMINAL_ITEM_STATUSES.has(item.status)) continue;
                Object.assign(item, { status: "cancelled", reason: `页面轮次已终止：${reason}`, claimToken: "",
                    claimedByStoreId: "", claimedAt: "", claimExpiresAt: "" });
                delete item.scheduling;
                cancelled++;
            }
            if (!inFlight) { removed++; continue; }
            kept += inFlight;
            job.updatedAt = new Date().toISOString();
            refreshJobStatus(job);
            await appendJobActivity(job, "execution_run_purged", { actor: "target-plugin", storeId, message: `页面轮次终止，清理未提交项并保留${inFlight}项待核对结果` });
            survivors.push(job);
        }
        state.jobs = survivors;
        if (removed) {
            // 任务已被移走，日志不能挂在它身上；按店铺单独记一条清除记录，供运营追溯。
            const entry = {
                at: new Date().toISOString(), type: "execution_run_cleared", spuId: "", storeId,
                actor: "target-plugin", jobId: "", sourceStoreId: "", sourceStoreName: "",
                targetStoreId: storeId, targetStoreName: "",
                message: `页面轮次终止：已从队列清除${removed}条任务（${reason}），作废${cancelled}个未提交项`
            };
            if (sql) await sql.appendLog(entry);
            else {
                const log = await readStoreWorkLog(storeId);
                log.entries.push(entry);
                await writeStoreWorkLog(log);
            }
        }
        return { removed, kept, cancelled };
    }
    /** start 必须比较上一轮编号；迟到的开始/停止不能覆盖新页面，重复请求只确认原轮次。 */
    async function controlExecutionRun(input = {}) {
        return withLock(async () => {
            const state = await readState(), storeId = asText(input.storeId);
            const instance = state.agents.find(a => a.pluginInstanceId === input.pluginInstanceId);
            // 原实例已经切店时停止通知只确认失效；旧店未提交项由同店维护事务清理，不触碰新店轮次。
            if (input.action === 'stop' && instance && instance.storeId !== storeId) return { stopped: true, stale: true };
            const agent = state.agents.find(a => a.storeId === storeId && a.pluginInstanceId === input.pluginInstanceId);
            if (!agent?.identityMatched || !agent.pluginDetected || input.identityMatched !== true || storeId !== `temu:${input.mallId}` || agent.mallId !== input.mallId) throw httpError('页面轮次店铺身份不匹配', 403);
            const id = asText(input.executionRunId), action = asText(input.action);
            if (!/^[a-zA-Z0-9-]{16,80}$/.test(id) || !['start', 'stop', 'touch'].includes(action)) throw httpError('执行轮次参数无效', 400);
            const old = agent.executionRun;
            // 停止先到时旧轮次已经不在，但仍要留下撤销记录；否则同一轮次的迟到启动会重新拿到授权。
            if (action === 'stop' && old?.id !== id) {
                if (!isRevoked(agent, id)) {
                    rememberRevocation(agent, id, 'stop_before_start');
                    await writeState(state);
                }
                return { stopped: true, stale: true };
            }
            if (action === 'start' && old?.id !== id && asText(input.previousRunId) !== asText(old?.id)) throw runInactive();
            // 已经撤销的轮次不能因为 previousRunId 恰好匹配就复活，撤销是不可逆终态。
            if (action === 'start' && isRevoked(agent, id)) throw runInactive();
            if (action === 'start' && old?.id === id) { requireExecutionRun(agent, id); return { executionRunId: id, expiresAt: old.expiresAt }; }
            if (action === 'touch') {
                requireExecutionRun(agent, id);
                if (isRevoked(agent, id)) throw runInactive();
            }
            const now = new Date().toISOString();
            agent.executionRunProtocol = 1;
            agent.executionRun = { id, storeId, active: action !== 'stop', expiresAt: new Date(Date.now() + 120000).toISOString(), updatedAt: now };
            // 停止也登记撤销，覆盖“旧轮次仍在、之后又有同 id 启动请求”的路径。
            if (action === 'stop') rememberRevocation(agent, id, 'stopped');
            const reason = asText(input.stopReason);
            // 只有明确声明为外部终止的原因才清除任务，判定用白名单而不是"非手动即外部"。
            // 已部署的 10.10.61 包不发送 stopReason；若默认按外部终止处理，操作者点"暂停"
            // （意图保留任务）会被误判成外部终止而清空队列，正好违反保留语义。
            // 反过来默认保留不会造成自动上传：轮次已撤销，遗留任务无法被领取。
            const isExternalStop = action === 'stop' && EXTERNAL_STOP_REASONS.has(reason);
            // 操作者主动暂停要保留任务，下次启用可继续，所以手动暂停不取消任何项：
            // 轮次已经失效，执行入口（requireExecutionRun）自然拦得住，不必作废数据。
            // 启用新轮次仍要清掉旧轮未提交项，否则旧轮清单会在新轮里继续下发。
            const cancelled = action === 'stop' && !isExternalStop
                ? 0 : await clearUnstartedRun(state, storeId, action === 'start' ? id : '');
            // 外部终止（刷新、升级、切店）把该轮任务整条清出队列；只有操作者主动暂停才保留任务。
            // 与停止写在同一事务里：授权撤销和队列清除必须一起生效，不能停在中间状态。
            const purge = isExternalStop ? await purgeRunJobs(state, storeId, id, reason) : null;
            await writeState(state);
            return { executionRunId: id, expiresAt: agent.executionRun.expiresAt, stopped: action === 'stop', cancelled,
                ...(purge ? { purged: purge } : {}) };
        });
    }
    /** 离线无法上报停止时，由服务端短租约清理；同店事务锁与 begin/分发共用。 */
    async function expireExecutionRun(input = {}) {
        return withLock(async () => {
            const state = await readState(), storeId = asText(input.storeId);
            const agent = state.agents.find(a => a.storeId === storeId);
            if (agent?.executionRunProtocol !== 1 && !state.jobs.some(j => j.targetStoreId === storeId && j.executionRunId)) return;
            const active = agent?.executionRun?.active && agent.executionRun.storeId === storeId && Date.parse(agent.executionRun.expiresAt) > Date.now();
            if (active) return;
            if (agent?.executionRun) agent.executionRun.active = false;
            await clearUnstartedRun(state, storeId);
            await writeState(state);
        });
    }
    async function cancelJob(id, access = null) {
        return withLock(async () => {
            const state = await readState();
            const job = (state.jobs || []).find((item) => item.id === asText(id));
            if (!job) throw httpError("job_not_found", 404);
            await assertJobAccess(job, access);
            if (job.items.some(item => !TERMINAL_ITEM_STATUSES.has(item.status) && ["creating", "unknown"].includes(item.directState))) throw httpError("接口提交已开始或结果待核对，不能取消或重发", 409);
            if (isTerminalJob(job) || job.status === "blocked_preflight") {
                throw httpError("已完成、失败、已取消或预检未通过的任务不能再取消", 409);
            }
            for (const item of job.items || []) {
                if (ACTIVE_ITEM_STATUSES.has(item.status)) {
                    item.status = "cancelled";
                    item.reason = "任务已取消";
                    item.claimedByStoreId = "";
                    item.claimedAt = "";
                    item.claimExpiresAt = "";
                    item.claimToken = "";
                }
            }
            refreshJobStatus(job);
            await appendJobActivity(job, "web_task_cancelled", {
                actor: "warehouse-web",
                storeId: job.targetStoreId,
                message: "网页已取消尚未完成的目标店任务"
            });
            job.updatedAt = new Date().toISOString();
            await writeState(state);
            return summarizeJob(job);
        });
    }
    /**
     * 取消本店还没提交到平台的待传项。
     *
     * 与 cancelJob 的区别：cancelJob 取消整条任务且要求无在途项；这里按店铺批量处理，
     * 逐项判断——只有"尚未提交"的项被取消，已提交或结果未知的项保留结果证据，
     * 因为那些可能已在平台建成商品，删掉凭证会导致重复创建。
     * 返回取消数与保留数，让界面能如实说明"取消了几个、保留了几个待核对"。
     */
    async function cancelStoreTasks(input = {}) {
        return withLock(async () => {
            const storeId = asText(input.storeId);
            if (!storeId) throw httpError('缺少目标店铺，无法取消任务', 400);
            const state = await readState();
            // 调用实例必须确实登记在该店铺名下：插件令牌只绑定实例、不绑定店铺，
            // 缺这道校验时，任一插件实例都能用别人的 storeId 取消其他店的任务。
            const instanceId = asText(input.pluginInstanceId);
            if (instanceId) {
                const bound = (state.agents || []).some(agent => asText(agent.storeId) === storeId && asText(agent.pluginInstanceId) === instanceId);
                if (!bound) throw httpError('插件实例与该店铺不匹配，不能取消其任务', 403);
            }
            let cancelled = 0, kept = 0;
            for (const job of state.jobs || []) {
                if (job.targetStoreId !== storeId || job.status === "cancelled") continue;
                let changed = false;
                for (const item of job.items || []) {
                    // 已提交或结果未知：保留证据，不做取消，也不改状态。
                    if (item.directAttemptId || ["creating", "unknown"].includes(item.directState)) { kept++; continue; }
                    if (TERMINAL_ITEM_STATUSES.has(item.status)) continue;
                    Object.assign(item, { status: "cancelled", reason: "操作者在插件面板取消了待上传任务", claimToken: "",
                        claimedByStoreId: "", claimedAt: "", claimExpiresAt: "" });
                    delete item.scheduling;
                    cancelled++; changed = true;
                }
                if (!changed) continue;
                job.updatedAt = new Date().toISOString();
                refreshJobStatus(job);
                await appendJobActivity(job, "store_tasks_cancelled", { actor: "target-plugin", storeId,
                    message: `操作者从插件面板取消本店待传任务` });
            }
            if (cancelled) await writeState(state);
            return { storeId, cancelled, kept };
        });
    }

    /**
     * 本机工人读取已打开目标店后也会走同一接口代领；必须携带目标店 storeId，且只能领取发给该店、尚未被别人占用的任务。
     */
    /** 本地快照本身就是持久化待确认记录；恢复只改变接收状态，不能重置执行尝试或跨越人工重试代次。 */
    async function recoverReceivedTasks(state, input, owner, occupiedByOther, now) {
        const replies = [], storeId = asText(input.storeId), instanceId = asText(input.pluginInstanceId);
        if (occupiedByOther || !owner || owner.pluginInstanceId !== instanceId || !owner.identityMatched || !owner.pluginDetected
            || input.identityMatched !== true || !hasSupportedPlugin(input) || !hasTransferIntegrityPlugin(input)
            || owner.executionMode === 'plugin-api' && (input.executionMode !== 'plugin-api' || storeId !== `temu:${input.mallId}`)) return replies;
        for (const ref of (Array.isArray(input.receivedReceipts) ? input.receivedReceipts : []).slice(0, 30)) {
            const job = state.jobs.find(entry => entry.id === asText(ref?.jobId) && entry.targetStoreId === storeId);
            const item = job?.items.find(entry => entry.spuId === asText(ref?.spuId));
            if (!item || job.mode !== 'manual-plugin-upload' || !taskIdentityMatches(job, owner, input)) continue;
            const reply = { jobId: job.id, spuId: item.spuId, status: item.status };
            if (job.status === 'cancelled' || TERMINAL_ITEM_STATUSES.has(item.status)) { replies.push({ ...reply, release: true }); continue; }
            // 本地接收恢复同样属于领取，不能用旧快照绕过当前账户槽与prepared代次。
            if (accountExecution && !await accountExecution.canClaim({ connection: sql.transactionConnection(), job, item })) continue;
            const sequence = Number(item.directRetrySequence || 0), localSequence = Number(ref.directRetrySequence || 0);
            if (sequence > localSequence) { replies.push({ ...reply, reload: true }); continue; }
            if (sequence !== localSequence || item.directState || !['queued', 'claimed', 'received'].includes(item.status)) continue;
            // 原领取尚在时必须匹配凭证；租约清除后只允许当前店铺实例用同版本快照摘要恢复。
            const receiptToken = asText(ref.claimToken);
            if (!receiptToken) continue;
            const recoveredReplay = item.status === 'received' && item.receiveRecovery?.pluginInstanceId === instanceId
                && item.receiveRecovery.claimToken === receiptToken;
            if (item.status !== 'queued' && !recoveredReplay && (!item.claimToken || item.claimToken !== receiptToken)) continue;
            if (!item.transferIntegrity && sql) await sql.loadSnapshot(item);
            const manifest = item.transferIntegrity || transferManifest(item.snapshot);
            if (asText(ref.snapshotSha256) !== manifest.sha256) continue;
            const changed = item.status !== 'received' || item.receivedSnapshotSha256 !== manifest.sha256;
            // 恢复响应也可能丢失，保留旧凭证别名供同实例同代次重放，不能每次重试重新换证。
            if (item.status === 'queued') item.receiveRecovery = { claimToken: receiptToken, pluginInstanceId: instanceId };
            item.transferIntegrity = manifest; item.claimToken ||= randomUUID(); item.claimedByStoreId = storeId;
            item.status = 'received'; item.receivedSnapshotSha256 = manifest.sha256; item.claimExpiresAt = '';
            if (changed) {
                item.reason = '目标插件已补报落盘摘要，商品接收已恢复'; job.updatedAt = now;
                await appendJobActivity(job, 'plugin_received', { actor: 'target-plugin', storeId, spuId: item.spuId, message: item.reason });
                refreshJobStatus(job);
            }
            replies.push({ ...reply, status: 'received', claimToken: item.claimToken, transferIntegrity: manifest });
        }
        return replies;
    }

    async function claimJobs(input = {}) {
        return withLock(async () => {
            const storeId = asText(input.storeId);
            const storeName = asText(input.storeName);
            const pageUrl = asText(input.pageUrl);
            if (!storeId) throw httpError("storeId 不能为空", 400);
            const state = await readState();
            const now = new Date().toISOString();
            const nowMs = Date.now();
            const claimed = [];
            const pluginDetected = hasSupportedPlugin(input);
            const pluginInstanceId = asText(input.pluginInstanceId);
            const currentManualTasks = Number.isInteger(input.pendingUploadCount) ? Math.max(0, input.pendingUploadCount) : 0;
            const prefetchLimit = supportsScheduling(input) ? 10 : MAX_MANUAL_TARGET_TASKS;
            const manualSlots = Math.max(0, prefetchLimit - currentManualTasks);
            const currentManualBytes = Number.isInteger(input.pendingUploadBytes) ? Math.max(0, input.pendingUploadBytes) : 0;
            const manualByteSlots = Math.max(0, MAX_MANUAL_TARGET_TASK_BYTES - Math.min(currentManualBytes, MAX_MANUAL_TARGET_TASK_BYTES));
            let manualClaimedCount = 0;
            let manualClaimedBytes = 0;
            // 同一店铺只能由当前已登记且在线的插件实例领取人工上传快照，防止第二个窗口抢到资料。
            const owner = (state.agents || []).find((agent) => asText(agent.storeId) === storeId && isAgentOnline(agent, nowMs));
            const occupiedByOther = Boolean(owner && asText(owner.pluginInstanceId)
                && asText(owner.pluginInstanceId) !== pluginInstanceId);
            if (owner?.executionRunProtocol === 1) {
                if (occupiedByOther || input.executionRunProtocol !== 1) throw runInactive();
                const run = requireExecutionRun(owner, input.executionRunId);
                run.expiresAt = new Date(Date.now() + 120000).toISOString();
            }
            // 新版商城任务禁止旧CLI代领；双通道不能同时执行写操作。
            if (owner?.executionMode === "plugin-api" && input.executionMode !== "plugin-api") throw httpError("该店任务只允许插件API领取",409);
            const identityMatched = Boolean(input.identityMatched);
            const receivedReceipts = await recoverReceivedTasks(state, input, owner, occupiedByOther, now);
            if (pluginDetected) {
                for (const job of state.jobs || []) {
                    expireStaleLeases(job, nowMs);
                    // CLI 专用领取不得顺带占用旧身份核验任务的租约。
                    if (input.manualUploadsOnly === true && job.mode !== "manual-plugin-upload") continue;
                    if (job.targetStoreId !== storeId) continue;
                    // 直推任务的轮次约束按双方协议分流，不能一刀切：
                    // - 店铺已启用轮次协议（或任务本身带轮次）：任务必须绑定当前活跃轮次，否则不下发。
                    //   无轮次的历史任务因此不再自动上传，这正是"刷新后仍自动上传"要消除的来源。
                    // - 店铺仍是旧协议（未发轮次声明）：没有轮次概念，任务照常领取，不能把旧店堵死。
                    if (job.directCreate && (owner?.executionRunProtocol === 1 || job.executionRunId)) {
                        if (!job.executionRunId || job.executionRunId !== input.executionRunId) continue;
                        if (owner?.executionRunProtocol === 1) requireExecutionRun(owner, input.executionRunId);
                    }
                    if (["cancelled", "failed", "blocked_preflight"].includes(job.status) || isTerminalJob(job)) continue;
                    if (job.targetStoreName && !taskIdentityMatches(job, owner, input)) continue;
                    // 本机 worker 只负责打开/核验页面；人工上传任务必须由目标店插件后台领取并落盘完整快照，
                    // 否则 worker 抢到领取租约却没有保存商品包，会让真正的目标插件被迫等待租约过期。
                    if (job.mode === "manual-plugin-upload" && input.claimManualUploads === false) continue;
                    if (job.mode === "manual-plugin-upload" && (
                        !hasManualTransferPlugin(input)
                        || input.identityMatched !== true
                        || !owner
                        || asText(owner.pluginInstanceId) !== pluginInstanceId
                        || (owner && !owner.pluginDetected)
                        || (owner && !owner.identityMatched)
                        || (owner && !hasManualTransferPlugin(owner))
                    )) continue;
                    if (job.mode === "manual-plugin-upload" && manualClaimedCount >= manualSlots) continue;
                    for (const item of job.items || []) {
                        if (job.mode === "manual-plugin-upload" && manualClaimedCount >= manualSlots) break;
                        // on模式只下发运行器准备完成的当前work，旧job或同job其他SPU都不能抢先领取。
                        if (accountExecution && !await accountExecution.canClaim({ connection: sql.transactionConnection(), job, item })) continue;
                        // 仅当前已核验实例的完整清单可证明快照丢失；一旦发过执行许可，绝不自动重新交付。
                        if (supportsScheduling(input) && supportsScheduling(owner) && input.inventoryComplete === true
                            && Array.isArray(input.heldTasks) && input.heldTasks.length === currentManualTasks && input.heldTasks.length <= 30
                            && job.mode === 'manual-plugin-upload' && item.status === 'received' && !item.directState && !item.directAttemptId
                            && !input.heldTasks.some(ref => ref.jobId === job.id && ref.spuId === item.spuId)) {
                            item.status = 'queued'; item.claimToken = ''; item.claimExpiresAt = '';
                            item.reason = '目标插件本地快照缺失，尚未授权执行，重新交付';
                            delete item.receiveRecovery;
                        }
                        const leaseExpired = item.claimExpiresAt && Date.parse(item.claimExpiresAt) < nowMs;
                        const sameLease = item.status === "claimed" && item.claimedByStoreId === storeId && !leaseExpired && item.claimToken;
                        // 已登记目标插件可以直接领取网页定向的人工上传任务；旧核验任务仍必须经过工人打开页面。
                        const canClaim = (item.status === "queued" && job.mode === "manual-plugin-upload")
                            || item.status === "opened"
                            || item.status === "plugin_missing"
                            || (item.status === "claimed" && leaseExpired)
                            || (item.status === "claimed" && !item.claimedByStoreId);
                        if (!canClaim) continue;
                        if (sameLease) continue;
                        // 插件降级后不能占走新协议任务，再因无法提供回执而阻塞队列。
                        if (item.transferIntegrity && !hasTransferIntegrityPlugin(input)) continue;
                        // 通过实例和租约资格后才解压正文，避免不可领取候选占用预取额度。
                        if (sql && job.mode === "manual-plugin-upload") await sql.loadSnapshot(item);
                        if (item.transferIntegrity) verifyTransferManifest(item.snapshot, item.transferIntegrity);
                        const claimToken = randomUUID();
                        // JSON 数组新增第二项起会多一个逗号；当前字节数已包含数组的中括号。
                        const storedTaskBytes = job.mode === "manual-plugin-upload"
                            ? manualTargetTaskStorageBytes(job, item, claimToken, now)
                            : 0;
                        // 单件已超过插件总额度时明确阻断该任务项，不标红来源商品，也不阻塞后续候选。
                        if (storedTaskBytes > MAX_MANUAL_TARGET_TASK_BYTES) {
                            item.status = "blocked";
                            item.reason = "商品资料超过插件单次接收额度，请精简后重新下发";
                            continue;
                        }
                        const separatorBytes = job.mode === "manual-plugin-upload" && currentManualTasks + manualClaimedCount > 0 ? 1 : 0;
                        if (job.mode === "manual-plugin-upload" && manualClaimedBytes + separatorBytes + storedTaskBytes > manualByteSlots) continue;
                        if (item.status === "claimed" && leaseExpired) {
                            item.reason = "领取租约已过期，重新领取";
                        }
                        item.status = "claimed";
                        item.claimedByStoreId = storeId;
                        item.claimedAt = now;
                        item.claimExpiresAt = new Date(nowMs + CLAIM_LEASE_MS).toISOString();
                        item.claimToken = claimToken;
                        delete item.receiveRecovery;
                        item.reason = job.mode === "manual-plugin-upload"
                            ? "目标插件已领取，正在接收商品快照"
                            : (item.reason || "本机工人已领取，等待核验身份");
                        claimed.push({
                            executionRunId: job.executionRunId || '',
                            jobId: job.id,
                            spuId: item.spuId,
                            title: item.title,
                            productVersion: item.productVersion,
                            dataHash: item.dataHash,
                            ...(item.transferIntegrity ? { transferIntegrity: item.transferIntegrity } : {}),
                            snapshot: item.snapshot || null,
                            directCreate: Boolean(job.directCreate),
                            sourceStoreId: job.sourceStoreId,
                            targetStoreId: job.targetStoreId,
                            sourceBatchId: job.sourceBatchId,
                            mode: job.mode,
                            // 人工确认重试的代次：插件据此判断这是重新下发，需要清掉本地旧 attempt 的隔离状态。
                            directRetrySequence: Number(item.directRetrySequence || 0),
                            claimToken
                        });
                        if (job.mode === "manual-plugin-upload") {
                            manualClaimedCount += 1;
                            manualClaimedBytes += separatorBytes + storedTaskBytes;
                        }
                        await appendJobActivity(job, "plugin_claimed", {
                            actor: "target-plugin",
                            storeId,
                            spuId: item.spuId,
                            message: "目标插件已领取定向商品快照"
                        });
                    }
                    refreshJobStatus(job);
                    if ((job.items || []).some((item) => item.status === "claimed")) job.updatedAt = now;
                }
            }
            // 老的只核验任务保持兼容；但后到实例不能覆盖已在线目标插件的 Agent 身份。
            if (occupiedByOther) {
                await writeState(state);
                return { storeId, storeName, claimed, receivedReceipts };
            }
            const existing = resolveAgentStore(state.agents, { ...input, storeId });
            // 实例冲突已经在领取前返回；这里的 Agent 更新只能写回当前实例自己的记录。
            const target = existing;
            const targetIndex = target ? (state.agents || []).indexOf(target) : -1;
            const agent = {
                pluginInstanceId: pluginInstanceId || (existing && existing.pluginInstanceId) || "",
                storeId,
                storeName: storeName || (existing && existing.storeName) || "",
                pageUrl: pageUrl || (existing && existing.pageUrl) || "",
                pageType: asText(input.pageType) || (existing && existing.pageType) || "",
                pluginVersion: asText(input.pluginVersion) || (existing && existing.pluginVersion) || "",
                lastSeenAt: now,
                lastClaimedJobId: claimed[0] ? claimed[0].jobId : (target && target.lastClaimedJobId || ""),
                pluginDetected,
                identityMatched,
                schedulingProtocol: supportsScheduling(input) ? 1 : 0,
                pageStoreName: asText(input.pageStoreName) || (target && target.pageStoreName) || "",
                nameSource: asText(input.nameSource) || (target && target.nameSource) || "",
                nameConfidence: asText(input.nameConfidence) || (target && target.nameConfidence) || "",
                expectedCount: Number.isInteger(input.expectedCount) ? input.expectedCount : (target && target.expectedCount),
                completedCount: Number.isInteger(input.completedCount) ? input.completedCount : (target && target.completedCount),
                capturePhase: asText(input.capturePhase) || (target && target.capturePhase) || "",
                ingestPhase: asText(input.ingestPhase) || (target && target.ingestPhase) || "",
                pendingUploadCount: Number.isInteger(input.pendingUploadCount) ? input.pendingUploadCount : (target && target.pendingUploadCount) || 0,
                source: asText(input.source) || (target && target.source) || ""
                ,mallId: target?.mallId || "", executionMode: target?.executionMode || ""
            };
            // 领取心跳不能丢掉页面轮次，否则下一次请求会降级为无轮次的旧协议。
            const nextAgent = { ...target, ...agent };
            if (targetIndex >= 0) state.agents[targetIndex] = nextAgent;
            else state.agents = [nextAgent, ...(state.agents || [])].slice(0, sql ? undefined : MAX_AGENTS);
            await writeState(state);
            return { storeId, storeName, claimed, receivedReceipts };
        });
    }

    /**
     * 回传任务进度。插件必须再次带上当前页面店铺身份；对不上就记 identity_mismatch，不能改成成功。
     */
    async function reportProgress(input = {}) {
        return withLock(async () => {
            const jobId = asText(input.jobId);
            const spuId = asText(input.spuId);
            const storeId = asText(input.storeId);
            let status = asText(input.status);
            const allowed = ["opening", "opened", "received", "upload_opened", "uploaded", "identity_verified", "identity_mismatch", "plugin_missing", "retry_wait", "failed"];
            if (!jobId || !spuId || !storeId) throw httpError("jobId、spuId、storeId 不能为空", 400);
            if (!allowed.includes(status)) throw httpError("当前阶段只接受 opening / opened / identity_verified / identity_mismatch / plugin_missing / retry_wait / failed", 400);
            const pluginDetected = hasSupportedPlugin(input);
            // 旧工人可能仍按历史规则把空版本面板写为已核验；服务端在终态前降级，避免错误放行。
            if (status === "identity_verified" && !pluginDetected) status = "plugin_missing";
            if (status === "identity_verified" && input.identityMatched === false) status = "identity_mismatch";
            if (["received", "upload_opened", "uploaded"].includes(status)
                && (!hasManualTransferPlugin(input) || input.identityMatched !== true)) {
                throw httpError("只有新版目标插件才能回传上传状态", 409);
            }
            const state = await readState();
            const job = (state.jobs || []).find((item) => item.id === jobId);
            if (!job) throw httpError("job_not_found", 404);
            if (job.directCreate && ["upload_opened", "uploaded"].includes(status)) throw httpError("接口任务只能由平台结果回查通道更新", 409);
            if (job.targetStoreId !== storeId) throw httpError("店铺身份与任务目标店不一致", 409);
            // 手动下发任务的失败与重试回报同样影响商品状态，必须与成功回报一样核验目标插件。
            if (job.mode === "manual-plugin-upload") {
                const pluginInstanceId = asText(input.pluginInstanceId);
                const agent = (state.agents || []).find((entry) => asText(entry.storeId) === storeId
                    && asText(entry.pluginInstanceId) === pluginInstanceId);
                const pageStoreName = asText(input.pageStoreName || input.storeName);
                if (!pluginInstanceId || !agent || !agent.pluginDetected || !agent.identityMatched
                    || !hasManualTransferPlugin(agent)
                    || (job.targetStoreName && !taskIdentityMatches(job, agent, input))) {
                    throw httpError("目标插件实例或当前页面店铺身份未核验", 409);
                }
            }
            const item = (job.items || []).find((entry) => entry.spuId === spuId);
            if (!item) throw httpError("job_item_not_found", 404);
            // 不允许未领取任务的实例仅凭任务编号写入失败或重试状态；旧工人核验任务维持原协议。
            if (job.mode === "manual-plugin-upload"
                && (!item.claimToken || asText(input.claimToken) !== item.claimToken || item.claimedByStoreId !== storeId)) {
                throw httpError("领取凭证不匹配", 409);
            }
            if (item.directState) throw httpError("接口任务已进入专用状态流程", 409);
            if (TERMINAL_ITEM_STATUSES.has(item.status)) {
                throw httpError("终态任务不能被迟到消息覆盖", 409);
            }
            if (item.claimedByStoreId && item.claimedByStoreId !== storeId && status !== "opening" && status !== "opened") {
                throw httpError("任务已被其他店铺占用", 409);
            }
            if (["identity_verified", "identity_mismatch", "plugin_missing"].includes(status)) {
                if (item.status !== "claimed") throw httpError("必须先领取任务才能核验身份", 409);
                if (item.claimToken && asText(input.claimToken) !== item.claimToken) {
                    throw httpError("领取凭证不匹配", 409);
                }
            }
            if (["received", "upload_opened", "uploaded"].includes(status)) {
                if (!["claimed", "received", "upload_opened"].includes(item.status)) throw httpError("商品尚未送达目标插件", 409);
                if (item.claimToken && asText(input.claimToken) !== item.claimToken) throw httpError("领取凭证不匹配", 409);
            }
            if (!canTransitionItem(item.status, status)) {
                throw httpError(`不允许从 ${item.status} 改为 ${status}`, 409);
            }
            // 目标插件必须先确认实际落盘的快照摘要，才允许后续申请平台创建许可。
            if (status === "received" && item.transferIntegrity) {
                if (asText(input.snapshotSha256) !== item.transferIntegrity.sha256) throw httpError("目标插件接收摘要与下发资料不一致，不能确认送达", 422);
                item.receivedSnapshotSha256 = input.snapshotSha256;
            }
            item.status = status;
            item.reason = asText(input.reason) || (status === "plugin_missing" && !pluginDetected ? "未检测到兼容的 10.x 中转插件" : "");
            item.pageUrl = asText(input.pageUrl);
            item.submitted = false;
            item.published = false;
            if (status === "uploaded") item.submitted = true;
            item.pluginDetected = pluginDetected;
            item.pageStoreName = asText(input.pageStoreName);
            await appendJobActivity(job, `plugin_${status}`, {
                actor: asText(input.actor) || "target-plugin",
                storeId,
                spuId,
                message: asText(input.reason) || `目标插件状态：${status}`
            });
            if (status === "opening") item.openingAt = new Date().toISOString();
            if (status === "opened") {
                item.openedAt = new Date().toISOString();
                item.claimedByStoreId = "";
                item.claimedAt = "";
                item.claimExpiresAt = "";
                item.claimToken = "";
            }
            if (status === "plugin_missing") {
                item.pluginMissingAt = new Date().toISOString();
                item.pluginDetected = false;
            }
            if (status === "retry_wait") {
                item.retryAt = new Date(Date.now() + OPEN_LEASE_MS).toISOString();
            }
            if (status === "identity_verified") item.verifiedAt = new Date().toISOString();
            refreshJobStatus(job);
            job.updatedAt = new Date().toISOString();
            await writeState(state);
            return summarizeJob(job);
        });
    }

    /**
     * 本机工人只查询需要打开的目标店，不会把商品资料广播给所有插件。
     */
    async function listOpenRequests() {
        return withLock(async () => {
            const state = await readState();
            const requests = [];
            let changed = false;
            for (const job of state.jobs || []) {
                if (expireStaleLeases(job)) changed = true;
                // 新人工上传任务直接由已在线的目标插件领取，工人不应重复打开或代领。
                if (job.mode === "manual-plugin-upload") continue;
                // opening 表示工人正在打开，不能再塞进待打开列表，否则会每轮重复导航。
                const pending = (job.items || []).filter((item) => item.status === "queued");
                if (!pending.length) continue;
                requests.push({
                    jobId: job.id,
                    targetStoreId: job.targetStoreId,
                    targetStoreName: job.targetStoreName,
                    sourceStoreId: job.sourceStoreId,
                    spuIds: pending.map((item) => item.spuId),
                    mode: job.mode
                });
            }
            if (changed) await writeState(state);
            return { requests };
        });
    }

    /**
     * 目标插件只查询自己已领取任务的状态，用来清理由网页取消或服务端失败的本地快照。
     * 返回值不含商品正文和领取凭证，避免把快照再次扩散到页面侧。
     */
    async function listTargetTaskStates(input = {}) {
        return withLock(async () => {
            const storeId = asText(input.storeId);
            const pluginInstanceId = asText(input.pluginInstanceId);
            const requested = Array.isArray(input.tasks) ? input.tasks : [];
            if (!storeId || !pluginInstanceId) throw httpError("storeId、pluginInstanceId 不能为空", 400);
            const state = await readState();
            const agent = (state.agents || []).find((entry) => asText(entry.storeId) === storeId
                && asText(entry.pluginInstanceId) === pluginInstanceId);
            if (!agent || !agent.pluginDetected || !agent.identityMatched || !hasManualTransferPlugin(agent)) {
                throw httpError("目标插件实例或店铺身份未核验", 409);
            }
            const tasks = [];
            for (const reference of requested.slice(0, 30)) {
                const jobId = asText(reference && reference.jobId);
                const spuId = asText(reference && reference.spuId);
                if (!jobId || !spuId) continue;
                const job = (state.jobs || []).find((entry) => entry.id === jobId && entry.targetStoreId === storeId);
                const item = job && (job.items || []).find((entry) => entry.spuId === spuId);
                tasks.push({
                    jobId,
                    spuId,
                    status: item ? asText(item.status) : "cancelled",
                    reason: item ? asText(item.reason) : "任务已从中转仓移除"
                });
            }
            return { tasks };
        });
    }

    /** 汇总网页和目标插件的任务动作，供仓库日志页按时间倒序回看整条链路。 */
    async function mergeStoreWorkLog(storeId, extra, meta = {}) {
        const log = await readStoreWorkLog(storeId);
        log.storeName = asText(meta.storeName) || log.storeName;
        log.sourceStoreId = asText(meta.sourceStoreId) || log.sourceStoreId;
        log.sourceStoreName = asText(meta.sourceStoreName) || log.sourceStoreName;
        for (const entry of extra) {
            const matched = log.entries.find((item) => isSameWorkLog(item, entry));
            if (matched) {
                if (String(entry.at) > String(matched.at)) matched.at = entry.at;
                matched.actor = asText(entry.actor) || matched.actor;
                continue;
            }
            log.entries.push(entry);
        }
        await writeStoreWorkLog(log);
    }

    async function migrateLegacyJobActivity(state) {
        let jobsChanged = false;
        for (const job of state.jobs || []) {
            const leftover = Array.isArray(job.activity) ? job.activity : [];
            if (!leftover.length) {
                if (Object.prototype.hasOwnProperty.call(job, "activity")) {
                    delete job.activity;
                    jobsChanged = true;
                }
                continue;
            }
            const storeId = asText(job.targetStoreId);
            if (storeId) {
                await mergeStoreWorkLog(storeId, leftover.map((item) => ({
                    at: asText(item.at) || new Date().toISOString(),
                    type: asText(item.type),
                    spuId: asText(item.spuId),
                    storeId: asText(item.storeId) || storeId,
                    actor: asText(item.actor),
                    message: asText(item.message).slice(0, 240),
                    jobId: asText(item.jobId || job.id),
                    sourceStoreId: asText(job.sourceStoreId),
                    sourceStoreName: asText(job.sourceStoreName),
                    targetStoreId: storeId,
                    targetStoreName: asText(job.targetStoreName)
                })), {
                    storeName: job.targetStoreName,
                    sourceStoreId: job.sourceStoreId,
                    sourceStoreName: job.sourceStoreName
                });
            }
            delete job.activity;
            jobsChanged = true;
        }
        if (jobsChanged) await writeState(state);
    }

    async function listActivity() {
        return withLock(async () => {
        const state = await readState();
        await migrateLegacyJobActivity(state);
        await mkdir(workLogDir, { recursive: true });
        const nowMs = Date.now();
        const stores = [];
        let names;
        try {
            names = await readdir(workLogDir);
        } catch (error) {
            if (error && error.code !== "ENOENT") throw error;
            names = [];
        }
        for (const name of names) {
            if (!name.endsWith(".json")) continue;
            let value;
            try {
                value = JSON.parse(await readFile(path.join(workLogDir, name), "utf8"));
            } catch {
                continue;
            }
            if (!value || typeof value !== "object") continue;
            const storeId = asText(value.storeId);
            if (!storeId) continue;
            const entries = pruneWorkLogEntries(value.entries, nowMs);
            if (entries.length !== (Array.isArray(value.entries) ? value.entries.length : 0)) {
                await writeStoreWorkLog({
                    storeId,
                    storeName: asText(value.storeName),
                    sourceStoreId: asText(value.sourceStoreId),
                    sourceStoreName: asText(value.sourceStoreName),
                    entries
                });
            }
            const agent = (state.agents || []).find((item) => asText(item.storeId) === storeId);
            const visible = entries.slice().sort((left, right) => String(right.at).localeCompare(String(left.at)));
            stores.push({
                storeId,
                storeName: asText(value.storeName) || asText(agent?.storeName || agent?.pageStoreName) || storeId,
                sourceStoreId: asText(value.sourceStoreId),
                sourceStoreName: asText(value.sourceStoreName),
                online: Boolean(agent && isAgentOnline(agent, nowMs)),
                updatedAt: asText(value.updatedAt) || asText(visible[0]?.at) || asText(agent?.lastSeenAt),
                entries: visible
            });
        }
        // 已登记但最近 15 天没有操作的店铺也要出现在日志索引里，运营才能确认店是否接入、是否离线。
        const indexedStoreIds = new Set(stores.map((item) => asText(item.storeId)));
        for (const agent of state.agents || []) {
            const storeId = asText(agent.storeId);
            if (!storeId || indexedStoreIds.has(storeId)) continue;
            stores.push({
                storeId,
                storeName: asText(agent.storeName || agent.pageStoreName) || storeId,
                sourceStoreId: "",
                sourceStoreName: "",
                online: isAgentOnline(agent, nowMs),
                updatedAt: asText(agent.lastSeenAt),
                entries: []
            });
        }
        stores.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
        return {
            retentionDays: 15,
            stores,
            entries: stores.flatMap((store) => store.entries)
        };
        });
    }

    /** 日志按目标店整组删除，只校验目标店归属；SQL 归属锁与删除处于同一事务。 */
    async function clearStoreActivity(storeId, access = null) {
        return withLock(async () => {
            const id = asText(storeId);
            if (!id) throw httpError("storeId 不能为空", 400);
            await assertJobAccess({ sourceStoreId: id, targetStoreId: id }, access);
            if (sql) { await sql.clearLog(id); return { storeId: id, deleted: true }; }
            await mkdir(workLogDir, { recursive: true });
            await rm(workLogPath(id), { force: true });
            return { storeId: id, deleted: true };
        });
    }

    /**
     * 统计删除某个店铺记录会波及多少任务与日志，供确认弹窗展示。
     * 与商品统计分开；MySQL 模式直接计数，避免加载该店全部历史商品快照。
     */
    async function storeRecordImpact(storeId) {
        const id = asText(storeId);
        if (!id) return { storeId: "", jobCount: 0, logCount: 0, agentCount: 0 };
        if (sql) return sql.storeImpact(id);
        const state = await readState();
        const jobs = (state.jobs || []).filter((job) => asText(job.sourceStoreId) === id || asText(job.targetStoreId) === id);
        const agents = (state.agents || []).filter((agent) => asText(agent.storeId) === id);
        let logCount = 0;
        try {
            const raw = JSON.parse(await readFile(workLogPath(id), "utf8"));
            logCount = Array.isArray(raw?.entries) ? raw.entries.length : 0;
        } catch { logCount = 0; }
        return { storeId: id, jobCount: jobs.length, logCount, agentCount: agents.length };
    }

    /**
     * 删除一个店铺的记录：心跳条目、相关任务、工作日志。
     *
     * 不删商品——商品属于仓库数据，由 store.deleteStoreData 按管理员选的模式单独处理。
     * 这里只负责"店铺自己"的记录，两块职责分开，避免一处改动同时影响任务与商品。
     *
     * 任务整条移除而不是只清字段：任务按来源批次与目标店记录，来源店没了之后
     * 它既无法继续执行、也无法被任何人看到，留着只会让任务列表越积越多。
     */
    async function deleteStoreRecord(storeId) {
        const id = asText(storeId);
        if (!id) throw httpError("storeId 不能为空", 400);
        return withLock(async () => {
            const state = await readState();
            const beforeJobs = (state.jobs || []).length;
            const beforeAgents = (state.agents || []).length;
            state.jobs = (state.jobs || []).filter((job) => asText(job.sourceStoreId) !== id && asText(job.targetStoreId) !== id);
            state.agents = (state.agents || []).filter((agent) => asText(agent.storeId) !== id);
            await writeState(state);
            if (sql) await sql.clearLog(id);
            else {
                await mkdir(workLogDir, { recursive: true });
                await rm(workLogPath(id), { force: true });
            }
            return {
                storeId: id,
                deletedJobs: beforeJobs - state.jobs.length,
                deletedAgents: beforeAgents - state.agents.length
            };
        });
    }

    async function listDeletedStores() {
        return deletedStores ? deletedStores.list() : [];
    }

    /** 恢复已删除的店铺：从名单移除并写回归属，商品是否还在取决于删除时选的模式。 */
    async function restoreDeletedStore(storeId) {
        const id = asText(storeId);
        if (!id) throw httpError("storeId 不能为空", 400);
        if (!deletedStores) throw httpError("删除名单未启用", 500);
        const record = await deletedStores.unmark(id);
        // 归属还原失败不影响恢复本身：店铺已经从名单移除，管理员可以在列表里重新认领或改派。
        if (record.previousOwnerId && ownership?.restoreAssignment) {
            try {
                await ownership.restoreAssignment({
                    storeId: id,
                    ownerId: record.previousOwnerId,
                    ownerName: record.previousOwnerName,
                    storeName: record.storeName,
                    claimedAt: record.deletedAt
                });
            } catch { /* 归属表写入失败时保留已删除记录的回执，管理员可改派 */ }
        }
        return { storeId: id, restored: true, record };
    }

    // 通知专用只读副本与业务队列隔离；多个账号订阅同一文件时不重复解析商品快照和日志。
    let liveQueueCache = null;
    let liveQueueStamp = "";
    const liveLogCache = new Map();
    /** 在线与租约超时只在通知副本中推算，不落盘；心跳时间本身不构成界面变化。 */
    async function liveSignature(scope = null) {
        return withLock(async () => {
            const fileInfo = await stat(filePath).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
            const stamp = fileInfo ? `${fileInfo.mtimeMs}:${fileInfo.size}` : "missing";
            if (!liveQueueCache || liveQueueStamp !== stamp) {
                const loaded = await readState();
                // 版本计算不需要发布快照，避免 SSE 缓存长期保留大批商品的完整资料。
                liveQueueCache = {
                    agents: loaded.agents || [],
                    jobs: (loaded.jobs || []).map(job => ({ ...job, items: (job.items || []).map(({ snapshot, ...item }) => item) }))
                };
                liveQueueStamp = stamp;
            }
            const state = liveQueueCache;
            const nowMs = Date.now();
            for (const job of state.jobs || []) expireStaleLeases(job, nowMs);
            // SSE 只暴露当前账号可见的任务和插件变化；认领目录另用公开状态签名。
            const visibleAgents = (state.agents || []).filter(agent => !scope || scope.has(asText(agent.storeId)));
            const agents = visibleAgents.map((agent) => [
                asText(agent.storeId),
                asText(agent.storeName || agent.pageStoreName),
                isAgentOnline(agent, nowMs) ? 1 : 0,
                asText(agent.pluginVersion),
                agent.identityMatched ? 1 : 0,
                hasManualTransferPlugin(agent) ? 1 : 0
            ].join(":")).sort().join(";");
            const directory = (state.agents || []).map(agent => [asText(agent.storeId), asText(agent.storeName || agent.pageStoreName), asText(agent.pluginVersion), isAgentOnline(agent, nowMs) ? 1 : 0].join(":")).sort().join(";");
            const jobs = (state.jobs || []).filter(job => !scope || scope.has(asText(job.sourceStoreId)) || scope.has(asText(job.targetStoreId))).map((job) => [
                asText(job.id),
                asText(job.status),
                asText(job.updatedAt),
                (job.items || []).map((item) => `${asText(item.spuId)}:${asText(item.status)}:${asText(item.directState)}`).join(",")
            ].join(":")).join(";");
            let logs = "";
            try {
                const names = (await readdir(workLogDir)).filter((name) => name.endsWith(".json")).sort();
                for (const name of liveLogCache.keys()) if (!names.includes(name)) liveLogCache.delete(name);
                const parts = [];
                for (const name of names) {
                    const info = await stat(path.join(workLogDir, name)).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
                    if (!info) continue;
                    const logStamp = `${info.mtimeMs}:${info.size}`;
                    if (scope) {
                        if (liveLogCache.get(name)?.stamp !== logStamp) {
                            liveLogCache.set(name, { stamp: logStamp, log: JSON.parse(await readFile(path.join(workLogDir, name), "utf8")) });
                        }
                        // 同一目标店的日志可能混合多个来源店，通知也必须按单条日志可见范围过滤。
                        const log = liveLogCache.get(name).log;
                        const entries = (log.entries || []).filter(entry => scope.has(asText(entry.storeId)) || scope.has(asText(entry.sourceStoreId)));
                        if (!entries.length) continue;
                        parts.push(createHash("sha256").update(JSON.stringify(entries)).digest("hex"));
                    } else {
                        parts.push(`${name}:${logStamp}`);
                    }
                }
                logs = parts.join(";");
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
                // 尚无日志时允许空签名；损坏或读取失败不能伪装成“全部日志已删除”。
                logs = "";
            }
            return { agents, jobs, logs, directory };
        });
    }

    /**
     * 本机工人仅回传旧身份核验任务的打开结果；用户会话须在事务内复核来源店和目标店归属。
     */
    async function reportOpenResult(input = {}, access = null) {
        return withLock(async () => {
            const jobId = asText(input.jobId);
            const storeId = asText(input.storeId || input.targetStoreId);
            const status = asText(input.status);
            if (!jobId || !storeId) throw httpError("jobId、storeId 不能为空", 400);
            if (!["opening", "opened", "plugin_missing", "retry_wait", "failed"].includes(status)) throw httpError("工人只接受 opening / opened / plugin_missing / retry_wait / failed", 400);
            const state = await readState();
            const job = (state.jobs || []).find((item) => item.id === jobId);
            if (!job) throw httpError("job_not_found", 404);
            // 工人回传不能借用他人的任务编号；归属校验必须先于任何状态变更和兼容应答。
            await assertJobAccess(job, access);
            if (job.targetStoreId !== storeId) throw httpError("打开结果与任务目标店不一致", 409);
            if (job.mode !== "identity-open-only" || job.directCreate) {
                // 文件后端旧工人会多报一次人工任务已打开；仅保留无副作用应答，不能改变人工任务状态。
                if (!sql && !access && job.mode === "manual-plugin-upload" && status === "opened") return summarizeJob(job);
                throw httpError("打开回传仅适用于旧身份核验任务", 409);
            }
            const now = new Date().toISOString();
            for (const item of job.items || []) {
                const fromOpened = item.status === "opened" && status === "plugin_missing";
                if (item.status !== "queued" && item.status !== "opening" && !fromOpened) continue;
                if (Array.isArray(input.spuIds) && input.spuIds.length && !input.spuIds.includes(item.spuId)) continue;
                const nextStatus = status === "opening" ? "opening" : status;
                if (!canTransitionItem(item.status, nextStatus)) continue;
                item.status = nextStatus;
                item.reason = asText(input.reason) || (status === "opened" ? "目标店已打开，等待本机工人代领核验" : item.reason);
                item.pageUrl = asText(input.pageUrl);
                if (status === "opening") item.openingAt = now;
                if (status === "opened") item.openedAt = now;
                if (status === "plugin_missing") {
                    item.pluginMissingAt = now;
                    item.pluginDetected = false;
                }
                if (status === "retry_wait") item.retryAt = new Date(Date.now() + OPEN_LEASE_MS).toISOString();
            }
            refreshJobStatus(job);
            job.updatedAt = now;
            await writeState(state);
            return summarizeJob(job);
        });
    }

    /**
     * 入库包可能只有 pluginInstanceId 和页面店名。按已登记 Agent 回填来源店，
     * 不能用商品 SPU 或运营事后手选代替。
     */
    async function resolveIngestSource(input = {}) {
        const state = await readState();
        const matched = resolveAgentStore(state.agents, input);
        if (!matched || !asText(matched.storeId)) return null;
        const pageStoreName = asText(input.pageStoreName || input.storeName);
        // API实例用商城ID核验；显式商城或实例冲突不能降级为同名匹配，旧CLI仍保留名称规则。
        if (matched.executionMode === 'plugin-api') {
            if (!taskIdentityMatches({ directCreate: true, targetStoreId: asText(matched.storeId) }, matched, input)) return null;
        } else if (!pageStoreName || !namesCompatible(pageStoreName, asText(matched.pageStoreName || matched.storeName))) return null;
        return {
            sourceStoreId: asText(matched.storeId),
            sourceStoreName: asText(matched.storeName || matched.pageStoreName),
            pluginInstanceId: asText(matched.pluginInstanceId)
        };
    }

    /** 超时转unknown：旧模式只隔离本店；账户模式同时保留持久平台许可和业务槽等待原尝试结果。 */
    async function expireDirectPermits() {
        return withLock(async () => {
            const state = await readState(), now = new Date().toISOString();
            let expired = 0;
            for (const job of state.jobs) {
                if (job.status === 'cancelled') continue;
                let changed = false;
                for (const item of job.items || []) {
                    if (item.status !== 'upload_opened' || item.directState !== 'creating'
                        || !(Date.parse(item.directUpdatedAt) < Date.now() - DIRECT_STALE_MS)) continue;
                    item.directState = 'unknown'; item.directUpdatedAt = now;
                    item.reason = accountExecution
                        ? '创建许可超过10分钟未收到结果，已转待核对；账户槽和平台许可保留，不自动重发'
                        : '创建许可超过10分钟未收到结果，已转待核对；释放全局名额但本店不自动重发';
                    await appendJobActivity(job, 'direct_unknown', { actor: 'server', storeId: job.targetStoreId, spuId: item.spuId, message: item.reason });
                    job.updatedAt = now; changed = true; expired++;
                }
                if (changed) refreshJobStatus(job);
            }
            if (expired) await writeState(state);
            return { expired };
        });
    }

    const api = {
        controlExecutionRun,
        expireExecutionRun,
        retireLegacyDirectJobs,
        expireDirectPermits,
        directProgress,
        directRetry,
        listAgents,
        listJobs,
        listJobsPage,
        listDashboard,
        liveSignature,
        getJob,
        createJob,
        cancelJob,
        cancelStoreTasks,
        registerAgent,
        claimJobs,
        reportProgress,
        listTargetTaskStates,
        listOpenRequests,
        reportOpenResult,
        listActivity,
        clearStoreActivity,
        resolveIngestSource,
        storeRecordImpact,
        deleteStoreRecord,
        listDeletedStores,
        restoreDeletedStore
    };
    if (sql) {
        // 维护分片与begin采用同一锁顺序，和真实回执竞争时必须重新读取，不能覆盖已经完成的结果。
        api.expireDirectPermits = async () => {
            let expired = 0;
            for (const storeId of await sql.listExecutionRunStores()) await api.expireExecutionRun({ storeId });
            for (const candidate of await sql.listStaleDirectJobs(new Date(Date.now() - DIRECT_STALE_MS).toISOString())) {
                expired += (await sql.run('expireDirectPermits', [candidate], expireDirectPermits)).expired;
            }
            return { expired };
        };
        api.repairProjections = sql.repairProjections;
        api.cleanupPayloads = sql.cleanupPayloads;
        // 历史遗留任务按店铺分片终结：SQL 写操作必须有明确店铺边界，
        // 而且游标分片避免几百家店时后排永远轮不到。
        api.retireLegacyDirectJobs = async () => {
            let retired = 0, kept = 0, cancelled = 0;
            for (const storeId of await sql.listExecutionRunStores()) {
                const result = await sql.run('retireLegacyDirectJobs', [{ storeId }], async () => withLock(async () => {
                    const state = await readState();
                    const outcome = await retireLegacyDirectJobs(state, storeId);
                    if (outcome.retired || outcome.cancelled) await writeState(state);
                    return outcome;
                }));
                retired += result.retired; kept += result.kept; cancelled += result.cancelled;
            }
            return { retired, kept, cancelled };
        };
        // 分发、状态回执和目录查询共用协议，不共用文件锁或连接额度。
        for (const name of ["controlExecutionRun", "expireExecutionRun", "createJob", "claimJobs", "cancelJob", "cancelStoreTasks", "directRetry", "directProgress", "reportProgress", "registerAgent", "listAgents", "getJob", "listTargetTaskStates", "reportOpenResult", "resolveIngestSource", "storeRecordImpact", "deleteStoreRecord", "clearStoreActivity", "listOpenRequests"]) {
            const fn = api[name];
            api[name] = (...args) => sql.run(name, args, () => fn(...args));
        }
        api.listJobsPage = sql.listJobsPage;
        api.listJobs = async () => {
            const result = await sql.listJobsPage({ limit: 200 });
            return { jobs: result.jobs, agents: result.agents };
        };
        api.listDashboard = sql.listDashboard;
        api.listActivity = sql.listActivity;
        api.liveSignature = sql.liveSignature;
        api.importLegacyState = sql.importLegacy;
        api.cleanupLogs = sql.cleanupLogs;
    } else {
        const expirePermits = api.expireDirectPermits;
        // 文件模式沿用相同终止语义，仅MySQL按店分页读取；维护不嵌套同一个文件锁。
        api.expireDirectPermits = async () => {
            const state = await readState();
            for (const storeId of new Set(state.jobs.filter(job => job.executionRunId).map(job => job.targetStoreId))) await expireExecutionRun({ storeId });
            return expirePermits();
        };
        // 文件模式没有 sql.run 包装，直接在同一把文件锁里读改写。
        api.retireLegacyDirectJobs = () => withLock(async () => {
            const state = await readState();
            const result = await retireLegacyDirectJobs(state);
            if (result.retired || result.cancelled) await writeState(state);
            return result;
        });
    }
    return api;
}
