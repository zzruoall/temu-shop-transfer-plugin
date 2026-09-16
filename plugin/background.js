"use strict";

importScripts("packet.js");
importScripts("ingest-queue.js");
importScripts("ingest-endpoint.js");
importScripts("store-identity.js");
importScripts("operation-log.js");
importScripts("cli-receiver.js");
importScripts("direct-executor.js");

const DATABASE_NAME = "temu-local-dataset";
const DATABASE_VERSION = 2;
const EVENT_STORE = "events";
const CAPTURE_LOGS_KEY = "captureLogsV1";
const PAGE_DIAGNOSTICS_KEY = "pageDiagnosticsV1";
const INTERFACE_DIAGNOSTIC_KEY_PREFIX = "interfaceDiagnosticsTab:";
const INTERFACE_DIAGNOSTIC_DATA_PREFIX = "interfaceDiagnosticsData:";
const INTERFACE_DIAGNOSTIC_INDEX_KEY = "interfaceDiagnosticsIndexV1";
const INGEST_SETTINGS_KEY = "ingestSettingsV1";
const MAX_CAPTURE_LOGS = 2000;
const MAX_CAPTURE_LOG_BYTES = 4 * 1024 * 1024;
const MAX_PAGE_DIAGNOSTICS_BYTES = 5 * 1024 * 1024;
// 接口诊断只存结构摘要，不存原始请求/响应；双重上限避免商品页一次操作耗尽 session storage。
const MAX_INTERFACE_DIAGNOSTIC_EVENTS = 160;
const MAX_INTERFACE_DIAGNOSTIC_BYTES = 512 * 1024;
const MAX_INTERFACE_DIAGNOSTIC_SESSIONS = 3;
const MAX_INTERFACE_DIAGNOSTIC_TOTAL_BYTES = 1024 * 1024;
const MAX_INTERFACE_DIAGNOSTIC_RECORD_BYTES = 24 * 1024;
const MAX_INTERFACE_SCHEMA_NODES = 120;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_AUTO_EXPORT_BYTES = 32 * 1024 * 1024;
const SENSITIVE_KEY_PATTERN = /(?:access|refresh|auth|csrf)?token|cookie|authorization|password|passwd|secret|session(?:id)?|credential|api[-_]?key|phone(?:number)?|mobile|email(?:address)?|(?:shipping|billing)?address/i;
const DETAIL_QUEUE_PREFIX = "detailSupplementTab:";
// 队列字段包含详情证据和按商品隔离的事件；版本变化时丢弃旧队列，避免旧任务继续误报完成。
const DETAIL_QUEUE_VERSION = 4;
// 只有页面已证实的 SPU 字段参与当前页完成度；goodsId 是内部商品记录键，必须与 SPU 分离。
const SPU_ID_KEYS = new Set(["productid", "productids", "productspuid", "productspuids", "spuid", "spuids"]);
const GOODS_ID_KEYS = new Set(["goodsid", "goodsids"]);
const SKC_ID_KEYS = new Set(["productskcid", "productskcids", "goodsskc", "goodsskcs", "skcid", "skcids"]);
const SKU_ID_KEYS = new Set(["skuid", "skuids", "productskuid", "productskuids", "goodsskuid", "goodsskuids"]);
const PRODUCT_COUNT_KEYS = new Set(["productcount", "producttotal", "totalproduct", "totalproducts", "productnum", "productnumber", "goodscount", "goodstotal"]);
// 商品列表行内的移除标记：removeStatus=1 表示店铺里已删除（随后按 autoDeleteRemainingDays 自动清理）。
const REMOVE_STATUS_KEYS = new Set(["removestatus"]);
const REAL_DETAIL_KEYS = new Set([
    "detail", "description", "desc", "productdesc", "goodsdesc", "detaildesc", "productdetail", "goodsdetail",
    "productdescription", "goodsdescription", "detaildescription", "detailhtml", "detailehtml", "goodsdetailhtml",
    "productdetailhtml", "richtext", "richtextcontent", "longdesc", "productdetaildesc", "goodsdetaildesc",
    "detailinfo", "productdetailinfo", "goodsdetailinfo", "detaildata", "productdetaildata", "goodsdetaildata",
    "richtextdata", "descriptionhtml",
    // 与中转仓解析器保持同一份正文兼容范围；编辑页会按类目把详情拆成内容/列表/i18n 字段。
    "detailcontent", "detailcontents", "descriptioncontent", "descriptioncontents", "descriptiontext",
    "productdescriptiontext", "descriptionlist", "descriptioni18n", "productdescriptioni18n",
    "productdetaili18n", "richtextlist", "detailtext", "contenttext", "contenthtml",
    "goodslayerdecorationvolist", "goodslayerdecorationcustomizei18nvolist"
]);
const DETAIL_CONTAINER_KEYS = new Set(["decoration", "decorationi18n", "material", "materiali18n"]);
const DETAIL_CONTENT_KEYS = new Set(["content", "html", "htmlcontent", "richtext", "body", "text", "description", "url", "src", "images", "imageurls"]);
const DETAIL_FLAG_KEY = /^(?:has|have|need|can|is|if|allow|should|off|on)/i;
let captureLogWriteQueue = Promise.resolve();
let interfaceDiagnosticWriteQueue = Promise.resolve();
let pendingIngestQueue = Promise.resolve();
let ingestStoreQueue = Promise.resolve();
const PERMANENT_INGEST_ERRORS = new Set([
    "missing_ingest_token",
    "ingest_permission_denied",
    "invalid_ingest_endpoint",
    "ingest_unauthorized",
    "ingest_endpoint_mismatch"
]);

/** 计算与页面端相同的 UTF-8 字节数，保证大响应在两端使用一致的拒绝边界。 */
function getUtf8ByteLength(value) {
    return new TextEncoder().encode(String(value || "")).byteLength;
}

function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            const store = database.objectStoreNames.contains(EVENT_STORE)
                ? request.transaction.objectStore(EVENT_STORE)
                : database.createObjectStore(EVENT_STORE, { keyPath: "eventId" });
            if (!store.indexNames.contains("dataType")) store.createIndex("dataType", "dataType", { unique: false });
            if (!store.indexNames.contains("savedAt")) store.createIndex("savedAt", "savedAt", { unique: false });
        };
        request.onsuccess = () => {
            request.result.onversionchange = () => request.result.close();
            resolve(request.result);
        };
        request.onerror = () => reject(request.error);
    });
}

function runTransaction(mode, operation) {
    return openDatabase().then(database => new Promise((resolve, reject) => {
        const transaction = database.transaction(EVENT_STORE, mode);
        const store = transaction.objectStore(EVENT_STORE);
        let operationResult;
        try {
            operation(store, value => { operationResult = value; }, transaction);
        } catch (error) {
            try { transaction.abort(); } catch (_) {}
            database.close();
            reject(error);
            return;
        }
        transaction.oncomplete = () => {
            database.close();
            resolve(operationResult);
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            database.close();
            reject(transaction.error || new Error("transaction_aborted"));
        };
    }));
}

function redactSensitiveData(value, depth = 0) {
    if (depth > 30) return "[DEPTH_LIMIT]";
    if (Array.isArray(value)) return value.map(item => redactSensitiveData(item, depth + 1));
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        result[key] = SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED]" : redactSensitiveData(item, depth + 1);
    }
    return result;
}

/**
 * 脱去查询参数并补全页面相对 URL；Temu 的 XHR 常使用 `/api/...`，不补全会把本可保存的响应误报为失败。
 */
function sanitizeUrl(value, baseUrl = "") {
    try {
        const rawValue = String(value || "").trim();
        if (!rawValue) return "";
        const url = new URL(rawValue, String(baseUrl || "") || undefined);
        return `${url.origin}${url.pathname}`;
    } catch (_) {
        return "";
    }
}

function findDeepValue(root, keys, depth = 0) {
    if (!root || typeof root !== "object" || depth > 6) return null;
    for (const key of keys) {
        if (root[key] !== undefined && root[key] !== null && root[key] !== "") return root[key];
    }
    for (const value of Object.values(root)) {
        const found = findDeepValue(value, keys, depth + 1);
        if (found !== null) return found;
    }
    return null;
}

/**
 * 统一商品 ID 的表现形式，避免接口返回数字、字符串或带空格时无法和页面 DOM 对上。
 * 只接受有限长度的标量，防止把整段商品对象或异常文本误当成商品 ID。
 */
function normalizeProductId(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const normalized = String(value).trim();
    if (!normalized || normalized.length > 128 || /[\r\n]/.test(normalized)) return null;
    return normalized;
}

/**
 * 从任意层级 JSON 中按字段名分离 SPU、SKC、SKU 和接口声明数量。
 * Temu 的商品列表响应常把三类 ID 放在同一行对象中，按数字长度猜类型会误配，必须以字段名为准。
 */
function addMetaField(meta, type, key, path, values) {
    const fieldMap = meta.fieldSources[type];
    const fieldKey = `${path} (${key})`;
    let entry = fieldMap.get(fieldKey);
    if (!entry) {
        entry = { path, key, count: 0, samples: [] };
        fieldMap.set(fieldKey, entry);
    }
    for (const value of values) {
        const productId = normalizeProductId(value);
        if (!productId) continue;
        entry.count += 1;
        if (entry.samples.length < 10 && !entry.samples.includes(productId)) entry.samples.push(productId);
    }
}

function extractProductMeta(root, depth = 0, meta = null, path = "$") {
    if (!meta) {
        meta = {
            spuIds: new Set(),
            goodsIds: new Set(),
            skcIds: new Set(),
            skuIds: new Set(),
            fieldSources: { spu: new Map(), goods: new Map(), skc: new Map(), sku: new Map() },
            count: null
        };
    }
    const totalIds = () => meta.spuIds.size + meta.goodsIds.size + meta.skcIds.size + meta.skuIds.size;
    if (!root || typeof root !== "object" || depth > 12 || totalIds() >= 5000) return;
    if (Array.isArray(root)) {
        root.forEach((value, index) => extractProductMeta(value, depth + 1, meta, `${path}[${index}]`));
        return;
    }
    for (const [key, value] of Object.entries(root)) {
        const normalizedKey = key.replace(/[\s_-]/g, "").toLowerCase();
        const type = SPU_ID_KEYS.has(normalizedKey) ? "spu"
            : (GOODS_ID_KEYS.has(normalizedKey) ? "goods"
                : (SKC_ID_KEYS.has(normalizedKey) ? "skc" : (SKU_ID_KEYS.has(normalizedKey) ? "sku" : null)));
        const target = type === "spu" ? meta.spuIds
            : (type === "goods" ? meta.goodsIds : (type === "skc" ? meta.skcIds : (type === "sku" ? meta.skuIds : null)));
        if (target) {
            const values = Array.isArray(value) ? value : [value];
            addMetaField(meta, type, key, `${path}.${key}`, values);
            for (const item of values) {
                const productId = normalizeProductId(item);
                if (productId) target.add(productId);
            }
        }
        if (PRODUCT_COUNT_KEYS.has(normalizedKey) && meta.count === null) {
            const count = Number(value);
            if (Number.isInteger(count) && count >= 0 && count <= 100000) meta.count = count;
        }
        extractProductMeta(value, depth + 1, meta, `${path}.${key}`);
        if (totalIds() >= 5000) return;
    }
}

function getProductMeta(payload) {
    const meta = {
        spuIds: new Set(),
        goodsIds: new Set(),
        skcIds: new Set(),
        skuIds: new Set(),
        fieldSources: { spu: new Map(), goods: new Map(), skc: new Map(), sku: new Map() },
        count: null
    };
    extractProductMeta(payload, 0, meta);
    const serializeSources = sourceMap => Array.from(sourceMap.values()).slice(0, 40).map(source => ({
        path: String(source.path || "").slice(0, 240),
        key: String(source.key || "").slice(0, 80),
        count: Number.isInteger(source.count) ? source.count : 0,
        samples: Array.isArray(source.samples) ? source.samples.slice(0, 5) : []
    }));
    const removal = collectRemovalStatuses(payload);
    return {
        productIds: Array.from(meta.spuIds),
        goodsIds: Array.from(meta.goodsIds),
        skcIds: Array.from(meta.skcIds),
        skuIds: Array.from(meta.skuIds),
        removedProductIds: Array.from(removal.removed),
        activeProductIds: Array.from(removal.active),
        idSources: {
            spu: serializeSources(meta.fieldSources.spu),
            goods: serializeSources(meta.fieldSources.goods),
            skc: serializeSources(meta.fieldSources.skc),
            sku: serializeSources(meta.fieldSources.sku)
        },
        productCount: meta.count
    };
}

/**
 * 从商品列表行里分离“店铺已删除”和“仍在店铺内”的 SPU。
 * 平台状态必须按行的实时字段读取，不能用货号历史推断：同一货号删除后可能被重新建成新商品，
 * 而新商品的 productId 不同、removeStatus 为 0，只有行状态才能区分两者。
 * 只有同一行对象同时带上 removeStatus 和 SPU 字段时才取信，避免把旁路任务的同名字段当成商品状态。
 */
function collectRemovalStatuses(root, depth = 0, result = null) {
    const removal = result || { removed: new Set(), active: new Set() };
    if (!root || typeof root !== "object" || depth > 12) return removal;
    if (removal.removed.size + removal.active.size >= 5000) return removal;
    if (Array.isArray(root)) {
        for (const value of root) collectRemovalStatuses(value, depth + 1, removal);
        return removal;
    }
    const entries = Object.entries(root);
    const statusEntry = entries.find(([key]) => REMOVE_STATUS_KEYS.has(normalizeSchemaKey(key)));
    const rawStatus = statusEntry ? statusEntry[1] : null;
    // 只接受明确数值或字符串形式的 0/1，避免 Number(null) 被误判成“仍在店铺”。
    const status = rawStatus === 0 || rawStatus === 1
        ? rawStatus
        : (typeof rawStatus === "string" && /^[01]$/.test(rawStatus.trim()) ? Number(rawStatus) : null);
    // 只认 0（在店）和 1（已删除）两种已知取值；其他取值含义未验证，宁可当成未知而不误判。
    if (status === 0 || status === 1) {
        const target = status === 1 ? removal.removed : removal.active;
        for (const [key, value] of entries) {
            if (!SPU_ID_KEYS.has(normalizeSchemaKey(key))) continue;
            for (const item of (Array.isArray(value) ? value : [value])) {
                const productId = normalizeProductId(item);
                if (productId) target.add(productId);
            }
        }
    }
    for (const [, value] of entries) collectRemovalStatuses(value, depth + 1, removal);
    return removal;
}

/** 将接口字段名折叠为可比较形式，兼容 Temu 返回的 camelCase、snake_case 和短横线命名。 */
function normalizeSchemaKey(key) {
    return String(key || "").replace(/[\s_-]/g, "").toLowerCase();
}

function hasDeepKey(root, keys, depth = 0, normalizedKeys = null) {
    if (!root || typeof root !== "object" || depth > 6) return false;
    const wanted = normalizedKeys || new Set(keys.map(normalizeSchemaKey));
    if (Object.keys(root).some(key => wanted.has(normalizeSchemaKey(key)))) return true;
    return Object.values(root).some(value => hasDeepKey(value, keys, depth + 1, wanted));
}

/** 识别当前是否处于单个商品编辑页；详情响应可能不在正文重复 SPU，只能用页面路由建立归属。 */
function isProductDetailPageUrl(pageUrl = "") {
    return /\/goods\/edit(?:[\/?#]|$)/i.test(String(pageUrl || ""));
}

/** 从商品编辑页 URL 读取当前 SPU，作为响应缺少 productId 时的唯一安全回退。 */
function readDetailPageProductId(pageUrl = "") {
    try {
        const url = new URL(String(pageUrl || ""));
        const hashText = String(url.hash || "");
        const hashRoute = hashText.split("?")[0];
        if (!isProductDetailPageUrl(`${url.pathname}${hashRoute}`)) return null;
        const hashQuery = hashText.includes("?") ? hashText.slice(hashText.indexOf("?") + 1) : "";
        const hashParams = new URLSearchParams(hashQuery);
        return normalizeProductId(url.searchParams.get("productId") || url.searchParams.get("spuId")
            || hashParams.get("productId") || hashParams.get("spuId"));
    } catch (_) {
        return null;
    }
}

/** 详情页上的这些接口都可能承载基础信息、图文或规格；列表页同名 query 不会进入此分支。 */
function isProductDetailRequestUrl(requestUrl = "") {
    const url = String(requestUrl || "");
    // 基础详情通常是 /product/query、/product/edit；规格模块则常见
    // /product/sku/spec/query。两者都在商品编辑页内，必须纳入同一 SPU 的事件集合。
    return /\/(?:product|goods)\/(?:query|detail|info|edit)(?:$|[/?])/i.test(url)
        || /\/(?:product|goods)\/(?:sku|skc)\/[^/?#]+(?:\/[^/?#]+)*\/(?:query|detail|info|edit)(?:$|[/?])/i.test(url);
}

/** 编辑页的基础资料接口；只有该请求才能证明商品核心对象已返回。 */
function isPrimaryProductDetailRequestUrl(requestUrl = "") {
    return /\/visage-agent-seller\/product\/query(?:$|[/?])/i.test(String(requestUrl || ""));
}

/** 详情队列使用的字段级采集证据，避免仅凭“接口返回成功”就显示完整。 */
function emptyDetailCapture() {
    return {
        primaryResponse: false,
        corePayload: false,
        images: false,
        sku: false,
        specs: false,
        detailText: false,
        captured: false,
        completeness: "missing",
        missing: ["基础资料", "图片", "SKU", "规格"]
    };
}

/** 递归确认字段确实有内容；空数组、空对象和空字符串不算证据。 */
function hasPopulatedNamedValue(root, keys, depth = 0) {
    if (!root || typeof root !== "object" || depth > 8) return false;
    if (Array.isArray(root)) return root.some(item => hasPopulatedNamedValue(item, keys, depth + 1));
    for (const [key, value] of Object.entries(root)) {
        if (keys.has(normalizeSchemaKey(key))) {
            if (typeof value === "string" && value.trim()) return true;
            if (typeof value === "number") return true;
            if (Array.isArray(value) && value.length) return true;
            if (value && typeof value === "object" && Object.keys(value).length) return true;
        }
        if (value && typeof value === "object" && hasPopulatedNamedValue(value, keys, depth + 1)) return true;
    }
    return false;
}

/**
 * 详情接口可在列表页调用；正文允许源商品为空，不将采集完整度当成目标店发布资格。
 * 仅保存布尔证据和缺失名称，不把商品正文复制进日志。
 */
function summarizeDetailCapture(payload, requestUrl, pageUrl = "", responseStatus = 0) {
    const empty = emptyDetailCapture();
    if (!isProductDetailPageUrl(pageUrl) && !isPrimaryProductDetailRequestUrl(requestUrl)) return empty;
    const status = Number(responseStatus) || 0;
    const success = (!status || (status >= 200 && status < 300)) && payload?.success !== false && (!payload?.errorCode || payload.errorCode === 1000000);
    const primaryResponse = success && isPrimaryProductDetailRequestUrl(requestUrl);
    const corePayload = primaryResponse && hasDeepKey(payload, [
        "productName", "productSkcList", "productPropertyList", "productSpecPropertyVOS", "categories", "productSaleExtAttr"
    ]);
    const images = hasPopulatedNamedValue(payload, new Set([
        "carouselimageurls", "carouselimgsi18n", "nocostumecarouselimgsi18n", "productimagelist", "imagelist", "images", "imageurls",
        "mainimageurl", "mainimage", "coverurl", "thumburl", "skuimageurl", "productpicture"
    ]));
    const sku = hasPopulatedNamedValue(payload, new Set([
        "productskulist", "productskusummaries", "productskumap", "skulist", "skus", "skuinfolist", "variants", "variations"
    ]));
    const specs = hasPopulatedNamedValue(payload, new Set([
        "productspecpropertyvos", "productskuspeclist", "skuspeclist", "speclist", "specifications", "productpropertylist", "productproperties"
    ]));
    const detailText = hasDetailPayloadEvidence(payload);
    const missing = [];
    if (!corePayload) missing.push("基础资料");
    if (!images) missing.push("图片");
    if (!sku) missing.push("SKU");
    if (!specs) missing.push("规格");
    const captured = primaryResponse && corePayload;
    return { primaryResponse, corePayload, images, sku, specs, detailText, captured, completeness: missing.length ? "partial" : "complete", missing };
}

/** 多个详情请求按 OR 合并，后续空响应不能覆盖前一条有效证据。 */
function mergeDetailCapture(previous, incoming) {
    const before = previous && typeof previous === "object" ? previous : emptyDetailCapture();
    const next = incoming && typeof incoming === "object" ? incoming : emptyDetailCapture();
    const primaryResponse = Boolean(before.primaryResponse || next.primaryResponse);
    const corePayload = Boolean(before.corePayload || next.corePayload);
    const images = Boolean(before.images || next.images);
    const sku = Boolean(before.sku || next.sku);
    const specs = Boolean(before.specs || next.specs);
    const detailText = Boolean(before.detailText || next.detailText);
    const captured = primaryResponse && corePayload;
    const missing = [];
    if (!corePayload) missing.push("基础资料");
    if (!images) missing.push("图片");
    if (!sku) missing.push("SKU");
    if (!specs) missing.push("规格");
    return { primaryResponse, corePayload, images, sku, specs, detailText, captured, completeness: missing.length ? "partial" : "complete", missing };
}

/** 对外日志只保留有限的证据字段。 */
function compactDetailCapture(value) {
    const capture = value && typeof value === "object" ? value : emptyDetailCapture();
    return {
        primaryResponse: Boolean(capture.primaryResponse),
        corePayload: Boolean(capture.corePayload),
        images: Boolean(capture.images),
        sku: Boolean(capture.sku),
        specs: Boolean(capture.specs),
        detailText: Boolean(capture.detailText),
        captured: Boolean(capture.captured),
        completeness: capture.completeness === "complete" ? "complete" : "partial",
        missing: Array.isArray(capture.missing) ? capture.missing.map(item => String(item || "").slice(0, 20)).filter(Boolean).slice(0, 8) : []
    };
}

/**
 * 判断字段值是否包含真实正文/图文内容；布尔开关、数量、状态码和空配置不能作为详情完成证据。
 * 这里故意比“字段名命中”更严格，因为编辑页会同时请求库存、权限和任务状态接口。
 */
function hasMeaningfulDetailValue(value, depth = 0) {
    if (depth > 8 || value == null) return false;
    if (typeof value === "boolean" || typeof value === "number") return false;
    if (typeof value === "string") {
        const text = value.trim();
        if (text.length < 8 || /^(?:true|false|null|undefined|success|ok|done|pending)$/i.test(text)) return false;
        return /<[a-z][^>]*>/i.test(text) || /https?:\/\//i.test(text) || /[\p{L}\p{N}]/u.test(text);
    }
    if (Array.isArray(value)) return value.some(item => hasMeaningfulDetailValue(item, depth + 1));
    if (typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) => {
        if (DETAIL_FLAG_KEY.test(key)) return false;
        return hasMeaningfulDetailValue(child, depth + 1);
    });
}

/** 只在明确的详情字段或图文容器内寻找正文，避免把任意接口的 URL/提示文本误标为详情。 */
function hasDetailPayloadEvidence(payload, depth = 0) {
    if (!payload || typeof payload !== "object" || depth > 8) return false;
    if (Array.isArray(payload)) return payload.some(item => hasDetailPayloadEvidence(item, depth + 1));
    return Object.entries(payload).some(([key, value]) => {
        const normalized = normalizeSchemaKey(key);
        if (DETAIL_FLAG_KEY.test(key)) return false;
        if (REAL_DETAIL_KEYS.has(normalized) && hasMeaningfulDetailValue(value)) return true;
        if (DETAIL_CONTAINER_KEYS.has(normalized)) {
            if (!value || typeof value !== "object") return false;
            return Object.entries(value).some(([childKey, childValue]) => {
                const childNormalized = normalizeSchemaKey(childKey);
                return DETAIL_CONTENT_KEYS.has(childNormalized) && hasMeaningfulDetailValue(childValue);
            });
        }
        return value && typeof value === "object" && hasDetailPayloadEvidence(value, depth + 1);
    });
}

function classifyEvent(requestUrl, payload, pageUrl = "") {
    const url = String(requestUrl || "");
    const hasDetailPayload = hasDetailPayloadEvidence(payload);
    // 先处理已确认的 Temu 主列表接口，避免其中携带单个 productId 时被库存旁路接口规则抢先误判。
    if (/\/visage-agent-seller\/product\/skc\/pageQuery(?:$|[/?])/i.test(url)) return "product-list";
    // 已验证的核心详情接口不依赖宿主路由，列表页批量查询也必须归为详情。
    if (isPrimaryProductDetailRequestUrl(url)) return "product-detail";
    if (isProductDetailPageUrl(pageUrl) && (isProductDetailRequestUrl(url) || hasDetailPayload)) return "product-detail";
    // /product/skc/pageQuery 是当前商品表格主列表接口，不能因路径含 skc 被误分到 SKU 类；真正 SKU 接口通常含 /sku/、variation 或 specification。
    if (/(?:^|[/_.-])(sku|variation|variant|specification)(?:[/_.?-]|$)/i.test(url)) return "sku";
    if (/(?:product|goods|item).*(?:detail|description|richtext)|(?:detail|description|richtext).*(?:product|goods|item)/i.test(url)) return "product-detail";
    if (/(?:product|goods|item).*(?:list|search|query)|(?:list|search|query).*(?:product|goods|item)/i.test(url)) return "product-list";
    if (/(?:category|categories|cat-tree|category-attribute)/i.test(url)) return "category";
    if (/(?:shop|store|seller).*(?:info|detail|profile)|(?:info|detail|profile).*(?:shop|store|seller)/i.test(url)) return "shop";
    if (hasDeepKey(payload, ["skuList", "skus", "variants", "variations", "specifications"])) return "sku";
    if (hasDeepKey(payload, ["productList", "goodsList", "products", "productCount"])) return "product-list";
    if (isProductDetailPageUrl(pageUrl) && hasDetailPayload) return "product-detail";
    if (hasDeepKey(payload, ["productDetail", "goodsDetail", "detailInfo"])) return "product-detail";
    if (hasDeepKey(payload, ["categoryList", "categories", "categoryTree", "categoryAttributes"])) return "category";
    if (hasDeepKey(payload, ["shopInfo", "storeInfo", "sellerInfo", "shopKey"])) return "shop";
    // 接口名称经常被压缩或改成 snake_case；有明确商品标识时仍给出可用于完成度核验的兜底分类。
    const productMeta = getProductMeta(payload);
    if (productMeta.productCount !== null || productMeta.productIds.length > 1 || productMeta.goodsIds.length > 1) return "product-list";
    // 列表页里只有一个 ID 的库存、校验或统计响应不能证明打开了商品详情；
    // 只有编辑页路由才允许单对象回退为 product-detail。
    if (isProductDetailPageUrl(pageUrl) && (productMeta.productIds.length === 1 || productMeta.goodsIds.length === 1)) return "product-detail";
    return "unknown";
}

async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * 保存原始响应快照，以内容指纹作为主键去重；暂不把字段压平成商品表，避免在看清真实数据前丢失结构。
 * 来源 URL 删除查询参数，账号和会话类字段在进入 IndexedDB 前统一脱敏。
 */
async function saveCapture(event, sender) {
    if (!event || event.kind !== "network-json" || !event.payload || typeof event.payload !== "object") {
        throw new Error("invalid_capture_event");
    }
    const serializedPayload = JSON.stringify(event.payload);
    const payloadBytes = getUtf8ByteLength(serializedPayload);
    if (payloadBytes > MAX_RESPONSE_BYTES) {
        const error = new Error("capture_too_large");
        error.captureMeta = { payloadBytes, productRelated: false };
        throw error;
    }
    const payload = redactSensitiveData(event.payload);
    const productMeta = getProductMeta(payload);
    const rawPageUrl = sender.tab && sender.tab.url;
    const pageUrl = sanitizeUrl(rawPageUrl);
    const dataType = classifyEvent(event.requestUrl, payload, rawPageUrl);
    // 编辑页完整度以真实 product/query 的字段为准；正文仍单独保留，避免没有详情文案的商品被误报“接口未捕获”。
    const detailCapture = summarizeDetailCapture(payload, event.requestUrl, rawPageUrl, event.responseStatus);
    const detailEvidence = detailCapture.detailText;
    const primaryProduct = isPrimaryProductDetailRequestUrl(event.requestUrl) ? (payload.result || payload.res || payload) : null;
    const explicitSpu = normalizeProductId(primaryProduct && primaryProduct.productId);
    const routeSpu = readDetailPageProductId(rawPageUrl);
    if (explicitSpu && routeSpu && explicitSpu !== routeSpu) throw new Error("detail_product_id_mismatch");
    const detailPageProductId = explicitSpu || routeSpu;
    const detailPage = isProductDetailPageUrl(rawPageUrl);
    const detailRequestSeen = isPrimaryProductDetailRequestUrl(event.requestUrl) || (detailPage && (isProductDetailRequestUrl(event.requestUrl) || dataType === "product-detail"));
    // 详情接口有时只返回 detail/图片，不重复 productId；页面路由是当前 SPU 的唯一上下文证据。
    if (dataType === "product-detail" && detailPageProductId) {
        // 核心响应自身ID优先，编辑路由仅作缺ID时的上下文；冲突已在前面拒绝。
        productMeta.productIds = [detailPageProductId];
        productMeta.idSources.spu = (Array.isArray(productMeta.idSources.spu) ? productMeta.idSources.spu : [])
            .filter(source => Array.isArray(source.samples) && source.samples.includes(detailPageProductId));
        productMeta.idSources.spu.unshift({ path: explicitSpu ? "$payload.productId" : "$pageUrl.productId", key: explicitSpu ? "productId" : "pageProductId", count: 1, samples: [detailPageProductId] });
    }
    const productRelated = dataType === "product-list" || dataType === "product-detail"
        || productMeta.productIds.length > 0 || productMeta.goodsIds.length > 0 || productMeta.productCount !== null;
    const requestUrl = sanitizeUrl(event.requestUrl, sender.tab && sender.tab.url);
    if (!requestUrl) {
        const error = new Error("invalid_request_url");
        error.captureMeta = {
            category: dataType,
            productRelated,
            productIds: productMeta.productIds,
            goodsIds: productMeta.goodsIds,
            skcIds: productMeta.skcIds,
            skuIds: productMeta.skuIds,
            idSources: productMeta.idSources,
            productCount: productMeta.productCount,
            payloadBytes,
            detailRequestSeen,
            detailEvidence,
            detailCapture: compactDetailCapture(detailCapture),
            detailPage
        };
        throw error;
    }
    // 详情响应可能不含 productId；仅详情页把编辑页 SPU 纳入指纹，避免不同商品相互去重，
    // 普通列表响应沿用旧指纹算法，升级插件不会把历史记录重复写入。
    const eventFingerprint = detailPageProductId
        ? `${requestUrl}\n${detailPageProductId}\n${JSON.stringify(payload)}`
        : `${requestUrl}\n${JSON.stringify(payload)}`;
    const eventId = await sha256(eventFingerprint);
    const record = {
        schemaVersion: 5,
        extensionVersion: chrome.runtime.getManifest().version,
        classifierVersion: 8,
        redactionVersion: 1,
        eventId,
        savedAt: new Date().toISOString(),
        dataType,
        identity: {
            shopId: findDeepValue(payload, ["shop_id", "shopId", "shopKey", "storeId", "sellerId"]),
            categoryId: findDeepValue(payload, ["categoryId", "catId", "leafCategoryId", "category_id"]),
            productId: productMeta.productIds[0] || null,
            productIds: productMeta.productIds,
            // goodsId 只保留为内部商品记录元数据，不能进入当前页商品完成度集合。
            goodsIds: productMeta.goodsIds,
            // SKU/SKC 只保留为响应结构元数据，不能进入当前页商品完成度集合。
            skcIds: productMeta.skcIds,
            skuIds: productMeta.skuIds,
            idSources: productMeta.idSources
        },
        productCount: productMeta.productCount,
        detailRequestSeen,
        detailEvidence,
        detailCapture: compactDetailCapture(detailCapture),
        source: {
            pageUrl,
            pageProductId: detailPageProductId || "",
            requestUrl,
            method: String(event.method || "GET").slice(0, 12),
            transport: event.transport === "xhr" ? "xhr" : "fetch",
            queryKeys: (() => {
                try {
                    return Array.from(new URL(String(event.requestUrl || ""), sender.tab.url).searchParams.keys());
                } catch (_) {
                    return [];
                }
            })()
        },
        payloadBytes: getUtf8ByteLength(JSON.stringify(payload)),
        payload
    };

    const saved = await runTransaction("readwrite", (store, setResult, transaction) => {
        const existing = store.get(eventId);
        existing.onsuccess = () => {
            if (existing.result) {
                const previous = existing.result;
                const needsUpgrade = (previous.schemaVersion || 1) < 5
                || (previous.classifierVersion || 1) < 8
                    || !previous.identity
                    || !Array.isArray(previous.identity.productIds)
                    || !Array.isArray(previous.identity.goodsIds)
                    || !Array.isArray(previous.identity.skcIds)
                    || !Array.isArray(previous.identity.skuIds)
                    || !previous.identity.idSources;
                if (needsUpgrade) {
                    // 旧版本 eventId 算法相同，只补齐商品元数据并保留原始来源，避免导出文件混有无法参与商品匹配的旧快照。
                    const upgrade = store.put({
                        ...previous,
                        schemaVersion: 5,
                        classifierVersion: record.classifierVersion,
                        redactionVersion: record.redactionVersion,
                        dataType: record.dataType,
                        identity: { ...(previous.identity || {}), ...record.identity, productIds: productMeta.productIds, goodsIds: productMeta.goodsIds, skcIds: productMeta.skcIds, skuIds: productMeta.skuIds, idSources: productMeta.idSources },
                        productCount: productMeta.productCount,
                        detailRequestSeen,
                        detailEvidence,
                        detailCapture: compactDetailCapture(detailCapture),
                        savedAt: previous.savedAt || record.savedAt
                    });
                    upgrade.onsuccess = () => setResult({ saved: true, duplicate: true, upgraded: true, category: record.dataType, productRelated, detailPage, detailRequestSeen, detailEvidence, detailCapture: compactDetailCapture(detailCapture), productIds: productMeta.productIds, goodsIds: productMeta.goodsIds, skcIds: productMeta.skcIds, skuIds: productMeta.skuIds, idSources: productMeta.idSources, productCount: productMeta.productCount });
                    upgrade.onerror = () => transaction.abort();
                    return;
                }
                setResult({ saved: true, duplicate: true, category: record.dataType, productRelated, detailPage, detailRequestSeen, detailEvidence, detailCapture: compactDetailCapture(detailCapture), productIds: productMeta.productIds, goodsIds: productMeta.goodsIds, skcIds: productMeta.skcIds, skuIds: productMeta.skuIds, idSources: productMeta.idSources, productCount: productMeta.productCount });
                return;
            }
            const add = store.add(record);
            add.onsuccess = () => setResult({ saved: true, duplicate: false, category: record.dataType, productRelated, detailPage, detailRequestSeen, detailEvidence, detailCapture: compactDetailCapture(detailCapture), productIds: productMeta.productIds, goodsIds: productMeta.goodsIds, skcIds: productMeta.skcIds, skuIds: productMeta.skuIds, idSources: productMeta.idSources, productCount: productMeta.productCount });
            add.onerror = event => {
                event.preventDefault();
                if (add.error && add.error.name === "ConstraintError") {
                    setResult({ saved: true, duplicate: true, category: record.dataType, productRelated, detailPage, detailRequestSeen, detailEvidence, detailCapture: compactDetailCapture(detailCapture), productIds: productMeta.productIds, goodsIds: productMeta.goodsIds, skcIds: productMeta.skcIds, skuIds: productMeta.skuIds, idSources: productMeta.idSources, productCount: productMeta.productCount });
                } else {
                    transaction.abort();
                }
            };
        };
        existing.onerror = () => transaction.abort();
    });
    // eventId 是响应正文（详情页再加当前 SPU）的稳定指纹，页面据此划分“本次采集”包，
    // 无需把原始响应再传回页面上下文。
    // 商品行的店铺删除状态随保存结果回传，采集页据此把已删除商品排除在本批次之外。
    return { ...saved, eventId, removedProductIds: productMeta.removedProductIds, activeProductIds: productMeta.activeProductIds };
}

function getAllRecords() {
    return runTransaction("readonly", (store, setResult, transaction) => {
        const request = store.getAll();
        request.onsuccess = () => setResult(request.result || []);
        request.onerror = () => transaction.abort();
    });
}

function makeDataUrl(text) {
    // service worker 没有可靠的 blob URL 生命周期，自动落盘使用 UTF-8 百分号编码，兼容紫鸟的下载目录。
    return `data:application/json;charset=utf-8,${encodeURIComponent(String(text || ""))}`;
}

/**
 * 采集终态后无交互地生成完整包，文件名固定落在浏览器默认下载目录的 temu-local-dataset 子目录。
 * 紫鸟 CLI 可读取每个店铺的 downloadFolderPath，入库监控程序据此发现文件，避免插件跨环境请求本地 HTTP。
 */
async function exportFullPacketToDownload(options = {}) {
    const allRecords = await getAllRecords();
    const requestedIds = Array.isArray(options.eventIds)
        ? new Set(options.eventIds.map(value => String(value || "").trim()).filter(Boolean))
        : null;
    const allowedSpuIds = Array.isArray(options.allowedSpuIds)
        ? options.allowedSpuIds.map(value => String(value || "").trim()).filter(Boolean)
        : null;
    const records = requestedIds ? allRecords.filter(record => requestedIds.has(String(record && record.eventId || ""))) : allRecords;
    if (!records.length) return { skipped: true, reason: "empty_packet", recordCount: 0, productCount: 0 };
    const packet = makeFullCapturePacket(records, await packetSourceOptions({
        scope: requestedIds ? "current-capture-run" : "all-local-captured-records",
        allowedSpuIds
    }));
    if (!packet.products.length) return { skipped: true, reason: "no_products", recordCount: packet.records.length, productCount: 0 };
    const text = JSON.stringify(packet, null, 2);
    const bytes = getUtf8ByteLength(text);
    if (bytes > MAX_AUTO_EXPORT_BYTES) {
        const error = new Error("auto_export_too_large");
        error.bytes = bytes;
        throw error;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const fileName = `temu-local-dataset/temu-full-capture-${stamp}.json`;
    const downloadId = await chrome.downloads.download({
        url: makeDataUrl(text),
        filename: fileName,
        saveAs: false,
        conflictAction: "uniquify"
    });
    return { exported: true, downloadId, fileName, bytes, recordCount: packet.records.length, productCount: packet.products.length };
}

async function getStats() {
    return runTransaction("readonly", (store, setResult, transaction) => {
        const totalRequest = store.count();
        const byType = {};
        const index = store.index("dataType");
        const types = ["product-list", "product-detail", "sku", "category", "shop", "unknown"];
        let pending = types.length + 1;
        let total = 0;
        const finish = () => {
            pending -= 1;
            if (pending === 0) setResult({ total, byType });
        };
        totalRequest.onsuccess = () => { total = totalRequest.result || 0; finish(); };
        totalRequest.onerror = () => transaction.abort();
        for (const type of types) {
            const request = index.count(type);
            request.onsuccess = () => { byType[type] = request.result || 0; finish(); };
            request.onerror = () => transaction.abort();
        }
    });
}

async function clearRecords() {
    return runTransaction("readwrite", (store, setResult, transaction) => {
        const request = store.clear();
        request.onsuccess = () => setResult({ cleared: true });
        request.onerror = () => transaction.abort();
    });
}

/**
 * 将采集结果写入独立日志队列，日志只包含状态、接口路径和计数，不保存响应正文，方便定位失败又不扩大敏感数据范围。
 */
function appendCaptureLog(entry) {
    const task = captureLogWriteQueue.then(async () => {
        const stored = await chrome.storage.local.get(CAPTURE_LOGS_KEY);
        const logs = Array.isArray(stored[CAPTURE_LOGS_KEY]) ? stored[CAPTURE_LOGS_KEY] : [];
        logs.push(entry);
        if (logs.length > MAX_CAPTURE_LOGS) logs.splice(0, logs.length - MAX_CAPTURE_LOGS);
        // storage.local 还有页面结构诊断要保存，日志按字节再裁剪一次，避免达到配额后静默丢写入。
        while (logs.length > 1 && getUtf8ByteLength(JSON.stringify(logs)) > MAX_CAPTURE_LOG_BYTES) logs.shift();
        await chrome.storage.local.set({ [CAPTURE_LOGS_KEY]: logs });
    });
    captureLogWriteQueue = task.catch(() => {});
    return task.catch(() => {});
}

function makeCaptureLog(event, sender, result, error) {
    const tabUrl = sender && sender.tab && sender.tab.url;
    const errorText = error && error.message ? error.message : (error ? String(error) : "");
    const errorMeta = error && error.captureMeta || {};
    const productIds = Array.isArray(result && result.productIds)
        ? result.productIds
        : (Array.isArray(errorMeta.productIds) ? errorMeta.productIds : []);
    const goodsIds = Array.isArray(result && result.goodsIds)
        ? result.goodsIds
        : (Array.isArray(errorMeta.goodsIds) ? errorMeta.goodsIds : []);
    const skcIds = Array.isArray(result && result.skcIds)
        ? result.skcIds
        : (Array.isArray(errorMeta.skcIds) ? errorMeta.skcIds : []);
    const skuIds = Array.isArray(result && result.skuIds)
        ? result.skuIds
        : (Array.isArray(errorMeta.skuIds) ? errorMeta.skuIds : []);
    const idSources = result && result.idSources && typeof result.idSources === "object"
        ? result.idSources
        : (errorMeta.idSources && typeof errorMeta.idSources === "object" ? errorMeta.idSources : {});
    return {
        loggedAt: new Date().toISOString(),
        status: errorText ? "failed" : "saved",
        error: errorText.slice(0, 160),
        category: result && result.category ? result.category : (errorMeta.category || ""),
        productRelated: Boolean(result && result.productRelated || errorMeta.productRelated),
        detailPage: Boolean(result && result.detailPage || errorMeta.detailPage || readDetailPageProductId(tabUrl)),
        detailRequestSeen: Boolean(result && result.detailRequestSeen || errorMeta.detailRequestSeen),
        detailEvidence: Boolean(result && result.detailEvidence || errorMeta.detailEvidence),
        detailCapture: compactDetailCapture(result && result.detailCapture || errorMeta.detailCapture),
        duplicate: Boolean(result && result.duplicate),
        upgraded: Boolean(result && result.upgraded),
        productIdsCount: Array.isArray(result && result.productIds)
            ? result.productIds.length
            : (Array.isArray(errorMeta.productIds) ? errorMeta.productIds.length : 0),
        productIdsSample: productIds.slice(0, 20),
        // productIds 旧字段继续保留兼容日志分析；明确的 spuIds 字段帮助快速区分三类 ID。
        spuIdsCount: productIds.length,
        spuIdsSample: productIds.slice(0, 20),
        goodsIdsCount: goodsIds.length,
        goodsIdsSample: goodsIds.slice(0, 20),
        skcIdsCount: skcIds.length,
        skuIdsCount: skuIds.length,
        idSources,
        // 页面 URL 是详情响应的归属证据；日志保留当前 SPU，便于定位哪一件缺正文。
        pageProductId: readDetailPageProductId(tabUrl) || "",
        productCount: Number.isInteger(result && result.productCount)
            ? result.productCount
            : (Number.isInteger(errorMeta.productCount) ? errorMeta.productCount : null),
        payloadBytes: Number.isFinite(errorMeta.payloadBytes) ? errorMeta.payloadBytes : (() => {
            try { return event && event.payload ? getUtf8ByteLength(JSON.stringify(event.payload)) : null; } catch (_) { return null; }
        })(),
        requestUrl: sanitizeUrl(event && event.requestUrl, tabUrl),
        pageUrl: sanitizeUrl(tabUrl, tabUrl),
        method: String(event && event.method || "GET").slice(0, 12),
        transport: event && event.transport === "xhr" ? "xhr" : "fetch"
    };
}

/** 记录页面端未进入商品库的响应，只保留诊断元数据，帮助区分超大响应、非 JSON 与后台保存失败。 */
function makeCaptureSkipLog(event, sender) {
    const tabUrl = sender && sender.tab && sender.tab.url;
    return {
        loggedAt: new Date().toISOString(),
        status: "skipped",
        error: String(event && event.reason || "capture_skipped").slice(0, 160),
        category: "",
        duplicate: false,
        upgraded: false,
        productIdsCount: 0,
        productCount: null,
        payloadBytes: Number.isFinite(event && event.responseBytes) ? event.responseBytes : null,
        textLength: Number.isFinite(event && event.textLength) ? event.textLength : null,
        requestUrl: sanitizeUrl(event && event.requestUrl, tabUrl),
        pageUrl: sanitizeUrl(tabUrl, tabUrl),
        method: String(event && event.method || "GET").slice(0, 12),
        transport: event && event.transport === "xhr" ? "xhr" : "fetch"
    };
}

/** 记录一次采集的完成度快照；商品 ID 仅保留前20个样本，方便比对页面集合和接口集合而不导出响应正文。 */
function makeCaptureRunLog(summary, sender) {
    const safeSummary = summary && typeof summary === "object" ? summary : {};
    const sample = value => Array.isArray(value)
        ? value.filter(item => typeof item === "string" || typeof item === "number").map(item => String(item).trim()).filter(Boolean).slice(0, 20)
        : [];
    const tabUrl = sender && sender.tab && sender.tab.url;
    return {
        loggedAt: new Date().toISOString(),
        status: "run-summary",
        error: "",
        category: "run",
        phase: String(safeSummary.phase || "").slice(0, 40),
        expectedCount: Number.isInteger(safeSummary.expectedCount) ? safeSummary.expectedCount : null,
        completedCount: Number.isInteger(safeSummary.completedCount) ? safeSummary.completedCount : null,
        pageProductIdsCount: Number.isInteger(safeSummary.pageProductIdsCount) ? safeSummary.pageProductIdsCount : 0,
        matchedProductIdsCount: Number.isInteger(safeSummary.matchedProductIdsCount) ? safeSummary.matchedProductIdsCount : 0,
        pageProductIdsSample: sample(safeSummary.pageProductIdsSample),
        matchedProductIdsSample: sample(safeSummary.matchedProductIdsSample),
        captured: Number.isInteger(safeSummary.captured) ? safeSummary.captured : 0,
        saved: Number.isInteger(safeSummary.saved) ? safeSummary.saved : 0,
        failed: Number.isInteger(safeSummary.failed) ? safeSummary.failed : 0,
        productFailures: Number.isInteger(safeSummary.productFailures) ? safeSummary.productFailures : 0,
        durationMs: Number.isInteger(safeSummary.durationMs) ? safeSummary.durationMs : null,
        expectedSource: String(safeSummary.expectedSource || "").slice(0, 80),
        // 运行日志只保存 DOM 计数和有限样本；完整候选行结构另存于 pageDiagnostics，避免每次网络事件复制大对象。
        domDiagnostics: safeSummary.domDiagnostics && typeof safeSummary.domDiagnostics === "object"
            ? safeSummary.domDiagnostics
            : null,
        primaryProductEvents: Number.isInteger(safeSummary.primaryProductEvents) ? safeSummary.primaryProductEvents : 0,
        pendingWrites: Number.isInteger(safeSummary.pendingWrites) ? safeSummary.pendingWrites : 0,
        declaredProductCount: Number.isInteger(safeSummary.declaredProductCount) ? safeSummary.declaredProductCount : null,
        pageVisibleCount: Number.isInteger(safeSummary.pageVisibleCount) ? safeSummary.pageVisibleCount : 0,
        productEvents: Number.isInteger(safeSummary.productEvents) ? safeSummary.productEvents : 0,
        bufferOverflow: Boolean(safeSummary.bufferOverflow),
        finished: Boolean(safeSummary.finished),
        pageContextKey: String(safeSummary.pageContextKey || "").slice(0, 500),
        activePageLabels: sample(safeSummary.activePageLabels),
        allowedSpuIdsCount: Array.isArray(safeSummary.allowedSpuIds) ? safeSummary.allowedSpuIds.length : 0,
        allowedSpuIdsSample: sample(safeSummary.allowedSpuIds),
        autoExport: safeSummary.autoExport && typeof safeSummary.autoExport === "object"
            ? {
                phase: String(safeSummary.autoExport.phase || "").slice(0, 20),
                fileName: String(safeSummary.autoExport.fileName || "").slice(0, 240),
                bytes: Number.isFinite(safeSummary.autoExport.bytes) ? safeSummary.autoExport.bytes : 0,
                productCount: Number.isInteger(safeSummary.autoExport.productCount) ? safeSummary.autoExport.productCount : 0,
                error: String(safeSummary.autoExport.error || "").slice(0, 160)
            }
            : null,
        detailSupplement: safeSummary.detailSupplement && typeof safeSummary.detailSupplement === "object"
            ? {
                mode: String(safeSummary.detailSupplement.mode || "").slice(0, 12),
                runId: String(safeSummary.detailSupplement.runId || "").slice(0, 80),
                spuId: String(safeSummary.detailSupplement.spuId || "").slice(0, 128),
                eventCount: Number.isInteger(safeSummary.detailSupplement.eventCount) ? safeSummary.detailSupplement.eventCount : 0,
                detailEvidence: Boolean(safeSummary.detailSupplement.detailEvidence),
                detailCaptured: Boolean(safeSummary.detailSupplement.detailCaptured),
                completeness: safeSummary.detailSupplement.completeness === "complete" ? "complete" : "partial",
                missing: Array.isArray(safeSummary.detailSupplement.missing)
                    ? safeSummary.detailSupplement.missing.map(item => String(item || "").slice(0, 20)).filter(Boolean).slice(0, 8)
                    : [],
                total: Number.isInteger(safeSummary.detailSupplement.total) ? safeSummary.detailSupplement.total : 0,
                completed: Number.isInteger(safeSummary.detailSupplement.completed) ? safeSummary.detailSupplement.completed : 0,
                complete: Number.isInteger(safeSummary.detailSupplement.complete) ? safeSummary.detailSupplement.complete : 0,
                partial: Number.isInteger(safeSummary.detailSupplement.partial) ? safeSummary.detailSupplement.partial : 0,
                failed: Number.isInteger(safeSummary.detailSupplement.failed) ? safeSummary.detailSupplement.failed : 0,
                currentIndex: Number.isInteger(safeSummary.detailSupplement.currentIndex) ? safeSummary.detailSupplement.currentIndex : 0
            }
            : null,
        lastEventAt: Number.isFinite(safeSummary.lastEventAt) ? safeSummary.lastEventAt : null,
        lastProductEventAt: Number.isFinite(safeSummary.lastProductEventAt) ? safeSummary.lastProductEventAt : null,
        requestUrl: "",
        pageUrl: sanitizeUrl(tabUrl, tabUrl),
        method: "",
        transport: "content"
    };
}

/** 记录用户在采集尚未自然结束时导出日志的瞬间，避免日志缺少“是否完成”的证据。 */
function makeCaptureSnapshotLog(summary, sender) {
    const runLog = makeCaptureRunLog(summary, sender);
    return { ...runLog, status: "run-snapshot", phase: runLog.phase || "导出时状态" };
}

async function getCaptureLogs() {
    await captureLogWriteQueue;
    const stored = await chrome.storage.local.get(CAPTURE_LOGS_KEY);
    const settings = await getIngestSettings();
    const bound = await getBoundStore();
    const tasks = await getTargetUploadTasks();
    // 导出时只读取本机状态，不尝试联网领取或发布，避免诊断动作改变待排查任务。
    const diagnosticState = TemuOperationLog.clean({ version: chrome.runtime.getManifest().version,
        endpoint: settings.endpoint, tokenPresent: Boolean(settings.token), storeId: bound.storeId,
        permissionGranted: await ensureIngestPermission(settings.endpoint).catch(() => false),
        pageUrl: lastPageIdentity.pageUrl, taskCount: tasks.length });
    return { logs: Array.isArray(stored[CAPTURE_LOGS_KEY]) ? stored[CAPTURE_LOGS_KEY] : [],
        operationLog: await TemuOperationLog.read(), diagnosticState,
        taskStates: tasks.slice(0, 30).map(task => TemuOperationLog.clean({ jobId: task.jobId, spuId: task.spuId, storeId: task.targetStoreId, status: task.status })) };
}

/** 入库及任务 HTTP 的统一诊断边界：记录请求阶段/耗时/HTTP状态，绝不读取或复制正文与请求头。 */
async function diagnosticFetch(url, options = {}) {
    const started = Date.now();
    const requestId = `http-${started}-${Math.random().toString(16).slice(2, 8)}`;
    try {
        // 诊断不改变上传请求的超时/取消语义；只有 started 没有终态本身就是请求挂起的证据。
        const response = await fetch(url, options);
        if (!response.ok) {
            await TemuOperationLog.append({ action: "hub-http", status: "failed", endpoint: String(url), requestId,
                httpStatus: response.status, durationMs: Date.now() - started, error: `http_${response.status}` });
        }
        return response;
    } catch (error) {
        await TemuOperationLog.append({ action: "hub-http", status: "failed", endpoint: String(url), requestId,
            durationMs: Date.now() - started, error: String(error.message || error) });
        throw error;
    }
}

async function clearCaptureLogs() {
    // 把清空动作排在现有写入之后，避免 remove 与 set 并发导致旧日志被写回。
    const task = captureLogWriteQueue.then(() => chrome.storage.local.remove(CAPTURE_LOGS_KEY));
    captureLogWriteQueue = task.catch(() => {});
    await task;
    return { cleared: true };
}

/** 保存用户主动导出的页面结构诊断；限制体积，避免异常 DOM 让 storage 或日志页失控。 */
async function savePageDiagnostics(structure) {
    if (!structure || typeof structure !== "object" || Array.isArray(structure)) {
        throw new Error("invalid_page_diagnostics");
    }
    const serialized = JSON.stringify(structure);
    const bytes = getUtf8ByteLength(serialized);
    if (bytes > MAX_PAGE_DIAGNOSTICS_BYTES) throw new Error("page_diagnostics_too_large");
    const record = { schemaVersion: 1, savedAt: new Date().toISOString(), structure };
    await chrome.storage.local.set({ [PAGE_DIAGNOSTICS_KEY]: record });
    return { saved: true, savedAt: record.savedAt, bytes };
}

async function getPageDiagnostics() {
    // 诊断页只读取最近一次用户主动采集的结构，不重新访问卖家页面，避免跨页面拿到错误 DOM。
    const stored = await chrome.storage.local.get(PAGE_DIAGNOSTICS_KEY);
    return stored[PAGE_DIAGNOSTICS_KEY] || null;
}

function interfaceDiagnosticTabKey(tabId) {
    return `${INTERFACE_DIAGNOSTIC_KEY_PREFIX}${tabId}`;
}

function interfaceDiagnosticDataKey(sessionId) {
    return `${INTERFACE_DIAGNOSTIC_DATA_PREFIX}${String(sessionId || "")}`;
}

function emptyInterfaceDiagnostics() {
    return { active: false, sessionId: "", sampleCount: 0, skippedCount: 0, droppedCount: 0, startedAt: "" };
}

async function readInterfaceDiagnosticSession(tabId) {
    if (!Number.isInteger(tabId)) return emptyInterfaceDiagnostics();
    const stored = await chrome.storage.session.get(interfaceDiagnosticTabKey(tabId));
    const value = stored[interfaceDiagnosticTabKey(tabId)];
    return value && typeof value === "object" ? {
        active: value.active === true,
        sessionId: String(value.sessionId || ""),
        sampleCount: Number(value.sampleCount) || 0,
        skippedCount: Number(value.skippedCount) || 0,
        droppedCount: Number(value.droppedCount) || 0,
        startedAt: String(value.startedAt || "")
    } : emptyInterfaceDiagnostics();
}

function diagnosticAllowedSender(sender) {
    return Boolean(sender && sender.tab && /^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(sender.tab.url || ""));
}

function diagnosticFieldType(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
}

/**
 * 将响应压缩为可分析的字段树和 ID 路径。这里只保留字段名、类型、长度和极少数 ID 样本，
 * 以便确认接口是否含商品图文/SKU，同时避免把商品正文、地址或会话值写入诊断文件。
 */
function summarizeInterfacePayload(payload) {
    const schema = [];
    const idPaths = { spu: [], goods: [], skc: [], sku: [] };
    const idSamples = { spu: [], goods: [], skc: [], sku: [] };
    const flags = { images: false, sku: false, specs: false, detailText: false };
    const seen = new Set();
    const safeKey = key => SENSITIVE_KEY_PATTERN.test(String(key || "")) ? "[REDACTED_KEY]" : String(key).slice(0, 100);
    const addId = (type, path, value) => {
        if (!idPaths[type].includes(path)) idPaths[type].push(path);
        const normalized = normalizeProductId(value);
        if (normalized && idSamples[type].length < 8 && !idSamples[type].includes(normalized)) idSamples[type].push(normalized);
    };
    const walk = (value, path, depth) => {
        if (seen.size >= MAX_INTERFACE_SCHEMA_NODES || depth > 6) return;
        const type = diagnosticFieldType(value);
        const marker = `${path}:${type}`;
        if (seen.has(marker)) return;
        seen.add(marker);
        const entry = { path: path.slice(0, 260), type };
        if (Array.isArray(value)) {
            entry.length = Math.min(value.length, 10000);
            schema.push(entry);
            value.slice(0, 12).forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
            return;
        }
        if (!value || typeof value !== "object") {
            schema.push(entry);
            return;
        }
        const keys = Object.keys(value).slice(0, 80);
        entry.keys = keys.map(safeKey);
        schema.push(entry);
        keys.forEach(key => {
            const childPath = `${path}.${safeKey(key)}`;
            const normalized = normalizeSchemaKey(key);
            const child = value[key];
            if (SPU_ID_KEYS.has(normalized)) {
                (Array.isArray(child) ? child.slice(0, 8) : [child]).forEach(item => addId("spu", childPath, item));
            } else if (GOODS_ID_KEYS.has(normalized)) {
                (Array.isArray(child) ? child.slice(0, 8) : [child]).forEach(item => addId("goods", childPath, item));
            } else if (SKC_ID_KEYS.has(normalized)) {
                (Array.isArray(child) ? child.slice(0, 8) : [child]).forEach(item => addId("skc", childPath, item));
            } else if (SKU_ID_KEYS.has(normalized)) {
                (Array.isArray(child) ? child.slice(0, 8) : [child]).forEach(item => addId("sku", childPath, item));
            }
            if (/image|picture|picurl|imageurl|mainphoto|thumbnail/i.test(key)) flags.images = true;
            if (/sku|skc|variant|variation/i.test(key)) flags.sku = true;
            if (/spec|attribute|property/i.test(key)) flags.specs = true;
            if (/detail|description|richtext|content|html|body/i.test(key) && typeof child === "string" && child.trim().length >= 8) flags.detailText = true;
            walk(child, childPath, depth + 1);
        });
    };
    walk(payload, "$", 0);
    return { schema, idPaths, idSamples, flags, nodeCount: schema.length };
}

function sanitizeDiagnosticRequestBody(body) {
    if (!body || typeof body !== "object") return { kind: "none", bytes: 0, keys: [] };
    const idFields = Array.isArray(body.idFields) ? body.idFields.slice(0, 12).map(field => {
        const key = String(field && field.key || "");
        const sample = String(field && field.sample || "").trim();
        return /(?:spu|goods|product|sku|skc)[_-]?ids?$/i.test(key) && /^[A-Za-z0-9_-]{1,128}$/.test(sample)
            ? { path: String(field && field.path || "").slice(0, 180), key: SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED_KEY]" : key.slice(0, 80), sample }
            : null;
    }).filter(Boolean) : [];
    return {
        kind: String(body.kind || "unknown").slice(0, 24),
        bytes: Number.isFinite(body.bytes) ? body.bytes : null,
        mimeType: String(body.mimeType || "").slice(0, 80),
        keys: Array.isArray(body.keys) ? body.keys.slice(0, 40).map(key => SENSITIVE_KEY_PATTERN.test(String(key)) ? "[REDACTED_KEY]" : String(key).slice(0, 80)) : [],
        idFields
    };
}

function makeInterfaceDiagnosticRecord(event, sender, skipped = false) {
    const pageUrl = sanitizeUrl(sender && sender.tab && sender.tab.url, sender && sender.tab && sender.tab.url);
    const requestUrl = sanitizeUrl(event && event.requestUrl, sender && sender.tab && sender.tab.url);
    // 字段树函数不会保留普通值，直接遍历载荷可避免诊断与普通采集并存时再做一次 8MB 深拷贝。
    const payload = event && event.payload && typeof event.payload === "object" ? event.payload : null;
    const summary = payload ? summarizeInterfacePayload(payload) : { schema: [], idPaths: { spu: [], goods: [], skc: [], sku: [] }, idSamples: { spu: [], goods: [], skc: [], sku: [] }, flags: { images: false, sku: false, specs: false, detailText: false }, nodeCount: 0 };
    return {
        recordedAt: new Date().toISOString(),
        status: skipped ? "skipped" : "json",
        reason: skipped ? String(event && event.reason || "capture_skipped").slice(0, 80) : "",
        requestUrl,
        pageUrl,
        queryKeys: (() => {
            try { return Array.from(new URL(String(event && event.requestUrl || ""), sender && sender.tab && sender.tab.url).searchParams.keys()).slice(0, 40).map(key => SENSITIVE_KEY_PATTERN.test(key) ? "[REDACTED_KEY]" : String(key).slice(0, 80)); } catch (_) { return []; }
        })(),
        method: String(event && event.method || "GET").toUpperCase().slice(0, 12),
        transport: event && event.transport === "xhr" ? "xhr" : "fetch",
        responseStatus: Number(event && event.responseStatus) || 0,
        responseBytes: Number.isFinite(event && event.responseBytes) ? event.responseBytes : null,
        durationMs: Number.isFinite(event && event.durationMs) ? Math.max(0, Math.min(event.durationMs, 600000)) : null,
        requestBody: sanitizeDiagnosticRequestBody(event && event.requestBody),
        schema: summary.schema,
        idPaths: summary.idPaths,
        idSamples: summary.idSamples,
        flags: summary.flags,
        nodeCount: summary.nodeCount
    };
}

/** 对单条诊断再设硬上限；遇到异常宽的 JSON 时宁可截断字段树，也不能让一次诊断写满 session storage。 */
function limitInterfaceDiagnosticRecord(record) {
    const safeRecord = record && typeof record === "object" ? record : null;
    if (!safeRecord) return null;
    const schema = Array.isArray(safeRecord.schema) ? safeRecord.schema : [];
    const originalSchemaCount = schema.length;
    while (schema.length > 1 && getUtf8ByteLength(JSON.stringify(safeRecord)) > MAX_INTERFACE_DIAGNOSTIC_RECORD_BYTES) schema.pop();
    if (getUtf8ByteLength(JSON.stringify(safeRecord)) > MAX_INTERFACE_DIAGNOSTIC_RECORD_BYTES) return null;
    if (schema.length < originalSchemaCount) safeRecord.schemaTruncated = true;
    return safeRecord;
}

/**
 * 诊断文件按会话隔离，允许用户同时比较少量页面动作；每次写入都按最近使用时间淘汰旧会话，
 * 防止多次“开始诊断”在 chrome.storage.session 中无限堆积。
 */
async function saveInterfaceDiagnosticData(sessionId, data) {
    const dataKey = interfaceDiagnosticDataKey(sessionId);
    const stored = await chrome.storage.session.get(INTERFACE_DIAGNOSTIC_INDEX_KEY);
    const previous = Array.isArray(stored[INTERFACE_DIAGNOSTIC_INDEX_KEY]) ? stored[INTERFACE_DIAGNOSTIC_INDEX_KEY] : [];
    const now = Date.now();
    const entries = [{ sessionId: String(sessionId), updatedAt: now }, ...previous
        .filter(entry => entry && String(entry.sessionId || "") && String(entry.sessionId) !== String(sessionId))]
        .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
    const candidateKeys = entries.map(entry => interfaceDiagnosticDataKey(entry.sessionId));
    const all = await chrome.storage.session.get(candidateKeys);
    const retained = [];
    const removedKeys = [];
    let totalBytes = 0;
    for (const entry of entries) {
        const key = interfaceDiagnosticDataKey(entry.sessionId);
        const value = entry.sessionId === String(sessionId) ? data : all[key];
        if (!value || typeof value !== "object") {
            removedKeys.push(key);
            continue;
        }
        const bytes = getUtf8ByteLength(JSON.stringify(value));
        if (retained.length >= MAX_INTERFACE_DIAGNOSTIC_SESSIONS || totalBytes + bytes > MAX_INTERFACE_DIAGNOSTIC_TOTAL_BYTES) {
            removedKeys.push(key);
            continue;
        }
        retained.push(entry);
        totalBytes += bytes;
    }
    await chrome.storage.session.set({ [dataKey]: data, [INTERFACE_DIAGNOSTIC_INDEX_KEY]: retained });
    const oldKeys = removedKeys.filter(key => key !== dataKey);
    if (oldKeys.length) await chrome.storage.session.remove(oldKeys);
}

async function appendInterfaceDiagnosticRecord(record, tabId, sessionId) {
    const task = interfaceDiagnosticWriteQueue.then(async () => {
        // 停止按钮可能与一条迟到响应并发到达；写入前再看会话状态，停止后的响应不能混进导出文件。
        const session = await readInterfaceDiagnosticSession(tabId);
        if (!session.active || String(session.sessionId || "") !== String(sessionId || "")) return null;
        const dataKey = interfaceDiagnosticDataKey(sessionId);
        const stored = await chrome.storage.session.get(dataKey);
        const current = stored[dataKey] && typeof stored[dataKey] === "object"
            ? stored[dataKey] : { schemaVersion: 1, sessionId, startedAt: new Date().toISOString(), records: [] };
        if (String(current.sessionId || "") !== String(sessionId || "")) return current;
        const records = Array.isArray(current.records) ? current.records : [];
        const limitedRecord = limitInterfaceDiagnosticRecord(record);
        let droppedCount = Number(current.droppedCount) || 0;
        if (!limitedRecord) {
            const next = { ...current, records, droppedCount: droppedCount + 1, updatedAt: new Date().toISOString() };
            await saveInterfaceDiagnosticData(sessionId, next);
            const nextSession = { ...session, droppedCount: (Number(session.droppedCount) || 0) + 1 };
            await chrome.storage.session.set({ [interfaceDiagnosticTabKey(tabId)]: nextSession });
            return { next, diagnostics: nextSession };
        }
        records.push(limitedRecord);
        while (records.length > MAX_INTERFACE_DIAGNOSTIC_EVENTS) { records.shift(); droppedCount += 1; }
        while (records.length > 1 && getUtf8ByteLength(JSON.stringify(records)) > MAX_INTERFACE_DIAGNOSTIC_BYTES) { records.shift(); droppedCount += 1; }
        const next = { ...current, records, droppedCount, updatedAt: new Date().toISOString() };
        await saveInterfaceDiagnosticData(sessionId, next);
        const nextSession = { ...session, sampleCount: records.filter(item => item && item.status === "json").length, skippedCount: records.filter(item => item && item.status === "skipped").length, droppedCount };
        await chrome.storage.session.set({ [interfaceDiagnosticTabKey(tabId)]: nextSession });
        return { next, diagnostics: nextSession };
    });
    interfaceDiagnosticWriteQueue = task.catch(() => {});
    return task;
}

async function startInterfaceDiagnostics(sender) {
    if (!diagnosticAllowedSender(sender)) throw new Error("unsupported_sender");
    const tabId = sender.tab.id;
    if (await isTabCaptureEnabled(tabId)) throw new Error("capture_active_cannot_start_diagnostics");
    const sessionId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const diagnostics = { active: true, sessionId, sampleCount: 0, skippedCount: 0, droppedCount: 0, startedAt: new Date().toISOString() };
    const task = interfaceDiagnosticWriteQueue.then(async () => {
        await saveInterfaceDiagnosticData(sessionId, { schemaVersion: 1, sessionId, startedAt: diagnostics.startedAt, records: [] });
        await chrome.storage.session.set({ [interfaceDiagnosticTabKey(tabId)]: diagnostics });
        return diagnostics;
    });
    interfaceDiagnosticWriteQueue = task.catch(() => {});
    return task;
}

async function stopInterfaceDiagnostics(sender) {
    if (!diagnosticAllowedSender(sender)) throw new Error("unsupported_sender");
    const tabId = sender.tab.id;
    const task = interfaceDiagnosticWriteQueue.then(async () => {
        const diagnostics = await readInterfaceDiagnosticSession(tabId);
        const stopped = { ...diagnostics, active: false };
        await chrome.storage.session.set({ [interfaceDiagnosticTabKey(tabId)]: stopped });
        return stopped;
    });
    interfaceDiagnosticWriteQueue = task.catch(() => {});
    const stopped = await task;
    const query = new URLSearchParams({ autodownload: "1", session: stopped.sessionId });
    await chrome.tabs.create({ url: chrome.runtime.getURL(`interface-diagnostics.html?${query.toString()}`), active: true });
    return stopped;
}

async function getInterfaceDiagnostics(sessionId = "") {
    await interfaceDiagnosticWriteQueue;
    const key = interfaceDiagnosticDataKey(sessionId);
    const stored = await chrome.storage.session.get(key);
    return stored[key] || { schemaVersion: 1, sessionId: String(sessionId || ""), records: [] };
}

async function clearInterfaceDiagnostics(sessionId = "") {
    const task = interfaceDiagnosticWriteQueue.then(async () => {
        const dataKey = interfaceDiagnosticDataKey(sessionId);
        const stored = await chrome.storage.session.get(null);
        const index = Array.isArray(stored[INTERFACE_DIAGNOSTIC_INDEX_KEY]) ? stored[INTERFACE_DIAGNOSTIC_INDEX_KEY] : [];
        const sessionUpdates = {};
        Object.entries(stored).forEach(([key, value]) => {
            if (!key.startsWith(INTERFACE_DIAGNOSTIC_KEY_PREFIX) || !value || typeof value !== "object") return;
            if (String(value.sessionId || "") === String(sessionId || "")) sessionUpdates[key] = { ...value, active: false };
        });
        await chrome.storage.session.set({ ...sessionUpdates, [INTERFACE_DIAGNOSTIC_INDEX_KEY]: index.filter(entry => String(entry && entry.sessionId || "") !== String(sessionId || "")) });
        await chrome.storage.session.remove(dataKey);
    });
    interfaceDiagnosticWriteQueue = task.catch(() => {});
    await task;
    return { cleared: true };
}

async function recordInterfaceDiagnostic(message, sender, skipped) {
    if (!diagnosticAllowedSender(sender)) throw new Error("unsupported_sender");
    const tabId = sender.tab.id;
    const session = await readInterfaceDiagnosticSession(tabId);
    if (!session.active || !session.sessionId) return { recorded: false, diagnostics: session };
    const record = makeInterfaceDiagnosticRecord(message && message.event, sender, skipped);
    const result = await appendInterfaceDiagnosticRecord(record, tabId, session.sessionId);
    if (!result || !result.next || String(result.next.sessionId || "") !== session.sessionId) return { recorded: false, diagnostics: await readInterfaceDiagnosticSession(tabId), recordCount: 0 };
    return { recorded: true, diagnostics: result.diagnostics, recordCount: Array.isArray(result.next.records) ? result.next.records.length : 0 };
}

function captureEnabledKey(tabId) {
    return `captureEnabledTab:${tabId}`;
}

function selectedCaptureKey(tabId) {
    return `selectedCaptureIntent:${tabId}`;
}

/** 按标签页暂存用户勾选的 SPU；选择属于当前店铺会话，不能与其他紫鸟店铺共用。 */
async function saveSelectedCaptureIntent(input, sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) throw new Error("missing_sender_tab");
    const ids = [...new Set((Array.isArray(input && input.spuIds) ? input.spuIds : [])
        .map(normalizeProductId).filter(Boolean))].slice(0, 1000);
    if (!ids.length) throw new Error("no_selected_spu_ids");
    const intent = {
        version: 1,
        spuIds: ids,
        pageUrl: String(input && input.pageUrl || sender.tab.url || "").slice(0, 1000),
        pageStoreName: String(input && input.pageStoreName || "").slice(0, 120),
        createdAt: Date.now()
    };
    await chrome.storage.session.set({ [selectedCaptureKey(tabId)]: intent });
    return { ok: true, intent };
}

async function getSelectedCaptureIntent(sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) throw new Error("missing_sender_tab");
    const key = selectedCaptureKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const intent = stored[key];
    if (!intent || typeof intent !== "object" || intent.version !== 1 || Date.now() - Number(intent.createdAt || 0) > 2 * 60 * 60 * 1000) {
        await chrome.storage.session.remove(key);
        return { ok: true, intent: null };
    }
    return { ok: true, intent };
}

async function clearSelectedCaptureIntent(sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) throw new Error("missing_sender_tab");
    await chrome.storage.session.remove(selectedCaptureKey(tabId));
    return { ok: true };
}

function detailQueueKey(tabId) {
    return `${DETAIL_QUEUE_PREFIX}${tabId}`;
}

// 同一标签的开始、落库、推进和停止串行，避免旧回执覆盖新批次或暂停状态。
const detailQueueLocks = new Map();
function withDetailQueue(tabId, task) {
    const next = (detailQueueLocks.get(tabId) || Promise.resolve()).catch(() => {}).then(task);
    detailQueueLocks.set(tabId, next);
    return next.finally(() => { if (detailQueueLocks.get(tabId) === next) detailQueueLocks.delete(tabId); });
}

/**
 * 详情补采队列放在 session storage，跨商品导航仍能保留进度，但关闭浏览器后不会把旧任务带到下一次采集。
 * 队列只保存 SPU、状态和事件指纹，不保存正文，正文仍由 IndexedDB 的原始响应负责承载。
 */
async function loadDetailQueue(tabId) {
    const stored = await chrome.storage.session.get(detailQueueKey(tabId));
    const value = stored[detailQueueKey(tabId)];
    if (!value || typeof value !== "object" || value.version !== DETAIL_QUEUE_VERSION) return null;
    return value;
}

async function saveDetailQueue(tabId, queue) {
    await chrome.storage.session.set({ [detailQueueKey(tabId)]: queue });
    return queue;
}

function detailQueueView(queue) {
    if (!queue) return { active: false, status: "none", total: 0, completed: 0, failed: 0, eventIds: [] };
    const items = Array.isArray(queue.items) ? queue.items : [];
    const current = items[Number(queue.currentIndex) || 0] || null;
    const completed = items.filter(item => item.status === "done").length;
    const complete = items.filter(item => item.status === "done" && item.detailCapture && item.detailCapture.completeness === "complete").length;
    const partial = items.filter(item => item.status === "done" && (!item.detailCapture || item.detailCapture.completeness !== "complete")).length;
    return {
        runId: queue.runId || "",
        mode: queue.mode || "navigation",
        spuIds: items.map(item => item.spuId),
        active: queue.active === true,
        status: String(queue.status || (queue.active ? "running" : "done")),
        total: items.length,
        completed,
        complete,
        partial,
        failed: items.filter(item => item.status === "failed").length,
        failures: items.filter(item => item.status === "failed").slice(0, 20).map(item => ({ spuId: item.spuId, reason: item.reason })),
        current: current && current.status === "queued" ? {
            ...current,
            detailCapture: compactDetailCapture(current.detailCapture),
            detailCaptured: Boolean(current.detailCapture && current.detailCapture.captured),
            completeness: current.detailCapture && current.detailCapture.completeness === "complete" ? "complete" : "partial"
        } : null,
        currentIndex: Number(queue.currentIndex) || 0,
        listUrl: String(queue.listUrl || ""),
        eventIds: Array.isArray(queue.eventIds) ? queue.eventIds.slice(0, 5000) : [],
        finalizationPending: queue.finalizationPending === true,
        finalization: queue.finalization && typeof queue.finalization === "object" ? {
            download: queue.finalization.download && typeof queue.finalization.download === "object" ? { ...queue.finalization.download } : null,
            ingest: queue.finalization.ingest && typeof queue.finalization.ingest === "object" ? { ...queue.finalization.ingest } : null
        } : null,
        startedAt: String(queue.startedAt || ""),
        finishedAt: String(queue.finishedAt || "")
    };
}

/** 详情队列结束后只保存入库结果摘要；采集过程不再自动生成下载文件。 */
function summarizeDetailFinalization(result, error) {
    if (error) return { status: "error", error: String(error && error.message || error).slice(0, 160) };
    if (!result || typeof result !== "object") return { status: "unknown" };
    if (result.exported) return {
        status: "done",
        fileName: String(result.fileName || "").slice(0, 240),
        bytes: Number.isFinite(result.bytes) ? result.bytes : 0,
        productCount: Number.isInteger(result.productCount) ? result.productCount : 0
    };
    if (result.batchId || result.reused) return {
        status: "done",
        batchId: String(result.batchId || "").slice(0, 120),
        reused: result.reused === true,
        productCount: Number.isInteger(result.productCount) ? result.productCount : 0
    };
    return { status: result.skipped ? "skipped" : "unknown", reason: String(result.reason || "").slice(0, 160) };
}

/** 创建逐 SPU 详情补采队列；仅允许来自 Temu 页面消息，避免外部页面伪造导航任务。 */
async function beginDetailSupplement(input, sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) throw new Error("missing_sender_tab");
    if (!await isTabCaptureEnabled(tabId)) throw new Error("capture_not_enabled_for_tab");
    if (!/^https:\/\/agentseller\.temu\.com\/goods\/list(?:[?#]|$)/.test(sender.tab.url || "")) throw new Error("当前仅支持 agentseller 商品列表页接口采集");
    const existing = await loadDetailQueue(tabId);
    if (existing && existing.active) {
        // 用户手动返回列表页或页面刷新后，继续当前商品而不是创建第二条队列。
        if (existing.mode !== "api") await navigateDetailQueue(tabId, existing);
        return detailQueueView(existing);
    }
    const ids = [...new Set((Array.isArray(input && input.spuIds) ? input.spuIds : [])
        .map(normalizeProductId).filter(Boolean))].slice(0, 1000);
    if (!ids.length) throw new Error("no_detail_spu_ids");
    const listUrl = sanitizeUrl(input && input.listUrl, sender.tab.url) || sanitizeUrl(sender.tab.url, sender.tab.url);
    const queue = {
        version: DETAIL_QUEUE_VERSION,
        mode: "api",
        runId: crypto.randomUUID(),
        contextUrl: String(sender.tab.url || ""),
        active: true,
        status: "running",
        listUrl,
        currentIndex: 0,
        startedAt: new Date().toISOString(),
        finalizationPending: false,
        finalization: null,
        eventIds: Array.isArray(input && input.eventIds) ? [...new Set(input.eventIds.map(String).filter(Boolean))].slice(0, 5000) : [],
        items: ids.map(spuId => ({
            spuId,
            status: "queued",
            attempts: 0,
            // 每件商品必须单独存证据，不能让上一件的详情字段影响下一件的完成判断。
            detailEvidence: false,
            detailCapture: emptyDetailCapture(),
            eventIds: [],
            updatedAt: ""
        }))
    };
    await saveDetailQueue(tabId, queue);
    return detailQueueView(queue);
}

function detailPageUrl(spuId, listUrl = "") {
    let origin = "https://agentseller.temu.com";
    try { origin = new URL(String(listUrl || origin)).origin; } catch (_) {}
    return `${origin}/goods/edit?from=productList&productId=${encodeURIComponent(String(spuId || ""))}`;
}

/** 逐个导航到商品编辑页，让卖家中心自己的请求封装提供详情数据，避免后台裸调接口触发 403。 */
async function navigateDetailQueue(tabId, queue) {
    const item = queue && queue.items && queue.items[Number(queue.currentIndex) || 0];
    const target = item && item.spuId ? detailPageUrl(item.spuId, queue && queue.listUrl) : String(queue && queue.listUrl || "");
    if (!target) return;
    await chrome.tabs.update(tabId, { url: target });
}

/** 详情页空闲后推进队列；失败项保留原因，最终包仍可明确显示哪些 SPU 未补齐。 */
async function advanceDetailSupplement(input, sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) throw new Error("missing_sender_tab");
    const queue = await loadDetailQueue(tabId);
    if (!queue) return detailQueueView(null);
    if (queue.mode === "api" && input.runId !== queue.runId) throw new Error("stale_detail_run");
    const index = Number(queue.currentIndex) || 0;
    const item = queue.items[index];
    if (!item || (input && input.spuId && String(input.spuId) !== String(item.spuId))) return detailQueueView(queue);
    // 页面定时器、刷新恢复或重复消息可能同时回报同一 SPU；已推进的项目不能再次推进队列。
    if (!queue.active || item.status !== "queued") return detailQueueView(queue);
    if (item) {
        const capture = mergeDetailCapture(item.detailCapture, input && input.detailCapture);
        const status = input && input.status === "done" && capture.captured ? "done" : "failed";
        item.status = status;
        item.detailCapture = capture;
        item.reason = String(input && input.reason || (status === "done" && capture.missing.length ? `缺少${capture.missing.join("、")}` : "")).slice(0, 160);
        item.detailEvidence = capture.detailText;
        item.updatedAt = new Date().toISOString();
        if (queue.mode === "api" && status === "failed") {
            await appendCaptureLog({ timestamp: new Date().toISOString(), status: "api-detail-failed", category: "product-detail", runId: queue.runId, productIds: [item.spuId], error: item.reason || "详情查询失败", pageUrl: sanitizeUrl(sender.tab.url), source: "api-batch" });
        }
    }
    if (queue.mode === "api" && item.status === "failed") {
        // 权限、超时或ID冲突后不继续撞接口；未查询项保留queued供日志区分。
        queue.active = false;
        queue.status = "partial";
        queue.finishedAt = new Date().toISOString();
    } else if (index + 1 >= queue.items.length) {
        queue.active = false;
        queue.status = queue.items.some(entry => entry.status === "failed" || !entry.detailCapture || entry.detailCapture.completeness !== "complete") ? "partial" : "done";
        queue.finalizationPending = true;
        queue.finishedAt = new Date().toISOString();
    } else {
        queue.currentIndex = index + 1;
        queue.items[queue.currentIndex].attempts = Number(queue.items[queue.currentIndex].attempts || 0) + 1;
    }
    await saveDetailQueue(tabId, queue);
    if (queue.mode === "api") {
        if (!queue.active) {
            // 接口详情是当前主采集路径；结束后必须导出并入库，不能停在“等待点击上传”。
            await finalizeDetailQueue(tabId, queue, { returnToList: false });
        }
        return detailQueueView(queue);
    }
    if (queue.active) {
        await navigateDetailQueue(tabId, queue);
    } else {
        // 编辑页补采结束后回到列表页；下载和入库结果写进队列终态，供面板区分“已采集”和“已入库”。
        await finalizeDetailQueue(tabId, queue, { returnToList: true });
    }
    return detailQueueView(queue);
}

/**
 * 详情队列结束后只在启用自动入库时推送到云仓；下载完整包必须由用户从导出页主动发起。
 */
async function finalizeDetailQueue(tabId, queue, options = {}) {
    const eventIds = Array.isArray(queue.eventIds) ? queue.eventIds.slice(0, 5000) : [];
    const allowedSpuIds = (Array.isArray(queue.items) ? queue.items : [])
        .map(entry => String(entry && entry.spuId || "")).filter(Boolean);
    queue.finalizationPending = true;
    queue.finalization = { download: { status: "skipped", reason: "采集完成不自动下载，请从导出页手动导出" }, ingest: { status: "pending" } };
    await saveDetailQueue(tabId, queue);
    await chrome.storage.session.set({ [captureEnabledKey(tabId)]: false });
    try {
        const settings = await getIngestSettings();
        if (settings.autoPush === false) {
            queue.finalization.ingest = { status: "skipped", reason: "已关闭自动" };
        } else {
            const result = await pushFullPacket({ eventIds, allowedSpuIds });
            queue.finalization.ingest = summarizeDetailFinalization(result, null);
        }
    } catch (error) {
        queue.finalization.ingest = summarizeDetailFinalization(null, error);
    }
    queue.finalizationPending = false;
    await saveDetailQueue(tabId, queue);
    if (options.returnToList && queue.listUrl) await chrome.tabs.update(tabId, { url: queue.listUrl });
}

/** 用户停止采集时取消未完成的详情导航，避免旧任务在下一次采集时继续串入当前页。 */
async function clearDetailSupplement(sender) {
    const tabId = sender && sender.tab && sender.tab.id;
    if (!Number.isInteger(tabId)) throw new Error("missing_sender_tab");
    const queue = await loadDetailQueue(tabId);
    await chrome.storage.session.remove(detailQueueKey(tabId));
    return { cleared: true, queue: detailQueueView(queue) };
}

/** 详情页每条相关响应成功落库后登记事件指纹，返回列表页时自动包能覆盖列表和补采响应。 */
async function noteDetailCapture(tabId, event, result) {
    const queue = await loadDetailQueue(tabId);
    if (!queue || !queue.active) return queue;
    if (queue.mode === "api" && event.apiRunId !== queue.runId) return queue;
    const index = Number(queue.currentIndex) || 0;
    const item = queue.items[index];
    if (!item) return queue;
    const url = String(event && event.requestUrl || "");
    // 详情页的接口路径并不固定（例如 darwin-mms/.../stock/query），只要来自当前编辑页就纳入本商品完整包；
    // 页面上下文已限定当前 SPU，避免依赖路径猜测而漏掉图片、规格和正文接口。
    if (result && result.eventId && (result.detailRequestSeen || result.detailPage || result.productRelated || result.detailEvidence || /(?:product|goods|sku|image|category)/i.test(url))) {
        const eventId = String(result.eventId);
        if (!queue.eventIds.includes(eventId)) queue.eventIds.push(eventId);
        if (!item.eventIds.includes(eventId)) item.eventIds.push(eventId);
    }
    if (result && result.detailCapture) item.detailCapture = mergeDetailCapture(item.detailCapture, result.detailCapture);
    if (item.detailCapture && item.detailCapture.detailText) item.detailEvidence = true;
    await saveDetailQueue(tabId, queue);
    return queue;
}

/** 接口回执必须属于当前启用批次和队列头；落库成功后才推进，禁止页面自报完整度。 */
async function captureApiDetail(input, sender) {
    const tabId = sender.tab?.id;
    const queue = await loadDetailQueue(tabId);
    const item = queue?.items?.[queue.currentIndex];
    if (!await isTabCaptureEnabled(tabId) || !queue?.active || queue.mode !== "api" || queue.runId !== input.runId || item?.spuId !== input.spuId) throw new Error("stale_detail_run");
    if (sender.tab.url !== queue.contextUrl) throw new Error("page_context_changed");
    const product = input.payload?.result;
    if (input.payload?.success !== true || String(product?.productId || "") !== item.spuId) throw new Error("detail_product_id_mismatch");
    const event = { kind: "network-json", requestUrl: new URL("/visage-agent-seller/product/query", sender.tab.url).href, method: "POST", transport: "fetch", responseStatus: 200, payload: input.payload, apiRunId: queue.runId };
    try {
        const result = await saveCapture(event, sender);
        await noteDetailCapture(tabId, event, result);
        await appendCaptureLog(makeCaptureLog(event, sender, result, null));
        return { result, queue: await advanceDetailSupplement({ runId: queue.runId, spuId: item.spuId, status: "done" }, sender) };
    } catch (error) {
        await appendCaptureLog(makeCaptureLog(event, sender, null, error));
        throw error;
    }
}

async function isTabCaptureEnabled(tabId) {
    const key = captureEnabledKey(tabId);
    const result = await chrome.storage.session.get(key);
    return result[key] === true;
}

function defaultIngestSettings() {
    return {
        endpoint: "https://www.ruofei.com.cn/temu/api/ingest",
        token: "",
        pluginTokenExpiresAt: 0,
        // 新安装按云仓流程采集后入库；已有用户配置继续保留。
        autoPush: true,
        settingsVersion: 3
    };
}

function normalizeIngestEndpoint(value) {
    const raw = String(value || "").trim();
    if (!raw) return defaultIngestSettings().endpoint;
    try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid_ingest_protocol");
        if (!url.pathname || url.pathname === "/") url.pathname = "/api/ingest";
        url.pathname = String(url.pathname || "/").replace(/\/+$/, "") || "/api/ingest";
        url.hash = "";
        return url.toString();
    } catch (_) {
        throw new Error("invalid_ingest_endpoint");
    }
}

async function getIngestSettings() {
    const stored = await chrome.storage.local.get(INGEST_SETTINGS_KEY);
    const current = stored[INGEST_SETTINGS_KEY] && typeof stored[INGEST_SETTINGS_KEY] === "object"
        ? stored[INGEST_SETTINGS_KEY]
        : {};
    const settingsVersion = Number(current.settingsVersion) || 0;
    const next = {
        endpoint: String(current.endpoint || defaultIngestSettings().endpoint),
        token: String(current.token || ""),
        // 云端插件令牌有有效期；设备令牌没有该字段，不能把两种令牌混为一谈。
        pluginTokenExpiresAt: Number.isFinite(Number(current.pluginTokenExpiresAt)) ? Number(current.pluginTokenExpiresAt) : 0,
        // 10.3 改为人工上传；旧版“默认自动推送”不视为用户的明确选择，升级后统一关闭。
        autoPush: settingsVersion >= 3 ? current.autoPush === true : defaultIngestSettings().autoPush,
        settingsVersion: 3
    };
    if (settingsVersion < 3) {
        await chrome.storage.local.set({ [INGEST_SETTINGS_KEY]: next });
    }
    return next;
}

async function saveIngestSettings(settings, requestPermission) {
    const next = {
        endpoint: normalizeIngestEndpoint(settings && settings.endpoint),
        token: String(settings && settings.token || "").trim(),
        pluginTokenExpiresAt: Number.isFinite(Number(settings && settings.pluginTokenExpiresAt)) ? Number(settings.pluginTokenExpiresAt) : 0,
        autoPush: settings && Object.prototype.hasOwnProperty.call(settings, "autoPush")
            ? Boolean(settings.autoPush)
            : true,
        settingsVersion: 3
    };
    await chrome.storage.local.set({ [INGEST_SETTINGS_KEY]: next });
    const permissionGranted = await ensureIngestPermission(next.endpoint);
    // 本机仓库在已授权时会把令牌返回给本机请求；保存后立刻补齐，避免用户还要再复制一次。
    const bootstrapped = permissionGranted ? await bootstrapIngestToken(next) : next;
    return { settings: bootstrapped, permissionGranted: Boolean(permissionGranted) };
}

function ingestOriginPattern(endpoint) {
    return new URL(endpoint).origin + "/*";
}

async function ensureIngestPermission(endpoint) {
    const origin = ingestOriginPattern(endpoint);
    const has = await chrome.permissions.contains({ origins: [origin] }).catch(() => false);
    if (has) return true;
    // 清单已声明的本机入库地址不需要再走 optional 授权；部分 Chromium 内核 contains 会对已声明 host 返回 false。
    if (isDeclaredLocalIngestOrigin(endpoint)) return true;
    // 局域网或其他地址仍只能在设置页的用户点击里申请权限，后台不能代点授权。
    return false;
}

function isDeclaredLocalIngestOrigin(endpoint) {
    try {
        const url = new URL(endpoint);
        const localHost = url.hostname === "127.0.0.1" || url.hostname === "localhost";
        // 清单只声明了 http://127.0.0.1:17380 和 http://localhost:17380，不能把 https 也当成已授权。
        return localHost && url.port === "18380" && url.protocol === "http:";
    } catch (_) {
        return false;
    }
}

async function ingestInfoUrl(endpoint) {
    return TemuIngestEndpoint.apiUrl(endpoint, "/api/ingest-info");
}

/**
 * 本机仓库的 /api/ingest-info 会把令牌返回给本机请求。
 * 仅在用户还没填令牌时补齐；非本机请求仓库不会下发令牌，这时仍需从仓库首页复制。
 */
/** 只读连接测试使用兼容的 AbortController；覆盖读取正文，避免返回响应头后仍无限等待。 */
async function probeIngestInfo(settings, authenticated = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await diagnosticFetch(await ingestInfoUrl(settings.endpoint), {
            method: "GET", signal: controller.signal,
            headers: authenticated ? { authorization: `Bearer ${settings.token}` } : {}
        });
        const data = await response.json();
        return { response, data };
    } catch (error) {
        if (controller.signal.aborted) throw new Error("ingest_probe_timeout");
        throw error;
    } finally { clearTimeout(timer); }
}

async function bootstrapIngestToken(settings, throwOnFailure = false) {
    const token = String(settings.token || "");
    const expiresAt = Number(settings.pluginTokenExpiresAt) || 0;
    const pluginTokenStale = token.startsWith("pt_") && (!expiresAt || expiresAt <= Date.now() + 60_000);
    // 设备令牌由用户配置、没有过期时间；插件专用令牌接近过期时才重新登记，避免每次心跳都申请新令牌。
    if (token && !pluginTokenStale) return settings;
    const registrationSettings = pluginTokenStale ? { ...settings, token: "", pluginTokenExpiresAt: 0 } : settings;
    const allowed = await ensureIngestPermission(registrationSettings.endpoint);
    if (!allowed) return settings;
    try {
        // 公网首次连接只登记插件实例，服务器返回实例专用令牌；管理员令牌永不进入扩展包。
        const registration = await diagnosticFetch(TemuIngestEndpoint.apiUrl(registrationSettings.endpoint, "/api/plugin/register"), {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pluginInstanceId:await getPluginInstanceId(),pluginVersion:chrome.runtime.getManifest().version})});
        const registered = await registration.json().catch(()=>({}));
        if(registration.ok && registered.token){const next={...registrationSettings,token:String(registered.token),pluginTokenExpiresAt:Date.now()+Math.max(60_000,Number(registered.expiresIn||86_400)*1000),settingsVersion:3};await chrome.storage.local.set({[INGEST_SETTINGS_KEY]:next});return next;}
        // 连接探测只读且有时间上限；不对商品提交请求套用自动重试，避免重复创建。
        const { response, data } = await probeIngestInfo(registrationSettings);
        const token = String(data && data.token || "").trim();
        if (!response.ok || !token) return registrationSettings;
        const next = { ...registrationSettings, token, pluginTokenExpiresAt: 0, settingsVersion: 3 };
        await chrome.storage.local.set({ [INGEST_SETTINGS_KEY]: next });
        return next;
    } catch (error) {
        // 保存设置时仓库可能还没开，不能把连接失败当成保存失败；推送/测试时必须报出来。
        if (throwOnFailure) throw new Error(error?.message === "ingest_probe_timeout" ? "ingest_probe_timeout" : "ingest_unreachable");
        return settings;
    }
}

/** 云端插件令牌失效时只重登记认证，不重试已被服务端接受的业务请求。 */
async function authenticatedIngestFetch(url, settings, options = {}) {
    const makeOptions = (token) => ({ ...options, headers: { ...(options.headers || {}), authorization: `Bearer ${token}` } });
    let response = await diagnosticFetch(url, makeOptions(settings.token));
    if ((response.status === 401 || response.status === 403) && String(settings.token || "").startsWith("pt_")) {
        const cleared = { ...settings, token: "", pluginTokenExpiresAt: 0 };
        await chrome.storage.local.set({ [INGEST_SETTINGS_KEY]: cleared });
        const refreshed = await bootstrapIngestToken(cleared, true);
        response = await diagnosticFetch(url, makeOptions(refreshed.token));
    }
    return response;
}

async function testIngestConnection() {
    const settings = await bootstrapIngestToken(await getIngestSettings(), true);
    const allowed = await ensureIngestPermission(settings.endpoint);
    if (!allowed) throw new Error("ingest_permission_denied");
    if (!settings.token) throw new Error("missing_ingest_token");
    const { response, data } = await probeIngestInfo(settings, true);
    if (!response.ok) throw new Error(data.error || `ingest_http_${response.status}`);
    if (data.authorized !== true) throw new Error("ingest_unauthorized");
    if (!TemuIngestEndpoint.matchesConfiguredEndpoint(settings.endpoint, data)) {
        throw new Error("ingest_endpoint_mismatch");
    }
    return {
        service: data.service || "ziniao-ingest",
        origin: new URL(settings.endpoint).origin,
        endpoints: Array.isArray(data.endpoints) && data.endpoints.length ? data.endpoints : [settings.endpoint],
        ingestPath: data.ingestPath || TemuIngestEndpoint.endpointPath(settings.endpoint)
    };
}

function stampPacketName(prefix) {
    return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
}

let ingestPushQueue = Promise.resolve();

/**
 * 把 IndexedDB 中的全部响应打成与下载文件相同的完整包，再一次性推到入库台。
 * 不按接口实时上报，避免菜单、红点和配置接口把仓库打成碎片批次。
 */
async function pushFullPacket(options = {}) {
    const run = ingestPushQueue.then(() => pushFullPacketNow(options));
    ingestPushQueue = run.catch(() => {});
    return run;
}

/**
 * 实际推送完整包。空库直接跳过，避免采集失败时在仓库里留下空批次。
 * 并发推送串行化，防止采集结束和手动点击同时写出两份相同文件。
 */
async function pushFullPacketNow(options = {}) {
    const settings = await bootstrapIngestToken(await getIngestSettings(), true);
    const allowed = await ensureIngestPermission(settings.endpoint);
    if (!allowed) throw new Error("ingest_permission_denied");
    if (!settings.token) throw new Error("missing_ingest_token");
    const allRecords = await getAllRecords();
    const requestedIds = Array.isArray(options.eventIds)
        ? new Set(options.eventIds.map(value => String(value || "").trim()).filter(Boolean))
        : null;
    const allowedSpuIds = Array.isArray(options.allowedSpuIds)
        ? options.allowedSpuIds.map(value => String(value || "").trim()).filter(Boolean)
        : null;
    // 自动入库按本次任务 eventId 取子集；手动导出与手动推送仍保留“全部本地记录”的既有语义。
    const records = requestedIds ? allRecords.filter(record => requestedIds.has(String(record && record.eventId || ""))) : allRecords;
    if (!records.length) {
        return {
            skipped: true,
            reason: "empty_packet",
            recordCount: 0,
            productCount: 0
        };
    }
    const packet = makeFullCapturePacket(records, await packetSourceOptions({
        scope: requestedIds ? "current-capture-run" : "all-local-captured-records",
        allowedSpuIds
    }));
    if (!packet.products.length) {
        return {
            skipped: true,
            reason: "no_products",
            recordCount: packet.records.length,
            productCount: 0
        };
    }
    const fileName = stampPacketName("temu-full-capture");
    const ingestLabel = String(options.label || packet.source && packet.source.shopName || "插件直推");
    const response = await authenticatedIngestFetch(settings.endpoint, settings, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "x-ingest-filename": fileName },
        body: JSON.stringify({
            // HTTP 请求头只接受 ByteString；中文批次名必须放 JSON 正文，否则浏览器会在发送前抛错。
            label: ingestLabel,
            shopName: options.shopName || packet.source && packet.source.shopName || "",
            fileName,
            packet
        })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `ingest_http_${response.status}`);
    return {
        reused: Boolean(data.reused),
        batchId: data.batchId || (data.batch && data.batch.id) || "",
        batch: data.batch || null,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
        recordCount: packet.records.length,
        productCount: packet.products.length
    };
}

async function maybeAutoPushFullPacket(context = {}) {
    const settings = await getIngestSettings();
    if (!settings.autoPush) return { skipped: true, reason: "auto_push_disabled" };
    // 自动推送只能代表刚结束的任务；没有本次商品回执时禁止把历史 IndexedDB 全量包误报为本次采集结果。
    if (Number(context.saved) <= 0 || Number(context.productEvents) <= 0) {
        return { skipped: true, reason: "no_run_product_records" };
    }
    const eventIds = Array.isArray(context.eventIds) ? context.eventIds : [];
    if (!eventIds.length) return { skipped: true, reason: "no_run_product_records" };
    const allowedSpuIds = Array.isArray(context.allowedSpuIds) ? context.allowedSpuIds : [];
    if (!allowedSpuIds.length) return { skipped: true, reason: "no_current_page_spu" };
    // 同一采集再次入队时，attempts/nextAttemptAt 由队列合并逻辑保留；这里只提交本次商品范围。
    await enqueueIngestJob({
        eventIds,
        allowedSpuIds,
        saved: Number(context.saved) || 0,
        productEvents: Number(context.productEvents) || 0,
        createdAt: new Date().toISOString()
    });
    const fingerprint = TemuIngestQueue.fingerprintJob({ eventIds, allowedSpuIds });
    // 队列里可能已有更早的到期任务。这次采集只认自己那条任务；别人的批次不能写进当前面板。
    try {
        const result = await enqueuePendingIngest();
        const jobs = await loadPendingIngestJobs();
        if (result && result.fingerprint === fingerprint) return { ...result, queue: result.queue || await ingestQueueStatusFor(fingerprint, jobs) };
        const mine = jobs.find(job => job.fingerprint === fingerprint);
        if (!mine) {
            const queue = await ingestQueueStatusFor(fingerprint, jobs);
            if (queue && queue.outcome) return { skipped: true, reason: queue.outcome.status === "done" ? "already_done" : "already_failed", queue, fingerprint };
            return { skipped: true, reason: "queued", queue, fingerprint };
        }
        return { skipped: true, reason: "queued", queue: await ingestQueueStatusFor(fingerprint, jobs), fingerprint };
    } catch (error) {
        const jobs = await loadPendingIngestJobs();
        if (error && error.fingerprint === fingerprint) throw error;
        const mine = jobs.find(job => job.fingerprint === fingerprint);
        if (!mine) throw error;
        return { skipped: true, reason: "queued", queue: await ingestQueueStatusFor(fingerprint, jobs), fingerprint };
    }
}

/**
 * 读取队列时兼容旧的单任务字段。多个失败任务必须同时保留，后一次采集不能覆盖前一次。
 */
async function loadPendingIngestJobs() {
    const stored = await chrome.storage.local.get([TemuIngestQueue.QUEUE_KEY, TemuIngestQueue.LEGACY_KEY]);
    return TemuIngestQueue.migrateLegacyJobs(
        stored[TemuIngestQueue.QUEUE_KEY],
        stored[TemuIngestQueue.LEGACY_KEY]
    );
}

async function savePendingIngestJobs(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    await chrome.storage.local.set({ [TemuIngestQueue.QUEUE_KEY]: list });
    await chrome.storage.local.remove(TemuIngestQueue.LEGACY_KEY);
    await schedulePendingIngestAlarm(list);
    return list;
}

async function loadIngestOutcomes() {
    const stored = await chrome.storage.local.get(TemuIngestQueue.OUTCOME_KEY);
    return Array.isArray(stored[TemuIngestQueue.OUTCOME_KEY]) ? stored[TemuIngestQueue.OUTCOME_KEY] : [];
}

async function saveIngestOutcomes(outcomes) {
    const list = Array.isArray(outcomes) ? outcomes : [];
    await chrome.storage.local.set({ [TemuIngestQueue.OUTCOME_KEY]: list });
    return list;
}

/**
 * 任务离开队列时必须立刻写成终态。alarm 成功、永久失败、重试耗尽和队列溢出
 * 都会删掉任务，页面只能靠 fingerprint 找回自己的结果。
 */
async function recordIngestOutcome(incoming) {
    const outcomes = await loadIngestOutcomes();
    return saveIngestOutcomes(TemuIngestQueue.upsertOutcome(outcomes, incoming));
}

async function enqueueIngestJob(job) {
    return withIngestStore(async () => {
        const jobs = await loadPendingIngestJobs();
        const result = TemuIngestQueue.upsertJobWithEviction(jobs, job);
        // 第 11 个任务会挤掉最早的失败任务；必须写成 error 终态，不能静默消失。
        for (const evicted of result.evicted) {
            await recordIngestOutcome({
                fingerprint: evicted.fingerprint,
                jobId: evicted.id,
                status: "error",
                error: "queue_overflow",
                reason: "queue_overflow"
            });
        }
        return savePendingIngestJobs(result.jobs);
    });
}

/**
 * MV3 service worker 可能在网络失败后立刻休眠。必须用 alarms 按退避时间再唤醒，
 * 不能指望“启动时再试一次”覆盖全部重试。
 */
async function schedulePendingIngestAlarm(jobs) {
    if (!chrome.alarms || typeof chrome.alarms.clear !== "function") return;
    const due = TemuIngestQueue.nextDueJob(jobs);
    const wakeAt = TemuIngestQueue.nextWakeAt(jobs);
    await chrome.alarms.clear(TemuIngestQueue.ALARM_NAME);
    if (due) {
        chrome.alarms.create(TemuIngestQueue.ALARM_NAME, { delayInMinutes: 0.2 });
        return;
    }
    if (wakeAt) {
        const delayMinutes = Math.max(0.2, (wakeAt - Date.now()) / 60000);
        chrome.alarms.create(TemuIngestQueue.ALARM_NAME, { delayInMinutes: delayMinutes });
    }
}

function ingestQueueStatus(jobs = [], extra = {}) {
    const summary = TemuIngestQueue.summarizeQueue(jobs);
    const fingerprint = String(extra.fingerprint || "");
    const mine = fingerprint ? (Array.isArray(jobs) ? jobs : []).find(job => job && job.fingerprint === fingerprint) : null;
    const nextJob = mine || summary.nextJob;
    const outcome = extra.outcome && typeof extra.outcome === "object" ? extra.outcome : null;
    return {
        pendingCount: summary.pendingCount,
        fingerprint,
        currentPending: Boolean(mine),
        nextAttemptAt: nextJob && nextJob.nextAttemptAt || "",
        lastError: nextJob && nextJob.lastError || (outcome && outcome.error) || "",
        attempts: nextJob ? Number(nextJob.attempts) || 0 : 0,
        maxAttempts: TemuIngestQueue.MAX_ATTEMPTS,
        outcome: outcome ? {
            fingerprint: String(outcome.fingerprint || ""),
            jobId: String(outcome.jobId || ""),
            status: String(outcome.status || ""),
            error: String(outcome.error || ""),
            batchId: String(outcome.batchId || ""),
            reused: Boolean(outcome.reused),
            reason: String(outcome.reason || ""),
            finishedAt: String(outcome.finishedAt || "")
        } : null
    };
}

async function ingestQueueStatusFor(fingerprint, jobs) {
    const list = Array.isArray(jobs) ? jobs : await loadPendingIngestJobs();
    const outcomes = await loadIngestOutcomes();
    return ingestQueueStatus(list, {
        fingerprint,
        outcome: TemuIngestQueue.findOutcome(outcomes, fingerprint)
    });
}

async function runPendingIngest() {
    const prepared = await withIngestStore(async () => {
        const jobs = await loadPendingIngestJobs();
        const job = TemuIngestQueue.nextDueJob(jobs);
        if (!job) {
            await schedulePendingIngestAlarm(jobs);
            return { skipped: true, reason: "no_pending_ingest", queue: await ingestQueueStatusFor("", jobs), fingerprint: "" };
        }
        if (!TemuIngestQueue.isUsableJob(job)) {
            const remaining = await savePendingIngestJobs(TemuIngestQueue.removeJob(jobs, job.id));
            await recordIngestOutcome({
                fingerprint: job.fingerprint,
                jobId: job.id,
                status: "error",
                error: "no_current_page_spu",
                reason: "no_current_page_spu"
            });
            return { skipped: true, reason: "no_current_page_spu", queue: await ingestQueueStatusFor(job.fingerprint, remaining), fingerprint: job.fingerprint };
        }
        return { job };
    });
    if (!prepared.job) return prepared;
    const job = prepared.job;
    try {
        const result = await pushFullPacket({ eventIds: job.eventIds, allowedSpuIds: job.allowedSpuIds });
        return withIngestStore(async () => {
            const jobs = await loadPendingIngestJobs();
            // 空包和无商品不能写成成功。没有批次号也没有复用回执时，只能记阻断/错误终态。
            const remaining = await savePendingIngestJobs(TemuIngestQueue.removeJob(jobs, job.id));
            const outcome = TemuIngestQueue.outcomeStatusFromPushResult(result);
            await recordIngestOutcome({
                fingerprint: job.fingerprint,
                jobId: job.id,
                status: outcome.status,
                error: outcome.error,
                batchId: outcome.batchId,
                reused: outcome.reused,
                reason: outcome.reason
            });
            return { ...result, queue: await ingestQueueStatusFor(job.fingerprint, remaining), fingerprint: job.fingerprint, jobId: job.id };
        });
    } catch (error) {
        const code = String(error && error.message ? error.message : error);
        const remaining = await withIngestStore(async () => {
            const jobs = await loadPendingIngestJobs();
            // 缺令牌或未授权不会因为重试变好，继续排队只会在后台反复失败。
            if (PERMANENT_INGEST_ERRORS.has(code) || job.attempts + 1 >= TemuIngestQueue.MAX_ATTEMPTS) {
                const next = await savePendingIngestJobs(TemuIngestQueue.removeJob(jobs, job.id));
                await recordIngestOutcome({
                    fingerprint: job.fingerprint,
                    jobId: job.id,
                    status: "error",
                    error: code,
                    reason: PERMANENT_INGEST_ERRORS.has(code) ? "permanent_error" : "retry_exhausted"
                });
                return next;
            }
            return savePendingIngestJobs(TemuIngestQueue.upsertJob(jobs, TemuIngestQueue.markRetry(job, code)));
        });
        error.queue = await ingestQueueStatusFor(job.fingerprint, remaining);
        error.fingerprint = job.fingerprint;
        error.jobId = job.id;
        throw error;
    }
}

/** 队列读写必须串行，避免入库推送过程中新任务被后一次 load/save 覆盖。 */
function withIngestStore(executor) {
    const run = ingestStoreQueue.then(executor);
    ingestStoreQueue = run.catch(() => {});
    return run;
}

function enqueuePendingIngest() {
    const run = pendingIngestQueue.then(() => runPendingIngest());
    pendingIngestQueue = run.catch(() => {});
    return run;
}

const BOUND_STORE_KEY = "boundStoreV1";
const PLUGIN_INSTANCE_KEY = "pluginInstanceIdV1";
const TARGET_UPLOAD_TASKS_KEY = "targetUploadTasksV1";
const MAX_TARGET_UPLOAD_TASKS = 30;
const MAX_TARGET_UPLOAD_TASKS_BYTES = 4 * 1024 * 1024;

/** 目标店任务只保存在扩展后台；同一浏览器下按 targetStoreId 分区，页面脚本永远拿不到完整商品包。 */
async function getTargetUploadTasks() {
    const stored = await chrome.storage.local.get(TARGET_UPLOAD_TASKS_KEY);
    return Array.isArray(stored[TARGET_UPLOAD_TASKS_KEY]) ? stored[TARGET_UPLOAD_TASKS_KEY] : [];
}

/** 页面面板初始化时主动完成一次云仓注册；不需要用户打开设置或手动粘贴令牌。 */
async function ensureIngestConnection() {
    const settings = await bootstrapIngestToken(await getIngestSettings(), false);
    return { settings, connected: Boolean(settings.token) };
}

/** 扩展后台任务存储的单写者队列；失败不阻断后续同步。 */
let targetTaskMutation = Promise.resolve();
function withTargetTaskMutation(action) {
    const next = targetTaskMutation.then(action);
    targetTaskMutation = next.catch(() => {});
    return next;
}

/** 向页面面板只返回任务摘要；完整商品快照和领取凭证始终留在扩展后台私有存储。 */
function summarizeTargetUploadTasks(tasks, storeId = "") {
    const expectedStoreId = String(storeId || "").trim();
    return (Array.isArray(tasks) ? tasks : [])
        .filter(task => !expectedStoreId || String(task.targetStoreId || "") === expectedStoreId)
        .map(task => ({
            jobId: String(task.jobId || ""),
            spuId: String(task.spuId || ""),
            title: String(task.title || ""),
            targetStoreId: String(task.targetStoreId || ""),
            sourceStoreId: String(task.sourceStoreId || ""),
            sourceBatchId: String(task.sourceBatchId || ""),
            status: String(task.status || "received"),
            directCreate: Boolean(task.directCreate),
            directState: String(task.directState || ""),
            reason: String(task.reason || ""),
            receivedAt: String(task.receivedAt || ""),
            uploadOpenedAt: String(task.uploadOpenedAt || "")
        }));
}

async function saveTargetUploadTasks(tasks) {
    const deduped = [];
    const seen = new Set();
    for (const task of (Array.isArray(tasks) ? tasks : [])) {
        const key = `${String(task && task.jobId || "")}::${String(task && task.spuId || "")}`;
        if (!key || key === "::" || seen.has(key)) continue;
        seen.add(key);
        deduped.push(task);
    }
    // 一个扩展安装可能在紫鸟中切换多家店。容量按目标店分区，A 店历史待办不能挤占 B 店领取槽位；
    // 浏览器总配额异常时整次写入会失败并保留旧数据，本业务仍为每店保留 30 条、4MB 的明确上限。
    const buckets = new Map();
    for (const task of deduped) {
        const storeId = String(task && task.targetStoreId || "").trim();
        if (!storeId) throw new Error("target_upload_task_missing_store");
        const bucket = buckets.get(storeId) || [];
        bucket.push(task);
        buckets.set(storeId, bucket);
    }
    for (const bucket of buckets.values()) {
        if (bucket.length > MAX_TARGET_UPLOAD_TASKS) throw new Error("target_upload_task_capacity_reached");
        if (getUtf8ByteLength(JSON.stringify(bucket)) > MAX_TARGET_UPLOAD_TASKS_BYTES) throw new Error("target_upload_tasks_too_large");
    }
    await chrome.storage.local.set({ [TARGET_UPLOAD_TASKS_KEY]: deduped });
    return deduped;
}

/** 领取响应后立即落盘，避免目标店切换到商品新建页时丢失快照。 */
async function receiveTargetUploadTasks(claimed = [], expectedStoreId = "") {
    const current = await getTargetUploadTasks();
    const incoming = (Array.isArray(claimed) ? claimed : []).filter(item => item && item.jobId && item.spuId && item.snapshot).map(item => ({
        jobId: String(item.jobId),
        spuId: String(item.spuId),
        title: String(item.title || ""),
        claimToken: String(item.claimToken || ""),
        sourceStoreId: String(item.sourceStoreId || ""),
        targetStoreId: String(item.targetStoreId || ""),
        sourceBatchId: String(item.sourceBatchId || ""),
        snapshot: item.snapshot,
        directCreate: Boolean(item.directCreate),
        status: "received",
        receivedAt: new Date().toISOString(),
        uploadOpenedAt: "",
        directRetrySequence: Math.max(0, Number(item.directRetrySequence || 0))
    }));
    const existingKeys = new Set(current.map(task => `${task.jobId}::${task.spuId}`));
    const newTasks = incoming.filter(task => !existingKeys.has(`${task.jobId}::${task.spuId}`));
    const targetStoreIds = new Set(incoming.map(task => String(task.targetStoreId || "").trim()));
    // 一次领取只能属于一个目标店；混店响应即使服务端异常也不能污染本地分区。
    if (targetStoreIds.size > 1 || targetStoreIds.has("")) throw new Error("target_upload_task_store_mismatch");
    const targetStoreId = targetStoreIds.values().next().value || "";
    if (targetStoreId && expectedStoreId && targetStoreId !== String(expectedStoreId)) throw new Error("target_upload_task_store_mismatch");
    const existingForTarget = targetStoreId
        ? current.filter(task => String(task.targetStoreId || "") === targetStoreId)
        : [];
    // 已经落盘的同一领取可安全重试；真正的新任务必须在所属店铺内整批通过预检，不能只保存前半批。
    if (existingForTarget.length + newTasks.length > MAX_TARGET_UPLOAD_TASKS) throw new Error("target_upload_task_capacity_reached");
    // 租约重领会更换凭证；保留快照但更新同店同任务凭证，避免永久使用过期令牌。
    const resetAttemptKeys = [];
    const next = [...current.map(task => {
        const renewed=incoming.find(item=>item.jobId===task.jobId&&item.spuId===task.spuId&&item.targetStoreId===task.targetStoreId);
        if(!renewed)return task;
        const retrySequence=Math.max(0,Number(renewed.directRetrySequence||0));
        // 网站人工确认重试后服务端会递增 directRetrySequence。本地残留的 unknown 与旧 attempt 记录会
        // 一直被插件自身的隔离规则挡住，必须按代次清掉，否则重新领取的任务永远不会再次提交。
        if(retrySequence>Math.max(0,Number(task.directRetrySequence||0))){
            resetAttemptKeys.push(`directAttempt:${task.jobId}:${task.spuId}`);
            return {...task,claimToken:renewed.claimToken,directRetrySequence:retrySequence,directState:"",status:"received",reason:"已人工确认重试，插件重新开始对比与预检"};
        }
        return {...task,claimToken:renewed.claimToken,directRetrySequence:Math.max(retrySequence,Math.max(0,Number(task.directRetrySequence||0)))};
    }), ...newTasks];
    if(resetAttemptKeys.length)await chrome.storage.local.remove(resetAttemptKeys);
    if (targetStoreId && getUtf8ByteLength(JSON.stringify([...existingForTarget, ...newTasks])) > MAX_TARGET_UPLOAD_TASKS_BYTES) throw new Error("target_upload_tasks_too_large");
    return saveTargetUploadTasks(next);
}

/** 接口创建进度只改本店任务摘要，不覆盖完整快照和领取凭证。 */
async function updateDirectTaskProgress(storeId, jobId, spuId, patch = {}) {
    return withTargetTaskMutation(async () => {
        const tasks = await getTargetUploadTasks();
        const expectedStoreId = String(storeId || "").trim();
        const next = tasks.map((task) => {
            if (String(task.jobId) !== String(jobId || "") || String(task.spuId) !== String(spuId || "")) return task;
            if (expectedStoreId && String(task.targetStoreId || "") !== expectedStoreId) return task;
            return {
                ...task,
                directState: String(patch.directState || task.directState || ""),
                reason: String(patch.reason || task.reason || ""),
                status: String(patch.status || task.status || "received")
            };
        });
        await saveTargetUploadTasks(next);
        return summarizeTargetUploadTasks(next, expectedStoreId);
    });
}

/** 人工确认后的唯一重试入口：清理本地旧 attempt 并把该商品排到当前店铺队列末尾，绝不由心跳自动触发。 */
async function retryDirectTask(sender, input = {}) {
    const identity = await directIdentity(sender, input.identity || {});
    const storeId = String(identity.storeId || '').trim();
    const jobId = String(input.jobId || '').trim();
    const spuId = String(input.spuId || '').trim();
    if (!storeId || !jobId || !spuId) throw new Error('人工重试缺少任务标识');
    const tasks = await getTargetUploadTasks();
    const task = tasks.find(item => String(item.jobId) === jobId && String(item.spuId) === spuId && String(item.targetStoreId) === storeId);
    if (!task) throw new Error('本地找不到待重试任务');
    if (!['unknown', 'preflight_failed', 'rejected'].includes(String(task.directState || ''))) throw new Error('当前任务不是可人工重试状态');
    // 服务端必须先原子关闭旧 attempt；插件不能仅凭本地状态解锁，否则刷新或多标签会重新产生创建尝试。
    const serverRetry = await hubJson('/api/jobs/direct-retry', {
        storeId,
        jobId,
        spuId,
        confirmed: true
    });
    if (!serverRetry?.ok && serverRetry?.state !== 'queued_for_retry') throw new Error(serverRetry?.error || '服务器未确认人工重试');
    const key = `directAttempt:${jobId}:${spuId}`;
    // 删除旧 attempt 后再置回队尾；未知结果仍需操作者先确认目标店没有相同货号。
    await chrome.storage.local.remove(key);
    await updateDirectTaskProgress(storeId, jobId, spuId, { directState: 'received', reason: '已人工确认重试，已排到上传队列末尾', status: 'received' });
    const reordered = (await getTargetUploadTasks()).filter(item => !(String(item.jobId) === jobId && String(item.spuId) === spuId && String(item.targetStoreId) === storeId));
    reordered.push(task);
    await saveTargetUploadTasks(reordered);
    await TemuOperationLog.append({ action: 'direct-create', status: 'started', phase: 'manual_retry_queued', storeId, jobId, spuId, reason: '操作者确认后重新排队，旧 attempt 已结束' });
    const canRun = Boolean(sender.tab?.id && /^https:\/\/agentseller\.temu\.com\/goods\/list(?:[?#]|$)/i.test(sender.tab.url || ''));
    if (canRun && !(await readDirectPause(storeId))) {
        runDirectTasks(sender.tab.id, identity).catch(error => TemuOperationLog.append({ action: 'direct-create', status: 'failed', phase: 'manual_retry', storeId, jobId, spuId, error: directBackgroundErrorText(error) }));
    }
    return { ok: true, queued: true, task: summarizeTargetUploadTasks(await getTargetUploadTasks(), storeId).find(item => item.jobId === jobId && item.spuId === spuId) };
}

/** 创建进度推给当前列表页；页面关闭时只保留后台任务状态，不阻断创建。 */
async function notifyDirectCreateProgress(tabId, payload = {}) {
    if (!tabId) return;
    try {
        await chrome.tabs.sendMessage(tabId, { type: "directCreateProgress", task: payload });
    } catch {
        /* 列表页已关闭时仍以后台任务状态为准。 */
    }
}

/**
 * 网页取消或服务端失败后，目标店不会再收到主动推送。插件随心跳核对最小状态并释放无效快照，
 * 只传 jobId/SPU，不把完整商品资料或领取凭证返回到页面。
 */
async function reconcileTargetUploadTasks(identity = {}) {
    const tasks = await getTargetUploadTasks();
    if (!tasks.length) return tasks;
    const storeId = String(identity.storeId || "").trim();
    if (!storeId) return tasks;
    // 扩展存储在同一浏览器配置内共享；只核对当前目标店的任务，不能因切店把别家待办误删。
    const scopedTasks = tasks.filter(task => String(task.targetStoreId || "") === storeId);
    if (!scopedTasks.length) return tasks;
    const result = await hubJson("/api/jobs/target-task-states", {
        storeId,
        pluginInstanceId: await getPluginInstanceId(),
        tasks: scopedTasks.map(task => ({ jobId: task.jobId, spuId: task.spuId }))
    });
    const terminalKeys = new Set((Array.isArray(result.tasks) ? result.tasks : [])
        .filter(task => ["cancelled", "failed", "identity_mismatch", "blocked", "uploaded"].includes(String(task.status || "")))
        .map(task => `${task.jobId}::${task.spuId}`));
    if (!terminalKeys.size) return tasks;
    return saveTargetUploadTasks(tasks.filter(task => !terminalKeys.has(`${task.jobId}::${task.spuId}`)));
}

async function reportTargetUploadTask(payload = {}) {
    const tasks = await getTargetUploadTasks();
    const task = tasks.find(item => String(item.jobId) === String(payload.jobId || "") && String(item.spuId) === String(payload.spuId || ""));
    if (!task) throw new Error("target_task_not_found");
    // 接口任务的结果只能由连接器回查平台后写入，不能用人工完成按钮伪装成功。
    if (task.directCreate && payload.status !== "received") throw new Error("接口任务由目标插件自动处理，请在网站工作日志查看结果；不要打开表单或重复提交");
    // 同一浏览器配置会共享扩展存储。页面只能操作当前目标店的待办，不能借 jobId 触碰另一店的商品快照。
    if (!payload.storeId || String(task.targetStoreId || "") !== String(payload.storeId)) throw new Error("target_task_store_mismatch");
    // CLI 在线时只记录操作者意图；必须等工人向服务端核验并签名回传后，才允许打开商品页。
    const cliState = await chrome.storage.local.get("cliConnectedAt");
    if (["upload_opened", "uploaded"].includes(payload.status) && Date.now() - Number(cliState.cliConnectedAt || 0) < 120000) {
        if (!payload.identityMatched || !boundMatchesPage(await getBoundStore(), payload.pageStoreName)) throw new Error("target_task_identity_mismatch");
        if (payload.status === "uploaded") {
            if (task.status !== "upload_opened") throw new Error("target_task_not_opened");
            // 这里只记录用户确认，不冒充平台发布成功；网站收到后保留人工确认语义。
            task.completionRequested = true;
            await saveTargetUploadTasks(tasks);
            return { pending: true, tasks: summarizeTargetUploadTasks(tasks, payload.storeId) };
        }
        if (task.status !== "upload_opened") {
            task.openRequested = true;
            await saveTargetUploadTasks(tasks);
            return { pending: true, tasks: summarizeTargetUploadTasks(tasks, payload.storeId) };
        }
        return { tasks: summarizeTargetUploadTasks(tasks, payload.storeId) };
    }
    const result = await reportStoreJob({ ...payload, claimToken: task.claimToken, pluginDetected: true, pluginVersion: chrome.runtime.getManifest().version });
    if (["uploaded", "failed", "cancelled", "identity_mismatch"].includes(payload.status)) {
        // 服务端已结束或否决的任务不应长期占用目标店本地容量；取消任务同样由下一次状态回传清理。
        await saveTargetUploadTasks(tasks.filter(item => item !== task));
    } else {
        task.status = String(payload.status || task.status);
        if (payload.status === "upload_opened") task.uploadOpenedAt = new Date().toISOString();
        await saveTargetUploadTasks(tasks);
    }
    return { result, tasks: summarizeTargetUploadTasks(await getTargetUploadTasks(), payload.storeId) };
}

/** 目标店可在新建商品页下载仅含当前商品资料的副本，便于人工核对 SKU、图片与详情而不暴露领取凭证。 */
async function downloadTargetUploadTask(input = {}) {
    const tasks = await getTargetUploadTasks();
    const task = tasks.find(item => String(item.jobId) === String(input.jobId || "") && String(item.spuId) === String(input.spuId || ""));
    if (!task) throw new Error("target_task_not_found");
    // 导出包含完整商品资料，必须以当前已核验的目标店作为二次边界，不能只凭页面传入的任务主键。
    if (!input.storeId || String(task.targetStoreId || "") !== String(input.storeId)) throw new Error("target_task_store_mismatch");
    const packet = {
        kind: "target-upload-task",
        exportedAt: new Date().toISOString(),
        sourceStoreId: task.sourceStoreId,
        targetStoreId: task.targetStoreId,
        sourceBatchId: task.sourceBatchId,
        product: task.snapshot
    };
    const text = JSON.stringify(packet, null, 2);
    const bytes = getUtf8ByteLength(text);
    if (bytes > MAX_TARGET_UPLOAD_TASKS_BYTES) throw new Error("target_upload_task_too_large");
    const downloadId = await chrome.downloads.download({
        url: makeDataUrl(text),
        filename: `temu-target-upload/SPU-${String(task.spuId).replace(/[^0-9A-Za-z_-]/g, "_")}.json`,
        saveAs: false,
        conflictAction: "uniquify"
    });
    return { exported: true, downloadId, bytes };
}

function hubApiUrl(endpoint, pathname) {
    return TemuIngestEndpoint.apiUrl(endpoint, pathname);
}

/**
 * 每个扩展安装生成一次实例 ID。紫鸟工人用它把窗口和中转仓 Agent 对上，
 * 不能用 Temu 商品 ID 或人工填写的店铺 ID 代替。
 */
async function getPluginInstanceId() {
    const stored = await chrome.storage.local.get(PLUGIN_INSTANCE_KEY);
    const existing = String(stored[PLUGIN_INSTANCE_KEY] || "").trim();
    if (existing) return existing;
    const created = (globalThis.crypto && typeof crypto.randomUUID === "function")
        ? crypto.randomUUID()
        : `plugin-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
    await chrome.storage.local.set({ [PLUGIN_INSTANCE_KEY]: created });
    return created;
}

async function getBoundStore() {
    const stored = await chrome.storage.local.get(BOUND_STORE_KEY);
    const value = stored[BOUND_STORE_KEY] && typeof stored[BOUND_STORE_KEY] === "object" ? stored[BOUND_STORE_KEY] : {};
    return {
        storeId: String(value.storeId || "").trim(),
        storeName: String(value.storeName || "").trim()
    };
}

/**
 * 采集包优先带上工人已映射的紫鸟店铺；没有映射时至少带上插件实例和页面店名，
 * 由中转仓按 pluginInstanceId 回填来源店，禁止用商品 SPU 冒充店铺 ID。
 */
function boundMatchesPage(bound, pageStoreName) {
    const helper = typeof TemuStoreIdentity !== "undefined" ? TemuStoreIdentity : null;
    return Boolean(bound && bound.storeId && bound.storeName && pageStoreName && helper && (
        helper.namesMatch(pageStoreName, bound.storeName)
        || (helper.namesCompatible && helper.namesCompatible(pageStoreName, bound.storeName))
    ));
}

async function packetSourceOptions(extra = {}) {
    const bound = await getBoundStore();
    const pluginInstanceId = await getPluginInstanceId();
    const pageStoreName = extra.pageStoreName || lastPageIdentity.pageStoreName || extra.shopName || "";
    const usableBound = boundMatchesPage(bound, pageStoreName) ? bound : { storeId: "", storeName: "" };
    return {
        ...extra,
        sourceStoreId: extra.sourceStoreId || usableBound.storeId,
        sourceStoreName: extra.sourceStoreName || usableBound.storeName || pageStoreName,
        shopName: extra.shopName || pageStoreName || usableBound.storeName,
        pluginInstanceId,
        pageStoreName
    };
}

async function saveBoundStore(input = {}) {
    const next = {
        storeId: String(input.storeId || "").trim(),
        storeName: String(input.storeName || "").trim()
    };
    await chrome.storage.local.set({ [BOUND_STORE_KEY]: next });
    return next;
}

/**
 * 目标店插件访问中转仓任务接口。必须带直推令牌，并且用页面读到的店铺身份，不能把任务发给所有插件。
 */
async function hubJson(pathname, body) {
    const settings = await bootstrapIngestToken(await getIngestSettings(), true);
    const allowed = await ensureIngestPermission(settings.endpoint);
    if (!allowed) throw new Error("ingest_permission_denied");
    if (!settings.token) throw new Error("missing_ingest_token");
    // 云端失联不能一直占住插件同步流程；超时仅终止等待，不重试任何写请求。
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
    const response = await authenticatedIngestFetch(hubApiUrl(settings.endpoint, pathname), settings, {
        signal: controller.signal,
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(body || {})
    });
    // 正文超时或损坏不能当作成功确认，否则领取状态会与服务端分离。
    const raw = await response.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {
        throw new Error(`hub_http_${response.status}_${String(raw).slice(0,120) || "invalid_response"}`);
    }
    if (!response.ok) throw new Error(directBackgroundErrorText(data.error) || `hub_http_${response.status}`);
    return data;
    } finally {
        clearTimeout(timeout);
    }
}

/** 中转仓返回的 error 可能是字符串或对象；把对象直接丢给 Error 只会得到 "[object Object]"。 */
function directBackgroundErrorText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (typeof value !== "object") return String(value);
    for (const key of ["message", "msg", "errorMsg", "error", "reason", "detail"]) {
        const text = directBackgroundErrorText(value[key]);
        if (text) return text;
    }
    try { return JSON.stringify(value) || ""; } catch (_) { return ""; }
}

let lastPageIdentity = { pageStoreName: "", pageUrl: "", pageType: "" };

async function rememberPageIdentity(identity = {}) {
    lastPageIdentity = {
        pageStoreName: String(identity.pageStoreName || lastPageIdentity.pageStoreName || "").trim(),
        pageUrl: String(identity.pageUrl || lastPageIdentity.pageUrl || "").trim(),
        pageType: String(identity.pageType || lastPageIdentity.pageType || "").trim()
    };
    return lastPageIdentity;
}

async function registerStoreAgent(identity = {}) {
    // 商城身份来自后台固定页面读取；同步本机来源归属，避免继续使用旧CLI账号绑定。
    if(identity.executionMode === "plugin-api") {
        identity.storeName=identity.pageStoreName || `商城 ${identity.mallId}`;
        await chrome.storage.local.set({[BOUND_STORE_KEY]:{storeId:identity.storeId,storeName:identity.storeName}});
    }
    const bound = await getBoundStore();
    const pluginInstanceId = await getPluginInstanceId();
    const usableBound = boundMatchesPage(bound, identity.pageStoreName || identity.storeName) ? bound : { storeId: "", storeName: "" };
    const storeId = String(identity.storeId || usableBound.storeId || "").trim();
    await rememberPageIdentity(identity);
    return hubJson("/api/agents/register", {
        pluginInstanceId,
        storeId,
        storeName: identity.storeName || usableBound.storeName || identity.pageStoreName || "",
        pageUrl: identity.pageUrl || "",
        pluginVersion: chrome.runtime.getManifest().version,
        pluginDetected: true,
        identityMatched: identity.identityMatched === true,
        pageStoreName: identity.pageStoreName || "",
        pageType: identity.pageType || "",
        nameSource: identity.source || "",
        nameConfidence: identity.confidence || "",
        expectedCount: Number.isInteger(identity.expectedCount) ? identity.expectedCount : null,
        completedCount: Number.isInteger(identity.completedCount) ? identity.completedCount : null,
        capturePhase: identity.capturePhase || "",
        ingestPhase: identity.ingestPhase || "",
        source: identity.sourceTag || "plugin-heartbeat"
        ,mallId: identity.mallId || "", executionMode: identity.executionMode || ""
    });
}

async function claimStoreJobs(identity = {}) {
    const bound = await getBoundStore();
    const usableBound = boundMatchesPage(bound, identity.pageStoreName || identity.storeName) ? bound : { storeId: "", storeName: "" };
    const storeId = String(identity.storeId || usableBound.storeId || "").trim();
    if (!storeId) throw new Error("missing_mapped_store");
    const pendingTasks = (await getTargetUploadTasks()).filter(task => String(task.targetStoreId || "") === storeId);
    const pendingUploadBytes = getUtf8ByteLength(JSON.stringify(pendingTasks));
    const result = await hubJson("/api/jobs/claim", {
        storeId,
        storeName: identity.storeName || usableBound.storeName || "",
        pageUrl: identity.pageUrl || "",
        pluginVersion: chrome.runtime.getManifest().version,
        pluginDetected: true,
        identityMatched: identity.identityMatched === true,
        pageStoreName: identity.pageStoreName || "",
        pluginInstanceId: await getPluginInstanceId(),
        // 服务端按扩展剩余任务槽位分批领取，避免超过本地 30 条硬上限后整批落盘失败。
        pendingUploadCount: pendingTasks.length,
        pendingUploadBytes,
        source: "plugin-content"
        ,executionMode: identity.executionMode || "", mallId: identity.mallId || ""
    });
    const claimed = Array.isArray(result && result.claimed) ? result.claimed : [];
    const manualJobs = claimed.filter(job => job && job.mode === "manual-plugin-upload");
    const legacyJobs = claimed.filter(job => !job || job.mode !== "manual-plugin-upload");
    if (manualJobs.length) {
        // 完整快照和领取凭证在后台完成落盘、回传，content script 只会拿到无敏感字段的任务摘要。
        await receiveTargetUploadTasks(manualJobs, storeId);
        for (const job of manualJobs) {
            await reportTargetUploadTask({
                jobId: job.jobId,
                spuId: job.spuId,
                storeId,
                status: "received",
                pageUrl: identity.pageUrl || "",
                pageStoreName: identity.pageStoreName || "",
                identityMatched: identity.identityMatched === true,
                reason: job.directCreate ? "目标插件已通过API接收商品快照，正在排队进行接口预检" : "目标插件已接收历史手动任务，等待操作者处理"
            });
        }
    }
    for (const job of legacyJobs) {
        // 历史核验任务同样由后台保管领取凭证，避免页面脚本读取令牌后再代为回传。
        await reportStoreJob({
            jobId: job.jobId,
            spuId: job.spuId,
            storeId,
            status: "identity_verified",
            pageUrl: identity.pageUrl || "",
            claimToken: job.claimToken || "",
            pageStoreName: identity.pageStoreName || "",
            pluginDetected: true,
            pluginVersion: chrome.runtime.getManifest().version,
            identityMatched: identity.identityMatched === true,
            reason: "页面店铺身份已核验，历史任务未执行上传"
        });
    }
    // 给页面的领取结果仅用于显示状态，不能包含 snapshot 或 claimToken。
    return {
        ...result,
        claimed: claimed.map(job => ({
            jobId: String(job && job.jobId || ""),
            spuId: String(job && job.spuId || ""),
            title: String(job && job.title || ""),
            mode: String(job && job.mode || "")
        })),
        receivedCount: manualJobs.length,
        // 面板据此显示“已停止接口创建”，不再依赖操作者展开工具区才发现自动创建已被关掉。
        directPaused: Boolean(await readDirectPause(storeId)),
        tasks: summarizeTargetUploadTasks(await getTargetUploadTasks(), storeId)
    };
}

/**
 * 面板“停止/继续接口创建”：停止需要落盘并让正在跑的那一轮在安全点收手；
 * 继续由后台立即补跑一次，避免操作者恢复后还要等下一次心跳才看到动作。
 */
async function setDirectCreatePaused(sender, identity = {}, paused = false) {
    const resolved = await directIdentity(sender, identity);
    const storeId = String(resolved.storeId || "").trim();
    // 停止标记先落盘：这一步之后即使插件被刷新或后台被回收，刷新页面也不会重新开始上传。
    const value = await writeDirectPause(storeId, paused, paused ? "操作者点击停止接口创建" : "");
    await TemuOperationLog.append({
        action: "direct-create",
        status: paused ? "skipped" : "started",
        phase: paused ? "stopped" : "resumed",
        storeId,
        reason: paused
            ? "操作者已停止接口创建：不再发起新的提交，已在读取中的预检会自行结束且不会提交，刷新页面也不会自动恢复"
            : "操作者已恢复接口创建：继续处理本店剩余任务"
    });
    if (!paused) {
        const canRunDirect = Boolean(sender.tab?.id && /^https:\/\/agentseller\.temu\.com\/goods\/list(?:[?#]|$)/i.test(sender.tab.url || ''));
        const pendingDirect = (await getTargetUploadTasks()).some(task => task.directCreate && task.targetStoreId === storeId
            && task.directState !== "created" && task.directState !== "duplicate_exists");
        if (pendingDirect && canRunDirect) {
            runDirectTasks(sender.tab.id, resolved).catch(error => {
                TemuOperationLog.append({ action: "direct-create", status: "failed", error: directBackgroundErrorText(error) || String(error?.message || error || ""), storeId }).catch(() => {});
            });
        }
    }
    return { paused: Boolean(value), storeId, tasks: summarizeTargetUploadTasks(await getTargetUploadTasks(), storeId) };
}

async function reportStoreJob(payload = {}) {
    const bound = await getBoundStore();
    // 回传任务时同样忽略店名对不上的 10.0.x 残留绑定，避免把 A 店核验写到 B 店。
    const usableBound = boundMatchesPage(bound, payload.pageStoreName || lastPageIdentity.pageStoreName) ? bound : { storeId: "", storeName: "" };
    const storeId = String(payload.storeId || usableBound.storeId || "").trim();
    if (!storeId) throw new Error("missing_mapped_store");
    return hubJson("/api/jobs/report", {
        ...payload,
        storeId,
        // 页面端漏传版本时由后台补齐扩展真实版本，防止兼容性守卫把当前插件误判为旧版。
        pluginVersion: String(payload.pluginVersion || chrome.runtime.getManifest().version),
        pluginDetected: payload.pluginDetected === true,
        // 后台签出扩展自身实例，服务端才能拒绝同店第二个插件窗口伪造的状态回传。
        pluginInstanceId: await getPluginInstanceId()
    });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;
    const handler = async () => {
        // 内容脚本仅转交签名资料，不暴露任意后台方法或仓库令牌给网页。
        if (message.type === "receiveCliTask") {
            if (sender.id !== chrome.runtime.id || !sender.tab || new URL(sender.tab.url).hostname !== "agentseller.temu.com") throw new Error("unsupported_sender");
            return { receipt: await TemuCliReceiver.receive(message.envelope, { pageOrigin: new URL(sender.tab.url).origin, pageStoreName: String(message.pageStoreName || "") }) };
        }
        if (message.type === "recordOperation") {
            if (sender.id !== chrome.runtime.id || (sender.tab && !/^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(sender.tab.url || ""))) throw new Error("unsupported_sender");
            await TemuOperationLog.append({ ...message.entry, tabId: sender.tab?.id, pageUrl: sender.tab?.url || sender.url });
            return { logged: true };
        }
        if (message.type === "captureEvent") {
            try {
                if (!sender.tab || !/^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(sender.tab.url || "")) {
                    throw new Error("unsupported_sender");
                }
                if (!await isTabCaptureEnabled(sender.tab.id)) throw new Error("capture_not_enabled_for_tab");
                const result = await saveCapture(message.event, sender);
                // 详情补采页用事件指纹推进持久化队列；普通列表采集不改变该队列。
                if (result && (result.detailPage || result.productRelated || result.detailEvidence || result.category === "product-detail")) {
                    await withDetailQueue(sender.tab.id, () => noteDetailCapture(sender.tab.id, message.event, result));
                }
                // 在返回采集回执前等待日志队列完成，避免 MV3 后台在响应后休眠导致最后几条日志丢失。
                await appendCaptureLog(makeCaptureLog(message.event, sender, result, null));
                return result;
            } catch (error) {
                await appendCaptureLog(makeCaptureLog(message.event, sender, null, error));
                throw error;
            }
        }
        if (message.type === "captureSkip") {
            if (!sender.tab || !/^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(sender.tab.url || "")) {
                throw new Error("unsupported_sender");
            }
            if (!await isTabCaptureEnabled(sender.tab.id)) throw new Error("capture_not_enabled_for_tab");
            await appendCaptureLog(makeCaptureSkipLog(message.event, sender));
            return { logged: true };
        }
        if (message.type === "captureRun") {
            if (!sender.tab || !/^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(sender.tab.url || "")) {
                throw new Error("unsupported_sender");
            }
            await appendCaptureLog(makeCaptureRunLog(message.summary, sender));
            return { logged: true };
        }
        if (message.type === "captureSnapshot") {
            if (!sender.tab || !/^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(sender.tab.url || "")) {
                throw new Error("unsupported_sender");
            }
            await appendCaptureLog(makeCaptureSnapshotLog(message.summary, sender));
            return { logged: true };
        }
        if (message.type === "openStructure") {
            if (!sender.tab || !/^https?:\/\/(?:[^/]+\.)?(?:temu\.com|kuajingmaihuo\.com)(?:\/|$)/i.test(sender.tab.url || "")) {
                throw new Error("unsupported_sender");
            }
            const saved = await savePageDiagnostics(message.structure);
            await chrome.tabs.create({ url: chrome.runtime.getURL("structure.html"), active: true });
            return { opened: true, ...saved };
        }
        if (message.type === "getPageStructure") return { record: await getPageDiagnostics() };
        if (message.type === "getStats") return getStats();
        if (message.type === "openExport") {
            await chrome.tabs.create({ url: chrome.runtime.getURL("export.html"), active: true });
            return { opened: true };
        }
        if (message.type === "openSettings") {
            await chrome.tabs.create({ url: chrome.runtime.getURL("settings.html"), active: true });
            return { opened: true };
        }
        if (message.type === "openLogs") {
            await chrome.tabs.create({ url: chrome.runtime.getURL("logs.html"), active: true });
            return { opened: true };
        }
        // 接口诊断不要求普通采集开启，专供操作者复现一次列表/详情动作后导出字段结构。
        if (message.type === "startInterfaceDiagnostics") return { ok: true, diagnostics: await startInterfaceDiagnostics(sender) };
        if (message.type === "stopInterfaceDiagnostics") return { ok: true, diagnostics: await stopInterfaceDiagnostics(sender) };
        if (message.type === "getInterfaceDiagnosticsState") return { ok: true, diagnostics: await readInterfaceDiagnosticSession(sender.tab && sender.tab.id) };
        if (message.type === "captureInterfaceDiagnostic") return { ok: true, ...(await recordInterfaceDiagnostic(message, sender, false)) };
        if (message.type === "captureInterfaceDiagnosticSkip") return { ok: true, ...(await recordInterfaceDiagnostic(message, sender, true)) };
        if (message.type === "getInterfaceDiagnostics") return { ok: true, diagnostics: await getInterfaceDiagnostics(message.sessionId) };
        if (message.type === "clearInterfaceDiagnostics") return { ok: true, ...(await clearInterfaceDiagnostics(message.sessionId)) };
        if (message.type === "getCaptureLogs") return getCaptureLogs();
        if (message.type === "clearCaptureLogs") return clearCaptureLogs();
        if (message.type === "clearRecords") return clearRecords();
        if (message.type === "getIngestSettings") return { settings: await getIngestSettings() };
        if (message.type === "ensureIngestConnection") return ensureIngestConnection();
        if (message.type === "saveIngestSettings") return saveIngestSettings(message.settings, message.requestPermission === true);
        if (message.type === "testIngest") return testIngestConnection();
        if (message.type === "pushFullPacket") return pushFullPacket(message.options || {});
        if (message.type === "exportFullPacketToDownload") return exportFullPacketToDownload(message.options || {});
        if (message.type === "autoPushFullPacket") return maybeAutoPushFullPacket(message.context || {});
        if (message.type === "getIngestQueue") {
            const jobs = await loadPendingIngestJobs();
            await schedulePendingIngestAlarm(jobs);
            return { queue: await ingestQueueStatusFor(message.fingerprint, jobs) };
        }
        if (message.type === "beginDetailSupplement") return withDetailQueue(sender.tab?.id, () => beginDetailSupplement(message.input || {}, sender));
        if (message.type === "captureApiDetail") return withDetailQueue(sender.tab?.id, () => captureApiDetail(message.input || {}, sender));
        if (message.type === "advanceDetailSupplement") return withDetailQueue(sender.tab?.id, () => advanceDetailSupplement(message.input || {}, sender));
        if (message.type === "getDetailSupplement") return detailQueueView(await loadDetailQueue(sender.tab && sender.tab.id));
        if (message.type === "clearDetailSupplement") return withDetailQueue(sender.tab?.id, () => clearDetailSupplement(sender));
        if (message.type === "getBoundStore") return { store: await getBoundStore(), cliConnectedAt: Number((await chrome.storage.local.get("cliConnectedAt")).cliConnectedAt || 0) };
        // 完整资料只在当前目标店已获打开许可的新建页，响应操作者填写操作时释放给页面。
        if (message.type === "getTargetFormProduct") {
            const url = new URL(sender.tab?.url || "https://invalid/");
            const bound = await getBoundStore();
            if (sender.id !== chrome.runtime.id || url.origin !== "https://agentseller.temu.com" || url.pathname !== "/goods/edit" || !boundMatchesPage(bound, message.pageStoreName)) throw new Error("target_form_identity_mismatch");
            const task = (await getTargetUploadTasks()).find(item => item.jobId === message.jobId && item.spuId === message.spuId && item.targetStoreId === bound.storeId && item.status === "upload_opened");
            if (!task?.snapshot?.publicationData?.sourceProduct) throw new Error("target_form_product_missing");
            return { product: task.snapshot.publicationData.sourceProduct };
        }
        if (message.type === "getPluginInstanceId") return { pluginInstanceId: await getPluginInstanceId() };
        if (message.type === "saveBoundStore") return { store: await saveBoundStore(message.store || {}) };
        if (message.type === "receiveTargetUploadTasks") return { tasks: summarizeTargetUploadTasks(await receiveTargetUploadTasks(message.tasks || [], message.storeId), message.storeId) };
        if (message.type === "getTargetUploadTasks") return { tasks: summarizeTargetUploadTasks(await getTargetUploadTasks(), message.storeId), directPaused: Boolean(await readDirectPause(message.storeId)) };
        if (message.type === "reconcileTargetUploadTasks") return { tasks: summarizeTargetUploadTasks(await reconcileTargetUploadTasks(message.identity || {}), message.identity && message.identity.storeId), directPaused: Boolean(await readDirectPause(message.identity && message.identity.storeId)) };
        if (message.type === "reportTargetUploadTask") return reportTargetUploadTask(message.payload || {});
        if (message.type === "downloadTargetUploadTask") return downloadTargetUploadTask(message.input || {});
        if (message.type === "registerStoreAgent") return registerStoreAgent(await directIdentity(sender, message.identity || {}));
        if (message.type === "claimStoreJobs") {
            const identity=await directIdentity(sender,message.identity||{});
            const result=await claimStoreJobs(identity);
            // 刷新后即使本轮 claimed 为空，本地未完成的接口任务也必须自动继续，不能等人点击。
            // 唯一例外是 unknown：请求可能已被平台受理，自动继续会把它变成第二次创建，
            // 因此必须等人工确认重试（网站任务台或面板按钮），服务端会用 directRetrySequence 通知插件解除隔离。
            const pendingDirect=(result.tasks||[]).some((task)=>task.directCreate&&task.directState!=="created"&&task.directState!=="duplicate_exists");
            // 操作者点过“停止接口创建”后，自动继续必须让位：这正是运营用刷新页面也停不下来的原因。
            const directPaused=Boolean(result.directPaused);
            // 身份连接可在详情页提前完成，但接口预检/提交必须回到商品列表页；否则执行器会被页面路由拒绝。
            const canRunDirect = Boolean(sender.tab?.id && /^https:\/\/agentseller\.temu\.com\/goods\/list(?:[?#]|$)/i.test(sender.tab.url || ''));
            if(pendingDirect&&canRunDirect&&!directPaused){
                runDirectTasks(sender.tab.id,identity).catch((error)=>{
                    TemuOperationLog.append({action:"direct-create",status:"failed",error:directBackgroundErrorText(error)||String(error?.message||error||""),storeId:identity.storeId});
                });
            }
            return result;
        }
        if (message.type === "setDirectCreatePaused") return setDirectCreatePaused(sender, message.identity || {}, message.paused === true);
        if (message.type === "retryDirectTask") return retryDirectTask(sender, message.input || {});
        if (message.type === "reportStoreJob") return reportStoreJob(message.payload || {});
        if (message.type === "getCaptureEnabled") {
            return {
                enabled: Boolean(sender.tab && await isTabCaptureEnabled(sender.tab.id))
            };
        }
        if (message.type === "saveSelectedCaptureIntent") return saveSelectedCaptureIntent(message.input || {}, sender);
        if (message.type === "getSelectedCaptureIntent") return getSelectedCaptureIntent(sender);
        if (message.type === "clearSelectedCaptureIntent") return clearSelectedCaptureIntent(sender);
        if (message.type === "setCaptureEnabled") {
            if (!sender.tab) throw new Error("missing_sender_tab");
            if (message.enabled === true) {
                const diagnostic = await readInterfaceDiagnosticSession(sender.tab.id);
                if (diagnostic.active) throw new Error("interface_diagnostics_active_cannot_capture");
            }
            const key = captureEnabledKey(sender.tab.id);
            await chrome.storage.session.set({ [key]: message.enabled === true });
            return { enabled: message.enabled === true };
        }
        throw new Error("unsupported_message");
    };
    // 每个业务命令独立记录开始和结果；高频只读查询不重复写成功，但任何命令失败都保留。
    const tracked = /^(?:open|save|test|push|export|autoPush|begin|advance|clear|setCapture|receiveTarget|reportTarget|downloadTarget|registerStore|claimStore|reportStore|reconcileTarget)/.test(message.type);
    const started = Date.now();
    const context = message.identity || message.payload || message.input || {};
    const meta = { action: message.type, tabId: sender.tab?.id, pageUrl: sender.tab?.url || sender.url,
        storeId: context.storeId, jobId: context.jobId, spuId: context.spuId, identityMatched: context.identityMatched,
        requestId: `cmd-${started}-${Math.random().toString(16).slice(2, 8)}` };
    const execute = async () => {
        if (tracked) await TemuOperationLog.append({ ...meta, status: "started" });
        // 所有目标任务读改写共用串行队列，防止 CLI 同步与 HTTP 回执覆盖彼此的存储。
        const data = /^(receiveCliTask|receiveTargetUploadTasks|reconcileTargetUploadTasks|reportTargetUploadTask|claimStoreJobs)$/.test(message.type)
            ? await withTargetTaskMutation(handler) : await handler();
        if (tracked) await TemuOperationLog.append({ ...meta, status: data?.ok === false ? "failed" : (data?.skipped ? "skipped" : "succeeded"),
            error: data?.error, reason: data?.reason, durationMs: Date.now() - started,
            claimedCount: Array.isArray(data?.claimed) ? data.claimed.length : undefined,
            taskCount: Array.isArray(data?.tasks) ? data.tasks.length : undefined, downloadId: data?.downloadId });
        return data;
    };
    execute().then(data => sendResponse({ ok: true, ...data })).catch(async error => {
        if (message.type !== "recordOperation") await TemuOperationLog.append({ ...meta, status: "failed", error: String(error?.message || error), durationMs: Date.now() - started });
        sendResponse({
            ok: false,
            ...(error && error.captureMeta ? error.captureMeta : {}),
            ...(error && error.queue ? { queue: error.queue } : {}),
            ...(error && error.fingerprint ? { fingerprint: error.fingerprint } : {}),
            ...(error && error.jobId ? { jobId: error.jobId } : {}),
            error: error && error.message ? error.message : String(error)
        });
    });
    return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
    TemuOperationLog.append({ action: "tab-closed", status: "observed", tabId });
    // 关闭卖家页后停止该页诊断；导出页仍可读取其最近会话数据，数据会由 LRU 上限统一淘汰。
    chrome.storage.session.remove([captureEnabledKey(tabId), detailQueueKey(tabId), selectedCaptureKey(tabId), interfaceDiagnosticTabKey(tabId)]).catch(() => {});
});

// 下载请求成功不等于磁盘文件落地，只记录本扩展创建的下载，不监听用户其他文件。
if (chrome.downloads?.onChanged) chrome.downloads.onChanged.addListener(async delta => {
    if (!delta.state && !delta.error) return;
    try {
        const [item] = await chrome.downloads.search({ id: delta.id });
        if (item?.byExtensionId !== chrome.runtime.id) return;
        await TemuOperationLog.append({ action: "download-state", status: delta.error ? "failed" : "changed",
            downloadId: delta.id, downloadState: delta.state?.current, error: delta.error?.current });
    } catch { await TemuOperationLog.append({ action: "download-state", status: "failed", error: "download_state_unavailable" }); }
});

if (chrome.alarms && typeof chrome.alarms.onAlarm === "object") {
    chrome.alarms.onAlarm.addListener(alarm => {
        if (!alarm || alarm.name !== TemuIngestQueue.ALARM_NAME) return;
        enqueuePendingIngest().catch(() => {});
    });
}

// 页面切走后 service worker 仍可能被唤醒；启动时继续执行未完成的自动入库任务。
enqueuePendingIngest().catch(() => {});
