/** 分发器纯内存回归：只替换 SQL 边界，不加载驱动、不连接数据库、不写测试报告文件。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAccountDispatcher, listAccountCandidates, discoverReadyAccounts } from '../lib/account-dispatcher.mjs';

const at = '2026-09-28T00:00:00.000Z';
/** 构造完整调度证据；反例通过覆盖字段表达缺证据、未到期或占槽。 */
function work(account, store = 's00', direction = 'ingest', overrides = {}) {
    return { account_id: account, store_id: store, direction, work_id: `${account}:${store}:${direction}`,
        status: 'queued', created_at: at, next_run_at: '', run_id: 'run', execution_run_id: 'run',
        actor_id: 'actor', ownership_generation: 'generation', ...overrides };
}

/**
 * SQL 边界替身只实现分发器的只读查询合同，未知查询直接失败。
 * 调度器、分发器及游标仍运行真实代码；SQL 语法另由隔离 MySQL 验收覆盖。
 */
function memoryDatabase(rows, runtimes = new Map()) {
    const calls = [];
    return { calls, async query(lane, sql, params = []) {
        assert.equal(lane, 'maintenance');
        assert.match(sql.trim(), /^SELECT/i);
        calls.push({ sql, params });
        const strict = sql.includes("actor_id<>''");
        const eligible = rows.filter(row => (!row.next_run_at || row.next_run_at <= at)
            && (!strict || (row.run_id && row.execution_run_id === row.run_id && row.actor_id && row.ownership_generation)));
        const fresh = eligible.filter(row => row.status === 'queued' && (!sql.includes('NOT EXISTS')
            || !runtimes.get(row.account_id)?.current_work_id || runtimes.get(row.account_id)?.state === 'idle'));
        const resumes = eligible.filter(row => row.status === 'waiting'
            && runtimes.get(row.account_id)?.state === 'waiting'
            && runtimes.get(row.account_id)?.current_work_id === row.work_id);
        if (sql.includes('UNION')) {
            assert.match(sql, /ORDER BY account_id LIMIT \?/);
            const after = params.at(-2), limit = params.at(-1);
            return [[...new Set([...fresh, ...resumes].map(row => row.account_id))]
                .sort().filter(id => id > after).slice(0, limit).map(account_id => ({ account_id }))];
        }
        if (sql.includes('MIN(created_at) AS first_at')) {
            return [[...new Set(fresh.map(row => row.account_id))].sort().slice(0, params.at(-1)).map(account_id => ({ account_id }))];
        }
        if (sql.includes('SELECT DISTINCT w.account_id')) {
            return [[...new Set(resumes.map(row => row.account_id))].sort().slice(0, params.at(-1)).map(account_id => ({ account_id }))];
        }
        if (sql.includes('w.account_id IN')) {
            return [resumes.filter(row => params.slice(0, -1).includes(row.account_id))];
        }
        assert.ok(sql.includes('account_id=?'), '未知的候选 SQL');
        let selected = fresh.filter(row => row.account_id === params[0]);
        if (sql.includes('direction=?')) selected = selected.filter(row => row.direction === params[2]);
        selected.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.work_id.localeCompare(b.work_id));
        if (sql.includes('ROW_NUMBER()')) {
            assert.match(sql, /PARTITION BY store_id,\s*direction ORDER BY created_at,\s*work_id/);
            assert.match(sql, /bucket_rank=1/);
            const heads = new Map();
            for (const row of selected) {
                const key = `${row.store_id}\0${row.direction}`;
                if (!heads.has(key)) heads.set(key, row);
            }
            const [store, repeatedStore, direction] = params.slice(-4, -1);
            assert.equal(store, repeatedStore);
            const follows = row => row.store_id > store || (row.store_id === store && row.direction > direction);
            selected = [...heads.values()].sort((a, b) => Number(follows(b)) - Number(follows(a))
                || a.store_id.localeCompare(b.store_id) || a.direction.localeCompare(b.direction));
        }
        return [selected.slice(0, params.at(-1))];
    } };
}

test('账户发现越过固定前200，并在末页回绕发现新增前缀账户', async () => {
    const rows = Array.from({ length: 405 }, (_, i) => work(`a${String(i).padStart(3, '0')}`));
    const database = memoryDatabase(rows);
    const dispatcher = createAccountDispatcher({ database });
    await dispatcher.refreshAccounts();
    assert.equal(dispatcher.knownAccounts().length, 200);
    await dispatcher.refreshAccounts();
    assert.equal(dispatcher.knownAccounts().length, 400);
    await dispatcher.refreshAccounts();
    assert.equal(dispatcher.knownAccounts().length, 405);
    rows.push(work('000-new'));
    await dispatcher.refreshAccounts();
    assert.ok(dispatcher.knownAccounts().includes('000-new'));
});

test('fresh与resume共用有界账户页，续片超过200也不固定在首屏', async () => {
    const rows = Array.from({ length: 410 }, (_, i) => work(`r${String(i).padStart(3, '0')}`, 's', 'publish', { status: 'waiting' }));
    const runtimes = new Map(rows.map(row => [row.account_id, { current_work_id: row.work_id, state: 'waiting' }]));
    rows.push(work('fresh'));
    const database = memoryDatabase(rows, runtimes);
    const dispatcher = createAccountDispatcher({ database });
    for (let i = 0; i < 3; i++) await dispatcher.refreshAccounts();
    assert.equal(dispatcher.knownAccounts().length, 411);
    assert.ok(database.calls.every(call => call.params.at(-1) === 200));
});

test('删除游标所在账户、整页边界及空尾页均能回绕', async () => {
    const rows = Array.from({ length: 200 }, (_, i) => work(`a${String(i).padStart(3, '0')}`));
    const dispatcher = createAccountDispatcher({ database: memoryDatabase(rows) });
    await dispatcher.refreshAccounts();
    rows.splice(199, 1);
    rows.unshift(work('000-new'));
    await dispatcher.refreshAccounts();
    assert.ok(dispatcher.knownAccounts().includes('000-new'));
});

test('同桶积压500件不会遮住第二店及另一方向，桶内仍取最早工作', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => work('a', 's00', 'ingest', { work_id: `w${String(i).padStart(3, '0')}` }));
    rows.push(work('a', 's00', 'publish'), work('a', 's99', 'ingest'));
    const candidates = await listAccountCandidates({ database: memoryDatabase(rows), accountIds: ['a'], perAccountLimit: 20, now: at });
    assert.equal(candidates.length, 3);
    assert.equal(candidates.find(row => row.storeId === 's00' && row.direction === 'ingest').workId, 'w000');
    assert.ok(candidates.some(row => row.storeId === 's99'));
});

test('超过20个桶依次得到选择，不靠消耗首屏工作才推进', async () => {
    const rows = Array.from({ length: 45 }, (_, i) => work('a', `s${String(i).padStart(2, '0')}`));
    const dispatcher = createAccountDispatcher({ database: memoryDatabase(rows), perAccountLimit: 20 });
    dispatcher.registerAccounts(['a']);
    const picked = [];
    for (let i = 0; i < 46; i++) {
        const { candidate } = await dispatcher.next();
        picked.push(candidate.storeId);
        dispatcher.recordServed(candidate.owner);
    }
    assert.equal(new Set(picked.slice(0, 45)).size, 45);
    assert.equal(picked[45], picked[0]);
});

test('两桶不会被双游标抵消；未获选账户的桶游标不提前消耗', async () => {
    const rows = ['a', 'b'].flatMap(id => [work(id, 's00'), work(id, 's01')]);
    const dispatcher = createAccountDispatcher({ database: memoryDatabase(rows), perAccountLimit: 1 });
    dispatcher.registerAccounts(['a', 'b']);
    const sequences = { a: [], b: [] };
    for (let i = 0; i < 8; i++) {
        const { candidate } = await dispatcher.next();
        sequences[candidate.owner].push(candidate.storeId);
        dispatcher.recordServed(candidate.owner);
    }
    assert.deepEqual(sequences, { a: ['s00', 's01', 's00', 's01'], b: ['s00', 's01', 's00', 's01'] });
});

test('方向过滤及busy/context过滤覆盖发现和候选，合法续片仍可选', async () => {
    const waiting = work('waiting', 's', 'publish', { status: 'waiting' });
    const rows = [work('busy'), work('bad', 's', 'ingest', { actor_id: '' }),
        work('future', 's', 'ingest', { next_run_at: '2099-01-01' }),
        work('good'), work('good', 's01', 'publish'), waiting];
    const runtimes = new Map([['busy', { state: 'unknown', current_work_id: 'old' }],
        ['waiting', { state: 'waiting', current_work_id: waiting.work_id }]]);
    const database = memoryDatabase(rows, runtimes);
    assert.deepEqual((await discoverReadyAccounts({ database, requireExecutionContext: true, now: at })).sort(), ['good', 'waiting']);
    const candidates = await listAccountCandidates({ database, accountIds: ['busy', 'bad', 'future', 'good'],
        direction: 'publish', requireExecutionContext: true, now: at });
    assert.deepEqual(candidates.map(row => row.workId), ['good:s01:publish']);
    const dispatcher = createAccountDispatcher({ database, requireExecutionContext: true, now: () => at });
    dispatcher.registerAccounts(['waiting']);
    assert.equal((await dispatcher.next()).candidate.kind, 'resume');
});

test('失败尝试不记公平服务量，重置同时清除桶游标', async () => {
    const dispatcher = createAccountDispatcher({ database: memoryDatabase([work('a'), work('a', 's01')]) });
    dispatcher.registerAccounts(['a']);
    const first = (await dispatcher.next()).candidate;
    const second = (await dispatcher.next()).candidate;
    assert.notEqual(first.storeId, second.storeId);
    assert.equal(dispatcher.snapshot()[0].served, 0);
    dispatcher.reset();
    assert.equal((await dispatcher.next()).candidate.storeId, first.storeId);
});

test('并发刷新共用一页，后续刷新接着下一页而不是回写旧游标', async () => {
    const rows = Array.from({ length: 405 }, (_, i) => work(`a${String(i).padStart(3, '0')}`));
    const backing = memoryDatabase(rows);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let calls = 0;
    // 屏障只暂停首次查询，确保两个刷新真实重叠，不依赖机器速度或定时等待。
    const database = { async query(...args) {
        calls++;
        if (calls === 1) await gate;
        return backing.query(...args);
    } };
    const dispatcher = createAccountDispatcher({ database });
    const first = dispatcher.refreshAccounts();
    const second = dispatcher.refreshAccounts();
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await first, await second);
    await dispatcher.refreshAccounts();
    assert.equal(dispatcher.knownAccounts().length, 400);
});

test('发现查询失败保留页边界，下次重试不漏掉尚未登记的账户', async () => {
    const rows = Array.from({ length: 405 }, (_, i) => work(`a${String(i).padStart(3, '0')}`));
    const backing = memoryDatabase(rows);
    let calls = 0;
    // 仅第二页第一次读取故障，验证失败清理不会清空或提前推进发现游标。
    const database = { async query(...args) {
        if (++calls === 2) throw new Error('query unavailable');
        return backing.query(...args);
    } };
    const dispatcher = createAccountDispatcher({ database });
    await dispatcher.refreshAccounts();
    await assert.rejects(dispatcher.refreshAccounts(), /query unavailable/);
    assert.equal(dispatcher.knownAccounts().length, 200);
    await dispatcher.refreshAccounts();
    assert.equal(dispatcher.knownAccounts().length, 400);
    await dispatcher.refreshAccounts();
    assert.equal(dispatcher.knownAccounts().length, 405);
});
