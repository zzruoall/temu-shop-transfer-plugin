/**
 * 直接执行插件注入到目标店页面的重复检索函数，覆盖分页遍历、货号匹配与“无法确认”分支。
 * 全程使用假页面与假接口，不访问 Temu，也不产生任何创建请求。
 */
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../plugin/direct-executor.js', import.meta.url), 'utf8');

/** 构造一次注入执行环境：pageRows 决定分页返回，options 控制异常与分页字段行为。 */
async function runCheck({ pageRows, productName = '目标商品', extCodes = ['UAD05*2'], acceptKey = 'page', ignorePaging = false, failOnPage = 0, ambiguousClient = false, supportSkuFilter = false }) {
    const calls = [];
    const client = {
        mallIdClient: { getMallIdAsync: async () => '123' },
        post: async (path, body) => {
            calls.push({ path, body });
            // 假服务端只认一种分页字段名，用来验证插件的字段名回退与沿用。
            const keys = ['page', 'pageNum', 'pageNumber'].filter(key => body[key] !== undefined);
            if (!keys.includes(acceptKey)) throw Error('unsupported_page_field');
            const page = Number(body[acceptKey]);
            if (failOnPage && page === failOnPage) throw Error('分页请求失败');
            if (supportSkuFilter && Array.isArray(body.skuExtCodes)) {
                const wanted = new Set(body.skuExtCodes);
                const filtered = (pageRows[0] || []).filter(item => (item.productSkuSummaries || []).some(sku => wanted.has(sku.extCode)) || wanted.has(item.extCode));
                return { result: { total: filtered.length, pageItems: filtered } };
            }
            const index = ignorePaging ? 1 : page;
            return { result: { pageItems: pageRows[index - 1] || [] } };
        }
    };
    const runtime = () => client;
    runtime.m = ambiguousClient
        ? { a: 'getMallIdAsync x .postWithoutMallId= x .mallIdClient=', b: 'getMallIdAsync y .postWithoutMallId= y .mallIdClient=' }
        : { only: 'getMallIdAsync .postWithoutMallId= .mallIdClient=' };
    const context = vm.createContext({
        console, crypto, Set, String, Number, Object, Array, JSON, Error, Promise, setTimeout,
        location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list' },
        window: {
            // webpack 的 chunkLoadingGlobal 只接收一个数组参数：[chunkIds, modules, runtimeCallback]。
            chunkLoadingGlobal_temu_sca_goods: { push: (entry) => entry[2](runtime) }
        },
        chrome: { scripting: { executeScript: async (spec) => [{ result: await spec.func(...spec.args) }] } }
    });
    vm.runInContext(source, context);
    context.__payload = { mallId: '123', spuId: '1160816649', productName, extCodes, skuIds: [] };
    let result = null;
    let failure = '';
    try {
        result = await vm.runInContext('directDuplicateCheck(7, __payload)', context);
    } catch (error) {
        failure = String(error?.message || error);
    }
    return { result, failure, calls };
}

const row = (id, name, codes) => ({ productId: id, productName: name, productSkuSummaries: codes.map(code => ({ productSkuId: `sku-${code}`, extCode: code })) });

// 当前 Temu 货号过滤路径：有 total 且返回匹配行时，不再扫描其余分页。
{
    const { result, calls } = await runCheck({ supportSkuFilter: true, pageRows: [[row('9', '新商品', ['UAD05*2'])], []] });
    assert.equal(result.state, 'exists');
    assert.equal(result.matchedBy, 'extCode');
    assert.equal(calls.length, 1);
}

// 单页无匹配：只有确认遍历结束才允许进入创建。
{
    const { result, calls } = await runCheck({ pageRows: [[row('1', '别的商品', ['X'])], []] });
    assert.equal(result.state, 'not_found');
    assert.equal(result.scanned, 1);
    assert.equal(result.pages, 1);
    assert.ok(calls.filter(call => call.path.endsWith('/product/skc/pageQuery')).length >= 2, '必须再取一次空页确认结束');
}

// 服务端把 pageSize 截断成 2：不能因为第一页没满就停，必须继续翻到空页。
{
    const { result } = await runCheck({ pageRows: [[row('1', 'A', ['X']), row('2', 'B', ['Y'])], [row('3', 'C', ['Z'])], []] });
    assert.equal(result.state, 'not_found');
    assert.equal(result.scanned, 3);
    assert.equal(result.pages, 2);
}

// 目标商品在第二页，按货号命中。
{
    const { result } = await runCheck({ pageRows: [[row('1', '别的商品', ['X'])], [row('9', '新商品', ['UAD05*2'])]] });
    assert.equal(result.state, 'exists');
    assert.equal(result.productId, '9');
    assert.equal(result.productName, '新商品');
    assert.equal(result.matchedBy, 'extCode');
}

// 只有名称没有货号时不能猜测重复，必须阻止上传并提示补充货号。
{
    const { result } = await runCheck({ productName: '精确同名', extCodes: [], pageRows: [[row('1', '精确同名', ['X'])]] });
    assert.equal(result.state, 'uncertain');
    assert.match(result.reason, /缺少货号/);
}

// 商品没有 SKU 明细时，行级货号仍要能命中。
{
    const { result } = await runCheck({ pageRows: [[{ productId: '5', productName: '无SKU明细商品', extCode: 'UAD05*2' }]] });
    assert.equal(result.state, 'exists');
    assert.equal(result.matchedBy, 'extCode');
    assert.equal(result.productId, '5');
}

// 服务端忽略分页参数：同一页反复返回，不能据此断言不存在。
{
    const { result } = await runCheck({ ignorePaging: true, pageRows: [[row('1', 'A', ['X'])], [row('2', 'B', ['Y'])]] });
    assert.equal(result.state, 'uncertain');
    assert.match(result.reason, /分页重复/);
}

// 分页中途失败：异常向上抛出，调用方按未知处理，不能返回 not_found。
{
    const { result, failure } = await runCheck({ failOnPage: 2, pageRows: [[row('1', 'A', ['X'])]] });
    assert.equal(result, null);
    assert.match(failure, /商品检索分页请求失败|分页请求失败/);
}

// 客户端模块不唯一：直接失败，不能拿错模块去判断是否存在。
{
    const { failure } = await runCheck({ ambiguousClient: true, pageRows: [[]] });
    assert.match(failure, /平台客户端不兼容/);
}

// 分页字段名兼容：服务端只认某一种写法时，插件必须换到可用写法并沿用同一写法翻页。
for (const acceptKey of ['page', 'pageNum', 'pageNumber']) {
    const { result, calls } = await runCheck({ acceptKey, pageRows: [[row('1', 'A', ['X'])], [row('2', 'B', ['UAD05*2'])]] });
    assert.equal(result.state, 'exists', `字段名 ${acceptKey} 时应能翻到第二页`);
    assert.equal(result.productId, '2');
    assert.ok(calls.every(call => call.path.endsWith('/product/skc/pageQuery')), '只在商品检索接口上分页');
}

console.log('重复检索检查通过：分页遍历到底、货号与同名命中、分页重复与失败均不下发创建');
