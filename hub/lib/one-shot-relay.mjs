/**
 * 仅在当前HTTP请求期间连接发送方与接收方；不落库、不等收妥、不保存平台运行状态。
 * 断线、超时或重启均丢弃当前发送，不在下次连接重放；页面身份防止旧请求落到刷新后的页面。
 */
export function createOneShotRelay({ waitMs = 12000, maxBytes = 32 * 1024 * 1024, maxPending = 128,
    handoff = async (claimed, deliver) => deliver({ claimed, skippedBlocked: [] }) } = {}) {
    const senders = new Map(), receivers = new Map();
    let bytes = 0, pending = 0;
    const fail = (code, status = 409) => Object.assign(Error(code), { status });
    const keyOf = ({ storeId, pluginInstanceId, relaySessionId }) => {
        if (![storeId, pluginInstanceId, relaySessionId].every(v => typeof v === 'string' && v && v.length <= 255)) throw fail('relay_identity_invalid', 400);
        return JSON.stringify([storeId, pluginInstanceId, relaySessionId]);
    };
    /** 等待有界且只占当前连接；完成路径先移除索引，防止并发领取重复获得正文。 */
    function wait(map, key, signal, timeoutValue, size = 0, owner = '') {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) return reject(fail('relay_aborted', 499));
            const finish = (error, value) => {
                if (map.get(key) !== entry) return;
                map.delete(key); clearTimeout(entry.timer); signal?.removeEventListener('abort', entry.abort);
                if (map === senders) { bytes -= size; pending--; }
                error ? reject(error) : resolve(value);
            };
            const entry = { owner, finish, timer: null, abort: () => finish(fail('relay_aborted', 499)) };
            entry.timer = setTimeout(() => timeoutValue instanceof Error ? finish(timeoutValue) : finish(null, timeoutValue), waitMs);
            map.set(key, entry);
            signal?.addEventListener('abort', entry.abort, { once: true });
        });
    }
    /** 来源权限与正文完整性由调用方先核验；这里仅限制在途传输内存，不决定插件如何执行。 */
    async function send(identity, claimed, owner, signal) {
        const key = keyOf(identity);
        const size = Buffer.byteLength(JSON.stringify(claimed));
        if (signal?.aborted) throw fail('relay_aborted', 499);
        if (size > maxBytes || bytes + size > maxBytes || pending >= maxPending
            || [...senders.values()].filter(v => v.owner === owner).length >= 16) throw fail('relay_capacity', 429);
        if (senders.has(key)) throw fail('relay_store_busy', 429);
        const receiver = receivers.get(key);
        if (receiver) {
            if (receiver.delivering) throw fail('relay_store_busy', 429);
            receiver.delivering = true;
            try {
                // 资格核验在实际交接时进行；数据库锁只覆盖这个同步回调，不覆盖等候接收连接。
                return await handoff(claimed, ({ claimed: allowed, skippedBlocked = [] }) => {
                    if (signal?.aborted || receivers.get(key) !== receiver) throw fail('relay_aborted', 499);
                    receiver.finish(null, { claimed: allowed });
                    return { sent: allowed.length, skippedBlocked };
                });
            } catch (error) { receiver.finish(error); throw error; }
        }
        bytes += size; pending++;
        const promise = wait(senders, key, signal, fail('relay_not_connected', 409), size, owner);
        const entry = senders.get(key);
        if (entry) entry.claimed = claimed;
        return promise;
    }
    /** 长轮询只接收一次；没有任何“收到”回报或成功重试接口。 */
    async function receive(identity, signal) {
        const key = keyOf(identity);
        if (signal?.aborted) throw fail('relay_aborted', 499);
        if (receivers.has(key)) throw fail('relay_receiver_busy', 409);
        const sender = senders.get(key);
        if (sender) {
            if (sender.delivering) throw fail('relay_receiver_busy', 409);
            sender.delivering = true;
            try {
                return await handoff(sender.claimed, ({ claimed: allowed, skippedBlocked = [] }) => {
                    if (signal?.aborted || senders.get(key) !== sender) throw fail('relay_aborted', 499);
                    sender.finish(null, { sent: allowed.length, skippedBlocked });
                    return { claimed: allowed };
                });
            } catch (error) { sender.finish(error); throw error; }
        }
        if (receivers.size >= 512) throw fail('relay_capacity', 429);
        return wait(receivers, key, signal, { claimed: [] });
    }
    return { send, receive, snapshot: () => ({ bytes, pending, receivers: receivers.size }) };
}
