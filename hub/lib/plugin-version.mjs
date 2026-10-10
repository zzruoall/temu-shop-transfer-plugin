/** 只认可已核验的10/11主版本；版本只是能力门槛，不能代替实例认证、商城身份或协议字段。 */
export function pluginVersionAtLeast(version, minimum) {
    const text = String(version || '').trim();
    if (!/^\d+\.\d+\.\d+$/.test(text)) return false;
    const parts = text.split('.').map(Number);
    if (![10, 11].includes(parts[0]) || parts.some(part => !Number.isSafeInteger(part) || part > 65535)) return false;
    for (let index = 0; index < 3; index++) {
        if (parts[index] !== minimum[index]) return parts[index] > minimum[index];
    }
    return true;
}

/** 收件协议从10.10.69开放；真实收发入口必须核验能力，不能只依赖目录展示的“可接收”字段。 */
export function hasRelayPlugin(agent) {
    return agent?.pluginDetected === true && agent.relayProtocol === 1
        && pluginVersionAtLeast(agent.pluginVersion, [10, 10, 69]);
}
