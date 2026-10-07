/** 只读验收管理员入口；临时会话仅在内存中签名，不改账号、不尝试真实口令、不读出管理数据。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';

const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/temu$/);
const database = await openMysqlDatabase();
assert.ok(database);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const request = (suffix, cookie = '') => fetch(base + suffix, {
    headers: cookie ? { cookie } : {}, redirect: 'manual', signal: AbortSignal.timeout(15000)
});

try {
    const [[schema]] = await database.query('query', 'SELECT data_root FROM hub_schema WHERE id=1');
    const usersFile = path.join(schema.data_root, 'users.json');
    const before = await readFile(usersFile);
    const state = JSON.parse(before);
    assert.ok(state.sessionSecret && Array.isArray(state.users), '必须使用已初始化账号文件，禁止检查时创建或迁移');
    const ordinary = state.users.find(user => user.role === 'user' && !user.disabled);
    assert.ok(ordinary, '需要现有普通账号才能验证旧会话入口');
    // 签名仅用于短时只读请求，不落盘、不输出会话或账号标识，也不创建新的用户。
    const expiry = String(Date.now() + 60000);
    const mac = createHmac('sha256', state.sessionSecret).update(`${ordinary.id}.${expiry}`).digest('hex');
    const cookie = `temu_session=${ordinary.id}.${expiry}.${mac}`;
    const me = await request('/api/me', cookie);
    assert.equal(me.status, 200);
    assert.equal((await me.json()).isAdmin, false);
    for (const session of ['', cookie]) {
        for (const alias of ['/admin', '/admin/', '/admin.html']) {
            const response = await request(alias, session);
            assert.equal(response.status, 303);
            assert.equal(response.headers.get('location'), alias === '/admin' ? '/temu/admin/login' : '/temu/admin');
            assert.equal(response.headers.get('set-cookie'), null, '打开入口不能清除普通账号会话');
        }
        const response = await request('/admin/login', session);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('cache-control'), /no-store/);
        const body = await response.text();
        assert.ok(body.includes('管理员登录') && body.includes('action="/temu/admin/session"'));
        assert.ok(!body.includes('无权访问管理控制台') && !body.includes('admin-store-list'));
        const denied = await request('/api/admin/users', session);
        assert.equal(denied.status, session ? 403 : 401);
    }
    const asset = await request('/admin.js');
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('cache-control'), /no-store/);
    assert.equal(hash(Buffer.from(await asset.arrayBuffer())), hash(await readFile(new URL('../public/admin.js', import.meta.url))));
    assert.equal(hash(await readFile(usersFile)), hash(before), '只读验收不得改写账号或会话密钥');
    console.log(JSON.stringify({ adminLoginSmoke: true, ordinarySessionRedirect: true, loginFormVisible: true,
        adminApiDenied: true, aliasesValidated: true, accountFileUnchanged: true, assetDigestMatched: true,
        productionWrites: 0, realPlatformCalls: 0 }));
} finally { await database.close(); }
