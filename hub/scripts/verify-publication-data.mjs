/** 核对发布原始资料不被展示快照裁剪，空值、顺序和多 SKU 配方变化均参与版本计算。 */
import assert from "node:assert/strict";
import { parseImportedFiles } from "../lib/parse-capture.mjs";
import { canonicalProductSnapshot, makeProductVersion } from "../lib/job-queue.mjs";
const sourceProduct = {
    productId: 12345678, productName: "验证商品", categories: { cat1: { catId: 123 } },
    productPropertyList: [{ templatePid: 1, pid: 10, refPid: 20, vid: 30, propName: "格式", propValue: "液体", valueUnit: "" }],
    productSkcList: [{ productSkcId: 23456789, productSkuList: [1, 2].map(n => ({
        productSkuId: 34567890 + n,
        productSkuNonAuditExtAttr: { cosmeticInfo: [{ cosmeticEnName: `配方${n}`, propertyInfoList: [{ vid: n, valueName: null, langPromptMap: { en: `成分${n}` } }] }] },
        productSkuWhExtAttr: { productSkuVolume: { len: 154 }, productSkuWeight: { value: 230000 } }
    })) }]
};
const result = parseImportedFiles([{ originalName: "temu-full-capture-test.json", bytes: 1, payload: {
    kind: "full-capture-packet", exportMode: "full-capture", records: [
        { source: { requestUrl: "https://agentseller.temu.com/visage-agent-seller/product/skc/pageQuery" }, payload: { success: true, result: { total: 1, pageItems: [{
            productId: 12345678,
            goodsId: 87654321,
            productName: "验证商品",
            leafCat: { catId: 123, catName: "测试类目" },
            productProperties: [
                { templatePid: 1, pid: 10, refPid: 20, vid: 30, propName: "格式", propValue: "液体", valueUnit: "" },
                { templatePid: 2, pid: 11, refPid: 21, vid: 31, propName: "香味", propValue: "玫瑰", valueUnit: "" }
            ],
            productSkuSummaries: []
        }] } } },
        { source: { requestUrl: "https://agentseller.temu.com/visage-agent-seller/product/query" }, payload: { success: true, result: sourceProduct } }
    ]
} }]);
const product = result.products.find(p => p.spuId === "12345678");
assert.deepEqual(product.publicationData.sourceProduct.productSkcList, sourceProduct.productSkcList);
assert.ok(product.publicationData.sourceProduct.productPropertyList.some(item => item.propName === "香味" && item.propValue === "玫瑰" && item.refPid === 21 && item.vid === 31), "列表属性必须合并进发布资料");
assert.deepEqual(canonicalProductSnapshot(product).publicationData.sourceProduct, product.publicationData.sourceProduct);
const changed = structuredClone(product);
changed.publicationData.sourceProduct.productSkcList[0].productSkuList[1].productSkuNonAuditExtAttr.cosmeticInfo = [];
assert.notEqual(makeProductVersion(changed), makeProductVersion(product));
assert.equal(product.publicationData.validationState, "target-unverified");
console.log("publication data checks passed");
