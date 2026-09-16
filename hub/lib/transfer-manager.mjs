import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createTemuAdapter } from "./adapters/temu-adapter.mjs";
import { createZiniaoBridge, parseCliJson, runCli } from "./ziniao-cli.mjs";

function unwrapStores(value) {
    const data = value && typeof value === "object" && !Array.isArray(value) && "data" in value ? value.data : value;
    if (Array.isArray(data)) return data;
    if (data && typeof data === "object") {
        for (const key of ["stores", "list", "items", "records"]) if (Array.isArray(data[key])) return data[key];
    }
    return [];
}

function normalizeStore(item) {
    const value = item && typeof item === "object" ? item : {};
    const storeId = String(value.storeId ?? value.id ?? value.accountId ?? "").trim();
    const name = String(value.storeName ?? value.name ?? value.shopName ?? value.accountName ?? storeId).trim();
    return {
        storeId,
        name,
        platform: String(value.platform ?? value.platformName ?? "").trim(),
        status: String(value.status ?? value.state ?? "unknown").trim(),
        running: Boolean(value.running ?? value.isRunning ?? false),
        downloadFolderPath: String(value.downloadFolderPath ?? value.downloadPath ?? "").trim()
    };
}

/**
 * 保存目标店铺和上传任务的本地状态。创建任务只做资料预检；
 * 用户确认后才打开目标店铺页面做探测。当前 Temu 适配器不会点击保存/发布，
 * 打开页面成功也只能记成 probed，不能记成已上传。
 */
export function createTransferManager(rootDir, store, options = {}) {
    const dataDir = path.join(rootDir, "data");
    const filePath = path.join(dataDir, "transfer.json");
    const artifactDir = path.join(dataDir, "transfer-artifacts");
    const bridge = options.bridge || createZiniaoBridge({ runCli: options.runCli || runCli });
    const adapters = Array.isArray(options.adapters) && options.adapters.length ? options.adapters : [createTemuAdapter()];
    let mutation = Promise.resolve();
    let runningJobId = "";

    function httpError(message, status) {
        const error = new Error(message);
        error.status = status;
        return error;
    }

    function resolveAdapter(target) {
        return adapters.find((item) => item && typeof item.matchesStore === "function" && item.matchesStore(target)) || null;
    }

    function summarizeJob(job) {
        const items = Array.isArray(job.items) ? job.items : [];
        return {
            ...job,
            counts: {
                total: items.length,
                ready: items.filter((item) => item.status === "ready").length,
                probed: items.filter((item) => item.status === "probed").length,
                failed: items.filter((item) => item.status === "failed" || item.status === "blocked_page").length,
                blocked: items.filter((item) => item.status === "blocked").length
            }
        };
    }

    async function readState() {
        await mkdir(dataDir, { recursive: true });
        try {
            const value = JSON.parse(await readFile(filePath, "utf8"));
            return value && typeof value === "object" ? { stores: [], jobs: [], ...value } : { stores: [], jobs: [] };
        } catch (error) {
            if (error && error.code !== "ENOENT") throw error;
            return { stores: [], jobs: [] };
        }
    }

    async function writeState(state) {
        await writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
    }

    async function refreshStores() {
        const run = mutation.then(async () => {
        let result;
        try {
            result = parseCliJson((await runCli(["store", "list", "--format", "json"])).stdout);
        } catch (error) {
            const wrapped = new Error(`ziniao_store_list_failed:${String(error && error.message || error).slice(0, 300)}`);
            wrapped.status = 503;
            throw wrapped;
        }
        const stores = unwrapStores(result).map(normalizeStore).filter((item) => item.storeId);
        const state = await readState();
        state.stores = stores;
        state.storesUpdatedAt = new Date().toISOString();
        await writeState(state);
        return { stores, updatedAt: state.storesUpdatedAt };
        });
        mutation = run.catch(() => {});
        return run;
    }

    async function listStores() {
        const state = await readState();
        return { stores: state.stores || [], updatedAt: state.storesUpdatedAt || null };
    }

    async function createJob(input = {}) {
        const run = mutation.then(async () => {
        const targetStoreId = String(input.targetStoreId || "").trim();
        const sourceBatchId = String(input.sourceBatchId || "").trim();
        const requestedIds = [...new Set((Array.isArray(input.spuIds) ? input.spuIds : []).map((item) => String(item || "").trim()).filter(Boolean))];
        if (!targetStoreId || !sourceBatchId || !requestedIds.length) {
            const error = new Error("targetStoreId、sourceBatchId、spuIds 不能为空");
            error.status = 400;
            throw error;
        }
        const overview = await store.listOverview();
        const products = overview.products.filter((product) => requestedIds.includes(String(product.spuId)));
        const missingIds = requestedIds.filter((id) => !products.some((product) => String(product.spuId) === id));
        const notReadyIds = products.filter((product) => !product.ready).map((product) => String(product.spuId));
        const state = await readState();
        const target = (state.stores || []).find((item) => item.storeId === targetStoreId) || null;
        const now = new Date().toISOString();
        const adapter = target ? resolveAdapter(target) : null;
        const job = {
            id: randomUUID().slice(0, 12),
            createdAt: now,
            updatedAt: now,
            status: target && adapter && !missingIds.length && !notReadyIds.length ? "awaiting_confirmation" : "blocked_preflight",
            mode: "preflight-only",
            adapterId: adapter ? adapter.id : "",
            adapterName: adapter ? adapter.displayName : "",
            targetStoreId,
            targetStoreName: target ? target.name : "",
            targetPlatform: target ? target.platform : "",
            sourceBatchId,
            spuIds: requestedIds,
            items: products.map((product) => ({
                spuId: String(product.spuId),
                title: String(product.title || ""),
                status: product.ready ? "ready" : "blocked",
                submitted: false,
                published: false,
                reason: product.ready ? "" : "商品资料未齐"
            })),
            preflight: {
                missingIds,
                notReadyIds,
                targetStoreKnown: Boolean(target),
                adapterKnown: Boolean(adapter),
                readyCount: products.filter((product) => product.ready).length,
                productCount: products.length,
                note: adapter
                    ? "资料预检完成。确认后只会打开 Temu 新建商品页并截图，不会保存草稿或发布。"
                    : "找不到匹配的目标平台适配器，或店铺/资料未齐。"
            }
        };
        state.jobs = [job, ...(state.jobs || [])].slice(0, 200);
        await writeState(state);
        return summarizeJob(job);
        });
        mutation = run.catch(() => {});
        return run;
    }

    async function listJobs() {
        const state = await readState();
        return { jobs: (state.jobs || []).map(summarizeJob) };
    }

    async function getJob(id) {
        const state = await readState();
        const job = (state.jobs || []).find((item) => item.id === String(id || "")) || null;
        return job ? summarizeJob(job) : null;
    }

    async function cancelJob(id) {
        const run = mutation.then(async () => {
            const state = await readState();
            const job = (state.jobs || []).find((item) => item.id === String(id || ""));
            if (!job) { const error = new Error("transfer_job_not_found"); error.status = 404; throw error; }
            if (!["awaiting_confirmation", "queued", "blocked_preflight"].includes(job.status)) {
                const error = new Error("transfer_job_not_cancellable"); error.status = 409; throw error;
            }
            job.status = "cancelled";
            job.updatedAt = new Date().toISOString();
            await writeState(state);
            return summarizeJob(job);
        });
        mutation = run.catch(() => {});
        return run;
    }

    async function persistJob(job) {
        const state = await readState();
        const index = (state.jobs || []).findIndex((item) => item.id === job.id);
        if (index < 0) throw httpError("transfer_job_not_found", 404);
        job.updatedAt = new Date().toISOString();
        const stored = { ...job };
        delete stored.counts;
        state.jobs[index] = stored;
        await writeState(state);
        return summarizeJob(job);
    }

    async function loadProduct(spuId) {
        if (typeof store.getProduct === "function") {
            const payload = await store.getProduct(spuId);
            return payload && payload.product ? payload.product : payload;
        }
        const overview = await store.listOverview();
        return (overview.products || []).find((item) => String(item.spuId) === String(spuId)) || null;
    }

    /**
     * 用户确认后按 SPU 打开目标店铺新建页。同一任务不会并行执行，
     * 已 probed 的 SPU 默认跳过，避免把一次页面打开重复记成多次上传。
     */
    async function executeJob(jobId, { retryFailed = false } = {}) {
        if (runningJobId) throw httpError("已有转移任务正在执行", 409);
        const current = await getJob(jobId);
        if (!current) throw httpError("transfer_job_not_found", 404);
        const allowed = retryFailed
            ? ["failed", "partial", "blocked_page", "running"]
            : ["awaiting_confirmation", "queued"];
        if (!allowed.includes(current.status)) throw httpError("transfer_job_not_runnable", 409);
        const state = await readState();
        const target = (state.stores || []).find((item) => item.storeId === current.targetStoreId);
        if (!target) throw httpError("目标店铺不存在或尚未刷新店铺列表", 409);
        const adapter = resolveAdapter(target);
        if (!adapter) throw httpError("当前店铺没有可用的上传适配器", 409);
        runningJobId = current.id;
        current.status = "running";
        current.mode = adapter.id;
        current.adapterId = adapter.id;
        current.adapterName = adapter.displayName;
        current.confirmedAt = current.confirmedAt || new Date().toISOString();
        current.startedAt = new Date().toISOString();
        current.error = "";
        await persistJob(current);
        try {
            for (const item of current.items) {
                if (item.status === "blocked") continue;
                if (item.status === "probed" && !retryFailed) continue;
                if (retryFailed && !["failed", "blocked_page", "ready", "probing"].includes(item.status)) continue;
                const product = await loadProduct(item.spuId);
                if (!product || !product.ready) {
                    item.status = "blocked";
                    item.submitted = false;
                    item.published = false;
                    item.reason = "执行前复查：商品资料未齐";
                    await persistJob(current);
                    continue;
                }
                item.status = "probing";
                item.reason = "正在打开目标店铺新建商品页";
                await persistJob(current);
                const screenshotName = `${String(item.spuId || "").replace(/[^0-9A-Za-z_-]/g, "")}.png`;
                if (screenshotName === ".png") {
                    item.status = "failed";
                    item.submitted = false;
                    item.published = false;
                    item.reason = "SPU 不能用于截图文件名";
                    await persistJob(current);
                    continue;
                }
                const screenshotPath = path.join(artifactDir, current.id, screenshotName);
                try {
                    const result = await adapter.inspectCreatePage({
                        store: target,
                        product,
                        screenshotPath,
                        bridge
                    });
                    item.submitted = Boolean(result && result.submitted);
                    item.published = Boolean(result && result.published);
                    item.pageUrl = result && result.pageUrl || "";
                    item.screenshot = result && result.screenshot ? path.relative(dataDir, result.screenshot).replace(/\\/g, "/") : "";
                    item.evidence = result && result.evidence || null;
                    item.blockers = result && result.blockers || [];
                    if (item.submitted || item.published) {
                        // 当前适配器不允许提交；若未来误把提交写成 true，必须记失败而不是成功。
                        item.status = "failed";
                        item.reason = "适配器返回了提交/发布标记，但当前版本禁止自动提交";
                    } else if (result && result.detected) {
                        item.status = "probed";
                        item.reason = "已打开新建商品页并截图，未保存草稿，未发布";
                    } else {
                        item.status = "blocked_page";
                        item.reason = (result && result.blockers && result.blockers[0]) || "目标页面结构不匹配";
                    }
                } catch (error) {
                    item.status = "failed";
                    item.submitted = false;
                    item.published = false;
                    item.reason = String(error && error.message || error).slice(0, 300);
                }
                await persistJob(current);
            }
            const live = await getJob(current.id);
            const items = live.items || [];
            const actionable = items.filter((item) => item.status !== "blocked");
            const probed = actionable.filter((item) => item.status === "probed").length;
            const failed = actionable.filter((item) => item.status === "failed" || item.status === "blocked_page").length;
            if (!actionable.length) live.status = "blocked_preflight";
            else if (failed && probed) live.status = "partial";
            else if (failed) live.status = "failed";
            else live.status = "probed";
            live.finishedAt = new Date().toISOString();
            live.preflight = {
                ...(live.preflight || {}),
                note: "确认后只完成页面探测。probed 不是已上传，也不是已发布。"
            };
            return await persistJob(live);
        } catch (error) {
            current.status = "failed";
            current.error = String(error && error.message || error).slice(0, 300);
            current.finishedAt = new Date().toISOString();
            await persistJob(current);
            throw error;
        } finally {
            runningJobId = "";
        }
    }

    async function confirmJob(id) {
        const run = mutation.then(() => executeJob(id, { retryFailed: false }));
        mutation = run.catch(() => {});
        return run;
    }

    async function retryJob(id) {
        const run = mutation.then(() => executeJob(id, { retryFailed: true }));
        mutation = run.catch(() => {});
        return run;
    }

    function artifactPath(jobId, fileName) {
        const safeJob = path.basename(String(jobId || ""));
        const safeFile = path.basename(String(fileName || ""));
        if (!/^[a-zA-Z0-9_-]{1,32}$/.test(safeJob) || !/^[a-zA-Z0-9._-]{1,80}$/.test(safeFile)) return "";
        if (safeJob === "." || safeJob === ".." || safeFile === "." || safeFile === "..") return "";
        return path.join(artifactDir, safeJob, safeFile);
    }

    return { refreshStores, listStores, createJob, listJobs, getJob, cancelJob, confirmJob, retryJob, artifactPath };
}
