/**
 * 目标店有界收件箱（方案步骤2）。
 *
 * 与前一版的**实质区别：真正落盘**。前一版把队列和"分片数量"放在内存 Map 里，
 * 复核指出这不能算磁盘收件箱——MV3 后台一休眠就丢，且"51 件"只验证了一个数字，
 * 不能证明 51 件商品被完整保存。现在：
 *
 * - 队列索引、批次清单、分片索引、**每件商品正文**都写在存储适配器里
 *   （浏览器 IndexedDB / Node 文件，二者接口一致，见 `session-inbox-store.js`）；
 * - 每件商品有独立 itemId 与**持久游标**，可以逐件取用、逐件结算；
 * - 同一事务内的写入要么都成功要么都回滚，不留"半份队列"。
 *
 * ## 队列模型（三段，任何操作只在这三段之间搬动数据）
 *
 *   receiving --(收齐并接纳)--> executable（按 sequence 升序，逐件消费）
 *       |
 *       +--(缺片/失败)--> waiting --(前置完结时晋升)--> executable
 *
 * - receiving：已预留、未收齐。占容量（正文正在落盘）。
 * - waiting：已收齐但前面还有未完结的更早批次。**也占容量**。
 * - executable：可被逐件取用，**按 sequence 升序**，批内按 position 升序。
 *
 * 三条不变量：
 * 1. **容量 = receiving + waiting + executable**；
 * 2. **晋升只有一处入口** `promoteWaiting`——前批**正常完成**或被**明确丢弃**
 *    都触发同一处推进；
 * 3. **替换/结束必须同时清空 waiting**，否则旧批次会在后续晋升里复活。
 *
 * 本模块不碰网络与 DOM；协议（HTTP 投递）由后续步骤接。
 */

/** 首版预算：配置上限，不是已验证容量承诺；实施时以边界测试实测占用校准。 */
import { transactionInboxStore } from './session-inbox-store.js';

export const DEFAULT_INBOX_LIMITS = Object.freeze({
    perStoreBytes: 64 * 1024 * 1024,
    instanceBytes: 128 * 1024 * 1024,
    perStoreItems: 10000
});

export class InboxCapacityError extends Error {
    constructor(message, detail = {}) {
        super(message);
        this.name = 'InboxCapacityError';
        this.code = 'inbox_capacity_insufficient';
        this.detail = detail;
    }
}

const fail = (code, detail = {}) => Object.assign(new Error(code), { code, detail });
const text = value => String(value || '').trim();
const num = value => Number(value) || 0;
const storeKeyOf = storeId => `store:${storeId}`;
const batchKeyOf = (storeId, batchId) => `batch:${storeId}:${batchId}`;
const bodyKeyOf = (storeId, batchId, itemId) => `item:${storeId}:${batchId}:${itemId}`;

/** 分片摘要协议：按传输清单顺序连接商品原始字节；身份及边界另由冻结清单核对。 */
export async function hashInboxPart(items) {
    const length = items.reduce((sum, item) => sum + item.bytes.length, 0);
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const item of items) { bytes.set(item.bytes, offset); offset += item.bytes.length; }
    return Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes)),
        byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createTargetSessionInbox({ store = null, now = () => Date.now(), limits = {} } = {}) {
    if (!store?.atomic) throw fail('inbox_store_required');
    const cfg = { ...DEFAULT_INBOX_LIMITS, ...limits };

    /** 实例内所有店铺摘要；instanceBytes 用真实落盘记录，不用调用方计数。 */
    async function readAllStores(handle) {
        const values = handle ? await handle.list('meta') : await store.list('meta');
        return values.filter(value => value?.kind === 'store');
    }

    /** 读取本店索引；不存在则建立。接收入口不要求调用方先显式建档。 */
    async function loadStore(handle, storeId) {
        const record = await handle.get('meta', storeKeyOf(storeId));
        if (record) return { retired: {}, retained: [], cutoffSequence: 0, highSequence: 0, ...record };
        const created = { kind: 'store', storeId, queued: [], waiting: [], receiving: [], accepted: {},
            retired: {}, retained: [], cutoffSequence: 0, highSequence: 0 };
        await handle.put('meta', storeKeyOf(storeId), created);
        return created;
    }

    /** 摘要：队列里只保留小对象，正文与清单在批次记录里，避免每次变更重写大 JSON。 */
    const summaryOf = batch => ({ batchId: batch.batchId, sequence: num(batch.sequence),
        totalItems: num(batch.totalItems), totalBytes: num(batch.totalBytes) });

    function usedBytesOf(record) {
        const sum = list => list.reduce((total, batch) => total + num(batch.totalBytes), 0);
        return sum(record.queued) + sum(record.waiting) + sum(record.receiving) + sum(record.retained || []);
    }

    async function instanceBytes({ exclude = '', handle = null } = {}) {
        let total = 0;
        for (const record of await readAllStores(handle)) {
            if (record.storeId === exclude) continue;
            total += usedBytesOf(record);
        }
        return total;
    }

    const sortBySequence = list => [...list].sort((left, right) => {
        const a = num(left.sequence), b = num(right.sequence);
        if (a === 0 && b === 0) return 0;
        if (a === 0) return 1;
        if (b === 0) return -1;
        return a - b;
    });

    /**
     * **唯一的晋升入口**：把 waiting 里"前面已无更早未完结批次"的项移入可执行队列。
     * 正常完成、明确丢弃、替换、结束都调用同一条路径，
     * 因此不会出现"只在失败路径推进、成功路径永久卡住"。
     */
    function promote(record) {
        if (!record.waiting.length) return 0;
        const pendingSequences = [...record.receiving, ...record.queued]
            .map(batch => num(batch.sequence)).filter(value => value > 0);
        const earliestPending = pendingSequences.length ? Math.min(...pendingSequences) : 0;
        const ready = [], stillWaiting = [];
        for (const batch of sortBySequence(record.waiting)) {
            const seq = num(batch.sequence);
            const blockedByReceiving = earliestPending > 0 && seq > 0 && seq > earliestPending;
            const blockedByQueued = record.queued.some(item => num(item.sequence) > 0 && seq > 0
                && num(item.sequence) < seq);
            if (blockedByReceiving || blockedByQueued) stillWaiting.push(batch);
            else ready.push(batch);
        }
        if (ready.length) {
            record.queued = sortBySequence([...record.queued, ...ready]);
            record.waiting = stillWaiting;
        }
        return ready.length;
    }

    /** 删除一批商品正文（磁盘回收）；与队列元数据变更放在同一事务里。 */
    async function dropBodies(handle, storeId, batchId) {
        for (const key of await handle.keys('bodies')) {
            if (key.startsWith(`item:${storeId}:${batchId}:`)) await handle.del('bodies', key);
        }
    }

    /**
     * **预留**容量：只记账、不写正文。清单（每件的身份与字节数）在此冻结。
     *
     * 预留失败必须拒绝接收，而不是先删旧数据腾空间——后者会让用户丢批次。
     */
    async function reserve({ storeId, batchId, items = null, totalItems = 0, totalBytes = 0,
        manifestHash = '', chunkCount = 0, sequence = 0 }) {
        const key = text(batchId);
        const id = text(storeId);
        if (!key) throw fail('inbox_missing_batch');
        if (!id) throw fail('inbox_missing_store');
        return store.atomic(['meta'], async handle => {
            const record = await loadStore(handle, id);
            if (record.retired[key] || (num(sequence) > 0 && num(sequence) <= record.cutoffSequence)) {
                throw fail('inbox_batch_retired', { batchId: key });
            }
            // 已接纳批次的重复预留：幂等，且**不再占一份容量**。
            if (record.accepted[key] !== undefined) {
                return { reserved: true, idempotent: true, alreadyAccepted: true,
                    sequence: record.accepted[key], usedBytes: usedBytesOf(record) };
            }
            if (record.receiving.some(batch => batch.batchId === key)) {
                return { reserved: true, idempotent: true, alreadyReceiving: true, usedBytes: usedBytesOf(record) };
            }
            /**
             * 清单必须逐件给出：没有 itemId 就无法逐件执行与逐件结算，
             * "51 件"也就只是数字。缺清单直接拒绝，不允许退化。
             */
            if (!Array.isArray(items) || !items.length) throw fail('inbox_items_required', { batchId: key });
            const seen = new Set();
            const manifest = items.map((item, position) => {
                const itemId = text(item?.itemId);
                if (!itemId || seen.has(itemId)) throw fail('inbox_item_identity_invalid', { itemId, position });
                seen.add(itemId);
                if (!Number.isSafeInteger(Number(item?.byteLength)) || Number(item.byteLength) <= 0) {
                    throw fail('inbox_item_bytes_invalid', { itemId });
                }
                return { itemId, position, byteLength: num(item?.byteLength), partNo: null };
            });
            if (num(totalItems) > 0 && manifest.length !== num(totalItems)) {
                throw fail('inbox_item_count_mismatch', { declared: num(totalItems), actual: manifest.length });
            }
            const needed = num(totalBytes);
            if (!Number.isSafeInteger(needed) || needed <= 0
                || manifest.reduce((sum, item) => sum + item.byteLength, 0) !== needed) {
                throw fail('inbox_manifest_bytes_mismatch');
            }
            if (!Number.isSafeInteger(Number(sequence)) || Number(sequence) < 0
                || !Number.isSafeInteger(Number(chunkCount)) || Number(chunkCount) < 1) throw fail('inbox_manifest_invalid');
            if (usedBytesOf(record) + needed > cfg.perStoreBytes) {
                throw new InboxCapacityError('本地接收容量不足，请结束旧批次或减少发送数量',
                    { storeId: id, projected: usedBytesOf(record) + needed, limit: cfg.perStoreBytes });
            }
            if (await instanceBytes({ exclude: id, handle }) + usedBytesOf(record) + needed > cfg.instanceBytes) {
                throw new InboxCapacityError('插件实例接收容量不足，请结束旧批次或减少发送数量',
                    { storeId: id, limit: cfg.instanceBytes });
            }
            const totalCount = [...record.queued, ...record.waiting, ...record.receiving, ...record.retained]
                .reduce((sum, batch) => sum + batch.totalItems, 0);
            if (totalCount + manifest.length > cfg.perStoreItems) {
                throw new InboxCapacityError('本地接收条数超出上限，请拆分发送', { storeId: id, limit: cfg.perStoreItems });
            }
            const batch = { batchId: key, storeId: id, manifestHash: text(manifestHash),
                totalItems: manifest.length, totalBytes: needed,
                chunkCount: num(chunkCount), sequence: num(sequence) || record.highSequence + 1,
                manifest, parts: {}, cursor: 0, status: 'receiving', reservedAt: now() };
            await handle.put('meta', batchKeyOf(id, key), batch);
            record.highSequence = Math.max(record.highSequence, batch.sequence);
            record.receiving.push(summaryOf(batch));
            await handle.put('meta', storeKeyOf(id), record);
            return { reserved: true, usedBytes: usedBytesOf(record) };
        });
    }

    /**
     * 写入一个分片：正文**逐件落盘**，分片索引只留摘要与字节。
     *
     * 校验片号范围、字节守恒、商品身份属于冻结清单、同一件不得在两片重复出现。
     * 校验不通过只记原因并返回（让调用方能上报失败而不是崩溃）；
     * **只有**"批次未预留/已被结束"这类结构性错误才抛出，
     * 它们表示消息本身过期，调用方应放弃而不是重试。
     */
    async function acceptPart({ storeId, batchId, partNo, partHash, byteLength = 0, items = [], receivedHash = '' }) {
        const id = text(storeId), key = text(batchId);
        // 摘要计算在事务外完成，避免 WebCrypto 异步等待让 IndexedDB 提前提交。
        // 复制字节，防止等待摘要期间调用者改写同一缓冲区。
        if (!Array.isArray(items) || !items.length) return { stored: false, reason: 'part_items_missing' };
        if (items.some(item => !(item?.bytes instanceof Uint8Array) || !item.bytes.length)) return { stored: false, reason: 'item_body_missing' };
        const entries = items.map(item => ({ itemId: text(item.itemId), bytes: new Uint8Array(item.bytes) }));
        const actualBytes = entries.reduce((sum, item) => sum + item.bytes.length, 0);
        if (actualBytes > cfg.perStoreBytes || actualBytes > cfg.instanceBytes) return { stored: false, reason: 'bytes_exceed_reserved' };
        if (!Number.isSafeInteger(Number(byteLength)) || actualBytes !== Number(byteLength)) return { stored: false, reason: 'part_byte_mismatch' };
        if (!text(partHash)) return { stored: false, reason: 'part_hash_missing' };
        const actualHash = await hashInboxPart(entries);
        if (actualHash !== text(partHash) || (receivedHash && text(receivedHash) !== actualHash)) return { stored: false, reason: 'part_hash_mismatch' };
        return store.atomic(['meta', 'bodies'], async handle => {
            const record = await loadStore(handle, id);
            if (record.accepted[key] !== undefined) return { stored: false, reason: 'batch_already_accepted' };
            const batch = await handle.get('meta', batchKeyOf(id, key));
            if (!batch) throw fail('inbox_batch_not_reserved', { batchId: key });
            const index = Number(partNo);
            if (!Number.isSafeInteger(index) || index < 0 || index >= batch.chunkCount) {
                return { stored: false, reason: 'part_no_out_of_range' };
            }
            const expected = batch.parts[index];
            if (expected) {
                if (partHash && expected.partHash && expected.partHash !== partHash) throw fail('inbox_part_conflict');
                return { stored: false, reason: 'duplicate_part' };
            }
            const byId = new Map(batch.manifest.map(item => [item.itemId, item]));
            const claimed = new Set(Object.values(batch.parts).flatMap(part => part.itemIds));
            const seen = new Set(); let stored = 0;
            for (const entry of entries) {
                const itemId = text(entry?.itemId), bytes = entry?.bytes;
                if (!byId.has(itemId)) return { stored: false, reason: 'item_not_in_manifest', itemId };
                if (claimed.has(itemId) || seen.has(itemId)) return { stored: false, reason: 'item_duplicated', itemId };
                if (!(bytes instanceof Uint8Array) || !bytes.length) return { stored: false, reason: 'item_body_missing', itemId };
                const declared = byId.get(itemId).byteLength;
                if (declared > 0 && bytes.length !== declared) {
                    return { stored: false, reason: 'item_byte_mismatch', itemId, declared, actual: bytes.length };
                }
                seen.add(itemId); stored += bytes.length;
            }
            const received = Object.values(batch.parts).reduce((sum, part) => sum + num(part.storedBytes), 0) + stored;
            if (batch.totalBytes > 0 && received > batch.totalBytes) return { stored: false, reason: 'bytes_exceed_reserved' };
            for (const entry of entries) {
                await handle.put('bodies', bodyKeyOf(id, key, text(entry.itemId)), entry.bytes);
            }
            batch.parts[index] = { partHash: text(partHash), byteLength: num(byteLength),
                itemIds: entries.map(entry => text(entry.itemId)), storedBytes: stored };
            await handle.put('meta', batchKeyOf(id, key), batch);
            return { stored: true, parts: Object.keys(batch.parts).length, receivedBytes: received };
        });
    }

    /** 完整性判定：片数、连续片号、总字节、摘要非空、逐件身份与字节。返回 null 表示通过。 */
    function integrityProblem(batch, { chunkCount = 0 } = {}) {
        const frozen = num(batch.chunkCount), declared = num(chunkCount);
        if (frozen > 0 && declared > 0 && declared !== frozen) {
            return { reason: 'chunk_count_downgrade', frozen, declared };
        }
        const expected = frozen || declared;
        const parts = Object.keys(batch.parts).map(Number).sort((a, b) => a - b);
        if (expected > 0 && parts.length !== expected) {
            return { reason: 'incomplete_parts', expected, actual: parts.length };
        }
        if (expected > 0 && parts.some((value, index) => value !== index)) {
            return { reason: 'part_number_gap', parts };
        }
        if (parts.some(value => !batch.parts[value].partHash)) return { reason: 'part_hash_missing', partNo: parts.find(v => !batch.parts[v].partHash) };
        const received = parts.reduce((sum, value) => sum + num(batch.parts[value].byteLength), 0);
        if (batch.totalBytes > 0 && received !== num(batch.totalBytes)) {
            return { reason: 'byte_total_mismatch', declaredBytes: batch.totalBytes, receivedBytes: received };
        }
        /**
         * **逐件核对**：分片里出现的商品集合必须与冻结清单完全一致
         * （不重复、不遗漏、不越权）。只数分片数无法发现"缺件"。
         */
        const stored = new Set(parts.flatMap(value => batch.parts[value].itemIds || []));
        if (stored.size !== batch.manifest.length) {
            return { reason: 'item_set_mismatch', declared: batch.manifest.length, stored: stored.size };
        }
        for (const item of batch.manifest) {
            if (!stored.has(item.itemId)) return { reason: 'item_missing', itemId: item.itemId };
        }
        return null;
    }

    /**
     * **接纳整批**：完整性通过后进入队列；去处由 mode 决定。
     * - append：前置未完结则进 waiting，否则进可执行队列；
     * - replace：替换**可执行队列与 waiting**（旧待办一律丢弃，正文立即回收）。
     */
    async function commitBatch({ storeId, batchId, manifestHash = '', chunkCount = 0, mode = 'append', sequence = 0, keepBatches = [] }) {
        const id = text(storeId), key = text(batchId);
        return store.atomic(['meta', 'bodies'], async handle => {
            const record = await loadStore(handle, id);
            if (record.retired[key]) return { committed: false, reason: 'stale_sequence' };
            if (record.accepted[key] !== undefined) {
                return { committed: true, idempotent: true, mode, queued: record.queued.length,
                    sequence: record.accepted[key] };
            }
            const batch = await handle.get('meta', batchKeyOf(id, key));
            if (!batch) throw fail('inbox_batch_not_reserved', { batchId: key });
            if (batch.manifestHash && manifestHash && batch.manifestHash !== text(manifestHash)) {
                return { committed: false, reason: 'manifest_mismatch' };
            }
            const problem = integrityProblem(batch, { chunkCount });
            if (problem) return { committed: false, ...problem };

            const seq = num(batch.sequence);
            if (seq <= record.cutoffSequence || (num(sequence) && num(sequence) !== seq)) return { committed: false, reason: 'stale_sequence' };
            batch.sequence = seq; batch.status = 'accepted'; batch.committedAt = now();
            await handle.put('meta', batchKeyOf(id, key), batch);
            const summary = summaryOf({ ...batch, sequence: seq });

            if (mode === 'replace') {
                // 低序号迟到批次不得覆盖较新批次（latest-wins）。
                const highest = Math.max(0, ...record.queued.map(item => num(item.sequence)),
                    ...record.waiting.map(item => num(item.sequence)));
                if (highest > 0 && seq > 0 && seq < highest) {
                    await handle.del('meta', batchKeyOf(id, key));
                    await dropBodies(handle, id, key);
                    record.receiving = record.receiving.filter(item => item.batchId !== key);
                    await handle.put('meta', storeKeyOf(id), record);
                    return { committed: false, reason: 'stale_sequence', incoming: seq, highest };
                }
                // 替换包含迟到分片；保留在途批次至回执结算，并继续计入容量。
                const oldBatches = [...record.queued, ...record.waiting,
                    ...record.receiving.filter(item => item.batchId !== key && item.sequence < seq)];
                for (const old of oldBatches) {
                    record.retired[old.batchId] = true;
                    if (keepBatches.includes(old.batchId)) {
                        if (!record.retained.some(item => item.batchId === old.batchId)) record.retained.push(old);
                    } else {
                        await dropBodies(handle, id, old.batchId);
                        await handle.del('meta', batchKeyOf(id, old.batchId));
                    }
                }
                record.cutoffSequence = Math.max(record.cutoffSequence, seq - 1);
                record.queued = [summary];
                record.waiting = [];
                record.receiving = record.receiving.filter(item => item.batchId !== key && item.sequence > seq);
                record.accepted[key] = seq;
                await handle.put('meta', storeKeyOf(id), record);
                return { committed: true, mode, queued: 1, waiting: 0, sequence: seq };
            }

            // append：前置未完结则先等待，由 promoteWaiting 统一晋升。
            const pendingEarlier = record.receiving.some(pending => pending.batchId !== key && pending.sequence < seq);
            if (pendingEarlier) {
                record.waiting = sortBySequence([...record.waiting, summary]);
                record.receiving = record.receiving.filter(item => item.batchId !== key);
                record.accepted[key] = seq;
                await handle.put('meta', storeKeyOf(id), record);
                return { committed: true, deferred: true, reason: 'earlier_batch_receiving',
                    queued: record.queued.length, waiting: record.waiting.length, sequence: seq };
            }
            record.queued = sortBySequence([...record.queued, summary]);
            record.receiving = record.receiving.filter(item => item.batchId !== key);
            record.accepted[key] = seq;
            await handle.put('meta', storeKeyOf(id), record);
            return { committed: true, mode, queued: record.queued.length, sequence: seq };
        });
    }

    /**
     * 丢弃未接纳的预留（接收失败/超时）：释放容量与正文，并**触发晋升**。
     * 与 completeBatch 对称：复核实测的另一半。
     */
    async function dropPending({ storeId, batchId }) {
        const id = text(storeId), key = text(batchId);
        return store.atomic(['meta', 'bodies'], async handle => {
            const record = await loadStore(handle, id);
            const before = record.receiving.length;
            const wasReceiving = record.receiving.some(item => item.batchId === key);
            record.receiving = record.receiving.filter(item => item.batchId !== key);
            /**
             * 只删除**未接纳**批次的记录：已接纳批次的正文与清单是执行输入，
             * 它的生命周期由 completeBatch/endStore 管理，不能被失败回滚误删。
             */
            if (wasReceiving) {
                await handle.del('meta', batchKeyOf(id, key));
                await dropBodies(handle, id, key);
            }
            const promoted = promote(record);
            await handle.put('meta', storeKeyOf(id), record);
            return { dropped: wasReceiving, promoted };
        });
    }

    async function headOf(storeId) {
        const id = text(storeId);
        if (!id) return null;
        const record = await store.get('meta', storeKeyOf(id));
        if (!record?.queued.length) return null;
        const head = record.queued[0];
        const batch = await store.get('meta', batchKeyOf(id, head.batchId));
        if (!batch) return { ...head, cursor: 0, items: [] };
        return { batchId: batch.batchId, sequence: num(batch.sequence), totalItems: num(batch.totalItems),
            totalBytes: num(batch.totalBytes), cursor: num(batch.cursor), chunkCount: num(batch.chunkCount),
            items: batch.manifest.map(item => item.itemId) };
    }

    /** 逐件游标：返回队首批次当前应执行的**一件**；批内耗尽返回 null。 */
    async function nextItem({ storeId, batchId }) {
        const id = text(storeId), key = text(batchId);
        const batch = await store.get('meta', batchKeyOf(id, key));
        if (!batch) throw fail('inbox_batch_not_reserved', { batchId: key });
        if (batch.status !== 'accepted') return null;
        const cursor = num(batch.cursor);
        if (cursor >= batch.manifest.length) return null;
        const item = batch.manifest[cursor];
        return { itemId: item.itemId, position: item.position, cursor, byteLength: num(item.byteLength) };
    }

    /** 游标推进：只有**明确终态**才由状态机调用；推进到批尾即 exhausted。 */
    async function advanceCursor({ storeId, batchId, itemId }) {
        const id = text(storeId), key = text(batchId);
        return store.atomic(['meta'], async handle => {
            const batch = await handle.get('meta', batchKeyOf(id, key));
            if (!batch) throw fail('inbox_batch_not_reserved', { batchId: key });
            const current = batch.manifest[num(batch.cursor)];
            if (!current || text(itemId) !== current.itemId) {
                return { advanced: false, reason: 'cursor_item_mismatch',
                    expected: current?.itemId || '', actual: text(itemId) };
            }
            batch.cursor = num(batch.cursor) + 1;
            await handle.put('meta', batchKeyOf(id, key), batch);
            return { advanced: true, cursor: batch.cursor, exhausted: batch.cursor >= batch.manifest.length };
        });
    }

    /** 读取一件商品的落盘正文（执行器的输入；也是"确实保存了 51 件"的证据来源）。 */
    async function readItem({ storeId, batchId, itemId }) {
        return store.get('bodies', bodyKeyOf(text(storeId), text(batchId), text(itemId)));
    }

    /**
     * 该批次完结（全部商品已结算）：移出可执行队列、回收正文，并**触发晋升**。
     */
    async function completeBatch({ storeId, batchId }) {
        const id = text(storeId), key = text(batchId);
        return store.atomic(['meta', 'bodies'], async handle => {
            const record = await loadStore(handle, id);
            const before = record.queued.length;
            record.queued = record.queued.filter(batch => batch.batchId !== key);
            record.retained = record.retained.filter(batch => batch.batchId !== key);
            await dropBodies(handle, id, key);
            /**
             * 批次完成后连**元数据**一并回收：它承载的 itemId/游标已不再需要，
             * 留着既占空间又会让"已完结批次"看起来仍可结算。
             * （结束保留的在途批次记录也在它结算完结时被这里清掉。）
             */
            await handle.del('meta', batchKeyOf(id, key));
            const promoted = promote(record);
            await handle.put('meta', storeKeyOf(id), record);
            return { removed: before - record.queued.length, promoted };
        });
    }

    /**
     * 结束：清空**本店**的 receiving / waiting / executable 三段并回收正文。
     * 只清本店，其他店与其他方向（来源采集）不受影响。
     *
     * `keepBatches`：**在途件所在批次必须保留记录**——它可能仍在平台请求中，
     * 结果回执要能结算（复核 P2：结束把在途批次的记录也删了，
     * 于是"结束了但收不到已发请求的结果"）。这些批次不在队列里，只作为
     * 在途件结算所需的身份与游标载体，结算完由 completeBatch 回收。
     */
    async function endStore({ storeId, keepBatches = [] } = {}) {
        const id = text(storeId);
        const keep = new Set(keepBatches.map(value => text(value)));
        return store.atomic(['meta', 'bodies'], async handle => {
            const record = await loadStore(handle, id);
            const all = [...record.queued, ...record.waiting, ...record.receiving, ...record.retained];
            const present = [...new Set(all.map(batch => batch.batchId))];
            const cleared = { queued: record.queued.length, waiting: record.waiting.length,
                receiving: record.receiving.length,
                keptInflight: present.filter(batchId => keep.has(batchId)) };
            for (const batchId of present) {
                record.retired[batchId] = true;
                // 在途载荷保留到结果结算，避免领取与读取正文之间结束导致输入丢失。
                if (!keep.has(batchId)) await dropBodies(handle, id, batchId);
                /**
                 * 在途批次的**元数据要保留**：它承载 itemId 与游标，
                 * 结算回执必须能落进来（复核 P2）。其余批次连元数据一并删除。
                 */
                if (!keep.has(batchId)) await handle.del('meta', batchKeyOf(id, batchId));
            }
            // 三段全部清空：结束后不得再执行旧待办，连在途批次的剩余件也不执行。
            record.queued = []; record.waiting = []; record.receiving = [];
            record.retained = all.filter((batch, index) => keep.has(batch.batchId)
                && all.findIndex(item => item.batchId === batch.batchId) === index);
            // 保留幂等证据及分界，结束并不等于允许旧消息重新执行。
            record.cutoffSequence = Math.max(record.cutoffSequence, record.highSequence);
            await handle.put('meta', storeKeyOf(id), record);
            return cleared;
        });
    }

    async function promoteWaiting(storeId) {
        const id = text(storeId);
        return store.atomic(['meta'], async handle => {
            const record = await loadStore(handle, id);
            const promoted = promote(record);
            if (promoted) await handle.put('meta', storeKeyOf(id), record);
            return { promoted };
        });
    }

    /** 观测：三段状态与容量（全部来自落盘记录）。 */
    async function snapshot(storeId = '') {
        if (storeId) {
            const id = text(storeId);
            const record = await store.get('meta', storeKeyOf(id));
            if (!record) return { storeId: id, queued: 0, waiting: 0, receiving: 0, usedBytes: 0, limitBytes: cfg.perStoreBytes };
            return { storeId: id, queued: record.queued.length, waiting: record.waiting.length,
                receiving: record.receiving.length, usedBytes: usedBytesOf(record), limitBytes: cfg.perStoreBytes };
        }
        const records = await readAllStores();
        return { stores: records.map(record => ({ storeId: record.storeId, queued: record.queued.length,
            waiting: record.waiting.length, receiving: record.receiving.length, usedBytes: usedBytesOf(record) })),
        instanceBytes: records.reduce((total, record) => total + usedBytesOf(record), 0), limitBytes: cfg.instanceBytes };
    }

    /**
     * 建立（或读取）本店索引。首次接收前调用；已存在即复用，
     * 这样后台重启后新实例能直接接到原有队列，而不是清空重来。
     */
    async function openStore(storeId) {
        const id = text(storeId);
        if (!id) throw fail('inbox_missing_store');
        return store.atomic(['meta'], async handle => {
            const existing = await handle.get('meta', storeKeyOf(id));
            if (existing) return { storeId: id, reused: true };
            await handle.put('meta', storeKeyOf(id), { kind: 'store', storeId: id, queued: [], waiting: [], receiving: [], accepted: {} });
            return { storeId: id, reused: false };
        });
    }

    return { openStore, reserve, acceptPart, commitBatch, dropPending, headOf, nextItem, advanceCursor, readItem,
        completeBatch, endStore, promoteWaiting, snapshot, limits: cfg, store,
        // 仅复用传入句柄，不持有可被并发调用覆盖的全局事务变量。
        inTransaction: handle => createTargetSessionInbox({ store: transactionInboxStore(handle), now, limits: cfg }) };
}
