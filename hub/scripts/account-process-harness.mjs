/**
 * 账户专属进程的隔离测试基座。
 *
 * 提供三样东西，供本方案的各验证脚本复用：
 * 1. 可追踪的事件轨迹（accountId/storeId/workId/pid/epoch/stage），日志不含商品正文与令牌；
 * 2. 多账户夹具：4 账户 × 每账户 3 店 × 每店 10 商品，以及可注入故障的模拟平台；
 * 3. 隔离 MySQL 连接（仅 33917），运行前打印库名，拒绝生产库。
 *
 * 这里只搭基座，不含业务实现；调用方按场景注入 mock 行为。
 */
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';

/** 隔离 MySQL 端口；生产库不允许出现在任何测试里。 */
export const ISOLATED_MYSQL_PORT = 33917;

/** 打开隔离库并保证不是生产库：库名必须带测试前缀，端口必须是隔离端口。 */
export async function openIsolatedDatabase({ prefix = 'temu_accproc', label = '' } = {}) {
    const admin = await mysql.createConnection({ host: '127.0.0.1', port: ISOLATED_MYSQL_PORT, user: 'root' });
    const name = `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e4)}`;
    assert.ok(name.startsWith('temu_'), `测试库名必须以 temu_ 开头，实际 ${name}`);
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    // 运行前打印库名，便于人工确认不是生产库。
    console.log(`[isolated-db] ${label || prefix} → 127.0.0.1:${ISOLATED_MYSQL_PORT}/${name}`);
    return {
        admin, name,
        async drop() { await admin.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {}); await admin.end().catch(() => {}); }
    };
}

/**
 * 事件轨迹：记录调度与执行的每一步，供断言"进程数量、账户唯一执行、提交次数、公平顺序"。
 * 只记录标识和阶段，不记录商品正文、令牌或密码。
 */
export function createTrace({ max = 20000 } = {}) {
    const events = [];
    const push = (type, fields = {}) => {
        if (events.length >= max) return;
        events.push({ seq: events.length + 1, at: Date.now(), type, ...fields });
    };
    return {
        push,
        /** 进程生命周期：fork/exit 用于统计真实并发子进程数。 */
        process: (action, fields) => push(`process:${action}`, fields),
        /** 账户业务阶段：一个商品从选中到终态的过程。 */
        work: (stage, fields) => push(`work:${stage}`, fields),
        /** 平台请求：统计重复创建的唯一依据。 */
        platform: (action, fields) => push(`platform:${action}`, fields),
        events,
        /** 某时刻同时存在的子进程数上限（按 fork/exit 配对计算）。 */
        maxChildrenObserved() {
            let live = 0, peak = 0;
            for (const event of events) {
                if (event.type === 'process:fork') { live++; peak = Math.max(peak, live); }
                else if (event.type === 'process:exit') live = Math.max(0, live - 1);
            }
            return peak;
        },
        /**
         * 同一账户同时处于业务执行中的商品数上限。
         * 关键：unknown 表示"这件还没结束"——它仍占账户业务槽，
         * 因此只有明确终态（done/failed/cancelled）才减少占用；
         * 把任何 settle 都当结束会漏掉"unknown 后又启动第二件"的违规。
         */
        maxAccountActiveObserved() {
            const active = new Map();
            let peak = 0;
            const terminal = new Set(['done', 'failed', 'cancelled']);
            for (const event of events) {
                if (event.type === 'work:start') active.set(event.accountId, (active.get(event.accountId) || 0) + 1);
                else if (event.type === 'work:settle' && terminal.has(event.state)) {
                    active.set(event.accountId, Math.max(0, (active.get(event.accountId) || 0) - 1));
                }
                peak = Math.max(peak, active.get(event.accountId) || 0);
            }
            return peak;
        },
        /** 场景是否真的执行过：空轨迹不构成执行证据。 */
        hasExecutionEvidence() {
            return events.some(e => e.type === 'work:start') && events.some(e => ['work:settle', 'platform:create'].includes(e.type));
        },
        /** 真实进程证据：fork 事件必须携带实际 pid，且数量与 exit 配对。 */
        hasRealProcessEvidence() {
            const forked = events.filter(e => e.type === 'process:fork');
            return forked.length > 0 && forked.every(e => Number.isInteger(e.pid) && e.pid > 0);
        },
        /** 平台创建请求的去重键出现次数；>1 说明可能重复创建。 */
        duplicatePlatformCreates() {
            const seen = new Map();
            for (const event of events) {
                if (event.type !== 'platform:create') continue;
                const key = event.idempotencyKey || `${event.accountId}/${event.storeId}/${event.spuId}`;
                seen.set(key, (seen.get(key) || 0) + 1);
            }
            return [...seen.values()].filter(n => n > 1).length;
        },
        /** 跨账户写入：事件里的 ownerAccount 与操作者账户不一致的次数。 */
        crossAccountWrites() {
            return events.filter(e => e.type.startsWith('work:') && e.ownerAccount && e.accountId && e.ownerAccount !== e.accountId).length;
        },
        /** 旧轮启动次数：runId 不在该账户当前有效轮次集合内的启动。 */
        oldRunStarts(validRunsByAccount = new Map()) {
            return events.filter(e => {
                const type = e.type;
                if (type !== 'work:start' && type !== 'platform:create') return false;
                const valid = validRunsByAccount.get(e.accountId);
                if (!valid) return false;
                return e.runId && !valid.has(e.runId);
            }).length;
        },
        /** 某账户被服务的顺序，用于校验公平轮换。 */
        serviceOrder() {
            return events.filter(e => e.type === 'work:start').map(e => e.accountId);
        },
        reset() { events.length = 0; }
    };
}

/** 4 账户 × 每账户 3 店 × 每店 10 商品的夹具；店铺 ID 与商城 ID 同源，避免身份校验失败。 */
export function createAccountFixture({ accounts = 4, storesPerAccount = 3, productsPerStore = 10 } = {}) {
    const accountsList = [];
    for (let a = 0; a < accounts; a += 1) {
        const accountId = `acct-${String(a + 1).padStart(2, '0')}`;
        const stores = [];
        for (let s = 0; s < storesPerAccount; s += 1) {
            // 商城 ID 用合成值，夹具万一联网也不落到真实店铺。
            const mallId = String(990000000000 + a * 100 + s);
            const storeId = `temu:${mallId}`;
            const products = Array.from({ length: productsPerStore }, (_, n) => ({
                spuId: String(8800000000 + a * 1000 + s * 100 + n),
                ready: true,
                title: `${accountId}-店${s}-商品${n}`,
                images: ['https://invalid.test/a.jpg'],
                skuIds: [String(n + 1)],
                skcIds: [String(n + 1)],
                publicationData: { sourceProduct: { productId: String(8800000000 + a * 1000 + s * 100 + n) } }
            }));
            stores.push({ storeId, mallId, accountId, storeName: `${accountId}-店${s}`, pageStoreName: `${accountId}-店${s}`, products });
        }
        accountsList.push({ accountId, stores });
    }
    return {
        accounts: accountsList,
        accountsById: new Map(accountsList.map(a => [a.accountId, a])),
        /** 认领关系：storeId → accountId，供 accountResolver 注入。 */
        assignments() {
            return Object.fromEntries(accountsList.flatMap(account =>
                account.stores.map(store => [store.storeId, { ownerId: account.accountId, storeName: store.storeName }])));
        },
        /** 店铺 → 账户，等价于 ownership.ownedStoreIds 的输入。 */
        ownedStoreIds(accountId) {
            const account = accountsList.find(a => a.accountId === accountId);
            return new Set(account ? account.stores.map(s => s.storeId) : []);
        },
        allStores() { return accountsList.flatMap(a => a.stores); },
        allProducts() { return accountsList.flatMap(a => a.stores.flatMap(s => s.products)); },
        /** 插件身份：与 server.mjs 里的身份字段保持同源。 */
        agentFor(store, instanceSuffix = '1') {
            return {
                storeId: store.storeId, mallId: store.mallId, executionMode: 'plugin-api',
                storeName: store.storeName, pageStoreName: store.pageStoreName,
                pluginInstanceId: `inst-${store.mallId}-${instanceSuffix}`,
                pluginVersion: '10.10.65', schedulingProtocol: 1, executionRunProtocol: 1,
                pluginDetected: true, identityMatched: true
            };
        }
    };
}

/**
 * 可注入故障的模拟平台。返回的 recorder 记录每次调用，
 * duplicateCreates() 用于断言"同一次提交没有重复创建"。
 */
export function createMockPlatform(trace = null) {
    const calls = [];
    const behavior = { create: 'success', delayMs: 0, disconnectAfterCreate: false };
    return {
        behavior,
        calls,
        /** 模拟一次平台新增：按 behavior 返回成功/延迟/断网/结果未知。 */
        async create({ accountId, storeId, spuId, idempotencyKey, runId }) {
            calls.push({ accountId, storeId, spuId, idempotencyKey, runId, at: Date.now() });
            trace?.platform('create', { accountId, storeId, spuId, idempotencyKey, runId });
            if (behavior.delayMs) await new Promise(resolve => setTimeout(resolve, behavior.delayMs));
            if (behavior.disconnectAfterCreate) return { outcome: 'unknown', reason: '响应丢失' };
            if (behavior.create === 'reject') return { outcome: 'rejected', reason: '平台拒绝内容' };
            return { outcome: 'created', productId: `P-${spuId}` };
        },
        /** 同一次业务提交（同 idempotencyKey）的调用次数。 */
        countByIdempotencyKey(idempotencyKey) {
            return calls.filter(call => call.idempotencyKey === idempotencyKey).length;
        }
    };
}

/**
 * 断言聚合报告的核心红线。
 *
 * 上限断言只能证明"没有超过"，空轨迹同样满足上限，因此必须**先要求场景真的执行过**：
 * 报告需带 executionEvidence=true（由 trace.hasExecutionEvidence() 得出），
 * 否则一律判失败——不能用"什么都没发生"冒充"没违规"。
 */
export function assertReportRedlines(report) {
    assert.equal(report.executionEvidence, true,
        '报告缺少真实执行证据（空轨迹或未执行），不能以"没有超过上限"作为通过依据');
    assert.ok(report.maxChildrenObserved <= (report.maxChildrenAllowed ?? 2),
        `子进程数超限：${report.maxChildrenObserved} > ${report.maxChildrenAllowed ?? 2}`);
    assert.ok(report.maxAccountActiveObserved <= 1,
        `单账户同时执行超过 1 件：${report.maxAccountActiveObserved}`);
    assert.equal(report.duplicatePlatformCreates, 0, `存在重复平台创建：${report.duplicatePlatformCreates}`);
    assert.equal(report.crossAccountWrites, 0, `存在跨账户写入：${report.crossAccountWrites}`);
    assert.equal(report.oldRunStarts, 0, `存在旧轮启动：${report.oldRunStarts}`);
}

/** 临时工作目录，供需要落盘的场景使用。 */
export async function scratchDir(prefix = 'temu-accproc-') {
    return await mkdtemp(path.join(tmpdir(), prefix));
}
