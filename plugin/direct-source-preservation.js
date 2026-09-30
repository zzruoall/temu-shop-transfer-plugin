"use strict";

/** 只比较来源已经存在的业务值，不规定商品必须有哪些字段，不替平台判断发布资格。 */
window.__temuSourcePreservation = function preserveSourceValues(source, request) {
    const array = value => Array.isArray(value) ? value : value && typeof value.length === 'number' ? Array.from(value) : [];
    const text = value => String(value ?? '').trim();
    const present = value => value !== null && value !== undefined && text(value) !== '';
    const fail = field => { throw Error(`来源字段在转换中丢失或改变：${field}`); };
    const same = (from, to, label, numeric = false) => {
        if (!present(from)) return;
        if (!present(to) || (numeric ? Number(from) !== Number(to) : text(from) !== text(to))) fail(label);
    };
    const contains = (from, to, label) => {
        const target = new Set(array(to).map(text));
        if (array(from).some(value => present(value) && !target.has(text(value)))) fail(label);
    };
    if (!request || typeof request !== 'object') fail('新增请求');
    same(source?.productName, request.productName, '商品名称');
    contains(source?.carouselImageUrls, request.carouselImageUrls, '商品主图');
    const specs = sku => array(sku.productSkuSpecList || sku.productSkuSpecReqs).map(spec => text(spec.specId)).sort().join('|');
    const skuKey = sku => JSON.stringify([text(sku.extCode || sku.skuExtCode), specs(sku)]);
    const skus = skc => array(skc.productSkuList || skc.productSkuReqs);
    const skcKey = skc => text(skc.extCode || skc.skcExtCode) || skus(skc).map(skuKey).sort().join('|');
    const sourceSkcs = array(source?.productSkcList), targetSkcs = array(request.productSkcReqs);
    if (sourceSkcs.length && sourceSkcs.length !== targetSkcs.length) fail('SKC数量');
    /** 一对一消费匹配项，重复签名不复用同一目标；不按数组排序猜测规格对应。 */
    const take = (items, key, keyOf, label) => {
        const index = items.findIndex(item => keyOf(item) === key);
        if (index < 0) fail(label);
        return items.splice(index, 1)[0];
    };
    const ingredients = groups => array(groups).flatMap(group => array(group?.propertyInfoList).map(item => text(item.vid))).filter(Boolean);
    const productCosmetic = source?.productNonAuditExtAttr?.cosmeticInfoVO || source?.productNonAuditExtAttr?.cosmeticInfo || source?.cosmeticInfoVO;
    const remaining = [...targetSkcs];
    for (const fromSkc of sourceSkcs) {
        const toSkc = take(remaining, skcKey(fromSkc), skcKey, 'SKC货号或规格');
        same(fromSkc.extCode || fromSkc.skcExtCode, toSkc.extCode || toSkc.skcExtCode, '商品货号');
        const sourceSkus = skus(fromSkc), remainingSkus = [...skus(toSkc)];
        if (sourceSkus.length && sourceSkus.length !== remainingSkus.length) fail('SKU数量');
        for (const from of sourceSkus) {
            const to = take(remainingSkus, skuKey(from), skuKey, 'SKU货号或规格');
            same(from.supplierPrice, to.supplierPrice, 'SKU价格', true);
            same(from.thumbUrl, to.thumbUrl, 'SKU图片');
            const net = from.productSkuMultiPack?.productSkuNetContent;
            const targetNet = to.productSkuMultiPackReq?.productSkuNetContentReq;
            same(net?.netContentNumber, targetNet?.netContentNumber, 'SKU净含量', true);
            same(net?.netContentUnitCode, targetNet?.netContentUnitCode, 'SKU净含量单位', true);
            const skuIngredients = ingredients(from.productSkuNonAuditExtAttr?.cosmeticInfo);
            contains(skuIngredients.length ? skuIngredients : ingredients(productCosmetic ? [productCosmetic] : []),
                ingredients(to.productSkuNonAuditExtAttrReq?.productSkuCosmeticInfoReqList), 'SKU成分');
        }
    }
    return true;
};
