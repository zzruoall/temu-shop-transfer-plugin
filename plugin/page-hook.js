(function installTemuLocalPageHook() {
    "use strict";

    // 与 9.x 旧采集器隔离的页面消息通道，避免两个扩展共存时互相消费同一网络响应。
    const SOURCE = "temu-shop-transfer-v10";
    const HOOK_MARKER = "__temuShopTransferV10HookInstalled__";
    const DIAGNOSTIC_TOGGLE_EVENT = "temu-shop-transfer-interface-diagnostic";
    const DIAGNOSTIC_TOGGLE_ATTRIBUTE = "data-temu-shop-transfer-interface-diagnostic";
    const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
    // 同一扩展脚本在 SPA 恢复或异常重注入时只包装一次 fetch/XHR，不能累计多层响应克隆。
    if (window[HOOK_MARKER]) return;
    window[HOOK_MARKER] = true;
    const originalFetch = window.fetch;
    const originalXhrOpen = XMLHttpRequest.prototype.open;
    const originalXhrSend = XMLHttpRequest.prototype.send;
    let interfaceDiagnosticEnabled = document.documentElement?.getAttribute(DIAGNOSTIC_TOGGLE_ATTRIBUTE) === "1";
    // 内容脚本以 DOM 属性和事件双通道通知页面主世界：属性覆盖注入顺序，事件覆盖运行时开关变化。
    window.addEventListener(DIAGNOSTIC_TOGGLE_EVENT, event => { interfaceDiagnosticEnabled = Boolean(event && event.detail && event.detail.enabled); });

    /**
     * 复制页面已经有权读取的 JSON 响应，不改写原始响应，也不调用任何云端采集服务。
     * 解析或转发失败必须静默降级，避免影响卖家中心正常加载和操作。
     */
    /**
     * 页面端与后台端统一按 UTF-8 字节限制响应大小；此前按 JS 字符数判断会让中文响应绕过前置检查，随后在后台保存阶段失败。
     */
    function getUtf8ByteLength(text) {
        try {
            return new TextEncoder().encode(text).byteLength;
        } catch (_) {
            return String(text || "").length * 2;
        }
    }

    /**
     * fetch 的第一个参数可能是字符串、URL 或 Request。只读页面已经能看到的地址，
     * 不要因为拿不到 URL 就丢掉整段响应。
     */
    function readRequestUrl(input) {
        try {
            if (typeof input === "string") return new URL(input, location.href).href;
            if (input && typeof input.url === "string") return new URL(input.url, location.href).href;
            return new URL(String(input), location.href).href;
        } catch (_) {
            if (typeof input === "string") return input;
            return String(input && input.url || "");
        }
    }

    /**
     * 只提取请求体的类型、大小和字段名，供接口诊断判断分页/商品参数；不跨页面保存请求值，
     * 这样即使请求里带令牌、Cookie 或商品标题，也不会进入诊断消息。
     */
    function summarizeRequestBody(body) {
        if (body == null) return { kind: "none", bytes: 0, keys: [] };
        const redactKey = key => /token|cookie|auth|password|secret|session|credential|phone|mobile|email|address/i.test(String(key || "")) ? "[REDACTED]" : String(key).slice(0, 80);
        const keysFromObject = value => value && typeof value === "object" && !Array.isArray(value)
            ? Object.keys(value).slice(0, 40).map(redactKey)
            : [];
        // 只允许明确商品 ID 键的短字母数字值作为样本，既能关联详情请求和列表 SPU，又不保留普通表单内容。
        const collectIdFields = value => {
            const fields = [];
            const walk = (current, path, depth) => {
                if (depth > 4 || fields.length >= 12 || !current || typeof current !== "object") return;
                Object.entries(current).slice(0, 60).forEach(([key, child]) => {
                    const childPath = `${path}.${redactKey(key)}`;
                    const isProductId = /(?:spu|goods|product|sku|skc)[_-]?ids?$/i.test(key);
                    const values = Array.isArray(child) ? child.slice(0, 4) : [child];
                    if (isProductId) values.forEach(item => {
                        const sample = typeof item === "string" || typeof item === "number" ? String(item).trim() : "";
                        if (sample && /^[A-Za-z0-9_-]{1,128}$/.test(sample) && fields.length < 12) fields.push({ path: childPath, key: redactKey(key), sample });
                    });
                    if (child && typeof child === "object") walk(child, childPath, depth + 1);
                });
            };
            walk(value, "$", 0);
            return fields;
        };
        try {
            if (typeof body === "string") {
                const bytes = getUtf8ByteLength(body);
                try {
                    const parsed = JSON.parse(body);
                    return { kind: "json", bytes, keys: keysFromObject(parsed), idFields: collectIdFields(parsed) };
                } catch (_) {
                    try {
                        const params = new URLSearchParams(body);
                        const idFields = Array.from(params.keys()).slice(0, 40).filter(key => /(?:spu|goods|product|sku|skc)[_-]?ids?$/i.test(key)).flatMap(key => params.getAll(key).slice(0, 4).map(sample => ({ path: `$.${redactKey(key)}`, key: redactKey(key), sample: String(sample || "").trim() })).filter(item => /^[A-Za-z0-9_-]{1,128}$/.test(item.sample))).slice(0, 12);
                        return { kind: "form", bytes, keys: Array.from(params.keys()).slice(0, 40).map(redactKey), idFields };
                    } catch (_) {
                        return { kind: "text", bytes, keys: [] };
                    }
                }
            }
            if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
                const formKeys = Array.from(body.keys()).slice(0, 40);
                const idFields = formKeys.filter(key => /(?:spu|goods|product|sku|skc)[_-]?ids?$/i.test(key)).flatMap(key => body.getAll(key).slice(0, 4).map(sample => ({ path: `$.${redactKey(key)}`, key: redactKey(key), sample: String(sample || "").trim() })).filter(item => /^[A-Za-z0-9_-]{1,128}$/.test(item.sample))).slice(0, 12);
                return { kind: "form", bytes: getUtf8ByteLength(body.toString()), keys: formKeys.map(redactKey), idFields };
            }
            if (typeof FormData !== "undefined" && body instanceof FormData) {
                const keys = [];
                const idFields = [];
                body.forEach((value, key) => {
                    if (keys.length < 40) keys.push(redactKey(key));
                    const sample = typeof value === "string" ? value.trim() : "";
                    if (/(?:spu|goods|product|sku|skc)[_-]?ids?$/i.test(key) && /^[A-Za-z0-9_-]{1,128}$/.test(sample) && idFields.length < 12) idFields.push({ path: `$.${redactKey(key)}`, key: redactKey(key), sample });
                });
                return { kind: "form-data", bytes: null, keys, idFields };
            }
            if (typeof Blob !== "undefined" && body instanceof Blob) return { kind: "blob", bytes: Number(body.size) || 0, mimeType: String(body.type || "").slice(0, 80), keys: [] };
        } catch (_) {}
        return { kind: "unknown", bytes: null, keys: [] };
    }

    /** 只发送体积和原因，不发送被跳过的响应正文，便于诊断而不扩大日志敏感数据范围。 */
    function emitSkip(requestUrl, method, transport, reason, textLength, responseBytes, requestStartedAt, responseStatus = 0, requestBody = null) {
        window.postMessage({
            source: SOURCE,
            kind: "network-skip",
            requestUrl: String(requestUrl || ""),
            method: String(method || "GET").toUpperCase(),
            transport,
            reason,
            textLength,
            responseBytes,
            responseStatus: Number(responseStatus) || 0,
            durationMs: Number(requestStartedAt) ? Math.max(0, Date.now() - Number(requestStartedAt)) : null,
            requestBody,
            requestStartedAt: Number(requestStartedAt) || Date.now()
        }, location.origin);
    }

    function emitJson(requestUrl, method, text, transport, requestStartedAt, responseStatus = 0, requestBody = null) {
        if (!text) return;
        const textLength = String(text).length;
        const responseBytes = getUtf8ByteLength(text);
        if (responseBytes > MAX_RESPONSE_BYTES) {
            emitSkip(requestUrl, method, transport, "response_too_large", textLength, responseBytes, requestStartedAt, responseStatus, requestBody);
            return;
        }
        let payload;
        try {
            payload = JSON.parse(text);
        } catch (_) {
            // 非 JSON 的静态响应很多，只对明显的接口路径记录跳过原因，避免日志被页面资源请求淹没。
            if (/\/(?:api|graphql)(?:\/|$)|(?:list|detail|query|search)/i.test(String(requestUrl || ""))) {
                emitSkip(requestUrl, method, transport, "invalid_json", textLength, responseBytes, requestStartedAt, responseStatus, requestBody);
            }
            return;
        }
        window.postMessage({
            source: SOURCE,
            kind: "network-json",
            requestUrl: String(requestUrl || ""),
            method: String(method || "GET").toUpperCase(),
            transport,
            payload,
            responseBytes,
            responseStatus: Number(responseStatus) || 0,
            durationMs: Number(requestStartedAt) ? Math.max(0, Date.now() - Number(requestStartedAt)) : null,
            requestBody,
            requestStartedAt: Number(requestStartedAt) || Date.now()
        }, location.origin);
    }

    /** Request 对象的 body 是一次性流；克隆后只读取字段摘要，不能读取或改写页面将要发送的原流。 */
    function summarizeFetchRequestBody(input, init, method) {
        if (init && Object.prototype.hasOwnProperty.call(init, "body")) return Promise.resolve(summarizeRequestBody(init.body));
        if (typeof Request !== "undefined" && input instanceof Request && !/^(?:GET|HEAD)$/i.test(String(method || ""))) {
            try {
                return input.clone().text().then(text => summarizeRequestBody(text)).catch(() => ({ kind: "unavailable", bytes: null, keys: [] }));
            } catch (_) {}
        }
        return Promise.resolve({ kind: "none", bytes: 0, keys: [] });
    }

    window.fetch = async function temuLocalFetch(input, init) {
        const requestStartedAt = Date.now();
        const url = readRequestUrl(input);
        const method = (init && init.method) || (input && input.method) || "GET";
        const requestBodyPromise = interfaceDiagnosticEnabled
            ? summarizeFetchRequestBody(input, init, method)
            : Promise.resolve({ kind: "not_recorded", bytes: null, keys: [] });
        let response;
        try {
            response = await originalFetch.apply(this, arguments);
        } catch (error) {
            // 失败请求同样对接口诊断有价值，但只记错误类别，不转发页面的错误正文。
            requestBodyPromise.then(requestBody => emitSkip(url, method, "fetch", "network_error", 0, 0, requestStartedAt, 0, requestBody)).catch(() => {});
            throw error;
        }
        try {
            response.clone().text().then(async text => emitJson(url, method, text, "fetch", requestStartedAt, response.status, await requestBodyPromise)).catch(() => {});
        } catch (_) {}
        return response;
    };

    XMLHttpRequest.prototype.open = function temuLocalXhrOpen(method, url) {
        this.__temuLocalMeta = { method, url, requestStartedAt: Date.now(), requestBody: null };
        return originalXhrOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function temuLocalXhrSend() {
        if (this.__temuLocalMeta) {
            this.__temuLocalMeta.requestStartedAt = Date.now();
            this.__temuLocalMeta.requestBody = interfaceDiagnosticEnabled ? summarizeRequestBody(arguments[0]) : { kind: "not_recorded", bytes: null, keys: [] };
        }
        this.addEventListener("load", function captureTemuXhr() {
            try {
                if (this.responseType && this.responseType !== "text" && this.responseType !== "json") return;
                const meta = this.__temuLocalMeta || {};
                const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseText;
                emitJson(meta.url, meta.method, text, "xhr", meta.requestStartedAt, this.status, meta.requestBody);
            } catch (_) {}
        }, { once: true });
        this.addEventListener("error", function captureTemuXhrError() {
            const meta = this.__temuLocalMeta || {};
            emitSkip(meta.url, meta.method, "xhr", "network_error", 0, 0, meta.requestStartedAt, this.status, meta.requestBody);
        }, { once: true });
        return originalXhrSend.apply(this, arguments);
    };
})();
