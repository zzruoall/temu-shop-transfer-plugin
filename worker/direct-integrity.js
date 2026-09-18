/** 核对来源到请求及平台回查的关键字段；先按 SKC，再按规格关联 SKU，不依赖数组位置。 */
(function checkDirectIntegrity(source, request) {
    const text=value=>String(value??'').trim();
    // 平台转换器回传的规格字段是带 length/索引的类数组实例，Array.isArray 返回 false。
    // 只认真数组会把目标规格读成空集合，导致规格签名恒不相等，商品在没有内容差异时也被判失败。
    const asArray=value=>{
        if(Array.isArray(value))return value;
        if(!value||typeof value!=='object')return [];
        if(typeof value.length!=='number')return [];
        try{ return Array.from(value); }catch(_){ return []; }
    };
    const sourceSkcs=asArray(source?.productSkcList);
    const targetSkcs=asArray(request?.productSkcReqs);
    const specs=value=>asArray(value).map(spec=>String(spec?.specId)).sort();
    const skuSignature=sku=>JSON.stringify([text(sku?.extCode||sku?.skuExtCode),specs(sku?.productSkuSpecList||sku?.productSkuSpecReqs)]);
    const skcSignature=skc=>{
        const code=text(skc?.extCode||skc?.skcExtCode);
        if(code)return `code:${code}`;
        // 无商品/SKC 货号时才用该 SKC 下 SKU 的“货号+规格”特征稳定匹配，避免按数组顺序猜测。
        const skus=asArray(skc?.productSkuList).length?asArray(skc.productSkuList):asArray(skc?.productSkuReqs);
        return `skus:${skus.map(skuSignature).sort().join('|')}`;
    };
    if(sourceSkcs.length!==targetSkcs.length||!sourceSkcs.length)throw Error('SKC数量不一致');
    if(asArray(source.carouselImageUrls).length!==asArray(request.carouselImageUrls).length)throw Error('主图数量不一致');
    const targetBySkc=new Map();
    for(const target of targetSkcs) {
        const signature=skcSignature(target);
        if(targetBySkc.has(signature))throw Error('SKC规格对应关系不唯一');
        targetBySkc.set(signature,target);
    }
    for(const sourceSkc of sourceSkcs) {
        const targetSkc=targetBySkc.get(skcSignature(sourceSkc));
        if(!targetSkc)throw Error('SKC规格对应关系不唯一');
        const sourceCode=text(sourceSkc.extCode||sourceSkc.skcExtCode);
        const targetCode=text(targetSkc.extCode||targetSkc.skcExtCode);
        // 商品/SKC 货号必须原样传递；任一边缺失或不同都说明转换器改动了两级货号语义。
        if(sourceCode!==targetCode)throw Error('SKC货号未完整传递');
        const sourceSkus=asArray(sourceSkc.productSkuList);
        const targetSkus=asArray(targetSkc.productSkuReqs);
        if(sourceSkus.length!==targetSkus.length||!sourceSkus.length)throw Error('SKU数量不一致');
        const targetBySku=new Map();
        for(const targetSku of targetSkus) {
            const signature=skuSignature(targetSku);
            if(targetBySku.has(signature))throw Error('SKU规格对应关系不唯一');
            targetBySku.set(signature,targetSku);
        }
        for(const sku of sourceSkus) {
            const target=targetBySku.get(skuSignature(sku));
            if(!target)throw Error('SKU规格对应关系不唯一');
            if(text(sku.extCode||sku.skuExtCode)!==text(target.extCode||target.skuExtCode))throw Error('SKU货号未完整传递');
            if(Number(sku.supplierPrice)!==Number(target.supplierPrice)||!target.thumbUrl)throw Error('SKU价格或图片不一致');
            const from=sku.productSkuMultiPack?.productSkuNetContent;
            const to=target.productSkuMultiPackReq?.productSkuNetContentReq;
            if((from?.netContentNumber!=null||to?.netContentNumber!=null)&&(from?.netContentNumber==null||to?.netContentNumber==null||Number(from.netContentNumber)!==Number(to.netContentNumber)||Number(from.netContentUnitCode)!==Number(to.netContentUnitCode)))throw Error('SKU净含量未完整传递');
            // 成分允许从商品级下传到 SKU 级：来源 SKU 为空而商品级有成分时，目标请求带商品级成分是正确的，
            // 只比较 SKU 级会把“已按商品级补齐”误判成成分丢失。
            const groupIds=groups=>asArray(groups).flatMap(g=>asArray(g?.propertyInfoList).map(p=>String(p.vid))).filter(Boolean);
            const skuLevel=groupIds(sku.productSkuNonAuditExtAttr?.cosmeticInfo);
            // 商品级成分是单个 cosmeticInfoVO，下传时被包成一个分组；这里按同一语义取期望值。
            const productLevel=asArray(source.productNonAuditExtAttr?.cosmeticInfoVO?.propertyInfoList).map(p=>String(p.vid)).filter(Boolean);
            const expected=[...new Set(skuLevel.length?skuLevel:productLevel)].sort().join(',');
            if(expected!==[...new Set(groupIds(target.productSkuNonAuditExtAttrReq?.productSkuCosmeticInfoReqList))].sort().join(','))throw Error('SKU成分未完整传递');
        }
    }
    return true;
})
