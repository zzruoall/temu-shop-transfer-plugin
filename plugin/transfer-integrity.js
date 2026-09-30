"use strict";

/** 全字段传输摘要只规范对象键顺序，不筛选平台字段，不改写数组、空值或未知结构。 */
globalThis.TemuTransferIntegrity = (() => {
    const algorithm = "sha256-json-v1";
    const canonical = value => Array.isArray(value) ? value.map(canonical)
        : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    /** 摘要只证明采集后的数据一致性，不证明平台原始接口已返回全部业务资料。 */
    async function hash(value) {
        const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)));
        return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }
    async function manifest(value) { return { algorithm, sha256: await hash(value) }; }
    /** 历史任务没有清单仍可处理，但不得将其标记为通过摘要核验。 */
    async function verify(value, expected) {
        if (!expected) return false;
        if (expected.algorithm !== algorithm || !/^[a-f0-9]{64}$/.test(expected.sha256 || "") || await hash(value) !== expected.sha256) {
            throw new Error("商品传输摘要不一致，已停止处理，请重新发送原始资料");
        }
        return true;
    }
    return { algorithm, hash, manifest, verify };
})();
