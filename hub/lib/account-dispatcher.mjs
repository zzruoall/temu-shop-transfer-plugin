/**
 * 账户分发器：把公平算法接到**真实持久候选**上。
 *
 * 对应方案步骤3。与 `account-scheduler.mjs` 的分工：
 * - scheduler 只决定"该轮到哪个账户"（虚拟时间 + 最久未服务），不碰数据库；
 * - dispatcher 负责从库里**按账户游标分页**取候选、按方向与店铺轮转、记账与让位。
 *
 * 必须解决的问题（方案第 3.3 节）：
 * - 候选不能只取"全局最早若干工作行"：大量积压、离线或 unknown 的账户会把就绪账户挡在页外
 *   （第 6 条）；后加入的账户必须也能被选中（第 6 条、验收清单"候选超过分页窗口"）。
 * - 恢复当前检查点与领取新商品分开（第 7 条）：否则持有业务槽的账户会被自己的 waiting 挡住。
 * - 只有成功取得资源和账户槽才记服务量（第 2 条）：失败申请不算完成一次服务。
 */
import { createAccountScheduler } from './account-scheduler.mjs';

/** 候选类型：新工作与续片分开，两者都要参与公平竞争。 */
export const CANDIDATE_KIND = Object.freeze({ fresh: 'fresh', resume: 'resume' });
/**
 * 按账户取店铺/方向桶头，桶内保持 created_at/work_id 的先后顺序。
 *
 * @param {object} args
 * @param {object} args.database 数据库
 * @param {string[]} args.accountIds 参与本轮调度的账户（**有序**，由调用方按公平顺序给出）
 * @param {number} args.perAccountLimit 每账户最多返回多少个桶头（不是商品前缀）
 * @param {Map<string, {storeId: string, direction: string}>} args.bucketCursors 各账户上次选中桶；只读，未获选账户不推进
 * @param {string} args.direction 可选：限定方向
 */
export async function listAccountCandidates({ database, accountIds = [], perAccountLimit = 20, direction = '', bucketCursors = new Map(), requireExecutionContext = false, elastic = null, now = new Date().toISOString() }) {
    const accounts = [...new Set(accountIds.map(id => String(id || '').trim()).filter(Boolean))];
    if (!accounts.length) return [];
    const out = [];
    // 在数据库中先取每桶最早一件，再应用窗口；先截商品前缀会让大店遮住小店和另一方向。
    for (const accountId of accounts) {
        const filters = ["account_id=?", "status='queued'", "(next_run_at='' OR next_run_at<=?)"];
        const params = [accountId, now];
        // 仍占准备槽的账户不能再领新工作；弹性模式已交接给插件的业务不占这个准备槽。
        filters.push("NOT EXISTS (SELECT 1 FROM hub_account_runtime r WHERE r.account_id=hub_account_work.account_id AND r.current_work_id<>'' AND r.state<>'idle')");
        // 同店串行，不让被占用店铺的桶头遮住本账户的其他店铺。
        if (elastic) {
            filters.push('NOT EXISTS (SELECT 1 FROM hub_elastic_work_slots s WHERE s.store_id=hub_account_work.store_id)');
            filters.push('(SELECT COUNT(*) FROM hub_elastic_work_slots s WHERE s.account_id=hub_account_work.account_id) < ?');
            params.push(elastic.snapshot().perAccountLimit);
        }
        if (requireExecutionContext) filters.push("run_id<>'' AND execution_run_id=run_id AND actor_id<>'' AND ownership_generation<>''");
        if (direction) { filters.push('direction=?'); params.push(direction); }
        const cursor = bucketCursors.get(accountId) || { storeId: '', direction: '' };
        // 排序与游标比较都由数据库使用相同排序规则执行；游标之后的桶优先，末尾自动回绕。
        // 每桶只返回一件，积压量不改变桶份额；窗口外的桶将在已选桶游标推进后进入窗口。
        const [rows] = await database.query('maintenance',
            `SELECT * FROM (
                SELECT hub_account_work.*, ROW_NUMBER() OVER (
                    PARTITION BY store_id, direction ORDER BY created_at, work_id
                ) AS bucket_rank
                FROM hub_account_work WHERE ${filters.join(' AND ')}
             ) bucket_heads WHERE bucket_rank=1
             ORDER BY CASE WHEN store_id > ? OR (store_id = ? AND direction > ?) THEN 0 ELSE 1 END,
                      store_id, direction LIMIT ?`, [...params, cursor.storeId, cursor.storeId, cursor.direction, perAccountLimit]);
        for (const row of rows) {
            out.push({
                owner: accountId,
                kind: CANDIDATE_KIND.fresh,
                workId: row.work_id,
                storeId: row.store_id,
                direction: row.direction,
                // 成本：这里用 1 作为等成本基准。真实成本（CPU/字节）接入后再按账户分别记账，
                // 不能先用大小商品完成数相同来声称公平。
                cost: 1
            });
        }
    }
    return out;
}

/**
 * 续片候选：账户槽被自己占用、但工作处于 waiting 且已到期的那些。
 * 与 fresh 分开列出，避免"持有槽的账户被自己挡住"。
 */
export async function listResumeCandidates({ database, accountIds = [], requireExecutionContext = false, now = new Date().toISOString() }) {
    const accounts = [...new Set(accountIds.map(id => String(id || '').trim()).filter(Boolean))];
    if (!accounts.length) return [];
    const placeholders = accounts.map(() => '?').join(',');
    const [rows] = await database.query('maintenance',
        `SELECT w.* FROM hub_account_work w
         JOIN hub_account_runtime r ON r.account_id = w.account_id AND r.current_work_id = w.work_id
         WHERE w.account_id IN (${placeholders}) AND w.status='waiting'
           AND r.state='waiting' AND (w.next_run_at='' OR w.next_run_at<=?)
           ${requireExecutionContext ? "AND w.run_id<>'' AND w.execution_run_id=w.run_id AND w.actor_id<>'' AND w.ownership_generation<>''" : ''}`, [...accounts, now]);
    return rows.map(row => ({
        owner: row.account_id,
        kind: CANDIDATE_KIND.resume,
        workId: row.work_id,
        storeId: row.store_id,
        direction: row.direction,
        cost: 1
    }));
}

/**
 * 从数据库发现**有就绪工作的账户**。
 *
 * 为什么不能只靠内存 `registerAccounts`：进程重启后内存集合是空的，
 * 已有的 queued 工作将永远选不到（复核指出"重启漏队列"）。
 * 这里按持久工作表发现候选，内存注册仅作为补充。
 */
export async function discoverReadyAccounts({ database, limit = 200, afterAccountId = '', requireExecutionContext = false, now = new Date().toISOString() }) {
    // fresh 与 resume 共用账户 ID 游标和一个窗口，避免两条固定前缀查询分别遮住后续账户。
    // 不按 MIN(created_at) 分页：完成/新增商品会改变排序键，使游标跳过仍未发现的账户。
    const [rows] = await database.query('maintenance',
        `SELECT account_id FROM (
         SELECT account_id FROM hub_account_work
         WHERE status='queued' AND (next_run_at='' OR next_run_at<=?)
         AND NOT EXISTS (SELECT 1 FROM hub_account_runtime r WHERE r.account_id=hub_account_work.account_id AND r.current_work_id<>'' AND r.state<>'idle')
         ${requireExecutionContext ? "AND run_id<>'' AND execution_run_id=run_id AND actor_id<>'' AND ownership_generation<>''" : ''}
         UNION
         SELECT w.account_id FROM hub_account_work w
         JOIN hub_account_runtime r ON r.account_id = w.account_id AND r.current_work_id = w.work_id
         WHERE w.status='waiting' AND r.state='waiting' AND (w.next_run_at='' OR w.next_run_at<=?)
         ${requireExecutionContext ? "AND w.run_id<>'' AND w.execution_run_id=w.run_id AND w.actor_id<>'' AND w.ownership_generation<>''" : ''}
         ) ready_accounts WHERE account_id > ?
         ORDER BY account_id LIMIT ?`, [now, now, afterAccountId, limit]);
    return rows.map(row => String(row.account_id));
}

/**
 * 分发器：按账户公平顺序产出候选，并把"成功服务"记账。
 *
 * 记账规则（方案第 3.3 节第 2 条）：只有 `recordServed` 被显式调用才推进虚拟时间。
 * 领取失败、被资源预算拒绝、账户被取消——都不算服务，也就不该消耗它的公平份额。
 */
export function createAccountDispatcher({ database, scheduler = createAccountScheduler(),
    perAccountLimit = 20, requireExecutionContext = false, elastic = null, now = () => new Date().toISOString() } = {}) {
    const knownAccounts = new Set();
    const cursors = new Map();
    let discoveryCursor = '';
    let refreshing = null;

    /** 登记参与调度的账户；新账户加入后必须能参与竞争，不能被固定前缀垄断。 */
    function registerAccounts(accountIds = []) {
        for (const id of accountIds) {
            const key = String(id || '').trim();
            if (key) knownAccounts.add(key);
        }
        return [...knownAccounts];
    }

    /**
     * 取下一个候选。
     * @returns {Promise<{candidate: object|null, reason: string, order: string[]}>}
     */
    async function next({ direction = '', includeResume = true } = {}) {
        const accounts = [...knownAccounts];
        if (!accounts.length) return { candidate: null, reason: 'no_accounts', order: [] };
        if (elastic && elastic.snapshot().processLimit < 1) return { candidate: null, reason: 'elastic_capacity_wait', order: [] };
        const fresh = await listAccountCandidates({ database, accountIds: accounts, perAccountLimit, direction, bucketCursors: cursors, requireExecutionContext, elastic, now: now() });
        const resume = includeResume
            ? await listResumeCandidates({ database, accountIds: accounts, requireExecutionContext, now: now() })
            : [];
        // 续片保留独立 kind，同账户优先续接已有槽，不用新工作替换它。
        const pool = [...resume, ...fresh];
        if (!pool.length) return { candidate: null, reason: 'no_candidates', order: [] };
        // 每账户只交一个桶头给 scheduler；它只负责账户公平，不能再用内部游标抵消桶轮转。
        const heads = new Map();
        for (const item of pool) if (!heads.has(item.owner)) heads.set(item.owner, item);
        let eligible = [...heads.values()];
        if (elastic) {
            const [rows] = await database.query('maintenance', 'SELECT account_id,COUNT(*) AS n FROM hub_elastic_work_slots GROUP BY account_id');
            const occupancy = new Map(rows.map(row => [row.account_id, Number(row.n)]));
            const total = rows.reduce((sum, row) => sum + Number(row.n), 0);
            eligible = eligible.filter(item => item.kind === CANDIDATE_KIND.resume || total < elastic.snapshot().businessLimit);
            // 优先给尚未获得份额的就绪账户，平局继续使用原有虚拟服务量公平算法。
            const least = Math.min(...eligible.map(item => occupancy.get(item.owner) || 0));
            eligible = eligible.filter(item => (occupancy.get(item.owner) || 0) === least);
        }
        const { picked, order } = scheduler.pick(eligible);
        if (picked?.kind === CANDIDATE_KIND.fresh) {
            // 只推进本次实际选中的账户。失败尝试也让下个桶获得机会，但不增加账户服务量。
            cursors.set(picked.owner, { storeId: picked.storeId, direction: picked.direction });
        }
        return { candidate: picked || null, reason: picked ? '' : 'no_candidates', order };
    }

    /**
     * 记账：只有真正拿到资源与账户槽后才调用。
     * @param {string} owner 账户
     * @param {number} cost 本次成本（缺省 1）
     */
    function recordServed(owner, cost = 1) {
        return scheduler.recordServed(owner, cost);
    }

    /**
     * 用数据库中的就绪账户刷新参与集合。
     * 重启后没有内存注册也能继续调度，不依赖调用方"记得注册"。
     */
    async function refreshAccounts() {
        // 并发唤醒共享同一次发现，防止较晚返回的旧页把游标倒写；失败时保留游标供重试。
        if (refreshing) return refreshing;
        refreshing = (async () => {
            const limit = 200;
            const scanAt = now();
            let ready = await discoverReadyAccounts({ database, limit, afterAccountId: discoveryCursor, requireExecutionContext, now: scanAt });
            // 游标行删除或刚好整页时可能遇到空尾页，最多补查一次首屏，不做无界循环。
            if (!ready.length && discoveryCursor) {
                ready = await discoverReadyAccounts({ database, limit, requireExecutionContext, now: scanAt });
            }
            discoveryCursor = ready.length === limit ? ready.at(-1) : '';
            registerAccounts(ready);
            return [...knownAccounts];
        })();
        try { return await refreshing; }
        finally { refreshing = null; }
    }

    return {
        registerAccounts,
        refreshAccounts,
        next,
        recordServed,
        knownAccounts: () => [...knownAccounts],
        snapshot: () => scheduler.snapshot(),
        reset: () => { scheduler.reset(); cursors.clear(); discoveryCursor = ''; }
    };
}

/**
 * 惰性清单：大批量发送不能一次物化全部目标工作。
 *
 * 5000 商品 × 200 店 = 100 万目标组合。若一次生成 100 万个大对象，
 * 内存与磁盘都会先垮掉，而不是公平性问题。这里只保留清单与窗口游标，
 * 由调度器按窗口逐项物化（方案第 3.3 节第 8 条、第 4 节"就绪工作物化窗口"）。
 *
 * 窗口语义（复核 P1-4 修正）：
 * - **游标**（cursor）是持久进度：只增不减，表示"已物化到第几项"；
 * - **在途数**（inflight）是当前已被物化但尚未确认消费的数量；
 * - 因此容量判断必须用 `cursor` 与 `inflight`，不能用 `cursor` 本身——
 *   把累计进度当成占用量，会让清单在生成 2000 项后彻底卡死（剩余 3000 项无法推进）。
 * 消费完成必须调用 `release()` 回收在途额度。
 */
export function createLazyManifest({ jobId, spuIds = [], targetStoreIds = [], globalWindow = 2000, perAccountWindow = 100 } = {}) {
    const spus = [...spuIds];
    const stores = [...targetStoreIds];
    const totalPairs = spus.length * stores.length;
    // 持久进度：下一个要物化的下标。只增不减。
    let cursor = 0;
    // 在途额度：已物化但未 release 的数量。这是窗口的真正占用。
    let inflight = 0;
    const perAccountInflight = new Map();

    return {
        jobId,
        totalPairs,
        /** 尚未物化的组合数（按持久进度算，不受在途影响）。 */
        remaining: () => totalPairs - cursor,
        /** 在途（已物化未确认消费）数量。 */
        inflight: () => inflight,
        /** 物化进度总量，供对账使用。 */
        materializedTotal: () => cursor,
        /**
         * 取下一窗口。返回的是**引用+目标店**，不复制商品正文。
         * 两个上限同时生效：全局窗口保护服务，每账户窗口避免一个账户先占满窗口。
         * 取出的项计入在途，必须由调用方在消费完成后 `release()`。
         */
        take({ accountId = '', limit = globalWindow } = {}) {
            const account = String(accountId || '');
            const accountUsed = perAccountInflight.get(account) || 0;
            const accountRoom = Math.max(0, perAccountWindow - accountUsed);
            const room = Math.min(limit, globalWindow - inflight, accountRoom, totalPairs - cursor);
            if (room <= 0) return [];
            const batch = [];
            for (let i = 0; i < room; i += 1) {
                const index = cursor + i;
                const spuId = spus[index % spus.length];
                const targetStoreId = stores[Math.floor(index / spus.length) % stores.length];
                // 只存引用与目标店：商品正文按不可变 hash 引用，不在这里复制。
                batch.push({ jobId, spuId, targetStoreId, sourceRef: `job:${jobId}/spu:${spuId}` });
            }
            cursor += room;
            inflight += room;
            perAccountInflight.set(account, accountUsed + room);
            return batch;
        },
        /**
         * 回收在途额度：某项确认消费（已写入持久任务或被明确丢弃）后调用。
         * 不回收会让窗口逐步被占满；**不能**用"重置账户窗口"代替它——
         * 那样只是把每账户计数清零，全局在途仍然占满。
         *
         * 释放量以**该账户自己持有的额度**为上限：否则一个没有在途任务的账户
         * 可以释放别人占用的全局容量，把在途硬上限直接放空（复核实测 B 释放了 A 的 2 个）。
         */
        release({ accountId = '', count = 1 } = {}) {
            const account = String(accountId || '');
            const accountUsed = perAccountInflight.get(account) || 0;
            // 三重上限：请求数量、该账户持有量、全局在途量。
            const amount = Math.max(0, Math.min(Number(count) || 0, accountUsed, inflight));
            if (amount > 0) {
                inflight -= amount;
                perAccountInflight.set(account, accountUsed - amount);
            }
            return { released: amount, inflight, accountInflight: perAccountInflight.get(account) || 0 };
        },
        /** 该账户当前在途多少。 */
        materializedFor: accountId => perAccountInflight.get(String(accountId || '')) || 0,
        /**
         * 兼容旧名：把某账户在途清零。
         * 注意它**同时回收全局在途**——只清账户计数会让全局窗口永久占满。
         */
        resetAccountWindow: accountId => {
            const account = String(accountId || '');
            const accountUsed = perAccountInflight.get(account) || 0;
            inflight = Math.max(0, inflight - accountUsed);
            perAccountInflight.set(account, 0);
            return inflight;
        }
    };
}
