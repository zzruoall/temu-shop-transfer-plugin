/** 正式站只读验收新安装包、认证边界、来源名称与现有升级路由；不登记插件或提交平台商品。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { pluginVersionAtLeast } from '../lib/plugin-version.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
assert.equal(JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url))).version, '11.0.0');
assert.ok(pluginVersionAtLeast('11.0.0', [10, 10, 56]));
assert.ok(pluginVersionAtLeast('10.10.78', [10, 10, 56]));
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS));
assert.ok(credentials.deviceToken);
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const suffix of ['crx', 'zip']) {
    const name = `temu-transfer-plugin-11.0.0.${suffix}`;
    assert.equal((await fetch(base + '/downloads/' + name, { redirect: 'manual', signal: AbortSignal.timeout(20000) })).status, 401);
    const response = await fetch(base + '/downloads/' + name, { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/downloads/' + name, import.meta.url))));
}
const database = await openMysqlDatabase();
assert.ok(database);
let namesChecked = 0;
let sourceStoresChecked = 0;
try {
    const response = await fetch(base + '/api/overview?productLimit=100', { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);const overview = await response.json();
    const [entries] = await database.query('query', "SELECT entry_key,body FROM hub_map_entries WHERE domain='ownership'");
    const assignments = Object.fromEntries(entries.map(row => [row.entry_key, typeof row.body === 'string' ? JSON.parse(row.body) : row.body]));
    const [rawBatches] = await database.query('query', 'SELECT id,body FROM hub_batches');
    const batches = new Map(rawBatches.map(row => [row.id, typeof row.body === 'string' ? JSON.parse(row.body) : row.body]));
    for (const batch of overview.batches || []) {
        const raw = batches.get(batch.id);assert.ok(raw, '总览批次必须对应既有记录');
        const explicit = [raw.sourceStoreName, raw.shopName, raw.pageStoreName]
            .map(value => String(value || '').trim()).find(value => value && value !== batch.sourceStoreId);
        const expected = explicit || String(assignments[batch.sourceStoreId]?.storeName || batch.sourceStoreId).trim();
        assert.equal(batch.sourceStoreName, expected, '来源名称必须等于本批次有效名称或同ID目录名称');
        namesChecked++;
    }
    // 全范围来源筛选目录不依赖当前商品页，独立核对聚合名与同ID目录兜底。
    const [sources] = await database.query('query', `SELECT store_id,COALESCE(MAX(COALESCE(
        NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(body,'$.sourceStoreName'))),''),store_id),
        NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(body,'$.shopName'))),''),store_id),
        NULLIF(NULLIF(TRIM(JSON_UNQUOTE(JSON_EXTRACT(body,'$.pageStoreName'))),''),store_id))),store_id) AS name
        FROM hub_batches GROUP BY store_id`);
    const expectedSources = new Map(sources.filter(item => item.store_id).map(item => [item.store_id,
        item.name !== item.store_id ? item.name : String(assignments[item.store_id]?.storeName || item.store_id).trim()]));
    assert.equal((overview.sourceStores || []).length, expectedSources.size);
    for (const item of overview.sourceStores || []) { assert.equal(item.storeName, expectedSources.get(item.storeId));sourceStoresChecked++; }
} finally { await database.close(); }
const socket = new WebSocket(base.replace(/^http/, 'ws') + '/api/relay/socket');
let upgrade = false;
try {
    await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.terminate();reject(Error('升级路由验收超时')); }, 15000);
        socket.on('error', error => { clearTimeout(timer);reject(error); });
        socket.on('upgrade', response => { assert.equal(response.statusCode, 101);upgrade = true; });
        socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: 'invalid-smoke-token',
            pluginInstanceId: randomUUID(), identity: { storeId: 'temu:99999999999999999999', mallId: '99999999999999999999',
                relaySessionId: randomUUID(), relayProtocol: 1, executionMode: 'plugin-api', identityMatched: true,
                pageUrl: 'https://agentseller.temu.com/goods/list', pluginVersion: '11.0.0' } })));
        socket.on('close', code => { clearTimeout(timer);try { assert.equal(code, 4403);resolve(); } catch (error) { reject(error); } });
    });
    assert.ok(upgrade);
} finally { socket.terminate(); }
console.log(JSON.stringify({ collectionReleaseSmoke: true, plugin: '11.0.0', localVersionGateChecked: true,
    downloadsMatched: true, http101: upgrade, invalidTokenRejected: true, namesChecked,
    sourceStoresChecked, sourceNameVerification: namesChecked ? 'verified' : 'no_samples_not_verified',
    authenticatedDeliveryTest: 'isolated_HTTP_regression_not_real_shop', productionWrites: 0, realPlatformCalls: 0 }));
