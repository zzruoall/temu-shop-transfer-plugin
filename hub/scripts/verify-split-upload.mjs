/** 两类真实插件执行入口的隔离回归，平台和浏览器只用内存夹具，禁止真实提交。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fixture } from './verify-plugin-relay.mjs';
import { transferManifest } from '../lib/transfer-integrity.mjs';

/** 使用完整后台接收、轮次、会话锁及真实执行循环，只替换外部平台读写。 */
async function scenario(types) {
    const f = await fixture();
    for (const [index, actionType] of types.entries()) await f.receive([String(1000000000 + index)], f.identity, 'split-job', '', actionType);
    await withSourceCodes(f);
    f.context.acquirePlatformForDirect = async () => true;
    const calls = [];
    f.context.directDuplicateCheck = async (_tab, payload) => {
        calls.push({ operation: 'match', payload });
        return { state: 'exists', productId: '9876543210', matchedBy: 'productExtCode' };
    };
    f.context.directPage = async (_tab, operation) => { calls.push({ operation }); return {}; };
    f.context.qualificationPage = async (_tab, operation) => { calls.push({ operation }); return { status: 'complete', items: [] }; };
    f.context.runDirectQualifications = async task => {
        calls.push({ operation: 'qualifications', spuId: task.spuId });
        return { state: 'complete', items: [], reason: '适用资质已补全' };
    };
    return { ...f, platform: calls };
}

/** 匹配入口必须使用带货号的完整来源快照，不能用无货号夹具绕过实际查询。 */
async function withSourceCodes(f) {
    f.context.codedTasks = f.tasks().map(task => {
        const snapshot = { publicationData: { sourceProduct: { productId: task.spuId,
            productSkcList: [{ extCode: 'P', productSkuList: [{ extCode: 'S' }] }] } }, qualifications: { status: 'complete', items: [] } };
        return { ...task, snapshot, transferIntegrity: transferManifest(snapshot) };
    });
    await f.run('saveTargetUploadTasks(codedTasks)');
}

test('同一投递同一商品的两种任务分开入队、尝试和摘要，未知类型不能落盘', async () => {
    const f = await scenario(['product_create']);
    await f.receive(['1000000000'], f.identity, 'split-job', '', 'qualification_upload');
    assert.equal(f.tasks().length, 2);
    f.context.pair = f.tasks();
    assert.notEqual(f.run('directTaskKey(pair[0])'), f.run('directTaskKey(pair[1])'));
    await f.run('rememberDirectProgress(pair[1],{directState:"qualification_not_found",reason:"没有匹配到内容"},1)');
    assert.equal(f.tasks()[0].directState, undefined);
    assert.equal(f.tasks()[1].directState, 'qualification_not_found');
    const view = await f.run('targetUploadTaskView(sender,identity.storeId)');
    assert.deepEqual(view.tasks.map(task => task.actionType), ['product_create', 'qualification_upload']);
    await assert.rejects(f.receive(['1000000001'], f.identity, 'bad-job', '', 'arbitrary_write'), /任务类型/);
    assert.equal(f.tasks().length, 2);
});

test('商品重复只跳过，不读取或写入资质；无资质资料不能阻止商品任务结束', async () => {
    const f = await scenario(['product_create']);
    await f.run('runDirectTasks(1,identity)');
    assert.equal(f.tasks()[0].directState, 'duplicate_exists');
    assert.deepEqual(f.platform.map(call => call.operation), ['match']);
});

test('资质未匹配跳过后处理下一件，不创建商品、不申请许可、不回传成功', async () => {
    const f = await scenario(['qualification_upload', 'qualification_upload']);
    const original = f.tasks().map(task => ({ ...task, snapshot: { publicationData: { sourceProduct: {
        productId: task.spuId, productSkcList: [{ extCode: 'P-' + task.spuId, productSkuList: [{ extCode: 'S-' + task.spuId }] }]
    } }, qualifications: { status: 'complete', items: [] } } }));
    original.forEach(task => { task.transferIntegrity = transferManifest(task.snapshot); });
    f.context.original = original;
    await f.run('saveTargetUploadTasks(original)');
    let count = 0;
    f.context.directDuplicateCheck = async (_tab, payload) => {
        assert.equal(payload.qualificationMatch, true);
        assert.equal(payload.skuCodes.length, 1);
        f.platform.push({ operation: 'match' });
        return count++ ? { state: 'exists', productId: '9876543210' } : { state: 'not_found', reason: '没有匹配到内容：SKU货号不一致' };
    };
    await f.run('runDirectTasks(1,identity)');
    assert.deepEqual(f.tasks().map(task => task.directState), ['qualification_not_found', 'qualification_complete']);
    assert.equal(f.platform.filter(call => call.operation === 'qualifications').length, 1);
    assert.equal(f.platform.filter(call => ['prepare', 'submit', 'preserve'].includes(call.operation)).length, 0);
    assert.equal(f.calls.filter(call => /progress|permit|error-notice/.test(call.url)).length, 0);
    assert.match(f.tasks()[1].reason, /适用资质已补全/);
    assert.doesNotMatch(f.tasks()[1].reason, /平台已返回商品/);
});

/** 执行实际页面注入函数，验证精确匹配不能被商品判重的宽松存在规则替代。 */
async function match(rows, payload, extraRows = []) {
    const f = await fixture();
    const client = { mallIdClient: { getMallIdAsync: async () => '222' }, post: async (_path, body) => {
        if (_path === '/visage-agent-seller/product/query') return { success: true, result: { productId: body.productId,
            productSkcList: [...rows, ...extraRows].filter(row => row.productId === body.productId && row.removeStatus === 0)
                .map(row => ({ extCode: row.extCode, productSkuList: row.productSkuSummaries })) } };
        const code = (body.skcExtCodes || body.skuExtCodes)[0];
        const hits = rows.filter(row => body.skcExtCodes ? row.extCode === code : row.productSkuSummaries.some(sku => sku.extCode === code));
        return { success: true, result: { total: hits.length, pageItems: hits } };
    } };
    const runtime = () => client;
    runtime.m = { only: 'getMallIdAsync .postWithoutMallId= .mallIdClient=' };
    const page = vm.createContext({ crypto: globalThis.crypto, location: { origin: 'https://agentseller.temu.com', pathname: '/goods/list' },
        window: { chunkLoadingGlobal_temu_sca_goods: { push: entry => entry[2](runtime) } } });
    f.context.chrome.scripting.executeScript = async spec => {
        page.args = spec.args;
        return [{ result: await vm.runInContext(`(${spec.func.toString()})(...args)`, page) }];
    };
    f.context.compare = { mallId: '222', productCodes: ['P'], skuCodes: ['S1', 'S2'], qualificationMatch: true, ...payload };
    return f.run('directDuplicateCheck(1,compare,{force:true})');
}
const row = (id = '9876543210', skuCodes = ['S1', 'S2'], removeStatus = 0) => ({ productId: id, productSkcId: 'skc-' + id,
    extCode: 'P', removeStatus, productSkuSummaries: skuCodes.map(extCode => ({ extCode })) });

test('资质匹配核对完整SKU集合、唯一商品和删除状态；商品存在判断不要求唯一', async () => {
    assert.equal((await match([row()])).state, 'exists');
    for (const rows of [[row('9876543210', ['S1'])], [row('9876543210', ['S1', 'S2', 'S3'])],
        [row(), row('9876543211')], [row('9876543210', ['S1', 'S2'], 1)]]) {
        const found = await match(rows);
        assert.equal(found.state, 'not_found'); assert.match(found.reason, /没有匹配到内容/);
    }
    assert.equal((await match([row(), row('9876543211')], { qualificationMatch: false })).state, 'exists');
    assert.equal((await match([row('9876543210', ['S1', 'S2'], null)])).state, 'uncertain');
    const extra = { ...row(), extCode: 'EXTRA-P', productSkuSummaries: [{ extCode: 'EXTRA-S' }] };
    assert.equal((await match([row()], {}, [extra])).state, 'not_found', '未命中货号的其他SKC也必须核对');
});

/** 同一次点击同SPU的多个来源不能互相覆盖尝试或进度。 */
test('来源任务标识同时隔离接收、尝试和面板摘要', async () => {
    const f = await fixture();
    await f.receive(['1000000000'], f.identity, 'source-split');
    f.context.first = { ...f.tasks()[0], transportOnly: true, executionRunId: f.identity.relaySessionId, sourceTaskId: 'a'.repeat(64) };
    f.context.second = { ...f.tasks()[0], transportOnly: true, executionRunId: f.identity.relaySessionId, sourceTaskId: 'b'.repeat(64), sourceStoreId: 'temu:other' };
    await f.run('saveTargetUploadTasks([])');
    await f.run('receiveTargetUploadTasks([first],identity.storeId,identity)');
    await f.run('receiveTargetUploadTasks([second],identity.storeId,identity)');
    assert.equal(f.tasks().length, 2);
    assert.notEqual(f.run('directTaskKey(first)'), f.run('directTaskKey(second)'));
    f.context.second = f.tasks()[1];
    await f.run('rememberDirectProgress(second,{directState:"rejected",reason:"第二来源失败"},1)');
    assert.equal(f.tasks()[0].directState, undefined);
    assert.equal(f.tasks()[1].directState, 'rejected');
});

test('资质任务具体失败原因保存后不会被平台已返回商品的通用提示覆盖', async () => {
    const f = await scenario(['qualification_upload']);
    const task = f.tasks()[0]; f.context.task = task;
    await f.run('writeDirectAttempt(task,directTaskKey(task),{stage:"qualifying",productId:"9876543210",mallId:"222",qualificationItems:[{certType:1421,state:"submitting",attemptId:"cert-a"}]})');
    await f.run('writeDirectAttempt(task,directTaskKey(task),{stage:"qualification_failed",done:true,productId:"9876543210",mallId:"222",businessError:"报告不符合目标模板",qualificationItems:[{certType:1421,state:"failed",attemptId:"cert-a"}]})');
    assert.equal(f.tasks()[0].reason, '报告不符合目标模板');
});

/** 恢复时只能继续原目标；重新匹配到另一商品不得沿用旧资质提交事实。 */
test('暂停恢复重新核验货号和SKU，目标变化时不提交到另一商品', async () => {
    const f = await scenario(['qualification_upload']);
    f.context.directDuplicateCheck = async () => { f.platform.push({ operation: 'match' }); return { state: 'exists', productId: '9876543211' }; };
    f.context.task = f.tasks()[0];
    await f.run('writeDirectAttempt(task,directTaskKey(task),{stage:"qualifying",productId:"9876543210",mallId:"222",qualificationItems:[]})');
    await f.run('runDirectTasks(1,identity)');
    assert.equal(f.platform.filter(call => call.operation === 'match').length, 1);
    assert.equal(f.platform.filter(call => call.operation === 'qualifications').length, 0);
    assert.equal(f.tasks()[0].directState, 'qualification_failed');
    assert.match(f.tasks()[0].reason, /恢复时目标商品已变化/);
});

/** 初次读模板就失去商城身份也要整店停止，后续商品不得被当成材料失败继续。 */
test('资质模板读取遇到登录失效时停止整店，不执行下一件', async () => {
    const f = await fixture();
    f.context.acquirePlatformForDirect = async () => true;
    f.context.directDuplicateCheck = async () => ({ state: 'exists', productId: '9876543210' });
    let reads = 0;
    f.context.qualificationPage = async () => { reads++; throw Error('登录已失效'); };
    await f.receive(['1000000000', '1000000001'], f.identity, 'login-stop', '', 'qualification_upload');
    await withSourceCodes(f);
    // 此用例必须有实际填写的来源材料，空列表按协议正常跳过，不会触发目标模板查询。
    f.context.loginTasks = f.tasks().map(task => {
        const snapshot = { ...task.snapshot, qualifications: { status: 'complete', items: [
            { certType: 1421, status: 'complete', content: { certType: 1421, authCode: 'FIXTURE' } }
        ] } };
        return { ...task, snapshot, transferIntegrity: transferManifest(snapshot) };
    });
    await f.run('saveTargetUploadTasks(loginTasks)');
    await f.run('runDirectTasks(1,identity)');
    assert.equal(reads, 1);
    assert.equal(f.tasks()[1].directState, undefined);
});
