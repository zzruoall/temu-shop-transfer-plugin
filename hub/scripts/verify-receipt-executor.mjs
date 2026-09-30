/** 使用真实执行器和回执队列模拟后台重启，全程不访问店铺或生产服务。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { directExecutorFixture } from './direct-platform-fixture.mjs';
const executor = await directExecutorFixture({ executionRounds: true });
const receipts = await readFile(new URL('../../plugin/direct-receipts.js', import.meta.url), 'utf8');
for (const scenario of ['created-offline', 'rejected-offline', 'unknown-offline', 'preservation-failed', 'capacity-wait']) {
    // 同文档后台重启保留有效轮次，但持久化回执不依赖轮次仍处于启用状态。
    const identity = { storeId: 'temu:123', mallId: '123', tabId: 1, documentId: 'receipt-document',
        executionRunProtocol: 1, executionRunId: 'receipt-execution-round' };
    const memory = { 'directPause:temu:123': { ...identity, paused: false, enabledVersion: '10.10.60' } }, reports = [];
    let submits = 0, online = false, now = Date.now(), begins = 0;
    const task = { jobId: 'job', spuId: '9100894431', targetStoreId: 'temu:123', executionRunId: identity.executionRunId, claimToken: 'test', directCreate: true,
        directRetrySequence: 0, snapshot: { publicationData: { sourceProduct: { productId: '9100894431' } } } };
    /** 重启只重建 JS 上下文，storage 中的执行记录与待报回执保持原样。 */
    function boot() {
        const ctx = vm.createContext({ console, crypto, Set, Map, Promise, setTimeout, clearTimeout,
            Date: class extends Date { static now() { return now; } },
            chrome: { runtime: { getManifest: () => ({ version: '10.10.60' }) }, alarms: { create: async () => {} },
                storage: { local: { get: async key => structuredClone(key === null ? memory : { [key]: memory[key] }),
                    set: async data => Object.assign(memory, structuredClone(data)), remove: async key => { delete memory[key]; } } },
                scripting: { executeScript: async spec => {
                    if (spec.files) return [];
                    if (!spec.args) {
                        assert.equal(spec.target.tabId, identity.tabId);
                        assert.equal(spec.target.documentIds?.[0], identity.documentId);
                        return [{ documentId: identity.documentId, result: { visible: true } }];
                    }
                    const [op] = spec.args;
                    if (typeof op === 'object') return [{ result: { state: 'not_found' } }];
                    if (op === 'identity') return [{ result: { mallId: '123' } }];
                    if (op === 'prepare') return [{ result: { request: { productName: 'test' }, hash: 'a'.repeat(64) } }];
                    if (op === 'preserve') {
                        if (scenario === 'preservation-failed') throw Error('来源字段在转换中丢失或改变：SKU价格');
                        return [{ result: { preserved: true } }];
                    }
                    if (op === 'submit') { submits++; return [{ result: { started: true } }]; }
                    if (op === 'submit-status') return [{ result: scenario === 'rejected-offline'
                        ? { state: 'rejected', error: '目标类目拒绝' }
                        : scenario === 'unknown-offline' ? { state: 'unknown', error: '网络超时', transient: true }
                        : { state: 'created', productId: '8002250622' } }];
                    if (op === 'verify') return [{ result: { verified: true } }];
                    return [{ result: {} }];
                } } },
            getTargetUploadTasks: async () => [task], getPluginInstanceId: async () => 'test-instance',
            TemuOperationLog: { append: async () => {} },
            hubJson: async (_url, body) => {
                reports.push(structuredClone(body));
                if (body.phase === 'begin') {
                    if (scenario === 'capacity-wait' && begins++ === 0) return { state: 'waiting', scheduling: { protocol: 1, action: 'wait', reasonCode: 'direct_capacity_wait', retryAfterMs: 15000 } };
                    return { attemptId: 'attempt', state: 'creating', resumed: false };
                }
                if (!online) throw Error('offline');
                return { attemptId: 'attempt', state: body.phase };
            } });
        vm.runInContext(receipts + '\n' + executor, ctx);
        ctx.identity = identity;
        return ctx;
    }
    let ctx = boot();
    await vm.runInContext('runDirectTasks(1, identity)', ctx);
    if (scenario === 'capacity-wait') {
        assert.equal(submits, 0);
        ctx = boot();
        for (let i = 0; i < 20; i++) await vm.runInContext('runDirectTasks(1, identity)', ctx);
        assert.equal(begins, 1, '重启和心跳不得绕过已落盘的等待期限');
        now += 21000;
        await vm.runInContext('runDirectTasks(1, identity)', ctx);
        assert.equal(submits, 1);
    }
    const pending = Object.entries(memory).filter(([key]) => key.startsWith('directReceiptV1:'));
    assert.equal(pending.length, 1, scenario + ' 必须先持久化结果');
    assert.equal(submits, scenario === 'preservation-failed' ? 0 : 1);
    const expected = ['created-offline', 'capacity-wait'].includes(scenario) ? 'created' : scenario === 'unknown-offline' ? 'unknown' : scenario === 'rejected-offline' ? 'rejected' : 'preflight_failed';
    assert.equal(pending[0][1].body.phase, expected);
    const id = pending[0][1].body.receiptId;
    memory['directPause:temu:123'].paused = true;
    ctx = boot(); online = true; now += 41000;
    await vm.runInContext('TemuDirectReceipts.flush()', ctx);
    await vm.runInContext('runDirectTasks(1, identity)', ctx);
    assert.equal(submits, scenario === 'preservation-failed' ? 0 : 1, '重启后不得再次提交');
    assert.equal(Object.keys(memory).filter(key => key.startsWith('directReceiptV1:')).length, 0);
    assert.equal(reports.at(-1).receiptId, id);
}
console.log('执行器与回执队列隔离验证通过：成功、明确拒绝、未知结果、转换丢字段；真实平台请求为 0');
