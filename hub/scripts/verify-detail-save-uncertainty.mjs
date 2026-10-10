/** 执行真实内容脚本队列函数，验证页面查询到后台资料保存失败之间的不明结果不会丢失。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../../plugin/content-app.js', import.meta.url), 'utf8');
const match = /^    async function runApiDetailQueue\(/m.exec(source);
assert.ok(match);
const tail = source.slice(match.index), end = /^    }\r?$/m.exec(tail);
assert.ok(end);
const fn = tail.slice(0, end.index + end[0].length);

for (const uncertain of [true, false]) for (const transport of [true, false]) {
    test(`资质结果不明=${uncertain}，保存${transport ? '消息抛错' : '返回失败'}仍保留查询标记`, async () => {
        const messages = [];
        const state = { apiRunning: false, enabled: true, runGeneration: 1, pageKey: 'same', pendingWrites: 0, failed: 0, productFailures: 0 };
        const ctx = vm.createContext({ state, setTimeout, render: () => {}, syncPageContext: () => {},
            queryApiDetail: async () => ({ payload: {}, qualifications: {}, stopBatch: true, queryUncertain: uncertain }),
            send: async (type, value) => {
                messages.push({ type, value });
                if (type === 'captureApiDetail') { if (transport) throw Error('保存接口timeout业务拒绝');return { ok: false, error: 'QuotaExceededError' }; }
                return { ok: true, active: false, status: 'partial' };
            }, restoreFinishedDetailSupplement: () => {}, makeRunSummary: () => ({}), refreshStats: async () => {} });
        vm.runInContext(fn, ctx);
        await ctx.runApiDetailQueue({ mode: 'api', active: true, current: { spuId: '8044560175' }, runId: 'run', completed: 0, total: 1 });
        assert.equal(messages.find(message => message.type === 'advanceDetailSupplement').value.input.queryUncertain, uncertain);
        assert.equal(state.apiRunning, false);
    });
}
