/** 使用真实领取入口和执行器验证升级保护；所有网络、存储和平台接口均为内存模拟。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { directExecutorFixture } from './direct-platform-fixture.mjs';

const executor = await directExecutorFixture({ executionRounds: true });
const background = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
const receipts = await readFile(new URL('../../plugin/direct-receipts.js', import.meta.url), 'utf8');
const start = background.indexOf('async function claimStoreJobs(identity = {})');
const end = background.indexOf('async function setDirectCreatePaused', start);
assert.ok(start >= 0 && end > start);
const identity = { storeId: 'temu:123', mallId: '123', identityMatched: true, executionMode: 'plugin-api',
    tabId: 1, documentId: 'upgrade-document', executionRunProtocol: 1, executionRunId: '' };
const sender = { tab: { id: 1, url: 'https://agentseller.temu.com/goods/list' }, documentId: identity.documentId };
const task = { jobId: 'old-job', spuId: '9100894431', targetStoreId: identity.storeId,
    executionRunId: 'previous-execution-round', claimToken: 'old-claim-token', directCreate: true,
    snapshot: { publicationData: { sourceProduct: { productId: '9100894431' } } } };
const memory = { 'directAttempt:old-job:9100894431': { stage: 'unknown', attemptId: 'old-attempt' } };
let version = '10.10.60', pageCalls = 0, httpCalls = [], readFails = false, writeFails = false, stopDuringIdentity = false;
let activeDocumentId = identity.documentId, serverRunId = '';

/** 重建后台上下文但保留持久存储，区分版本升级与同版本后台回收。 */
function boot() {
    const ctx = vm.createContext({ console, crypto, TextEncoder, setTimeout, clearTimeout,
        chrome: { runtime: { getManifest: () => ({ version }) }, alarms: { create: async () => {} },
            storage: { local: {
                get: async key => {
                    if (readFails) throw Error('storage unavailable');
                    return structuredClone(key === null ? memory : { [key]: memory[key] });
                },
                set: async value => { if (writeFails) throw Error('storage unavailable'); Object.assign(memory, structuredClone(value)); },
                remove: async key => { delete memory[key]; }
            } },
            scripting: { executeScript: async spec => {
                // 文档探测和轮次标记不等于平台请求；刷新后旧文档必须探测失败。
                if (spec.target.documentIds?.[0] !== activeDocumentId) throw Error('页面已变化');
                if (!spec.args || typeof spec.args[0] === 'string' && spec.args.length === 1) {
                    return [{ documentId: activeDocumentId, result: { visible: true } }];
                }
                pageCalls++; throw Error('暂停期间不应调用平台');
            } } },
        getBoundStore: async () => ({ storeId: identity.storeId }), boundMatchesPage: () => true,
        getTargetUploadTasks: async () => [task], getPluginInstanceId: async () => {
            if (stopDuringIdentity) memory['directPause:temu:123'] = { paused: true };
            return 'test-instance';
        },
        reportTargetUploadTask: async body => { httpCalls.push({ url: '/api/jobs/report', body }); task.receivePending = false; },
        summarizeTargetUploadTasks: tasks => tasks, saveTargetUploadTasks: async () => {},
        registerStoreAgent: async () => ({ agent: { executionRunLastId: serverRunId } }),
        reconcileTargetUploadTasks: async () => [],
        getUtf8ByteLength: value => Buffer.byteLength(value),
        TemuOperationLog: { append: async () => {} },
        hubJson: async (url, body) => {
            httpCalls.push({ url, body });
            if (url === '/api/jobs/execution-run') {
                if (body.action === 'start') serverRunId = body.executionRunId;
                return { executionRunId: body.executionRunId, expiresAt: new Date(Date.now() + 120000).toISOString(), stopped: body.action === 'stop' };
            }
            return { attemptId: body.attemptId, state: body.phase, claimed: [] };
        }
    });
    vm.runInContext(receipts + '\n' + executor + '\n' + background.slice(start, end), ctx);
    ctx.identity = identity;
    ctx.sender = sender;
    return ctx;
}

let ctx = boot();
for (let i = 0; i < 3; i++) {
    const result = await vm.runInContext('claimStoreJobs(identity)', ctx);
    assert.equal(result.directPaused, true);
    assert.equal(result.claimed.length, 0);
    await vm.runInContext('runDirectTasks(1, identity)', ctx);
    ctx = boot();
}
assert.equal(httpCalls.length, 0, '未确认启用时，后台唤醒不得领取服务端旧任务');
assert.equal(pageCalls, 0, '本地已有旧快照也不能触发上架');
assert.equal(memory['directAttempt:old-job:9100894431'].attemptId, 'old-attempt', '不得删除未知结果的执行证据');

// 默认暂停不阻断已提交结果的补报，也不能借补报重新申请创建授权。
await vm.runInContext("TemuDirectReceipts.send({jobId:'old-job',spuId:'9100894431',attemptId:'old-attempt',phase:'created',storeId:'temu:123'})", ctx);
assert.equal(httpCalls.length, 1);
assert.equal(httpCalls[0].body.phase, 'created');
assert.equal(pageCalls, 0);
httpCalls = [];

// 平台已返回商品编号、尚未入回执队列即重启时，暂停仍能补报，但不会新增或声称详情回查完成。
memory['directAttempt:old-job:9100894431'] = { stage: 'verifying', attemptId: 'created-attempt', mallId: '123', productId: '8002250622' };
task.receivePending = true;
await vm.runInContext('claimStoreJobs(identity)', ctx);
assert.equal(httpCalls.filter(call => call.body.phase === 'created').length, 1);
assert.match(httpCalls.find(call => call.body.phase === 'created').body.reason, /尚未完成详情回查/);
assert.equal(httpCalls.filter(call => call.url === '/api/jobs/report').length, 1, '暂停期间仍补报已接收快照');
assert.equal(httpCalls.filter(call => call.url === '/api/jobs/claim').length, 0);
assert.equal(pageCalls, 0);
httpCalls = [];

// 停止发生在拿到许可之后时，后台崩溃也只能补报未提交，不能在下次启动重放。
memory['directAttempt:old-job:9100894431'] = { stage: 'stopped_before_submit', attemptId: 'unused-attempt', mallId: '123' };
ctx = boot();
await vm.runInContext('claimStoreJobs(identity)', ctx);
assert.equal(httpCalls.length, 1);
assert.equal(httpCalls[0].body.phase, 'preflight_failed');
assert.equal(httpCalls[0].body.attemptId, 'unused-attempt');
assert.equal(memory['directAttempt:old-job:9100894431'].done, true);
assert.equal(pageCalls, 0);
httpCalls = [];

// 启用必须完成真实轮次握手；单独写 paused=false 已不再是合法入口。
await assert.rejects(vm.runInContext("writeDirectPause('temu:123',false)", ctx), /启用执行必须/);
Object.assign(identity, await vm.runInContext('startExecutionRound(sender, identity)', ctx));
assert.equal(httpCalls.filter(call => call.url === '/api/jobs/execution-run' && call.body.action === 'start').length, 1);
httpCalls = [];
assert.equal(await vm.runInContext("readDirectPause('temu:123')", ctx), null);
ctx = boot();
assert.equal(await vm.runInContext("readDirectPause('temu:123', identity)", ctx), null, '同版本同文档后台重启保留轮次');
assert.equal((await vm.runInContext("readDirectPause('temu:999')", ctx)).paused, true, '启用 A 店不能启用 B 店');
await vm.runInContext('claimStoreJobs(identity)', ctx);
assert.equal(httpCalls.filter(call => call.url === '/api/jobs/claim').length, 1, '明确启用后才能领取');
assert.equal(httpCalls.find(call => call.url === '/api/jobs/claim').body.executionRunId, identity.executionRunId);
httpCalls = []; stopDuringIdentity = true;
assert.equal((await vm.runInContext('claimStoreJobs(identity)', ctx)).directPaused, true);
assert.equal(httpCalls.filter(call => call.url === '/api/jobs/claim').length, 0, '准备领取期间停止后不得发新领取');
stopDuringIdentity = false;
Object.assign(identity, await vm.runInContext('startExecutionRound(sender, identity)', ctx));
// 同版本刷新也不能复用轮次，即使持久存储中的 paused 仍为 false。
activeDocumentId = 'refreshed-document'; ctx = boot(); httpCalls = [];
assert.equal((await vm.runInContext('claimStoreJobs(identity)', ctx)).directPaused, true);
assert.equal(httpCalls.length, 0, '新文档不得领取旧轮任务');
activeDocumentId = identity.documentId;
version = '10.10.61'; ctx = boot(); httpCalls = [];
assert.equal((await vm.runInContext('claimStoreJobs(identity)', ctx)).directPaused, true);
assert.equal(httpCalls.length, 0, '下一版本不能沿用旧版确认');

// 旧版停止标记、读写失败必须保持停止，不能因异常退回自动执行。
memory['directPause:temu:123'] = { paused: true, reason: '人工停止' };
assert.equal((await vm.runInContext("readDirectPause('temu:123')", ctx)).reason, '人工停止');
readFails = true;
assert.equal((await vm.runInContext("readDirectPause('temu:123')", ctx)).paused, true);
readFails = false; writeFails = true;
await assert.rejects(vm.runInContext('startExecutionRound(sender, identity)', ctx), /storage unavailable/);
assert.equal(memory['directPause:temu:123'].paused, true);
writeFails = false;

// 控制命令按照到达后台的顺序生效，较早启用的慢身份读取不能覆盖较晚停止。
const controlsEnd = background.indexOf('async function reportStoreJob', end);
vm.runInContext(background.slice(end, controlsEnd), ctx);
let releaseIdentity, identities = 0;
ctx.directIdentity = async () => {
    if (identities++ === 0) await new Promise(resolve => { releaseIdentity = resolve; });
    return identity;
};
ctx.getTargetUploadTasks = async () => [];
const continuing = vm.runInContext('setDirectCreatePaused(sender, identity, false)', ctx);
await Promise.resolve();
assert.equal(typeof releaseIdentity, 'function');
const stopping = vm.runInContext('setDirectCreatePaused(sender, identity, true)', ctx);
releaseIdentity();
await continuing; await stopping;
assert.equal(memory['directPause:temu:123'].paused, true, '较晚停止必须最终生效');
console.log('升级保护通过：握手启用、同文档后台重启、新文档及新版本拒绝旧轮、异常停止、控制顺序、暂停仍补报结果；真实平台请求为0');
