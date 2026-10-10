/** 执行真实插件函数，浏览器存储与平台接口用隔离模拟器替代；禁止真实店铺创建。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transferManifest } from '../lib/transfer-integrity.mjs';

export async function fixture({ notices = false } = {}) {
    const session = {}, local = {}, calls = [], logs = [];
    const area = data => ({ get: async key => key === null ? structuredClone(data) :
        Object.fromEntries((Array.isArray(key) ? key : [key]).map(id => [id, structuredClone(data[id])])),
        set: async values => Object.assign(data, structuredClone(values)),
        remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; } });
    const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, console,
        setTimeout, clearTimeout, queueMicrotask, URL, Date, Promise,
        chrome: { storage: { session: area(session), local: area(local) },
            runtime: { getManifest: () => ({ version: '10.10.69' }) },
            scripting: { executeScript: async ({ target }) => [{ documentId: target.documentIds?.[0] || 'doc-1', result: {} }] },
            tabs: { sendMessage: async () => {} } },
        TemuOperationLog: { append: async value => { logs.push(value); } },
        getUtf8ByteLength: text => Buffer.byteLength(text) });
    const bg = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
    const executor = await readFile(new URL('../../plugin/direct-executor.js', import.meta.url), 'utf8');
    const round = await readFile(new URL('../../plugin/execution-round.js', import.meta.url), 'utf8');
    const integrity = await readFile(new URL('../../plugin/transfer-integrity.js', import.meta.url), 'utf8');
    const qualification = await readFile(new URL('../../plugin/qualification-executor.js', import.meta.url), 'utf8');
    const privateQueue = bg.slice(bg.indexOf('const BOUND_STORE_KEY'), bg.indexOf('function hubApiUrl'));
    const reception = bg.slice(bg.indexOf('let directPauseControlQueue'), bg.indexOf('chrome.runtime.onMessage.addListener'));
    const identityHelpers = bg.slice(bg.indexOf('async function getPluginInstanceId'), bg.indexOf('let directPauseControlQueue'));
    vm.runInContext(integrity + '\n' + executor + '\n' + qualification + '\n' + round + '\n' + privateQueue + '\n' + identityHelpers + '\n' + reception, context);
    if (notices) vm.runInContext(await readFile(new URL('../../plugin/error-notice.js', import.meta.url), 'utf8'), context);
    context.sender = { tab: { id: 1, url: 'https://agentseller.temu.com/goods/list' }, documentId: 'doc-1' };
    context.base = { storeId: 'temu:222', mallId: '222', identityMatched: true, pageStoreName: '验证店', executionMode: 'plugin-api' };
    context.hubJson = async (url, body) => { calls.push({ url, body }); return url === '/api/jobs/claim' ? { claimed: [] } : { agent: body }; };
    context.postProductErrorNotice = async body => { calls.push({ url: '/api/products/error-notice', body }); return { status: 'marked' }; };
    vm.runInContext('directIdentity = (sender, identity, locked=false) => bindExecutionIdentity(sender, {...base,...identity}, locked)', context);
    const identity = await vm.runInContext('bindExecutionIdentity(sender, base)', context);
    context.identity = identity;
    const receive = async (ids, id = identity, jobId = globalThis.crypto.randomUUID(), failureGrant = '', actionType = 'product_create') => {
        context.incoming = ids.map(spuId => { const snapshot = { publicationData: { sourceProduct: { productId: spuId } } };
            return { jobId, spuId, snapshot, transferIntegrity: transferManifest(snapshot), directCreate: true, actionType, failureGrant,
                transportOnly: true, executionRunId: id.relaySessionId, targetStoreId: id.storeId, sourceStoreId: 'temu:111' }; });
        context.receiveIdentity = id;
        return vm.runInContext('receiveTargetUploadTasks(incoming, receiveIdentity.storeId, receiveIdentity)', context);
    };
    return { context, session, local, calls, logs, identity, receive,
        run: code => vm.runInContext(code, context), tasks: () => session.targetUploadTasksV1 || [] };
}

/** 真实背景数据流必须携带错误凭证，但面板和诊断不能得到签名授权。 */
test('实际接收保存错误授权，仅真实错误异步通知且摘要不暴露授权', async () => {
    const f = await fixture({ notices: true });
    await f.receive(['1234567890']);
    f.context.incoming[0].noticeToken = 'signed-v2-authorization';
    // 使用新的投递批次避免只测试旧任务对象原地赋值。
    f.context.incoming[0].jobId = 'notice-batch';
    await f.run('receiveTargetUploadTasks(incoming,identity.storeId,identity)');
    await f.run('updateDirectTaskProgress(identity.storeId,"notice-batch","1234567890",{directState:"created",reason:"创建成功"},identity)');
    assert.equal(f.calls.filter(call => call.url === '/api/products/error-notice').length, 0);
    await f.run('updateDirectTaskProgress(identity.storeId,"notice-batch","1234567890",{directState:"rejected",reason:"具体字段错误",errorCode:"PRODUCT_FIELD_INVALID",errorStage:"提交"},identity)');
    for (let i = 0; i < 30 && f.tasks().find(task => task.jobId === 'notice-batch')?.errorNoticeStatus !== 'marked'; i++) await new Promise(resolve => setTimeout(resolve, 1));
    const calls = f.calls.filter(call => call.url === '/api/products/error-notice');
    assert.equal(calls.length, 1); assert.equal(calls[0].body.reason, '具体字段错误');
    assert.equal(calls[0].body.noticeToken, 'signed-v2-authorization');
    await f.run('updateDirectTaskProgress(identity.storeId,"notice-batch","1234567890",{directState:"rejected"},identity)');
    await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(f.calls.filter(call => call.url === '/api/products/error-notice').length, 1);
    const view = await f.run('targetUploadTaskView(sender,identity.storeId)');
    assert.equal(Object.hasOwn(view.tasks.find(task => task.jobId === 'notice-batch'), 'noticeToken'), false);
});

/** 相同错误在人工重试中再次出现时，旧请求不能把通知状态写回新一轮。 */
test('人工重试隔离迟到通知，具体 SKU 与原因截断事实沿真实摘要传递', async () => {
    const f = await fixture({ notices: true });
    await f.receive(['1'], f.identity, 'retry-notice');
    f.context.incoming[0].noticeToken = 'notice-authorization';
    f.context.incoming[0].jobId = 'retry-authorized';
    await f.run('receiveTargetUploadTasks(incoming,identity.storeId,identity)');
    const completions = [];
    f.context.postProductErrorNotice = async () => new Promise(resolve => completions.push(resolve));
    f.context.longReason = 'X'.repeat(2500);
    const update = 'updateDirectTaskProgress(identity.storeId,"retry-authorized","1",{directState:"rejected",reason:longReason,errorCode:"PRODUCT_SKU_INVALID",offendingSkuCode:"SKU-A"},identity)';
    await f.run(update);
    while (completions.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
    await f.run('setDirectCreatePaused(sender,identity,true)');
    await f.run('retryDirectTask(sender,{identity,jobId:"retry-authorized",spuId:"1"})');
    await f.run(update);
    while (completions.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
    completions[0]({ status: 'already_marked' });
    await new Promise(resolve => setTimeout(resolve, 5));
    const task = f.tasks().find(item => item.jobId === 'retry-authorized');
    assert.equal(task.directRetrySequence, 1); assert.equal(task.errorNoticeStatus, 'pending');
    const view = await f.run('targetUploadTaskView(sender,identity.storeId)');
    const summary = view.tasks.find(item => item.jobId === 'retry-authorized');
    assert.equal(summary.offendingSkuCode, 'SKU-A'); assert.equal(summary.reasonTruncated, true);
    assert.equal(summary.reason.length, 2000);
    completions[1]({ status: 'marked' });
    for (let i = 0; i < 50 && f.tasks().find(item => item.jobId === 'retry-authorized')?.errorNoticeStatus !== 'marked'; i++) await new Promise(resolve => setTimeout(resolve, 1));
    assert.equal(f.tasks().find(item => item.jobId === 'retry-authorized').errorNoticeStatus, 'marked');
});

/** 初始化不能返回共享队列或把缺省执行停止冒充主动暂停。 */
test('暂停展示核验真实文档，无映射、新文档和读取异常均回到空初始态', async () => {
    const f = await fixture();
    await f.receive(['1']);
    await f.run('setDirectCreatePaused(sender, identity, true)');
    const paused = await f.run('targetUploadTaskView(sender, identity.storeId)');
    assert.equal(paused.directPaused, true);
    assert.equal(paused.tasks.length, 1);
    const empty = async code => {
        const value = await f.run(code);
        assert.equal(value.directPaused, false);
        assert.equal(value.sessionReady, false);
        assert.equal(value.tasks.length, 0);
    };
    await empty('targetUploadTaskView(sender, "")');
    await empty('targetUploadTaskView({...sender,documentId:"new-document"},identity.storeId)');
    const original = f.context.chrome.scripting.executeScript;
    f.context.chrome.scripting.executeScript = async () => { throw Error('文档不可读'); };
    await empty('targetUploadTaskView(sender, identity.storeId)');
    f.context.chrome.scripting.executeScript = original;
    await f.run('invalidateExecutionTab(1,"刷新")');
    await empty('targetUploadTaskView(sender,identity.storeId)');
});

/** 货号摘要直接取可信来源正文，商品货号存在时也不能漏掉所有关联 SKU。 */
test('异常摘要同时保留两级货号、完整原因、执行阶段且不暴露正文或授权', async () => {
    const f = await fixture();
    const snapshot = { publicationData: { sourceProduct: { productId: '1', productSkcList: [
        { extCode: 'P-1', productSkuList: [{ extCode: 'S-1' }, { skuExtCode: 'S-2' }] },
        { skcExtCode: 'P-2', productSkuList: [{ extCode: 'S-1' }] }
    ] } } };
    f.context.incoming = [{ jobId: 'codes', spuId: '1', snapshot, transferIntegrity: transferManifest(snapshot),
        directCreate: true, transportOnly: true, executionRunId: f.identity.relaySessionId,
        targetStoreId: f.identity.storeId, failureGrant: 'old-ignored-grant' }];
    await f.run('receiveTargetUploadTasks(incoming,identity.storeId,identity)');
    f.context.failureReason = '详细平台原因'.repeat(70);
    await f.run('updateDirectTaskProgress(identity.storeId,"codes","1",{directState:"rejected",reason:failureReason,errorCode:"2000135",errorStage:"提交"},identity)');
    const view = await f.run('targetUploadTaskView(sender,identity.storeId)');
    assert.deepEqual(Array.from(view.tasks[0].productCodes), ['P-1', 'P-2']);
    assert.deepEqual(Array.from(view.tasks[0].skuCodes), ['S-1', 'S-2']);
    assert.equal(view.tasks[0].reason, f.tasks()[0].reason);
    assert.equal(view.tasks[0].errorCode, '2000135');
    assert.equal(view.tasks[0].errorStage, '提交');
    for (const key of ['snapshot','failureGrant','transferIntegrity']) assert.equal(Object.hasOwn(view.tasks[0], key), false);
    await f.run('updateDirectTaskProgress(identity.storeId,"codes","1",{directState:"created",reason:"成功",errorCode:"",errorStage:""},identity)');
    assert.equal(f.tasks()[0].errorCode, '');
    assert.equal(f.tasks()[0].errorStage, '');
});

test('暂停收到新批只替换未开始任务，运行中追加，结束后新批正常接收', { timeout: 5000 }, async () => {
    const f = await fixture();
    await f.receive(['1', '2']); await f.receive(['3']);
    assert.deepEqual(f.tasks().map(t => t.spuId), ['1', '2', '3']);
    await f.run('setDirectCreatePaused(sender, identity, true)');
    await f.receive(['4']);
    assert.deepEqual(f.tasks().map(t => t.spuId), ['4']);
    assert.equal(f.session['directPause:temu:222'].paused, true);
    // 防止真实运行器由继续命令触发：本测试只检查队列状态，执行器另有独立用例。
    f.context.sender.tab.url = 'https://agentseller.temu.com/home';
    await f.run('setDirectCreatePaused(sender, identity, false)');
    f.context.identity = await f.run('bindExecutionIdentity(sender, base)');
    await f.receive(['5'], f.context.identity);
    assert.deepEqual(f.tasks().map(t => t.spuId), ['4', '5']);
    await f.run('cancelStoreTasks(sender, identity)');
    assert.equal(f.tasks().length, 0);
    assert.equal(f.session['directPause:temu:222'].paused, false);
    await f.receive(['6'], await f.run('bindExecutionIdentity(sender, base)'));
    assert.deepEqual(f.tasks().map(t => t.spuId), ['6']);
    assert.equal(f.calls.length, 0, '控制与执行不能调用服务端状态接口');
});

test('刷新包括暂停队列也清空；迟到接收不能复活旧任务，其他店不受影响', async () => {
    const f = await fixture();
    await f.receive(['1']); await f.run('setDirectCreatePaused(sender, identity, true)');
    f.context.otherSender = { tab: { id: 2 }, documentId: 'doc-2' };
    const other = await f.run('bindExecutionIdentity(otherSender, {...base,storeId:"temu:333",mallId:"333"})');
    await f.receive(['2'], other);
    await f.run('invalidateExecutionTab(1, "刷新")');
    assert.deepEqual(f.tasks().map(t => t.targetStoreId), ['temu:333']);
    await assert.rejects(f.receive(['3']), /页面已变化/);
    f.context.sender.documentId = 'new-doc';
    const fresh = await f.run('bindExecutionIdentity(sender, base)');
    assert.notEqual(fresh.relaySessionId, f.identity.relaySessionId);
    assert.equal(f.session['directPause:temu:222'].paused, false);
    assert.equal(f.calls.length, 0);
});

test('运行器实际预检提交只在插件处理，平台调用模拟，绝不申请许可或回传结果', async () => {
    const f = await fixture();
    await f.receive(['1', '2']);
    let submits = 0;
    f.context.acquirePlatformForDirect = async () => { await f.run('directRunningTabs.add(1);directRunningStores.set("temu:222",1)'); return true; };
    f.context.directPage = async (_tab, phase) => { assert.notEqual(phase, 'verify', '商品成功后不得额外详情回查'); if (phase === 'submit') submits++; return phase === 'submit-status' ? { state: 'created', productId: '9876543210' } : {}; };
    // 此用例只验证商品执行与零回执；资质决策和真实注入由独立的资质执行测试覆盖。
    f.context.runDirectQualifications = async () => ({ state: 'complete', reason: '商品及资质已提交', items: [] });
    f.context.prepareDirectTask = async (task, identity, tab, key) => { f.session[key] = { stage: 'authorizing', request: {}, hash: 'a'.repeat(64), hashLength: 64, mallId: identity.mallId }; return { kind: 'prepared' }; };
    await f.run('runDirectTasks(1, identity)');
    assert.equal(submits, 2);
    assert.deepEqual(f.tasks().map(t => t.directState), ['created', 'created']);
    await f.run('runDirectTasks(1, identity)');
    assert.equal(submits, 2);
    assert.equal(f.calls.length, 0);
    assert.equal(Object.keys(f.local).filter(key => key.startsWith('directAttempt:')).length, 0);
});

/** 没有新版错误授权的兼容任务只保留本地失败清单，不恢复旧回执接口。 */
for (const noticeMode of ['ok', 'reject', 'hang']) test(`四件平台拒绝继续执行，结果零回传（${noticeMode}）`, async () => {
    const f = await fixture();
    await f.receive(['1', '2', '3', '4'], f.identity, 'isolated-click', 'signed-fixture-grant');
    let submits = 0;
    f.context.hubJson = async (url, body) => {
        f.calls.push({ url, body });
        if (noticeMode === 'reject') throw Error('模拟网络不可用');
        if (noticeMode === 'hang') return new Promise(() => {});
        return { ok: true };
    };
    f.context.acquirePlatformForDirect = async () => { await f.run('directRunningTabs.add(1);directRunningStores.set("temu:222",1)'); return true; };
    f.context.prepareDirectTask = async (_task, identity, _tab, key) => {
        f.session[key] = { stage: 'authorizing', request: {}, hash: 'a'.repeat(64), hashLength: 64, mallId: identity.mallId };
        return { kind: 'prepared' };
    };
    f.context.directPage = async (_tab, phase) => {
        if (phase === 'submit') submits++;
        return phase === 'submit-status' ? { state: 'rejected', error: '净含量必填' } : {};
    };
    await f.run('runDirectTasks(1, identity)');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(submits, 4);
    assert.deepEqual(f.tasks().map(task => task.directState), ['rejected', 'rejected', 'rejected', 'rejected']);
    assert.equal(f.calls.length, 0);
    assert.ok(f.tasks().every(task => task.reason === '净含量必填'));
    assert.ok(f.tasks().every(task => !Object.hasOwn(task, 'failureGrant')));
    await f.run('runDirectTasks(1, identity)');
    assert.equal(submits, 4, '终态心跳不重新提交');
    assert.equal(f.calls.length, 0, '终态心跳不回传');
});

test('平台结果未知只保留本地待核对，心跳不重复提交或回传', async () => {
    const f = await fixture();
    await f.receive(['1'], f.identity, 'isolated-click', 'signed-fixture-grant');
    let submits = 0;
    f.context.acquirePlatformForDirect = async () => true;
    f.context.prepareDirectTask = async (_task, identity, _tab, key) => {
        f.session[key] = { stage: 'authorizing', request: {}, mallId: identity.mallId };
        return { kind: 'prepared' };
    };
    f.context.directPage = async (_tab, phase) => {
        if (phase === 'submit') submits++;
        assert.notEqual(phase, 'verify');
        return phase === 'submit-status' ? { state: 'unknown', error: '网络超时', errorCode: '429' } : {};
    };
    await f.run('runDirectTasks(1, identity)');
    const originalReason = f.tasks()[0].reason;
    await f.run('runDirectTasks(1, identity)');
    assert.equal(submits, 1);
    assert.equal(f.tasks()[0].directState, 'unknown');
    assert.equal(f.tasks()[0].reason, originalReason, '心跳不能覆盖首次未知原因');
    assert.match(f.tasks()[0].reason, /网络超时/);
    assert.equal(f.tasks()[0].errorCode, '429');
    assert.equal(f.tasks()[0].errorStage, '提交');
    assert.equal(f.calls.length, 0);
});

test('外围注入失败只保留当前件本地错误，不污染已成功项或回传', async () => {
    const f = await fixture();
    await f.receive(['1', '2'], f.identity, 'isolated-click', 'signed-fixture-grant');
    f.tasks()[0].directState = 'created';
    f.context.acquirePlatformForDirect = async () => { await f.run('directRunningTabs.add(1);directRunningStores.set("temu:222",1)'); return true; };
    const execute = f.context.chrome.scripting.executeScript;
    f.context.chrome.scripting.executeScript = input => input.files ? Promise.reject(Error('注入环境不可用')) : execute(input);
    await f.run('runDirectTasks(1, identity)');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(f.tasks().map(task => task.directState), ['created', 'preflight_failed']);
    assert.equal(f.calls.length, 0);
    assert.match(f.tasks()[1].reason, /注入环境不可用/);
});

test('暂停期间仍可接收主动投递，但不发送收妥或平台回执', async () => {
    const f = await fixture();
    await f.run('setDirectCreatePaused(sender, identity, true)');
    await f.receive(['1']);
    assert.equal(f.tasks().length, 1);
    assert.equal(f.session['directPause:temu:222'].paused, true);
    assert.equal(f.calls.length, 0);
});

/** 验证一次点击拆成多个HTTP正文时不会被暂停替换规则截断。 */
test('暂停下同一点击分段合并，重复正文只保存一次，新点击才替换', async () => {
    const f = await fixture();
    await f.run('setDirectCreatePaused(sender, identity, true)');
    const click = globalThis.crypto.randomUUID();
    await f.receive(['1', '2'], f.identity, click);
    await f.receive(['3'], f.identity, click);
    await f.receive(['2'], f.identity, click);
    assert.deepEqual(f.tasks().map(t => t.spuId), ['1', '2', '3']);
    await f.receive(['4']);
    assert.deepEqual(f.tasks().map(t => t.spuId), ['4']);
});

/** 结束无法撤回已发出的平台请求，但迟到进度不得把旧任务插回新面板。 */
test('当前件暂停时保留，结束后迟到完成只记日志，不复活或污染新任务', async () => {
    const f = await fixture();
    await f.receive(['1', '2']);
    const task = f.tasks()[0];
    f.context.key = `directAttempt:${task.jobId}:${task.spuId}`;
    await f.run('directActiveTaskKeys.add(key); setDirectCreatePaused(sender, identity, true)');
    await f.receive(['3']);
    assert.deepEqual(f.tasks().map(t => t.spuId), ['1', '3']);
    await f.run('cancelStoreTasks(sender, identity)');
    await f.receive(['4'], await f.run('bindExecutionIdentity(sender, base)'));
    f.context.oldTask = task;
    let pushed = 0;
    f.context.chrome.tabs.sendMessage = async () => { pushed++; };
    await f.run('updateDirectTaskProgress(oldTask.targetStoreId,oldTask.jobId,oldTask.spuId,{directState:"created"});notifyDirectCreateProgress(1,oldTask)');
    assert.equal(pushed, 0);
    assert.deepEqual(f.tasks().map(t => [t.spuId, t.directState]), [['4', undefined]]);
});

test('结束前挂起的主动投递不能重新入队', async () => {
    const f = await fixture();
    await f.receive(['1']);
    const task = f.tasks()[0];
    let deliver, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const verify = f.context.TemuTransferIntegrity.verify;
    f.context.TemuTransferIntegrity.verify = async (...args) => { entered(); await new Promise(resolve => { deliver = resolve; }); return verify(...args); };
    const pending = f.receive(['2']);
    await started;
    await f.run('cancelStoreTasks(sender, identity)');
    deliver();
    await assert.rejects(pending, /接收页面已变化/);
    assert.equal(f.tasks().length, 0);
    const fresh = await f.run('bindExecutionIdentity(sender, base)');
    assert.notEqual(fresh.relaySessionId, f.identity.relaySessionId);
});

test('暂停时A旧分段不能在B新点击之后反向覆盖B', async () => {
    const f = await fixture();
    const a = globalThis.crypto.randomUUID(), b = globalThis.crypto.randomUUID();
    await f.receive(['1'], f.identity, a);
    await f.run('setDirectCreatePaused(sender, identity, true)');
    await f.receive(['2'], f.identity, b);
    await assert.rejects(f.receive(['3'], f.identity, a), /旧批次已被替换/);
    assert.deepEqual(f.tasks().map(t => t.spuId), ['2']);
});

test('旧注入迟到失败不能给结束后新商品标记预检错误', async () => {
    const f = await fixture();
    await f.receive(['1']);
    let fail, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const original = f.context.chrome.scripting.executeScript;
    f.context.chrome.scripting.executeScript = input => input.files ? new Promise((_, reject) => { fail = reject; entered(); }) : original(input);
    f.context.acquirePlatformForDirect = async () => { await f.run('directRunningTabs.add(1);directRunningStores.set("temu:222",1)'); return true; };
    const running = f.run('runDirectTasks(1, identity)');
    await started;
    await f.run('cancelStoreTasks(sender, identity)');
    await f.receive(['2'], await f.run('bindExecutionIdentity(sender, base)'));
    // 新批执行由独立用例覆盖；这里禁用后续唤醒，专门断言旧异常不能改新队列。
    f.context.acquirePlatformForDirect = async () => false;
    fail(Error('旧注入失败'));
    await running;
    assert.deepEqual(f.tasks().map(task => [task.spuId, task.directState]), [['2', undefined]]);
});

test('孤儿正文在新写入前清理，旧预检不能在清空后重新存储，全部会话受总配额约束', async () => {
    const f = await fixture();
    f.session['directAttempt:orphan:1'] = { request: 'x'.repeat(10000) };
    f.context.chrome.storage.session.QUOTA_BYTES = 8000;
    await f.receive(['1']);
    assert.equal(f.session['directAttempt:orphan:1'], undefined);
    const task = f.tasks()[0];
    f.context.oldTask = task;
    await f.run('cancelStoreTasks(sender, identity)');
    await assert.rejects(f.run('writeDirectAttempt(oldTask, "directAttempt:late:1", {request:{}})'), /轮次已结束/);
    assert.equal(f.session['directAttempt:late:1'], undefined);
    f.session.unrelated = 'x'.repeat(7000);
    await assert.rejects(f.receive(['2'], await f.run('bindExecutionIdentity(sender, base)')), /会话空间不足/);
    assert.equal(f.tasks().length, 0);
});

test('页面调用挂起按截止时间失败，不无限持有本地等待', async () => {
    const f = await fixture();
    await assert.rejects(f.run('executionWithDeadline(() => new Promise(() => {}), 20)'), /页面调用超时/);
});

/** 直接执行面板的真实进度监听器，而不是只断言后台通知函数的顺序场景。 */
test('已结束面板不接受未知任务，旧代次进度不能覆盖同主键的新轮次', async () => {
    const content = await readFile(new URL('../../plugin/content-app.js', import.meta.url), 'utf8');
    const start = content.indexOf('chrome.runtime.onMessage.addListener((message) => {');
    const end = content.indexOf('chrome.storage.onChanged.addListener', start);
    let handler, renders = 0;
    const task = { jobId: 'a', spuId: '1', targetStoreId: 'temu:222', relaySessionId: 'new', executionRunId: 'new-run' };
    const context = vm.createContext({ chrome: { runtime: { onMessage: { addListener: callback => { handler = callback; } } } },
        state: { transferTasks: [task] }, render: () => { renders++; } });
    vm.runInContext(content.slice(start, end), context);
    handler({ type: 'directCreateProgress', task: { ...task, relaySessionId: 'old', reason: '迟到旧进度' } });
    handler({ type: 'directCreateProgress', task: { ...task, jobId: 'removed', reason: '已结束任务' } });
    assert.equal(renders, 0);
    assert.equal(context.state.transferTasks.length, 1);
    handler({ type: 'directCreateProgress', task: { ...task, reason: '当前进度' } });
    assert.equal(renders, 1);
    assert.equal(context.state.message, '当前进度');
});

/** 存储写入故意挂起，强制让继续命令与暂停换批交错，验证共享提交边界。 */
test('换批写入与继续交错时淘汰名单不会丢失', async () => {
    const f = await fixture();
    const a = globalThis.crypto.randomUUID(), b = globalThis.crypto.randomUUID();
    await f.receive(['1'], f.identity, a);
    await f.run('setDirectCreatePaused(sender, identity, true)');
    let finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const set = f.context.chrome.storage.session.set;
    let blocked = false;
    f.context.chrome.storage.session.set = async values => {
        if (!blocked && values.targetUploadTasksV1?.[0]?.spuId === '2') {
            blocked = true; entered(); await new Promise(resolve => { finish = resolve; });
        }
        return set(values);
    };
    const replacing = f.receive(['2'], f.identity, b);
    await started;
    f.context.sender.tab.url = 'https://agentseller.temu.com/home';
    const continuing = f.run('setDirectCreatePaused(sender, identity, false)');
    finish();
    await replacing; await continuing;
    await f.run('setDirectCreatePaused(sender, identity, true)');
    await assert.rejects(f.receive(['3'], f.identity, a), /旧批次已被替换/);
    assert.deepEqual(f.tasks().map(task => task.spuId), ['2']);
});

// 同一执行闭环分别在正常配额与共享空间压力下验证，不能用孤立状态赋值代替平台返回路径。
for (const spacePressure of [false, true]) test(`暂停不丢弃当前件平台已返回的创建事实${spacePressure ? '（空间压力）' : ''}`, async () => {
    const f = await fixture();
    await f.receive(['1']);
    let finish, entered;
    const started = new Promise(resolve => { entered = resolve; });
    f.context.acquirePlatformForDirect = async () => { await f.run('directRunningTabs.add(1);directRunningStores.set("temu:222",1)'); return true; };
    f.context.prepareDirectTask = async (task, _identity, _tab, key) => {
        f.context.preparingTask = task; f.context.preparingKey = key;
        await f.run('writeDirectAttempt(preparingTask,preparingKey,{stage:"authorizing",request:{},hash:"a",hashLength:1,mallId:"222"})');
        return { kind: 'prepared' };
    };
    f.context.directPage = async (_tab, phase) => phase === 'submit-status'
        ? (entered(), new Promise(resolve => { finish = resolve; })) : {};
    const running = f.run('runDirectTasks(1,identity)');
    await started;
    if (spacePressure) {
        f.context.chrome.storage.session.QUOTA_BYTES = 10000;
        f.session.unrelated = 'x'.repeat(9400 - Buffer.byteLength(JSON.stringify(f.session)) - 20);
        assert.ok(Buffer.byteLength(JSON.stringify(f.session)) > 8500);
    }
    await f.run('setDirectCreatePaused(sender,identity,true)');
    finish({ state: 'created', productId: '9876543210' });
    await running;
    assert.equal(f.tasks()[0].directState, 'created');
    const record = f.session[`directAttempt:${f.tasks()[0].jobId}:1`];
    assert.equal(record.productId, '9876543210');
    assert.equal(record.done, true, '商品任务已返回编号即完成，暂停不能启动独立资质任务');
    assert.equal(f.tasks()[0].productId, '9876543210');
});

test('结束后的后台旧快照拒绝返回，面板也丢弃控制前的读取', async () => {
    const f = await fixture();
    await f.receive(['1']);
    let finish, entered, blocked = false;
    const started = new Promise(resolve => { entered = resolve; });
    const get = f.context.chrome.storage.session.get;
    f.context.chrome.storage.session.get = async key => {
        const result = await get(key);
        if (!blocked && key === 'targetUploadTasksV1') {
            blocked = true; entered(); await new Promise(resolve => { finish = resolve; });
        }
        return result;
    };
    const reading = f.run('targetUploadTaskView(sender,identity.storeId)');
    await started;
    await f.run('cancelStoreTasks(sender,identity)');
    await f.receive(['2'], await f.run('bindExecutionIdentity(sender,base)'));
    finish();
    assert.equal((await reading).tasks.length, 0);

    const content = await readFile(new URL('../../plugin/content-app.js', import.meta.url), 'utf8');
    const start = content.indexOf('async function refreshTargetUploadTasks()');
    const end = content.indexOf('/** 扩展存储跨店共享', start);
    let deliver, requested;
    const requestedPromise = new Promise(resolve => { requested = resolve; });
    const fresh = { jobId: 'new' };
    const ui = vm.createContext({ targetViewEpoch: 0, lastStoreSequence: 0, state: { transferTasks: [] },
        currentPageIdentity: () => ({ storeId: 'temu:222' }),
        send: async type => type === 'getBoundStore' ? { ok: false } : (requested(), new Promise(resolve => { deliver = resolve; })) });
    vm.runInContext(content.slice(start, end), ui);
    const pending = vm.runInContext('refreshTargetUploadTasks()', ui);
    await requestedPromise;
    ui.targetViewEpoch++; ui.state.transferTasks = [fresh];
    deliver({ ok: true, tasks: [{ jobId: 'old' }], directPaused: true });
    await pending;
    assert.deepEqual(ui.state.transferTasks, [fresh]);
});

test('共享占用超过软预算时结束仍可减量释放队列', async () => {
    const f = await fixture();
    await f.receive(['1']);
    f.context.chrome.storage.session.QUOTA_BYTES = 10000;
    f.session.unrelated = 'x'.repeat(8700);
    assert.ok(Buffer.byteLength(JSON.stringify(f.session)) > 8500);
    await f.run('cancelStoreTasks(sender, identity)');
    assert.equal(f.tasks().length, 0);
    assert.equal(f.session['directPause:temu:222'].paused, false);
});

test('控制预留空间不能被新商品正文或尝试正文挪用', async () => {
    const f = await fixture();
    await f.receive(['1']);
    f.context.chrome.storage.session.QUOTA_BYTES = 10000;
    f.session.unrelated = 'x'.repeat(8700);
    await assert.rejects(f.receive(['2']), /会话空间不足/);
    await assert.rejects(f.run('setTargetSessionValues({"directAttempt:new:2":{request:"body"}})'), /会话空间不足/);
    await assert.rejects(f.run('setTargetSessionValues({"directPause:extra":{reason:"x".repeat(2000)}})'), /会话空间不足/);
    assert.deepEqual(f.tasks().map(task => task.spuId), ['1']);
});

test('净减量但仍超软预算不能换入新商品或新尝试正文', async () => {
    const f = await fixture();
    await f.receive(['1', '2']);
    await f.run('setDirectCreatePaused(sender, identity, true)');
    f.context.chrome.storage.session.QUOTA_BYTES = 10000;
    f.session.unrelated = 'x'.repeat(9700 - Buffer.byteLength(JSON.stringify(f.session)) - 20);
    await assert.rejects(f.receive(['3']), /会话空间不足/);
    assert.deepEqual(f.tasks().map(task => task.spuId), ['1', '2']);
    f.session['directAttempt:old:1'] = { request: 'x'.repeat(500) };
    f.session.unrelated = '';
    f.session.unrelated = 'x'.repeat(9800 - Buffer.byteLength(JSON.stringify(f.session)));
    await assert.rejects(f.run('setTargetSessionValues({"directAttempt:old:1":null,"directAttempt:new:1":{request:"small"}})'), /会话空间不足/);
    assert.ok(f.session['directAttempt:old:1']);
    assert.equal(f.session['directAttempt:new:1'], undefined);
});
