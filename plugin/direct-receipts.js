"use strict";

/** 只补报执行结果，绝不重试 begin 授权或平台新增请求；每条回执独立落盘，避免跨店覆盖。 */
globalThis.TemuDirectReceipts = (() => {
    const PREFIX = "directReceiptV1:";
    const ALARM_NAME = "direct-receipt-retry";
    let serial = Promise.resolve();
    const exclusive = action => {
        const run = serial.then(action);
        serial = run.catch(() => {});
        return run;
    };
    const wake = () => chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5 });

    /** 服务端按 receiptId 幂等接收；断网和响应丢失只重发同一回执，不改变尝试编号。 */
    async function deliver(key, entry) {
        try {
            const reply = await hubJson('/api/jobs/direct-progress', entry.body);
            if (!reply || !['created', 'unknown', 'preflight_failed', 'rejected', 'duplicate_exists'].includes(reply.state) || !reply.attemptId) throw Error('服务端没有确认执行回执');
            await chrome.storage.local.remove(key);
            await TemuOperationLog.append({ action: 'direct-receipt', status: 'succeeded', jobId: entry.body.jobId, spuId: entry.body.spuId, storeId: entry.body.storeId });
            return reply;
        } catch (error) {
            const attempts = Number(entry.attempts || 0) + 1;
            // 旧凭证或人工重试后的回执不可覆盖新任务，保留现场供排查，不用新凭证偷偷改写重报。
            // 心跳尚未恢复或授权暂时不可用也可能返回 409，不能把这类恢复窗口永久封死。
            const blocked = [400, 404, 410, 422].includes(Number(error?.status))
                || Number(error?.status) === 409 && /任务已取消|回执重试轮次已失效|回执编号已绑定其他结果/.test(String(error?.message || ''));
            const next = { ...entry, attempts, blocked, lastError: String(error?.message || error).slice(0, 240),
                nextAttemptAt: Date.now() + Math.max(Number(error.scheduling?.retryAfterMs) || 0, Math.min(300000, 30000 * 2 ** Math.min(attempts - 1, 4))) + Math.random() * 10000 };
            await chrome.storage.local.set({ [key]: next });
            await TemuOperationLog.append({ action: 'direct-receipt', status: blocked ? 'blocked' : 'retry_wait',
                jobId: entry.body.jobId, spuId: entry.body.spuId, storeId: entry.body.storeId, error: next.lastError });
            if (!blocked) await wake();
            return { pending: true, blocked };
        }
    }

    /** 本地持久化失败必须向调用方抛错；网络失败则保留回执并返回 pending，执行结果不被降级。 */
    function send(body) {
        if (!['created', 'unknown', 'preflight_failed', 'rejected', 'duplicate_exists'].includes(body?.phase)) return Promise.reject(Error('不允许排队重试创建授权'));
        return exclusive(async () => {
            const key = PREFIX + [body.jobId, body.spuId, body.directRetrySequence || 0, body.attemptId || 'unstarted', body.phase].map(encodeURIComponent).join(':');
            const stored = (await chrome.storage.local.get(key))[key];
            const entry = stored || { body: { ...body, receiptId: crypto.randomUUID() }, createdAt: Date.now(), attempts: 0 };
            await chrome.storage.local.set({ [key]: entry });
            // 先登记唤醒，再发 HTTP；worker 在请求途中终止后仍有补报机会。
            await wake();
            if (entry.blocked) return { pending: true, blocked: true };
            return deliver(key, entry);
        });
    }

    /** 启动和 alarm 都进入同一串行通道；每轮有界补报，不依赖商品页仍打开或任务仍在本地列表。 */
    function flush() {
        return exclusive(async () => {
            const stored = await chrome.storage.local.get(null);
            const entries = Object.entries(stored).filter(([key, entry]) => key.startsWith(PREFIX) && entry?.body && !entry.blocked)
                .sort(([, a], [, b]) => a.createdAt - b.createdAt);
            for (const [key, entry] of entries.filter(([, entry]) => !entry.nextAttemptAt || entry.nextAttemptAt <= Date.now()).slice(0, 4)) await deliver(key, entry);
            const remaining = await chrome.storage.local.get(null);
            if (Object.entries(remaining).some(([key, entry]) => key.startsWith(PREFIX) && entry?.body && !entry.blocked)) await wake();
        });
    }
    return { send, flush, ALARM_NAME };
})();
