import { createHash } from "node:crypto";

export const TRANSFER_HASH_ALGORITHM = "sha256-json-v1";

/** 全字段规范化只消除对象键顺序差异；未知字段、数组顺序、空值和数值不得裁剪或改写。 */
export function canonicalTransferJson(value) {
    if (Array.isArray(value)) return value.map(canonicalTransferJson);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalTransferJson(value[key])]));
    return value;
}

/** 摘要用于传输及存储一致性，不代表满足平台发布要求，也不是来源真实性签名。 */
export function transferHash(value) {
    return createHash("sha256").update(JSON.stringify(canonicalTransferJson(value))).digest("hex");
}

/** 清单绑定完整快照，不复用只覆盖业务去重字段的版本指纹。 */
export function transferManifest(value) {
    return { algorithm: TRANSFER_HASH_ALGORITHM, sha256: transferHash(value) };
}

/** 有清单必须验全包；无清单的历史采集只标记未核验，不伪造来源端校验成功。 */
export function verifyTransferManifest(value, manifest) {
    if (!manifest) return false;
    if (manifest.algorithm !== TRANSFER_HASH_ALGORITHM || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "") || transferHash(value) !== manifest.sha256) {
        throw Object.assign(new Error("传输数据摘要不一致，请重新发送原始采集包"), { status: 422 });
    }
    return true;
}

/** 只核对来源商品身份和原始对象存在；不检查标题、图片、SKU、详情或类目模板是否完整。 */
export function assertCapturedSource(product) {
    const source = product?.publicationData?.sourceProduct;
    if (!source || typeof source !== "object" || Array.isArray(source) || String(source.productId || "") !== String(product?.spuId || "") || !product?.spuId) {
        throw Object.assign(new Error(`SPU ${product?.spuId || "未知"} 缺少可核对身份的来源原始资料，请重新采集该商品`), { status: 422 });
    }
    return source;
}
