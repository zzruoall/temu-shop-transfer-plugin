"use strict";

const statusElement = document.getElementById("status");
const endpointInput = document.getElementById("endpoint");
const tokenInput = document.getElementById("token");
const autoPushInput = document.getElementById("autoPush");
const storeIdInput = document.getElementById("storeId");
const storeNameInput = document.getElementById("storeName");

function setStatus(text) {
    statusElement.textContent = text;
}

/** 把直推失败码翻成设置页可执行说明；内部码不能直接展示给操作者。 */
function ingestErrorText(error) {
    const code = String(error || "");
    if (code === "missing_ingest_token") return "还没有中转仓令牌。请先启动中转仓，再保存并授权或粘贴首页令牌。";
    if (code === "ingest_permission_denied") return "还没有授权访问该入库地址，请再次点击保存并授权。";
    if (code === "invalid_ingest_endpoint") return "入库地址不是合法的 http/https 地址。";
    if (code === "ingest_unauthorized") return "令牌不正确，请从仓库首页重新复制。";
    if (code === "ingest_unreachable") return "插件无法访问当前仓库地址。请核对地址并在紫鸟测试访问；本机和局域网地址都可能受代理影响，请勿盲目切换。";
    if (code === "ingest_probe_timeout") return "仓库探测超过10秒。请检查网站运行状态、地址及紫鸟代理连接。";
    if (code === "ingest_endpoint_mismatch") return "入库地址路径不正确。请填写仓库首页给出的 /api/ingest 地址，不要改成 /api/wrong。";
    if (/failed to fetch|networkerror|net::/i.test(code)) return "插件请求未取得HTTP响应，请检查地址、访问权限与代理连接；这不表示商品资料有错。";
    return code || "未知错误";
}
async function loadSettings() {
    const result = await chrome.runtime.sendMessage({ type: "getIngestSettings" });
    if (!result || !result.ok) {
        setStatus(result && result.error ? result.error : "读取设置失败");
        return;
    }
    endpointInput.value = result.settings.endpoint || "http://127.0.0.1:18380/api/ingest";
    tokenInput.value = result.settings.token || "";
    autoPushInput.checked = result.settings.autoPush === true;
    const bound = await chrome.runtime.sendMessage({ type: "getBoundStore" });
    if (bound && bound.ok && bound.store) {
        storeIdInput.value = bound.store.storeId || "";
        storeNameInput.value = bound.store.storeName || "";
    }
    setStatus(result.settings.token
        ? "已读取中转仓设置。默认请在插件面板点击上传；店铺身份由插件识别，紫鸟店铺由工人自动映射。"
        : "本机地址已预填。保存并授权后，插件会尝试自动读取仓库令牌。");
}

async function saveSettings(requestPermission) {
    const endpoint = endpointInput.value.trim() || "http://127.0.0.1:18380/api/ingest";
    if (requestPermission !== false) {
        try {
            const origin = `${new URL(endpoint).origin}/*`;
            await chrome.permissions.request({ origins: [origin] });
        } catch (_) {}
    }
    const result = await chrome.runtime.sendMessage({
        type: "saveIngestSettings",
        settings: {
            endpoint,
            token: tokenInput.value,
            autoPush: autoPushInput.checked
        },
        requestPermission: requestPermission !== false
    });
    if (!result || !result.ok) {
        setStatus(result && result.error ? result.error : "保存失败");
        return null;
    }
    endpointInput.value = result.settings.endpoint;
    tokenInput.value = result.settings.token;
    autoPushInput.checked = result.settings.autoPush === true;
    if (result.permissionGranted === false) {
        setStatus("设置已保存，但还没有获得该地址的访问权限。紫鸟访问局域网时需要再次点击保存并授权。");
    } else {
        const bound = await chrome.runtime.sendMessage({
            type: "saveBoundStore",
            store: {
                storeId: storeIdInput.value.trim(),
                storeName: storeNameInput.value.trim()
            }
        });
        const storeHint = bound && bound.ok && bound.store && bound.store.storeId
            ? ` 已记录店铺 ${bound.store.storeId}。`
            : " 未手工绑定店铺，将由插件店名和本机工人自动映射。";
        setStatus((result.settings.autoPush === false
            ? "节点设置已保存。自动入库已关闭，采集结束后不会上传。"
            : "节点设置已保存。采集结束后会自动推送到中转仓。") + storeHint);
    }
    return result;
}

document.getElementById("save").addEventListener("click", async () => {
    await saveSettings(true);
});

document.getElementById("test").addEventListener("click", async () => {
    await saveSettings(true);
    setStatus("正在测试入库节点…");
    const result = await chrome.runtime.sendMessage({ type: "testIngest" });
    if (!result || !result.ok) {
        setStatus(result && result.error ? `连接失败：${ingestErrorText(result.error)}` : "连接失败");
        return;
    }
    setStatus(`连接成功。仓库返回 ${result.service || "ziniao-ingest"}，可推送地址 ${result.endpoints && result.endpoints[0] || result.origin || ""}`);
});

document.getElementById("push").addEventListener("click", async () => {
    await saveSettings(true);
    setStatus("正在推送当前完整商品包…");
    const result = await chrome.runtime.sendMessage({ type: "pushFullPacket" });
    if (!result || !result.ok) {
        setStatus(result && result.error ? `推送失败：${ingestErrorText(result.error)}` : "推送失败");
        return;
    }
    if (result.skipped) {
        setStatus(result.reason === "empty_packet" || result.reason === "no_products"
            ? "本地没有识别到可推送的商品记录，未创建批次。"
            : `未推送：${result.reason || "已跳过"}`);
        return;
    }
    const batchId = result.batchId || (result.batch && result.batch.id) || "";
    if (!result.reused && !batchId) {
        setStatus("中转仓没有返回批次，未记为推送成功。");
        return;
    }
    const reused = result.reused ? "仓库已有相同文件。" : "已新建批次。";
    const readiness = result.batch && result.batch.readiness || "";
    setStatus(`推送成功。${reused} 批次 ${batchId}。${readiness}`);
});

loadSettings();
