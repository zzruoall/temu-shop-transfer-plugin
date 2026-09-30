/**
 * 账户公平调度的确定性验证。
 *
 * 测试方式刻意贴近业务入口：业务用单步 pick() 逐个取，所以这里也用 pick() 逐个取，
 * 只有"连续取一段"的用例才用 pickMany。之前只测 pickMany 导致漏掉了
 * "单步调用下退化成按账户名排序"的缺陷，本文件不再重复这个错误。
 *
 * 全部纯内存、无网络、无数据库；不操作真实店铺或商品。
 */
import assert from 'node:assert/strict';
import { createAccountScheduler } from '../lib/account-scheduler.mjs';

/**
 * 模拟业务入口：单步 pick() 选择，**取得资源后**再用 recordServed 记账。
 * 业务真实顺序就是"先选、再申请资源与账户槽、成功才记一次服务"，
 * 因此测试必须复刻这个顺序；只在 pick 里隐式记账会让被拒的申请也扣份额。
 */
function runSingleStep(scheduler, owners, steps) {
    const counts = {};
    for (const owner of owners) counts[owner] = 0;
    for (let i = 0; i < steps; i += 1) {
        // 每个账户始终有等成本候选：这正是"两个账户始终有任务、任务成本相同"的真实场景。
        const { picked } = scheduler.pick(owners.map(owner => ({ owner, id: `${owner}-${i}` })));
        if (!picked) break;
        counts[picked.owner] += 1;
        scheduler.recordServed(picked.owner, picked.cost); // 资源已取得 → 记一次服务
    }
    return counts;
}

function spreadOf(counts) {
    const values = Object.values(counts);
    return Math.max(...values) - Math.min(...values);
}

// 一、业务入口的长期公平：两账户各 700 次必须等权。
// 这是外部检查复现出 A=595/B=105 的那个场景，直接用单步 pick() 复刻。
{
    const scheduler = createAccountScheduler();
    const counts = runSingleStep(scheduler, ['A', 'B'], 700);
    assert.equal(counts.A, 350, `单步调用下 A 应得 350 次，实际 ${counts.A}`);
    assert.equal(counts.B, 350, `单步调用下 B 应得 350 次，实际 ${counts.B}`);
}

// 二、单步调用下也不得出现连续独占：任何账户连续被服务不超过一次。
{
    const scheduler = createAccountScheduler();
    const owners = ['A', 'B'];
    const sequence = [];
    for (let i = 0; i < 40; i += 1) {
        const { picked } = scheduler.pick(owners.map(owner => ({ owner, id: `${owner}-${i}` })));
        sequence.push(picked.owner);
        scheduler.recordServed(picked.owner, picked.cost);
    }
    for (let i = 1; i < sequence.length; i += 1) {
        assert.notEqual(sequence[i], sequence[i - 1], `出现连续独占：${sequence.join('')}`);
    }
}

// 三、三账户单步调用同样等权。
{
    const scheduler = createAccountScheduler();
    const counts = runSingleStep(scheduler, ['A', 'B', 'C'], 900);
    assert.equal(spreadOf(counts), 0, `三账户必须精确等权，实际 ${JSON.stringify(counts)}`);
}

// 四、积压量不改变账户权重：A 有 10 个候选、B 只有 1 个，服务次数仍相等。
{
    const scheduler = createAccountScheduler();
    const counts = { A: 0, B: 0 };
    for (let i = 0; i < 600; i += 1) {
        const candidates = [
            ...Array.from({ length: 10 }, (_, k) => ({ owner: 'A', id: `a${i}-${k}` })),
            { owner: 'B', id: `b${i}` }
        ];
        const { picked } = scheduler.pick(candidates);
        counts[picked.owner] += 1;
        scheduler.recordServed(picked.owner, picked.cost);
    }
    assert.equal(spreadOf(counts), 0, `积压量不得改变权重，实际 ${JSON.stringify(counts)}`);
}

// 五、账户内部轮转：同一账户的多家店轮流被服务，不是同一家店连续占用。
{
    const scheduler = createAccountScheduler();
    const stores = [];
    for (let i = 0; i < 6; i += 1) {
        const { picked } = scheduler.pick([
            { owner: 'A', store: 's1' }, { owner: 'A', store: 's2' }, { owner: 'A', store: 's3' }
        ]);
        stores.push(picked.store);
        scheduler.recordServed(picked.owner, picked.cost);
    }
    assert.equal(new Set(stores.slice(0, 3)).size, 3, `同一账户内部必须轮转，实际 ${stores.join(',')}`);
}

// 六、多店不增权：一个账号认领 3 家店、另一个 1 家，账户级服务量必须相等。
// 这正是生产上 002 账号有 3 家店、003 账号有 1 家店的场景。
{
    const scheduler = createAccountScheduler();
    const counts = { 'u-002': 0, 'u-003': 0 };
    for (let i = 0; i < 300; i += 1) {
        const { picked } = scheduler.pick([
            { owner: 'u-002', id: `s1-${i}` }, { owner: 'u-002', id: `s2-${i}` }, { owner: 'u-002', id: `s3-${i}` },
            { owner: 'u-003', id: `t1-${i}` }
        ]);
        counts[picked.owner] += 1;
        scheduler.recordServed(picked.owner, picked.cost);
    }
    assert.equal(spreadOf(counts), 0, `多店账号不得获得更高权重，实际 ${JSON.stringify(counts)}`);
}

// 七、借用与归还：A 单独运行很久后，B 加入必须立即被服务，
// 且此后必须严格交替——只在总量上平分是不够的，前段连续独占同样是缺陷。
{
    const scheduler = createAccountScheduler();
    runSingleStep(scheduler, ['A'], 200);
    // 记录 B 加入后的逐次序列，检查是否立即纳入并交替。
    const sequence = [];
    for (let i = 0; i < 100; i += 1) {
        const { picked } = scheduler.pick([{ owner: 'A', id: `a${i}` }, { owner: 'B', id: `b${i}` }]);
        sequence.push(picked.owner);
        scheduler.recordServed(picked.owner, picked.cost);
    }
    const counts = { A: 0, B: 0 };
    for (const owner of sequence) counts[owner] += 1;
    assert.equal(spreadOf(counts), 0, `B 加入后必须回到等权，实际 ${JSON.stringify(counts)}`);
    assert.equal(sequence[0], 'B', `B 必须立即被服务，实际首个是 ${sequence[0]}`);
    // 严格交替：任何账户不得连续出现两次。
    for (let i = 1; i < sequence.length; i += 1) {
        assert.notEqual(sequence[i], sequence[i - 1], `B 加入后出现连续独占：${sequence.slice(0, 12).join('')}`);
    }
}

// 七之二、同一批入队顺序不改变公平：A 的请求先提交、B 后提交，
// 也要交替放行而不是让先提交的连续占用（对应准入队列的真实入队顺序）。
{
    const scheduler = createAccountScheduler();
    const sequence = [];
    // 每轮都把 A 放在候选数组前面，模拟"A 先到"；公平性不能因此偏向 A。
    for (let i = 0; i < 60; i += 1) {
        const { picked } = scheduler.pick([{ owner: 'A', id: `a${i}` }, { owner: 'B', id: `b${i}` }]);
        sequence.push(picked.owner);
        scheduler.recordServed(picked.owner, picked.cost);
    }
    for (let i = 1; i < sequence.length; i += 1) {
        assert.notEqual(sequence[i], sequence[i - 1], `先提交不得带来连续独占：${sequence.slice(0, 12).join('')}`);
    }
}

// 八、账号离开再回来不产生欠账：A 与 B 交替，B 离场期间 A 多用，B 回来后仍等权。
{
    const scheduler = createAccountScheduler();
    runSingleStep(scheduler, ['A', 'B'], 20);
    runSingleStep(scheduler, ['A'], 100);
    const counts = runSingleStep(scheduler, ['A', 'B'], 100);
    assert.equal(spreadOf(counts), 0, `离场账户回来后必须等权，实际 ${JSON.stringify(counts)}`);
}

// 九、空转保护与可复现：没有候选立即返回；相同输入得到相同顺序。
{
    const scheduler = createAccountScheduler();
    assert.equal(scheduler.pick([]).picked, null, '没有候选时不得空转');
    assert.deepEqual(scheduler.pickMany([], 5), [], '空候选必须立即返回空');
    const once = createAccountScheduler();
    const twice = createAccountScheduler();
    const a = [], b = [];
    for (let i = 0; i < 8; i += 1) {
        a.push(once.pick([{ owner: 'X' }, { owner: 'Y' }]).picked.owner);
        b.push(twice.pick([{ owner: 'X' }, { owner: 'Y' }]).picked.owner);
    }
    assert.deepEqual(a, b, '相同输入必须得到相同顺序，便于测试与复现');
}

// 十、账户号归一：空 owner 归入同一默认账户，不会被当成多个账户各拿一份权重。
{
    const scheduler = createAccountScheduler();
    const { order } = scheduler.pick([{ owner: '' }, { owner: undefined }, { owner: null }]);
    assert.equal(order.length, 1, '空 owner 必须归入同一个默认账户');
}

// 十一、pickMany 与单步 pick 结果一致：两个入口不能给出不同的公平语义。
{
    const make = (owner, n) => Array.from({ length: n }, (_, i) => ({ owner, id: `${owner}${i}` }));
    // pickMany 的语义是"一次取走并立即使用"，每个取出的项都记一次服务；
    // 因此单步对照也必须在每次选择后记账，否则两者比较的是不同流程。
    const viaMany = createAccountScheduler().pickMany([...make('A', 50), ...make('B', 50)], 20).map(i => i.owner);
    const viaStep = [];
    const stepScheduler = createAccountScheduler();
    for (let i = 0; i < 20; i += 1) {
        const { picked } = stepScheduler.pick([...make('A', 50), ...make('B', 50)].map((it, k) => ({ ...it, id: `${it.id}-${i}` })));
        viaStep.push(picked.owner);
        stepScheduler.recordServed(picked.owner, picked.cost);
    }
    assert.deepEqual(viaMany, viaStep, '两个入口必须给出相同的公平顺序');
}

// 十二、选择不记账、失败不扣份额、成功恰好记一次。
// 复核 P2-1：只在 next()/pick() 里隐式推进虚拟时间，会让"没拿到资源"的账户白吃亏，
// 调用方成功后再记一次就变成双重计数。这一项把三条不变式钉死。
{
    const scheduler = createAccountScheduler();
    // (1) 只选择不记账：反复 pick 但一次都不 recordServed，虚拟时间必须保持 0。
    for (let i = 0; i < 20; i += 1) {
        scheduler.pick([{ owner: 'A', id: `a${i}` }, { owner: 'B', id: `b${i}` }]);
    }
    const afterSelectOnly = scheduler.snapshot();
    for (const entry of afterSelectOnly) {
        assert.equal(entry.served, 0, `只选择不得记账，${entry.owner} 实际 served=${entry.served}`);
        assert.equal(entry.virtualTime, 0, `只选择不得推进虚拟时间，${entry.owner} 实际 ${entry.virtualTime}`);
    }

    // (2) 成功恰好记一次：选一次、记一次。
    const { picked } = scheduler.pick([{ owner: 'A', id: 'a-final' }, { owner: 'B', id: 'b-final' }]);
    scheduler.recordServed(picked.owner, picked.cost);
    const afterOne = scheduler.snapshot().find(entry => entry.owner === picked.owner);
    assert.equal(afterOne.served, 1, `成功一次应记 1 次服务，实际 ${afterOne.served}`);
    assert.equal(afterOne.virtualTime, 1, `成功一次应推进 1 个虚拟单位，实际 ${afterOne.virtualTime}`);

    // (3) 失败不扣份额：被拒绝的申请不调用 recordServed，份额必须原样。
    const before = scheduler.snapshot();
    // 模拟"选中后被资源预算拒绝"：只选择、不记账。
    scheduler.pick([{ owner: 'A', id: 'a-rejected' }, { owner: 'B', id: 'b-rejected' }]);
    const afterReject = scheduler.snapshot();
    for (const entry of afterReject) {
        const previous = before.find(item => item.owner === entry.owner);
        if (!previous) continue;
        assert.equal(entry.virtualTime, previous.virtualTime,
            `申请被拒不得消耗份额，${entry.owner} 从 ${previous.virtualTime} 变成 ${entry.virtualTime}`);
    }
}

console.log(JSON.stringify({
    accountFairness: true,
    drivenBy: 'pick()（业务实际入口）',
    singleStepTwoAccounts700: 'A=350 B=350',
    noConsecutiveMonopoly: '通过',
    threeAccountsEqual: '通过',
    backlogDoesNotChangeWeight: '通过',
    innerRotation: '通过',
    multiStoreNoBoost: '通过',
    borrowReturn: '通过',
    leaveReturnNoDebt: '通过',
    idleSafe: '通过',
    ownerNormalization: '通过',
    pickManyMatchesPick: '通过',
    selectionDoesNotCharge: '通过',
    failureDoesNotConsumeShare: '通过'
}));
