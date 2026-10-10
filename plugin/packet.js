"use strict";

function packetText(value) {
    return String(value || "").trim();
}

function packetUnique(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(packetText).filter(Boolean))];
}

/** 专用快照可进入新站；未经分类的历史旁路响应继续隔离，避免示例或主图绕过采集边界。 */
function packetIsLocalPhotoRecord(record) {
    return record?.dataType !== 'product-live-photos'
        && /\/api\/flash\/(?:hq\/)?real_picture\//.test(String(record?.source?.requestUrl || ''));
}

/**
 * 从原始响应中按 SPU 提取两级货号：商品行/productSkcList.extCode 是商品货号，
 * productSkuList/productSkuSummaries.extCode 是 SKU 货号。两级必须分开保存，不能在包索引中拍平。
 */
function packetCodesForSpu(root, spuId, depth = 0, result = null) {
    const output = result || { productExtCodes: [], skuExtCodes: [] };
    if (!root || typeof root !== "object" || depth > 10) return output;
    if (Array.isArray(root)) {
        root.slice(0, 500).forEach(item => packetCodesForSpu(item, spuId, depth + 1, output));
        return output;
    }
    const normalizedSpu = packetText(spuId);
    const matchesSpu = Object.entries(root).some(([key, value]) => {
        const normalizedKey = key.replace(/[\s_-]/g, "").toLowerCase();
        if (!["productid", "productspuid", "spuid"].includes(normalizedKey)) return false;
        return (Array.isArray(value) ? value : [value]).some(item => packetText(item) === normalizedSpu);
    });
    if (matchesSpu) {
        output.productExtCodes.push(packetText(root.extCode), packetText(root.skcExtCode));
        const skcs = Array.isArray(root.productSkcList) ? root.productSkcList : [];
        for (const skc of skcs) {
            if (!skc || typeof skc !== "object") continue;
            output.productExtCodes.push(packetText(skc.extCode), packetText(skc.skcExtCode));
            const skus = Array.isArray(skc.productSkuList) ? skc.productSkuList : [];
            for (const sku of skus) {
                if (!sku || typeof sku !== "object") continue;
                output.skuExtCodes.push(packetText(sku.extCode), packetText(sku.skuExtCode));
            }
        }
        for (const key of ["productSkuSummaries", "productSkuList", "skus", "skuList"]) {
            const skus = Array.isArray(root[key]) ? root[key] : [];
            for (const sku of skus) {
                if (!sku || typeof sku !== "object") continue;
                output.skuExtCodes.push(packetText(sku.extCode), packetText(sku.skuExtCode));
            }
        }
    }
    Object.values(root).slice(0, 180).forEach(value => {
        if (value && typeof value === "object") packetCodesForSpu(value, spuId, depth + 1, output);
    });
    return output;
}

/**
 * 商品、证书和独立实拍图共用原始采集包，实拍图只由专用解析器处理；旁路原始响应仍留本地扩展区。
 */
function makeFullCapturePacket(records, options = {}) {
    const allRecords = Array.isArray(records) ? records : [];
    const allowedSpuIds = Array.isArray(options.allowedSpuIds)
        ? new Set(options.allowedSpuIds.map(value => String(value || "").trim()).filter(Boolean))
        : null;
    // 正式记录包含已分类实拍图，原始旁路响应只保留本地，不给服务端递归商品解析。
    const localOnlyRecords = allRecords.filter(packetIsLocalPhotoRecord);
    const safeRecords = allRecords.filter(record => !packetIsLocalPhotoRecord(record));
    const firstSource = allRecords.find(record => record && record.source) || {};
    const products = new Map();
    allRecords.forEach(record => {
        const identity = record && record.identity && typeof record.identity === "object" ? record.identity : {};
        const spuIds = Array.isArray(identity.productIds) ? identity.productIds : [];
        spuIds.forEach(spuId => {
            const normalized = String(spuId || "").trim();
            if (!normalized || (allowedSpuIds && !allowedSpuIds.has(normalized))) return;
            const current = products.get(normalized) || {
                spuId: normalized,
                goodsId: "",
                productExtCodes: [],
                skuExtCodes: [],
                skcIds: [],
                skuIds: [],
                sources: []
            };
            const codes = packetCodesForSpu(record.payload, normalized);
            current.productExtCodes.push(...codes.productExtCodes);
            current.skuExtCodes.push(...codes.skuExtCodes);
            if (spuIds.length === 1 && Array.isArray(identity.goodsIds) && identity.goodsIds.length === 1) current.goodsId = String(identity.goodsIds[0] || "");
            if (spuIds.length === 1 && Array.isArray(identity.skcIds) && identity.skcIds.length === 1) current.skcIds.push(String(identity.skcIds[0] || ""));
            if (spuIds.length === 1 && Array.isArray(identity.skuIds) && identity.skuIds.length === 1) current.skuIds.push(String(identity.skuIds[0] || ""));
            current.sources.push(record.dataType || "unknown");
            products.set(normalized, current);
        });
    });
    return {
        schemaVersion: 5,
        kind: "full-capture-packet",
        exportedAt: new Date().toISOString(),
        purpose: "用于商品资料仓库存储和后续导入准备的完整采集包",
        exportMode: "full-capture",
        source: {
            platform: "temu",
            pageUrl: firstSource.source && firstSource.source.pageUrl || "",
            pageUrls: [...new Set(safeRecords.map(record => record && record.source && record.source.pageUrl).filter(Boolean))].slice(0, 20),
            // 来源店必须写进采集包，后续任务只能按这个紫鸟店铺 ID 认领，不能靠运营事后手选。
            shopName: String(options.shopName || options.sourceStoreName || "").trim(),
            sourceStoreId: String(options.sourceStoreId || "").trim(),
            sourceStoreName: String(options.sourceStoreName || options.shopName || "").trim(),
            pluginInstanceId: String(options.pluginInstanceId || "").trim(),
            pageStoreName: String(options.pageStoreName || options.shopName || "").trim(),
            scope: String(options.scope || "all-local-captured-records"),
            // 自动入库带上当前页 SPU 白名单，仓库解析 records 时不得再把其他页面商品写进本批次。
            allowedSpuIds: allowedSpuIds ? Array.from(allowedSpuIds) : undefined
        },
        counts: {
            capturedRecords: allRecords.length,
            records: safeRecords.length,
            ...(localOnlyRecords.length ? { localOnlyRecords: localOnlyRecords.length } : {}),
            productRecords: safeRecords.filter(record => record && (record.dataType === "product-list" || record.dataType === "product-detail")).length,
            products: products.size
        },
        products: Array.from(products.values()).map(product => ({
            ...product,
            productExtCodes: packetUnique(product.productExtCodes),
            skuExtCodes: packetUnique(product.skuExtCodes),
            skcIds: [...new Set(product.skcIds.filter(Boolean))],
            skuIds: [...new Set(product.skuIds.filter(Boolean))],
            sources: [...new Set(product.sources)]
        })),
        records: safeRecords,
        ...(localOnlyRecords.length ? { localOnlyRecords } : {})
    };
}
