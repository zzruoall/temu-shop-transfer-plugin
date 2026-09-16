"use strict";

/** 操作日志与采集响应分开限额保存；只接收白名单状态，不复制消息正文、令牌或商品资料。 */
globalThis.TemuOperationLog = (() => {
    const KEY = "operationLogsV1";
    const FALLBACK_KEY = "operationLogFallbackV1";
    const LIMIT = 1500;
    const BYTES = 1024 * 1024;
    let queue = Promise.resolve();
    let writeError = "";
    const fields = new Set(["action", "status", "error", "reason", "pageUrl", "endpoint", "requestPath", "storeId", "jobId", "spuId", "phase", "ingestPhase", "agentPhase", "pageType", "requestId", "tabId", "httpStatus", "durationMs", "pendingCount", "claimedCount", "taskCount", "completedCount", "expectedCount", "enabled", "tokenPresent", "permissionGranted", "identityMatched", "downloadId", "downloadState", "version"]);
    const ids = new Set(["storeId", "jobId", "spuId", "requestId"]);
    function clean(input = {}) {
        const entry = { loggedAt: new Date().toISOString(), category: "operation" };
        for (const [key, value] of Object.entries(input)) {
            if (!fields.has(key) || value == null) continue;
            if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) { entry[key] = value; continue; }
            if (typeof value !== "string") continue;
            // 含凭证赋值或结构化正文的自由文本整段丢弃，不能只遮掉首个 Cookie/带空格密码。
            if (/(?:["']?(?:cookie|authorization|password|passwd|secret|token|api[-_]?key)["']?\s*[:=]|\bbearer\s|[{}]|<\/?[a-z])/i.test(value)
                && key !== "pageUrl" && key !== "endpoint") { entry[key] = "[sensitive-text-omitted]"; continue; }
            if (key === "pageUrl" || key === "endpoint") {
                try { const url = new URL(value); entry[key] = `${url.origin}${url.pathname}`.slice(0, 240); } catch { entry[key] = ""; }
            } else if (ids.has(key)) {
                entry[key] = /^[\w-]{1,80}$/.test(value) ? value : "[invalid-id]";
            } else {
                // 错误只保留短摘要；剥离链接参数、常见凭证、邮箱及长随机值，禁止存储任意 HTML/正文。
                entry[key] = value.replace(/https?:\/\/\S+/gi, "[url]")
                    .replace(/(?:bearer\s+|["']?(?:token|cookie|authorization|password|secret|key)["']?\s*[:=]\s*["']?)\S+/gi, "[redacted]")
                    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
                    .replace(/\b1[3-9]\d{9}\b/g, "[phone]")
                    .replace(/[A-Za-z0-9_+/=-]{32,}/g, "[redacted]").slice(0, 240);
            }
        }
        return entry;
    }
    function append(input) {
        const entry = clean(input);
        const task = queue.then(async () => {
            const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
            const entries = Array.isArray(stored.entries) ? stored.entries : [];
            let dropped = Number(stored.dropped) || 0;
            entries.push(entry);
            while (entries.length > LIMIT || new TextEncoder().encode(JSON.stringify(entries)).length > BYTES) { entries.shift(); dropped++; }
            await chrome.storage.local.set({ [KEY]: { entries, dropped } });
        });
        queue = task.catch(async () => {
            writeError = "operation_log_storage_write_failed";
            // local 配额已满时使用独立 session 配额保留最后失败证据，服务工作线程重启后仍可诊断。
            try {
                const area = chrome.storage.session;
                if (!area) return;
                const previous = (await area.get(FALLBACK_KEY))[FALLBACK_KEY] || {};
                await area.set({ [FALLBACK_KEY]: { writeError, failedWrites: (previous.failedWrites || 0) + 1,
                    entries: [...(previous.entries || []), entry].slice(-50) } });
            } catch { /* 两个存储区都不可写时只能保留当前工作线程内的错误标记。 */ }
        });
        return queue;
    }
    async function read() {
        await queue;
        const stored = (await chrome.storage.local.get(KEY))[KEY] || {};
        const fallback = chrome.storage.session ? (await chrome.storage.session.get(FALLBACK_KEY))[FALLBACK_KEY] || {} : {};
        return { entries: [...(stored.entries || []), ...(fallback.entries || [])].sort((a, b) => a.loggedAt.localeCompare(b.loggedAt)),
            dropped: stored.dropped || 0, writeError: writeError || fallback.writeError || "", failedWrites: fallback.failedWrites || 0,
            maxEntries: LIMIT, maxBytes: BYTES };
    }
    return { append, read, clean };
})();
