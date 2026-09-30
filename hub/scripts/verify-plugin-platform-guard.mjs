/** 用真实后台占用函数模拟跨标签采集/发布互斥及云端限流重试，不连接浏览器或平台。 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { directExecutorFixture } from './direct-platform-fixture.mjs';

const session = {}, local = {};
const ctx = vm.createContext({ console, crypto, setTimeout, clearTimeout, chrome: { storage: {
    session: { get: async () => session }, local: { get: async () => local }
} } });
vm.runInContext(await directExecutorFixture(), ctx);
session['captureEnabledTab:1'] = true;
assert.equal(await vm.runInContext("acquirePlatformForDirect(2, 'temu:1')", ctx), false);
session['captureEnabledTab:1'] = false;
session['detailSupplementTab:1'] = { active: false, platformUncertain: true };
assert.equal(await vm.runInContext("acquirePlatformForDirect(2, 'temu:1')", ctx), false);
session['detailSupplementTab:1'] = { active: false, finalizationPending: true };
// 已采集数据等待上传不占平台锁；同店两个标签竞争时只能一个获得执行权。
const results = await vm.runInContext("Promise.all([acquirePlatformForDirect(2, 'temu:1'), acquirePlatformForDirect(3, 'temu:1')])", ctx);
assert.equal(results.filter(Boolean).length, 1);
await assert.rejects(vm.runInContext('assertPlatformAvailableForCapture()', ctx), /正在发布/);
assert.equal(await vm.runInContext("acquirePlatformForDirect(4, 'temu:2')", ctx), true);
vm.runInContext('directRunningTabs.clear(); directRunningStores.clear();', ctx);
local['directAttempt:job:spu'] = { stage: 'submitting' };
await assert.rejects(vm.runInContext('assertPlatformAvailableForCapture()', ctx), /待核对/);
local['directAttempt:job:spu'] = { stage: 'created', done: true };
await vm.runInContext('assertPlatformAvailableForCapture()', ctx);

const background = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
const start = background.indexOf('async function runPendingIngest()');
const end = background.indexOf('/** 队列读写必须串行', start);
const rounds = await readFile(new URL('../../plugin/execution-round.js', import.meta.url), 'utf8');
const pruneStart = rounds.indexOf('async function pruneInactiveIngestJobs(jobs)');
const pruneEnd = rounds.indexOf('async function assertExecutionDocument', pruneStart);
assert.ok(start >= 0 && end > start && pruneStart >= 0 && pruneEnd > pruneStart, '真实函数边界必须完整');
const binding = { tabId: 1, documentId: 'capture-document', version: '10.10.60', epoch: 'capture-epoch' };
let jobs = [], outcomeWrites = 0, uploads = 0;
const retired = [];
const ingest = vm.createContext({ console, Date, Math, Error, Promise, PERMANENT_INGEST_ERRORS: new Set(),
    withIngestStore: async action => action(), loadPendingIngestJobs: async () => jobs,
    savePendingIngestJobs: async next => { jobs = next; return next; },
    ingestQueueStatusFor: async () => ({ pendingCount: jobs.length }), schedulePendingIngestAlarm: async () => {},
    recordIngestOutcome: async () => { outcomeWrites++; },
    // 平台文档仅作隔离模拟，过期项的全队列清理由真实 prune 函数执行。
    isIngestPageActive: async value => value?.documentId === binding.documentId && value.version === binding.version && value.epoch === binding.epoch,
    retireIngestJob: async job => { retired.push(job.id); outcomeWrites++; },
    pushFullPacket: async () => { uploads++; throw Error('ingest_capacity_wait'); }
});
vm.runInContext(await readFile(new URL('../../plugin/ingest-queue.js', import.meta.url), 'utf8'), ingest);
ingest.binding = binding;
jobs = vm.runInContext("TemuIngestQueue.migrateLegacyJobs([{pageBinding:binding,eventIds:['event'],allowedSpuIds:['9100000000'],attempts:4,nextAttemptAt:'2020-01-01T00:00:00Z'}],null)", ingest);
vm.runInContext(rounds.slice(pruneStart, pruneEnd), ingest);
vm.runInContext(background.slice(start, end), ingest);
await assert.rejects(vm.runInContext('runPendingIngest()', ingest), /ingest_capacity_wait/);
assert.equal(jobs.length, 1);
assert.equal(jobs[0].attempts, 4, '容量等待不能耗尽失败额度');
assert.ok(Date.parse(jobs[0].nextAttemptAt) > Date.now());
assert.equal(outcomeWrites, 0, '排队不能写成业务失败');
// 升级失效项即使尚未到期或已耗尽重试次数，也应退出队列，不能在后台唤醒时上传。
jobs.push(...['future', 'exhausted'].map((id, index) => ({ ...structuredClone(jobs[0]), id,
    pageBinding: { ...binding, version: '10.10.59' }, attempts: index ? 5 : 0,
    nextAttemptAt: new Date(Date.now() + 3600000).toISOString() })));
await vm.runInContext('runPendingIngest()', ingest);
assert.equal(jobs.length, 1);
assert.deepEqual(retired, ['future', 'exhausted']);
assert.equal(uploads, 1, '后台清理旧轮只保留核对结果，不重发大包');
console.log('PASS: capture/publish exclusion, same-store cross-tab lock, cloud upload independent, pending submission guard, capacity retry without failure budget');
