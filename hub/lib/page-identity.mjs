import { coreStoreName, nameFoundInText, namesCompatible } from "./store-names.mjs";

export const REQUIRED_PLUGIN_PRESENCE = "temu-local-capture";

function asText(value) {
    return String(value == null ? "" : value).trim();
}

/**
 * 页面检查只能承认当前中转插件写下的双重标记；历史面板只复用了 DOM id，
 * 不能据此让工人进入领取任务的后续状态。
 */
export function hasRequiredPlugin(presence, version) {
    const parts = asText(version).split(".").map(part => Number(part));
    return asText(presence) === REQUIRED_PLUGIN_PRESENCE
        && parts.length === 3
        && parts.every(Number.isInteger)
        && parts.every(part => part >= 0)
        && parts[0] === 10
        // 10.1.0 起才公开 pluginInstanceId 和自动店名；10.0.x 不能再进入领取状态。
        && parts[1] > 0;
}

/**
 * 工人在已打开的紫鸟窗口里执行这段脚本。
 * 只读取插件宿主公开的只读状态和页面文本，不填写、不点击、不跳转。
 * pluginDetected 的版本正则必须与 hasRequiredPlugin 一致：只承认 10.1+，10.0.x 视为未检测到。
 */
export const PAGE_INSPECT_SCRIPT = "JSON.stringify((function(){var panel=document.getElementById('temu-local-dataset-panel');function attr(name){return panel?String(panel.getAttribute(name)||''):'';}try{window.dispatchEvent(new Event('temu-shop-transfer-status-request'));}catch(e){}var presence=attr('data-plugin-presence');var version=attr('data-plugin-version');var body=document.body;var text=body?String(body.innerText||''):'';return{url:location.href,title:document.title,pluginPanelPresent:Boolean(panel),pluginPresence:presence,pluginDetected:Boolean(panel)&&presence==='temu-local-capture'&&/^10\\.(?:[1-9]\\d*)\\.\\d+$/.test(version),pluginVersion:version,pluginInstanceId:attr('data-plugin-instance-id'),boundStoreId:attr('data-mapped-store-id')||attr('data-bound-store-id'),boundStoreName:attr('data-mapped-store-name')||attr('data-bound-store-name'),pageStoreName:attr('data-page-store-name'),pageType:attr('data-page-type'),nameSource:attr('data-name-source'),expectedCount:attr('data-expected-count'),completedCount:attr('data-completed-count'),capturePhase:attr('data-capture-phase'),ingestPhase:attr('data-ingest-phase'),pendingUploadCount:attr('data-pending-upload-count'),snippet:text.slice(0,4000)};})())";

export function isTemuSellerUrl(url) {
    return /^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(asText(url));
}

/**
 * 登录/验证码页不能代领。商品列表也可能出现“登录态”，必须卡登录表单或验证码页。
 */
export function pageLooksBlocked(snippet) {
    const text = asText(snippet);
    return /验证码|安全验证|请登录|请登陆|login\s*(to|please)|sign\s*in|captcha|verify your identity/i.test(text);
}

function unwrapInspectNode(value) {
    let current = value;
    for (let i = 0; i < 8; i += 1) {
        if (typeof current === "string") {
            const text = current.trim();
            if (!text) return null;
            try {
                current = JSON.parse(text);
                continue;
            } catch {
                return { snippet: text.slice(0, 4000) };
            }
        }
        if (!current || typeof current !== "object") return null;
        if ("pluginDetected" in current || "pluginPanelPresent" in current || "pageStoreName" in current || "url" in current && "snippet" in current) {
            return current;
        }
        current = current.data || current.result || current.raw || null;
    }
    return null;
}

/**
 * 解开紫鸟 page exec 的多层 {ok,data:{data:{result}}} 包装，得到页面检查摘要。
 */
export function parseInspectPayload(raw) {
    const parsed = unwrapInspectNode(raw) || {};
    const pluginPresence = asText(parsed.pluginPresence);
    const pluginVersion = asText(parsed.pluginVersion);
    return {
        url: asText(parsed.url),
        title: asText(parsed.title),
        pluginPanelPresent: Boolean(parsed.pluginPanelPresent),
        pluginPresence,
        pluginDetected: hasRequiredPlugin(pluginPresence, pluginVersion),
        pluginVersion,
        pluginInstanceId: asText(parsed.pluginInstanceId),
        boundStoreId: asText(parsed.boundStoreId || parsed.mappedStoreId),
        boundStoreName: asText(parsed.boundStoreName || parsed.mappedStoreName),
        pageStoreName: asText(parsed.pageStoreName),
        pageType: asText(parsed.pageType),
        nameSource: asText(parsed.nameSource),
        expectedCount: asText(parsed.expectedCount),
        completedCount: asText(parsed.completedCount),
        capturePhase: asText(parsed.capturePhase),
        ingestPhase: asText(parsed.ingestPhase),
        pendingUploadCount: Number(parsed.pendingUploadCount) || 0,
        snippet: asText(parsed.snippet).slice(0, 4000)
    };
}

/**
 * 用页面店名、正文和插件标记核验目标店。紫鸟 storeId 不在 Temu DOM 里，不能从页面数字猜测。
 */
export function evaluateStoreIdentity(input = {}) {
    const expectedName = asText(input.expectedName);
    const pageStoreName = asText(input.pageStoreName);
    const snippet = asText(input.snippet);
    const url = asText(input.url);
    const pluginDetected = Boolean(input.pluginDetected);
    const pluginPanelPresent = Boolean(input.pluginPanelPresent);
    const blocked = pageLooksBlocked(snippet);
    const nameMatched = Boolean(expectedName) && (
        namesCompatible(pageStoreName, expectedName)
        || nameFoundInText(snippet, expectedName)
    );
    return {
        url,
        expectedName,
        pageStoreName: pageStoreName || (nameMatched ? coreStoreName(expectedName) : ""),
        pluginDetected,
        pluginPanelPresent,
        pluginVersion: asText(input.pluginVersion),
        blocked,
        temuPage: isTemuSellerUrl(url),
        identityMatched: Boolean(nameMatched && !blocked && isTemuSellerUrl(url)),
        reason: blocked
            ? "目标店页面像登录或验证码，不能核验身份"
            : !isTemuSellerUrl(url)
                ? "当前页不是 Temu 卖家中心"
                : !nameMatched
                ? "页面店名与目标店不一致"
                : !pluginDetected
                    ? (pluginPanelPresent ? "检测到旧版或不兼容插件面板，未检测到 10.x 中转插件" : "目标店已打开，但未检测到 10.x 中转插件")
                    : "页面店名与紫鸟店铺一致，并检测到采集插件"
    };
}
