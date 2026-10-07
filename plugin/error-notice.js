/* 错误通知与商品执行分离：只在当前会话内有限重试小通知，不落盘、不重新提交商品。 */
(function (scope) {
    'use strict';
    const productCodes = new Set(['PRODUCT_FIELD_INVALID', 'PRODUCT_SKU_INVALID', 'PRODUCT_IMAGE_INVALID', 'PRODUCT_DATA_INVALID']);
    const errorStates = new Set(['rejected', 'preflight_failed', 'unknown']);
    /** 只放行日志中已核实的字段拒绝；数字码可能复用，必须同时匹配原因及确定性提交失败。 */
    function verifiedPlatformDataError(task) {
        if (task.directState !== 'rejected' || task.errorStage !== '提交') return false;
        const code = String(task.errorCode || ''), reason = String(task.reason || '');
        return (code === '2000135' && /净含量[^\n]{0,80}必填/.test(reason))
            || (code === '2000225' && /化妆品成分不存在/.test(reason));
    }
    function classify(task) {
        if (!errorStates.has(task.directState) || !task.reason) return null;
        const code = String(task.errorCode || '');
        if (task.directState !== 'unknown' && (productCodes.has(code) || verifiedPlatformDataError(task))) return 'product_data';
        if (/^(?:401|403|SHOP_PERMISSION_DENIED|LOGIN_EXPIRED)$/.test(code)) return 'shop_context';
        if (/^(?:429|502|503|504|NETWORK_ERROR|TIMEOUT)$/.test(code)) return 'transport';
        // 其余自由文本或未核实的数字码不能把一店故障推断为所有店的商品错误。
        return 'unknown';
    }
    function create({ post, valid, status, now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), uuid = () => crypto.randomUUID() }) {
        const entries = new Map();
        let bytes = 0, active = 0;
        const emit = (task, value) => Promise.resolve(status(task, value)).catch(() => {});
        function enqueue(task, instance, codes = []) {
            const errorScope = classify(task);
            if (!errorScope || !task.noticeToken) return false;
            const key = JSON.stringify([task.targetStoreId, task.jobId, task.spuId, task.relaySessionId, task.executionRunId, task.directRetrySequence || 0]);
            if (entries.has(key) || task.errorNoticeStatus) return false;
            const reason = String(task.reason).replace(/Bearer\s+[\w.\/-]+/gi, 'Bearer [已隐藏]')
                .replace(/(?:cookie|authorization|token)\s*[:=]\s*[^\s,;]+/gi, '[敏感信息已隐藏]').slice(0, 2000);
            const body = { pluginInstanceId: instance, noticeToken: task.noticeToken, eventId: uuid(), errorScope,
                errorCode: String(task.errorCode || '').slice(0, 80), errorStage: String(task.errorStage || '').slice(0, 80), reason,
                productCodes: codes.slice(0, 16).map(code => String(code).slice(0, 160)), offendingSkuCode: String(task.offendingSkuCode || '').slice(0, 255),
                reasonTruncated: Boolean(task.reasonTruncated || String(task.reason).length >= 2000) };
            const size = new TextEncoder().encode(JSON.stringify(body)).length;
            if (size > 16 * 1024 || entries.size >= 64 || bytes + size > 256 * 1024) { void emit(task, 'not_delivered'); return false; }
            const entry = { key, task, body, size, started: now(), running: false };
            entries.set(key, entry); bytes += size;
            void emit(task, 'pending');
            pump();
            return true;
        }
        async function run(entry) {
            let outcome = 'not_delivered';
            try {
                for (let attempt = 0; attempt < 3; attempt++) {
                    if (now() - entry.started >= 30000 || !await valid(entry.task)) return;
                    try {
                        const result = await post(entry.body);
                        if (['marked', 'already_marked', 'not_product_error', 'stale_or_deleted'].includes(result?.status)) {
                            outcome = result.status; break;
                        }
                    } catch (error) {
                        if (error?.status && error.status !== 429 && error.status < 500) break;
                    }
                    if (attempt < 2) await sleep(500 * (2 ** attempt) + Math.floor(Math.random() * 250));
                }
                if (await valid(entry.task)) await emit(entry.task, outcome);
            } finally {
                entries.delete(entry.key); bytes -= entry.size; active--; pump();
            }
        }
        function pump() {
            for (const entry of entries.values()) {
                if (active >= 2) break;
                if (entry.running) continue;
                entry.running = true; active++;
                // 通知异常只影响通知状态，绝不把后台异步拒绝扩散到执行器。
                void run(entry).catch(() => {});
            }
        }
        return { enqueue, snapshot: () => ({ entries: entries.size, bytes, active }) };
    }
    scope.TemuErrorNotices = { classify, create };
})(globalThis);
