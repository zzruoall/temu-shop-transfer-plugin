"use strict";

const statusElement = document.getElementById("status");
const summaryElement = document.getElementById("summary");
const detailElement = document.getElementById("detail");
const jsonElement = document.getElementById("json");
const downloadButton = document.getElementById("download");
const refreshButton = document.getElementById("refresh");
let currentRecord = null;

function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ type, ...payload });
}

/** 统一空值显示，防止诊断摘要把 null/undefined 渲染成难以判断的字符串。 */
function text(value, fallback = "—") {
    return value === null || value === undefined || value === "" ? fallback : String(value);
}

/** 将诊断计数与页面身份摘要渲染成可快速核对的卡片，不把完整 HTML 塞进摘要区域。 */
function renderSummary(structure, record) {
    const counts = structure && structure.counts && typeof structure.counts === "object" ? structure.counts : {};
    const items = [
        ["采集时间", text(structure && structure.capturedAt)],
        ["表格数量", text(counts.tables, "0")],
        ["候选行", text(counts.visibleCandidateRows, "0")],
        ["SPU 命中行", text(counts.selectedProductRows, "0")],
        ["页面 SPU", text(Array.isArray(structure && structure.domProductIds) ? structure.domProductIds.length : 0, "0")],
        ["iframe", text(counts.iframes, "0")],
        ["开放 Shadow DOM", text(counts.openShadowRoots, "0")],
        ["保存时间", text(record && record.savedAt)]
    ];
    summaryElement.replaceChildren(...items.map(([label, value]) => {
        const item = document.createElement("div");
        item.className = "item";
        const labelElement = document.createElement("span");
        labelElement.className = "label";
        labelElement.textContent = label;
        const valueElement = document.createElement("span");
        valueElement.className = "value";
        valueElement.textContent = value;
        item.append(labelElement, valueElement);
        return item;
    }));
    detailElement.textContent = [
        `页面：${text(structure && structure.pageUrl)}`,
        `标题：${text(structure && structure.title)}`,
        `激活页签：${Array.isArray(structure && structure.activePageLabels) ? structure.activePageLabels.join(" / ") || "—" : "—"}`,
        `扫描根节点：${Array.isArray(structure && structure.roots) ? structure.roots.map(root => `${root.tag}${root.id ? `#${root.id}` : ""}`).join("、") || "—" : "—"}`,
        `扫描范围：${text(structure && structure.scanScope, "仅 document 主文档")}`
    ].join("\n");
}

/** 从后台读取最近一次页面结构；页面刷新后仍可继续下载上一份诊断。 */
async function loadStructure() {
    downloadButton.disabled = true;
    statusElement.textContent = "正在读取最近一次页面结构…";
    try {
        const result = await send("getPageStructure");
        if (!result || !result.ok) throw new Error(result && result.error || "读取页面结构失败");
        currentRecord = result.record;
        const structure = currentRecord && currentRecord.structure;
        if (!structure) {
            statusElement.textContent = "还没有页面结构诊断。请返回商品页点击“导出页面结构诊断”。";
            summaryElement.replaceChildren();
            detailElement.textContent = "";
            jsonElement.textContent = "暂无诊断数据";
            return;
        }
        renderSummary(structure, currentRecord);
        jsonElement.textContent = JSON.stringify(currentRecord, null, 2);
        downloadButton.disabled = false;
        statusElement.textContent = "页面结构诊断已读取。请下载 JSON 发回以便分析真实 DOM。";
    } catch (error) {
        statusElement.textContent = "读取页面结构失败";
        detailElement.textContent = error && error.message ? error.message : String(error);
    }
}

/** 通过 downloads API 导出保存的诊断记录，供开发侧按真实 DOM 修正规则。 */
async function downloadStructure() {
    if (!currentRecord || !currentRecord.structure) return;
    downloadButton.disabled = true;
    try {
        const dataset = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            purpose: "用于分析 Temu 紫鸟页面真实 DOM 结构与 SPU 识别结果",
            sensitivePayloadIncluded: false,
            record: currentRecord
        };
        const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const downloadId = await chrome.downloads.download({
            url: blobUrl,
            filename: `temu-local-dataset/temu-page-structure-${stamp}.json`,
            saveAs: true
        });
        statusElement.textContent = `已提交页面结构 JSON 下载，任务 ID：${downloadId}`;
        setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
    } catch (error) {
        statusElement.textContent = "页面结构 JSON 下载失败";
        detailElement.textContent = error && error.message ? error.message : String(error);
    } finally {
        downloadButton.disabled = false;
    }
}

downloadButton.addEventListener("click", downloadStructure);
refreshButton.addEventListener("click", loadStructure);
loadStructure();
