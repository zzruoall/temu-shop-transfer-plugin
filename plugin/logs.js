"use strict";

const statusElement = document.getElementById("status");
const detailElement = document.getElementById("detail");
const downloadButton = document.getElementById("download");
let currentLogs = [];

function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload });
}

/**
 * 日志导出只包含状态、错误码、接口路径、体积和有限商品 ID 样本，不把原始商品响应或敏感字段复制到诊断文件。
 */
async function exportLogs() {
    downloadButton.disabled = true;
    statusElement.textContent = "正在生成操作日志文件…";
    try {
        const result = await send("getCaptureLogs");
        if (!result || !result.ok) throw new Error(result && result.error || "读取日志失败");
        currentLogs = Array.isArray(result.logs) ? result.logs : [];
        const operations = Array.isArray(result.operationLog?.entries) ? result.operationLog.entries : [];
        const operationFailures = operations.filter(item => ["failed", "blocked", "transport-failed"].includes(item.status));
        const failed = currentLogs.filter(item => item.status === "failed" || item.status === "api-detail-failed");
        const skipped = currentLogs.filter(item => item.status === "skipped");
        const errorSummary = {};
        failed.forEach(item => { errorSummary[item.error || "unknown"] = (errorSummary[item.error || "unknown"] || 0) + 1; });
        const skipSummary = {};
        skipped.forEach(item => { skipSummary[item.error || "unknown"] = (skipSummary[item.error || "unknown"] || 0) + 1; });
        // 运行摘要与网络事件分开统计，便于判断“日志已导出但任务尚未结束”的情况。
        const runSummaries = currentLogs.filter(item => item.status === "run-summary");
        const snapshots = currentLogs.filter(item => item.status === "run-snapshot");
        const latestRunSnapshot = [...snapshots].pop() || [...runSummaries].pop() || null;
        // 按 JSON 字段路径聚合 ID 来源，避免只看 ID 长度而误把 SKU/SKC 当成 SPU。
        const idSourceSummary = {};
        currentLogs.forEach(item => {
            const sourceGroups = item && item.idSources && typeof item.idSources === "object" ? item.idSources : {};
            Object.entries(sourceGroups).forEach(([type, sources]) => {
                if (!Array.isArray(sources)) return;
                sources.forEach(source => {
                    const key = `${type}:${source.path || "?"} (${source.key || "?"})`;
                    idSourceSummary[key] = (idSourceSummary[key] || 0) + (Number(source.count) || 0);
                });
            });
        });
        const dataset = {
            schemaVersion: 4,
            exportedAt: new Date().toISOString(),
            purpose: "分析插件采集、按钮操作、页面状态、连接请求、任务领取与上传回传；不包含网站服务端内部日志",
            sensitivePayloadIncluded: false,
            logCount: currentLogs.length,
            failedCount: failed.length,
            skippedCount: skipped.length,
            runSummaryCount: runSummaries.length,
            snapshotCount: snapshots.length,
            latestRunSnapshot,
            errorSummary,
            skipSummary,
            idSourceSummary,
            pluginVersion: chrome.runtime.getManifest().version,
            operationCount: operations.length,
            operationFailedCount: operationFailures.length,
            operationRetention: { maxEntries: result.operationLog?.maxEntries, maxBytes: result.operationLog?.maxBytes,
                dropped: result.operationLog?.dropped || 0, writeError: result.operationLog?.writeError || "",
                failedWrites: result.operationLog?.failedWrites || 0,
                note: "仅记录安装本版本后的插件操作；容量超限时保留最近记录，切页/重启不主动清空。离页瞬间或后台崩溃的在途消息可能未落盘。" },
            diagnosticState: result.diagnosticState,
            taskStates: result.taskStates,
            operations,
            logs: currentLogs
        };
        const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const downloadId = await chrome.downloads.download({
            url: blobUrl,
            filename: `temu-local-dataset/temu-operation-logs-${stamp}.json`,
            saveAs: true
        });
        statusElement.textContent = `已提交日志下载：操作 ${operations.length} 条，采集 ${currentLogs.length} 条。`;
        detailElement.textContent = `失败 ${failed.length} 条，跳过 ${skipped.length} 条，完成摘要 ${runSummaries.length} 条，导出时快照 ${snapshots.length} 条；下载任务 ID：${downloadId}\n错误统计：${JSON.stringify(errorSummary, null, 2)}\n跳过统计：${JSON.stringify(skipSummary, null, 2)}\n最近状态：${latestRunSnapshot ? `${latestRunSnapshot.phase || "未知"}，已完成 ${latestRunSnapshot.completedCount ?? "—"}/${latestRunSnapshot.expectedCount ?? "—"}` : "暂无"}`;
        detailElement.textContent += `\n操作失败或阻断 ${operationFailures.length} 条；容量裁剪 ${result.operationLog?.dropped || 0} 条。\n日志写入状态：${result.operationLog?.writeError || "正常"}\n连接配置：${result.diagnosticState?.tokenPresent ? "已有令牌（不导出内容）" : "缺少令牌"}；本地任务 ${result.diagnosticState?.taskCount || 0} 个。`;
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
    } catch (error) {
        statusElement.textContent = "日志导出失败";
        detailElement.textContent = error && error.message ? error.message : String(error);
    } finally {
        downloadButton.disabled = false;
    }
}

downloadButton.addEventListener("click", exportLogs);
exportLogs();
