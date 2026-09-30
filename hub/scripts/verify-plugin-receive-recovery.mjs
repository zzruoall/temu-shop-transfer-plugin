/** 执行真实后台接收函数与哈希实现，使用内存storage和假HTTP，不访问平台也不改真实浏览器。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const background = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
const integrity = await readFile(new URL('../../plugin/transfer-integrity.js', import.meta.url), 'utf8');
const storageFunctions = background.slice(background.indexOf('const TARGET_UPLOAD_TASKS_KEY'), background.indexOf('async function retryDirectTask'));
const reportFunction = background.slice(background.indexOf('async function reportTargetUploadTask'), background.indexOf('async function downloadTargetUploadTask'));
const claimFunction = background.slice(background.indexOf('async function claimStoreJobs'), background.indexOf('async function setDirectCreatePaused'));
const memory = {}, refs = [];
let claims = [], calls = 0, reports = 0, replies = [];
const context = vm.createContext({ console, crypto, TextEncoder, structuredClone,
    chrome: { runtime: { getManifest: () => ({ version: '10.10.57' }) }, storage: { local: {
        get: async key => structuredClone({ [key]: memory[key] }), set: async value => Object.assign(memory, structuredClone(value)),
        remove: async key => { for (const k of Array.isArray(key) ? key : [key]) delete memory[k]; }
    } } },
    getUtf8ByteLength: value => Buffer.byteLength(value), getBoundStore: async () => ({ storeId: 'temu:123', storeName: 'test' }),
    boundMatchesPage: () => true, getPluginInstanceId: async () => 'instance', readDirectPause: async () => false,
    TemuOperationLog: { append: async () => {} }, reportStoreJob: async () => { reports++; throw Error('offline'); },
    hubJson: async (_url, body) => { refs.push(structuredClone(body)); return { claimed: calls++ ? [] : claims, receivedReceipts: replies }; }
});
vm.runInContext(integrity + '\n' + storageFunctions + '\n' + reportFunction + '\n' + claimFunction, context);
for (let i = 0; i < 30; i++) {
    const snapshot = { spuId: String(i), publicationData: { sourceProduct: { productId: String(i) } } };
    context.snapshot = snapshot;
    const manifest = await vm.runInContext('TemuTransferIntegrity.manifest(snapshot)', context);
    claims.push({ jobId: 'job', spuId: String(i), mode: 'manual-plugin-upload', targetStoreId: 'temu:123', claimToken: `old-${i}`, directCreate: true, snapshot, transferIntegrity: manifest });
}
context.identity = { storeId: 'temu:123', storeName: 'test', pageStoreName: 'test', identityMatched: true };
await vm.runInContext('claimStoreJobs(identity)', context);
assert.equal(reports, 1, '断网只等待一次失败，不能让30件逐个超时');
assert.equal(memory.targetUploadTasksV1.length, 30);
assert.ok(memory.targetUploadTasksV1.every(task => task.receivePending));
replies = claims.map(task => ({ jobId: task.jobId, spuId: task.spuId, status: 'received', claimToken: `new-${task.spuId}`, transferIntegrity: task.transferIntegrity }));
const result = await vm.runInContext('claimStoreJobs(identity)', context);
assert.equal(refs[1].pendingUploadCount, 30); assert.equal(refs[1].receivedReceipts.length, 30);
assert.ok(memory.targetUploadTasksV1.every(task => !task.receivePending && task.claimToken === `new-${task.spuId}`));
assert.equal(result.receivedReceipts, undefined);
assert.ok(!JSON.stringify(result).includes('claimToken'), '恢复凭证不能透传页面');
replies = [{ jobId: 'job', spuId: '0', reload: true }, { jobId: 'job', spuId: '1', release: true }];
await vm.runInContext('claimStoreJobs(identity)', context);
assert.equal(memory.targetUploadTasksV1.length, 28);
console.log(JSON.stringify({ passed: true, fullInboxRecovered: 30, privateTokens: true, retryGenerationReleased: true, realPlatformRequests: 0 }));
