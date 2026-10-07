/** 精确货号查询回归：执行真实后台与页面注入代码，仅使用内存客户端，不访问平台或创建商品。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { directExecutorFixture } from './direct-platform-fixture.mjs';

const source = await directExecutorFixture();
const QUERY_PATH = '/visage-agent-seller/product/skc/pageQuery';
const CODE = 'EXACT-CODE';
const levels = [
    { name: '商品', input: 'productCodes', field: 'skcExtCodes', matchedBy: 'productExtCode' },
    { name: 'SKU', input: 'skuCodes', field: 'skuExtCodes', matchedBy: 'skuExtCode' }
];

/** 商品与 SKU 使用不同货号池，另一层故意填入无关货号，防止夹具自己实现交叉匹配。 */
function row(level, id, removeStatus = 1, code = CODE) {
    return {
        productId: `product-${id}`, productSkcId: `skc-${id}`, productName: `item-${id}`,
        removeStatus, extCode: level.input === 'productCodes' ? code : 'OTHER-PRODUCT',
        productSkuSummaries: [{ productSkuId: `sku-${id}`, extCode: level.input === 'skuCodes' ? code : 'OTHER-SKU' }]
    };
}

/** 返回平台约定的唯一响应形状；不补默认 total，缺字段攻击必须原样到达被测代码。 */
function response(total, pageItems) {
    return { result: { total, pageItems } };
}

/** 同货号的历史版本保留独立 SKC 身份，用于验证分页重复检测不能仅按 SPU 去重。 */
function deletedRows(level, count = 100, code = CODE) {
    return Array.from({ length: count }, (_, index) => row(level, `old-${index}`, 1, code));
}

/**
 * 分离后台与页面全局对象，并序列化真实 executeScript 函数后在页面 VM 执行，避免闭包替代正式注入逻辑。
 * 请求断言放在执行完成后，不能在 post 中抛断言后被插件重试吞掉；所有接口仅返回本地模拟数据。
 */
async function runCheck({ level = levels[0], codes = [CODE], reply = () => response(0, []), clientMode = 'normal' } = {}) {
    const calls = [];
    const injections = [];
    const client = {
        mallIdClient: { getMallIdAsync: async () => '123' },
        post: async (path, body) => {
            const call = { path, body: structuredClone(body) };
            calls.push(call);
            // 错误实现若不停翻页，限制本地请求数量，仍保留全部越界证据供外层断言检查。
            if (calls.length > 160) throw Error('隔离夹具请求预算耗尽');
            return structuredClone(await reply(call, calls.length));
        }
    };
    const runtime = () => clientMode === 'boolean' ? true : client;
    const signature = 'getMallIdAsync .postWithoutMallId= .mallIdClient=';
    runtime.m = clientMode === 'ambiguous' ? { first: signature, second: signature } : { only: signature };
    const page = vm.createContext({
        console, crypto: { randomUUID }, setTimeout, clearTimeout,
        location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list' },
        window: { chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } }
    });
    const background = vm.createContext({
        console, crypto: { randomUUID },
        // 仅压缩后台失败重试的等待，不替换截止时间函数，也不影响正式查询和页面结果。
        setTimeout: (callback, delay, ...args) => setTimeout(callback, delay === 800 ? 0 : delay, ...args),
        clearTimeout,
        chrome: { scripting: { executeScript: async spec => {
            injections.push({ world: spec.world, target: structuredClone(spec.target), funcType: typeof spec.func });
            page.__injectionArgs = JSON.parse(JSON.stringify(spec.args));
            const result = await vm.runInContext(`(${spec.func.toString()})(...__injectionArgs)`, page, { timeout: 1000 });
            return [{ result: structuredClone(result) }];
        } } }
    });
    vm.runInContext(source, background, { timeout: 1000 });
    const payload = { mallId: '123', productCodes: [], skuCodes: [], [level.input]: codes };
    vm.runInContext(`globalThis.__payload = ${JSON.stringify(payload)}`, background);
    const result = await vm.runInContext('directDuplicateCheck(7, __payload, { force: true })', background, { timeout: 1000 });
    assert.ok(injections.length > 0, '必须执行真实插件注入函数，不能在夹具中伪造判重结果');
    for (const injection of injections) {
        assert.equal(injection.world, 'MAIN');
        assert.equal(injection.target.tabId, 7);
        assert.equal(injection.funcType, 'function');
    }
    for (const { path, body } of calls) {
        assert.equal(path, QUERY_PATH, '只允许货号检索，不允许访问其他平台接口');
        assert.equal(Object.hasOwn(body, 'extCodes'), false, '禁止发送歧义 extCodes 字段');
        assert.equal(Object.hasOwn(body, level.field === 'skcExtCodes' ? 'skuExtCodes' : 'skcExtCodes'), false, '商品和 SKU 查询字段不能混用');
        assert.ok(Array.isArray(body[level.field]), `禁止无货号过滤请求，必须带 ${level.field}`);
        assert.equal(body[level.field].length, 1, '每个货号单独分页，不能混成一个查询');
        assert.ok(codes.includes(body[level.field][0]), '不能检索载荷之外的货号');
        assert.ok(Number.isInteger(body.page) && body.page >= 1, '仅接受明确的 page 页码');
        assert.equal(body.pageSize, 100);
        assert.equal(Object.hasOwn(body, 'pageNum'), false, '不能回退其他分页字段');
        assert.equal(Object.hasOwn(body, 'pageNumber'), false, '不能回退其他分页字段');
    }
    return { result, calls };
}

/** 逐货号读取调用序列，明确限定查询范围及页数，而不是只检查最终状态。 */
function pagesFor(calls, level, code = CODE) {
    return calls.filter(call => call.body[level.field][0] === code).map(call => call.body.page);
}

/** 未查清必须可诊断；既不能抛出异常终止调用方，也不能冒充允许创建的 not_found。 */
function assertUncertain(result) {
    assert.equal(result.state, 'uncertain');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.trim(), '未确认必须附带可读原因');
}

for (const level of levels) {
    test(`${level.name}：零命中仅一次精确请求，大整店的无关分页绝不读取`, async () => {
        let wholeStoreReads = 0;
        const { result, calls } = await runCheck({ level, reply: ({ body }) => {
            if (body[level.field]?.[0] === CODE) return response(0, []);
            wholeStoreReads += 1;
            return response(500000, [row(level, 'unrelated', 0, 'OTHER')]);
        } });
        assert.equal(result.state, 'not_found');
        assert.equal(wholeStoreReads, 0, '不得用整店无关分页兜底');
        assert.equal(calls.length, 1);
        assert.deepEqual(pagesFor(calls, level), [1]);
    });

    test(`${level.name}：明确未删除精确命中为 exists`, async () => {
        const { result, calls } = await runCheck({ level, reply: () => response(1, [row(level, 'active', 0)]) });
        assert.equal(result.state, 'exists');
        assert.equal(result.productId, 'product-active');
        assert.equal(result.matchedBy, level.matchedBy);
        assert.equal(calls.length, 1);
    });

    test(`${level.name}：同货号第一页全删除，第二页未删除版本仍为 exists`, async () => {
        const { result, calls } = await runCheck({ level, reply: ({ body }) => response(101,
            body.page === 1 ? deletedRows(level) : body.page === 2 ? [row(level, 'active', 0)] : []) });
        assert.equal(result.state, 'exists');
        assert.equal(result.productId, 'product-active');
        assert.deepEqual(pagesFor(calls, level), [1, 2]);
    });

    test(`${level.name}：同货号全部删除，达到 total 即结束，不额外请求空页`, async () => {
        const { result, calls } = await runCheck({ level, reply: ({ body }) => response(101,
            body.page === 1 ? deletedRows(level) : body.page === 2 ? [row(level, 'last')] : []) });
        assert.equal(result.state, 'not_found');
        assert.deepEqual(pagesFor(calls, level), [1, 2]);
    });

    test(`${level.name}：恰好一整页删除版本只请求一页`, async () => {
        const { result, calls } = await runCheck({ level, reply: () => response(100, deletedRows(level)) });
        assert.equal(result.state, 'not_found');
        assert.deepEqual(pagesFor(calls, level), [1]);
    });

    test(`${level.name}：服务端截短非空页，不能在尚未达到 total 时提前放行`, async () => {
        const { result, calls } = await runCheck({ level, reply: ({ body }) => response(2,
            body.page === 1 ? [row(level, 'old')] : body.page === 2 ? [row(level, 'active', 0)] : []) });
        assert.equal(result.state, 'exists');
        assert.deepEqual(pagesFor(calls, level), [1, 2]);
    });

    test(`${level.name}：多个货号各自查清，不能用首个零命中或删除版本代表其余货号`, async () => {
        const codes = ['MISSING', 'DELETED', 'ACTIVE'];
        const { result, calls } = await runCheck({ level, codes, reply: ({ body }) => {
            const code = body[level.field]?.[0];
            if (code === 'MISSING') return response(0, []);
            if (code === 'DELETED') return response(1, [row(level, 'deleted', 1, code)]);
            return response(101, body.page === 1 ? deletedRows(level, 100, code) : [row(level, 'active', 0, code)]);
        } });
        assert.equal(result.state, 'exists');
        assert.equal(result.productId, 'product-active');
        assert.deepEqual(pagesFor(calls, level, 'MISSING'), [1]);
        assert.deepEqual(pagesFor(calls, level, 'DELETED'), [1]);
        assert.deepEqual(pagesFor(calls, level, 'ACTIVE'), [1, 2]);
    });

    test(`${level.name}：多个货号均为负结论时，total 按每个货号独立计算`, async () => {
        const codes = ['EMPTY', 'OLD'];
        const { result, calls } = await runCheck({ level, codes, reply: ({ body }) => {
            const code = body[level.field]?.[0];
            return code === 'EMPTY' ? response(0, []) : response(101,
                body.page === 1 ? deletedRows(level, 100, code) : [row(level, 'last', 1, code)]);
        } });
        assert.equal(result.state, 'not_found');
        assert.deepEqual(pagesFor(calls, level, 'EMPTY'), [1]);
        assert.deepEqual(pagesFor(calls, level, 'OLD'), [1, 2]);
    });

    test(`${level.name}：多个货号有一个查询失败，不能仅凭其他货号的零命中放行`, async () => {
        const { result, calls } = await runCheck({ level, codes: ['EMPTY', 'FAILED'], reply: ({ body }) => {
            if (body[level.field]?.[0] === 'EMPTY') return response(0, []);
            throw Error('精确货号请求失败');
        } });
        assertUncertain(result);
        assert.ok(pagesFor(calls, level, 'FAILED').length > 0);
    });

    for (const [label, status] of [['缺失', undefined], ['null', null], ['空串', ''], ['空白', ' '],
        ['false', false], ['true', true], ['非法整数', 2], ['描述文本', 'deleted']]) {
        test(`${level.name}：删除状态${label}为 uncertain`, async () => {
            const unknown = row(level, 'unknown');
            unknown.removeStatus = status;
            const { result } = await runCheck({ level, reply: () => response(2, [row(level, 'deleted'), unknown]) });
            assertUncertain(result);
        });
    }

    for (const [label, total] of [['缺失', undefined], ['null', null], ['负数', -1], ['小数', 1.5],
        ['布尔 true', true], ['布尔 false', false], ['数字字符串', '0'], ['NaN', NaN], ['Infinity', Infinity]]) {
        test(`${level.name}：total ${label}不能成为不存在证据`, async () => {
            const { result } = await runCheck({ level, reply: () => response(total, []) });
            assertUncertain(result);
        });
    }

    test(`${level.name}：即使返回有效命中，缺失 total 也不能掩盖协议异常`, async () => {
        const { result } = await runCheck({ level, reply: () => ({ result: { pageItems: [row(level, 'active', 0)] } }) });
        assertUncertain(result);
    });

    for (const total of [100, 102]) {
        test(`${level.name}：第二页 total 变为 ${total}，不能确认完整结果`, async () => {
            const { result } = await runCheck({ level, reply: ({ body }) => response(body.page === 1 ? 101 : total,
                body.page === 1 ? deletedRows(level) : [row(level, 'last')]) });
            assertUncertain(result);
        });
    }

    test(`${level.name}：第二页缺 total 返回 uncertain`, async () => {
        const { result } = await runCheck({ level, reply: ({ body }) => body.page === 1
            ? response(101, deletedRows(level)) : { result: { pageItems: [row(level, 'last')] } } });
        assertUncertain(result);
    });

    for (const firstPageEmpty of [true, false]) {
        test(`${level.name}：${firstPageEmpty ? '首' : '第二'}页在 total 尚未完成前为空，返回 uncertain`, async () => {
            const { result } = await runCheck({ level, reply: ({ body }) => response(101,
                !firstPageEmpty && body.page === 1 ? deletedRows(level) : []) });
            assertUncertain(result);
        });
    }

    test(`${level.name}：客户端忽略 page，重复返回同页不能当作已查完`, async () => {
        const { result, calls } = await runCheck({ level, reply: () => response(101, deletedRows(level)) });
        assertUncertain(result);
        assert.ok(calls.some(call => call.body.page === 2));
    });

    test(`${level.name}：第二页部分重叠不能按行数凑足 total`, async () => {
        const first = deletedRows(level);
        const { result } = await runCheck({ level, reply: ({ body }) => response(101,
            body.page === 1 ? first : [first[0]]) });
        assertUncertain(result);
    });

    test(`${level.name}：重复分页仅调整行顺序，仍不能按两个不同整页签名放行`, async () => {
        const first = deletedRows(level);
        const { result } = await runCheck({ level, reply: ({ body }) => response(200,
            body.page === 1 ? first : [...first].reverse()) });
        assertUncertain(result);
    });

    test(`${level.name}：同 SPU 不同 SKC 是合法版本，第二页有效版本不能误判重复分页`, async () => {
        const first = deletedRows(level).map(item => ({ ...item, productId: 'same-product' }));
        const active = { ...row(level, 'active', 0), productId: 'same-product' };
        const { result, calls } = await runCheck({ level, reply: ({ body }) => response(101, body.page === 1 ? first : [active]) });
        assert.equal(result.state, 'exists');
        assert.deepEqual(pagesFor(calls, level), [1, 2]);
    });

    for (const page of [1, 2]) {
        test(`${level.name}：第 ${page} 页请求失败返回 uncertain，不回退整店请求`, async () => {
            const { result } = await runCheck({ level, reply: ({ body }) => {
                if (body.page === page) throw { success: false, errorCode: 403, errorMsg: '模拟查询失败' };
                return response(101, deletedRows(level));
            } });
            assertUncertain(result);
        });
    }

    test(`${level.name}：客户端忽略货号字段并返回大整店无关行，只能 uncertain`, async () => {
        const { result, calls } = await runCheck({ level, reply: () => response(500000, [row(level, 'unrelated', 0, 'OTHER')]) });
        assertUncertain(result);
        assert.ok(calls.every(call => call.body.page === 1), '发现过滤失效后不能继续翻阅整店无关页');
    });

    for (const activeFirst of [true, false]) {
        test(`${level.name}：精确结果混入无关货号，${activeFirst ? '命中在前' : '命中在后'}也不能掩盖过滤失效`, async () => {
            const active = row(level, 'active', 0), unrelated = row(level, 'unrelated', 1, 'OTHER');
            const { result } = await runCheck({ level, reply: () => response(2, activeFirst ? [active, unrelated] : [unrelated, active]) });
            assertUncertain(result);
        });
    }

    test(`${level.name}：查询某货号却返回载荷中的另一个货号，仍属于过滤失效`, async () => {
        const { result } = await runCheck({ level, codes: ['FIRST', 'SECOND'],
            reply: () => response(1, [row(level, 'wrong-code', 0, 'SECOND')]) });
        assertUncertain(result);
    });

    test(`${level.name}：货号只出现在另一层级不能交叉认作 exists 或 not_found`, async () => {
        const otherLevel = levels.find(item => item !== level);
        const { result } = await runCheck({ level, reply: () => response(1, [row(otherLevel, 'cross-level', 0)]) });
        assertUncertain(result);
    });

    test(`${level.name}：第二页过滤失效，即使出现另一层同名货号仍为 uncertain`, async () => {
        const otherLevel = levels.find(item => item !== level);
        const { result } = await runCheck({ level, reply: ({ body }) => response(101,
            body.page === 1 ? deletedRows(level) : [row(otherLevel, 'cross-level', 0)]) });
        assertUncertain(result);
    });

    for (const [label, value] of [['响应 true', true], ['缺 pageItems', { result: { total: 0 } }],
        ['非数组 pageItems', { result: { total: 0, pageItems: {} } }], ['失败信封', { success: false, errorCode: 403, errorMsg: '失败' }]]) {
        test(`${level.name}：${label}不满足查询协议，返回 uncertain`, async () => {
            const { result } = await runCheck({ level, reply: () => value });
            assertUncertain(result);
        });
    }

    // 失败响应附带旧列表并不代表查询成功，不能借有效 total 或有效货号绕过失败语义。
    for (const hasHit of [true, false]) {
        test(`${level.name}：失败信封携带${hasHit ? '有效命中' : '零命中'}结果，仍为 uncertain`, async () => {
            const { result } = await runCheck({ level, reply: () => ({ success: false, errorCode: 403,
                ...response(hasHit ? 1 : 0, hasHit ? [row(level, 'active', 0)] : []) }) });
            assertUncertain(result);
        });
    }

    test(`${level.name}：total 为零却返回非空列表，返回 uncertain`, async () => {
        const { result } = await runCheck({ level, reply: () => response(0, [row(level, 'unexpected', 0)]) });
        assertUncertain(result);
    });

    test(`${level.name}：行数超过 total，不能按全部删除放行`, async () => {
        const { result } = await runCheck({ level, reply: () => response(1, [row(level, 'first'), row(level, 'second')]) });
        assertUncertain(result);
    });
}

for (const clientMode of ['boolean', 'ambiguous']) {
    test(`客户端${clientMode === 'boolean' ? '导出 true 而非客户端实例' : '特征命中多个模块'}时为 uncertain，不能访问接口`, async () => {
        const { result, calls } = await runCheck({ clientMode });
        assertUncertain(result);
        assert.equal(calls.length, 0);
    });
}

test('没有任何货号时保持 no_code 且零请求，不能退化为整店检索', async () => {
    const { result, calls } = await runCheck({ codes: [] });
    assert.equal(result.state, 'not_found');
    assert.equal(result.queryMode, 'no_code');
    assert.equal(calls.length, 0);
});
