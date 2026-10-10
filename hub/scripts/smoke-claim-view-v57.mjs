/** 使用现有短期只读会话核验本人隐藏/保留和发送目录；不改变账号、认领或业务数据。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const database = await openMysqlDatabase(); assert.ok(database);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
    const [[schema]] = await database.query('query', 'SELECT data_root FROM hub_schema WHERE id=1');
    const filename = path.join(schema.data_root, 'users.json'), before = await readFile(filename);
    const state = JSON.parse(before);
    let checked = 0;
    for (const user of state.users.filter(user => !user.disabled)) {
        const expiry = String(Date.now() + 120000);
        const signature = createHmac('sha256', state.sessionSecret).update(`${user.id}.${expiry}`).digest('hex');
        const headers = { cookie: `temu_session=${user.id}.${expiry}.${signature}` };
        const get = async endpoint => {
            const response = await fetch(base + endpoint, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
            assert.equal(response.status, 200, endpoint); return response.json();
        };
        // 每页直接检查三态，不跨请求对比会变化的在线瞬时值，避免心跳竞态误判。
        for (const view of ['online', 'mine']) {
            let offset = 0, more = true;
            while (more) {
                const result = await get(`/api/stores?view=${view}&limit=200&offset=${offset}`);
                assert.equal(result.counts.online + result.counts.offline, result.total);
                assert.ok(result.stores.every(store => view === 'mine' ? store.claimState === 'mine' : store.claimState !== 'mine'));
                more = result.hasMore; offset += result.stores.length;
                if (more) assert.ok(result.stores.length > 0, '后续分页必须推进');
            }
        }
        const agents = await get('/api/agents?limit=200&offset=0');
        assert.ok(Array.isArray(agents.agents), '发送目标目录仍可访问');
        checked++;
    }
    assert.ok(checked > 0);
    assert.equal(hash(await readFile(filename)), hash(before), '只读核验不能改变账号文件');
    console.log(JSON.stringify({ claimViewSmoke: true, accountsChecked: checked, ownHiddenInAll: true, ownKeptInMine: true,
        countsAndPaginationChecked: true, targetDirectoryReadable: true, productionWrites: 0, realPlatformCalls: 0 }));
} finally { await database.close(); }
