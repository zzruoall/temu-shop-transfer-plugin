/**
 * 目标店判重回归：直接执行插件注入到目标店页面的重复检索函数。
 *
 * 锁住两条互相牵制的规则：
 *   1. 判重必须真的能发现重复（精确结果分页完整、两级货号不交叉匹配）；
 *   2. 判重失败必须等待重查，不能把未查清当成不存在；也不能封禁来源商品。
 * 全程使用假页面与假接口，不访问 Temu，也不产生任何创建请求。
 *
 * 两级货号语义（用例必须按此构造，否则测的不是真实行为）：
 *   - 来源有商品货号 → 只比目标店"行级"货号（row.extCode / row.skcExtCode）；
 *   - 来源只有 SKU 货号 → 只比目标店 SKU 级货号（productSkuSummaries[].extCode）；
 *   两级交叉比对会把两件无关商品判成重复，因此实现上刻意隔离。
 */
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { directExecutorFixture, seedExecutionRounds } from './direct-platform-fixture.mjs';
import { transferManifest } from '../lib/transfer-integrity.mjs';
const source = await directExecutorFixture();

/** 主循环测试需要直接执行源码，这里显式加载一次并复用同一份文本。 */
async function loadExecutor() {
    return { runDirectTasks: 'runDirectTasks', source };
}

/** 单店单轮夹具使用会话存储；本用例不模拟持久队列或并发写入，正文保真仍执行真实校验。 */
async function seedCurrentExecutor(context, data) {
    context.TextEncoder = TextEncoder;
    context.chrome.storage.session = context.chrome.storage.local;
    context.withTargetTaskMutation = async action => action();
    context.pruneDirectAttempts = async () => {};
    context.setTargetSessionValues = async values => Object.assign(data, structuredClone(values));
    context.saveTargetUploadTasks = async (_tasks, values = {}) => Object.assign(data, structuredClone(values));
    const tasks = context.getTargetUploadTasks;
    context.getTargetUploadTasks = async () => (await tasks()).map(task => ({ ...task, transferIntegrity: transferManifest(task.snapshot) }));
    await seedExecutionRounds(context);
}

/** 构造一次注入执行环境：pageRows 决定分页返回，options 控制异常与分页字段行为。 */
async function runCheck({ pageRows, productCodes = [], skuCodes = [], acceptKey = 'page', ignorePaging = false, failOnPage = 0, ambiguousClient = false, looseFilter = false }) {
    const calls = [];
    const allRows = () => [...new Set(pageRows.flat().map(item => JSON.stringify(item)))].map(text => JSON.parse(text));
    const client = {
        mallIdClient: { getMallIdAsync: async () => '123' },
        post: async (path, body) => {
            calls.push({ path, body });
            // 只接受真实页面的精确字段；禁止测试替旧 extCodes 或无过滤请求伪造成功。
            const filterField = ['skcExtCodes', 'skuExtCodes'].find(field => Array.isArray(body[field]));
            assert.ok(filterField, '每页必须携带精确货号过滤');
            const wanted = new Set(body[filterField]);
            const filtered = allRows().filter(item => {
                const rowCodes = [item.extCode, item.skcExtCode].filter(Boolean);
                const skuCodesOfRow = (item.productSkuSummaries || []).flatMap(sku => [sku.extCode, sku.skuExtCode].filter(Boolean));
                const pool = looseFilter ? [...rowCodes, ...skuCodesOfRow] : filterField === 'skcExtCodes' ? rowCodes : skuCodesOfRow;
                return pool.some(code => wanted.has(code));
            });
            if (acceptKey !== 'page') throw Error('unsupported_page_field');
            const page = Number(body.page);
            if (failOnPage && page === failOnPage) throw Error('分页请求失败');
            const index = ignorePaging ? 1 : page;
            return { result: { total: filtered.length, pageItems: filtered.slice(index - 1, index) } };
        }
    };
    const runtime = () => client;
    runtime.m = ambiguousClient
        ? { a: 'getMallIdAsync x .postWithoutMallId= x .mallIdClient=', b: 'getMallIdAsync y .postWithoutMallId= y .mallIdClient=' }
        : { only: 'getMallIdAsync .postWithoutMallId= .mallIdClient=' };
    const context = vm.createContext({
        console, crypto, Set, String, Number, Object, Array, JSON, Error, Promise, setTimeout, clearTimeout,
        location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list' },
        window: {
            // webpack 的 chunkLoadingGlobal 只接收一个数组参数：[chunkIds, modules, runtimeCallback]。
            chunkLoadingGlobal_temu_sca_goods: { push: (entry) => entry[2](runtime) }
        },
        chrome: { scripting: { executeScript: async (spec) => [{ result: await spec.func(...spec.args) }] } }
    });
    vm.runInContext(source, context);
    context.__payload = { mallId: '123', productCodes, skuCodes };
    let result = null;
    let failure = '';
    try {
        // force 走真实检索路径，确保被测的始终是正式判重逻辑。
        result = await vm.runInContext('directDuplicateCheck(7, __payload, { force: true })', context);
    } catch (error) {
        failure = String(error?.message || error);
    }
    return { result, failure, calls };
}

/** 目标店商品行：货号放在"行级"（对应商品/SKC 货号）。 */
const rowWithProductCode = (id, name, code) => ({ productId: id, productName: name, extCode: code, removeStatus: 0 });
/** 目标店商品行：货号挂在 SKU 明细上（对应 SKU 货号）。 */
const row = (id, name, codes) => ({ productId: id, productName: name, removeStatus: 0, productSkuSummaries: codes.map(code => ({ productSkuId: `sku-${code}`, extCode: code })) });

// 一、商品货号命中：来源带商品货号时，按目标店行级货号比对。
{
    const { result } = await runCheck({ productCodes: ['UAD05*2'], pageRows: [[rowWithProductCode('1', '别的商品', 'X')], [rowWithProductCode('9', '新商品', 'UAD05*2')], []] });
    assert.equal(result.state, 'exists', '商品货号命中必须判为已存在');
    assert.equal(result.productId, '9');
    assert.equal(result.matchedBy, 'productExtCode', '必须标明是按商品货号命中的');
}

// 二、SKU 货号命中：只有 SKU 货号时也要能发现重复。
{
    const { result } = await runCheck({ skuCodes: ['U5EQ5'], pageRows: [[row('1', '别的商品', ['X'])], [row('7', '同款', ['U5EQ5'])], []] });
    assert.equal(result.state, 'exists', 'SKU 货号命中必须判为已存在');
    assert.equal(result.matchedBy, 'skuExtCode', '必须标明是按 SKU 货号命中的');
}

// 三、两级货号不能交叉匹配：来源是 SKU 货号时，不得命中目标店其他商品的行级货号。
// 交叉匹配会把两件无关的商品判成重复，然后拦掉一次正常上传。
// 用 looseFilter 让平台把该行返回回来，被测的是插件自己的层级隔离规则。
{
    const { result } = await runCheck({ skuCodes: ['U5EQ5'], looseFilter: true, pageRows: [[rowWithProductCode('3', '无关商品', 'U5EQ5')], []] });
    assert.equal(result.state, 'uncertain', '平台跨层宽松过滤不能证明不存在，也不能误判重复');
}

// 四、精确查询 total=0 立即确认不存在，不扫描其他货号。
{
    const { result, calls } = await runCheck({ productCodes: ['UAD05*2'], pageRows: [[rowWithProductCode('1', 'A', 'X')], []] });
    assert.equal(result.state, 'not_found');
    assert.equal(result.scanned, 0);
    assert.equal(calls.length, 1, '精确查询明确零结果仅需一次请求');
}

// 五、精确查询不存在时，无关商品数量不影响请求次数。
{
    const { result } = await runCheck({ productCodes: ['UAD05*2'], pageRows: [[rowWithProductCode('1', 'A', 'X'), rowWithProductCode('2', 'B', 'Y')], [rowWithProductCode('3', 'C', 'Z')], []] });
    assert.equal(result.state, 'not_found');
    assert.equal(result.scanned, 0);
    assert.equal(result.pages, 1);
}

// 六、无任何货号：没有比对主键，只能按"未发现重复"继续，且不得拿名称去猜同款。
{
    const { result, calls } = await runCheck({ pageRows: [[row('1', '任意商品', ['X'])], []] });
    assert.equal(result.state, 'not_found', '无货号不能阻断上传');
    assert.equal(result.queryMode, 'no_code', '必须如实标记为无货号可比对');
    assert.equal(calls.length, 0, '无货号时不应发起检索，也不允许用名称猜同款');
}

// 七、分页不能完成时返回 uncertain；调用方等待重查，不把未确认当作允许新增。
{
    const { result, failure } = await runCheck({ productCodes: ['UAD05*2'], ignorePaging: true, pageRows: [[{ ...rowWithProductCode('1', 'A', 'UAD05*2'), removeStatus: 1 }], [{ ...rowWithProductCode('2', 'B', 'UAD05*2'), removeStatus: 1 }]] });
    assert.equal(failure, '', '判重未确认时不能抛异常中断上传流程');
    assert.equal(result.state, 'uncertain', '分页重复必须如实返回未确认');
    assert.match(result.reason, /分页重复/);
}

// 八、分页请求持续失败返回未确认，不能伪装成已不存在或商品资料错误。
{
    const { result, failure } = await runCheck({ productCodes: ['UAD05*2'], failOnPage: 2, pageRows: [[{ ...rowWithProductCode('1', 'A', 'UAD05*2'), removeStatus: 1 }], [{ ...rowWithProductCode('2', 'B', 'UAD05*2'), removeStatus: 1 }]] });
    assert.equal(failure, '', '检索失败须返回 uncertain，交由调用方等待核对');
    assert.equal(result.state, 'uncertain', '检索失败必须如实返回未确认');
    assert.match(result.reason, /检索失败|无法确认/);
}

// 九、客户端不兼容属于环境问题；等待核对，不全局标记商品。
{
    const { result, failure } = await runCheck({ productCodes: ['UAD05*2'], ambiguousClient: true, pageRows: [[]] });
    assert.equal(failure, '', '平台客户端不兼容属于环境问题，不能中断上传流程');
    assert.equal(result.state, 'uncertain', '环境问题必须按未确认处理');
}

// 十、采用已验证的 page 字段；不兼容时拒绝猜测新字段或扫描整店。
for (const acceptKey of ['page', 'pageNum', 'pageNumber']) {
    const { result, calls } = await runCheck({ acceptKey, productCodes: ['UAD05*2'], pageRows: [[rowWithProductCode('1', 'A', 'X')], [rowWithProductCode('2', 'B', 'UAD05*2')], []] });
    assert.equal(result.state, acceptKey === 'page' ? 'exists' : 'uncertain');
    if (acceptKey === 'page') assert.equal(result.productId, '2');
    assert.ok(calls.every(call => call.path.endsWith('/product/skc/pageQuery')), '只在商品检索接口上分页');
}

// 十一、SKU 精确查询零结果也不再扫描其他商品。
{
    const { result } = await runCheck({ skuCodes: ['U5EQ5'], pageRows: [[row('1', 'A', ['X'])], []] });
    assert.equal(result.state, 'not_found');
    assert.equal(result.pages, 1, 'SKU 精确零结果只查询一次');
}

// 十二、类数组货号载荷（页面运行时回传的形态）必须能被读出，不能读成空集合。
// 只认 Array.isArray 会让货号判重整体失效，商品被重复创建。
{
    const arrayLike = { length: 1, 0: 'UAD05*2' };
    arrayLike[Symbol.iterator] = Array.prototype[Symbol.iterator];
    const { result } = await runCheck({ productCodes: arrayLike, pageRows: [[rowWithProductCode('9', '同款', 'UAD05*2')], []] });
    assert.equal(result.state, 'exists', '类数组货号载荷必须能参与判重，不能被读成空集合');
}

console.log('重复检索检查通过：精确货号过滤、不扫描整店、未确认显式返回、类数组载荷可读');

/**
 * 每次上传都要在目标店查一次：首次执行与同文档后台回收后继续都不能跳过判重。
 * 此处只模拟当前轮次内尚未授权的 authorizing 记录，刷新后的旧轮不得继续。
 * 这里同时锁住"一定要查"和"只查一次"：查是为防重复，只查一次是为不拖慢批量上传。
 */
{
    const { runDirectTasks } = await loadExecutor();

    /** 跑一轮插件主循环，返回这次实际发生了多少次目标店检索、多少次提交。 */
    async function runPass({ record, duplicateResult, taskSnapshot, secondPrepared = false, secondCode = null, failFirstPreserve = false }) {
        const data = record ? { [`directAttempt:job:9100894431`]: record } : {};
        if (secondPrepared) {
            data['directAttempt:job:9100894432'] = structuredClone(record);
            if (secondCode) data['directAttempt:job:9100894432'].request.productSkcReqs[0].extCode = secondCode;
        }
        let searches = 0, submits = 0, preserves = 0;
        const context = vm.createContext({
            console, crypto: globalThis.crypto, Set, Map, Promise, setTimeout, clearTimeout, Date,
            chrome: {
                runtime: { getManifest: () => ({ version: '10.10.49' }) },
                storage: { local: {
                    get: async key => ({ [key]: data[key] }),
                    set: async value => Object.assign(data, structuredClone(value)),
                    remove: async key => { delete data[key]; } } },
                scripting: { executeScript: async spec => {
                    if (spec.files) return [];
                    const [operation, payload] = spec.args;
                    // 判重注入的载荷带 mallId；用它区分判重与其它页面操作。
                    if (operation && typeof operation === 'object' && operation.mallId !== undefined) {
                        searches += 1;
                        return [{ result: typeof duplicateResult === 'function' ? duplicateResult(operation) : duplicateResult }];
                    }
                    if (operation === 'prepare') return [{ result: { request: { productName: 't' }, hash: 'a'.repeat(64) } }];
                    if (operation === 'identity') return [{ result: { mallId: '123' } }];
                    if (operation === 'preserve') {
                        // 页面只读阶段允许一次重试，因此首件的两次尝试都失败才能证明占位确实释放。
                        if (failFirstPreserve && preserves++ < 2) throw Error('夹具模拟提交前来源保真失败');
                        return [{ result: { preserved: true } }];
                    }
                    if (operation === 'submit') { submits += 1; return [{ result: { started: true } }]; }
                    if (operation === 'submit-status') return [{ result: { state: 'created', productId: '8000000001' } }];
                    if (operation === 'verify') return [{ result: { verified: true } }];
                    return [{}];
                } }
            },
            getTargetUploadTasks: async () => (secondPrepared ? ['9100894431', '9100894432'] : ['9100894431']).map(spuId => ({
                jobId: 'job', spuId, targetStoreId: 'temu:123', claimToken: 't',
                directCreate: true, directState: '', directRetrySequence: 0,
                snapshot: { ...taskSnapshot, publicationData: { ...taskSnapshot.publicationData,
                    sourceProduct: { ...taskSnapshot.publicationData.sourceProduct, productId: spuId } } }
            })),
            getPluginInstanceId: async () => 'instance',
            TemuOperationLog: { append: async () => {} },
            hubJson: async () => ({ attemptId: 'att', resumed: false }),
            TemuDirectReceipts: { send: async () => ({ acknowledged: true }) }
        });
        await seedCurrentExecutor(context, data);
        vm.runInContext(`${await readFile(new URL('../../plugin/qualification-executor.js', import.meta.url), 'utf8')}\n${source}`, context);
        // 此夹具只验证创建与资质的路由分工；材料提交由独立资质执行器测试覆盖。
        context.runDirectQualifications = async () => ({ state: 'complete', items: [], reason: '夹具适用资质已提交' });
        await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])", context);
        return { searches, submits, data, context };
    }

    const snapshot = { publicationData: { sourceProduct: { productId: '9100894431' } } };

    // 无法完成判重时不得提交平台，由本地等待记录保留重查机会。
    {
        const pass = await runPass({ record: null, duplicateResult: { state: 'uncertain', reason: '分页不可用' }, taskSnapshot: snapshot });
        assert.equal(pass.submits, 0);
        assert.equal(pass.data['directAttempt:job:9100894431'].stage, 'duplicate_wait', JSON.stringify(pass.data['directAttempt:job:9100894431']));
    }

    // 一、正常路径（全新任务）：必须查目标店，查完再提交。
    {
        const pass = await runPass({ record: null, duplicateResult: { state: 'not_found', scanned: 0, pages: 0, queryMode: 'skuExtCodes' }, taskSnapshot: snapshot });
        assert.ok(pass.searches >= 1, '每次上传都要先查目标店');
        assert.equal(pass.submits, 1, '确认不存在时应当提交');
    }

    // 二、同文档后台回收：本地已有当前轮次的准备记录，仍必须再查一次目标店。
    {
        const record = { stage: 'authorizing', request: { productSkcReqs: [{ extCode: 'UAD05*2', productSkuReqs: [{ extCode: 'UAD05*2' }] }] }, hash: 'a'.repeat(64), authorizationKey: 'k', mallId: '123', retrySequence: 0 };
        const hit = await runPass({ record, duplicateResult: { state: 'exists', productId: '5886465868', matchedBy: 'productExtCode' }, taskSnapshot: snapshot });
        assert.ok(hit.searches >= 1, '同轮准备记录也必须查目标店，不能凭本地记录直接提交');
        assert.equal(hit.submits, 0, '目标店已有该商品时必须跳过，绝不能提交');
        assert.equal(hit.data['directAttempt:job:9100894431'].stage, 'duplicate_exists', '商品已存在只跳过，不自动进入资质');
        assert.equal(hit.data['directAttempt:job:9100894431'].done, true);

        const miss = await runPass({ record, duplicateResult: { state: 'not_found', scanned: 0, pages: 0, queryMode: 'skuExtCodes' }, taskSnapshot: snapshot });
        assert.ok(miss.searches >= 1, '同轮准备记录必须复查');
        assert.equal(miss.submits, 1, '复查确认不存在时必须照常提交，不能被复查挡住');
    }

    // 三、正常路径不能重复查货号：一次上传只查一次，否则批量上传会被拖慢一倍。
    {
        const pass = await runPass({ record: null, duplicateResult: { state: 'not_found', scanned: 0, pages: 0, queryMode: 'skuExtCodes' }, taskSnapshot: snapshot });
        assert.equal(pass.searches, 1, '一遍上传只查一次目标店（刚查过就不在提交前重复查）');
    }

    // 同轮两个已准备请求仍只创建一次；即使列表同步或缓存写入尚未反映新商品，也不重建第二件。
    {
        const record = { stage: 'authorizing', request: { productSkcReqs: [{ extCode: 'SAME' }] },
            hash: 'a'.repeat(64), authorizationKey: 'k', mallId: '123', retrySequence: 0 };
        const pass = await runPass({ record, secondPrepared: true, duplicateResult: { state: 'not_found' }, taskSnapshot: snapshot });
        assert.equal(pass.submits, 1, '两个已准备的同货号任务只允许一次新增');
        assert.equal(pass.data['directAttempt:job:9100894432'].stage, 'duplicate_exists');
    }

    // 本件货号重复只跳过新增；下一件不同货号仍创建，不能升级成整店停机。
    {
        const record = { stage: 'authorizing', request: { productSkcReqs: [{ extCode: 'SAME' }] },
            hash: 'a'.repeat(64), authorizationKey: 'k', mallId: '123', retrySequence: 0 };
        const pass = await runPass({ record, secondPrepared: true, secondCode: 'OTHER', taskSnapshot: snapshot,
            duplicateResult: payload => payload.productCodes.includes('SAME')
                ? { state: 'exists', productId: '5886465868', matchedBy: 'productExtCode' } : { state: 'not_found' } });
        assert.equal(pass.data['directAttempt:job:9100894431'].stage, 'duplicate_exists');
        assert.equal(pass.data['directAttempt:job:9100894432'].stage, 'created');
        assert.equal(pass.submits, 1, '跳过重复货号后仍应处理下一件');
    }

    // 首件确定未提交的保真失败应释放自己的货号，下一件合法的同货号请求仍可创建。
    {
        const record = { stage: 'authorizing', request: { productSkcReqs: [{ extCode: 'SAME' }] },
            hash: 'a'.repeat(64), authorizationKey: 'k', mallId: '123', retrySequence: 0 };
        const pass = await runPass({ record, secondPrepared: true, failFirstPreserve: true,
            duplicateResult: { state: 'not_found' }, taskSnapshot: snapshot });
        assert.equal(pass.data['directAttempt:job:9100894431'].stage, 'preflight_failed');
        assert.equal(pass.data['directAttempt:job:9100894432'].stage, 'created');
        assert.equal(pass.submits, 1, '确定提交前失败不得误拦后续合法同货号任务');
    }

    // 四、目标店按 SKU 货号命中也算重复：货号与 SKU 货号任一重复都要跳过。
    {
        const record = { stage: 'authorizing', request: { productSkcReqs: [{ productSkuReqs: [{ extCode: 'U5EQ5' }] }] }, hash: 'a'.repeat(64), authorizationKey: 'k', mallId: '123', retrySequence: 0 };
        const hit = await runPass({ record, duplicateResult: { state: 'exists', productId: '5886465868', matchedBy: 'skuExtCode' }, taskSnapshot: snapshot });
        assert.equal(hit.submits, 0, 'SKU 货号重复同样要跳过');
        assert.equal(hit.data['directAttempt:job:9100894431'].stage, 'duplicate_exists');
    }

    // 五、复查用的是"准备提交的那批货号"，不是最新快照的货号：
    // 两者可能不同（商品重新采集后货号变了），用错会拿一批与待提交请求无关的货号去查。
    {
        const record = { stage: 'authorizing', request: { productSkcReqs: [{ extCode: 'OLDCODE', productSkuReqs: [{ extCode: 'OLDCODE' }] }] }, hash: 'a'.repeat(64), authorizationKey: 'k', mallId: '123', retrySequence: 0 };
        const data = { 'directAttempt:job:9100894431': record };
        let seenCodes = null;
        const context = vm.createContext({
            console, crypto: globalThis.crypto, Set, Map, Promise, setTimeout, clearTimeout, Date,
            chrome: {
                runtime: { getManifest: () => ({ version: '10.10.49' }) },
                storage: { local: { get: async key => ({ [key]: data[key] }),
                    set: async value => Object.assign(data, structuredClone(value)), remove: async key => { delete data[key]; } } },
                scripting: { executeScript: async spec => {
                    if (spec.files) return [];
                    const [operation] = spec.args;
                    if (operation && typeof operation === 'object' && operation.mallId !== undefined) {
                        seenCodes = operation.productCodes;
                        return [{ result: { state: 'not_found', scanned: 0, pages: 0 } }];
                    }
                    if (operation === 'prepare') return [{ result: { request: {}, hash: 'a'.repeat(64) } }];
                    if (operation === 'identity') return [{ result: { mallId: '123' } }];
                    if (operation === 'preserve') return [{ result: { preserved: true } }];
                    if (operation === 'submit') return [{ result: { started: true } }];
                    if (operation === 'submit-status') return [{ result: { state: 'created', productId: '8000000001' } }];
                    if (operation === 'verify') return [{ result: { verified: true } }];
                    return [{}];
                } }
            },
            getTargetUploadTasks: async () => [{
                jobId: 'job', spuId: '9100894431', targetStoreId: 'temu:123', claimToken: 't',
                directCreate: true, directState: '', directRetrySequence: 0,
                // 最新快照的货号已变（重新采集过），复查不该用它
                snapshot: { publicationData: { sourceProduct: { productId: '9100894431', productSkcList: [{ extCode: 'NEWCODE', productSkuList: [{ extCode: 'NEWCODE' }] }] } } }
            }],
            getPluginInstanceId: async () => 'instance',
            TemuOperationLog: { append: async () => {} },
            hubJson: async () => ({ attemptId: 'att', resumed: false }),
            TemuDirectReceipts: { send: async () => ({ acknowledged: true }) }
        });
        await seedCurrentExecutor(context, data);
        vm.runInContext(source, context);
        await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])", context);
        // 跨 vm 上下文的数组原型与本上下文不同，deepEqual 会比原型而误报，这里比对内容本身。
        assert.equal(JSON.stringify(seenCodes), JSON.stringify(['OLDCODE']), '复查必须用待提交请求里的货号，不能用最新快照的货号');
    }
}

console.log('每次上传都判重通过：首次执行与同文档同轮次继续都查、只查一次、货号或 SKU 货号重复即跳过');
