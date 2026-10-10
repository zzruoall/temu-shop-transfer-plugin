/** 用生产网页函数和模拟传输复现边界；不连接线上、不提交平台商品。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
/** 提取真实函数，不在测试中复制一份调度或筛选实现。 */
function implementation(name) {
    const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
    assert.ok(match, name);
    const text = source.slice(match.index), end = /^}\r?$/m.exec(text);
    assert.ok(end, name);
    return text.slice(0, end.index + end[0].length);
}
function harness(api) {
    const context = vm.createContext({ api, crypto: { randomUUID }, Map, Set, productExtCodes: product => [product.articleNo || product.spuId] });
    vm.runInContext(['prepareBulkSelection', 'submitBulkManifest', 'blockedTransferText', 'transferResultText'].map(implementation).join('\n'), context);
    return context;
}
const group = count => ({ sourceStoreId: 'source', sourceBatchId: 'batch', spuIds: Array.from({ length: count }, (_, i) => String(i)) });
const targets = ['A', 'B', 'C'].map(storeId => ({ storeId }));

test('六件选中只形成四件发送正文；全部标红或缺来源不产生发送组', () => {
    const api = harness();
    const products = Array.from({ length: 6 }, (_, i) => ({ spuId: String(i), sendBlocked: i < 2 }));
    const selection = api.prepareBulkSelection(products, () => ({ id: 'batch', sourceStoreId: 'source' }));
    assert.equal(selection.eligible, 4); assert.equal(selection.blocked.length, 2);
    assert.deepEqual(Array.from(selection.groups[0].spuIds), ['2', '3', '4', '5']);
    const empty = api.prepareBulkSelection(products.slice(0, 2), () => null);
    assert.equal(empty.groups.length, 0); assert.equal(empty.blocked.length, 2);
    assert.equal(api.prepareBulkSelection(products.slice(2), () => null).missing.length, 4);
});

test('最多两店同时在途；同店十件分段有序，分段同标识，人工再发使用新标识', async () => {
    const calls = [], gates = []; let active = 0, peak = 0;
    const api = harness(async (url, options) => {
        assert.equal(url, '/temu/api/relay/send');
        const body = JSON.parse(options.body); calls.push(body);
        active++; peak = Math.max(peak, active);
        if (calls.length <= 2) await new Promise(resolve => gates.push(resolve));
        active--; return { sent: body.spuIds.length };
    });
    const pending = api.submitBulkManifest([group(21)], [...targets, targets[0]]);
    assert.equal(calls.length, 2); assert.deepEqual(calls.map(v => v.targetStoreId), ['A', 'B']);
    gates.forEach(resolve => resolve());
    const result = await pending;
    assert.equal(result.sent, 63); assert.equal(peak, 2);
    for (const target of targets) {
        const chunks = calls.filter(v => v.targetStoreId === target.storeId);
        assert.deepEqual(chunks.map(v => v.spuIds.length), [10, 10, 1]);
        assert.equal(new Set(chunks.map(v => v.manualSendId)).size, 1);
        assert.deepEqual(chunks.flatMap(v => v.spuIds), group(21).spuIds);
    }
    const previous = calls[0].manualSendId;
    await api.submitBulkManifest([group(1)], [targets[0]]);
    assert.notEqual(calls.at(-1).manualSendId, previous);
});

test('离页停止两店后续分段和第三店，已发请求正常结算，不自动补发', async () => {
    let current = true; const gates = [], calls = [];
    const api = harness(async (url, options) => {
        calls.push(JSON.parse(options.body));
        await new Promise(resolve => gates.push(resolve));
        return { sent: 10 };
    });
    const pending = api.submitBulkManifest([group(21)], targets, { canSend: () => current });
    assert.equal(calls.length, 2); current = false;
    gates.forEach(resolve => resolve());
    const result = await pending;
    assert.equal(result.stopped, true); assert.equal(result.sent, 20);
    assert.equal(calls.length, 2); assert.match(api.transferResultText(result), /已发内容未撤回/);
    await api.submitBulkManifest([group(1)], targets, { canSend: () => false });
    assert.equal(calls.length, 2);
});

test('一店失败不阻断其他店；服务端新增红标跳过和错误同时可见', async () => {
    const calls = [];
    const api = harness(async (url, options) => {
        const body = JSON.parse(options.body); calls.push(body.targetStoreId);
        if (body.targetStoreId === 'A') throw Error('目标未连接');
        return { sent: 0, skippedBlocked: [{ spuId: '0', productCodes: ['CODE-1'] }] };
    });
    await assert.rejects(api.submitBulkManifest([group(1)], targets), /实际发出 0 份.*已跳过禁传 2 份.*CODE-1.*A.*目标未连接/);
    assert.deepEqual(calls.sort(), ['A', 'B', 'C']);
});

test('资格在途变化只过滤后续分段和未开始店铺，已交付分段不撤回', async () => {
    const products = new Map(group(20).spuIds.map(spuId => [spuId, { spuId }]));
    const calls = [], gates = [];
    const api = harness(async (url, options) => {
        const body = JSON.parse(options.body); calls.push(body);
        if (calls.length <= 2) await new Promise(resolve => gates.push(resolve));
        return { sent: body.spuIds.length };
    });
    const pending = api.submitBulkManifest([group(20)], targets, { productForId: id => products.get(id) });
    assert.equal(calls.length, 2);
    products.get('19').sendBlocked = true;
    products.get('18').statusStale = true;
    gates.forEach(resolve => resolve());
    const result = await pending;
    assert.equal(result.sent, 54);
    assert.equal(result.skippedBlocked.length, 3);
    for (const body of calls.slice(2)) assert.ok(!body.spuIds.includes('19') && !body.spuIds.includes('18'));
});

test('删除旧查验、查看方式和手工导入入口，保留商品库路由与发送校验', () => {
    assert.doesNotMatch(source, /function renderBatch\(|function renderAllProductsFrame\(|核验说明|字段完整度|框架预览|待接入商品数据/);
    assert.doesNotMatch(source, /href=["']#\/products\/all/);
    assert.doesNotMatch(source, /product-view-mode|catalog-upload-button|catalog-files|function uploadFiles\(|function bindDrop\(|data-business-product-group/);
    assert.match(implementation('route'), /#\/products\/all/);
    // 无在线店只禁用弹窗提交，不禁用开窗入口；红标与来源校验仍保留。
    assert.match(source, /button\.disabled = Boolean\(blocked \|\| !hasBatch/);
    assert.doesNotMatch(source, /button\.disabled = Boolean\(blocked \|\| !targetStores\.length/);
    assert.match(source, /uploadConfirmButton\.disabled = !actionType \|\| !targetCount \|\| !selection\.eligible/);
    assert.match(source, /标红跳过.*缺少来源/);
});
