/**
 * 旧CLI路径的紫鸟店名和 Temu 页头店名比对。紫鸟 ID 不在页面 DOM 里，旧路径用店名核验；
 * 页头常省略托管备注，因此允许长名与核心短名对应，但不允许单个短词前缀。
 */
function asText(value) {
    return String(value == null ? "" : value).trim();
}

function normalizeName(value) {
    return asText(value).toLowerCase().replace(/\s+/g, " ");
}

/**
 * 取店名核心段。`Hair removal wax-全托-若欧` 的页头通常只有 `Hair removal wax`。
 */
export function coreStoreName(value) {
    const text = asText(value);
    if (!text) return "";
    const parts = text.split(/\s*[-–—_|/·]\s*/).map(asText).filter(Boolean);
    if (parts.length >= 2 && (parts[0].length >= 8 || parts[0].split(/\s+/).length >= 2)) return parts[0];
    return text;
}

function isStrongName(value) {
    const text = normalizeName(value);
    return Boolean(text) && (text.length >= 8 || text.split(/\s+/).length >= 2);
}

function isNamePrefix(shortName, fullName) {
    const short = normalizeName(shortName);
    const full = normalizeName(fullName);
    if (!short || !full || !isStrongName(short)) return false;
    return full === short || full.startsWith(`${short} `) || full.startsWith(`${short}-`);
}

export function namesMatch(left, right) {
    const a = normalizeName(left);
    const b = normalizeName(right);
    return Boolean(a && b && a === b);
}

export function namesCompatible(left, right) {
    const a = normalizeName(left);
    const b = normalizeName(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const ac = normalizeName(coreStoreName(left));
    const bc = normalizeName(coreStoreName(right));
    if (ac && bc && ac === bc) return true;
    return isNamePrefix(a, b) || isNamePrefix(b, a) || isNamePrefix(ac, b) || isNamePrefix(bc, a);
}

/** API任务以已登记实例的商城ID为身份依据；店名仅展示，旧CLI任务仍保留名称核验。 */
export function taskIdentityMatches(job, agent, input = {}) {
    const target = asText(job?.targetStoreId);
    if (job?.directCreate && /^temu:\d+$/.test(target)) {
        return Boolean(agent?.executionMode === 'plugin-api' && agent.identityMatched && agent.pluginDetected
            && asText(agent.storeId) === target && target === `temu:${asText(agent.mallId)}`
            && (!input.storeId || asText(input.storeId) === target)
            && (!input.mallId || asText(input.mallId) === asText(agent.mallId))
            && (!input.executionMode || input.executionMode === 'plugin-api')
            && (!input.pluginInstanceId || asText(input.pluginInstanceId) === asText(agent.pluginInstanceId)));
    }
    return namesCompatible(job?.targetStoreName, input.pageStoreName || input.storeName || agent?.storeName);
}

/**
 * 页头选择器经常读不到店名，商品页正文里会出现核心店名。只接受足够长的核心名。
 */
export function nameFoundInText(text, expectedName) {
    const hay = normalizeName(text);
    const needle = normalizeName(coreStoreName(expectedName) || expectedName);
    if (!hay || !needle || !isStrongName(needle)) return false;
    return hay.includes(needle);
}
