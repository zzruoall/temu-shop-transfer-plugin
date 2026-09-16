import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile, rename, lstat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_INTERVAL_MS = 2000;
const DEFAULT_STABLE_MS = 1200;
const MAX_FILE_BYTES = 256 * 1024 * 1024;

/**
 * 监控插件下载目录，把已经写完的完整采集包交给同一仓库解析器。
 * 监控逻辑放在本机 Node 服务而不是网页里，是因为浏览器页面不能持续读取用户文件夹，
 * 同时也能绕开紫鸟浏览器访问本机 HTTP 服务时的网络隔离。
 */
export function createInboxWatcher(options = {}) {
    const importFiles = typeof options.importFiles === "function" ? options.importFiles : null;
    const intervalMs = Number.isFinite(options.intervalMs) ? Math.max(500, options.intervalMs) : DEFAULT_INTERVAL_MS;
    const stableMs = Number.isFinite(options.stableMs) ? Math.max(300, options.stableMs) : DEFAULT_STABLE_MS;
    const directories = [...new Set((Array.isArray(options.directories) ? options.directories : [options.directory]).map((item) => String(item || "").trim()).filter(Boolean).map((item) => path.resolve(item)))];
    const entries = new Map();
    const checkpointPath = options.checkpointPath ? path.resolve(options.checkpointPath) : "";
    const discoverDirectories = options.discoverDirectories;
    const discoveryIntervalMs = Math.max(500, Number(options.discoveryIntervalMs) || 30000);
    const directoryCutoffs = {};
    let initialized = false;
    let lastDiscoveryAt = 0;
    let discoveryPending = null;
    const state = {
        running: false,
        scanInProgress: false,
        directories,
        intervalMs,
        stableMs,
        scanned: 0,
        imported: 0,
        reused: 0,
        skipped: 0,
        failed: 0,
        lastScanAt: null,
        lastImportAt: null,
        lastError: "",
        discoveryError: "",
        lastDiscoveryAt: null,
        recent: []
    };
    let timer = null;

    /** 持久化每个目录的接入时间和已处理签名，重启不回放历史包，也不丢停机期间的新包。 */
    async function saveCheckpoint() {
        if (!checkpointPath) return;
        await mkdir(path.dirname(checkpointPath), { recursive: true });
        const data = { version: 1, directories, directoryCutoffs,
            entries: [...entries].filter(([, entry]) => entry.status === "done") };
        await writeFile(`${checkpointPath}.tmp`, JSON.stringify(data), "utf8");
        await rename(`${checkpointPath}.tmp`, checkpointPath);
    }

    /** 首次接入仅接收最近一天的包；更早文件保留在磁盘，由操作者明确手动导入。 */
    function registerDirectory(directory) {
        const resolved = path.resolve(directory);
        const key = resolved.toLowerCase();
        if (!directories.some(item => item.toLowerCase() === key)) directories.push(resolved);
        if (!(key in directoryCutoffs)) directoryCutoffs[key] = Date.now() - 24 * 60 * 60 * 1000;
    }

    async function initialize() {
        if (initialized) return;
        if (checkpointPath) {
            try {
                const saved = JSON.parse(await readFile(checkpointPath, "utf8"));
                if (saved.version !== 1 || !Array.isArray(saved.directories) || !Array.isArray(saved.entries)
                    || !saved.directoryCutoffs || typeof saved.directoryCutoffs !== "object") throw new Error("inbox_checkpoint_invalid");
                if (Object.values(saved.directoryCutoffs).some(value => !Number.isFinite(value) || value <= 0)) throw new Error("inbox_checkpoint_invalid_cutoff");
                Object.assign(directoryCutoffs, saved.directoryCutoffs);
                // 显式目录配置是监控边界，不得被上次自动发现或旧配置的持久目录扩大。
                if (typeof discoverDirectories === "function") saved.directories.forEach(registerDirectory);
                for (const [key, entry] of saved.entries) if (entry.status === "done") entries.set(key, entry);
            } catch (error) {
                // 损坏记录不能重置为全目录重放，否则可能恢复操作者删除的历史库存。
                if (error.code !== "ENOENT") throw error;
            }
        }
        directories.forEach(registerDirectory);
        await saveCheckpoint();
        initialized = true;
    }

    /** 目录发现独立运行，CLI 暂不可用时仍继续扫描已知目录，不阻塞网站启动和入库。 */
    function refreshDirectories() {
        if (typeof discoverDirectories !== "function" || discoveryPending || Date.now() - lastDiscoveryAt < discoveryIntervalMs) return;
        lastDiscoveryAt = Date.now();
        discoveryPending = Promise.resolve().then(discoverDirectories).then(result => {
            for (const directory of result.directories || []) registerDirectory(directory);
            state.discoveryError = String(result.error || "").slice(0, 240);
            state.lastDiscoveryAt = new Date().toISOString();
        }).catch(() => {
            state.discoveryError = "无法通过紫鸟 CLI 查询下载目录，请确认紫鸟和 CLI 已登录；已知目录继续监控。";
        }).finally(() => { discoveryPending = null; });
    }

    function isCandidate(name) {
        // 只自动处理完整包，日志/结构样本仍由用户在网页中明确上传，避免目录里任意 JSON 污染仓库。
        return /^temu-full-capture-[^/\\]+\.json$/i.test(String(name || ""));
    }

    function pushRecent(item) {
        state.recent.unshift(item);
        if (state.recent.length > 30) state.recent.length = 30;
    }

    async function inspectFile(filePath, directory) {
        const name = path.basename(filePath);
        if (!isCandidate(name)) return;
        let info;
        try {
            info = await lstat(filePath);
        } catch (error) {
            if (error && error.code === "ENOENT") return;
            throw error;
        }
        if (!info.isFile() || info.size <= 0 || info.size > MAX_FILE_BYTES) {
            state.skipped += 1;
            return;
        }
        const key = filePath.toLowerCase();
        const signature = `${info.size}:${info.mtimeMs}`;
        const previous = entries.get(key);
        if (previous && previous.signature === signature && previous.status === "done") return;
        if (checkpointPath && info.mtimeMs < directoryCutoffs[directory.toLowerCase()]) {
            entries.set(key, { signature, status: "done", reason: "historical_before_onboarding" });
            state.skipped += 1;
            pushRecent({ fileName: name, directory, status: "skipped", reason: "接入前的历史文件，请手动导入", at: new Date().toISOString() });
            return;
        }
        if (!previous || previous.signature !== signature) {
            entries.set(key, { signature, firstSeenAt: Date.now(), status: "pending" });
            return;
        }
        if (Date.now() - previous.firstSeenAt < stableMs) return;
        if (previous.status === "failed" && Date.now() - previous.lastTriedAt < 30000) return;
        if (!importFiles) throw new Error("inbox_importer_unavailable");
        entries.set(key, { ...previous, status: "processing" });
        try {
            const text = await readFile(filePath, "utf8");
            const after = await stat(filePath);
            // 下载写入过程中不能解析半个包；读前读后大小及修改时间必须一致。
            if (`${after.size}:${after.mtimeMs}` !== signature) {
                entries.delete(key);
                return;
            }
            const payload = JSON.parse(String(text || "").replace(/^\uFEFF/, ""));
            if (payload?.kind !== "full-capture-packet" || !Array.isArray(payload.records)) throw new Error("inbox_not_full_capture_packet");
            const hash = createHash("sha256").update(text).digest("hex");
            const result = await importFiles([{ originalName: name, payload }], {
                source: "local-inbox",
                sourceDirectory: directory,
                sourceFileHash: hash
            });
            const reused = Boolean(result && result.reused);
            const batch = result && result.batch || null;
            const productCount = Array.isArray(batch && batch.products) ? batch.products.length : 0;
            state.imported += reused ? 0 : 1;
            state.reused += reused ? 1 : 0;
            state.lastImportAt = new Date().toISOString();
            state.lastError = "";
            entries.set(key, { signature, firstSeenAt: previous.firstSeenAt, status: "done", batchId: batch && batch.id || "", productCount });
            // 最近文件只记入库结果，不把整包正文写进监控状态，避免页面轮询把采集包再带出来。
            pushRecent({
                fileName: name,
                directory,
                status: reused ? "reused" : "imported",
                batchId: batch && batch.id || "",
                productCount,
                at: state.lastImportAt
            });
        } catch (error) {
            state.failed += 1;
            state.lastError = String(error && error.message || error).slice(0, 240);
            entries.set(key, { ...previous, status: "failed", lastTriedAt: Date.now() });
            pushRecent({ fileName: name, directory, status: "failed", error: state.lastError, at: new Date().toISOString() });
        }
    }

    async function scan() {
        if (state.scanInProgress) return snapshot();
        state.scanInProgress = true;
        state.lastScanAt = new Date().toISOString();
        try {
            await initialize();
            refreshDirectories();
            for (const directory of [...directories]) {
                let names = [];
                try { names = await readdir(directory); } catch (error) {
                    // 店铺尚未首次下载时子目录不存在，不创建紫鸟目录，也不把它当作采集失败。
                    if (error.code === "ENOENT") continue;
                    state.lastError = String(error && error.message || error).slice(0, 240);
                    continue;
                }
                for (const name of names) {
                    state.scanned += 1;
                    await inspectFile(path.join(directory, name), directory);
                }
            }
            await saveCheckpoint();
        } finally {
            state.scanInProgress = false;
        }
        return snapshot();
    }

    function snapshot() {
        return {
            ...state,
            directories: [...state.directories],
            recent: state.recent.map((item) => ({ ...item }))
        };
    }

    async function start() {
        if (state.running) return snapshot();
        state.running = true;
        // 检查点异常仅暂停自动入库并暴露错误，不拖垮商品查看和手动上传；后续扫描仍禁止重放。
        try { await scan(); } catch (error) { state.lastError = String(error?.message || error).slice(0, 240); }
        timer = setInterval(() => { scan().catch((error) => { state.lastError = String(error && error.message || error).slice(0, 240); }); }, intervalMs);
        return snapshot();
    }

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        state.running = false;
        return snapshot();
    }

    return { start, stop, scan, snapshot };
}

