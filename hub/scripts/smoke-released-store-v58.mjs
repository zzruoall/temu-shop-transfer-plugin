/** 线上只读验收当前认领展示规则；会话只留内存，不认领店铺、不修改商品或账户。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import path from 'node:path';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const database = await openMysqlDatabase(); assert.ok(database);
const parse = body => typeof body === 'string' ? JSON.parse(body) : body;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
try {
    const [[schema]] = await database.query('query', 'SELECT data_root FROM hub_schema WHERE id=1');
    const filename = path.join(schema.data_root, 'users.json'), before = await readFile(filename);
    const state = JSON.parse(before);
    const [rows] = await database.query('query', "SELECT entry_key,body FROM hub_map_entries WHERE domain='ownership'");
    const entries = Object.fromEntries(rows.map(row => [row.entry_key, parse(row.body)]));
    const domains = Object.fromEntries(Object.values(entries).filter(row => row.kind === 'data-domain').map(row => [row.storeId, row.accountType]));
    const assigned = Object.fromEntries(Object.entries(entries).filter(([, row]) => row.ownerId));
    const [agentRows] = await database.query('query', 'SELECT store_id FROM hub_agents');
    const directoryIds = new Set([...agentRows.map(row => row.store_id).filter(Boolean), ...Object.keys(assigned)]);
    // 用户可随时重新认领店铺，线上不保证保留历史解绑样本；不能为验收强制解绑真实账户。
    const activeTypes = new Set(state.users.filter(user => !user.disabled).map(user => user.accountType || 'production'));
    const releasedSamples = Object.entries(domains).filter(([id, type]) => directoryIds.has(id) && !assigned[id]
        && [...activeTypes].some(accountType => accountType !== type));
    let accountsChecked = 0, releasedCrossCategoryChecks = 0;
    for (const user of state.users.filter(user => !user.disabled)) {
        const expiry = String(Date.now() + 120000);
        const signature = createHmac('sha256', state.sessionSecret).update(`${user.id}.${expiry}`).digest('hex');
        const headers = { cookie: `temu_session=${user.id}.${expiry}.${signature}` };
        const get = async endpoint => {
            const response = await fetch(base + endpoint, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
            assert.equal(response.status, 200, endpoint); return response.json();
        };
        const type = user.accountType || 'production';
        const expected = [...directoryIds].filter(id => !assigned[id] || !domains[id] || domains[id] === type);
        const all = await get('/api/stores?view=all&limit=200');
        assert.equal(all.hasMore, false, '本次目录验收应覆盖全量店铺');
        assert.deepEqual(all.stores.map(row => row.storeId).sort(), expected.sort());
        for (const store of all.stores) {
            if (!assigned[store.storeId]) {
                assert.equal(store.claimState, 'unclaimed'); assert.equal(store.accountType, '');
                assert.equal(store.ownerName, '');
                if (domains[store.storeId] && domains[store.storeId] !== type) releasedCrossCategoryChecks++;
            } else assert.equal(domains[store.storeId], type);
        }
        const online = await get('/api/stores?view=online&limit=200');
        assert.ok(online.stores.every(row => row.claimState !== 'mine'));
        const mine = await get('/api/stores?view=mine&limit=200');
        assert.ok(mine.stores.every(row => assigned[row.storeId]?.ownerId === user.id && row.claimState === 'mine'));
        const targets = await get('/api/agents?limit=200');
        assert.ok(targets.agents.every(row => assigned[row.storeId]?.ownerId === user.id));
        if (user.role === 'admin') {
            const pending = await get('/api/stores?accountType=unclassified&limit=200');
            assert.ok(pending.stores.every(row => row.accountType === 'unclassified'));
        }
        accountsChecked++;
    }
    assert.ok(accountsChecked > 0);
    if (releasedSamples.length) assert.ok(releasedCrossCategoryChecks > 0, '现存解绑样本必须验证跨分类可见');
    else assert.equal(releasedCrossCategoryChecks, 0, '无历史解绑样本时不能伪造实测覆盖');
    assert.equal(hash(await readFile(filename)), hash(before));
    console.log(JSON.stringify({ releasedStoreSmoke: true, accountsChecked, releasedCrossCategoryChecks,
        releasedCrossCategoryCoverage: releasedSamples.length ? 'verified' : 'sample-not-present',
        currentClaimsSeparated: true, unclaimedVisible: releasedCrossCategoryChecks > 0 ? true : null,
        ownTargetsOnly: true, adminClassificationPreserved: true,
        productionWrites: 0, realPlatformCalls: 0 }));
} finally { await database.close(); }
