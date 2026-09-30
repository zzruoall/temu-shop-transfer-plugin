/**
 * 入库接收限流与字节预算；等待时不读取请求体，发布回执不共用此队列。
 *
 * 排队顺序按账户公平选择，而不是全局先到先服务：
 * 原来固定取 queue[0]，先提交的账户会连续占满名额，后加入的账户一直排在队尾。
 * 现在由账户调度器挑下一个可放行的请求，账户之间等权轮转。
 * 字节预算仍是硬约束：选中的请求放不下就退回最早的能放下的项，
 * 避免一个超出剩余预算的大包把它后面的小包一起挡住。
 */
import { createAccountScheduler } from './account-scheduler.mjs';

export function createIngestAdmission({ limit = 2, maxPending = 128, maxBytes = 64 * 1024 * 1024, waitMs = 15000, largePacketBytes = 8 * 1024 * 1024,
    scheduler = createAccountScheduler(), perAccountPending = 16, perAccountBytes = 64 * 1024 * 1024,
    // 解析工作集单独一份额度：它约束的是"同时解析几个大包"，不是"能收多大的包"。
    // 之前把 size×3 的解析预留算进 perAccountBytes，导致超过 8MiB/3 ≈ 2.67MiB 的包
    // 永远满足不了自己账户的配额——协议允许 64MiB，却连 3MiB 都进不来（死条件）。
    parserSlots = 1, capacity = null } = {}) {
    let active = 0, bytes = 0;
    const queue = [];
    // 正在处理的条目单独记账：账户配额要同时约束"排队中 + 处理中"，
    // 否则 limit 一放开，请求立刻转入处理态，排队配额就形同虚设。
    const running = new Set();
    const busy = (message = 'ingest_capacity_wait') => Object.assign(new Error(message), { status: 429, retryAfter: 15 });

    /**
     * 接收预留：只按**本份请求的实际传输与暂存占用**记账，不乘解析系数。
     * 大包按独占接收位处理（同一时刻只允许一个大包在收），因此预留取包本身大小即可。
     */
    function reservationFor(size) {
        if (size > largePacketBytes) return size;
        return Math.max(1, size);
    }

    /** 大包需要独占解析工作集名额：同时只允许 parserSlots 个在解析。 */
    function parsingCount() {
        let count = 0;
        for (const entry of running) if (entry.parser) count += 1;
        return count;
    }

    /** 某账户当前占用的名额与字节，含排队中与处理中。 */
    function usageOf(owner) {
        let pending = 0, reserved = 0;
        for (const entry of queue) {
            if (entry.owner !== owner) continue;
            pending += 1;
            reserved += entry.bytes;
        }
        for (const entry of running) {
            if (entry.owner !== owner) continue;
            pending += 1;
            reserved += entry.bytes;
        }
        return { pending, reserved };
    }

    /** 按账户公平选一个可放行的下标；预算内才参与竞争，挑不到返回 -1。 */
    function chooseIndex() {
        if (!queue.length) return -1;
        const fits = entry => bytes + entry.bytes <= maxBytes;
        // 解析工作集名额：已满时**只放行不需要解析位的小包**，大包继续排队。
        // 这样大包不会把后续小包一起挡住，也不会一次占满整机解析内存。
        const parserFree = parsingCount() < parserSlots;
        const eligible = entry => fits(entry) && (!entry.parser || parserFree);
        let withinBudget = queue.filter(eligible);
        if (!withinBudget.length) return -1;
        if (capacity) {
            // 弹性借用先满足尚未占位账户；相同占用再按已有公平服务量轮转。
            const held = owner => [...running].filter(entry => entry.owner === owner).length;
            const least = Math.min(...withinBudget.map(entry => held(entry.owner)));
            withinBudget = withinBudget.filter(entry => held(entry.owner) === least);
        }
        const { picked } = scheduler.pick(withinBudget);
        const index = picked ? queue.indexOf(picked) : -1;
        if (index >= 0) return index;
        // 兜底：调度器没给出候选时按最早可放行的项，保证队列不会因此停滞。
        return queue.findIndex(eligible);
    }

    const pump = () => {
        for (;;) {
            if (!queue.length || active >= currentLimit()) return;
            const index = chooseIndex();
            if (index < 0) return;
            const next = queue.splice(index, 1)[0];
            clearTimeout(next.timer);
            next.signal?.removeEventListener('abort', next.cancel);
            active++; bytes += next.bytes; running.add(next);
            // 放行即完成一次服务：这里必须显式记账。
            // scheduler.pick 现在只做选择（调用方可能拿不到资源），
            // 而准入队列的"放行"就是成功取得资源的时刻，不记账会让轮转退化成先到先服务。
            scheduler.recordServed(next.owner || '', next.cost);
            let released = false;
            next.resolve(() => {
                if (released) return;
                released = true; active--; bytes -= next.bytes; running.delete(next); pump();
            });
        }
    };
    /** 缺失或非法实时预算一律停止新接收，已接收数据仍正常完成和释放。 */
    function currentLimit() {
        const value = capacity ? capacity() : limit;
        return Number.isInteger(value) && value >= 0 ? Math.min(limit, value) : 0;
    }
    return {
        // 采样恢复时主动唤醒，不依赖另一个请求到来或已有请求释放。
        refreshCapacity: pump,
        snapshot: () => ({ active, pending: queue.length, bytes, limit: currentLimit(), maxBytes, perAccountPending, perAccountBytes,
            parsing: parsingCount(), parserSlots }),
        /**
         * 未声明长度时预留整份预算；超限包必须拆批，不能让两个巨包撑爆服务器内存。
         *
         * 三层配额分开记账（对应方案第四节）：
         * - **接收字节**：全局 maxBytes + 每账户 perAccountBytes，按包的实际大小预留；
         * - **解析工作集**：大包要占用 parserSlots 名额，与接收额度解耦——
         *   接收额度不该被解析系数拖到永远无法满足；
         * - **排队位**：全局 maxPending + 每账户 perAccountPending。
         */
        acquire(size = maxBytes, signal, owner = '') {
            if (!Number.isFinite(size) || size < 0 || size > maxBytes) {
                return Promise.reject(Object.assign(new Error('ingest_packet_too_large'), { status: 413 }));
            }
            if (signal?.aborted) return Promise.reject(Object.assign(new Error('upload_aborted'), { status: 499 }));
            if (queue.length >= maxPending) return Promise.reject(busy());
            const account = String(owner || '');
            // 该账户已排满自己的额度：拒绝它的新请求，但不动全局队列，其他账户不受影响。
            const usage = usageOf(account);
            if (usage.pending >= perAccountPending) return Promise.reject(busy('ingest_account_quota'));
            return new Promise((resolve, reject) => {
                // 大包按独占接收位处理：它需要解析工作集名额，但不因此把接收额度乘成三倍。
                const parser = size > largePacketBytes;
                const entry = { bytes: reservationFor(size), owner: account, parser, resolve, signal };
                // 账户字节配额按**接收预留**校验；解析开销由 parserSlots 单独约束。
                if (usage.reserved + entry.bytes > perAccountBytes) {
                    reject(busy('ingest_account_quota'));
                    return;
                }
                const remove = error => {
                    const index = queue.indexOf(entry);
                    if (index < 0) return;
                    queue.splice(index, 1); clearTimeout(entry.timer);
                    signal?.removeEventListener('abort', entry.cancel);
                    reject(error); pump();
                };
                entry.cancel = () => remove(Object.assign(new Error('upload_aborted'), { status: 499 }));
                entry.timer = setTimeout(() => remove(busy()), waitMs);
                signal?.addEventListener('abort', entry.cancel, { once: true });
                queue.push(entry); pump();
            });
        }
    };
}
