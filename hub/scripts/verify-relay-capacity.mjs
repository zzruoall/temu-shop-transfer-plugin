import test from 'node:test';
import assert from 'node:assert/strict';
import { relayResourceCapacity } from '../lib/relay-resource-capacity.mjs';
import { createIngestAdmission } from '../lib/ingest-admission.mjs';

const MiB = 1024 * 1024;
const healthy = { canAcceptNewStaging: true, canAuthorizeBusiness: true };
const base = { budget: healthy, sampledAt: 1000, now: 1000, database: true,
    sample: { memoryMaxBytes: 768 * MiB, memoryCurrentBytes: 300 * MiB }, max: 2 };

test('收发只按真实余量准入，不用整机内存；预算缺失或过期关闭生产入口', () => {
    assert.equal(relayResourceCapacity(base), 2);
    assert.equal(relayResourceCapacity({ ...base, now: 17000 }), 0);
    assert.equal(relayResourceCapacity({ ...base, budget: null }), 0);
    assert.equal(relayResourceCapacity({ ...base, sample: {} }), 0);
    assert.equal(relayResourceCapacity({ ...base, budget: { ...healthy, canAcceptNewStaging: false } }), 0);
    assert.equal(relayResourceCapacity({ ...base, sample: { ...base.sample, memoryCurrentBytes: 520 * MiB } }), 0);
    assert.equal(relayResourceCapacity({ ...base, budget: null, database: false }), 1);
});

test('同一有界准入同时覆盖上传和发送，缩容不取消已受理内容，恢复自动唤醒', async () => {
    let capacity = 2;
    const admission = createIngestAdmission({ limit: 2, capacity: () => capacity, waitMs: 2000 });
    const upload = await admission.acquire(100, null, 'A');
    const relay = await admission.acquire(100, null, 'A');
    assert.equal(admission.snapshotActive(), 2);
    let admitted = false;
    const pending = admission.acquire(100, null, 'B').then(release => { admitted = true; return release; });
    capacity = 0; upload(); relay();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(admitted, false);
    capacity = 1; admission.refreshCapacity();
    (await pending)();
    assert.equal(admission.snapshotActive(), 0);
});
