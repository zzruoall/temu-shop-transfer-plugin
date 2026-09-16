/** 构建产物：页面固定商品转换与完整性检查，无云仓令牌。 */
window.__temuDirectPrepare=/** 列表页无界面生成新增请求；只读取目标店模板，不创建草稿、不提交商品。 */
(async function prepareDirectCreate(source) {
    let runtime;
    const text = value => String(value ?? "").trim();
    const clone = value => JSON.parse(JSON.stringify(value));
    const normalizedName = value => text(value).replace(/\s+/g, "").toLowerCase();
    // 列表接口和详情接口会把同一属性放在不同字段里；统一成一种结构后再按目标模板匹配，
    // 这样历史任务只保存 name/value 摘要时也能补齐，不依赖某个商品的固定字段位置。
    const collectSourceProperties = product => {
        const rows = [
            ...(Array.isArray(product.productPropertyList) ? product.productPropertyList : []),
            ...(Array.isArray(product.productProperties) ? product.productProperties : []),
            ...(Array.isArray(product.attributes) ? product.attributes : [])
        ];
        return rows.map(item => ({
            templatePid: item?.templatePid,
            pid: item?.pid,
            refPid: item?.refPid,
            vid: item?.vid,
            propName: text(item?.propName || item?.propertyName || item?.attributeName || item?.name),
            propValue: text(item?.propValue || item?.propertyValue || item?.attributeValue || item?.value),
            valueUnit: text(item?.valueUnit || item?.unit),
            valueExtendInfo: text(item?.valueExtendInfo),
            numberInputValue: text(item?.numberInputValue)
        })).filter(item => item.propName && item.propValue);
    };
    const parseRange = value => {
        const match = text(value).match(/(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*%/);
        return match ? { min: Number(match[1]), max: Number(match[2]) } : null;
    };
    const selectTargetOption = (targetProperty, sourceProperty) => {
        const values = Array.isArray(targetProperty.values) ? targetProperty.values : [];
        const sourceVid = Number(sourceProperty?.vid);
        const sourceValue = normalizedName(sourceProperty?.propValue);
        if (Number.isFinite(sourceVid)) {
            const byVid = values.find(option => Number(option.vid) === sourceVid);
            if (byVid) return byVid;
        }
        const byValue = values.find(option => normalizedName(option.value) === sourceValue);
        if (byValue) return byValue;
        // 来源店和方向店的香精浓度分档不完全相同，例如来源“3-5%”落在目标“1-5%”档内。
        // 只在目标档完整覆盖来源区间时映射，避免把具体浓度夸大到更高档位。
        if (targetProperty.name === "香精浓度") {
            const sourceRange = parseRange(sourceProperty?.propValue);
            if (sourceRange) {
                return values.map(option => ({ option, range: parseRange(option.value) }))
                    .filter(item => item.range && item.range.min <= sourceRange.min && item.range.max >= sourceRange.max)
                    .sort((left, right) => (left.range.max - left.range.min) - (right.range.max - right.range.min))[0]?.option || null;
            }
        }
        return null;
    };
    // 实物重量是目标类目的商品级必填项，但来源商品可能只在 SKU 容量里写“15ml”。
    // 只有全部 SKU 都是同一种明确计量单位时才推断档位，混合规格或无法解析时保留阻断。
    const deriveTargetOption = (targetProperty, product) => {
        if (targetProperty.name !== "实物重量") return null;
        const values = Array.isArray(targetProperty.values) ? targetProperty.values : [];
        const measures = (product.productSkcList || []).flatMap(skc => (skc.productSkuList || []))
            .flatMap(sku => (sku.productSkuSpecList || []).map(spec => text(spec.specName)))
            .map(value => {
                const match = value.match(/(\d+(?:\.\d+)?)\s*(ml|毫升|g|克)\b/i);
                if (!match) return null;
                return { value: Number(match[1]), unit: /ml|毫升/i.test(match[2]) ? "ml" : "g" };
            }).filter(Boolean);
        if (!measures.length || measures.some(item => item.unit !== measures[0].unit)) return null;
        const max = Math.max(...measures.map(item => item.value));
        const wanted = measures[0].unit === "ml"
            ? (max <= 100 ? "≤100ml" : ">100ml")
            : (max <= 300 ? "≤300g" : ">300g");
        return values.find(option => normalizedName(option.value) === normalizedName(wanted)) || null;
    };
    // 商品级成分在部分来源详情中存在，但 SKU 级字段为空；目标类的提交接口只读取 SKU 级成分，
    // 因此在不修改成分 ID 的前提下下传到每个 SKU，避免把平台已有数据误报成缺失。
    const inheritProductCosmeticInfo = product => {
        const cosmeticInfoVO = product.productNonAuditExtAttr?.cosmeticInfoVO
            || product.productNonAuditExtAttr?.cosmeticInfo
            || product.cosmeticInfoVO;
        if (!Array.isArray(cosmeticInfoVO?.propertyInfoList) || !cosmeticInfoVO.propertyInfoList.length) return false;
        let inherited = false;
        for (const skc of product.productSkcList || []) {
            for (const sku of skc.productSkuList || []) {
                const current = sku.productSkuNonAuditExtAttr || {};
                if (Array.isArray(current.cosmeticInfo) && current.cosmeticInfo.length) continue;
                sku.productSkuNonAuditExtAttr = { ...current, cosmeticInfo: [clone(cosmeticInfoVO)] };
                inherited = true;
            }
        }
        return inherited;
    };
    // 转换器会按当前页面模板生成请求，但列表摘要和历史快照可能缺少目标模板编号，
    // 或对“香味”等多选属性静默丢弃。这里按来源明确值、目标模板值双重校验后补齐/校正。
    const applyRequiredPropertyMappings = (request, store, product, notes, targetPropertyTemplate) => {
        const sourceProperties = collectSourceProperties(product);
        // 生成请求的转换器会消费并清空部分模板值，必须用查询后的独立快照做映射，
        // 否则“香味”等字段在生成结束后已看不到可选项，即使来源和目标值完全相同也无法补齐。
        const targetProperties = (targetPropertyTemplate || []).filter(item => item.required);
        const requestProperties = Array.isArray(request.productPropertyReqs) ? request.productPropertyReqs : [];
        for (const targetProperty of targetProperties) {
            const sourceProperty = sourceProperties.find(item => item.refPid != null && String(item.refPid) === String(targetProperty.refPid))
                || sourceProperties.find(item => normalizedName(item.propName) === normalizedName(targetProperty.name));
            const option = sourceProperty
                ? selectTargetOption(targetProperty, sourceProperty)
                : deriveTargetOption(targetProperty, product);
            if (!option) continue;
            const mapped = {
                refPid: targetProperty.refPid,
                propName: targetProperty.name,
                vid: option.vid,
                propValue: option.value,
                numberInputValue: "",
                valueUnit: "",
                pid: targetProperty.pid,
                templatePid: targetProperty.templatePid,
                valueExtendInfo: ""
            };
            const index = requestProperties.findIndex(item => String(item.refPid) === String(targetProperty.refPid));
            if (index < 0) {
                requestProperties.push(mapped);
                notes.push(`已按来源资料补齐目标属性：${targetProperty.name}=${option.value}`);
            } else if (String(requestProperties[index].templatePid) !== String(targetProperty.templatePid)
                || String(requestProperties[index].pid) !== String(targetProperty.pid)
                || String(requestProperties[index].vid) !== String(option.vid)) {
                requestProperties[index] = { ...requestProperties[index], ...mapped };
                notes.push(`已按目标模板校正来源属性：${targetProperty.name}=${option.value}`);
            }
        }
        request.productPropertyReqs = requestProperties;
    };
    const chunks = self.chunkLoadingGlobal_temu_sca_goods;
    if (!Array.isArray(chunks) || location.hostname !== "agentseller.temu.com" || location.pathname !== "/goods/list") throw Error("unsupported_page");
    // 备货区域的平台取值：1=一般仓库、3=保税仓库。两者物流路径不同，不能互相替代。
    const GENERAL_WAREHOUSE_REGION = 1;
    chunks.push([[`prepare-${Date.now()}`], {}, value => { runtime = value; }]);
    // 依赖清单来自当前页面的 productCreateEdit 路由，只加载代码，不执行页面挂载函数。
    const route = Object.values(runtime.m).map(String).find(text => text.includes(".e(7362)") && text.includes("productCreateEdit"));
    const block = route?.match(/productCreateEdit,load:\(\)=>Promise\.all\(\[([^\]]+)\]/)?.[1];
    if (!block) throw Error("create_route_changed");
    const dependencies = [...block.matchAll(/\.e\((\d+)\)/g)].map(match => Number(match[1]));
    await Promise.all(dependencies.map(id => runtime.e(id)));
    const converter = runtime(67464);
    const global = runtime(79099).jf();
    if (!global?.isGrayReady || !global.grayInfo) throw Error("target_config_not_ready");
    if (global.isSemiManagedSupplier) throw Error("semi_managed_not_validated");
    const product = clone(source);
    const inheritedCosmeticInfo = inheritProductCosmeticInfo(product);
    converter.X9({ productInfo: product, matchSupportPersonalization: false, isSupportPersonalizationCat: false });
    delete product.supplierId;
    if (product.productSaleExtAttr) delete product.productSaleExtAttr.productShipment;
    const categories = Object.entries(product.categories || {}).filter(([key]) => /^cat\d+$/.test(key)).sort(([a],[b]) => Number(a.slice(3))-Number(b.slice(3))).map(([,value]) => value).filter(value => value.catId);
    if (!categories.length) throw Error("category_missing");
    const store = new (runtime(66291).e)();
    store.setCatItemList(categories);
    store.setIsCostume(product.categories.catType);
    store.setIsSemiManagedSupplier(false);
    const supplierConfig = await runtime(8887).K({configItems:Object.values(runtime(91282).d).filter(value=>typeof value==="number")});
    if (supplierConfig.matchSemiManagedSupplier) throw Error("semi_managed_not_validated");
    store.setSupplierCurrencyInfo(supplierConfig.supplierCurrencyTypeVO || {});
    store.setNeedOuterGoodsUrl(Boolean(supplierConfig.matchMarketSupplier));
    // 目标页只有在选定产地国后才会带上产地查询“备货区域是否必填”；不带产地时该字段恒为 null，
    // 会让目标店实际必填的备货区域被判为不需要，进而生成缺字段的请求。
    // 这里复用同一份配置项，只额外带上产地，避免按中文标签去猜配置项编号。
    const originCountry = product.productWhExtAttr?.productOrigin?.countryShortName;
    // 查询失败与“平台明确回答不需要”是两件事：只有拿到返回值才能据此判断必填性，
    // 因此单独记住失败状态，避免网络抖动被静默当成“该店不要求备货区域”。
    let originConfigFailed = false;
    const originConfig = originCountry
        ? await runtime(8887).K({
            configItems:Object.values(runtime(91282).d).filter(value=>typeof value==="number"),
            productOrigin:{countryShortName:originCountry}
        }).catch(() => { originConfigFailed = true; return null; })
        : null;
    const inventoryRegionRequired = Boolean(originConfig?.inventoryRegionRequired ?? supplierConfig.inventoryRegionRequired);
    store.setInventoryRegionRequired(inventoryRegionRequired);
    const categoryConfig = await runtime(51327).I({leafCatId:store.catId,configItems:Object.values(runtime(65060).pN).filter(value=>typeof value==="number")});
    store.setCategoryCommonConfig(categoryConfig || {});
    store.setVisibleNetContent(Boolean(categoryConfig.matchNetContentRequired));
    store.setVisibleNetContentByCat(Boolean(categoryConfig.matchNetContentRequired));
    store.setPackageInventoryFullHiddenInGray(await runtime(94451).lW({isSemiManagedSupplier:false}));
    // 构造独立内存数据容器，避免改变运营当前页面或从 DOM 读取表单。
    let values = {};
    store.formApi = { getValues: () => values, getFieldValue: key => values[key], setPartialValues: value => { Object.assign(values, value); }, setFieldValue: (key,value) => { values[key] = value; } };
    await store.getRenderPropertiesAndSpec(store.catId);
    if (!store.originPropertyList.length) throw Error("target_property_template_missing");
    const targetPropertyTemplate = clone(store.originPropertyList);
    store.sourceProductInfo = product;
    // 是否要求成分由目标类目接口决定；仅复制成分词典会导致提交转换器静默丢弃成分。
    const cosmetic = await runtime(38799).S({ catId: store.catId, isSemiManaged: false }, { skipCheck: true });
    store.setCosmeticInfo(cosmetic || {});
    store.initCosmeticByProductInfo(product);
    values = converter.FC(product, store, global.grayInfo, ["common"], {});
    const notes = [];
    // 必填性查询失败时请求会按“不要求”生成；不写说明的话，平台只会回报难以理解的
    // “Stocking Area Cannot Be Empty”，运营无法追到真实原因。
    if (originConfigFailed) notes.push(`目标店备货区域必填性查询失败（产地 ${originCountry}），已按“该店不要求”生成请求`);
    // 备货区域属于目标店配置要求，来源店同款商品可能整段为空；不补齐时平台会以
    // “Stocking Area Cannot Be Empty”整单拒绝，而运营从错误文本看不出是哪个店级要求。
    if (store.inventoryRegionRequired && !Number(values.inventoryRegion)) {
        const inherited = Number(product.productSaleExtAttr?.inventoryRegion);
        values.inventoryRegion = inherited || GENERAL_WAREHOUSE_REGION;
        notes.push(inherited ? `备货区域沿用来源商品（${inherited}）` : `目标店要求备货区域，来源商品为空，已按一般仓库（${GENERAL_WAREHOUSE_REGION}）提交`);
    }
    // 表单选择产地国后会自动把该产地并入生产地列表；绕过表单生成请求时必须复现这一步，
    // 否则请求里的生产地为空，同样会被平台判为必填缺失。
    const originForLocation = values.productOriginCode || originCountry;
    if (originForLocation) {
        const locations = Array.isArray(values.manufacturingLocation) ? values.manufacturingLocation : [];
        if (!locations.includes(originForLocation)) {
            values.manufacturingLocation = [...locations, originForLocation];
            notes.push(`生产地已补入产地 ${originForLocation}`);
        }
    }
    store.setProductSpecTableData(runtime(73508).eq(values, store.rootSpecEnumList, store.sizeOrderConfig));
    const request = await converter.hi({ value: values, formStore: store, grayInfo: global.grayInfo, needSkcAndSkuId: false });
    applyRequiredPropertyMappings(request, store, product, notes, targetPropertyTemplate);
    if (inheritedCosmeticInfo) notes.push("已将商品级成分下传到每个 SKU");
    if (!request.productName || !request.productSkcReqs?.length) throw Error("request_incomplete");
    // 模板查询成功不等于可创建：不能用接口绕过必填项或替用户声明商品合规。
    const blockers = [];
    for (const property of store.originPropertyList.filter(item => item.required)) {
        if (!request.productPropertyReqs?.some(item => item.refPid === property.refPid)) blockers.push(`缺少必填属性：${property.name}`);
    }
    for (const skc of request.productSkcReqs) for (const sku of skc.productSkuReqs || []) {
        if (!sku.thumbUrl) blockers.push("SKU 图片缺失");
        if (!store.packageInventoryFullHiddenInGray && store.categoryCommonConfig.matchSkuAccessoriesRequired && !sku.productSkuAccessoriesReq) blockers.push("目标类目要求 SKU 配件信息，但当前提交资料没有此字段");
        if (store.isCosmeticRequire && !sku.productSkuNonAuditExtAttrReq?.productSkuCosmeticInfoReqList?.length) blockers.push("目标类目要求成分信息，但转换后的请求没有成分");
    }
    // chrome.scripting.executeScript 只能回传可结构化克隆的数据；store/values 含实例方法和循环引用，
    // 只留在页面预检内部使用。把它们一起返回会让整次注入结果无法回传，表现为“页面未返回结果”。
    return { request, blockers, notes, requiresComplianceConfirmation: Boolean(request.productComplianceStatementReq) };
})
;
window.__temuDirectCheck=/** 核对来源到请求及平台回查的关键字段；先按 SKC，再按规格关联 SKU，不依赖数组位置。 */
(function checkDirectIntegrity(source, request) {
    const text=value=>String(value??'').trim();
    const sourceSkcs=Array.isArray(source?.productSkcList)?source.productSkcList:[];
    const targetSkcs=Array.isArray(request?.productSkcReqs)?request.productSkcReqs:[];
    const specs=value=>(Array.isArray(value)?value:[]).map(spec=>String(spec?.specId)).sort();
    const skuSignature=sku=>JSON.stringify([text(sku?.extCode||sku?.skuExtCode),specs(sku?.productSkuSpecList||sku?.productSkuSpecReqs)]);
    const skcSignature=skc=>{
        const code=text(skc?.extCode||skc?.skcExtCode);
        if(code)return `code:${code}`;
        // 无商品/SKC 货号时才用该 SKC 下 SKU 的“货号+规格”特征稳定匹配，避免按数组顺序猜测。
        const skus=Array.isArray(skc?.productSkuList||skc?.productSkuReqs)?(skc.productSkuList||skc.productSkuReqs):[];
        return `skus:${skus.map(skuSignature).sort().join('|')}`;
    };
    if(sourceSkcs.length!==targetSkcs.length||!sourceSkcs.length)throw Error('SKC数量不一致');
    if((source.carouselImageUrls||[]).length!==(request.carouselImageUrls||[]).length)throw Error('主图数量不一致');
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
        const sourceSkus=Array.isArray(sourceSkc.productSkuList)?sourceSkc.productSkuList:[];
        const targetSkus=Array.isArray(targetSkc.productSkuReqs)?targetSkc.productSkuReqs:[];
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
            const ingredientIds=groups=>(groups||[]).flatMap(g=>(g.propertyInfoList||[]).map(p=>String(p.vid))).sort().join(',');
            const original=ingredientIds(sku.productSkuNonAuditExtAttr?.cosmeticInfo);
            if(original!==ingredientIds(target.productSkuNonAuditExtAttrReq?.productSkuCosmeticInfoReqList))throw Error('SKU成分未完整传递');
        }
    }
    return true;
})
;
