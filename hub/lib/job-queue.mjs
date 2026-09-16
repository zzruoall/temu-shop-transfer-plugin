import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { namesCompatible } from "./store-names.mjs";

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
const MAX_MANUAL_TARGET_TASKS = 30;
const MAX_MANUAL_TARGET_TASK_BYTES = 4 * 1024 * 1024;
const WORK_LOG_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_STORE_WORK_LOG_ENTRIES = 400;
// 已开始提交但长时间没有任何进度更新的项目，视为插件中途掉线留下的残局；
// 这个阈值必须远大于一次正常的重复检索加预检耗时，避免人工重试打断仍在提交中的插件。
const DIRECT_STALE_MS = 10 * 60 * 1000;
const TERMINAL_JOB_STATUSES = new Set(["cancelled", "failed", "identity_verified", "uploaded"]);
const ACTIVE_ITEM_STATUSES = new Set(["queued", "opening", "opened", "claimed", "received", "upload_opened", "plugin_missing", "retry_wait"]);
// 会真正走到平台提交、或已被插件接手准备提交的状态；人工重试据此保证同店同货号只有一个在途项。
const DIRECT_IN_FLIGHT_STATUSES = new Set(["queued", "opening", "opened", "claimed", "received", "retry_wait"]);
const TERMINAL_ITEM_STATUSES = new Set(["identity_verified", "identity_mismatch", "uploaded", "failed", "cancelled", "blocked"]);
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
        jobId: String(job && job.id || ""),
        spuId: String(item && item.spuId || ""),
        title: String(item && item.title || ""),
        claimToken: String(claimToken || ""),
        sourceStoreId: String(job && job.sourceStoreId || ""),
        targetStoreId: String(job && job.targetStoreId || ""),
        sourceBatchId: String(job && job.sourceBatchId || ""),
        snapshot: item && item.snapshot || null,
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

/** 超过 3 天的操作不再展示，也不再写回店铺日志文件。 */
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
    try {
        await rename(temp, filePath);
    } catch {
        await writeFile(filePath, await readFile(temp, "utf8"), "utf8");
        await rm(temp, { force: true });
    }
}

function summarizeAgent(agent) {
    return {
        pluginInstanceId: agent.pluginInstanceId || "",
        storeId: agent.storeId || "",
        storeName: agent.storeName || "",
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
        canReceiveUploads: hasManualTransferPlugin(agent)
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
        }
    };
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
    else if (allItemsTerminal) job.status = "partial";
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
export function createJobQueue(rootDir, store) {
    const dataDir = path.join(rootDir, "data");
    const filePath = path.join(dataDir, "jobs.json");
    const workLogDir = path.join(dataDir, "work-logs");
    let mutation = Promise.resolve();

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
        // 任务文件先写临时文件再替换，避免进程中途退出把 jobs.json 写成半截。
        const temp = `${filePath}.tmp`;
        await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
        try {
            await rename(temp, filePath);
        } catch (error) {
            // Windows 上目标文件已存在时 rename 可能失败，改为覆盖写完再删临时文件。
            await writeFile(filePath, await readFile(temp, "utf8"), "utf8");
            await rm(temp, { force: true });
        }
    }

    async function withLock(executor) {
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
            const state = await readState();
            const now = new Date().toISOString();
            const pluginDetected = hasSupportedPlugin(input);
            let existing = resolveAgentStore(state.agents, input);
            // API绑定不能被旧CLI心跳重新映射；旧连接器仅能继续管理旧模式实例。
            if(existing?.executionMode === "plugin-api" && input.executionMode !== "plugin-api") throw httpError("API插件绑定不可被旧连接器覆盖",409);
            const pageStoreName = asText(input.pageStoreName || input.storeName);
            // API插件使用真实商城命名空间，旧CLI账号不得冒充该商城。
            if (input.executionMode === "plugin-api" && (!/^\d+$/.test(asText(input.mallId)) || storeId !== `temu:${input.mallId}`)) throw httpError("商城绑定不匹配", 409);
            // 同一扩展实例切到另一家店时，页面店名已变化而 storeId 尚未重新核验，必须先解除旧店绑定。
            // 否则新店采集包会按 pluginInstanceId 被错误归入上一家来源店。
            const pageChanged = Boolean(pluginInstanceId && existing && !storeId && pageStoreName
                && asText(existing.pageStoreName || existing.storeName)
                && !namesCompatible(pageStoreName, asText(existing.pageStoreName || existing.storeName)));
            // 紫鸟店铺已被另一个插件实例占用时，不能把同一 storeId 写到后到的实例上。
            // 旧实例已离线时才释放映射，避免浏览器重开后永久无法由新实例接管。
            if (pluginInstanceId && storeId) {
                const occupied = (state.agents || []).find((item) => asText(item.storeId) === storeId
                    && asText(item.pluginInstanceId)
                    && asText(item.pluginInstanceId) !== pluginInstanceId);
                if (occupied && isAgentOnline(occupied)) {
                    storeId = asText(existing && existing.storeId);
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
                storeName: asText(input.storeName) || (pageChanged ? "" : (existing && existing.storeName) || ""),
                pageUrl: asText(input.pageUrl) || (existing && existing.pageUrl) || "",
                pageType: asText(input.pageType) || (existing && existing.pageType) || "",
                pluginVersion: asText(input.pluginVersion) || (existing && existing.pluginVersion) || "",
                lastSeenAt: now,
                lastClaimedJobId: pageChanged ? "" : (existing && existing.lastClaimedJobId || ""),
                pluginDetected,
                identityMatched: Boolean(input.identityMatched),
                pageStoreName: pageStoreName || (existing && existing.pageStoreName) || "",
                nameSource: asText(input.nameSource) || (existing && existing.nameSource) || "",
                nameConfidence: asText(input.nameConfidence) || (existing && existing.nameConfidence) || "",
                expectedCount: Number.isInteger(input.expectedCount) ? input.expectedCount : (existing && existing.expectedCount),
                completedCount: Number.isInteger(input.completedCount) ? input.completedCount : (existing && existing.completedCount),
                capturePhase: asText(input.capturePhase) || (existing && existing.capturePhase) || "",
                ingestPhase: asText(input.ingestPhase) || (existing && existing.ingestPhase) || "",
                pendingUploadCount: Number.isInteger(input.pendingUploadCount) ? input.pendingUploadCount : (existing && existing.pendingUploadCount) || 0,
                source: asText(input.source) || (existing && existing.source) || ""
                ,mallId: asText(input.mallId) || existing?.mallId || "", executionMode: asText(input.executionMode) || existing?.executionMode || ""
            };
            const index = existing
                ? (state.agents || []).indexOf(existing)
                : -1;
            if (index >= 0) state.agents[index] = { ...existing, ...agent };
            else state.agents = [agent, ...(state.agents || [])].slice(0, 50);
            await writeState(state);
            const saved = index >= 0 ? state.agents[index] : agent;
            if (saved.storeId && typeof store.attachSourceStore === "function") {
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
     * 发送侧的唯一约束是目标店插件此刻仍在提交（creating 且未超过静默窗口），此时拒绝下发，避免同店并发写入。
     * 同店同货号的重复判断由目标店插件按货号自行检索完成；新任务落库时会撤销旧任务里重叠的未完成项，
     * 避免同一个货号在队列中堆积多份而重复领取。
     */
    async function createJob(input = {}) {
        return withLock(async () => {
            const sourceStoreId = asText(input.sourceStoreId);
            const targetStoreId = asText(input.targetStoreId);
            const targetStoreName = asText(input.targetStoreName);
            // requireOnline 由新版网页明确传入；保留旧任务台接口的“只核验”语义，确保升级不改变历史任务。
            const manualDelivery = input.requireOnline === true;
            // 新增接口必须由本次操作明确授权；升级程序不会把历史任务变成自动创建。
            const directCreate = input.directCreate === true;
            if (directCreate && (!manualDelivery || input.complianceVersion !== "V2.0")) throw httpError("请确认商品合规声明后再创建", 400);
            const sourceBatchId = asText(input.sourceBatchId);
            const requestedIds = unique(input.spuIds);
            if (!sourceStoreId || !targetStoreId || !sourceBatchId || !requestedIds.length) {
                throw httpError("sourceStoreId、targetStoreId、sourceBatchId、spuIds 不能为空", 400);
            }
            if (sourceStoreId === targetStoreId) throw httpError("来源店和目标店不能相同", 400);
            const batch = await store.getBatch(sourceBatchId);
            if (!batch) throw httpError("来源批次不存在", 404);
            const batchStoreId = asText(batch.sourceStoreId);
            if (!batchStoreId) throw httpError("该批次没有来源店记录，请用来源店插件重新采集后再创建任务", 409);
            if (batchStoreId !== sourceStoreId) {
                throw httpError("来源店与该批次记录的采集店铺不一致", 409);
            }
            const batchProducts = (batch.products || []).filter((product) => requestedIds.includes(asText(product.spuId)));
            const missingIds = requestedIds.filter((id) => !batchProducts.some((product) => asText(product.spuId) === id));
            const notReadyIds = batchProducts.filter((product) => !product.ready).map((product) => asText(product.spuId));
            const overview = await store.listOverview();
            const state = await readState();
            if (missingIds.length) throw httpError(`来源批次中没有这些 SPU：${missingIds.join("、")}`, 400);
            // 网页只允许下发给已经由本机工人核验、且近期仍在心跳的新版插件。
            // 这条检查是“选择目标店”与“实际能接收到商品包”之间的必要因果约束。
            const targetAgent = (state.agents || []).find((agent) => asText(agent.storeId) === targetStoreId);
            if (directCreate && !/^10\.(?:9|[1-9]\d)\./.test(asText(targetAgent?.pluginVersion))) throw httpError("接口创建需要目标店安装 10.9.0 或更新的 10.x 插件", 409);
            if (manualDelivery && (!targetAgent || !isAgentOnline(targetAgent) || !targetAgent.pluginDetected || !targetAgent.identityMatched || !hasManualTransferPlugin(targetAgent))) {
                throw httpError("目标店插件不在线、身份未核验或版本不支持接收上传任务", 409);
            }
            if (targetAgent && targetStoreName && asText(targetAgent.storeName) && !namesCompatible(targetStoreName, targetAgent.storeName)) {
                throw httpError("目标店名称与已检测插件不一致", 409);
            }
            const active = (state.jobs || []).filter((job) => !isTerminalJob(job));
            // 网站端不根据历史任务或 SPU 判断平台商品重复；该判断完全交给目标店插件。
            const overlaps = active.flatMap(job => job.targetStoreId === targetStoreId
                ? (job.items || []).filter(item => requestedIds.includes(item.spuId) && !TERMINAL_ITEM_STATUSES.has(item.status)).map(item => ({ job, item })) : []);
            // 发送上只保留一条约束：目标店插件此刻仍在执行提交（creating）时不再下发，避免同一家店被并发写入。
            // 插件中途掉线会留下没人推进的 creating 项，这类项超过静默窗口就不算“还在执行”，
            // 否则一次异常会永久堵死该店的发送通道；判断依据只有“插件还有没有在跑”，
            // 服务器依然不解读平台返回值、不判断商品是否重复。
            const nowMs = Date.now();
            const executing = active.some((job) => job.targetStoreId === targetStoreId
                && (job.items || []).some((item) => {
                    if (asText(item.directState) !== "creating") return false;
                    const updatedAt = Date.parse(asText(item.directUpdatedAt));
                    // 没有时间戳就无法证明插件已停下，按“仍在执行”处理，宁可让运营等一次也不要并发写入。
                    return !Number.isFinite(updatedAt) || nowMs - updatedAt < DIRECT_STALE_MS;
                }));
            if (executing) throw httpError("目标店插件正在提交上一个商品，请等它结束后再发送", 409);
            if (overlaps.length && notReadyIds.length) throw httpError("新商品资料未齐，不能覆盖旧任务", 409);
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
                    directCreate,
                    status: product.ready ? "queued" : "blocked",
                    reason: product.ready ? "" : "商品资料未齐",
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
                id: randomUUID().slice(0, 12),
                createdAt: now,
                updatedAt: now,
                status: missingIds.length ? "blocked_preflight" : (items.some((item) => item.status === "queued") ? "queued" : "blocked_preflight"),
                mode: manualDelivery ? "manual-plugin-upload" : "identity-open-only",
                directCreate,
                complianceVersion: directCreate ? "V2.0" : "",
                complianceConfirmedAt: directCreate ? now : "",
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
            await appendJobActivity(job, manualDelivery ? "web_task_created" : "legacy_task_created", {
                actor: "warehouse-web",
                storeId: targetStoreId,
                message: manualDelivery ? `网页已把 ${items.length} 个商品排队给已检测的目标插件` : `历史任务已创建，等待本机工人核验`
            });
            // 与新任务在同一锁及同一次存储提交中撤销旧凭证；迟到回执会被终态检查拒绝。
            for (const { job: oldJob, item } of overlaps) {
                item.status = "cancelled";
                item.reason = `已被新任务 ${job.id} 覆盖`;
                item.replacedByJobId = job.id;
                item.claimToken = "";
                item.claimedByStoreId = "";
                item.claimedAt = "";
                item.claimExpiresAt = "";
                refreshJobStatus(oldJob);
                oldJob.updatedAt = now;
                await appendJobActivity(oldJob, "web_task_replaced", { actor: "warehouse-web", storeId: targetStoreId, message: `商品 ${item.spuId} 被任务 ${job.id} 替换，旧领取凭证已撤销` });
            }
            // 任务历史达到上限时只淘汰已结束记录；若全是活跃任务则明确拒绝，不能丢掉可领取快照。
            const nextJobs = [job, ...(state.jobs || [])];
            while (nextJobs.length > MAX_JOBS) {
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
            if (!job?.directCreate || job.complianceVersion !== "V2.0" || !item || !agent?.identityMatched || !agent.pluginDetected
                || !namesCompatible(job.targetStoreName, asText(input.pageStoreName)) || !item.claimToken || item.claimToken !== input.claimToken) throw httpError("接口创建身份或授权不匹配", 409);
            const phase = asText(input.phase);
            // 恢复授权只返回原尝试且标记恢复，客户端不能把它当成新的提交许可。
            if (phase === "begin" && input.authorizationKey && item.authorizationKey === input.authorizationKey
                && item.directPluginInstanceId === input.pluginInstanceId && item.requestHash === input.requestHash
                && item.targetMallId === asText(input.mallId) && item.directAttemptId) return {attemptId:item.directAttemptId,state:item.directState,resumed:true};
            // 已授权尝试被平台明确拒绝的终态回执：商品确定没有创建，必须把平台原文写进任务，
            // 不能因为“已授权过”而判为重复提交，否则运营在工作日志里只会看到旧原因，问题无法定位。
            const attemptRejected = phase === "preflight_failed" && item.directAttemptId
                && item.directAttemptId === asText(input.attemptId) && item.directPluginInstanceId === input.pluginInstanceId
                && ["creating", "unknown"].includes(item.directState);
            if (attemptRejected) {
                item.directState = "preflight_failed";
                item.status = "failed";
                item.reason = asText(input.reason).slice(0, 1000);
                item.directUpdatedAt = new Date().toISOString();
                await appendJobActivity(job, "direct_preflight_failed", {actor:"local-cli",storeId:job.targetStoreId,spuId:item.spuId,message:item.reason});
                refreshJobStatus(job);
                job.updatedAt = item.directUpdatedAt;
                await writeState(state);
                return {attemptId:item.directAttemptId, state:item.directState};
            }
            // 已授权回执允许短时离线后补传；只有新授权必须核验在线状态。
            if (["begin", "preflight_failed"].includes(phase) && !isAgentOnline(agent)) throw httpError("目标插件离线，不能开始创建", 409);
            // 完成回执重传只接受同一实例、尝试和商品编号，不能覆盖既有结果。
            if (phase === "created" && item.directState === "created"
                && item.directPluginInstanceId === input.pluginInstanceId && item.directAttemptId === input.attemptId
                && item.createdProductId === asText(input.productId) && input.verified === true) {
                return {attemptId:item.directAttemptId, state:item.directState};
            }
            if (["begin", "preflight_failed"].includes(phase)) {
                if (!/^10\.(?:9|[1-9]\d)\./.test(asText(agent.pluginVersion))) throw httpError("目标插件需要升级到10.9.0", 409);
                // unknown 只表示上次结果未确认；新 attempt 必须携带插件检索结果 not_found 才能安全解锁。
                // unknown 不是失败：即使插件查不到货号，也不能从回执通道自动解锁新 attempt。
                // 人工确认重试必须先调用 directRetry，让旧 attempt 留痕并把任务重新排到队尾。
                if (item.status !== "received" || item.directState) throw httpError("任务尚未明确结束，不能重复提交；结果未知请人工确认重试", 409);
                if (phase === "begin" && agent.executionMode === "plugin-api") {
                    if (agent.mallId !== asText(input.mallId) || job.targetStoreId !== `temu:${input.mallId}`) throw httpError("目标商城不匹配",409);
                    // 历史 unknown 不能替代插件的真实重复检索；这里只保留正在创建任务的并发互斥。
                    if (state.jobs.some(j=>j.targetStoreId===job.targetStoreId && j.items.some(i=>i!==item && i.directState==="creating"))) throw httpError("目标店已有正在创建的任务，请稍后重试",409);
                    if (!/^[a-zA-Z0-9-]{16,80}$/.test(asText(input.authorizationKey))) throw httpError("缺少稳定授权键",400);
                }
                if (phase === "begin" && (!/^[a-f0-9]{64}$/.test(asText(input.requestHash)) || !/^\d+$/.test(asText(input.mallId)))) throw httpError("新增请求指纹或目标商城标识缺失", 400);
                item.directState = phase === "begin" ? "creating" : "preflight_failed";
                item.status = phase === "begin" ? "upload_opened" : "failed";
                item.directAttemptId = randomUUID();
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
            await writeState(state);
            return {attemptId:item.directAttemptId, state:item.directState};
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
    async function directRetry(input = {}) {
        return withLock(async () => {
            const state = await readState();
            const job = (state.jobs || []).find(entry => entry.id === asText(input.jobId) && entry.targetStoreId === asText(input.storeId));
            const item = job?.items.find(entry => entry.spuId === asText(input.spuId));
            if (!job?.directCreate || !item) throw httpError("任务不存在", 404);
            if (input.confirmed !== true) throw httpError("必须人工确认后才能重试", 400);
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

    async function cancelJob(id) {
        return withLock(async () => {
            const state = await readState();
            const job = (state.jobs || []).find((item) => item.id === asText(id));
            if (!job) throw httpError("job_not_found", 404);
            if (job.items.some(item => ["creating", "unknown"].includes(item.directState))) throw httpError("接口提交已开始或结果待核对，不能取消或重发", 409);
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
     * 本机工人读取已打开目标店后也会走同一接口代领；必须携带目标店 storeId，且只能领取发给该店、尚未被别人占用的任务。
     */
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
            const manualSlots = Math.max(0, MAX_MANUAL_TARGET_TASKS - Math.min(currentManualTasks, MAX_MANUAL_TARGET_TASKS));
            const currentManualBytes = Number.isInteger(input.pendingUploadBytes) ? Math.max(0, input.pendingUploadBytes) : 0;
            const manualByteSlots = Math.max(0, MAX_MANUAL_TARGET_TASK_BYTES - Math.min(currentManualBytes, MAX_MANUAL_TARGET_TASK_BYTES));
            let manualClaimedCount = 0;
            let manualClaimedBytes = 0;
            // 同一店铺只能由当前已登记且在线的插件实例领取人工上传快照，防止第二个窗口抢到资料。
            const owner = (state.agents || []).find((agent) => asText(agent.storeId) === storeId && isAgentOnline(agent, nowMs));
            const occupiedByOther = Boolean(owner && asText(owner.pluginInstanceId)
                && asText(owner.pluginInstanceId) !== pluginInstanceId);
            // 新版商城任务禁止旧CLI代领；双通道不能同时执行写操作。
            if (owner?.executionMode === "plugin-api" && input.executionMode !== "plugin-api") throw httpError("该店任务只允许插件API领取",409);
            const identityMatched = Boolean(input.identityMatched);
            if (pluginDetected) {
                for (const job of state.jobs || []) {
                    expireStaleLeases(job, nowMs);
                    // CLI 专用领取不得顺带占用旧身份核验任务的租约。
                    if (input.manualUploadsOnly === true && job.mode !== "manual-plugin-upload") continue;
                    if (job.targetStoreId !== storeId) continue;
                    if (["cancelled", "failed", "blocked_preflight"].includes(job.status) || isTerminalJob(job)) continue;
                    if (job.targetStoreName && storeName && !namesCompatible(job.targetStoreName, storeName)) continue;
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
                        const claimToken = randomUUID();
                        // JSON 数组新增第二项起会多一个逗号；当前字节数已包含数组的中括号。
                        const storedTaskBytes = job.mode === "manual-plugin-upload"
                            ? manualTargetTaskStorageBytes(job, item, claimToken, now)
                            : 0;
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
                        item.reason = job.mode === "manual-plugin-upload"
                            ? "目标插件已领取，正在接收商品快照"
                            : (item.reason || "本机工人已领取，等待核验身份");
                        claimed.push({
                            jobId: job.id,
                            spuId: item.spuId,
                            title: item.title,
                            productVersion: item.productVersion,
                            dataHash: item.dataHash,
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
                return { storeId, storeName, claimed };
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
            const nextAgent = agent;
            if (targetIndex >= 0) state.agents[targetIndex] = nextAgent;
            else state.agents = [nextAgent, ...(state.agents || [])].slice(0, 50);
            await writeState(state);
            return { storeId, storeName, claimed };
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
            if (job.mode === "manual-plugin-upload" && ["received", "upload_opened", "uploaded"].includes(status)) {
                const pluginInstanceId = asText(input.pluginInstanceId);
                const agent = (state.agents || []).find((entry) => asText(entry.storeId) === storeId
                    && asText(entry.pluginInstanceId) === pluginInstanceId);
                const pageStoreName = asText(input.pageStoreName || input.storeName);
                if (!pluginInstanceId || !agent || !agent.pluginDetected || !agent.identityMatched
                    || !hasManualTransferPlugin(agent) || !pageStoreName
                    || (job.targetStoreName && !namesCompatible(job.targetStoreName, pageStoreName))) {
                    throw httpError("目标插件实例或当前页面店铺身份未核验", 409);
                }
            }
            const item = (job.items || []).find((entry) => entry.spuId === spuId);
            if (!item) throw httpError("job_item_not_found", 404);
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
            if (!entries.length) continue;
            const visible = entries.slice().sort((left, right) => String(right.at).localeCompare(String(left.at)));
            stores.push({
                storeId,
                storeName: asText(value.storeName) || storeId,
                sourceStoreId: asText(value.sourceStoreId),
                sourceStoreName: asText(value.sourceStoreName),
                updatedAt: asText(value.updatedAt) || visible[0].at,
                entries: visible
            });
        }
        stores.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
        return {
            retentionDays: 3,
            stores,
            entries: stores.flatMap((store) => store.entries)
        };
        });
    }

    async function clearStoreActivity(storeId) {
        return withLock(async () => {
            const id = asText(storeId);
            if (!id) throw httpError("storeId 不能为空", 400);
            await mkdir(workLogDir, { recursive: true });
            await rm(workLogPath(id), { force: true });
            return { storeId: id, deleted: true };
        });
    }

    /**
     * 网页自动刷新信号：只回传“页面该不该重绘”所需的紧凑字符串，避免为刷新反复拉取完整任务列表。
     * 在线状态按心跳窗口实时换算成布尔值：插件每 8 秒一次心跳不会反复触发重绘，
     * 而掉线满 35 秒后即使没有任何写入，也会在下一次轮询被识别出来。
     * 租约过期只在内存副本上推算，不写回任务文件，轮询不承担落盘副作用。
     */
    async function liveSignature() {
        return withLock(async () => {
            const state = await readState();
            const nowMs = Date.now();
            for (const job of state.jobs || []) expireStaleLeases(job, nowMs);
            const agents = (state.agents || []).map((agent) => [
                asText(agent.storeId),
                isAgentOnline(agent, nowMs) ? 1 : 0,
                asText(agent.pluginVersion),
                agent.identityMatched ? 1 : 0,
                hasManualTransferPlugin(agent) ? 1 : 0
            ].join(":")).sort().join(";");
            const jobs = (state.jobs || []).map((job) => [
                asText(job.id),
                asText(job.status),
                asText(job.updatedAt),
                (job.items || []).map((item) => `${asText(item.spuId)}:${asText(item.status)}:${asText(item.directState)}`).join(",")
            ].join(":")).join(";");
            let logs = "";
            try {
                const names = (await readdir(workLogDir)).filter((name) => name.endsWith(".json")).sort();
                const parts = [];
                for (const name of names) {
                    const info = await stat(path.join(workLogDir, name)).catch(() => null);
                    if (info) parts.push(`${name}:${Math.round(info.mtimeMs)}:${info.size}`);
                }
                logs = parts.join(";");
            } catch {
                // 日志目录尚未创建时按空日志处理，不影响任务和在线状态的刷新判断。
                logs = "";
            }
            return { agents, jobs, logs };
        });
    }

    /**
     * 本机工人回传打开店铺的结果。成功后商品项进入 opened，插件才能领取；失败不中断其他店铺。
     */
    async function reportOpenResult(input = {}) {
        return withLock(async () => {
            const jobId = asText(input.jobId);
            const storeId = asText(input.storeId || input.targetStoreId);
            const status = asText(input.status);
            if (!jobId || !storeId) throw httpError("jobId、storeId 不能为空", 400);
            if (!["opening", "opened", "plugin_missing", "retry_wait", "failed"].includes(status)) throw httpError("工人只接受 opening / opened / plugin_missing / retry_wait / failed", 400);
            const state = await readState();
            const job = (state.jobs || []).find((item) => item.id === jobId);
            if (!job) throw httpError("job_not_found", 404);
            if (job.targetStoreId !== storeId) throw httpError("打开结果与任务目标店不一致", 409);
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
     * 入库包可能只有 pluginInstanceId 和页面店名。按已登记 Agent 回填紫鸟来源店，
     * 不能用商品 SPU 或运营事后手选代替。
     */
    async function resolveIngestSource(input = {}) {
        const state = await readState();
        const matched = resolveAgentStore(state.agents, input);
        if (!matched || !asText(matched.storeId)) return null;
        const pageStoreName = asText(input.pageStoreName || input.storeName);
        // 入库回填必须同时证明采集页店名与当前 Agent 店名相容；宁可不回填，也不能归到错误店铺。
        if (!pageStoreName || !namesCompatible(pageStoreName, asText(matched.pageStoreName || matched.storeName))) return null;
        return {
            sourceStoreId: asText(matched.storeId),
            sourceStoreName: asText(matched.storeName || matched.pageStoreName),
            pluginInstanceId: asText(matched.pluginInstanceId)
        };
    }

    return {
        directProgress,
        directRetry,
        listJobs,
        liveSignature,
        getJob,
        createJob,
        cancelJob,
        registerAgent,
        claimJobs,
        reportProgress,
        listTargetTaskStates,
        listOpenRequests,
        reportOpenResult,
        listActivity,
        clearStoreActivity,
        resolveIngestSource
    };
}
