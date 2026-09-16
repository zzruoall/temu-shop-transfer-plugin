/** 页面内请求指纹：先把请求序列化成真实传输形态，再规范化并做 SHA-256。注入到页面 MAIN world，与 direct-adapter.js 同一批。 */
window.__temuDirectFingerprint = (function buildDirectFingerprint() {
    /**
     * 指纹必须能在授权侧与提交侧一致比较，同时不能因为跨扩展边界而失真：
     * 1) 先 JSON 序列化：新增请求里含 MobX 可观察数组，数据挂在不可枚举属性与原型上，
     *    Object.keys 看不到它们；只遍历属性会把有内容的规格数组误判成空对象，使指纹空转，
     *    也无法与真正提交的报文对齐，因此一律以序列化结果为准。undefined、函数、Symbol、
     *    非有限数字在序列化时已按 JSON 语义处理，页面原件与跨边界副本（往返后都是 JSON.parse
     *    的结果）因此天然一致，不需要再额外归一。
     * 2) 序列化之后只做键排序这一项规范化：对象键顺序不影响服务端语义，重排不应改变指纹。
     *    除此以外不丢弃、不改写任何字段，避免把“提交了空值”和“没有提交该字段”误判成同一请求。
     */
    function canonicalize(value) {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (value && typeof value === 'object') {
            const out = {};
            for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
            return out;
        }
        return value;
    }
    /** 返回规范化文本的 SHA-256 十六进制值与文本长度；长度用于指纹不一致时定位差异方向。 */
    return async function directFingerprint(value) {
        // 序列化失败说明该请求本来就发不出去，直接抛出比给出一个空指纹更安全。
        const json = JSON.stringify(value);
        if (typeof json !== 'string') throw Error('请求内容无法序列化，禁止提交');
        const text = JSON.stringify(canonicalize(JSON.parse(json)));
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
        return { hash: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), length: text.length };
    };
})();
