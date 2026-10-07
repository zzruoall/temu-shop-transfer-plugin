/** 线上只读冒烟：核对当前商品状态与身份，不制造错误、不解除红标、不向店铺发送。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/temu$/);
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS, 'utf8'));
const headers = { authorization: `Bearer ${credentials.deviceToken}`, 'content-type': 'application/json' };
const request = (suffix, options = {}) => fetch(base + suffix, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000), ...options });
const database = await openMysqlDatabase();
assert.ok(database);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** 只保留摘要作为守恒证据，不把实例、错误正文或设备凭证写入发布输出。 */
async function evidence() {
    const [versions] = await database.query('query', 'SELECT * FROM hub_inventory_revision ORDER BY id');
    const [notices] = await database.query('query', 'SELECT id,instance_id,source_version,notice_epoch,notice FROM hub_product_notice_states ORDER BY id');
    return hash([versions, notices]);
}
try {
    const before = await evidence();
    const response = await request('/api/overview?productLimit=100');
    assert.equal(response.status, 200);
    const overview = await response.json();
    const products = overview.products.filter(product => product.sourceIdentity);
    assert.ok(products.length, '至少有一件真实已入库商品可供只读验收');
    const refs = products.map(({ spuId, sourceIdentity, productKey }) => ({ spuId: String(spuId), sourceIdentity, productKey }));
    for (const ref of refs) { assert.match(ref.sourceIdentity, /^[a-f0-9]{64}$/); assert.match(ref.productKey, /^[a-f0-9]{64}$/); }
    const stateResponse = await request('/api/products/status-read', { method: 'POST', body: JSON.stringify({ products: refs }) });
    assert.equal(stateResponse.status, 200);
    const states = await stateResponse.json();
    assert.deepEqual(states.staleIds, []);
    assert.equal(states.products.length, products.length);
    for (const state of states.products) {
        const product = products.find(product => String(product.spuId) === state.spuId);
        assert.ok(product);
        assert.equal(state.sourceIdentity, product.sourceIdentity);
        assert.equal(state.blocked, Boolean(product.blocked || product.sendBlocked));
        assert.equal(state.sendBlocked, Boolean(product.sendBlocked));
        assert.deepEqual(state.errorNotice, product.errorNotice || null);
        assert.doesNotMatch(JSON.stringify(state), /publicationData|sourceProduct|noticeToken|"images"/);
    }
    const staleResponse = await request('/api/products/status-read', { method: 'POST', body: JSON.stringify({ products: refs.map(ref =>
        ({ ...ref, sourceIdentity: (ref.sourceIdentity[0] === 'f' ? 'e' : 'f') + ref.sourceIdentity.slice(1) })) }) });
    assert.equal(staleResponse.status, 200);
    assert.deepEqual(await staleResponse.json(), { products: [], staleIds: refs.map(ref => ref.spuId) });
    const invalid = await request('/api/products/status-read', { method: 'POST', body: '{"products":[]}' });
    assert.equal(invalid.status, 400);
    const denied = await request('/api/products/status-read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ products: refs }) });
    assert.ok([401, 403].includes(denied.status));
    assert.equal(await evidence(), before, '状态读取不能改写库存或错误实例');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const stream = await request('/api/events', { signal: controller.signal });
        assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type'), /text\/event-stream/);
        const reader = stream.body.getReader(); let text = '';
        while (!text.includes('event: live')) {
            const item = await reader.read(); assert.equal(item.done, false);
            text += new TextDecoder().decode(item.value);
        }
        await reader.cancel();
    } finally { clearTimeout(timeout); controller.abort(); }
    console.log(JSON.stringify({ productStatusLiveSmoke: true, examined: products.length, blocked: states.products.filter(p => p.blocked).length,
        sourceIdentityValidated: true, staleRejected: true, unauthenticatedDenied: true, sseConnected: true, productionWrites: 0, realPlatformCalls: 0 }));
} finally { await database.close(); }
