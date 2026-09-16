/**
 * 用本机 Downloads 里的实测完整包核对 14 件商品的解析结果。
 * 文件不存在时跳过，不阻断通用 npm run verify。
 */
import fs from "node:fs";
import path from "node:path";
import { parseImportedFiles } from "../lib/parse-capture.mjs";

const fullPacket = path.join("C:", "Users", "27117", "Downloads", "temu-full-capture-2026-08-19T08-06-53-053Z.json");

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

if (!fs.existsSync(fullPacket)) {
    console.log("full-capture live checks skipped: missing", fullPacket);
    process.exit(0);
}

const parsed = parseImportedFiles([{
    originalName: path.basename(fullPacket),
    payload: JSON.parse(fs.readFileSync(fullPacket, "utf8")),
    bytes: 1
}]);
const perfume = parsed.products.find((item) => item.spuId === "7744886733");
const multi = parsed.products.find((item) => item.spuId === "3714507798");

assert(parsed.counts.spu === 14, `SPU 应为 14，实际 ${parsed.counts.spu}`);
assert(parsed.counts.goods === 14, `goods 应为 14，实际 ${parsed.counts.goods}`);
assert(parsed.counts.skc === 14, `SKC 应为 14，实际 ${parsed.counts.skc}`);
assert(parsed.counts.sku === 17, `SKU 应为 17，实际 ${parsed.counts.sku}`);
assert(parsed.counts.ready === 0, "列表包不能进入映射");
assert(parsed.status === "packet-incomplete", `状态应为 packet-incomplete，实际 ${parsed.status}`);
assert(perfume && perfume.skuIds.join(",") === "79322547323", "香水 SKU 挂错");
assert(perfume.skus[0].specs[0].value === "10ml", "香水规格未还原");
assert(perfume.images.some((url) => url.includes("0d2a1749")), "主图未还原");
assert(perfume.completeness.hasDetail === false, "空标记被当成详情");
assert(multi.skuIds.length === 3, "多 SKU 商品未全部挂回");

console.log("full-capture live checks passed", parsed.counts.spu, parsed.readiness);
