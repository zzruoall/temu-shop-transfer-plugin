"use strict";

const statusElement = document.getElementById("status");
const rowsElement = document.getElementById("rows");
const downloadButton = document.getElementById("download");
const refreshButton = document.getElementById("refresh");
const clearButton = document.getElementById("clear");
let dataset = { schemaVersion: 1, records: [] };
const sessionId = new URLSearchParams(location.search).get("session") || "";

function send(type, payload = {}) { return chrome.runtime.sendMessage({ type, ...payload }); }
function esc(value) { return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[char])); }
function paths(record) {
    const groups = record && record.idPaths || {};
    return Object.entries(groups).filter(([, values]) => Array.isArray(values) && values.length).map(([type, values]) => `${type}: ${values.slice(0, 4).join(", ")}`).join("\n") || "未发现明确 ID 字段";
}
function evidence(record) {
    const flags = record && record.flags || {};
    const labels = [];
    if (flags.images) labels.push("图片");
    if (flags.sku) labels.push("SKU");
    if (flags.specs) labels.push("规格");
    if (flags.detailText) labels.push("详情正文");
    return labels.join(" ") || "—";
}

async function load() {
    refreshButton.disabled = true;
    try {
        const result = await send("getInterfaceDiagnostics", { sessionId });
        if (!result || !result.ok) throw new Error(result && result.error || "读取诊断失败");
        dataset = result.diagnostics && typeof result.diagnostics === "object" ? result.diagnostics : { schemaVersion: 1, records: [] };
        const records = Array.isArray(dataset.records) ? dataset.records : [];
        const json = records.filter(item => item.status === "json");
        const skipped = records.filter(item => item.status === "skipped");
        document.getElementById("jsonCount").textContent = json.length;
        document.getElementById("skipCount").textContent = skipped.length;
        document.getElementById("imageCount").textContent = json.filter(item => item.flags && item.flags.images).length;
        document.getElementById("detailCount").textContent = json.filter(item => item.flags && item.flags.detailText).length;
        rowsElement.innerHTML = records.slice().reverse().map(record => {
            const queryKeys = Array.isArray(record.queryKeys) ? record.queryKeys : [];
            const bodyKeys = record.requestBody && Array.isArray(record.requestBody.keys) ? record.requestBody.keys : [];
            const bodyIds = record.requestBody && Array.isArray(record.requestBody.idFields) ? record.requestBody.idFields.map(field => `${field.key}=${field.sample}`).join(", ") : "";
            return `<tr><td>${esc(record.recordedAt || "")}</td><td><code>${esc(record.requestUrl || "")}</code><br><small>${esc(record.pageUrl || "")}</small></td><td>${esc(record.method || "")} / ${esc(record.transport || "")}</td><td>${record.status === "skipped" ? `<span class="badge skip">${esc(record.reason || "跳过")}</span>` : `<span class="badge">${esc(record.responseStatus || "JSON")}</span>`}</td><td>${esc(record.responseBytes == null ? "—" : record.responseBytes)} bytes<br>${esc(record.durationMs == null ? "—" : `${record.durationMs} ms`)}</td><td><code>${esc(paths(record))}</code><br><small>查询字段 ${esc(queryKeys.join(", ") || "—")}；请求字段 ${esc(bodyKeys.join(", ") || "—")}${bodyIds ? `；请求 ID ${esc(bodyIds)}` : ""}</small></td><td>${esc(evidence(record))}</td></tr>`;
        }).join("");
        statusElement.textContent = records.length ? `已读取 ${records.length} 条诊断记录${Number(dataset.droppedCount) ? `，因容量上限已丢弃 ${dataset.droppedCount} 条旧/超大记录` : ""}。诊断会话：${dataset.sessionId || "—"}` : "暂无诊断记录。请在 Temu 页面展开插件面板，点击“开始接口诊断”，再操作一次页面。";
    } catch (error) {
        statusElement.textContent = `读取失败：${error && error.message ? error.message : error}`;
    } finally { refreshButton.disabled = false; }
}

async function download() {
    downloadButton.disabled = true;
    try {
        const result = await send("getInterfaceDiagnostics", { sessionId });
        if (!result || !result.ok) throw new Error(result && result.error || "读取诊断失败");
        const exportData = { ...result.diagnostics, exportedAt: new Date().toISOString(), purpose: "用于定位可在列表页直接获取商品详情的接口", sensitivePayloadIncluded: false };
        const url = URL.createObjectURL(new Blob([JSON.stringify(exportData, null, 2)], { type: "application/json;charset=utf-8" }));
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await chrome.downloads.download({ url, filename: `temu-local-dataset/temu-interface-diagnostics-${stamp}.json`, saveAs: true });
        statusElement.textContent = "已提交接口诊断 JSON 下载。";
        setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
    } catch (error) { statusElement.textContent = `导出失败：${error && error.message ? error.message : error}`; }
    finally { downloadButton.disabled = false; }
}

async function clear() {
    if (!confirm("确定清空本次接口诊断吗？清空后不可恢复。")) return;
    const result = await send("clearInterfaceDiagnostics", { sessionId });
    if (!result || !result.ok) { statusElement.textContent = "清空失败。"; return; }
    await load();
}

downloadButton.addEventListener("click", download);
refreshButton.addEventListener("click", load);
clearButton.addEventListener("click", clear);
load().then(() => {
    // “停止并导出”打开本页时自动提交下载；用户日后重新打开页面仍可先检查再手动导出。
    if (new URLSearchParams(location.search).get("autodownload") === "1") download();
});
