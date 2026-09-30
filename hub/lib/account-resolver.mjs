/**
 * 店铺 → 认领账号的解析缓存。
 *
 * 为什么需要单独一层：账户身份在执行路径和上传路径都要用，而任务记录里只存
 * source_store/target_store，不存账号。每次去读认领文件会有 IO 开销，所以在内存里
 * 缓存一份带版本号的映射，认领关系变化时由调用方触发刷新。
 *
 * 解析失败一律返回空字符串，由调用方决定兜底策略（当前是退回按店铺/实例处理），
 * 不能让"查不到账号"变成拒绝服务。
 */

/** 缓存有效期：认领关系很少变，但也不能长期不刷新。 */
const DEFAULT_TTL_MS = 30 * 1000;

/**
 * @param {object} options
 * @param {() => Promise<object>} options.listAssignments 返回 { [storeId]: { ownerId, ... } }
 * @param {number} [options.ttlMs] 缓存有效期
 */
export function createAccountResolver({ listAssignments, ttlMs = DEFAULT_TTL_MS } = {}) {
    let cache = new Map();
    let loadedAt = 0;
    let inflight = null;

    /** 读取认领关系并刷新缓存；并发调用共享同一次读取。 */
    async function refresh() {
        if (typeof listAssignments !== 'function') return cache;
        if (inflight) return inflight;
        inflight = (async () => {
            try {
                const assignments = await listAssignments();
                const next = new Map();
                for (const [storeId, entry] of Object.entries(assignments || {})) {
                    const owner = String(entry?.ownerId || '').trim();
                    if (storeId && owner) next.set(String(storeId), owner);
                }
                cache = next;
                loadedAt = Date.now();
            } catch {
                // 读取失败保留旧缓存：宁可用稍旧的数据，也不要让所有调度突然失去账户维度。
            }
            return cache;
        })().finally(() => { inflight = null; });
        return inflight;
    }

    /**
     * 解析单个店铺的认领账号；未认领或读取失败返回空字符串。
     *
     * 注意：空串**同时**表示"未认领"和"查询失败"——调用方若需要区分，
     * 必须用 `classify`，不要用空串去猜。调度路径沿用这个宽松语义，
     * 避免一次数据库抖动就让所有账户维度突然失效。
     */
    async function resolve(storeId) {
        const key = String(storeId || '').trim();
        if (!key) return '';
        if (Date.now() - loadedAt > ttlMs) await refresh();
        const owner = cache.get(key);
        if (owner) return owner;
        // 首次未命中再强制刷新一次，覆盖"启动时缓存为空、随后有人认领"的情况。
        if (!loadedAt) { await refresh(); return cache.get(key) || ''; }
        return '';
    }

    /**
     * 严格解析：把"未认领"与"查询故障"分开。
     *
     * 为什么必须分开：混为一类会让数据库抖动被当成"这店没人认领"，
     * 商品于是静默进入待确认，而真正该做的是让客户端稍后重试（503）。
     * 返回 { status: 'owned'|'unclaimed'|'unavailable', accountId }。
     */
    async function classify(storeId) {
        const key = String(storeId || '').trim();
        if (!key) return { status: 'unclaimed', accountId: '' };
        if (typeof listAssignments !== 'function') return { status: 'unavailable', accountId: '', reason: 'no_source' };
        let failure = null;
        try {
            const assignments = await listAssignments();
            const next = new Map();
            for (const [storeIdKey, entry] of Object.entries(assignments || {})) {
                const owner = String(entry?.ownerId || '').trim();
                if (storeIdKey && owner) next.set(String(storeIdKey), owner);
            }
            cache = next; loadedAt = Date.now();
            const owner = next.get(key);
            return owner ? { status: 'owned', accountId: owner } : { status: 'unclaimed', accountId: '' };
        } catch (error) {
            failure = String(error?.message || error);
        }
        // 查询失败：**不**回退到旧缓存当作"已认领"，也不当成"未认领"。
        return { status: 'unavailable', accountId: '', reason: failure };
    }

    /** 批量解析：一次读取完成多个店铺的查询，供需要按账户分组的调度使用。 */
    async function resolveMany(storeIds = []) {
        if (Date.now() - loadedAt > ttlMs) await refresh();
        const out = new Map();
        for (const storeId of storeIds) {
            const key = String(storeId || '').trim();
            if (key) out.set(key, cache.get(key) || '');
        }
        return out;
    }

    return {
        resolve,
        /** 严格解析：区分"已认领/未认领/查询故障"，供新业务门控使用。 */
        classify,
        resolveMany,
        refresh,
        /** 观测用：当前缓存的认领店铺数。 */
        size: () => cache.size
    };
}
