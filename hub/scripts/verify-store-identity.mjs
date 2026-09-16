/**
 * 核对页面店铺身份：不能把商品 SPU 当成紫鸟店铺 ID，店名对不上就不能核验通过。
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const identity = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../plugin/store-identity.js"));

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(identity.namesMatch("City Beauty King-HAOSHI", "City Beauty King-HAOSHI") === true, "相同店名未通过");
assert(identity.namesMatch("City Beauty King-HAOSHI", "Hair removal wax-全托-若欧") === false, "不同店名被当成同一店");
assert(identity.namesMatch("", "City Beauty King-HAOSHI") === false, "空店名不能核验通过");
assert(identity.namesMatch("City", "City Beauty King-HAOSHI") === false, "短店名包含匹配不能通过");

assert(identity.namesCompatible("Hair removal wax", "Hair removal wax-全托-若欧") === true, "页头短名应能对上紫鸟长名");
assert(identity.namesCompatible("City Beauty King", "City Beauty King-HAOSHI") === true, "City Beauty King 应对上带备注的紫鸟名");
assert(identity.namesCompatible("City", "City Beauty King-HAOSHI") === false, "单个短词不能对上完整店名");
assert(identity.nameFoundInText("Beta 服务市场 Hair removal wax 新建商品", "Hair removal wax-全托-若欧") === true, "正文核心店名应能识别");
assert(identity.nameFoundInText("欢迎来到 Seller central City Beauty King 首页", "City Beauty King-HAOSHI") === true, "首页正文店名应能识别");
assert(identity.nameFoundInText("City 欢迎", "City Beauty King-HAOSHI") === false, "正文里的短词不能当店名");

const page = identity.readPageIdentity();
assert(page.storeId === "", "页面身份不得从 DOM 猜测紫鸟店铺 ID");

assert(identity.extractShopNameFromPayload({ result: { mallList: [{ mallName: "Hair removal wax" }] } }) === "Hair removal wax", "账号接口 mallName 应能提取");
assert(identity.extractShopNameFromPayload({ result: { pageItems: [{ productName: "商品标题太短" }] } }) === "", "商品列表标题不能当店名");
identity.rememberCapturedShopName("City Beauty King");
const captured = identity.readPageIdentity();
assert(captured.storeName === "City Beauty King", "已捕获店名应作为页头兜底");
assert(captured.source === "captured-api", "已捕获店名来源应标记为 captured-api");

console.log("store identity checks passed");
