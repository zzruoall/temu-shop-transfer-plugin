/**
 * 账户公平调度：按账户等权轮转，而不是全局按时间先后排队。
 *
 * 解决的问题：原来的领取顺序是 next_run_at/created_at，先到的账户连续提交会让
 * 后加入的账户一直排在队尾；"每账户上限"只限制积压量，不决定谁先被处理。
 *
 * 采用的规则（对应方案第 3.2 节）：
 * - 等权账户轮转，不引入套餐权重。每账户获得的份额只由它自己的服务量决定。
 * - 账户内部再按店铺/批次轮转，避免一个账户的同一家店连续占用。
 * - 空闲借用与归还：账户离场期间不累积"债务"；回来时对齐到当前最小虚拟时间，
 *   所以既有账户在别人不在时多用的份额不会在对方回来后压住对方。
 * - 空转保护：没有可运行候选时立即返回，不做无意义循环。
 *
 * 为什么用虚拟时间而不是封顶赤字：
 * 赤字一旦撞到上限，两个账户的比较就变成相等，排序退化成按账户名固定先后，
 * 结果是一个账户近乎独占（实测 700 次里 A=595、B=105）。虚拟时间单调递增、
 * 永不饱和，等成本任务下必然严格交替。
 *
 * 这里只做"选择顺序"，不执行任务、不碰数据库；调用方按返回的顺序自行领取。
 */

/** 单账户一次服务的默认成本单位。 */
export const DEFAULT_COST = 1;

/**
 * @param {object} options
 * @param {number} [options.maxVirtualAdvance] 单次服务允许推进的虚拟时间上限，
 *   防止超大包用一次服务就吃掉极多份额。
 */
export function createAccountScheduler({ maxVirtualAdvance = 64 } = {}) {
    // 每个账户的调度状态：虚拟时间（越小越先被服务）、内部游标、是否在本轮候选里。
    const accounts = new Map();
    // 单调递增的服务序号，用作"最久未被服务"的判据，不受账户名字典序影响。
    let tick = 0;

    function stateOf(owner) {
        const key = String(owner || "");
        if (!accounts.has(key)) {
            // lastServed 记录"最近一次被服务的序号"，用作虚拟时间相同时的平局判据。
            // 用账户名兜底会让同名字典序的账户长期优先，那是"看起来轮转、实际独占"的根源。
            accounts.set(key, { owner: key, virtualTime: 0, cursor: 0, served: 0, active: false, waited: 0, lastServed: -1 });
        }
        return accounts.get(key);
    }

    /** 按账户归组，组内保持调用方给的先后（通常已按店铺/批次排好）。 */
    function groupByOwner(candidates) {
        const groups = new Map();
        for (const item of candidates) {
            const key = String(item.owner || "");
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(item);
        }
        return groups;
    }

    /**
     * 决定本轮账户顺序：虚拟时间小者优先；相同时"最久未被服务"者优先。
     *
     * 重新加入的账户对齐到当前最小虚拟时间（floor）：
     * - 它不在场时别人多用资源，不该在它回来后变成它的欠账；
     * - 它自己也不因为长期离场而囤积信用，回来就能立即参与竞争。
     * 对齐后它的 lastServed 是旧的（更久没被服务），所以能在同分时胜出，
     * 从而避免"新账户排在队尾等若干轮"。
     */
    function orderOwners(groups) {
        const keys = [...groups.keys()];
        for (const key of keys) stateOf(key);
        // 本轮不在候选里的账户标记离场，下次回来重新起步。
        for (const entry of accounts.values()) if (!keys.includes(entry.owner)) entry.active = false;
        const returning = keys.filter(key => !stateOf(key).active);
        if (returning.length) {
            const staying = keys.filter(key => stateOf(key).active);
            // 只对齐到"持续在场"账户的最小虚拟时间；没有则从 0 起。
            const floor = staying.length ? Math.min(...staying.map(key => stateOf(key).virtualTime)) : 0;
            for (const key of returning) {
                const entry = stateOf(key);
                entry.virtualTime = floor;
                entry.active = true;
            }
        }
        return keys.sort((left, right) => {
            const a = stateOf(left), b = stateOf(right);
            const diff = a.virtualTime - b.virtualTime;
            if (diff !== 0) return diff;
            // 同分时最久未被服务者优先；再同分才用账户号保证结果可复现。
            if (a.lastServed !== b.lastServed) return a.lastServed - b.lastServed;
            return left.localeCompare(right);
        });
    }

    /** 一次服务记账：推进虚拟时间并计数。成本按调用方给的权重累计，缺省为 1。 */
    function recordServed(owner, cost = DEFAULT_COST) {
        const entry = stateOf(owner);
        const weight = Number.isFinite(cost) && cost > 0 ? cost : DEFAULT_COST;
        entry.virtualTime += Math.min(maxVirtualAdvance, weight);
        entry.served += 1;
        entry.waited = 0;
        // 记录服务序号：虚拟时间相同时用它判"谁更久没被服务"。
        entry.lastServed = tick += 1;
        return entry;
    }

    /** 本轮未被服务的账户累计等待轮数，用于观测饥饿（不参与排序，排序由虚拟时间保证）。 */
    function recordWaited(groups, chosenOwner) {
        for (const key of groups.keys()) {
            if (key === chosenOwner) continue;
            stateOf(key).waited += 1;
        }
    }

    /**
     * 从候选中挑出下一个要服务的项（单步）。业务入口用的就是这个方法。
     *
     * **只选择、不记账**：选择是纯查询，调用方可能随后被资源预算拒绝、
     * 被取消、或拿不到账户槽。若在这里就推进虚拟时间，等于"没做成事也扣份额"，
     * 既让被拒的账户白吃亏，也会在调用方成功后再记一次变成双重计数（复核 P2-1）。
     * 记账统一由 recordServed 在**真正取得资源与账户槽之后**显式完成。
     */
    function pick(candidates = []) {
        if (!candidates.length) return { picked: null, order: [] };
        const groups = groupByOwner(candidates);
        const order = orderOwners(groups);
        const chosenOwner = order[0];
        const bucket = groups.get(chosenOwner);
        const entry = stateOf(chosenOwner);
        // 账户内部轮转：游标推进，同一账户的多个店铺/批次不连续占用。
        const index = entry.cursor % bucket.length;
        entry.cursor = (entry.cursor + 1) % bucket.length;
        const picked = bucket[index];
        recordWaited(groups, chosenOwner);
        return { picked, order };
    }

    /**
     * 连续挑出 count 个。与单步 pick 由同一套虚拟时间规则驱动，
     * 两者在等成本、持续可运行的场景下都应得到等权结果。
     *
     * 与 `pick` 的差别：这是"一次批量取走并立即使用"的语义（调用方一次性拿到全部），
     * 因此每个被取出的项都直接计一次服务。业务入口逐件申请资源时请用单步 `pick` +
     * 成功后 `recordServed`，不要用本方法。
     */
    function pickMany(candidates = [], count = 1) {
        const pool = [...candidates];
        const picked = [];
        while (picked.length < count && pool.length) {
            const { picked: item } = pick(pool);
            if (!item) break;
            picked.push(item);
            pool.splice(pool.indexOf(item), 1);
            recordServed(item.owner, item.cost);
        }
        return picked;
    }

    return {
        pick,
        pickMany,
        /**
         * 一次服务记账：只有**真正取得资源与账户槽**后才调用。
         * 被拒绝、被取消、资源不足的申请都不该消耗账户的公平份额，
         * 因此记账是显式调用，而不是在 pick 内自动完成。
         */
        recordServed,
        /** 服务量记账对账用：各账户已获服务次数、虚拟时间与等待轮数。 */
        snapshot: () => [...accounts.values()].map(entry => ({ ...entry })),
        reset: () => accounts.clear()
    };
}
