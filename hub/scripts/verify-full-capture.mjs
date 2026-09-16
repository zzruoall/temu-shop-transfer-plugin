/**
 * 核对解析硬规则：SKU 必须挂回同一行 SPU，空标记不能当详情。
 * 不入库、不改 data/。通用 verify 只用仓库内 fixtures 和内联完整包，不读用户 Downloads。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hasRealProductDetail, parseImportedFiles } from "../lib/parse-capture.mjs";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = [
    "temu-capture-logs-2026-08-19T05-50-27-103Z.json",
    "temu-dataset-2026-08-19T05-51-14-255Z.json",
    "temu-page-structure-2026-08-19T05-51-28-944Z.json"
].map((name) => path.join(rootDir, "fixtures", name));

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

function parseFile(filePath) {
    return {
        originalName: path.basename(filePath),
        payload: JSON.parse(fs.readFileSync(filePath, "utf8")),
        bytes: 1
    };
}

assert(hasRealProductDetail({ hasDetailVideo: false, guideFileAttribute: {} }) === false, "假详情未拒绝");
assert(hasRealProductDetail({ description: "这是一段商品详情正文内容" }) === true, "真详情未被识别");
assert(hasRealProductDetail({ sellingpoint: "热卖推荐" }) === false, "列表卖点不能当详情");

// 内联列表包覆盖图片、规格、详情假阳性；14 件实测包改由 verify-full-capture-live.mjs 在有下载文件时跑。
const parsed = parseImportedFiles([{
    originalName: "temu-full-capture-inline.json",
    payload: {
        kind: "full-capture-packet",
        exportMode: "full-capture",
        records: [{
            payload: {
                result: {
                    pageItems: [
                        {
                            productId: 7744886733,
                            goodsId: 9001,
                            productSkcId: 36188760559,
                            productName: "香水",
                            mainImageUrl: "https://img.example.com/0d2a1749.jpg",
                            hasDetailVideo: false,
                            guideFileAttribute: {},
                            productSkuSummaries: [{
                                productSkuId: 79322547323,
                                thumbUrl: "https://img.example.com/sku-10ml.jpg",
                                productSkuSpecList: [{ parentSpecName: "规格", specName: "10ml" }]
                            }]
                        },
                        {
                            productId: 3714507798,
                            goodsId: 9002,
                            productSkcId: 22,
                            productName: "多SKU",
                            mainImageUrl: "https://img.example.com/multi.jpg",
                            productSkuSummaries: [
                                { productSkuId: 201 },
                                { productSkuId: 202 },
                                { productSkuId: 203 }
                            ]
                        }
                    ]
                }
            }
        }]
    },
    bytes: 1
}]);
const perfume = parsed.products.find((item) => item.spuId === "7744886733");
const multi = parsed.products.find((item) => item.spuId === "3714507798");
assert(parsed.counts.spu === 2, `SPU 应为 2，实际 ${parsed.counts.spu}`);
assert(parsed.counts.goods === 2, `goods 应为 2，实际 ${parsed.counts.goods}`);
assert(parsed.counts.skc === 2, `SKC 应为 2，实际 ${parsed.counts.skc}`);
assert(parsed.counts.sku === 4, `SKU 应为 4，实际 ${parsed.counts.sku}`);
assert(parsed.counts.ready === 0, "列表包不能进入映射");
assert(parsed.status === "packet-incomplete", `状态应为 packet-incomplete，实际 ${parsed.status}`);
assert(perfume && perfume.skuIds.join(",") === "79322547323", "香水 SKU 挂错");
assert(perfume.skus[0].specs[0].value === "10ml", "香水规格未还原");
assert(perfume.images.some((url) => url.includes("0d2a1749")), "主图未还原");
assert(perfume.completeness.hasDetail === false, "空标记被当成详情");
assert(multi.skuIds.length === 3, "多 SKU 商品未全部挂回");

const allowlist = parseImportedFiles([{
    originalName: "allowlist.json",
    payload: {
        kind: "full-capture-packet",
        source: { allowedSpuIds: ["1"] },
        products: [{ spuId: "1" }, { spuId: "2" }],
        records: [{
            payload: {
                result: {
                    pageItems: [
                        { productId: 1, goodsId: 11, productSkcId: 21, productName: "A", productSkuSummaries: [{ productSkuId: 101 }] },
                        { productId: 2, goodsId: 12, productSkcId: 22, productName: "B", productSkuSummaries: [{ productSkuId: 201 }] }
                    ]
                }
            }
        }]
    },
    bytes: 1
}]);
assert(allowlist.products.length === 1 && allowlist.products[0].spuId === "1", "当前页 SPU 白名单未过滤其他商品");

const neighbor = parseImportedFiles([{
    originalName: "neighbor.json",
    payload: {
        kind: "full-capture-packet",
        records: [{
            payload: {
                result: {
                    pageItems: [
                        { productId: 1, goodsId: 11, productSkcId: 21, productName: "A", productSkuSummaries: [{ productSkuId: 101 }] },
                        { productId: 2, goodsId: 12, productSkcId: 22, productName: "B", productSkuSummaries: [{ productSkuId: 201 }, { productSkuId: 202 }] }
                    ]
                }
            }
        }]
    },
    bytes: 1
}]);
assert(neighbor.products.find((item) => item.spuId === "1").skuIds.join(",") === "101", "邻行 SKU 串到了第一件商品");
assert(neighbor.products.find((item) => item.spuId === "2").skuIds.join(",") === "201,202", "多 SKU 未留在同一 SPU");

const identityOnly = parseImportedFiles([{
    originalName: "identity.json",
    payload: {
        kind: "full-capture-packet",
        records: [{ identity: { productIds: ["9"], goodsIds: ["90"], skuIds: ["111", "222"] }, payload: { result: { supplierAllowDecreaseStock: true } } }]
    },
    bytes: 1
}]);
assert((identityOnly.products[0].skuIds || []).length === 0, "identity 回退不应吞整包 SKU");

// 详情接口可能只在编辑页 URL 提供 SPU，正文和图片仍必须归入该商品。
const detailByPageContext = parseImportedFiles([{
    originalName: "detail-page-context.json",
    payload: {
        kind: "full-capture-packet",
        source: { pageUrl: "https://agentseller.temu.com/goods/edit" },
        records: [{
            dataType: "product-detail",
            identity: { productIds: ["1234567890"], goodsIds: ["555555555"], skcIds: [], skuIds: [] },
            source: { pageProductId: "1234567890", pageUrl: "https://agentseller.temu.com/goods/edit", requestUrl: "https://agentseller.temu.com/visage-agent-seller/product/query" },
            payload: { result: { productName: "详情商品", descriptionHtml: "<p>完整详情正文</p>", content: "<img src=\"https://img.example.com/detail.png\">" } }
        }]
    },
    bytes: 1
}]);
const contextProduct = detailByPageContext.products[0];
assert(contextProduct && contextProduct.spuId === "1234567890", "详情页上下文未建立 SPU 归属");
assert(contextProduct.completeness.hasDetail, "详情页正文未解析");
assert(contextProduct.images.some((url) => url.includes("detail.png")), "详情 HTML 图片未解析");

// 编辑页规格接口可能不重复 SPU，只带 skuList/variants；只要同一条响应
// 有 pageProductId，就应把规格和 SKU 合并回该 SPU，不能因字段改名而丢失。
const detailSkuList = parseImportedFiles([{
    originalName: "detail-sku-list.json",
    payload: {
        kind: "full-capture-packet",
        records: [{
            dataType: "product-detail",
            identity: { productIds: ["1234567890"] },
            source: { pageProductId: "1234567890", pageUrl: "https://agentseller.temu.com/goods/edit" },
            payload: { result: { skuList: [{ id: "sku-1", skuCode: "RED", price: 12, specList: [{ name: "颜色", value: "红" }], imageUrl: "https://img.example.com/red.png" }] } }
        }]
    },
    bytes: 1
}]);
const detailSkuProduct = detailSkuList.products[0];
assert(detailSkuProduct && detailSkuProduct.skuIds.includes("sku-1"), "编辑页 skuList 未合并");
assert(detailSkuProduct.skus[0] && detailSkuProduct.skus[0].specs[0].value === "红", "编辑页 SKU 规格未还原");
assert(detailSkuProduct.images.some((url) => url.includes("red.png")), "编辑页 SKU 图片未提取");

// product/query 是本轮浏览器实测到的编辑页主接口。它可能没有 goodsId，且 SKU 使用 productSkuMap；
// 只要标题、SKU、图片和图文详情齐全，就应可进入后续映射，不能被非必要 goodsId 阻断。
const temuProductQuery = parseImportedFiles([{
    originalName: "temu-product-query.json",
    payload: {
        kind: "full-capture-packet",
        records: [{
            dataType: "product-detail",
            identity: { productIds: ["4764369705"] },
            source: {
                pageProductId: "4764369705",
                pageUrl: "https://agentseller.temu.com/goods/edit?productId=4764369705",
                requestUrl: "https://agentseller.temu.com/visage-agent-seller/product/query"
            },
            payload: {
                result: {
                    productId: "4764369705",
                    productName: "接口详情测试商品",
                    productSkcList: [{
                        productSkuMap: {
                            red: {
                                productSkuId: "92333181434",
                                skuCode: "RED",
                                productSkuSpecList: [{ parentSpecName: "颜色", specName: "红色" }],
                                skuImageUrl: "https://img.example.com/red-main.jpg"
                            }
                        }
                    }],
                    carouselImgsI18n: { zh: [{ url: "https://img.example.com/main.jpg" }] },
                    decoration: [{ content: "<p>商品详情<img src=\"https://img.example.com/detail.jpg\"></p>" }]
                }
            }
        }]
    },
    bytes: 1
}]);
const queryProduct = temuProductQuery.products[0];
assert(queryProduct && queryProduct.spuId === "4764369705", "product/query 未归属到编辑页 SPU");
assert(queryProduct.skuIds.includes("92333181434"), "productSkuMap 中的 SKU 未解析");
assert(queryProduct.skus[0].specs[0].value === "红色", "productSkuMap 规格未解析");
assert(queryProduct.images.some((url) => url.includes("main.jpg")) && queryProduct.images.some((url) => url.includes("detail.jpg")), "product/query 图片未解析");
assert(queryProduct.ready, "缺少 goodsId 的完整 product/query 不应被阻断");

const logs = parseImportedFiles(fixtures.map(parseFile));
assert(logs.counts.spu === 14 && logs.counts.sku === 17, "旧日志回归失败");
assert(logs.status === "sample-verified", `旧日志状态回归失败：${logs.status}`);

console.log("full-capture parser checks passed");
