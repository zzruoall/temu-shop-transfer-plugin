"use strict";

const DATABASE_NAME = "temu-local-dataset";
const DATABASE_VERSION = 2;
const EVENT_STORE = "events";
const statusElement = document.getElementById("status");
const detailElement = document.getElementById("detail");
const retryButton = document.getElementById("retry");

function getSampleRecords() {
    return new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        openRequest.onupgradeneeded = () => {
            const database = openRequest.result;
            const store = database.objectStoreNames.contains(EVENT_STORE)
                ? openRequest.transaction.objectStore(EVENT_STORE)
                : database.createObjectStore(EVENT_STORE, { keyPath: "eventId" });
            if (!store.indexNames.contains("dataType")) store.createIndex("dataType", "dataType", { unique: false });
            if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt", "savedAt", { unique: false });
        };
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => {
            const database = openRequest.result;
            if (!database.objectStoreNames.contains(EVENT_STORE)) {
                database.close();
                resolve([]);
                return;
            }
            const transaction = database.transaction(EVENT_STORE, "readonly");
            const store = transaction.objectStore(EVENT_STORE);
            const samplesByType = {};
            const countsByType = {};
            const request = store.openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                const record = cursor.value;
                const type = record.dataType || "unknown";
                countsByType[type] = (countsByType[type] || 0) + 1;
                if (!samplesByType[type]) samplesByType[type] = [];
                const samples = samplesByType[type];
                samples.push(record);
                samples.sort((left, right) => (left.payloadBytes || Infinity) - (right.payloadBytes || Infinity));
                if (samples.length > 3) samples.pop();
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
            transaction.onerror = () => {
                database.close();
                reject(transaction.error);
            };
            transaction.onabort = () => {
                database.close();
                reject(transaction.error || new Error("transaction_aborted"));
            };
            transaction.oncomplete = () => {
                database.close();
                resolve({
                    countsByType,
                    records: Object.values(samplesByType).flat()
                });
            };
        };
    });
}

/**
 * 读取插件 IndexedDB 中的全部响应。结构样本用于诊断，完整包则必须保留每一条已捕获正文，
 * 否则商品详情接口和图片地址可能恰好落在被样本裁掉的记录里。
 */
function getAllRecords() {
    return new Promise((resolve, reject) => {
        const openRequest = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        openRequest.onupgradeneeded = () => {
            const database = openRequest.result;
            const store = database.objectStoreNames.contains(EVENT_STORE)
                ? openRequest.transaction.objectStore(EVENT_STORE)
                : database.createObjectStore(EVENT_STORE, { keyPath: "eventId" });
            if (!store.indexNames.contains("dataType")) store.createIndex("dataType", "dataType", { unique: false });
            if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt", "savedAt", { unique: false });
        };
        openRequest.onerror = () => reject(openRequest.error);
        openRequest.onsuccess = () => {
            const database = openRequest.result;
            if (!database.objectStoreNames.contains(EVENT_STORE)) {
                database.close();
                resolve([]);
                return;
            }
            const transaction = database.transaction(EVENT_STORE, "readonly");
            const request = transaction.objectStore(EVENT_STORE).getAll();
            request.onsuccess = () => {
                database.close();
                resolve(Array.isArray(request.result) ? request.result : []);
            };
            request.onerror = () => {
                database.close();
                reject(request.error);
            };
            transaction.onerror = () => {
                database.close();
                reject(transaction.error);
            };
        };
    });
}

/** 生成可长期保存的完整包骨架；正文仍按原始响应保存，网站端再依据字段证据归并商品。 */
function makeFullPacket(records) {
    return makeFullCapturePacket(records);
}

/**
 * 在扩展页面创建 Blob 下载，避免大型商品样本使用 data URL 时触发浏览器长度上限。
 * 文件包含脱敏后的完整原始响应，可直接交给后续网站与数据库设计流程分析。
 */
async function exportDataset() {
    retryButton.hidden = true;
    statusElement.textContent = "正在读取插件本地数据库…";
    detailElement.textContent = "";
    try {
        const sample = await getSampleRecords();
        const records = sample.records;
        const dataset = {
            schemaVersion: 3,
            exportedAt: new Date().toISOString(),
            purpose: "用于分析 Temu 商品接口真实结构并设计网站与数据库",
            exportMode: "structure-samples",
            sampleLimitPerType: 3,
            totalCountsByType: sample.countsByType,
            sampleCount: records.length,
            records
        };
        const blob = new Blob([JSON.stringify(dataset, null, 2)], { type: "application/json;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const downloadId = await chrome.downloads.download({
            url: blobUrl,
            filename: `temu-local-dataset/temu-dataset-${stamp}.json`,
            saveAs: true
        });
        statusElement.textContent = `已提交结构样本下载，共 ${records.length} 条样本。`;
        detailElement.textContent = `文件大小约 ${(blob.size / 1024 / 1024).toFixed(2)} MB，下载任务 ID：${downloadId}`;
        const listener = delta => {
            if (delta.id !== downloadId || !delta.state) return;
            if (delta.state.current === "complete" || delta.state.current === "interrupted") {
                URL.revokeObjectURL(blobUrl);
                chrome.downloads.onChanged.removeListener(listener);
            }
        };
        chrome.downloads.onChanged.addListener(listener);
        setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
            chrome.downloads.onChanged.removeListener(listener);
        }, 30 * 60 * 1000);
    } catch (error) {
        statusElement.textContent = "导出失败";
        detailElement.textContent = error && error.message ? error.message : String(error);
        retryButton.hidden = false;
    }
}

/** 导出完整采集包，保留所有已捕获响应；它是正式入库使用的入口。 */
async function exportFullPacket() {
    retryButton.hidden = true;
    statusElement.textContent = "正在整理全部已捕获响应…";
    detailElement.textContent = "完整包可能比结构样本大，请不要关闭此页面。";
    try {
        const records = await getAllRecords();
        const packet = makeFullPacket(records);
        const blob = new Blob([JSON.stringify(packet, null, 2)], { type: "application/json;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const downloadId = await chrome.downloads.download({
            url: blobUrl,
            filename: `temu-local-dataset/temu-full-capture-${stamp}.json`,
            saveAs: true
        });
        statusElement.textContent = `已提交完整商品包下载，共 ${packet.records.length} 条响应。`;
        detailElement.textContent = `商品索引 ${packet.products.length} 个，文件约 ${(blob.size / 1024 / 1024).toFixed(2)} MB，下载任务 ID：${downloadId}`;
        const listener = delta => {
            if (delta.id !== downloadId || !delta.state) return;
            if (delta.state.current === "complete" || delta.state.current === "interrupted") {
                URL.revokeObjectURL(blobUrl);
                chrome.downloads.onChanged.removeListener(listener);
            }
        };
        chrome.downloads.onChanged.addListener(listener);
        setTimeout(() => {
            URL.revokeObjectURL(blobUrl);
            chrome.downloads.onChanged.removeListener(listener);
        }, 30 * 60 * 1000);
    } catch (error) {
        statusElement.textContent = "完整包导出失败";
        detailElement.textContent = error && error.message ? error.message : String(error);
        retryButton.hidden = false;
    }
}

retryButton.addEventListener("click", exportFullPacket);
document.getElementById("fullExport").addEventListener("click", exportFullPacket);
document.getElementById("sampleExport").addEventListener("click", exportDataset);
exportFullPacket();
