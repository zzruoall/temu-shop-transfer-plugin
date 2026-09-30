/** 只在临时文件和模拟浏览器中检查当前隔离缺口；不启动服务、不访问网络、不修改业务源码。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createJobQueue } from '../lib/job-queue.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'temu-isolation-probe-'));
const source = await readFile(new URL('../../plugin/execution-round.js', import.meta.url), 'utf8');
const results = [];
const ingestQueue = createRequire(import.meta.url)('../../plugin/ingest-queue.js');

/** 每项断言表达未来验收要求；失败如实记为缺口，不把“成功复现缺陷”冒充验收通过。 */
async function check(name, run) {
    try {
        const details = await run();
        results.push({ name, status: 'PASS', details });
    } catch (error) {
        results.push({ name, status: 'FAIL', reason: error.message, code: error.code || '' });
    }
}

/**
 * 沙箱自检：探针环境必须先证明自己具备被测代码需要的能力。
 * 缺定时器时超时逻辑会抛 ReferenceError 并被业务 catch 吞成"失败返回"，
 * 从而把环境缺陷伪装成通过；所以环境不合格要整体判失败，不能静默继续。
 */
async function checkSandbox() {
    const { context } = pluginFixture({});
    const probes = await vm.runInContext(`(async () => {
        const out = {};
        out.hasSetTimeout = typeof setTimeout === 'function';
        out.hasClearTimeout = typeof clearTimeout === 'function';
        // withTimeout 必须真的在超时后 reject，且错误来自超时而不是环境缺失。
        let reason = '';
        try { await withTimeout(new Promise(() => {}), 30); } catch (error) { reason = error.message; }
        out.timeoutRejects = reason === '停止通知超时';
        return out;
    })()`, context);
    assert.equal(probes.hasSetTimeout, true, '沙箱缺少 setTimeout，超时逻辑无法被真实执行');
    assert.equal(probes.hasClearTimeout, true, '沙箱缺少 clearTimeout');
    assert.equal(probes.timeoutRejects, true, 'withTimeout 未能在超时后按预期拒绝');
    return probes;
}
await check('沙箱自检：定时器可用且超时逻辑真实生效', checkSandbox);

/**
 * 每个场景独占模拟扩展存储；回执失败、取消失败、回执挂起分别注入。
 * receiptWait 用来复现"回执请求永不返回"：这是纯挂起，不是抛错，
 * 只有 await 它才会暴露阻塞，抛错路径掩盖不了。
 */
function pluginFixture({ stopFails = false, receiptFails = false, stopWait = null, receiptWait = null, onGet = null } = {}) {
    const oldIdentity = { storeId: 'temu:111', mallId: '111' };
    const memory = { 'directPause:temu:111': { paused: true, pendingStop: true,
        executionRunId: 'probe-old-round-111', identity: oldIdentity, storeId: oldIdentity.storeId } };
    const calls = [];
    const context = vm.createContext({ console, crypto: webcrypto,
        // 定时器必须真实注入：插件里的超时逻辑依赖 setTimeout/clearTimeout。
        // 缺了它们会让 withTimeout 抛 ReferenceError，再被 catch 吞成"失败返回"，
        // 探针就会把"环境报错"误判成"超时生效"——那是假通过。
        setTimeout, clearTimeout, Date,
        directRunningStores: new Set(), directStopRequested: new Set(),
        directPauseKey: storeId => `directPause:${storeId}`,
        getPluginInstanceId: async () => 'probe-instance',
        recoverPausedDirectResults: async () => {
            if (receiptWait) await receiptWait;
            if (receiptFails) throw Error('模拟回执故障');
        },
        registerStoreAgent: async () => ({ agent: { executionRunLastId: '' } }),
        hubJson: async (_url, body) => {
            calls.push(body);
            if (stopWait && body.action === 'stop' && body.storeId === 'temu:111') await stopWait;
            if (stopFails && body.action === 'stop' && body.storeId === 'temu:111') throw Error('模拟旧店停止失败');
            return { executionRunId: body.executionRunId, expiresAt: new Date(Date.now() + 120000).toISOString() };
        },
        chrome: {
            runtime: { getManifest: () => ({ version: '10.10.62' }) },
            alarms: { create: () => {} },
            scripting: { executeScript: async spec => [{ documentId: spec.target.documentIds[0], result: true }] },
            storage: { local: {
                get: async key => {
                    const snapshot = structuredClone(key === null ? memory : { [key]: memory[key] });
                    // onGet 允许用例把"读"停住，用来制造读-改-写之间的真实插入窗口。
                    return onGet ? await onGet(key, snapshot) : snapshot;
                },
                set: async value => Object.assign(memory, structuredClone(value))
            } }
        }
    });
    vm.runInContext(source, context);
    return { context, calls, memory };
}

try {
    await check('先撤销再到达的启动不得复活同一轮次', async () => {
        const queue = createJobQueue(path.join(root, 'stop-before-start'), {});
        const identity = { storeId: 'temu:222', mallId: '222', storeName: 'probe', pageStoreName: 'probe',
            executionMode: 'plugin-api', pluginInstanceId: 'probe-instance', pluginVersion: '10.10.61',
            pluginDetected: true, identityMatched: true, schedulingProtocol: 1, executionRunProtocol: 1 };
        await queue.registerAgent(identity);
        const executionRunId = 'probe-revoked-before-start';
        await queue.controlExecutionRun({ ...identity, action: 'stop', executionRunId });
        let rejected = false;
        try { await queue.controlExecutionRun({ ...identity, action: 'start', executionRunId, previousRunId: '' }); }
        catch (error) { if (error.status === 409) rejected = true; else throw error; }
        assert.equal(rejected, true, '当前服务端接受了先前已收到停止通知的迟到启动');
    });

    await check('A店停止失败不得阻断同实例B店启用', async () => {
        const { context } = pluginFixture({ stopFails: true });
        const identity = { storeId: 'temu:222', mallId: '222' };
        const result = await context.startExecutionRound({ tab: { id: 2 }, documentId: 'probe-document-b' }, identity);
        assert.ok(result.executionRunId);
    });

    await check('结果回执恢复失败不得阻止发送停止通知', async () => {
        const { context, calls } = pluginFixture({ receiptFails: true });
        // 即使将来实现向上传播错误，也先核对停止请求事实，避免把其他异常误报成未发送。
        let failure;
        try { await context.flushExecutionStops(); } catch (error) { failure = error; }
        assert.equal(calls.filter(call => call.action === 'stop').length, 1, '当前停止通知被回执恢复失败截断');
        if (failure) throw failure;
    });

    // 回执"挂起"和"失败"是两种不同的阻塞：抛错能被 catch 吞掉，挂起只能靠不 await 来避免。
    // 这一项专门覆盖挂起，防止只用失败场景自证独立。
    await check('回执请求挂起时停止通知仍必须立即发出', async () => {
        let releaseReceipt, timer;
        const receiptWait = new Promise(resolve => { releaseReceipt = resolve; });
        const { context, calls } = pluginFixture({ receiptWait });
        try {
            const outcome = await Promise.race([
                context.flushExecutionStops().then(() => 'sent', error => `error:${error.message}`),
                new Promise(resolve => { timer = setTimeout(() => resolve('blocked-by-receipt'), 250); })
            ]);
            assert.equal(outcome, 'sent', '停止通知仍被挂起的回执请求挡住');
            assert.equal(calls.filter(call => call.action === 'stop').length, 1, '挂起期间必须已经发出一次停止通知');
        } finally {
            clearTimeout(timer);
            releaseReceipt();
        }
    });

    // 停止请求本身也可能挂起。它与"停止失败"不同：抛错能被 catch 吞掉，挂起只能靠超时兜住。
    // 这一项保证挂死的停止请求不会把领取或启用流程一起拖住。
    await check('停止请求挂起时结算不得无限等待', async () => {
        let releaseStop, timer;
        const stopWait = new Promise(resolve => { releaseStop = resolve; });
        const { context, calls } = pluginFixture({ stopWait });
        try {
            const outcome = await Promise.race([
                context.flushExecutionStops().then(ok => `settled:${ok}`, error => `error:${error.message}`),
                new Promise(resolve => { timer = setTimeout(() => resolve('STILL-HANGING'), 12000); })
            ]);
            assert.notEqual(outcome, 'STILL-HANGING', '停止请求挂起时结算仍未返回，调用方会被永久拖住');
            assert.equal(calls.filter(call => call.action === 'stop').length, 1, '挂起期间必须已经发出停止请求');
        } finally {
            clearTimeout(timer);
            releaseStop();
        }
    });

    // 旧回执迟到时不得把状态写回旧轮次。这是读-改-写竞态：
    // 若在"读最新"和"写回"之间让出，新轮次可能已经落盘，旧回执会把它覆盖成"旧轮次、已暂停"。
    // 旧回执迟到时不得把状态写回旧轮次。这是读-改-写竞态，必须制造真实的插入窗口：
    // 让旧轮次的读已经取到快照、但写回尚未发生，期间新轮次落盘。
    // 只在锁外挂起回执是抓不到的——那种顺序下写回仍发生在换轮之前，属于无效用例。
    await check('旧回执迟到不得覆盖新轮次状态', async () => {
        const key = 'directPause:temu:111';
        // 让锁内的读停住，从而把"读旧"和"写回"拆开，给新轮次留出落盘时机。
        let holdNextGet = false, releaseGet = null;
        const { context, memory } = pluginFixture({
            onGet: async (requestedKey, snapshot) => {
                if (!holdNextGet || requestedKey !== key) return snapshot;
                holdNextGet = false;
                await new Promise(resolve => { releaseGet = resolve; });
                // 放行时重新取当期值：模拟真实的"读发生在写入之后"。
                return structuredClone({ [key]: memory[key] });
            }
        });
        holdNextGet = true;
        const pending = context.updateExecutionState('temu:111', memory[key].executionRunId, () => ({ receiptPending: true }));
        // 等旧轮次的读取到快照并卡住，再写入新轮次。
        await new Promise(resolve => setTimeout(resolve, 30));
        const newRunId = 'probe-new-round-222';
        memory[key] = { ...memory[key], executionRunId: newRunId, paused: false, pendingStop: false };
        if (releaseGet) releaseGet();
        const applied = await pending;
        assert.equal(applied, false, '旧轮次的更新没有放弃写入');
        assert.equal(memory[key].executionRunId, newRunId, '旧回执把状态覆盖回了旧轮次');
        assert.equal(memory[key].paused, false, '旧回执把新轮次改成了已暂停');
        assert.equal(memory[key].receiptPending, undefined, '旧回执把字段写进了新轮次');
    });

    // 同一店铺的状态写入必须串行：并发写入不能互相丢字段。
    await check('同一店铺并发状态写入不得互相覆盖', async () => {
        const { context, memory } = pluginFixture({});
        const key = 'directPause:temu:111';
        const runId = memory[key].executionRunId;
        // 并发发起两笔针对同一轮次的不同字段更新；串行化后两者都必须保留。
        await Promise.all([
            context.updateExecutionState('temu:111', runId, () => ({ receiptPending: true })),
            context.updateExecutionState('temu:111', runId, () => ({ pendingStop: false }))
        ]);
        assert.equal(memory[key].receiptPending, true, '并发写丢失了 receiptPending');
        assert.equal(memory[key].pendingStop, false, '并发写丢失了 pendingStop');
        assert.equal(memory[key].executionRunId, runId, '并发写改动了轮次编号');
    });

    // 形参错位是一类静默缺陷：调用点少传一个实参时，实参整体左移，
    // updateExecutionState 拿 runId 当店铺、拿布尔值当轮次，判定必然不匹配，
    // 于是整次写入被安静地丢掉——既不报错也没有任何日志。
    // 这里断言"标记真的落到目标轮次上"，而不是断言"调用没抛错"。
    await check('回执补发标记必须真正落盘到本轮', async () => {
        const { context, memory } = pluginFixture({});
        const key = 'directPause:temu:111';
        const runId = memory[key].executionRunId;
        await context.markReceiptPending('temu:111', runId, true);
        assert.equal(memory[key].receiptPending, true, '成功路径的回执标记没有落到本轮（形参错位？）');
        await context.markReceiptPending('temu:111', runId, false);
        assert.equal(memory[key].receiptPending, false, '清除回执标记时没有落到本轮');
        assert.equal(memory[key].executionRunId, runId, '标记回执时改动了轮次编号');
    });

    // 上一条只证明函数本身可用；这里走真实入口，防止调用点又把参数传错。
    await check('停止流程的回执结果必须真实记录到本轮状态', async () => {
        const { context, memory, calls } = pluginFixture({ receiptFails: true });
        const key = 'directPause:temu:111';
        const runId = memory[key].executionRunId;
        await context.flushExecutionStops();
        assert.equal(calls.filter(call => call.action === 'stop').length, 1, '停止通知未发出');
        // 标记回执的那一步刻意不 await（回执不许拖住停止），所以要等它自己落盘。
        const deadline = Date.now() + 2000;
        while (memory[key].receiptPending === undefined && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 20));
        }
        // 回执恢复失败 → 必须留下待补标记；调用点传错参数会让这个字段永远不出现。
        assert.equal(memory[key].receiptPending, true, '回执恢复失败后没有在本轮记下待补标记（调用点形参错位？）');
        assert.equal(memory[key].executionRunId, runId, '记录回执标记时改动了轮次编号');
    });

    await check('A店停止请求挂起时B店启用不得等待该请求返回', async () => {
        let releaseStop, timer;
        const stopWait = new Promise(resolve => { releaseStop = resolve; });
        const { context } = pluginFixture({ stopWait });
        const work = context.startExecutionRound({ tab: { id: 2 }, documentId: 'probe-document-b' },
            { storeId: 'temu:222', mallId: '222' });
        // 250ms只是纯内存探针的挂起检测上限，不是线上性能承诺；释放闸门后收尾，不留后台任务。
        try {
            const outcome = await Promise.race([
                work.then(() => 'started', error => `error:${error.message}`),
                new Promise(resolve => { timer = setTimeout(() => resolve('blocked-by-old-stop'), 250); })
            ]);
            assert.equal(outcome, 'started', 'B店启用仍等待A店挂起的停止请求');
        } finally {
            clearTimeout(timer);
            releaseStop();
            await work.catch(() => {});
        }
    });

    await check('上传队列满额拒绝新任务且不淘汰原任务', async () => {
        const now = Date.now();
        const jobs = Array.from({ length: 10 }, (_, index) => ingestQueue.normalizeJob({
            eventIds: [`existing-${index}`], allowedSpuIds: [String(index + 1)], createdAt: new Date(now + index).toISOString()
        }, now));
        const next = ingestQueue.upsertJobWithEviction(jobs, {
            eventIds: ['incoming'], allowedSpuIds: ['99'], createdAt: new Date(now + 20).toISOString()
        }, now);
        assert.deepEqual(next.jobs, jobs);
        assert.equal(next.evicted.length, 1);
        assert.equal(next.evicted[0].allowedSpuIds[0], '99');
        return '现行容量保护符合保留旧任务的要求；旧脚本期望淘汰最早任务的断言需要更新';
    });

    const report = { generatedAt: new Date().toISOString(), scope: 'local-file-state-and-vm-only',
        productionChanged: false, realNetworkRequests: 0, results };
    const output = fileURLToPath(new URL('../../test-artifacts/queue-isolation-boundaries.json', import.meta.url));
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report, null, 2));
    if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
} finally {
    // 仅清除本脚本创建且位于系统临时目录下的专属目录，异常路径保留现场。
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('temu-isolation-probe-')) {
        throw Error('临时目录边界异常，拒绝清理');
    }
    await rm(resolved, { recursive: true, force: true });
}
