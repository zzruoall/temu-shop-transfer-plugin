/** 可控时钟验证容量变化，不使用主机空闲内存冒充线上容量证据。 */
import assert from 'node:assert/strict';
import { createElasticAllocation, readElasticAllocationConfig } from '../lib/elastic-allocation.mjs';
let clock = 1000;
const policy = createElasticAllocation({ now: () => clock });
const MiB = 1024 * 1024;
const sample = { ok: true, memoryMaxBytes: 768 * MiB, memoryCurrentBytes: 100 * MiB,
    cpuMax: { quotaUs: 60000, periodUs: 100000 }, mode: 'healthy', canStartNewWork: true, canAuthorizeBusiness: true };
assert.equal(policy.snapshot().businessLimit, 0);
assert.equal(policy.update(sample).businessLimit, 1);
for (let i = 0; i < 12; i++) { clock += 5000; policy.update(sample); }
assert.equal(policy.snapshot().businessLimit, 2);
assert.equal(policy.snapshot().processLimit, 1);
assert.equal(policy.update({ ...sample, memoryCurrentBytes: 650 * MiB }).businessLimit, 0);
clock += 5000;
assert.equal(policy.update(sample).businessLimit, 0, '恢复必须有稳定观察窗口');
for (let i = 0; i < 12; i++) { clock += 5000; policy.update(sample); }
assert.equal(policy.snapshot().businessLimit, 1);
clock += 16000;
assert.equal(policy.snapshot().businessLimit, 0, '采样过期拒绝准入');
assert.equal(policy.update({ ...sample, ok: false }).businessLimit, 0);
assert.equal(policy.update({ ...sample, memoryCurrentBytes: null }).businessLimit, 0);
assert.equal(policy.update({ ...sample, activeBusiness: Infinity }).businessLimit, 0);
assert.equal(policy.update({ ...sample, cpuMax: { quotaUs: Infinity, periodUs: 100000 } }).businessLimit, 0);
assert.equal(policy.update({ ...sample, memoryMaxBytes: 100 * MiB, memoryCurrentBytes: 80 * MiB }).processLimit, 0);
assert.equal(policy.update({ ...sample, mode: 'constrained' }).businessLimit, 0);
assert.equal(policy.update({ ...sample, canAuthorizeBusiness: false }).publishLimit, 0);
assert.throws(() => readElasticAllocationConfig({ ZINIAO_ELASTIC_BUSINESS_MAX: '0' }));
assert.throws(() => readElasticAllocationConfig({ ZINIAO_ELASTIC_PROCESS_MAX: 'abc' }));
const expanded = createElasticAllocation({ config: { businessMax: 4, accountMax: 4, processMax: 4, publishMax: 4 }, now: () => clock });
for (let i = 0; i < 60; i++) { clock += 5000; expanded.update({ ...sample, memoryMaxBytes: 4096 * MiB, cpuMax: { quotaUs: 400000, periodUs: 100000 } }); }
assert.equal(expanded.snapshot().businessLimit, 4);
assert.equal(expanded.snapshot().processLimit, 4);
// 已准备商品不依赖再次fork；模拟十分钟余量不足仍须允许原发布工作取得许可。
const preparedPolicy = createElasticAllocation({ now: () => clock });
for (let i = 0; i < 13; i++) { clock += 5000; preparedPolicy.update({ ...sample, activeBusiness: 2 }); }
for (let i = 0; i < 120; i++) {
    clock += 5000;
    const waiting = preparedPolicy.update({ ...sample, memoryCurrentBytes: 360 * MiB, activeBusiness: 2, activeProcesses: 0 });
    assert.equal(waiting.processLimit, 0);
    assert.equal(waiting.publishLimit, 2);
}
const cpuWaiting = preparedPolicy.update({ ...sample, activeBusiness: 2, canStartNewWork: false, processLimit: 0 });
assert.equal(cpuWaiting.processLimit, 0);
assert.equal(cpuWaiting.publishLimit, 2);
console.log('PASS elastic capacity: startup/growth/pressure/recovery/staleness/unknown/low-memory/config/CPU/hard-cap');
