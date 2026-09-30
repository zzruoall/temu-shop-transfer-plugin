/**
 * 入库准入的账户公平验证：按账户轮转放行，且字节预算仍被硬约束。
 * 纯内存、无网络、不写库；不操作真实店铺或商品。
 */
import assert from 'node:assert/strict';
import { createIngestAdmission } from '../lib/ingest-admission.mjs';

/** 占满 limit 后不再自动放行，便于观察排队顺序。 */
function acquireAll(admission, requests) {
    return requests.map(request => admission.acquire(request.bytes, null, request.owner));
}

// 一、账户公平：先提交的账户不得连续占满名额，后加入的账户要被纳入轮转。
{
    // limit=1：一次只放行一个，观察谁被选中。
    const admission = createIngestAdmission({ limit: 1, maxBytes: 1024 });
    // A 先排 5 个，B 后到排队 5 个。
    const releases = [];
    const order = [];
    const pending = [];
    for (let i = 0; i < 5; i += 1) pending.push(admission.acquire(10, null, 'A').then(r => { order.push('A'); releases.push(r); }));
    for (let i = 0; i < 5; i += 1) pending.push(admission.acquire(10, null, 'B').then(r => { order.push('B'); releases.push(r); }));
    // 放行若干次，观察交替情况。
    for (let step = 0; step < 6; step += 1) {
        await new Promise(resolve => setImmediate(resolve));
        if (releases.length) releases.shift()();
    }
    await new Promise(resolve => setImmediate(resolve));
    // 前几次放行必须出现 B，而不是 A 全部先走完。
    const head = order.slice(0, 4);
    assert.ok(head.includes('B'), `B 必须在早期就被放行，实际顺序 ${head.join('')}`);
    // 交替程度：任何账户不得连续被放行超过一次（limit=1 的轮转语义）。
    for (let i = 1; i < order.length; i += 1) {
        if (order[i] === order[i - 1]) {
            // 允许最后一次清空剩余，但前段不得连续。
            assert.ok(i >= order.length - 1, `前段出现连续同一账户：${order.join('')}`);
        }
    }
    // 全部释放，避免悬挂定时器。
    while (releases.length) releases.shift()();
    await Promise.allSettled(pending);
}

// 二、字节预算仍是硬约束：预算内挑不到就不放行，不因公平而超发。
{
    const admission = createIngestAdmission({ limit: 4, maxBytes: 100 });
    const first = await admission.acquire(80, null, 'A');
    // 剩余预算 20：请求 50 应排队而不是放行。
    let secondGranted = false;
    const second = admission.acquire(50, null, 'B').then(release => { secondGranted = true; return release; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondGranted, false, '超出剩余预算的请求不得被放行');
    assert.equal(admission.snapshot().active, 1, '在途数应保持 1');
    first();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondGranted, true, '预算释放后排队请求应被放行');
    const release = await second; release();
}

// 三、大包不堵小包：预算放不下的大包不得把它后面的小包一起挡住。
// 接收额度自本轮起按**包的实际大小**记账（不再乘解析系数），所以这里取"确实放不下"的组合：
// 先占 250，大包需 200（250+200=450 > 300 放不下），小包需 20（250+20=270 ≤ 300 放得下）。
{
    const admission = createIngestAdmission({ limit: 4, maxBytes: 300, largePacketBytes: 200 });
    const held = await admission.acquire(250, null, 'A');
    let bigGranted = false, smallGranted = false;
    const big = admission.acquire(200, null, 'B').then(r => { bigGranted = true; return r; });   // 放不下
    const small = admission.acquire(20, null, 'C').then(r => { smallGranted = true; return r; }); // 放得下
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bigGranted, false, '预算不足时大包不得放行');
    assert.equal(smallGranted, true, '小包不得被前面放不下的大包挡住');
    const smallRelease = await small; smallRelease();
    held();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bigGranted, true, '预算充足后大包应被放行');
    const bigRelease = await big; bigRelease();
}

// 三之二、协议允许的大包必须真的能进来：此前 size×3 让超过 8MiB/3≈2.67MiB 的包
// 永远满足不了自己账户的 8MiB 配额，是**死条件**（连 3MiB 都进不来，尽管协议允许 64MiB）。
{
    const MiB = 1024 * 1024;
    const admission = createIngestAdmission({ limit: 2, maxBytes: 64 * MiB, largePacketBytes: 8 * MiB,
        perAccountBytes: 8 * MiB, parserSlots: 1 });
    const sizes = [2, 2.7, 3, 5, 8];
    const accepted = [], rejected = [];
    for (const mb of sizes) {
        const size = Math.round(mb * MiB);
        try {
            const release = await admission.acquire(size, null, `acct-${mb}`);
            accepted.push(mb); release();
        } catch (error) { rejected.push({ mb, reason: error.message }); }
    }
    assert.deepEqual(rejected, [], `协议允许的包不得被账户配额永久拒绝，实际拒绝 ${JSON.stringify(rejected)}`);
    assert.deepEqual(accepted, sizes, `2/2.7/3/5/8MiB 都应被接受，实际 ${JSON.stringify(accepted)}`);

    // 解析工作集名额仍生效：占满 parserSlots 后大包排队等待，小包照常放行。
    const gate = createIngestAdmission({ limit: 4, maxBytes: 64 * MiB, largePacketBytes: 8 * MiB,
        perAccountBytes: 64 * MiB, parserSlots: 1 });
    const bigHeld = await gate.acquire(9 * MiB, null, 'big-1');
    let secondBig = false, smallWhileBig = false;
    const pendingBig = gate.acquire(10 * MiB, null, 'big-2').then(r => { secondBig = true; return r; });
    const pendingSmall = gate.acquire(1 * MiB, null, 'small-1').then(r => { smallWhileBig = true; return r; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondBig, false, '解析位已满时第二个大包必须排队');
    assert.equal(smallWhileBig, true, '解析位被占用时小包仍应放行');
    const smallRelease = await pendingSmall; smallRelease();
    bigHeld();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(secondBig, true, '解析位释放后大包应被放行');
    const bigRelease = await pendingBig; bigRelease();
}

// 四、取消与超时仍生效：等待中的请求被中止后不得再放行。
{
    const admission = createIngestAdmission({ limit: 1, maxBytes: 1000, waitMs: 50 });
    const held = await admission.acquire(10, null, 'A');
    const controller = new AbortController();
    const waiting = admission.acquire(10, controller.signal, 'B');
    controller.abort();
    await assert.rejects(waiting, /upload_aborted/);
    held();
    assert.equal(admission.snapshot().pending, 0, '被中止的请求必须移出队列');
}

// 五、调度身份必须是"店铺认领账号"，而不是插件实例：
// 同一账号多开插件、或一个账号认领多家店，都不能因此获得更多份额。
// 这里直接核对协议层把哪个标识交给了准入队列。
{
    const seen = [];
    const admission = {
        acquire: async (bytes, signal, owner) => { seen.push(owner); return () => {}; },
        snapshot: () => ({ active: 0, pending: 0, bytes: 0 })
    };
    // 用最小的内存数据库桩：协议层需要记录请求状态。
    const rows = new Map();
    const database = {
        transaction: async (_lane, fn) => fn({ query: async (sql, params) => {
            if (/SELECT id FROM hub_ingest_requests/.test(sql)) return [[]];
            if (/SELECT COUNT/.test(sql)) return [[{ n: 0, owned: 0 }]];
            if (/INSERT INTO hub_ingest_requests/.test(sql)) { rows.set(params[0], { id: params[0], owner_id: params[1], request_hash: params[2], status: 'prepared', receipt: null }); return [{}]; }
            if (/SELECT \* FROM hub_ingest_requests/.test(sql)) return [[rows.get(params[0])]];
            return [[]];
        } }),
        query: async (_lane, sql, params) => {
            if (/SELECT \* FROM hub_ingest_requests/.test(sql)) return [[rows.get(params[0])]];
            return [[]];
        }
    };
    // 店铺 → 账号映射：两个插件实例属于同一账号，第三个实例属于另一账号。
    const accountByStore = {
        'temu:11111111': 'u-same', 'temu:22222222': 'u-same', 'temu:33333333': 'u-other'
    };
    const { createIngestProtocol } = await import('../lib/ingest-protocol.mjs');
    const protocol = createIngestProtocol({ database, admission, resolveAccount: async storeId => accountByStore[storeId] || '' });

    const request = (owner, storeId, id) => protocol.prepare(owner, {
        storeId, requestId: id, sha256: 'a'.repeat(64), bytes: 1024
    });
    // 同一账号的两个不同插件实例上传：调度标识必须收敛为同一个账号。
    await request('plugin-instance-1', 'temu:11111111', 'req-11111111-aaaa');
    await request('plugin-instance-2', 'temu:22222222', 'req-22222222-bbbb');
    // 另一账号的实例上传。
    await request('plugin-instance-3', 'temu:33333333', 'req-33333333-cccc');

    assert.deepEqual(seen.slice(0, 3), ['u-same', 'u-same', 'u-other'],
        `调度标识必须按认领账号归一，实际 ${JSON.stringify(seen)}`);
    assert.ok(!seen.includes('plugin-instance-1'), '不得把插件实例号当作调度身份');

    // 店铺尚未认领时退回实例标识：未认领店铺仍要能被调度，不能被拒收。
    await request('plugin-instance-4', 'temu:44444444', 'req-44444444-dddd');
    assert.equal(seen[3], 'plugin-instance-4', '未认领店铺应退回实例标识而不是被拒收');
}

console.log(JSON.stringify({
  ingestAccountFairness: true,
  fairRotation: '通过',
  byteBudgetEnforced: '通过',
  largePacketNoBlocking: '通过',
  abortStillWorks: '通过',
  schedulingIdentityIsAccount: '通过',
  unclaimedFallsBackToInstance: '通过',
  realWrites: 0
}));
