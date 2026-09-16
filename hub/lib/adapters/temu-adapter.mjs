import { missingCapabilities, PlatformAdapter } from "./base-adapter.mjs";

const CREATE_URL = "https://agentseller.temu.com/goods/create/category";
const LIST_URL = "https://agentseller.temu.com/goods/list";
const PAGE_SCRIPT = `JSON.stringify({
    url: location.href,
    title: document.title,
    host: location.host,
    hasCategorySearch: Boolean(document.querySelector('input[placeholder*="搜索分类"], input[placeholder*="搜索类目"]')),
    hasNextStep: /下一步/.test(document.body.innerText || ""),
    hasCreateHeading: /新建商品/.test(document.body.innerText || "") || /选择商品分类/.test(document.body.innerText || ""),
    hasSubmit: /(提交审核|立即发布|发布商品)/.test(document.body.innerText || ""),
    snippet: String(document.body.innerText || "").replace(/\\s+/g, " ").slice(0, 240)
})`;

function asText(value) {
    return String(value || "").trim();
}

function looksLikeTemu(store = {}) {
    const blob = `${store.platform || ""} ${store.name || ""} ${store.storeName || ""}`.toLowerCase();
    return /temu|kuajingmaihuo|agentseller/.test(blob);
}

/**
 * Temu 中国卖家中心草稿探测。实测可打开 /goods/create/category，
 * 但 ziniao-cli 没有 input[type=file] / 系统文件选择器，因此本适配器只探测页面，不填写、不提交。
 */
export class TemuAdapter extends PlatformAdapter {
    get id() {
        return "temu-draft";
    }

    get displayName() {
        return "Temu 草稿探测";
    }

    get capability() {
        return {
            canOpenStore: true,
            canDetectCreatePage: true,
            canFillFields: false,
            canUploadLocalImages: false,
            canSubmitDraft: false,
            canPublish: false
        };
    }

    matchesStore(store) {
        return looksLikeTemu(store);
    }

    /**
     * 打开目标店铺的新建商品分类页并截图。命中页面也不等于草稿已保存。
     */
    async inspectCreatePage({ store, product, screenshotPath, bridge }) {
        const storeId = asText(store && store.storeId);
        if (!storeId) throw new Error("target_store_missing");
        await bridge.ensureStoreOpen(storeId, LIST_URL);
        await bridge.visit(storeId, CREATE_URL);
        const page = await bridge.execScript(storeId, PAGE_SCRIPT);
        const snapshot = page && typeof page === "object" ? page : {};
        const url = asText(snapshot.url);
        const detected = /\/goods\/create\/category/i.test(url)
            && Boolean(snapshot.hasCreateHeading || snapshot.hasCategorySearch || snapshot.hasNextStep);
        let screenshot = "";
        try {
            screenshot = await bridge.screenshot(storeId, screenshotPath);
        } catch (error) {
            screenshot = "";
            snapshot.screenshotError = String(error && error.message || error).slice(0, 240);
        }
        return {
            adapter: this.id,
            submitted: false,
            published: false,
            detected,
            pageUrl: url,
            pageTitle: asText(snapshot.title),
            screenshot,
            capability: this.capability,
            blockers: [
                ...missingCapabilities(this.capability),
                detected ? "" : "未进入 Temu 新建商品分类页，不能继续填写"
            ].filter(Boolean),
            evidence: {
                spuId: asText(product && product.spuId),
                title: asText(product && product.title),
                hasCategorySearch: Boolean(snapshot.hasCategorySearch),
                hasNextStep: Boolean(snapshot.hasNextStep),
                snippet: asText(snapshot.snippet)
            }
        };
    }
}

export function createTemuAdapter() {
    return new TemuAdapter();
}
