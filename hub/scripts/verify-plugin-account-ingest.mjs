/** 真实插件函数的VM回归，网络和Chrome存储均为替身，不接触任何店铺。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
const background = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
const rounds = await readFile(new URL('../../plugin/execution-round.js', import.meta.url), 'utf8');
const start = background.indexOf('async function pushFullPacketNow(');
const end = background.indexOf('async function maybeAutoPushFullPacket', start);
assert.ok(start > 0 && end > start);
const binding = { tabId: 1, documentId: 'doc', version: '10.10.67', epoch: '', memoryEpoch: 0 };
const memory = {}, outbox = new Map(), calls = [];
let state = 'queued', posts = 0, completions = 0, version = binding.version, cancelFails = false;
const packet = { products: [{ spuId: '1' }], records: [{}], source: { sourceStoreId: 'temu:123' } };
const transferIntegrity = { algorithm: 'sha256-json-v1', sha256: 'a'.repeat(64) };
const frozen = () => ({ packet, fileName: 'capture.json', requestId: 'stable-request-id-1234', transferIntegrity, pageBinding: binding });
outbox.set('auto', frozen());
const local = { get: async key => structuredClone(key === null ? memory : { [key]: memory[key] }),
    set: async value => Object.assign(memory, structuredClone(value)), remove: async key => { delete memory[key]; } };
const ctx = vm.createContext({ console, crypto: webcrypto, TextEncoder, AbortController, setTimeout, clearTimeout,
    chrome: { runtime: { getManifest: () => ({ version }) }, storage: { local, session: local }, alarms: { create() {} },
        scripting: { executeScript: async () => [{ documentId: 'doc' }] } },
    bootstrapIngestToken: async settings => settings, getIngestSettings: async () => ({ endpoint: 'https://fixture/api/ingest', token: 'fixture' }),
    ensureIngestPermission: async () => true, getPluginInstanceId: async () => 'instance',
    getUtf8ByteLength: value => Buffer.byteLength(value), hubApiUrl: (_endpoint, route) => route,
    TemuTransferIntegrity: { manifest: async () => transferIntegrity },
    TemuIngestOutbox: { get: async id => outbox.get(id), put: async (id, value) => outbox.set(id, value),
        complete: async id => { completions++; outbox.delete(id); }, retire: async id => { outbox.delete(id); } },
    hubJson: async (route, body) => {
        calls.push({ route, body });
        if (route.endsWith('/cancel')) { if (cancelFails) throw Error('offline'); return { state: 'cancelled' }; }
        return posts ? { state, receipt: state === 'completed' ? { batchId: 'batch', transferIntegrity: { ...transferIntegrity, receivedSha256: transferIntegrity.sha256, verified: true } } : undefined } : { state: 'ready', token: 'permit' };
    },
    authenticatedIngestFetch: async (_url, _settings, options) => {
        if (options.method === 'POST') { posts++; return { ok: true, status: 202, json: async () => ({ accepted: true, state: 'queued' }) }; }
        return { ok: true, status: 200, json: async () => ({ state, receipt: { batchId: 'batch', transferIntegrity: { ...transferIntegrity, receivedSha256: transferIntegrity.sha256, verified: true } } }) };
    },
    captureEnabledKey: id => `capture:${id}`, withIngestStore: fn => fn(), loadPendingIngestJobs: async () => [], savePendingIngestJobs: async () => {},
    recordIngestOutcome: async () => {}
});
vm.runInContext(rounds.slice(0, rounds.indexOf('/**\n * 同一店铺的停写')) + background.slice(start, end), ctx);
ctx.options = { jobId: 'auto', pageBinding: binding };
await assert.rejects(vm.runInContext('pushFullPacketNow(options)', ctx), error => error.scheduling?.action === 'reconcile');
assert.equal(completions, 0); assert.equal(posts, 1); assert.ok(outbox.has('auto'));
await assert.rejects(vm.runInContext('pushFullPacketNow(options)', ctx), error => error.scheduling?.action === 'reconcile');
assert.equal(posts, 1, 'queued重试只查询，不再上传正文');
state = 'completed';
await vm.runInContext('pushFullPacketNow(options)', ctx);
assert.equal(completions, 1); assert.equal(posts, 1);
state = 'failed'; outbox.set('auto', frozen());
await assert.rejects(vm.runInContext('pushFullPacketNow(options)', ctx), error => error.scheduling?.action === 'stop');
assert.equal(completions, 1);
// 手动请求不在自动队列，刷新仍要先持久化取消并退休原包，断网后只补取消。
outbox.set('manual', frozen());
memory['ingestRequest:manual-request-1234'] = { requestId: 'manual-request-1234', outboxId: 'manual', pageBinding: binding };
cancelFails = true;
await vm.runInContext('invalidateIngestTab(1)', ctx);
await vm.runInContext('flushIngestStops()', ctx);
assert.equal(outbox.has('manual'), false);
assert.ok(memory['ingestStop:manual-request-1234']);
cancelFails = false;
await vm.runInContext('flushIngestStops()', ctx);
assert.equal(memory['ingestStop:manual-request-1234'], undefined);
assert.equal(posts, 1, '停止补发通道绝不上传商品');
console.log('插件202等待、查询重试、完成核验、失败停止、手动刷新取消、断网补取消6项通过');
