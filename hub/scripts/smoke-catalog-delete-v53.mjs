/** 发布后只读核对每个账户的删除入口权限；绝不调用线上删除接口或更改认领。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const database = await openMysqlDatabase(); assert.ok(database);
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
try {
    const [[schema]] = await database.query('query', 'SELECT data_root FROM hub_schema WHERE id=1');
    const state = JSON.parse(await readFile(path.join(schema.data_root, 'users.json')));
    const [entries] = await database.query('query', "SELECT entry_key,body FROM hub_map_entries WHERE domain='ownership'");
    const assignments = Object.fromEntries(entries.map(row => [row.entry_key, parse(row.body)]));
    let checked = 0, own = 0, others = 0;
    for (const user of state.users.filter(user => !user.disabled)) {
        const expiry = String(Date.now() + 120000);
        const signature = createHmac('sha256', state.sessionSecret).update(`${user.id}.${expiry}`).digest('hex');
        const cookie = `temu_session=${user.id}.${expiry}.${signature}`;
        const get = async url => {
            const response = await fetch(base + url, { headers: { cookie }, redirect: 'manual', signal: AbortSignal.timeout(20000) });
            assert.equal(response.status, 200); return response.json();
        };
        for (const library of ['shared', 'personal']) {
            const overview = await get('/api/overview?productLimit=100&library=' + library);
            for (const product of overview.products) {
                const expected = product.sourceStoreIds.length > 0 && product.sourceStoreIds.every(id => user.role === 'admin' || assignments[id]?.ownerId === user.id);
                assert.equal(product.canDelete, expected, '商品删除入口必须对应服务端当前写权限');
                if (expected) own++; else others++;
                const details = await get('/api/products/' + encodeURIComponent(product.spuId) + '?' + new URLSearchParams({ sourceStoreId: product.sourceStoreIds[0], library }));
                assert.equal(details.product.canDelete, expected, '详情页与列表权限一致');
            }
        }
        checked++;
    }
    const response = await fetch(base + '/app.js', { signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/);
    const bytes = Buffer.from(await response.arrayBuffer()), hash = data => createHash('sha256').update(data).digest('hex');
    assert.equal(hash(bytes), hash(await readFile(new URL('../public/app.js', import.meta.url))));
    assert.match(bytes.toString(), /function canDeleteProduct\(product\)/);
    console.log(JSON.stringify({ catalogDeleteSmoke: true, accountsChecked: checked, deletableRows: own, protectedRows: others,
        responsePermissions: true, assetsMatched: true, productionWrites: 0, realPlatformCalls: 0 }));
} finally { await database.close(); }
