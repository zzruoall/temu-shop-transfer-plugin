/** 以现有短期只读会话验收分类和数据守恒；不注册账号、不投递商品、不输出凭证或商品正文。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';

const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const database = await openMysqlDatabase();
assert.ok(database);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const initialTests = new Set(['admin', '13800000002', '13800000003']);
try {
    const [[schema]] = await database.query('query', 'SELECT data_root FROM hub_schema WHERE id=1');
    const beforeBytes = await readFile(path.join(schema.data_root, 'users.json'));
    const state = JSON.parse(beforeBytes);
    assert.equal(state.users.filter(user => initialTests.has(user.username)).length, 3, '指定三个存量账户必须全部存在');
    for (const user of state.users) assert.equal(user.accountType, initialTests.has(user.username) ? 'test' : (user.accountType || 'production'));
    const [entries] = await database.query('query', "SELECT entry_key,body FROM hub_map_entries WHERE domain='ownership'");
    const assignments = Object.fromEntries(entries.map(row => [row.entry_key, parse(row.body)]));
    assert.ok(assignments['$account-types:v1']);
    const domains = Object.fromEntries(Object.values(assignments).filter(row => row.kind === 'data-domain').map(row => [row.storeId, row.accountType]));
    const [counts] = await database.query('query', 'SELECT store_id,COUNT(*) AS total FROM hub_products GROUP BY store_id');
    const productCounts = { test: 0, production: 0, unclassified: 0 };
    for (const row of counts) { assert.ok(domains[row.store_id], '库存来源必须已有明确分类'); productCounts[domains[row.store_id]] += Number(row.total); }
    if (process.env.TEMU_MIGRATION_BACKUP) {
        const old = JSON.parse(await readFile(path.join(process.env.TEMU_MIGRATION_BACKUP, 'shared/users.json')));
        assert.equal(state.sessionSecret, old.sessionSecret, '分类不得更换会话密钥');
        assert.equal(state.registrationOpen, old.registrationOpen);
        assert.equal(state.users.length, old.users.length, '迁移不得增删账户');
        for (const prior of old.users) {
            const current = state.users.find(user => user.id === prior.id);
            assert.ok(current);
            for (const key of ['id', 'username', 'salt', 'passwordHash', 'role', 'disabled', 'createdAt', 'passwordChangedAt']) {
                assert.equal(current[key], prior[key], `迁移不能更改账户原有字段:${key}`);
            }
            assert.equal(current.accountType, initialTests.has(current.username) ? 'test' : (prior.accountType || 'production'));
        }
        const oldEntries = JSON.parse(await readFile(path.join(process.env.TEMU_MIGRATION_BACKUP, 'ownership-before.json')));
        for (const [id, row] of Object.entries(oldEntries)) assert.deepEqual(assignments[id], row, '迁移不得改写既有认领关系');
    }
    const get = async (url, cookie) => {
        const response = await fetch(base + url, { redirect: 'manual', headers: cookie ? { cookie } : {}, signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200, url);
        return response;
    };
    // 用原会话密钥签名，证明旧登录无需重置；会话只在本进程使用，不写入日志或文件。
    const cookieFor = user => {
        const expiry = String(Date.now() + 120000);
        const signature = createHmac('sha256', state.sessionSecret).update(`${user.id}.${expiry}`).digest('hex');
        return `temu_session=${user.id}.${expiry}.${signature}`;
    };
    let checked = 0;
    for (const user of state.users.filter(user => !user.disabled)) {
        const cookie = cookieFor(user);
        const me = await (await get('/api/me', cookie)).json();
        assert.equal(me.user.accountType, user.accountType); assert.equal(me.isAdmin, user.role === 'admin');
        for (const personal of [false, true]) {
            const result = await (await get('/api/overview?productLimit=100&library=' + (personal ? 'personal' : 'shared'), cookie)).json();
            const stores = new Set(Object.entries(assignments).filter(([, row]) => row.ownerId === user.id).map(([id]) => id));
            const expected = personal ? counts.filter(row => domains[row.store_id] === user.accountType && stores.has(row.store_id)).reduce((n, row) => n + Number(row.total), 0) : productCounts[user.accountType];
            assert.equal(result.productCount, expected, '默认或个人商品库总量必须与数据库的类别范围一致');
            for (const product of result.products) for (const id of product.sourceStoreIds) {
                assert.equal(domains[id], user.accountType); if (personal) assert.ok(stores.has(id));
            }
        }
        const agents = await (await get('/api/agents', cookie)).json();
        for (const agent of agents.agents) assert.equal(assignments[agent.storeId]?.ownerId, user.id, '共享商品不能开放他人的发送目标');
        if (user.role === 'admin') {
            for (const type of ['production', 'test', 'unclassified']) {
                const result = await (await get('/api/overview?accountType=' + type, cookie)).json();
                assert.equal(result.productCount, productCounts[type]);
            }
            const page = await get('/admin', cookie); assert.match(await page.text(), /admin-account-type/);
        } else {
            const forged = await (await get('/api/overview?accountType=' + (user.accountType === 'test' ? 'production' : 'test'), cookie)).json();
            assert.equal(forged.productCount, productCounts[user.accountType], '普通账户不能伪造分类');
        }
        checked++;
    }
    assert.ok(checked >= 3);
    const app = await get('/app.js');
    const text = await app.text();
    assert.match(text, /个人商品库/); assert.doesNotMatch(text, /product-view-mode|catalog-upload-button|catalog-files|function uploadFiles\(/);
    // 管理员 HTML 入口会执行登录跳转，不把受保护页面当作匿名静态资源校验。
    for (const name of ['app.js', 'styles.css', 'admin.js', 'admin.css']) {
        const response = await get('/' + name); assert.match(response.headers.get('cache-control'), /no-store/);
        assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/' + name, import.meta.url))));
    }
    assert.equal(hash(await readFile(path.join(schema.data_root, 'users.json'))), hash(beforeBytes), '冒烟不得改写账户');
    console.log(JSON.stringify({ librarySmoke: true, accountsChecked: checked, testAccounts: 3, productCounts,
        ownTargetsOnly: true, removedControls: true, assetsMatched: true, productionWrites: 0, realPlatformCalls: 0 }));
} finally { await database.close(); }
