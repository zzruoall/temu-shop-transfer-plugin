/** 提取生产上传函数，模拟首请求回执丢失后重启；验证固定原包查询且不重复发正文。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
const excerpt = source.slice(source.indexOf('function stampPacketName('), source.indexOf('async function maybeAutoPushFullPacket('));
const integrity = await readFile(new URL('../../plugin/transfer-integrity.js', import.meta.url), 'utf8');
const queue = await readFile(new URL('../../plugin/ingest-queue.js', import.meta.url), 'utf8');
const memory = new Map(), prepare = [];
let reads = 0, posts = 0, saved;
function boot() {
    const context = vm.createContext({ crypto, TextEncoder, AbortController, setTimeout, clearTimeout,
        getIngestSettings: async () => ({ endpoint: 'https://fixture.invalid/api/ingest', token: 'fixture' }),
        bootstrapIngestToken: async settings => settings, ensureIngestPermission: async () => true,
        getAllRecords: async () => { reads++; return [{ eventId: 'event', value: reads }]; },
        packetSourceOptions: async options => options,
        makeFullCapturePacket: records => ({ records, exportedAt: new Date().toISOString(), products: [{ spuId: '1' }], source: { sourceStoreId: 'temu:123', shopName: '测试' } }),
        getPluginInstanceId: async () => 'fixture', getUtf8ByteLength: value => Buffer.byteLength(value),
        TemuIngestOutbox: { get: async id => structuredClone(memory.get(id)), put: async (id, value) => { memory.set(id, structuredClone(value)); }, remove: async id => { memory.delete(id); } },
        hubJson: async (_url, body) => {
            prepare.push(structuredClone(body));
            return saved ? { state: 'completed', receipt: saved } : { state: 'ready', token: 'fixture' };
        },
        authenticatedIngestFetch: async (_url, _settings, options) => {
            posts++;
            const body = JSON.parse(options.body);
            saved = { batchId: 'fixture-batch', transferIntegrity: { verified: true, algorithm: body.transferIntegrity.algorithm, receivedSha256: body.transferIntegrity.sha256 } };
            throw new TypeError('Failed to fetch');
        }
    });
    vm.runInContext(integrity + '\n' + queue + '\n' + excerpt, context);
    return context;
}
let context = boot();
await assert.rejects(context.pushFullPacket({ jobId: 'task', eventIds: ['event'] }), /Failed to fetch/);
assert.equal(memory.size, 1);
context = boot();
const result = await context.pushFullPacket({ jobId: 'task', eventIds: ['event'] });
assert.equal(result.batchId, 'fixture-batch'); assert.equal(memory.size, 0);
assert.equal(posts, 1); assert.equal(reads, 1);
assert.equal(prepare[0].requestId, prepare[1].requestId); assert.equal(prepare[0].sha256, prepare[1].sha256);
let jobs = [];
for (let i = 0; i < 10; i++) jobs = context.TemuIngestQueue.upsertJob(jobs, { eventIds: [String(i)], allowedSpuIds: [String(i)] });
const original = jobs.map(job => job.id);
const overflow = context.TemuIngestQueue.upsertJobWithEviction(jobs, { eventIds: ['extra'], allowedSpuIds: ['extra'] });
assert.deepEqual(overflow.jobs.map(job => job.id), original); assert.equal(overflow.evicted.length, 1);
console.log(JSON.stringify({ passed: true, immutablePacket: true, restartReceiptLookup: true, bodyPosts: posts, fullQueuePreservesOldJobs: true }));
