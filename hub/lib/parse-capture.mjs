/**
 * 识别插件导出文件种类，并尽量抽出可核验的商品名单。
 * 完整包以 records 里的原始响应为准；列表页只能还原基础资料，详情正文必须来自明确的详情字段。
 */
import { createHash } from "node:crypto";

const SENSITIVE_KEY = /(?:access|refresh|auth|csrf)?token|cookie|authorization|password|passwd|secret|session(?:id)?|credential|api[-_]?key/i;

export function redactSensitive(value, depth = 0) {
    if (depth > 24) return "[DEPTH_LIMIT]";
    if (Array.isArray(value)) return value.map((item) => redactSensitive(item, depth + 1));
    if (!value || typeof value !== "object") return value;
    const result = {};
    for (const [key, item] of Object.entries(value)) {
        result[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactSensitive(item, depth + 1);
    }
    return result;
}

function asText(value) {
    return String(value || "").trim();
}

function unique(values) {
    return [...new Set(values.filter(Boolean).map((item) => String(item)))];
}

export function detectFileKind(fileName, payload) {
    const name = asText(fileName).toLowerCase();
    if (payload && payload.exportMode === "structure-samples") return "dataset-sample";
    if (payload && payload.kind === "full-capture-packet") return "full-packet";
    if (payload && Array.isArray(payload.logs) && payload.latestRunSnapshot) return "capture-log";
    if (payload && payload.record && payload.record.structure) return "page-structure";
    if (name.includes("dataset")) return "dataset-sample";
    if (name.includes("capture-log") || name.includes("logs")) return "capture-log";
    if (name.includes("page-structure") || name.includes("structure")) return "page-structure";
    return "unknown";
}

function parseRowText(text) {
    const raw = asText(text).replace(/\s+/g, " ");
    if (!raw) return null;
    const spu = (raw.match(/SPU\s*ID\s*[:：]?\s*([0-9]{6,20})/i) || [])[1] || "";
    const skc = (raw.match(/SKC\s*ID\s*[:：]?\s*([0-9]{6,20})/i) || [])[1] || "";
    const category = (raw.match(/类目[:：]\s*([^\n]{1,40}?)(?=SPU\s*ID|货号|资质|$)/i) || [])[1] || "";
    const article = (raw.match(/货号[:：]\s*([A-Za-z0-9_*\/-]+)/) || [])[1] || "";
    let title = raw;
    const categoryIndex = raw.indexOf("类目");
    if (categoryIndex > 0) title = raw.slice(0, categoryIndex);
    title = title.replace(/\.beast-core[\s\S]*$/i, "").trim();
    return {
        spuId: spu,
        skcId: skc,
        category: asText(category).replace(/SPU.*$/i, "").trim(),
        articleNo: article === "-" ? "" : article,
        title,
        raw
    };
}

function collectIdSources(log) {
    const sources = log && log.idSources ? log.idSources : {};
    const pick = (kind) => (Array.isArray(sources[kind]) ? sources[kind] : [])
        .map((item) => asText(item && item.samples && item.samples[0]))
        .filter(Boolean);
    const skuEntries = (Array.isArray(sources.sku) ? sources.sku : []).map((item) => ({
        path: asText(item && item.path),
        id: asText(item && item.samples && item.samples[0])
    })).filter((item) => item.id);
    return {
        spu: pick("spu"),
        goods: pick("goods"),
        skc: pick("skc"),
        sku: skuEntries
    };
}

function skuIndexFromPath(path) {
    const match = String(path || "").match(/pageItems\[(\d+)\]/);
    return match ? Number(match[1]) : -1;
}

function upsertProduct(map, partial) {
    const spuId = asText(partial.spuId);
    if (!spuId) return null;
    const current = map.get(spuId) || {
        spuId,
        goodsId: "",
        title: "",
        category: "",
        articleNo: "",
        productExtCodes: [],
        skuExtCodes: [],
        skcIds: [],
        skuIds: [],
        skus: [],
        attributes: [],
        sources: [],
        notes: []
    };
    if (partial.goodsId && !current.goodsId) current.goodsId = String(partial.goodsId);
    if (partial.title && (!current.title || current.title.length < partial.title.length)) current.title = partial.title;
    if (partial.category && !current.category) current.category = partial.category;
    if (partial.articleNo && !current.articleNo) current.articleNo = partial.articleNo;
    current.productExtCodes = unique(current.productExtCodes.concat(partial.productExtCodes || []));
    current.skuExtCodes = unique(current.skuExtCodes.concat(
        partial.skuExtCodes || [],
        (partial.skus || []).map((sku) => sku && sku.extCode)
    ));
    // 发布资料独立于展示摘要，仅核心详情可替换，避免列表响应清空配方。
    if (partial.publicationData) current.publicationData = partial.publicationData;
    // 仅原始详情响应解析器生成该证据；源正文为空与尚未查询详情是不同状态。
    if (partial.captureEvidence?.primaryDetail === true) current.captureEvidence = { primaryDetail: true, source: "product-query", descriptionState: partial.captureEvidence.descriptionState || "unknown" };
    // 详情接口通常拆成“基础信息/图文/合规”多次返回；不能只保留第一段，否则后到的正文会丢失。
    if (hasRealProductDetail(partial.detail)) {
        current.detail = {
            ...(current.detail && typeof current.detail === "object" ? current.detail : {}),
            ...(partial.detail && typeof partial.detail === "object" ? partial.detail : {})
        };
    }
    if (Array.isArray(partial.images) && partial.images.length) current.images = unique((current.images || []).concat(partial.images));
    current.skcIds = unique(current.skcIds.concat(partial.skcIds || (partial.skcId ? [partial.skcId] : [])));
    current.skuIds = unique(current.skuIds.concat(partial.skuIds || (partial.skuId ? [partial.skuId] : [])));
    current.skus = mergeSkuRecords(current.skus, partial.skus);
    current.skuIds = unique(current.skuIds.concat(current.skus.map((item) => item.skuId)));
    if (Array.isArray(partial.attributes) && partial.attributes.length) {
        const attributeMap = new Map((current.attributes || []).map((item) => [`${item.name}\u0000${item.value}\u0000${item.unit}`, item]));
        partial.attributes.forEach((item) => {
            if (!item || (!item.name && !item.value)) return;
            attributeMap.set(`${item.name}\u0000${item.value}\u0000${item.unit}`, item);
        });
        current.attributes = [...attributeMap.values()].slice(0, 120);
    }
    current.sources = unique(current.sources.concat(partial.sources || []));
    current.notes = unique(current.notes.concat(partial.notes || []));
    map.set(spuId, current);
    return current;
}

function findShopName(dataset) {
    const records = Array.isArray(dataset && dataset.records) ? dataset.records : [];
    for (const record of records) {
        const malls = record && record.payload && record.payload.result && record.payload.result.mallList;
        if (Array.isArray(malls) && malls[0] && malls[0].mallName) return asText(malls[0].mallName);
    }
    return "";
}

function summarizeDataset(dataset) {
    return {
        exportMode: asText(dataset && dataset.exportMode) || "structure-samples",
        sampleCount: Number(dataset && dataset.sampleCount) || (Array.isArray(dataset && dataset.records) ? dataset.records.length : 0),
        totalCountsByType: dataset && dataset.totalCountsByType ? dataset.totalCountsByType : {},
        declaredTotal: Object.values((dataset && dataset.totalCountsByType) || {}).reduce((sum, value) => sum + Number(value || 0), 0)
    };
}

const PRODUCT_SPU_KEYS = new Set(["productid", "productspuid", "spuid", "productids", "productspuids", "spuids"]);
const PRODUCT_GOODS_KEYS = new Set(["goodsid", "goodsids"]);
const PRODUCT_SKC_KEYS = new Set(["productskcid", "productskcids", "skcid", "skcids"]);
const PRODUCT_SKU_KEYS = new Set(["productskuid", "productskuids", "skuid", "skuids"]);
const PRODUCT_TITLE_KEYS = new Set(["title", "producttitle", "productname", "goodsname", "spuname", "name"]);
const PRODUCT_DETAIL_TITLE_KEYS = new Set(["title", "producttitle", "productname", "goodsname", "spuname"]);
const PRODUCT_CATEGORY_KEYS = new Set(["category", "categoryname", "catname", "leafcategoryname"]);
const PRODUCT_ARTICLE_KEYS = new Set(["articleno", "articlenumber", "goodsno", "itemno"]);
const REAL_DETAIL_KEYS = new Set([
    "detail",
    "description",
    "desc",
    "productdesc",
    "goodsdesc",
    "detaildesc",
    "productdetail",
    "goodsdetail",
    "productdescription",
    "goodsdescription",
    "detaildescription",
    "detailhtml",
    "detailehtml",
    "goodsdetailhtml",
    "productdetailhtml",
    "richtext",
    "richtextcontent",
    "longdesc",
    "productdetaildesc",
    "goodsdetaildesc",
    "detailinfo",
    "productdetailinfo",
    "goodsdetailinfo",
    "detaildata",
    "productdetaildata",
    "goodsdetaildata",
    "richtextdata",
    "descriptionhtml",
    // 编辑页不同模块会把正文拆成列表或内容字段；这些名称仍需经过
    // hasMeaningfulDetailText/hasRichDetailValue 校验，不能仅凭字段名判定完整。
    "detailcontent",
    "detailcontents",
    "descriptioncontent",
    "descriptioncontents",
    "descriptiontext",
    "productdescriptiontext",
    "descriptionlist",
    "descriptioni18n",
    "productdescriptioni18n",
    "productdetaili18n",
    "richtextlist",
    "detailtext",
    "contenttext",
    "contenthtml",
    // 真实product/query的图文与多语言图文容器，不能因未识别字段而误报源正文为空。
    "goodslayerdecorationvolist", "goodslayerdecorationcustomizei18nvolist"
]);
// 编辑页图文字段名称随版本变化；只有容器中出现正文/HTML/图片等内容时才算详情，
// 不能把 decoration 的空配置或 hasDetailVideo 之类状态字段当成正文。
const DETAIL_CONTAINER_KEYS = new Set(["decoration", "decorationi18n", "material", "materiali18n"]);
const DETAIL_CONTENT_KEYS = new Set(["content", "html", "htmlcontent", "richtext", "body", "text", "description", "url", "src", "images", "imageurls"]);
const DETAIL_BODY_KEYS = new Set(["content", "html", "htmlcontent", "body"]);
const FLAG_DETAIL_KEYS = /^(?:has|have|need|can|is|if|allow|should|off|on)/i;
const DETAIL_META_KEYS = /^(?:status|state|code|error|message|msg|success|result|loading|pending|finished|complete|valid|enabled|type|id)$/i;

function normalizeFieldKey(key) {
    return String(key || "").replace(/[\s_-]/g, "").toLowerCase();
}

function scalarValues(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.map(item => {
        if (typeof item === "string" || typeof item === "number") return asText(item);
        return "";
    }).filter(Boolean);
}

function readShallowValues(object, keys) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return [];
    const found = [];
    for (const [key, value] of Object.entries(object)) {
        if (keys.has(normalizeFieldKey(key))) found.push(...scalarValues(value));
    }
    return unique(found);
}

function readShallowValue(object, keys) {
    return readShallowValues(object, keys)[0] || "";
}

/**
 * 合并同一 SPU 下多次出现的 SKU 行。按 skuId 去重，后到的非空字段覆盖空值。
 */
function mergeSkuRecords(current = [], incoming = []) {
    const map = new Map();
    for (const sku of [...current, ...incoming]) {
        const skuId = asText(sku && sku.skuId);
        if (!skuId) continue;
        const previous = map.get(skuId) || { skuId };
        map.set(skuId, {
            skuId,
            extCode: asText(sku.extCode || previous.extCode),
            specs: Array.isArray(sku.specs) && sku.specs.length ? sku.specs : (previous.specs || []),
            price: sku.price ?? previous.price ?? null,
            currency: asText(sku.currency || previous.currency),
            weight: sku.weight ?? previous.weight ?? null,
            netWeight: sku.netWeight ?? previous.netWeight ?? null,
            thumbUrl: asText(sku.thumbUrl || previous.thumbUrl)
        });
    }
    return [...map.values()];
}

function hasMeaningfulDetailText(value, depth = 0) {
    if (depth > 4 || value == null) return false;
    if (typeof value === "boolean" || typeof value === "number") return false;
    if (typeof value === "string") {
        const text = value.trim();
        if (!text || text === "[DEPTH_LIMIT]") return false;
        if (/^(true|false|null|undefined)$/i.test(text)) return false;
        // 详情证据必须是有内容的正文/资源；短状态词和单个编号不能把空详情判为完整。
        return text.length >= 8 && (/<[a-z][^>]*>/i.test(text) || /https?:\/\//i.test(text) || /\s|[\u4e00-\u9fff]/.test(text));
    }
    if (Array.isArray(value)) return value.some((item) => hasMeaningfulDetailText(item, depth + 1));
    if (typeof value === "object") return Object.entries(value).some(([key, item]) => {
        const normalized = normalizeFieldKey(key);
        return !DETAIL_META_KEYS.test(normalized) && !FLAG_DETAIL_KEYS.test(key) && hasMeaningfulDetailText(item, depth + 1);
    });
    return false;
}

/** 判断 decoration/material 这类包装对象里是否真的有图文内容，而不是空数组或布尔状态。 */
function hasRichDetailValue(value, depth = 0) {
    if (depth > 5 || value == null) return false;
    if (typeof value === "string") {
        const text = value.trim();
        return text.length >= 12 && (/\<[a-z][^>]*\>/i.test(text) || /https?:\/\//i.test(text) || /[\u4e00-\u9fff]/.test(text));
    }
    if (Array.isArray(value)) return value.some(item => hasRichDetailValue(item, depth + 1));
    if (typeof value !== "object") return false;
    return Object.entries(value).some(([key, child]) => {
        const normalized = normalizeFieldKey(key);
        if (DETAIL_META_KEYS.test(normalized) || FLAG_DETAIL_KEYS.test(key)) return false;
        if (DETAIL_CONTENT_KEYS.has(normalized)) return hasMeaningfulDetailText(child);
        // 只有继续进入对象/数组才递归；customizeType 等普通字符串不能单独证明有正文。
        return Boolean(child && typeof child === "object") && hasRichDetailValue(child, depth + 1);
    });
}

/**
 * 只有描述、富文本、详情 HTML 这类正文才算商品详情。
 * 列表页的 hasDetailVideo、guideFileAttribute、productProperties 不能把完成度标成已齐。
 */
export function hasRealProductDetail(detail) {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
    return Object.entries(detail).some(([key, value]) => {
        const normalized = normalizeFieldKey(key);
        return (REAL_DETAIL_KEYS.has(normalized) && hasMeaningfulDetailText(value))
            || (DETAIL_BODY_KEYS.has(normalized) && hasRichDetailValue(value))
            || (DETAIL_CONTAINER_KEYS.has(normalized) && hasRichDetailValue(value));
    });
}

/**
 * 统一批次解析、库存目录和任务发送的“资料可交付”门槛。
 * Temu 编辑页的 goodsId、SKC 并非每次 product/query 都会返回，不能把它们当成阻断条件；
 * 核心详情已成功采集时允许源正文为空；此门槛只允许资料交付，目标类目发布规则仍须单独核验。
 */
export function isProductReadyForTransfer(completeness) {
    const fields = completeness && typeof completeness === "object" ? completeness : {};
    return Boolean(fields.hasSpu && fields.hasTitle && fields.hasSku && (fields.hasDetail || (fields.hasPrimaryDetail && fields.detailState === "source-empty")) && fields.hasImages);
}

/** 根据当前合并后的真实字段重算完整度，供新包解析和旧库存迁移共用，避免信任历史布尔标记。 */
export function getProductCompleteness(product = {}) {
    const skuIds = unique([
        ...(Array.isArray(product.skuIds) ? product.skuIds : []),
        ...(Array.isArray(product.skus) ? product.skus.map((item) => item && item.skuId) : [])
    ]);
    const images = unique(Array.isArray(product.images) ? product.images : []);
    const skcIds = unique(Array.isArray(product.skcIds) ? product.skcIds : []);
    const attributes = Array.isArray(product.attributes) ? product.attributes : [];
    return {
        hasTitle: Boolean(asText(product.title)),
        hasSpu: Boolean(asText(product.spuId)),
        hasGoods: Boolean(asText(product.goodsId)),
        hasSkc: skcIds.length > 0,
        hasSku: skuIds.length > 0,
        hasAttributes: attributes.length > 0,
        hasDetail: hasRealProductDetail(product.detail),
        hasPrimaryDetail: product.captureEvidence?.primaryDetail === true,
        detailState: hasRealProductDetail(product.detail) ? "present" : (product.captureEvidence?.primaryDetail === true ? (product.captureEvidence.descriptionState === "empty" ? "source-empty" : "unverified") : "not-captured"),
        hasImages: images.length > 0
    };
}

function readCategoryName(object) {
    const direct = readShallowValue(object, PRODUCT_CATEGORY_KEYS);
    if (direct) return direct;
    const leafName = object && object.leafCat && typeof object.leafCat === "object" ? asText(object.leafCat.catName) : "";
    if (leafName) return leafName;
    const categories = object && object.categories && typeof object.categories === "object" ? object.categories : null;
    if (!categories) return "";
    return ["cat10", "cat9", "cat8", "cat7", "cat6", "cat5", "cat4", "cat3", "cat2", "cat1"]
        .map((key) => asText(categories[key] && categories[key].catName))
        .find(Boolean) || "";
}

function readArticleNo(object) {
    return readShallowValue(object, PRODUCT_ARTICLE_KEYS);
}

/**
 * 商品/SKC 货号只从商品级字段读取：列表行的 extCode，或 productSkcList 中每个 SKC 的 extCode。
 * 不能递归读取任意 extCode，否则会把 SKU 货号错误提升成商品货号，破坏“商品优先、SKU 兜底”的判重规则。
 */
function readProductExtCodes(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return [];
    const hasProductIdentity = readShallowValues(object, PRODUCT_SPU_KEYS).length > 0
        || readShallowValues(object, PRODUCT_GOODS_KEYS).length > 0
        || Array.isArray(object.productSkcList);
    if (!hasProductIdentity) return [];
    const values = readShallowValues(object, new Set(["extcode", "skcextcode"]));
    const skcs = Array.isArray(object.productSkcList) ? object.productSkcList : [];
    for (const skc of skcs.slice(0, 80)) {
        if (!skc || typeof skc !== "object" || Array.isArray(skc)) continue;
        values.push(...readShallowValues(skc, new Set(["extcode", "skcextcode"])));
    }
    return unique(values);
}

/**
 * 列表接口把 SKU 放在 pageItems[i].productSkuSummaries，不在与 SPU 同层。
 * 只读取当前对象自己的 SKU 数组，避免把邻行 SKU 挂到这个 SPU。
 */
function readNestedSkuSummaries(object) {
    if (!object || typeof object !== "object" || Array.isArray(object)) return [];
    const lists = [];
    for (const [key, value] of Object.entries(object)) {
        const normalized = normalizeFieldKey(key);
        // 列表页使用 productSkuSummaries，编辑页常改成 skuList/skuInfoList/variants；
        // 仅在“明确是 SKU 列表”的字段下读取，不能把任意数组里的 id 当 SKU。
        if (Array.isArray(value) && /^(?:product)?skusummar(?:y|ies)$|^(?:product)?skulist$|^(?:product)?skus$|^sku(?:info|detail)?list$|^(?:product)?sku(?:info|detail)s$|^(?:sku)?(?:variants?|variations?)$/.test(normalized)) {
            lists.push({ key: normalized, value });
        }
        // Temu 编辑页的 product/query 常用对象形式的 productSkuMap；不能因它不是数组就丢掉真实 SKU。
        if (value && typeof value === "object" && !Array.isArray(value) && /^(?:product)?skumap$|^sku(?:info|detail)?map$/.test(normalized)) {
            lists.push({ key: normalized, value: Object.values(value) });
        }
    }
    const skus = [];
    for (const listEntry of lists) {
        for (const sku of listEntry.value.slice(0, 80)) {
            if (!sku || typeof sku !== "object" || Array.isArray(sku)) continue;
            // 只有带 sku 语义的列表才允许使用通用 id，避免把图片/属性数组的 id 误挂到 SKU。
            const skuId = readShallowValue(sku, PRODUCT_SKU_KEYS)
                || (listEntry.key.includes("sku") ? readShallowValue(sku, new Set(["id"])) : "");
            if (!skuId) continue;
            const specLists = Object.entries(sku).filter(([key, value]) => Array.isArray(value)
                && /^(?:product)?skuspec(?:list|s)?$|^spec(?:list|s|ifications?)$/.test(normalizeFieldKey(key)))
                .flatMap(([, value]) => value);
            const specs = specLists.map((item) => ({
                name: asText(item && (item.parentSpecName || item.specName || item.name || item.specKey || item.attributeName)),
                value: asText(item && (item.specName || item.value || item.specValue || item.attributeValue))
            })).filter((item) => item.name || item.value);
            const warehouse = sku.productSkuWhExtAttr && typeof sku.productSkuWhExtAttr === "object" ? sku.productSkuWhExtAttr : {};
            skus.push({
                skuId,
                extCode: asText(sku.extCode || sku.skuExtCode || sku.merchantSku || sku.skuCode),
                specs,
                price: sku.supplierPrice ?? sku.salePrice ?? sku.productSkuPrice ?? sku.price ?? null,
                currency: asText(sku.currencyType || sku.currency || sku.currencyCode),
                weight: warehouse.productSkuWeight && warehouse.productSkuWeight.value != null ? warehouse.productSkuWeight.value
                    : (sku.weight ?? sku.grossWeight ?? null),
                netWeight: warehouse.productSkuNetWeight && warehouse.productSkuNetWeight.value != null ? warehouse.productSkuNetWeight.value
                    : (sku.netWeight ?? null),
                thumbUrl: asText(sku.thumbUrl || sku.imageUrl || sku.skuImageUrl || sku.mainImageUrl)
            });
        }
    }
    return mergeSkuRecords([], skus);
}

/**
 * 详情接口有时把 skuList 包在 result/data/productInfo 多层对象中；在已有
 * pageProductId 归属的前提下递归找这些明确的 SKU 容器，避免只看响应顶层而丢规格。
 */
function readDeepNestedSkuSummaries(root, depth = 0, output = []) {
    if (!root || typeof root !== "object" || depth > 8 || output.length >= 120) return mergeSkuRecords([], output);
    output.push(...readNestedSkuSummaries(root));
    if (Array.isArray(root)) {
        root.slice(0, 120).forEach(item => readDeepNestedSkuSummaries(item, depth + 1, output));
    } else {
        Object.values(root).slice(0, 160).forEach(value => {
            if (value && typeof value === "object") readDeepNestedSkuSummaries(value, depth + 1, output);
        });
    }
    return mergeSkuRecords([], output);
}

/**
 * 商品属性来自列表行的 productProperties，只作基础资料，不能代替详情正文。
 */
function readListAttributes(object) {
    const output = [];
    const visit = (value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 6 || output.length >= 120) return;
        if (Array.isArray(value)) {
            value.slice(0, 80).forEach(item => visit(item, depth + 1));
            return;
        }
        for (const [key, child] of Object.entries(value)) {
            const normalized = normalizeFieldKey(key);
            // 只展开明确的商品属性容器，避免把 SKU specList 的 name/value 当成商品属性。
            if (Array.isArray(child) && /^(?:product)?propert(?:y|ies)|^(?:product)?propertylist$|^(?:product)?attribute(?:list|infos?)?$/.test(normalized)) {
                child.slice(0, 80).forEach(item => {
                    if (!item || typeof item !== "object") return;
                    const name = asText(item.propName || item.propertyName || item.attributeName || item.label);
                    const itemValue = asText(item.propValue || item.propertyValue || item.attributeValue || item.value);
                    const unit = asText(item.valueUnit || item.unit);
                    if (name && itemValue) output.push({
                        name,
                        value: itemValue,
                        unit,
                        templatePid: item.templatePid,
                        pid: item.pid,
                        refPid: item.refPid,
                        vid: item.vid,
                        valueExtendInfo: asText(item.valueExtendInfo),
                        numberInputValue: asText(item.numberInputValue)
                    });
                });
            }
            if (child && typeof child === "object") visit(child, depth + 1);
        }
    };
    visit(object);
    const seen = new Set();
    return output.filter(item => {
        const key = `${item.name}\u0000${item.value}\u0000${item.unit}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 120);
}

/**
 * 详情接口只返回当前编辑页已存在的属性，列表接口会额外返回香味、香精浓度等尚未写入详情结构的字段。
 * 发布资料必须保留这些列表属性的模板编号；只合并展示摘要会在目标店预检时丢失来源证据。
 */
function mergePublicationProperties(product) {
    const sourceProduct = product && product.publicationData && product.publicationData.sourceProduct;
    if (!sourceProduct || typeof sourceProduct !== "object") return;
    const merge = (current, incoming) => {
        const result = { ...(current || {}) };
        for (const [key, value] of Object.entries(incoming || {})) {
            if (value !== undefined && value !== null && value !== "") result[key] = value;
        }
        return result;
    };
    const map = new Map();
    const put = item => {
        if (!item || typeof item !== "object") return;
        const name = asText(item.propName || item.name);
        const value = asText(item.propValue || item.value);
        if (!name || !value) return;
        const refPid = asText(item.refPid);
        const vid = asText(item.vid);
        // 同一属性可以合法返回多个值（例如多个适用香型），所以编号不全时仍需把名称和值纳入键，
        // 不能只按 refPid 合并并把后一个值覆盖掉。
        const key = refPid && vid
            ? `${refPid}\u0000${vid}`
            : `${refPid || vid || name}\u0000${name}\u0000${value}\u0000${asText(item.valueUnit || item.unit)}`;
        map.set(key, merge(map.get(key), item));
    };
    (Array.isArray(sourceProduct.productPropertyList) ? sourceProduct.productPropertyList : []).forEach(put);
    (Array.isArray(product.attributes) ? product.attributes : []).forEach(item => put({
        templatePid: item.templatePid,
        pid: item.pid,
        refPid: item.refPid,
        vid: item.vid,
        propName: item.name,
        propValue: item.value,
        valueUnit: item.unit,
        valueExtendInfo: item.valueExtendInfo,
        numberInputValue: item.numberInputValue
    }));
    if (map.size) sourceProduct.productPropertyList = [...map.values()];
}

function compactDetailValue(value, depth = 0) {
    if (depth > 3) return "[DEPTH_LIMIT]";
    if (typeof value === "string") return value.slice(0, 4000);
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (Array.isArray(value)) return value.slice(0, 30).map(item => compactDetailValue(item, depth + 1));
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).slice(0, 80).map(([key, item]) => [key, compactDetailValue(item, depth + 1)]));
    }
    return "";
}

function collectMediaUrls(value, key = "", output = [], depth = 0) {
    if (depth > 8 || output.length >= 80) return output;
    const normalizedKey = normalizeFieldKey(key);
    if (typeof value === "string") {
        const candidate = value.trim();
        const looksLikeMedia = /^(?:https?:)?\/\//i.test(candidate)
            && (/(?:image|img|pic|photo|media|thumb|cover|poster|video|avatar|主图|图片)/i.test(normalizedKey)
                || /\.(?:jpe?g|png|webp|gif|avif|svg|mp4)(?:[?#]|$)/i.test(candidate));
        if (looksLikeMedia && !output.includes(candidate)) output.push(candidate.slice(0, 2000));
        // 图文详情常把图片写在 HTML 的 src/data-src/poster 中，字段名本身不含 image。
        const embedded = candidate.match(/(?:src|data-src|poster)\s*=\s*["']([^"']+)["']/gi) || [];
        embedded.forEach(fragment => {
            const match = fragment.match(/=\s*["']([^"']+)["']/);
            const url = match && match[1] ? match[1].trim() : "";
            if (/^(?:https?:)?\/\//i.test(url) && !output.includes(url)) output.push(url.slice(0, 2000));
        });
        // 少数响应把图片 URL 直接拼在一段文本中，按扩展名提取并限制总量。
        const plainUrls = candidate.match(/https?:\/\/[^\s"'<>]+?\.(?:jpe?g|png|webp|gif|avif|svg|mp4)(?:\?[^\s"'<>]*)?/gi) || [];
        plainUrls.forEach(url => { if (!output.includes(url)) output.push(url.slice(0, 2000)); });
        return output;
    }
    if (Array.isArray(value)) {
        value.slice(0, 100).forEach(item => collectMediaUrls(item, key, output, depth + 1));
        return output;
    }
    if (!value || typeof value !== "object") return output;
    Object.entries(value).slice(0, 160).forEach(([childKey, childValue]) => collectMediaUrls(childValue, `${key}.${childKey}`, output, depth + 1));
    return output;
}

/** 详情响应可能没有顶层 SPU；单商品页面上下文已保证归属，此处仅按明确字段递归补齐元数据。 */
function readDeepValues(root, keys, depth = 0, output = []) {
    if (!root || typeof root !== "object" || depth > 8 || output.length >= 120) return unique(output);
    if (Array.isArray(root)) {
        root.slice(0, 120).forEach(item => readDeepValues(item, keys, depth + 1, output));
        return unique(output);
    }
    for (const [key, value] of Object.entries(root)) {
        if (keys.has(normalizeFieldKey(key))) output.push(...scalarValues(value));
        if (value && typeof value === "object") readDeepValues(value, keys, depth + 1, output);
    }
    return unique(output);
}

function readDetailFields(object, depth = 0, output = {}, allowGenericBody = false) {
    if (!object || typeof object !== "object" || depth > 5) return Object.keys(output).length ? output : null;
    if (Array.isArray(object)) {
        object.slice(0, 80).forEach(item => readDetailFields(item, depth + 1, output, allowGenericBody));
        return Object.keys(output).length ? output : null;
    }
    for (const [key, value] of Object.entries(object)) {
        const normalized = normalizeFieldKey(key);
        if (FLAG_DETAIL_KEYS.test(key) || FLAG_DETAIL_KEYS.test(normalized)) continue;
        if (REAL_DETAIL_KEYS.has(normalized) && hasMeaningfulDetailText(value)) {
            output[key] = compactDetailValue(value);
        } else if (allowGenericBody && DETAIL_BODY_KEYS.has(normalized) && hasRichDetailValue(value)) {
            output[key] = compactDetailValue(value);
        } else if (DETAIL_CONTAINER_KEYS.has(normalized) && hasRichDetailValue(value)) {
            output[key] = compactDetailValue(value);
        } else if (value && typeof value === "object" && Object.keys(output).length < 80) {
            readDetailFields(value, depth + 1, output, allowGenericBody);
        }
    }
    return Object.keys(output).length ? output : null;
}

/**
 * 从完整包中的原始接口响应提取商品字段。只接受同一对象内明确的 SPU 键，
 * 避免把仅有 goodsId/SKC/SKU 的附加对象串到邻近商品；原始响应仍完整保留在 records 中。
 */
function extractProductsFromRecord(record) {
    const products = [];
    const pageContextSpu = asText(record && record.source && record.source.pageProductId);
    // 不信任完整包预计算布尔值：只有成功的核心详情对象、ID一致、真实标题/SKU结构才提供采集证据。
    const rootPayload = record?.payload;
    const rootProduct = rootPayload?.result || rootPayload?.res || rootPayload;
    const primaryDetail = /\/visage-agent-seller\/product\/query(?:$|[?])/.test(record?.source?.requestUrl || "")
        && rootPayload?.success !== false && (!rootPayload?.errorCode || rootPayload.errorCode === 1000000)
        && rootProduct && typeof rootProduct.productName === "string" && Array.isArray(rootProduct.productSkcList)
        && asText(rootProduct.productId) && (!pageContextSpu || asText(rootProduct.productId) === pageContextSpu);
    const descriptionFields = ["goodsLayerDecorationVOList", "goodsLayerDecorationCustomizeI18nVOList"].filter(key => Object.hasOwn(rootProduct || {}, key));
    const descriptionState = descriptionFields.length && descriptionFields.every(key => rootProduct[key] === null || (Array.isArray(rootProduct[key]) && rootProduct[key].length === 0)) ? "empty" : "unknown";
    const visit = (value, depth = 0) => {
        if (!value || typeof value !== "object" || depth > 10) return;
        if (Array.isArray(value)) {
            value.slice(0, 500).forEach(item => visit(item, depth + 1));
            return;
        }
        const discoveredSpuIds = readShallowValues(value, PRODUCT_SPU_KEYS);
        // 编辑页响应偶尔带推荐/关联商品；页面 URL 的 SPU 是唯一归属证据，不能把关联商品并入当前商品。
        const spuIds = pageContextSpu
            ? discoveredSpuIds.filter(spuId => spuId === pageContextSpu)
            : discoveredSpuIds;
        if (spuIds.length) {
            const images = collectMediaUrls(value);
            const goodsIds = readShallowValues(value, PRODUCT_GOODS_KEYS);
            const skcIds = readShallowValues(value, PRODUCT_SKC_KEYS);
            const skuIds = readShallowValues(value, PRODUCT_SKU_KEYS);
            const singular = spuIds.length === 1;
            // 编辑页主对象下会先经过 productSkcList 再到 productSkuMap/productSkuList；
            // 仅查看当前层会漏掉这些真实 SKU，因此限定在当前 SPU 对象内做深层读取。
            const nestedSkus = singular ? readDeepNestedSkuSummaries(value) : [];
            spuIds.forEach((spuId, index) => products.push({
                    spuId,
                    goodsId: goodsIds.length === spuIds.length ? goodsIds[index] : (singular ? goodsIds[0] || "" : ""),
                    title: singular ? readShallowValue(value, PRODUCT_TITLE_KEYS) : "",
                    category: singular ? readCategoryName(value) : "",
                    articleNo: singular ? readArticleNo(value) : "",
                    productExtCodes: singular ? readProductExtCodes(value) : [],
                    // 核心详情将SKC放在productSkcList中，只取当前SPU主对象下的直属SKC。
                    skcIds: unique([...(skcIds.length === spuIds.length ? [skcIds[index]] : (singular ? skcIds : [])), ...(singular && Array.isArray(value.productSkcList) ? value.productSkcList.flatMap(skc => readShallowValues(skc, PRODUCT_SKC_KEYS)) : [])]),
                    skuIds: unique([
                        ...(skuIds.length === spuIds.length ? [skuIds[index]] : (singular ? skuIds : [])),
                        ...nestedSkus.map((item) => item.skuId)
                    ]),
                    skus: nestedSkus,
                    attributes: singular ? readListAttributes(value) : [],
                    images: singular ? images : [],
                    detail: singular ? readDetailFields(value, 0, {}, record && record.dataType === "product-detail") : null,
                    captureEvidence: primaryDetail && value === rootProduct ? { primaryDetail: true, descriptionState } : null,
                    // 保留 SKU 成分、规格标识、计量原值及媒体角色；尚未经过目标店铺校验。
                    publicationData: primaryDetail && value === rootProduct ? { schemaVersion: 1, validationState: "target-unverified", sourceProduct: structuredClone(rootProduct) } : undefined,
                    sources: ["full-packet"]
                }));
        }
        Object.values(value).slice(0, 180).forEach(child => visit(child, depth + 1));
    };
    visit(record && record.payload);
    // 详情接口可能完全不返回 productId；后台已用 /goods/edit?productId=... 建立唯一上下文，
    // 此时把整段响应归到该 SPU，并从同一响应提取正文、图文、规格。多商品响应仍禁止这样回退。
    const identitySpu = record && record.identity && Array.isArray(record.identity.productIds) && record.identity.productIds.length === 1
        ? asText(record.identity.productIds[0]) : "";
    const contextPayload = record && record.payload && typeof record.payload === "object" ? record.payload : {};
    // 编辑页会并行请求基础资料、规格、图片和库存；其中规格接口常被分类为
    // sku/unknown 且正文不重复 productId。只要响应来自带 pageProductId 的编辑页，
    // 并且包含明确商品字段，就按该 SPU 合并，避免 SKU/图片段在仓库中消失。
    const contextualContent = Boolean(record && record.detailEvidence)
        || Boolean(record && record.source && record.source.pageProductId && (
            readDeepValues(contextPayload, PRODUCT_DETAIL_TITLE_KEYS).length > 0
            || readDeepValues(contextPayload, PRODUCT_GOODS_KEYS).length > 0
            || readDeepValues(contextPayload, PRODUCT_SKC_KEYS).length > 0
            || readDeepValues(contextPayload, PRODUCT_SKU_KEYS).length > 0
            || readDeepNestedSkuSummaries(contextPayload).length > 0
            || collectMediaUrls(contextPayload).length > 0
            || hasRealProductDetail(readDetailFields(contextPayload, 0, {}, true))
        ));
    // 后台会给详情页每条响应写 pageProductId，但库存/权限等旁路响应不能因此把自身文本冒充商品详情。
    // 只有真实详情证据或明确商品字段才允许用页面上下文回退；列表响应仍可使用 identity 中的真实 SPU。
    const contextualSpu = pageContextSpu && contextualContent ? pageContextSpu : (!pageContextSpu ? identitySpu : "");
    const explicitIds = readDeepValues(contextPayload, PRODUCT_SPU_KEYS);
    if (!products.length && contextualSpu && (!explicitIds.length || explicitIds.includes(contextualSpu))) {
        const spuId = contextualSpu;
        const payload = contextPayload;
        const detail = readDetailFields(payload, 0, {}, true);
        const deepGoods = readDeepValues(payload, PRODUCT_GOODS_KEYS);
        const deepSkc = readDeepValues(payload, PRODUCT_SKC_KEYS);
        const deepSku = readDeepValues(payload, PRODUCT_SKU_KEYS);
        const nestedSkus = readDeepNestedSkuSummaries(payload);
        const payloadProduct = payload.result || payload.res || payload;
        products.push({
            spuId,
            goodsId: record.identity.goodsIds && record.identity.goodsIds.length === 1
                ? asText(record.identity.goodsIds[0]) : (deepGoods[0] || ""),
            // 详情树中常有规格 name/属性 name，不能使用过宽的通用 name 键作为商品标题。
            title: readDeepValues(payload, PRODUCT_DETAIL_TITLE_KEYS)[0] || "",
            category: readCategoryName(payload),
            articleNo: readDeepValues(payload, PRODUCT_ARTICLE_KEYS)[0] || "",
            productExtCodes: readProductExtCodes(payloadProduct),
            skcIds: unique([...(record.identity.skcIds || []), ...deepSkc]).slice(0, 20),
            // identity.skuIds 只是响应元数据，没有行级归属；只有正文自身携带的 SKU 才能挂回该 SPU。
            skuIds: unique([...deepSku, ...nestedSkus.map(item => item.skuId)]),
            skus: nestedSkus,
            attributes: readListAttributes(payload),
            images: collectMediaUrls(payload),
            detail,
            sources: ["full-packet", "detail-page-context"]
        });
    }
    return products.filter(product => product.spuId);
}

// SKU 归属只采信列表接口 pageItems[i].productSkuSummaries，不从无 SPU 的附加行猜测。

export function parseImportedFiles(files) {
    const products = new Map();
    const warnings = [];
    const fileSummaries = [];
    let shopName = "";
    let sourceStoreId = "";
    let sourceStoreName = "";
    let pluginInstanceId = "";
    let pageStoreName = "";
    let pageUrl = "";
    let coverage = "";
    let completedCount = 0;
    let expectedCount = 0;
    let logSaved = 0;
    let logFailed = 0;
    let productFailures = 0;
    let datasetSummary = null;
    let structureCounts = null;
    let kinds = [];

    for (const file of files) {
        const kind = detectFileKind(file.originalName, file.payload);
        kinds.push(kind);
        fileSummaries.push({
            originalName: file.originalName,
            kind,
            bytes: file.bytes,
            exportedAt: file.payload && file.payload.exportedAt,
            purpose: file.payload && file.payload.purpose
        });

        if (kind === "dataset-sample") {
            datasetSummary = summarizeDataset(file.payload);
            shopName = shopName || findShopName(file.payload);
            warnings.push("dataset 是结构样本，每种类型最多 3 条，不能当作完整商品包导入其他账号。");
        }

        if (kind === "capture-log") {
            const snap = file.payload.latestRunSnapshot || {};
            const diag = snap.domDiagnostics || {};
            pageUrl = pageUrl || asText(snap.pageUrl || diag.pageUrl);
            completedCount = Number(snap.completedCount || 0);
            expectedCount = Number(snap.expectedCount || snap.declaredProductCount || diag.declaredProductCount || 0);
            coverage = expectedCount ? `${completedCount}/${expectedCount}` : "";
            logSaved = Number(snap.saved || file.payload.logCount || 0);
            logFailed = Number(snap.failed || file.payload.failedCount || 0);
            productFailures = Number(snap.productFailures || 0);

            const rowSamples = Array.isArray(diag.rowSamples) ? diag.rowSamples : [];
            const parsedRows = rowSamples.map((row) => parseRowText(row && row.text)).filter(Boolean);
            parsedRows.filter((row) => row.spuId).forEach((row) => {
                upsertProduct(products, {
                    ...row,
                    sources: ["dom-row"]
                });
            });

            const listLog = (file.payload.logs || []).find((item) => item.category === "product-list" && Number(item.spuIdsCount) > 0);
            if (listLog) {
                const ids = collectIdSources(listLog);
                ids.spu.forEach((spuId, index) => {
                    const skuIds = ids.sku.filter((item) => skuIndexFromPath(item.path) === index).map((item) => item.id);
                    upsertProduct(products, {
                        spuId,
                        goodsId: ids.goods[index] || "",
                        skcId: ids.skc[index] || "",
                        skuIds,
                        sources: ["list-interface"]
                    });
                });
            }

            (snap.pageProductIdsSample || diag.domProductIds || []).forEach((spuId) => {
                upsertProduct(products, { spuId, sources: ["page-spu-set"] });
            });

            
        }

        if (kind === "page-structure") {
            const structure = file.payload.record && file.payload.record.structure;
            if (structure) {
                pageUrl = pageUrl || asText(structure.pageUrl);
                structureCounts = structure.counts || null;
                (structure.domProductIds || []).forEach((spuId) => {
                    upsertProduct(products, { spuId, sources: ["page-structure"] });
                });
                const rows = Array.isArray(structure.rowSamples) ? structure.rowSamples : [];
                rows.forEach((row) => {
                    const parsed = parseRowText((row && row.text) || (row && row.node && row.node.text) || "");
                    if (parsed && parsed.spuId) upsertProduct(products, { ...parsed, sources: ["page-structure-row"] });
                });
            }
        }

        if (kind === "full-packet") {
            const packetProducts = Array.isArray(file.payload.products) ? file.payload.products : [];
            const allowedSpuIds = Array.isArray(file.payload.source && file.payload.source.allowedSpuIds)
                ? new Set(file.payload.source.allowedSpuIds.map((value) => asText(value)).filter(Boolean))
                : null;
            // 插件自动入库只代表当前页；仓库解析 records 时必须继续遵守同一份 SPU 白名单。
            const allowSpu = (spuId) => !allowedSpuIds || allowedSpuIds.has(asText(spuId));
            packetProducts.forEach((item) => {
                if (!allowSpu(item && item.spuId)) return;
                upsertProduct(products, {
                    ...item,
                    captureEvidence: null,
                    // 包内预计算摘要不能伪造其他 SPU 的发布资料，只采信下方核心响应解析结果。
                    publicationData: undefined,
                    sources: ["full-packet"]
                });
            });
            const packetRecords = Array.isArray(file.payload.records) ? file.payload.records : [];
            packetRecords.forEach((record) => {
                extractProductsFromRecord(record).forEach((item) => {
                    if (!allowSpu(item && item.spuId)) return;
                    upsertProduct(products, item);
                });
            });
            if (file.payload.source && typeof file.payload.source === "object") {
                pageUrl = pageUrl || asText(file.payload.source.pageUrl);
                shopName = shopName || asText(file.payload.source.shopName);
                sourceStoreId = sourceStoreId || asText(file.payload.source.sourceStoreId);
                sourceStoreName = sourceStoreName || asText(file.payload.source.sourceStoreName || file.payload.source.shopName);
                pluginInstanceId = pluginInstanceId || asText(file.payload.source.pluginInstanceId);
                pageStoreName = pageStoreName || asText(file.payload.source.pageStoreName || file.payload.source.shopName);
            }
        }

        if (kind === "unknown") {
            warnings.push(`${file.originalName} 无法识别，已原样入库，不参与商品核验。`);
        }
    }

    const list = [...products.values()].map((product) => {
        mergePublicationProperties(product);
        const completeness = getProductCompleteness(product);
        return {
            ...product,
            completeness,
            // 交付门槛由共享函数计算，避免批次与库存目录对同一件商品给出相反结论。
            ready: isProductReadyForTransfer(completeness)
        };
    });

    const hasLog = kinds.includes("capture-log") || kinds.includes("page-structure");
    const hasSample = kinds.includes("dataset-sample");
    const hasFull = kinds.includes("full-packet");
    let readiness = "不可导入";
    let status = "unverified";
    if (hasFull && list.length && list.every((item) => item.ready)) {
        readiness = "待映射";
        status = "ready-for-map";
    } else if (hasFull && list.length) {
        readiness = "完整包未齐，不可导入";
        status = "packet-incomplete";
    } else if (list.length && hasLog) {
        readiness = "可核验，不可导入";
        status = hasSample ? "sample-verified" : "verified-incomplete";
    } else if (hasSample) {
        readiness = "仅结构样本";
        status = "sample-only";
    }

    if (!hasFull) warnings.push("还没有完整业务数据包。当前商品名单来自日志和页面结构，缺详情、图片和可发布字段。");
    if (hasFull && status === "packet-incomplete") {
        const missing = [];
        if (list.some((item) => !item.completeness.hasSku)) missing.push("SKU");
        if (list.some((item) => !item.completeness.hasImages)) missing.push("图片");
        if (list.some((item) => !item.completeness.hasDetail && !item.completeness.hasPrimaryDetail)) missing.push("详情接口资料");
        warnings.push(`完整包已解析到列表基础资料，但仍缺${missing.join("、") || "必要字段"}，不能进入导入映射。`);
    }
    if (datasetSummary && datasetSummary.declaredTotal && datasetSummary.sampleCount < datasetSummary.declaredTotal) {
        warnings.push(`dataset 只带了 ${datasetSummary.sampleCount} 条样本，插件声明各类响应合计 ${datasetSummary.declaredTotal} 条。`);
    }

    return {
        shopName,
        sourceStoreId,
        sourceStoreName,
        pluginInstanceId,
        pageStoreName,
        pageUrl,
        status,
        readiness,
        coverage,
        completedCount,
        expectedCount,
        logSaved,
        logFailed,
        productFailures,
        datasetSummary,
        structureCounts,
        warnings: unique(warnings),
        products: list,
        fileSummaries,
        counts: {
            spu: list.length,
            goods: list.filter((item) => item.goodsId).length,
            skc: unique(list.flatMap((item) => item.skcIds)).length,
            sku: unique(list.flatMap((item) => item.skuIds)).length,
            ready: list.filter((item) => item.ready).length
        }
    };
}

export function makeBatchId(parts) {
    return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}
