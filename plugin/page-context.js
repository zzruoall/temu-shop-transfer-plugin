/**
 * 当前页商品集合键的纯逻辑。URL/页签变化必须重置；虚拟滚动只改可见 SPU，不能重置。
 * 分页、筛选控件指纹从有值变成空，通常只是表格重绘，也不能当成切页。
 */
var TemuPageContext = (function () {
    "use strict";

    function asText(value) {
        return String(value == null ? "" : value).trim();
    }

    function composePageContextKey(parts) {
        var data = parts && typeof parts === "object" ? parts : {};
        return [data.path, data.labels, data.filter, data.list].map(asText).join("||");
    }

    function parsePageContextKey(key) {
        var parts = asText(key).split("||");
        return {
            path: asText(parts[0]),
            labels: asText(parts[1]),
            filter: asText(parts[2]),
            list: asText(parts[3])
        };
    }

    /**
     * 查询筛选只保留能表达列表语义的键。Hash 查询和 search 必须一起看，
     * 否则 SPA 把筛选放在 #/goods/list?status=draft 时会被当成同一页。
     */
    function collectStableFilterParams(search, hash) {
        var kept = [];
        var seen = {};
        function take(paramsText) {
            var params;
            try {
                params = new URLSearchParams(String(paramsText || "").replace(/^\?/, ""));
            } catch (error) {
                return;
            }
            params.forEach(function (value, key) {
                var item;
                if (!/^(?:filter|status|tab|type|page|sort|keyword|search|publish|sale|listed|draft)/i.test(key)) return;
                item = key + "=" + String(value).slice(0, 40);
                if (seen[item]) return;
                seen[item] = true;
                kept.push(item);
            });
        }
        var hashText = asText(hash);
        var hashQuery = hashText.indexOf("?") >= 0 ? hashText.slice(hashText.indexOf("?") + 1) : "";
        take(search);
        take(hashQuery);
        kept.sort();
        return kept.join("&");
    }

    /**
     * 请求发起时间早于当前页上下文，说明这是切页前发出的响应。
     * 允许写入历史库，但不能进入新任务的完成度、白名单和自动入库集合。
     */
    function isStaleRequest(requestStartedAt, contextStartedAt) {
        var started = Number(requestStartedAt) || 0;
        var context = Number(contextStartedAt) || 0;
        if (!started || !context) return false;
        return started < context;
    }

    /**
     * 只有稳定路由、页签、查询筛选或列表控件真的变了才重置。
     * 列表指纹缺失表示加载中，不能把上一页 SPU 清掉，也不能把虚拟滚动当成新列表。
     */
    function isGenuineListContextChange(previousKey, currentKey) {
        var previous = asText(previousKey);
        var current = asText(currentKey);
        var prev;
        var next;
        if (!previous || previous === current) return false;
        prev = parsePageContextKey(previous);
        next = parsePageContextKey(current);
        if (prev.path !== next.path) return true;
        // 首屏页签从空变成“全部”是页面水合，不能清空已见 SPU；两边都有文案后才算真切页签。
        if (prev.labels && next.labels && prev.labels !== next.labels) return true;
        // 筛选指纹暂时变空通常是控件重绘；从空变成具体筛选，或两个非空筛选不同，才算切页。
        if (next.filter && prev.filter !== next.filter) return true;
        if (!prev.list || !next.list) return false;
        return prev.list !== next.list;
    }

    if (typeof module !== "undefined" && module.exports) module.exports = {
        composePageContextKey: composePageContextKey,
        parsePageContextKey: parsePageContextKey,
        isGenuineListContextChange: isGenuineListContextChange,
        collectStableFilterParams: collectStableFilterParams,
        isStaleRequest: isStaleRequest
    };

    return {
        composePageContextKey: composePageContextKey,
        parsePageContextKey: parsePageContextKey,
        isGenuineListContextChange: isGenuineListContextChange,
        collectStableFilterParams: collectStableFilterParams,
        isStaleRequest: isStaleRequest
    };
}());
