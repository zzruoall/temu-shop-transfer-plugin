/**
 * 入库地址路径核对。测试连接只能证明仓库活着还不够，必须和标准直推路径一致。
 */
var TemuIngestEndpoint = (function () {
    "use strict";

    function asText(value) {
        return String(value == null ? "" : value).trim();
    }

    function normalizePath(pathname) {
        var path = asText(pathname) || "/";
        return path.replace(/\/+$/, "") || "/";
    }

    function endpointPath(endpoint) {
        try {
            return normalizePath(new URL(endpoint).pathname);
        } catch (_) {
            return "";
        }
    }

    /**
     * 仓库 /api/ingest-info 会返回 ingestPath 和完整 endpoints。
     * 插件填写 /api/wrong 时即使令牌正确，也不能把测试当成推送可用。
     */
    function advertisedPaths(data) {
        var paths = [];
        var ingestPath = normalizePath(data && data.ingestPath);
        if (data && data.ingestPath) paths.push(ingestPath);
        (Array.isArray(data && data.endpoints) ? data.endpoints : []).forEach(function (value) {
            var path = endpointPath(value);
            if (path) paths.push(path);
        });
        return paths.filter(function (path, index) {
            return paths.indexOf(path) === index;
        });
    }

    function matchesConfiguredEndpoint(endpoint, data) {
        var configured = endpointPath(endpoint);
        if (!configured) return false;
        return advertisedPaths(data).indexOf(configured) >= 0;
    }

    /** 保留云仓子目录，避免把认证或任务请求发送到主商城API。 */
    function apiUrl(endpoint, pathname) {
        var url = new URL(endpoint);
        var current = normalizePath(url.pathname);
        if (!current.endsWith("/api/ingest")) throw new Error("ingest_endpoint_mismatch");
        if (!/^\/api\/[a-zA-Z0-9/-]+$/.test(pathname)) throw new Error("invalid_hub_api_path");
        url.pathname = current.slice(0, -"/api/ingest".length) + pathname;
        url.search = ""; url.hash = "";
        return url.toString();
    }
    var api = {
        apiUrl: apiUrl,
        endpointPath: endpointPath,
        advertisedPaths: advertisedPaths,
        matchesConfiguredEndpoint: matchesConfiguredEndpoint
    };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return api;
}());
