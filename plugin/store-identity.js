/**
 * 从当前卖家中心页面读取店铺身份。紫鸟店铺 ID 不会写在 Temu DOM 里，
 * 所以这里只提取页面可见的店铺名。紫鸟 storeId 由中转仓工人对照 store list 补齐，插件不再要求人工绑定。
 */
var TemuStoreIdentity = (function () {
    "use strict";

    function asText(value) {
        return String(value == null ? "" : value).trim();
    }

    function unique(values) {
        var seen = {};
        var result = [];
        (Array.isArray(values) ? values : []).forEach(function (value) {
            var text = asText(value);
            if (!text || seen[text]) return;
            seen[text] = true;
            result.push(text);
        });
        return result;
    }

    function textOf(node) {
        if (!node) return "";
        return asText(node.textContent || node.value || node.getAttribute && node.getAttribute("content"));
    }

    /**
     * 只采信页面上明确的店铺名，不把菜单、类目或商品标题当成店名。
     */
    function collectCandidateNames() {
        var names = [];
        if (typeof document === "undefined") return names;
        var selectors = [
            "[class*='mall-name']",
            "[class*='mallName']",
            // 当前卖家中心新版把店名放在 account-info_mallInfo__* 节点，
            // 类名不再包含 name；保留此白名单才能让插件自身完成店铺映射。
            "[class*='mall-info']",
            "[class*='mallInfo']",
            "[class*='shop-name']",
            "[class*='shopName']",
            "[class*='store-name']",
            "[class*='storeName']",
            "[class*='seller-name']",
            "[class*='sellerName']",
            "[class*='account-name']",
            "[class*='user-name']",
            "[data-testid*='mall']",
            "[data-testid*='shop']",
            "[data-testid*='store']",
            "header [class*='name']",
            ".ant-layout-header [class*='name']"
        ];
        selectors.forEach(function (selector) {
            document.querySelectorAll(selector).forEach(function (node) {
                var text = textOf(node);
                if (text && text.length <= 80) names.push(text);
            });
        });
        document.querySelectorAll("img[alt]").forEach(function (node) {
            var alt = asText(node.getAttribute("alt"));
            if (/mall|shop|store|店铺|商家/i.test(alt) && alt.length <= 80) names.push(alt);
        });
        return unique(names);
    }

    /**
     * 页头选择器经常为空。只扫 header/nav/aside，不把整页商品标题当成店名。
     */
    function collectRegionNames() {
        var names = [];
        if (typeof document === "undefined") return names;
        var regions = document.querySelectorAll("header, nav, aside, [class*='layout-header'], [class*='topbar'], [class*='TopBar'], [class*='Header']");
        regions.forEach(function (region) {
            var lines = asText(region.innerText || region.textContent).split(/\n+/);
            lines.forEach(function (line) {
                if (looksLikeShopName(line) && isStrongName(line)) names.push(line);
            });
        });
        return unique(names);
    }

    function looksLikeShopName(value) {
        var text = asText(value);
        if (!text || text.length < 2 || text.length > 80) return false;
        if (/^\d+$/.test(text)) return false;
        if (/^(全部|筛选|搜索|商品|订单|设置|首页|登录|退出|新建商品|商品列表|卖家中心)$/i.test(text)) return false;
        if (/商品|订单|设置|登录|筛选|管理|数据看板/.test(text) && text.length < 12) return false;
        return true;
    }

    function normalizeName(value) {
        return asText(value).toLowerCase().replace(/\s+/g, " ");
    }

    /**
     * 紫鸟店名常带托管备注，例如 `Hair removal wax-全托-若欧`；Temu 页头只显示前半段。
     * 取第一段时必须够长，避免把 `City` 这类短词当成店名核心。
     */
    function coreStoreName(value) {
        var text = asText(value);
        if (!text) return "";
        var parts = text.split(/\s*[-–—_|/·]\s*/).map(asText).filter(Boolean);
        if (parts.length >= 2 && (parts[0].length >= 8 || parts[0].split(/\s+/).length >= 2)) return parts[0];
        return text;
    }

    function isStrongName(value) {
        var text = normalizeName(value);
        return Boolean(text) && (text.length >= 8 || text.split(/\s+/).length >= 2);
    }

    function isNamePrefix(shortName, fullName) {
        var short = normalizeName(shortName);
        var full = normalizeName(fullName);
        if (!short || !full || !isStrongName(short)) return false;
        return full === short || full.indexOf(short + " ") === 0 || full.indexOf(short + "-") === 0;
    }

    /**
     * 返回当前页身份摘要。storeId 不会从 Temu DOM 猜测，避免把商品 ID 当成紫鸟店铺 ID。
     */
    function readPageIdentity() {
        var captured = asText(lastCapturedShopName);
        var selectorNames = collectCandidateNames().filter(looksLikeShopName);
        var names = unique([captured].concat(selectorNames, collectRegionNames())).filter(looksLikeShopName);
        var source = "unresolved";
        var confidence = "none";
        if (captured && names[0] === captured) {
            source = "captured-api";
            confidence = "high";
        } else if (selectorNames.length) {
            source = "page-dom";
            confidence = "high";
        } else if (names.length) {
            source = "page-header";
            confidence = "medium";
        }
        return {
            pageUrl: typeof location !== "undefined" ? asText(location.href) : "",
            host: typeof location !== "undefined" ? asText(location.host) : "",
            pageType: readPageType(),
            storeName: names[0] || "",
            storeNameCandidates: names.slice(0, 8),
            storeId: "",
            source: names.length ? source : "unresolved",
            confidence: names.length ? confidence : "none"
        };
    }

    /**
     * 严格全等比较，留给需要精确绑定的调用方。短店名包含匹配不能通过。
     */
    function namesMatch(pageName, targetName) {
        var left = asText(pageName).toLowerCase();
        var right = asText(targetName).toLowerCase();
        if (!left || !right) return false;
        return left === right;
    }

    /**
     * 页面店名与紫鸟店名匹配：全等，或其中一方是带分隔备注的完整名、另一方是页头短名。
     * 不接受单个短词前缀，避免 City 对上 City Beauty King。
     */
    function namesCompatible(left, right) {
        var a = normalizeName(left);
        var b = normalizeName(right);
        if (!a || !b) return false;
        if (a === b) return true;
        var ac = normalizeName(coreStoreName(left));
        var bc = normalizeName(coreStoreName(right));
        if (ac && bc && ac === bc) return true;
        return isNamePrefix(a, b) || isNamePrefix(b, a) || isNamePrefix(ac, b) || isNamePrefix(bc, a);
    }

    /**
     * 页头选择器经常读不到店名，但正文里会出现 `Hair removal wax` / `City Beauty King`。
     * 只接受足够长的核心店名，避免短词误中。
     */
    function nameFoundInText(text, expectedName) {
        var hay = normalizeName(text);
        var needle = normalizeName(coreStoreName(expectedName) || expectedName);
        if (!hay || !needle || !isStrongName(needle)) return false;
        return hay.indexOf(needle) >= 0;
    }

    var lastCapturedShopName = "";

    /**
     * 记住账号/店铺接口里出现过的店名。这不是紫鸟 storeId，只用于页头选择器失效时的高置信兜底。
     */
    function rememberCapturedShopName(value) {
        var text = asText(value);
        if (looksLikeShopName(text) && isStrongName(text)) lastCapturedShopName = text;
        return lastCapturedShopName;
    }

    /**
     * 从卖家中心 JSON 里取 mallName/shopName。不把商品名、数字 ID 当成店名，
     * 也不深挖超长商品列表，避免把 pageItems 标题误判成店铺。
     */
    function extractShopNameFromPayload(payload, depth) {
        if (!payload || typeof payload !== "object" || (depth || 0) > 8) return "";
        if (Array.isArray(payload)) {
            if (payload.length > 30 && (depth || 0) > 1) return "";
            for (var i = 0; i < payload.length; i += 1) {
                var nested = extractShopNameFromPayload(payload[i], (depth || 0) + 1);
                if (nested) return nested;
            }
            return "";
        }
        var preferred = ["mallName", "shopName", "storeName", "sellerName", "accountName"];
        for (var j = 0; j < preferred.length; j += 1) {
            var value = asText(payload[preferred[j]]);
            if (looksLikeShopName(value) && isStrongName(value)) return value;
        }
        if (payload.mallList) {
            var mallName = extractShopNameFromPayload(payload.mallList, (depth || 0) + 1);
            if (mallName) return mallName;
        }
        var keys = Object.keys(payload);
        for (var k = 0; k < keys.length; k += 1) {
            var key = keys[k];
            if (key === "pageItems" || key === "skuList" || key === "records") continue;
            var child = extractShopNameFromPayload(payload[key], (depth || 0) + 1);
            if (child) return child;
        }
        return "";
    }

    /**
     * 当前页业务类型。工人和中转仓用它判断是列表采集页还是新建商品页，不从标题猜。
     */
    function readPageType(url) {
        var href = asText(url || (typeof location !== "undefined" ? location.href : ""));
        if (/\/goods\/list/i.test(href)) return "goods-list";
        if (/\/goods\/edit/i.test(href)) return "goods-edit";
        if (/\/goods\/create/i.test(href)) return "goods-create";
        if (/\/goods\/draft/i.test(href)) return "goods-draft";
        if (/agentseller\.temu\.com\/?$/i.test(href)) return "home";
        return "other";
    }

    var api = {
        readPageIdentity: readPageIdentity,
        readPageType: readPageType,
        namesMatch: namesMatch,
        namesCompatible: namesCompatible,
        nameFoundInText: nameFoundInText,
        coreStoreName: coreStoreName,
        extractShopNameFromPayload: extractShopNameFromPayload,
        rememberCapturedShopName: rememberCapturedShopName,
        looksLikeShopName: looksLikeShopName
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return api;
}());
