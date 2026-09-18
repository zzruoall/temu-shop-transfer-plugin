/**
 * 用假平台运行时驱动页面侧的新增请求生成脚本，锁定“目标店要求但来源商品没有的字段”处理规则。
 * 线上曾因备货区域为空被平台以“Stocking Area Cannot Be Empty”整单拒绝，该规则必须有回归保护。
 * 这里不联网、不接触真实 Temu 页面，只验证脚本对平台返回值的处理逻辑。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(scriptsDir);
const preparePath = path.resolve(rootDir, "..", "worker", "direct-create-prepare.js");
const prepareSource = readFileSync(preparePath, "utf8");

/** VM 内产生的对象原型与宿主不同，比较前统一转成普通 JSON 结构。 */
function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * 假路由模块：生成脚本按源码文本特征定位创建路由并读取其依赖分块。
 * 因此这里把特征写在函数源码里，而不是在测试侧拼接字符串。
 */
function fakeCreateRouteModule() {
    /* productCreateEdit,load:()=>Promise.all([.e(11),.e(12)]),.e(7362) */
}

/**
 * 搭建最小假运行时：只实现生成脚本读取的模块。
 * 关键行为对齐真实平台——备货区域是否必填只有带产地国查询时才返回，不带产地时返回 null。
 */
function createHarness({
    storeRequiresInventoryRegion,
    sourceInventoryRegion,
    sourceOrigin = "CN",
    sourceManufacturingLocation = null,
    originQueryThrows = false,
    supplierConfigInventoryRegionRequired = null,
    targetProperties = null,
    storeRequiresCosmetic = false,
    converterRequest = null
}) {
    const configCalls = [];
    const requiredFlags = [];
    const store = {
        catId: 18813,
        originPropertyList: targetProperties || [{ refPid: 1, name: "成分", required: false }],
        rootSpecEnumList: [],
        sizeOrderConfig: {},
        categoryCommonConfig: {},
        packageInventoryFullHiddenInGray: false,
        isCosmeticRequire: storeRequiresCosmetic,
        setCatItemList() {},
        setIsCostume() {},
        setIsSemiManagedSupplier() {},
        setSupplierCurrencyInfo() {},
        setNeedOuterGoodsUrl() {},
        setInventoryRegionRequired(value) { requiredFlags.push(value); this.inventoryRegionRequired = value; },
        setCategoryCommonConfig(value) { this.categoryCommonConfig = value || {}; },
        setVisibleNetContent() {},
        setVisibleNetContentByCat() {},
        setPackageInventoryFullHiddenInGray(value) { this.packageInventoryFullHiddenInGray = Boolean(value); },
        setCosmeticInfo() {},
        initCosmeticByProductInfo() {},
        setProductSpecTableData() {},
        async getRenderPropertiesAndSpec() {}
    };
    const converter = {
        // 只复现与本次缺陷相关的映射：备货区域、产地、生产地。
        X9() {},
        FC(product) {
            return {
                inventoryRegion: sourceInventoryRegion,
                productOriginCode: sourceOrigin,
                manufacturingLocation: sourceManufacturingLocation,
                __product: product
            };
        },
        async hi({ value }) {
            if (converterRequest) return converterRequest(value);
            return {
                productName: "测试商品",
                carouselImageUrls: ["a"],
                productSkcReqs: [{ productSkuReqs: [{ thumbUrl: "https://example.invalid/a.jpg" }] }],
                productSaleExtAttrReq: {
                    bodyShape: null,
                    ...(value.inventoryRegion ? { inventoryRegion: value.inventoryRegion } : {}),
                    manufacturingLocation: Array.isArray(value.manufacturingLocation)
                        ? { region1ShortNames: [...value.manufacturingLocation] }
                        : {}
                }
            };
        }
    };
    const runtime = Object.assign(id => {
        if (id === 67464) return converter;
        if (id === 79099) return { jf: () => ({ isGrayReady: true, grayInfo: {}, isSemiManagedSupplier: false }) };
        if (id === 66291) return { e: function FormStore() { return store; } };
        if (id === 8887) {
            return {
                K: async request => {
                    configCalls.push(request);
                    // 真实平台的“是否必填”只有带产地国时才给出；不带产地时该字段恒为 null。
                    // 产地查询本身也可能失败，这里用抛错复现网络/接口异常。
                    if (request?.productOrigin) {
                        if (originQueryThrows) throw new Error("mock origin config failure");
                        return {
                            inventoryRegionRequired: storeRequiresInventoryRegion,
                            matchSemiManagedSupplier: false,
                            supplierCurrencyTypeVO: { currencyType: "USD" },
                            matchMarketSupplier: false
                        };
                    }
                    return {
                        inventoryRegionRequired: supplierConfigInventoryRegionRequired,
                        matchSemiManagedSupplier: false,
                        supplierCurrencyTypeVO: { currencyType: "USD" },
                        matchMarketSupplier: false
                    };
                }
            };
        }
        if (id === 91282) return { d: { c6d00c7c: 7, otherConfig: 3 } };
        if (id === 51327) return { I: async () => ({}) };
        if (id === 65060) return { pN: { a: 1 } };
        if (id === 94451) return { lW: async () => false };
        if (id === 38799) return { S: async () => ({}) };
        if (id === 73508) return { eq: () => [] };
        throw new Error(`未预期的模块：${id}`);
    }, { e: async () => {}, m: { 1: fakeCreateRouteModule } });
    // 页面用数组承接模块运行时回调；这里保留数组语义，只在 push 时把假运行时交给生成脚本。
    const chunks = [];
    const nativePush = Array.prototype.push;
    chunks.push = function (entry) {
        const callback = entry && entry[2];
        if (typeof callback === "function") callback(runtime);
        return nativePush.call(this, entry);
    };
    const context = {
        self: { chunkLoadingGlobal_temu_sca_goods: chunks },
        location: { hostname: "agentseller.temu.com", pathname: "/goods/list" },
        Error, Date, JSON, Promise, Number, Array, Object, String, Boolean, console
    };
    vm.createContext(context);
    const prepare = vm.runInNewContext(`(${prepareSource})`, context);
    return { prepare, store, configCalls, requiredFlags };
}

const sourceProduct = {
    productId: "9613037099",
    categories: { cat6: { catId: 18936 }, catType: 0 },
    productSkcList: [],
    carouselImageUrls: ["a"],
    productWhExtAttr: { productOrigin: { countryShortName: "CN" } }
};

// 一、目标店要求备货区域、来源商品为空：必须补默认一般仓库，并补生产地。
{
    const harness = createHarness({ storeRequiresInventoryRegion: true, sourceInventoryRegion: null });
    const result = await harness.prepare(sourceProduct);
    assert.deepEqual(plain(harness.requiredFlags), [true], "带产地的配置查询返回必填时，预检必须认定备货区域必填");
    assert.ok(harness.configCalls.some(call => call?.productOrigin?.countryShortName === "CN"), "备货区域必填性必须带产地国查询");
    assert.equal(result.request.productSaleExtAttrReq.inventoryRegion, 1, "来源为空时必须补一般仓库，否则平台会整单拒绝");
    assert.deepEqual(plain(result.request.productSaleExtAttrReq.manufacturingLocation), { region1ShortNames: ["CN"] }, "生产地必须补入产地国");
    assert.equal(plain(result.blockers).length, 0, "补齐后不应再留下阻断");
    assert.equal(result.notes.length, 2, "补齐动作必须留下可读说明");
}

// 二、来源商品自带保税仓：必须沿用来源值，不能被默认值覆盖。
{
    const harness = createHarness({ storeRequiresInventoryRegion: true, sourceInventoryRegion: 3 });
    const result = await harness.prepare(sourceProduct);
    assert.equal(result.request.productSaleExtAttrReq.inventoryRegion, 3, "来源已有备货区域时必须沿用");
    assert.equal(result.notes.some(note => note.includes("一般仓库")), false, "沿用来源值时不应记为默认补齐");
}

// 三、目标店不要求备货区域：不得凭空写入该字段。
{
    const harness = createHarness({ storeRequiresInventoryRegion: false, sourceInventoryRegion: null });
    const result = await harness.prepare(sourceProduct);
    assert.equal(harness.requiredFlags[0], false, "目标店不要求时不应认定必填");
    assert.equal("inventoryRegion" in result.request.productSaleExtAttrReq, false, "不要求时不能凭空补充备货区域");
}

// 四、已有生产地时必须去重，不能把同一产地写两遍。
{
    const harness = createHarness({ storeRequiresInventoryRegion: true, sourceInventoryRegion: 1, sourceManufacturingLocation: ["CN"] });
    const result = await harness.prepare(sourceProduct);
    assert.deepEqual(plain(result.request.productSaleExtAttrReq.manufacturingLocation), { region1ShortNames: ["CN"] }, "生产地重复值必须去重");
    assert.equal(result.notes.some(note => note.includes("生产地")), false, "无需补生产地时不应产生说明");
}

// 五、产地配置查询失败：不能被当成“该店不要求”，必须留下可读说明。
// 否则平台只会回报难以理解的 “Stocking Area Cannot Be Empty”，运营追不到真实原因。
{
    const harness = createHarness({ storeRequiresInventoryRegion: true, sourceInventoryRegion: null, originQueryThrows: true });
    const result = await harness.prepare(sourceProduct);
    assert.equal(harness.requiredFlags[0], false, "查询失败时无法确认必填性，不得据此认定必填");
    assert.equal("inventoryRegion" in result.request.productSaleExtAttrReq, false, "未被确认必填时不能凭空补充备货区域");
    assert.equal(result.notes.filter(note => /查询失败/.test(note)).length, 1, "查询失败必须留下且只留下一条说明");
    assert.equal(result.notes.some(note => note.includes("一般仓库")), false, "查询失败不等于已确认必填，不能顺手补一般仓库");
}

// 六、平台明确回复“不需要”：必须尊重该结论，不得写入备货区域。
{
    const harness = createHarness({ storeRequiresInventoryRegion: false, sourceInventoryRegion: null, supplierConfigInventoryRegionRequired: true });
    const result = await harness.prepare(sourceProduct);
    assert.equal(harness.requiredFlags[0], false, "带产地的明确回复为 false 时必须优先于不带产地的回退值");
    assert.equal("inventoryRegion" in result.request.productSaleExtAttrReq, false, "明确不需要时不能写入备货区域");
}

// 七、来源商品备货区域为 0（平台未使用该枚举值）：等同于空值，必须补有效的一般仓库。
{
    const harness = createHarness({ storeRequiresInventoryRegion: true, sourceInventoryRegion: 0 });
    const result = await harness.prepare(sourceProduct);
    assert.equal(result.request.productSaleExtAttrReq.inventoryRegion, 1, "0 不是有效仓库枚举，必须补一般仓库而不是原样提交");
}

// 八、来源列表属性缺失于转换器输出时，必须按目标模板补齐；只有完全无法核验的字段才允许继续阻断。
{
    const targetProperties = [
        { name: "香精浓度", refPid: 3703, pid: 1753, templatePid: 1734899, required: true, values: [{ vid: 472654, value: "香精浓度1-5%" }] },
        { name: "实物重量", refPid: 6174, pid: 1873, templatePid: 1734902, required: true, values: [{ vid: 117299, value: "≤100ml" }] },
        { name: "香味", refPid: 386, pid: 196, templatePid: 1734905, required: true, values: [{ vid: 4253, value: "玫瑰" }] },
        { name: "留香时长", refPid: 8129, pid: 2602, templatePid: 1734906, required: true, values: [{ vid: 472629, value: "6-8小时" }] }
    ];
    const attributeProduct = {
        productId: "340667734",
        categories: { cat4: { catId: 19225 }, catType: 0 },
        productPropertyList: [
            { refPid: 3703, propName: "香精浓度", vid: 63446, propValue: "香精浓度3-5%" },
            { refPid: 386, propName: "香味", vid: 4253, propValue: "玫瑰" }
        ],
        productNonAuditExtAttr: {
            cosmeticInfoVO: { propertyInfoList: [{ vid: 1000102331, valueName: null, langPromptMap: { en: "Water" } }] }
        },
        productSkcList: [{
            productSkuList: [{
                thumbUrl: "https://example.invalid/a.jpg",
                productSkuSpecList: [{ parentSpecName: "容量", specName: "15ml" }],
                productSkuNonAuditExtAttr: null
            }]
        }]
    };
    const harness = createHarness({
        storeRequiresInventoryRegion: false,
        sourceInventoryRegion: null,
        targetProperties,
        storeRequiresCosmetic: true,
        converterRequest: value => {
            const sourceSku = value.__product.productSkcList[0].productSkuList[0];
            const cosmetic = sourceSku.productSkuNonAuditExtAttr?.cosmeticInfo || [];
            return {
                productName: "测试香水",
                carouselImageUrls: ["a"],
                productPropertyReqs: [{ refPid: 3703, propName: "香精浓度", vid: 63446, propValue: "香精浓度3-5%", pid: 1753, templatePid: 969453 }],
                productSkcReqs: [{ productSkuReqs: [{
                    thumbUrl: sourceSku.thumbUrl,
                    productSkuNonAuditExtAttrReq: cosmetic.length ? { productSkuCosmeticInfoReqList: cosmetic } : {}
                }] }],
                productSaleExtAttrReq: {}
            };
        }
    });
    const result = await harness.prepare(attributeProduct);
    const properties = plain(result.request.productPropertyReqs);
    assert.deepEqual(
        properties.find(item => item.refPid === 3703),
        { refPid: 3703, propName: "香精浓度", vid: 472654, propValue: "香精浓度1-5%", numberInputValue: "", valueUnit: "", pid: 1753, templatePid: 1734899, valueExtendInfo: "" },
        "来源 3-5% 必须映射到目标完整覆盖区间 1-5%"
    );
    assert.equal(properties.find(item => item.refPid === 6174)?.propValue, "≤100ml", "15ml SKU 必须推导实物重量档位");
    assert.equal(properties.find(item => item.refPid === 386)?.propValue, "玫瑰", "转换器漏掉的香味必须按来源补齐");
    // 目标店"要哪些必填项"由平台回答：本地只记录可疑项，不再阻断上传。
    // 否则本地规则一旦比平台严，就会造出平台上并不存在的失败（例如把条件必填当无条件必填，
    // 让按摩油被要求填电池属性）。缺失项仍必须被记录下来，供排查与平台报错对照。
    assert.equal(result.blockers.length, 0, "本地不得因缺字段阻断上传，判断权交给平台");
    assert.equal(result.warnings.length, 1, "缺少来源值的留香时长仍必须被记录");
    assert.match(result.warnings[0], /留香时长/, "记录内容必须指向真正缺失的字段");
    assert.ok(result.notes.some(note => note.includes("留香时长")), "可疑项必须进入备注，运营才能看到缺了什么");
    assert.equal(result.request.productSkcReqs[0].productSkuReqs[0].productSkuNonAuditExtAttrReq.productSkuCosmeticInfoReqList[0].propertyInfoList[0].vid, 1000102331, "商品级成分必须下传到 SKU");
    assert.ok(result.notes.some(note => note.includes("香味=玫瑰")), "补齐字段必须写入可核验说明");
}

console.log("direct prepare field checks passed");
