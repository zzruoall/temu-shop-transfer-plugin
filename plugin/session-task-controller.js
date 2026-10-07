/**
 * 插件目标队列状态机（方案步骤2）。
 *
 * 四条明确规则（对应方案"最终规则"）：
 * - **待命**收到完整新批次：入队并自动开始，不需要"启用本轮"；
 * - **执行中**收到新批次：追加到队尾，已有商品先执行；
 * - **暂停**收到完整新批次：替换全部未开始待办，仍保持暂停；
 * - **结束**：清空旧待办；后续新批次正常启动。
 *
 * 与收件箱的分工：收件箱管"有界、原子地存"（含逐件正文与游标），
 * 状态机管"什么时候追加/替换/清空、什么时候取下一件"。
 *
 * **控制状态落盘**：暂停/正在结束/在途件身份写在存储适配器里，
 * MV3 后台休眠唤醒后按同一 documentId 恢复；新 documentId 必须作废。
 * 前一版把这些放在内存 Map 里，复核指出"后台休眠会丢状态"——
 * 那时不是磁盘收件箱，只是内存原型。
 */

import { INSTANCE_KEY } from './session-inbox-store.js';

export const QUEUE_STATE = Object.freeze({
    // 待命：无待办、未暂停，收到新批次即自动开始
    idle: 'idle',
    // 执行中：有当前件在处理
    running: 'running',
    // 暂停：保留待办，不启动下一件，但仍可接收
    paused: 'paused',
    // 正在结束：等待服务端 cutoff 确认
    ending: 'ending'
});

/** 明确终态：只有这些结果才释放本地在途占用并推进游标。 */
export const TERMINAL_OUTCOMES = new Set(['done', 'failed', 'cancelled', 'skipped', 'duplicate']);

const fail = (code, detail = {}) => Object.assign(new Error(code), { code, detail });
const text = value => String(value || '').trim();
const controlKeyOf = storeId => `control:${storeId}`;

export function createSessionTaskController({ inbox, store = null, documentId = '', now = () => Date.now(), onTrace = () => {} } = {}) {
    if (!inbox?.store) throw fail('controller_missing_inbox');
    const backing = store || inbox.store;
    if (store && store !== inbox.store) throw fail('controller_store_mismatch');

    const entryOf = async storeId => {
        const key = text(storeId);
        if (!key) throw fail('controller_missing_store');
        const saved = await backing.get('control', controlKeyOf(key));
        return saved || { storeId: key, state: QUEUE_STATE.idle, currentItem: null, attemptSeq: 0,
            endingOperationId: '', documentId: text(documentId) };
    };
    const save = async entry => backing.atomic(['control'], handle =>
        handle.put('control', controlKeyOf(entry.storeId), entry));

    /**
     * 文档绑定：同一个 documentId 的后台唤醒复用原状态；
     * **新文档必须作废旧状态**（页面重载/切店/升级都不是"恢复"场景）。
     */
    async function bindDocument({ storeId, documentId: incoming = '' } = {}) {
        const entry = await entryOf(storeId);
        const next = text(incoming);
        if (!next) return { bound: false, reason: 'document_missing' };
        if (!entry.documentId) {
            entry.documentId = next;
            await save(entry);
            return { bound: true, adopted: true };
        }
        if (entry.documentId !== next) {
            /**
             * 这是"页面重载"与"后台唤醒"的分界点：documentId 变了就说明
             * 不是同一个页面文档，旧队列不能恢复给新文档。
             */
            const cleared = await inbox.endStore({ storeId: entry.storeId });
            entry.state = QUEUE_STATE.idle;
            entry.currentItem = null;
            entry.generationEpoch = Number(entry.generationEpoch || 0) + 1;
            entry.endingOperationId = '';
            entry.documentId = next;
            await save(entry);
            onTrace('queue:document-rebound', { storeId: entry.storeId, cleared });
            return { bound: true, invalidated: true, cleared, reason: 'document_changed' };
        }
        return { bound: true, reused: true };
    }

    /** 文档代次：后台唤醒保持不变，新文档或显式作废才递增。 */
    async function generationOf(storeId) {
        const entry = await entryOf(storeId);
        return entry.generationEpoch || 0;
    }

    /**
     * 决定一个完整批次该如何入队。
     * 这是四条规则唯一的判定点：按**提交时刻**的落盘状态决定，不拍旧快照。
     */
    async function modeFor(storeId) {
        const entry = await entryOf(storeId);
        if (entry.state === QUEUE_STATE.paused) return 'replace';
        // 待命与执行中都追加：执行中"已有商品先执行"，待命则直接开始。
        return 'append';
    }

    /**
     * 接纳一个完整批次。调用方必须先收齐分片（缺片则不调用）。
     *
     * - 替换模式下旧待办被整体替换，状态**保持暂停**；
     * - 追加模式下新批次排在队尾，已有商品先执行；
     * - 结束期间（ending）拒绝接纳，并**释放预留**（否则它会堵死整条队列）。
     */
    async function acceptBatch({ storeId, batchId, manifestHash = '', chunkCount = 0, totalItems = 0, totalBytes = 0, sequence = 0 }) {
        const entry = await entryOf(storeId);
        if (entry.state === QUEUE_STATE.ending) {
            await inbox.dropPending({ storeId, batchId });
            onTrace('queue:commit-rejected', { storeId, batchId, reason: 'ending_in_progress' });
            return { accepted: false, reason: 'ending_in_progress' };
        }
        const mode = await modeFor(storeId);
        const result = await inbox.commitBatch({ storeId, batchId, manifestHash, chunkCount, mode, sequence,
            keepBatches: entry.currentItem ? [entry.currentItem.batchId] : [] });
        if (!result.committed) {
            onTrace('queue:commit-rejected', { storeId, batchId, reason: result.reason });
            return { accepted: false, reason: result.reason, mode };
        }
        /**
         * **追加与替换都不递增代次**：代次只表示"当前在途件的身份版本"，
         * 队列内容变化不影响已发请求的结果回执。
         * 在途身份由 currentItem.itemId/attemptId 承担。
         */
        onTrace('queue:committed', { storeId, batchId, mode, sequence: Number(sequence) || 0 });
        // 待命下收到批次即自动开始，不需要"启用本轮"。
        if (entry.state === QUEUE_STATE.idle) entry.state = QUEUE_STATE.running;
        await save(entry);
        return { accepted: true, mode, state: entry.state, generation: await generationOf(storeId) };
    }

    /**
     * 取下一件：**逐件**从队首批次取，而不是只返回 batchId。
     *
     * 暂停/结束期间不返回任何可执行项——暂停只挡执行，接收不受影响。
     * 同一时刻只允许一件在途（一个账户一个业务槽的本地对应物）。
     */
    async function pickNext({ storeId }) {
        const entry = await entryOf(storeId);
        if (entry.state === QUEUE_STATE.paused || entry.state === QUEUE_STATE.ending) {
            return { picked: null, reason: entry.state };
        }
        if (entry.currentItem) return { picked: null, reason: 'already_running' };
        const head = await inbox.headOf(storeId);
        if (!head) return { picked: null, reason: 'queue_empty' };
        const item = await inbox.nextItem({ storeId, batchId: head.batchId });
        if (!item) {
            /**
             * 批内已无待执行件：由调用方判定"整批完成"。
             * 这里不擅自完结批次——队列推进必须显式，才能与结算一一对应。
             */
            return { picked: null, reason: 'batch_exhausted', batchId: head.batchId };
        }
        entry.attemptSeq = Number(entry.attemptSeq) + 1;
        entry.currentItem = { batchId: head.batchId, sequence: head.sequence, itemId: item.itemId,
            position: item.position, cursor: item.cursor,
            attemptId: `${head.batchId}#${item.itemId}#${entry.attemptSeq}`,
            // 回执守卫用的代次随在途件一起记录，调用方无须自己拼装。
            generation: Number(entry.generationEpoch || 0),
            startedAt: now() };
        entry.state = QUEUE_STATE.running;
        await save(entry);
        onTrace('queue:pick', { storeId, batchId: head.batchId, itemId: item.itemId, attemptId: entry.currentItem.attemptId });
        return { picked: { ...entry.currentItem }, batchId: head.batchId, itemId: item.itemId };
    }

    /**
     * 结算当前件。
     *
     * - **身份严格匹配**：入参缺失或不一致都拒绝（不能靠"不传身份"绕过）；
     * - **只有明确终态**才推进游标与释放占用；unknown 保留（请求可能已发出）；
     * - 结算后按状态决定是否继续：暂停中不取下一件。
     */
    async function settleCurrent({ storeId, outcome = 'done', itemId = '', attemptId = '' }) {
        const entry = await entryOf(storeId);
        const current = entry.currentItem;
        if (!current) {
            const previous = entry.lastSettlement;
            if (previous && previous.itemId === text(itemId) && previous.attemptId === text(attemptId)
                && previous.outcome === outcome) return { ...previous, settled: true, idempotent: true };
            return { settled: false, reason: 'no_current_item' };
        }
        if (text(itemId) !== current.itemId) {
            return { settled: false, reason: 'item_mismatch', expected: current.itemId, actual: text(itemId) };
        }
        if (text(attemptId) !== current.attemptId) {
            return { settled: false, reason: 'attempt_mismatch', expected: current.attemptId, actual: text(attemptId) };
        }
        if (!TERMINAL_OUTCOMES.has(String(outcome))) {
            onTrace('queue:settle-held', { storeId, batchId: current.batchId, outcome });
            return { settled: false, reason: 'non_terminal_outcome', outcome, held: true, batchId: current.batchId };
        }
        // 游标推进与在途释放同时提交：不会出现"回执已认、游标没动"的半状态。
        const advanced = await inbox.advanceCursor({ storeId, batchId: current.batchId, itemId: current.itemId });
        if (!advanced.advanced) {
            // 游标与在途身份不一致说明状态已被别的路径改写，必须暴露而不是静默清空。
            return { settled: false, reason: `cursor_${advanced.reason}`, batchId: current.batchId };
        }
        entry.currentItem = null;
        entry.lastSettlement = { itemId: current.itemId, attemptId: current.attemptId, outcome, batchId: current.batchId };
        if (entry.state === QUEUE_STATE.ending && advanced.exhausted) {
            // 正在结束且最后一件已收尾：保持 ending，等 finishEnd 用 operationId 确认。
        } else if (entry.state !== QUEUE_STATE.paused && entry.state !== QUEUE_STATE.ending) {
            entry.state = QUEUE_STATE.running;
        }
        await save(entry);
        onTrace('queue:settled', { storeId, batchId: current.batchId, itemId: current.itemId, outcome,
            exhausted: advanced.exhausted });
        /**
         * 整批耗尽时**自动完结**：这是"前批正常完成后 waiting 必须推进"的入口，
         * 也是逐件消费与批次生命周期衔接的地方。
         */
        let completed = null;
        const head = await inbox.headOf(storeId);
        if (advanced.exhausted || head?.batchId !== current.batchId) {
            completed = await inbox.completeBatch({ storeId, batchId: current.batchId });
            onTrace('queue:batch-completed', { storeId, batchId: current.batchId, promoted: completed.promoted });
        }
        return { settled: true, batchId: current.batchId, itemId: current.itemId, outcome,
            cursor: advanced.cursor, exhausted: advanced.exhausted,
            completed: Boolean(completed), promoted: completed?.promoted || 0, state: entry.state };
    }

    /** 暂停：立即禁止启动下一件，**保留本页待办**，接收能力不受影响。 */
    async function pause({ storeId }) {
        const entry = await entryOf(storeId);
        if (entry.state === QUEUE_STATE.ending) return { paused: false, reason: 'ending_in_progress' };
        /**
         * 暂停**不改变在途件身份**：它只禁止启动**下一件**，
         * 不改变当前在途商品的结果回执有效性。
         */
        entry.state = QUEUE_STATE.paused;
        await save(entry);
        const view = await inbox.snapshot(storeId);
        onTrace('queue:paused', { storeId, queued: view.queued });
        return { paused: true, queued: view.queued, currentItem: entry.currentItem ? { ...entry.currentItem } : null };
    }

    /** 继续：同页身份仍有效时执行现有队列（新批次此时按追加处理）。 */
    async function resume({ storeId }) {
        const entry = await entryOf(storeId);
        if (entry.state === QUEUE_STATE.ending) return { resumed: false, reason: 'ending_in_progress' };
        const view = await inbox.snapshot(storeId);
        entry.state = view.queued > 0 ? QUEUE_STATE.running : QUEUE_STATE.idle;
        await save(entry);
        onTrace('queue:resumed', { storeId, state: entry.state });
        return { resumed: true, state: entry.state };
    }

    /**
     * 结束（本地阶段）：清空旧待办并进入"正在结束"，等服务端 cutoff 确认。
     * **在途商品不清除**：它可能仍在平台请求中，必须保留到它自己结算。
     */
    async function beginEnd({ storeId, operationId = '' }) {
        const entry = await entryOf(storeId);
        /**
         * 结束**必须保留在途件批次的记录**：它还在平台请求中，
         * 回执要能结算；载荷和身份随当前件保留，结算时统一回收。
         */
        const keep = entry.currentItem ? [entry.currentItem.batchId] : [];
        const cleared = await inbox.endStore({ storeId, keepBatches: keep });
        entry.state = QUEUE_STATE.ending;
        entry.endingOperationId = text(operationId);
        await save(entry);
        onTrace('queue:end-begun', { storeId, cleared, hasInflight: Boolean(entry.currentItem) });
        return { ending: true, operationId: entry.endingOperationId, cleared,
            inflight: entry.currentItem ? { ...entry.currentItem } : null };
    }

    /**
     * 服务端 cutoff 确认后回到待命：此后新批次可正常启动。
     *
     * - **在途件未结算时不得回到可执行态**：返回 pending_inflight；
     * - **operationId 必须匹配当前结束操作**：迟到的旧结束确认不能把后来的暂停改成待命。
     */
    async function finishEnd({ storeId, operationId = '' }) {
        const entry = await entryOf(storeId);
        const op = text(operationId);
        if (op && entry.endingOperationId && op !== entry.endingOperationId) {
            return { finished: false, reason: 'stale_operation', state: entry.state };
        }
        if (entry.state !== QUEUE_STATE.ending) {
            return { finished: false, reason: 'state_changed', state: entry.state };
        }
        if (entry.currentItem) {
            onTrace('queue:end-pending-inflight', { storeId, batchId: entry.currentItem.batchId });
            return { finished: false, reason: 'pending_inflight', state: entry.state };
        }
        entry.state = QUEUE_STATE.idle;
        entry.endingOperationId = '';
        await save(entry);
        onTrace('queue:end-finished', { storeId });
        return { finished: true, state: entry.state };
    }

    /**
     * 页面失效（刷新/关闭/切店/升级）：旧会话作废。
     * **不**向新文档恢复旧队列——新批次必须重新发送。
     */
    async function invalidate({ storeId, reason = '' }) {
        const entry = await entryOf(storeId);
        const cleared = await inbox.endStore({ storeId });
        entry.currentItem = null;
        entry.state = QUEUE_STATE.idle;
        entry.generationEpoch = Number(entry.generationEpoch || 0) + 1;
        entry.documentId = '';
        await save(entry);
        onTrace('queue:invalidated', { storeId, reason, cleared });
        return { invalidated: true, reason, cleared, generation: entry.generationEpoch };
    }

    /** 旧回调守卫：代次不匹配的回调一律拒绝，不能改回已替换/已清空的队列。 */
    async function acceptsCallback({ storeId, generation, attemptId = '' }) {
        const entry = await entryOf(storeId);
        if (Number(generation) !== Number(entry.generationEpoch || 0)) return false;
        /**
         * 结束/替换后旧 attempt 的回执：只要这一件**仍在途**就仍有效
         * （它就是当前在途件本身）；在途件已被换掉才拒绝。
         */
        if (attemptId && entry.currentItem && entry.currentItem.attemptId !== text(attemptId)) return false;
        return true;
    }

    async function snapshot(storeId) {
        if (!storeId) {
            const view = await inbox.snapshot();
            return { ...view, states: view.stores.map(item => item.storeId) };
        }
        const entry = await entryOf(storeId);
        const view = await inbox.snapshot(storeId);
        return { ...view, state: entry.state, hasCurrent: Boolean(entry.currentItem),
            currentItem: entry.currentItem ? { ...entry.currentItem } : null,
            generation: Number(entry.generationEpoch || 0) };
    }

    /** 记录实例文档标记：后台启动时用它判断"同文档唤醒"还是"新文档"。 */
    async function rememberInstance({ pluginInstanceId, documentId: doc = '' } = {}) {
        const previous = await backing.get('control', INSTANCE_KEY);
        const next = { pluginInstanceId: text(pluginInstanceId), documentId: text(doc), at: now() };
        await backing.atomic(['control'], handle => handle.put('control', INSTANCE_KEY, next));
        return { previous: previous || null, current: next };
    }

    const methods = { bindDocument, rememberInstance, acceptBatch, pickNext, settleCurrent, pause, resume, beginEnd, finishEnd,
        invalidate, acceptsCallback, generationOf, modeFor, snapshot, entryOf };
    if (backing.inTransaction) return methods;
    /**
     * 每次状态转换跨 control/meta/bodies 一起提交，跨后台实例也由 IndexedDB 排他串行。
     * 日志在提交后发送，事务失败不会留下“已经执行成功”的观测。
     */
    return Object.fromEntries(Object.keys(methods).map(name => [name, async (...args) => {
        const traces = [];
        const result = await backing.atomic(['control', 'meta', 'bodies'], async handle => {
            const scopedInbox = inbox.inTransaction(handle);
            const scoped = createSessionTaskController({ inbox: scopedInbox, documentId, now,
                onTrace: (...event) => traces.push(event) });
            return scoped[name](...args);
        });
        for (const event of traces) onTrace(...event);
        return result;
    }]));
}
