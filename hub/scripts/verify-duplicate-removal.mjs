/** 执行真实页面查重函数；接口与商品列表均为隔离夹具，不访问平台、不提交商品。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { directExecutorFixture } from './direct-platform-fixture.mjs';

const source = await directExecutorFixture();
const code = 'SAME-CODE';

/** 明确绑定商品、SKC 与行状态，不能用同货号历史代替当前行的删除事实。 */
function row(id, removeStatus, level = 'product') {
    return { productId: id, productSkcId: `skc-${id}`, productName: `item-${id}`, removeStatus,
        extCode: level === 'product' ? code : 'OTHER-CODE', productSkuSummaries: [{ extCode: code }] };
}

/** 精确结果仍可跨页；未删除版本可能排在旧删除版本之后，不能首个命中即放行。 */
function fixture({ pages = [], filtered = null, level = 'product', cache = null } = {}) {
    const calls = [];
    const client = { mallIdClient: { getMallIdAsync: async () => '123' }, post: async (path, body) => {
        assert.equal(path, '/visage-agent-seller/product/skc/pageQuery');
        calls.push(body);
        const field = ['skcExtCodes', 'skuExtCodes'].find(key => body[key]);
        assert.ok(field, '只允许精确查询，不允许无过滤扫描整店');
        assert.equal(body.extCodes, undefined, '旧字段被平台忽略，禁止再使用');
        const sourceRows = filtered ?? pages.flat();
        const rows = sourceRows.filter(item => field === 'skcExtCodes'
            ? body[field].includes(item.extCode || item.skcExtCode)
            : [item.productSkuSummaries, item.skus, item.productSkuList].some(list => list?.some(sku => body[field].includes(sku.extCode || sku.skuExtCode))));
        const size = Math.max(1, ...pages.map(items => items.length));
        const offset = (body.page - 1) * size;
        return { result: { total: rows.length, pageItems: rows.slice(offset, offset + size) } };
    } };
    const runtime = () => client;
    runtime.m = { only: 'getMallIdAsync .postWithoutMallId= .mallIdClient=' };
    const window = { chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } };
    if (cache) window.__temuDuplicateIndex = { mallId: '123', epoch: 'current', at: Date.now(), ...cache };
    const context = vm.createContext({ console, crypto, Set, Map, String, Number, Object, Array, JSON,
        Error, Promise, setTimeout, clearTimeout, Date, window,
        location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list' },
        chrome: { scripting: { executeScript: async spec => [{ result: await spec.func(...spec.args) }] } } });
    vm.runInContext(source, context);
    vm.runInContext("directDuplicateEpochs.set(7, 'current')", context);
    context.payload = { mallId: '123', productCodes: level === 'product' ? [code] : [], skuCodes: level === 'sku' ? [code] : [] };
    return { calls, context, window, check: () => vm.runInContext('directDuplicateCheck(7, payload)', context) };
}

for (const level of ['product', 'sku']) {
    test(`${level}：只有删除版本不重复，未删除版本直接跳过`, async () => {
        assert.equal((await fixture({ level, pages: [[row('old', 1, level)]] }).check()).state, 'not_found');
        const hit = await fixture({ level, pages: [[row('active', 0, level)]] }).check();
        assert.equal(hit.state, 'exists');
        assert.equal(hit.productId, 'active');
    });
    test(`${level}：同页删除与未删除共存，不能用旧删除版本放行`, async () => {
        const hit = await fixture({ level, pages: [[row('old', 1, level), row('active', 0, level)]] }).check();
        assert.equal(hit.state, 'exists');
        assert.equal(hit.productId, 'active');
    });
    test(`${level}：精确结果首见删除版本，下一页有效版本仍必须跳过`, async () => {
        const old = row('old', 1, level);
        const f = fixture({ level, pages: [[old], [row('active', 0, level)]] });
        const hit = await f.check();
        assert.equal(hit.state, 'exists');
        assert.equal(hit.productId, 'active');
        assert.ok(f.calls.some(body => body.page === 2));
    });
    test(`${level}：删除与未知共存不能误新增，未知与有效共存仍跳过`, async () => {
        const f = fixture({ level, pages: [[row('old', 1, level), row('unknown', null, level)]] });
        const uncertain = await f.check();
        assert.equal(uncertain.state, 'uncertain');
        assert.match(uncertain.reason, /删除状态未确认/);
        assert.equal(f.window.__temuDuplicateIndex, undefined);
        const hit = await fixture({ level, pages: [[row('unknown', null, level), row('active', 0, level)]] }).check();
        assert.equal(hit.state, 'exists');
        assert.equal(hit.productId, 'active');
    });
}

test('状态只接受明确 0/1，空白、缺失、布尔及其他数值不能被转成未删除或已删除', async () => {
    for (const status of ['1', ' 1 ']) assert.equal((await fixture({ pages: [[row('old', status)]] }).check()).state, 'not_found');
    for (const status of ['0', ' 0 ']) assert.equal((await fixture({ pages: [[row('active', status)]] }).check()).state, 'exists');
    for (const status of [undefined, null, '', ' ', false, true, 9, 'deleted']) {
        assert.equal((await fixture({ pages: [[row('unknown', status)]] }).check()).state, 'uncertain');
    }
});

test('无匹配货号的未知状态不阻断当前商品，同结果中未知状态不能被删除记录抵消', async () => {
    assert.equal((await fixture({ pages: [[{ productId: 'other', extCode: 'OTHER' }]] }).check()).state, 'not_found');
    assert.equal((await fixture({ pages: [[row('old', null), row('old', 1)]] }).check()).state, 'uncertain');
});

test('精确结果不缓存负结论，旧整店缓存不能决定本次上传', async () => {
    const f = fixture({ pages: [[row('old', 1)]] });
    assert.equal((await f.check()).state, 'not_found');
    assert.equal(f.window.__temuDuplicateIndex, undefined);
    const before = f.calls.length;
    assert.equal((await f.check()).state, 'not_found');
    assert.equal(f.calls.length, before + 1, '再次实时查货号，不扫描整店或复用负结论');
    const legacy = fixture({ pages: [[row('old', 1)]], filtered: [], cache: { rows: [row('old', 0)] } });
    assert.equal((await legacy.check()).state, 'not_found');
});

test('实时删除或恢复优先于缓存中的相反旧状态', async () => {
    const restored = fixture({ pages: [[row('old', 0)]], cache: { rows: [row('old', 1)], removalAware: true } });
    assert.equal((await restored.check()).state, 'exists');
    const deleted = fixture({ pages: [[row('old', 1)]], cache: { rows: [row('old', 0)], removalAware: true } });
    assert.equal((await deleted.check()).state, 'not_found');
});

test('本轮平台新建成功加入未删除缓存，后续同货号仍跳过', async () => {
    const f = fixture({ filtered: [], cache: { rows: [], removalAware: true } });
    f.context.created = { mallId: '123', productId: 'created', request: { productSkcReqs: [{ extCode: code, productSkuReqs: [{ extCode: code }] }] } };
    await vm.runInContext("directPage(7, 'cache-created', created)", f.context);
    assert.equal(f.window.__temuDuplicateIndex.rows[0].removeStatus, 0);
    const hit = await f.check();
    assert.equal(hit.state, 'exists');
    assert.equal(hit.productId, 'created');
});

test('两个目标店实例的删除/未删除判断各自独立', async () => {
    assert.equal((await fixture({ pages: [[row('old', 1)]] }).check()).state, 'not_found');
    assert.equal((await fixture({ pages: [[row('active', 0)]] }).check()).state, 'exists');
});

test('旧删除缓存不能遮蔽精确查询中的已恢复版本', async () => {
    const f = fixture({ pages: [[{ productId: 'other', productSkcId: 'other-skc', extCode: 'OTHER', removeStatus: 0 }], [row('restored', 0)]],
        cache: { rows: [row('restored', 1)], removalAware: true } });
    assert.equal((await f.check()).productId, 'restored');
    assert.equal(f.calls.length, 1, '无关商品不占用精确查询的分页');
});

test('缺 SKC 身份的未知版本不能被同 SPU 的另一删除版本抵消', async () => {
    const unknown = row('same-product', null), deleted = row('same-product', 1);
    delete unknown.productSkcId;
    delete deleted.productSkcId;
    assert.equal((await fixture({ pages: [[unknown, deleted]] }).check()).state, 'uncertain');
});

test('空 SKU 摘要不遮蔽其他字段的有效 SKU，两级查询仍相互独立', async () => {
    const active = { ...row('active', 0, 'sku'), productSkuSummaries: [], skus: [{ extCode: code }] };
    const f = fixture({ pages: [[active]], level: 'product' });
    assert.equal((await f.check()).state, 'not_found');
    assert.equal(f.window.__temuDuplicateIndex, undefined);
    f.context.payload = { mallId: '123', productCodes: [], skuCodes: [code] };
    assert.equal((await f.check()).state, 'exists');
});

test('同 SPU 不同 SKC 的合法分页不被误判循环，下一页有效版本仍跳过', async () => {
    const deleted = row('same-product', 1), active = row('same-product', 0);
    deleted.productSkcId = 'old-skc';
    active.productSkcId = 'active-skc';
    const f = fixture({ pages: [[deleted], [active]] });
    assert.equal((await f.check()).state, 'exists');
});

test('旧删除列表不能覆盖本轮新建事实，查询其他货号也不能丢掉新建记录', async () => {
    const old = row('old', 1);
    const f = fixture({ filtered: [old], pages: [[old]] });
    assert.equal((await f.check()).state, 'not_found');
    f.context.created = { mallId: '123', cacheEpoch: 'current', productId: 'created', request: { productSkcReqs: [{ extCode: code }] } };
    await vm.runInContext("directPage(7, 'cache-created', created)", f.context);
    assert.equal((await f.check()).productId, 'created');
    f.context.payload = { mallId: '123', productCodes: ['ANOTHER-CODE'], skuCodes: [] };
    assert.equal((await f.check()).state, 'not_found');
    f.context.payload.productCodes = [code];
    assert.equal((await f.check()).productId, 'created');
});

test('尚未查货号时新建也建立本轮防重，但局部记录不能代表其他货号不存在', async () => {
    const f = fixture({ pages: [[row('another', 0)]] });
    f.context.created = { mallId: '123', cacheEpoch: 'current', productId: 'created', request: { productSkcReqs: [{ extCode: 'NEW-CODE' }] } };
    await vm.runInContext("directPage(7, 'cache-created', created)", f.context);
    assert.equal(f.window.__temuDuplicateIndex.at, 0);
    assert.equal((await f.check()).productId, 'another');
    f.context.payload.productCodes = ['NEW-CODE'];
    assert.equal((await f.check()).productId, 'created');
});

test('本轮新建缓存与请求比较器一样支持商品/SKU 货号别名', async () => {
    for (const level of ['product', 'sku']) {
        const f = fixture({ level, pages: [], filtered: [] });
        f.context.created = { mallId: '123', cacheEpoch: 'current', productId: 'created', request: {
            productSkcReqs: [level === 'product' ? { skcExtCode: code } : { productSkuReqs: [{ skuExtCode: code }] }] } };
        await vm.runInContext("directPage(7, 'cache-created', created)", f.context);
        assert.equal((await f.check()).state, 'exists');
        assert.equal((await f.check()).productId, 'created');
    }
});
