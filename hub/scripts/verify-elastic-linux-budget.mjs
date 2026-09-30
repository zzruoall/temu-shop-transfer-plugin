/** 在候选cgroup内采样真实CPU/内存；只验证保守配额增长，不提交任何业务或连接生产库。 */
import assert from 'node:assert/strict';
import { createRuntimeResourceBudget, readCgroupSample } from '../lib/runtime-resource-budget.mjs';
import { createElasticAllocation } from '../lib/elastic-allocation.mjs';
let raw;
const policy = createElasticAllocation();
const budget = createRuntimeResourceBudget({ config: { processLimit: 1 }, probe: async () => {
    raw = await readCgroupSample(); return { ...raw, dbWaitMs: 0, loopLagMs: 0 };
} });
let peak = 0, grew = false;
for (let index = 0; index < 15; index++) {
    const result = await budget.sample();
    assert.equal(raw.ok, true);
    assert.equal(raw.memoryMaxBytes, 768 * 1024 * 1024);
    assert.equal(raw.cpuMax.quotaUs / raw.cpuMax.periodUs, 0.6);
    const allocation = policy.update({ ...raw, ...result, activeBusiness: 0, activeProcesses: 0 });
    peak = Math.max(peak, raw.memoryCurrentBytes);
    grew ||= allocation.businessLimit === 2;
    assert.ok(allocation.processLimit <= 1 && allocation.businessLimit <= 2);
    console.log(JSON.stringify({ index, memory: raw.memoryCurrentBytes, allocation }));
    if (grew) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
}
assert.equal(grew, true, '真实限额下应从1增长到2');
console.log(JSON.stringify({ linuxBudget: true, peakSampledMemory: peak, realPlatformCalls: 0 }));
