/**
 * 本机紫鸟工人。从中转仓领取“需要打开的目标店”，用 CLI 打开店铺并核对页面。
 * 已打开的店铺只读取当前窗口，不主动改 URL。打开成功后核验页面店名和采集插件是否存在。
 * 历史任务只投递；新建且已确认合规的接口任务通过目标店登录态创建，不填写表单。
 */
import { runCli, parseCliJson } from "../hub/lib/ziniao-cli.mjs";
import { evaluateStoreIdentity, PAGE_INSPECT_SCRIPT, parseInspectPayload } from "../hub/lib/page-identity.mjs";
import { namesCompatible } from "../hub/lib/store-names.mjs";
import { readFile } from "node:fs/promises";
import { deliverCliTask } from "./cli-transport.mjs";
import { createDirectProduct } from "./direct-create.mjs";

const HUB_ORIGIN = String(process.env.SHOP_HUB_ORIGIN || "http://127.0.0.1:18380").replace(/\/+$/, "");
const TOKEN = String(process.env.SHOP_HUB_TOKEN || "").trim();
const INTERVAL_MS = Math.max(3000, Number(process.env.SHOP_HUB_WORKER_INTERVAL_MS) || 8000);
const CREATE_URL = "https://agentseller.temu.com/goods/list";
const ALLOWED = new Set(["store-list", "store-open", "page-visit", "page-content", "page-exec", "page-extract"]);

function asText(value) {
    return String(value || "").trim();
}

async function hubGet(pathname) {
    const headers = {};
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const response = await fetch(`${HUB_ORIGIN}${pathname}`, { headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `hub_http_${response.status}`);
    return data;
}

async function hubPost(pathname, body) {
    const headers = { "content-type": "application/json; charset=utf-8" };
    if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
    const response = await fetch(`${HUB_ORIGIN}${pathname}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body || {})
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `hub_http_${response.status}`);
    return data;
}

/**
 * 命令白名单。工人只能打开店铺和读取页面，不能把用户输入拼进 shell 字符串。
 */
async function runAllowed(command, args, timeoutMs) {
    if (!ALLOWED.has(command)) throw new Error(`command_not_allowed:${command}`);
    return runCli(args, timeoutMs);
}

function unwrapStores(value) {
    const data = value && typeof value === "object" && !Array.isArray(value) && "data" in value ? value.data : value;
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
        for (const key of ["stores", "list", "items", "records"]) if (Array.isArray(data[key])) return data[key];
    }
    return [];
}

async function listLocalStores() {
    const raw = parseCliJson((await runAllowed("store-list", ["store", "list", "--format", "json"], 20000)).stdout);
    return unwrapStores(raw).map((item) => ({
        storeId: asText(item.storeId ?? item.id ?? item.accountId),
        name: asText(item.storeName ?? item.name ?? item.shopName)
    })).filter((item) => item.storeId);
}

/**
 * 读取当前已打开窗口，不主动导航。店铺已开时不要再 store open --url，避免把运营正在看的页带走。
 */
async function listRunningStores() {
    const raw = parseCliJson((await runAllowed("page-extract", ["page", "extract", "--mode", "running"], 20000)).stdout);
    const data = raw && typeof raw === "object" && raw.data && typeof raw.data === "object" ? raw.data : raw;
    const items = Array.isArray(data && data.items) ? data.items : unwrapStores(raw);
    return items.map((item) => ({
        storeId: asText(item.storeId || item.id),
        storeName: asText(item.storeName || item.name)
    })).filter((item) => item.storeId);
}

function unwrapExecResult(raw) {
    const parsed = parseCliJson(raw);
    return parsed && parsed.data && parsed.data.data ? parsed.data.data : parsed && parsed.data ? parsed.data : parsed;
}

/**
 * 在当前窗口执行只读检查：页面 URL、店名文本、插件宿主是否存在。
 */
async function inspectOpenedStore(storeId) {
    const raw = (await runAllowed("page-exec", ["page", "exec", "--store-id", storeId, "--script", PAGE_INSPECT_SCRIPT, "--timeout", "15000"], 20000)).stdout;
    return parseInspectPayload(unwrapExecResult(raw));
}

async function ensureStoreWindow(storeId, alreadyOpen) {
    if (alreadyOpen) return { reused: true };
    await runAllowed("store-open", ["store", "open", "--id", storeId, "--url", CREATE_URL], 120000);
    await runAllowed("page-visit", ["page", "visit", "--store-id", storeId, "--url", CREATE_URL, "--wait-until", "load", "--timeout", "25000"], 30000);
    return { reused: false };
}

function isRetryableOpenError(message) {
    return /timeout|超时|temporarily|unavailable|not running|未启动|无法连接/i.test(asText(message));
}

/**
 * 领取后必须按页面店名和插件标记回传。没有插件时记 plugin_missing，不能写成身份已核验。
 */
async function claimAndVerify(request, inspect, storeName, expectedName) {
    const storeId = asText(request.targetStoreId);
    const verifiedIds = [];
    const missingIds = [];
    const mismatchIds = [];
    const verdict = evaluateStoreIdentity({
        expectedName,
        pageStoreName: inspect.pageStoreName,
        boundStoreName: inspect.boundStoreName || storeName,
        snippet: inspect.snippet,
        url: inspect.url,
        pluginPanelPresent: inspect.pluginPanelPresent,
        pluginDetected: inspect.pluginDetected,
        pluginVersion: inspect.pluginVersion
    });
    try {
        await hubPost("/api/agents/register", {
            storeId,
            storeName: asText(storeName) || asText(request.targetStoreName),
            pageUrl: inspect.url,
            pageStoreName: inspect.pageStoreName || verdict.pageStoreName,
            pluginVersion: inspect.pluginVersion,
            pluginDetected: inspect.pluginDetected,
            identityMatched: verdict.identityMatched,
            pluginInstanceId: inspect.pluginInstanceId,
            pageType: inspect.pageType,
            nameSource: inspect.nameSource,
            expectedCount: Number(inspect.expectedCount) || null,
            completedCount: Number(inspect.completedCount) || null,
            capturePhase: inspect.capturePhase,
            ingestPhase: inspect.ingestPhase,
            source: "worker-inspect"
        }).catch((error) => console.error(`[worker] 登记店铺失败 ${error.message}`));
        const claimed = await hubPost("/api/jobs/claim", {
            storeId,
            storeName: asText(storeName) || asText(request.targetStoreName),
            pageUrl: inspect.url,
            pluginVersion: inspect.pluginVersion,
        pluginDetected: inspect.pluginDetected,
        identityMatched: verdict.identityMatched,
        pageStoreName: inspect.pageStoreName || verdict.pageStoreName,
            pluginInstanceId: inspect.pluginInstanceId,
            // worker 只做店铺打开和身份核验，明确禁止领取含完整商品快照的人工上传任务。
            claimManualUploads: false,
            source: "worker-inspect"
        });
        const jobs = Array.isArray(claimed.claimed) ? claimed.claimed.filter((item) => item.jobId === request.jobId) : [];
        for (const job of jobs) {
            const status = verdict.identityMatched
                ? (inspect.pluginDetected ? "identity_verified" : "plugin_missing")
                : (verdict.blocked ? "failed" : "identity_mismatch");
            await hubPost("/api/jobs/report", {
                jobId: job.jobId,
                spuId: job.spuId,
                storeId,
                status,
                claimToken: job.claimToken,
                pageUrl: inspect.url,
                pageStoreName: inspect.pageStoreName || verdict.pageStoreName,
                pluginDetected: inspect.pluginDetected,
                pluginVersion: inspect.pluginVersion,
                reason: verdict.reason
            });
            if (status === "identity_verified") verifiedIds.push(job.spuId);
            else if (status === "plugin_missing") missingIds.push(job.spuId);
            else mismatchIds.push(job.spuId);
        }
        return { verifiedIds, missingIds, mismatchIds, verdict };
    } catch (error) {
        error.verifiedIds = verifiedIds;
        error.missingIds = missingIds;
        error.mismatchIds = mismatchIds;
        throw error;
    }
}

/**
 * 同一轮可能有多个任务指向同一目标店。打开一次即可，但每个任务都要回传，不能按 storeId 丢掉后面的任务。
 */
function groupRequestsByStore(requests) {
    const groups = new Map();
    for (const request of requests) {
        const storeId = asText(request.targetStoreId);
        if (!storeId) continue;
        const list = groups.get(storeId) || [];
        list.push(request);
        groups.set(storeId, list);
    }
    return groups;
}

/**
 * 工人回传打开结果。单店失败只影响该店任务，不中断其他店铺。
 */
async function reportOpenForRequests(requests, storeId, status, extra = {}) {
    for (const request of requests) {
        await hubPost("/api/jobs/open-result", {
            jobId: request.jobId,
            storeId,
            status,
            reason: extra.reason,
            pageUrl: extra.pageUrl,
            snippet: extra.snippet,
            spuIds: request.spuIds || []
        }).catch((error) => console.error(`[worker] 回传失败 ${error.message}`));
    }
}

/**
 * 领取时必须带上任务里的目标店名，否则队列会因店名不一致跳过；本机店名对得上则优先用本机名。
 */
function claimStoreName(request, knownName) {
    if (namesCompatible(request.targetStoreName, knownName)) return knownName;
    return asText(request.targetStoreName) || asText(knownName);
}

/**
 * 每轮读取已打开店铺并登记真实身份；人工上传任务不在旧打开队列中，必须独立同步。
 */
async function inspectIdleStores(running, stores) {
    for (const opened of running) {
        const known = stores.find((item) => item.storeId === opened.storeId) || opened;
        try {
            const inspect = await inspectOpenedStore(opened.storeId);
            const expectedName = known.name || opened.storeName;
            const verdict = evaluateStoreIdentity({
                expectedName,
                pageStoreName: inspect.pageStoreName,
                snippet: inspect.snippet,
                url: inspect.url,
                pluginPanelPresent: inspect.pluginPanelPresent,
                pluginDetected: inspect.pluginDetected,
                pluginVersion: inspect.pluginVersion
            });
            await hubPost("/api/agents/register", {
                storeId: opened.storeId,
                storeName: expectedName,
                pageUrl: inspect.url,
                pageStoreName: inspect.pageStoreName || verdict.pageStoreName,
                pluginVersion: inspect.pluginVersion,
                pluginDetected: inspect.pluginDetected,
                identityMatched: verdict.identityMatched,
                pluginInstanceId: inspect.pluginInstanceId,
                pageType: inspect.pageType,
                nameSource: inspect.nameSource,
                expectedCount: Number(inspect.expectedCount) || null,
                completedCount: Number(inspect.completedCount) || null,
                capturePhase: inspect.capturePhase,
                ingestPhase: inspect.ingestPhase,
                source: "worker-idle-inspect"
            });
            console.log(`[worker] 已打开店铺 ${expectedName || opened.storeId} 插件${inspect.pluginDetected ? "在场" : "未检测到"}，店名${verdict.identityMatched ? "匹配" : "未核验"}`);
            await syncManualTasks(opened.storeId, expectedName, inspect, verdict);
        } catch (error) {
            console.error(`[worker] 读取已打开店铺失败 ${opened.storeId}: ${error.message}`);
        }
    }
}

/** 签名同步并按容量投递；只有显式授权的新接口任务才执行单次创建。 */
async function syncManualTasks(storeId, storeName, inspect, verdict) {
    const version = String(inspect.pluginVersion || "").split(".").map(Number);
    if (process.env.SHOP_HUB_CLI_DELIVERY !== "1" || !verdict.identityMatched || !inspect.pluginDetected || !inspect.pluginInstanceId || version[0] !== 10 || !Number.isInteger(version[1]) || version[1] < 7) return;
    const privateKey = await readFile(new URL("../ziniao.pem", import.meta.url));
    const identity = { storeId, storeName, pageUrl: inspect.url, pageStoreName: inspect.pageStoreName, pluginVersion: inspect.pluginVersion, pluginDetected: true, identityMatched: true, pluginInstanceId: inspect.pluginInstanceId, source: "worker-cli-delivery" };
    const options = { storeId, privateKey, pluginInstanceId: inspect.pluginInstanceId, pageStoreName: inspect.pageStoreName };
    const jobs = (await hubGet("/api/jobs")).jobs || [];
    const entries = jobs.filter(job => job.targetStoreId === storeId && job.mode === "manual-plugin-upload").flatMap(job => (job.items || []).map(item => ({ job, item })));
    let receipt = null;
    if (version[1] >= 7) {
        // 分片只声明已知状态，插件不得把片内缺席解释为取消；避免历史任务累计撑爆单包。
        const syncStates = entries.map(({job,item}) => ({jobId:job.id,spuId:item.spuId,status:item.status,directState:item.directState||"",reason:item.reason||"",createdProductId:item.createdProductId||""}));
        for (let offset = 0; offset < Math.max(1, syncStates.length); offset += 500) {
            receipt = await deliverCliTask({ ...options, syncStates: syncStates.slice(offset, offset + 500) });
        }
        for (const pending of receipt.tasks.filter(item => item.openRequested)) {
            const found = entries.find(({job,item}) => !job.directCreate && job.id === pending.jobId && item.spuId === pending.spuId && item.status === "received" && item.claimToken);
            if (found) await hubPost("/api/jobs/report", { ...identity, jobId: found.job.id, spuId: found.item.spuId, claimToken: found.item.claimToken, status: "upload_opened" });
        }
        // 完成回报仅转交操作者明确确认，不把接收或打开页面当作平台发布成功。
        for (const pending of receipt.tasks.filter(item => item.completionRequested)) {
            const found = entries.find(({job,item}) => !job.directCreate && job.id === pending.jobId && item.spuId === pending.spuId && item.status === "upload_opened" && item.claimToken);
            if (found) await hubPost("/api/jobs/report", { ...identity, jobId: found.job.id, spuId: found.item.spuId, claimToken: found.item.claimToken, status: "uploaded", reason: "操作者确认上传（CLI回传，未执行自动发布）" });
        }
        // 每轮只处理一个已被目标插件接收的接口任务；已占位的任务绝不重新提交。
        const direct = entries.find(({job,item}) => job.directCreate && item.status === "received" && !item.directState && receipt.tasks.some(t=>t.jobId===job.id&&t.spuId===item.spuId));
        if (direct && version[1] >= 9) {
            await createDirectProduct({...direct,identity,hubPost});
            return;
        }
        // 工人重启后的未决提交只标记待核对，不能把未知当作失败后重发。
        const uncertain = entries.find(({item}) => item.directState === "creating");
        if (uncertain) await hubPost("/api/jobs/direct-progress", {...identity,jobId:uncertain.job.id,spuId:uncertain.item.spuId,claimToken:uncertain.item.claimToken,phase:"unknown",attemptId:uncertain.item.directAttemptId,reason:"连接器未取得最终回执，请先核对目标商品列表及本地 direct-results 回执，禁止重发"});
        // 恢复只针对未开始操作的任务；已打开上传页的任务绝不自动复制到新实例。
        const recover = entries.find(({job,item}) => item.claimToken && (item.status === "claimed" || (item.status === "received" && !receipt.tasks.some(task => task.jobId === job.id && task.spuId === item.spuId))));
        if (recover) {
            const { job, item } = recover;
            const task = { ...item, jobId: job.id, targetStoreId: storeId, sourceStoreId: job.sourceStoreId, sourceBatchId: job.sourceBatchId, mode: job.mode };
            await deliverCliTask({ ...options, task });
            if (item.status === "claimed") await hubPost("/api/jobs/report", { ...identity, jobId: job.id, spuId: item.spuId, claimToken: item.claimToken, status: "received" });
            return;
        }
    }
    // 每轮最多领取一个新任务，容量摘要异常时拒绝继续领取，而不是假定插件为空。
    if (receipt && (!Number.isFinite(receipt.pendingUploadCount) || !Number.isFinite(receipt.pendingUploadBytes) || receipt.pendingUploadCount < 0 || receipt.pendingUploadBytes < 0)) throw new Error("cli_capacity_invalid");
    const claimed = await hubPost("/api/jobs/claim", { ...identity, claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: Math.max(29, receipt?.pendingUploadCount || 0), pendingUploadBytes: receipt?.pendingUploadBytes || 0 });
    for (const task of (claimed.claimed || []).filter(task => task.mode === "manual-plugin-upload")) {
        await deliverCliTask({ ...options, task });
        await hubPost("/api/jobs/report", { ...identity, jobId: task.jobId, spuId: task.spuId, claimToken: task.claimToken, status: "received" });
        console.log(`[worker] 插件确认接收 ${task.jobId}/${task.spuId}`);
    }
}

async function tick() {
    const payload = await hubGet("/api/jobs/open-requests");
    const requests = Array.isArray(payload.requests) ? payload.requests : [];
    const stores = await listLocalStores();
    const running = await listRunningStores().catch(() => []);
    await inspectIdleStores(running, stores);
    if (!requests.length) {
        console.log(`[worker] 暂无待打开店铺，已检查 ${running.length} 个已打开窗口 ${new Date().toISOString()}`);
        return;
    }
    for (const [storeId, group] of groupRequestsByStore(requests)) {
        const known = stores.find((item) => item.storeId === storeId);
        if (!known) {
            console.log(`[worker] 本地没有目标店 ${storeId}`);
            await reportOpenForRequests(group, storeId, "failed", { reason: "本机紫鸟没有这个目标店" });
            continue;
        }
        const alreadyOpen = running.some((item) => item.storeId === storeId);
        console.log(`[worker] ${alreadyOpen ? "读取已打开店铺" : "打开目标店"} ${known.name || storeId}`);
        try {
            await reportOpenForRequests(group, storeId, "opening", { reason: alreadyOpen ? "本机工人正在读取已打开目标店" : "本机工人正在打开目标店" });
            await ensureStoreWindow(storeId, alreadyOpen);
            const inspect = await inspectOpenedStore(storeId);
            const expectedName = claimStoreName(group[0], known.name);
            const verdict = evaluateStoreIdentity({
                expectedName,
                pageStoreName: inspect.pageStoreName,
                boundStoreName: inspect.boundStoreName || known.name,
                snippet: inspect.snippet,
                url: inspect.url,
                pluginPanelPresent: inspect.pluginPanelPresent,
                pluginDetected: inspect.pluginDetected,
                pluginVersion: inspect.pluginVersion
            });
            if (verdict.blocked) {
                await reportOpenForRequests(group, storeId, "retry_wait", {
                    reason: verdict.reason,
                    pageUrl: inspect.url,
                    snippet: inspect.snippet
                });
                console.log(`[worker] 目标店被登录/验证码阻断 ${storeId}`);
                continue;
            }
            if (!verdict.pluginDetected) {
                // 先登记真实探测证据，再把任务落到可恢复的缺插件状态；不能借领取凭证伪造核验。
                await hubPost("/api/agents/register", {
                    storeId,
                    storeName: known.name || group[0].targetStoreName || "",
                    pageUrl: inspect.url,
                    pageStoreName: inspect.pageStoreName || verdict.pageStoreName,
                    pluginVersion: inspect.pluginVersion,
                    pluginDetected: false,
                    identityMatched: verdict.identityMatched,
                    pluginInstanceId: inspect.pluginInstanceId,
                    pageType: inspect.pageType,
                    nameSource: inspect.nameSource,
                    source: "worker-plugin-missing"
                }).catch((error) => console.error(`[worker] 登记缺插件店铺失败 ${error.message}`));
                await reportOpenForRequests(group, storeId, "plugin_missing", {
                    reason: verdict.reason,
                    pageUrl: inspect.url,
                    snippet: inspect.snippet
                });
                console.log(`[worker] 目标店缺少兼容插件 ${storeId}`);
                continue;
            }
            await reportOpenForRequests(group, storeId, "opened", {
                reason: alreadyOpen ? "目标店窗口已存在，本机工人读取当前页核验" : "目标店已打开，本机工人代领并核验",
                pageUrl: inspect.url,
                snippet: inspect.snippet
            });
            let verified = 0;
            let missing = 0;
            for (const request of group.filter(request => request.mode !== "manual-plugin-upload")) {
                try {
                    const result = await claimAndVerify(request, inspect, claimStoreName(request, known.name), expectedName);
                    verified += result.verifiedIds.length;
                    missing += result.missingIds.length;
                    const leftover = (request.spuIds || []).filter((spuId) => ![...result.verifiedIds, ...result.missingIds, ...result.mismatchIds].includes(spuId));
                    if (leftover.length) {
                        console.error(`[worker] 已打开但未能核验 ${request.jobId}：${leftover.join("、")}，等待领取租约到期后重新排队`);
                    }
                } catch (error) {
                    console.error(`[worker] 代领失败 ${request.jobId}: ${error.message}`);
                    const verifiedIds = Array.isArray(error && error.verifiedIds) ? error.verifiedIds : [];
                    verified += verifiedIds.length;
                }
            }
            console.log(`[worker] 已读取并核验 ${storeId}，身份通过 ${verified}，未检测到插件 ${missing}`);
        } catch (error) {
            console.error(`[worker] 打开失败 ${storeId}: ${error.message}`);
            const message = String(error && error.message || error).slice(0, 240);
            await reportOpenForRequests(group, storeId, isRetryableOpenError(message) ? "retry_wait" : "failed", {
                reason: message
            });
        }
    }
}

console.log(`本机工人监听 ${HUB_ORIGIN} ，已打开店铺只读取当前页并检测插件，不填写、不发布`);
await tick().catch((error) => console.error(`[worker] ${error.message}`));
let ticking = false;
setInterval(() => {
    if (ticking) return;
    ticking = true;
    tick().catch((error) => console.error(`[worker] ${error.message}`)).finally(() => {
        ticking = false;
    });
}, INTERVAL_MS);
