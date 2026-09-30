/** 用真实发送入口和插件收件函数验证单次操作去重；不连接线上或调用平台。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { test } from 'node:test';
import { transferManifest } from '../lib/transfer-integrity.mjs';

const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
const integrity = await readFile(new URL('../../plugin/transfer-integrity.js', import.meta.url), 'utf8');

test('每次主动发送使用新编号，包括上次响应丢失后再次点击', async () => {
    const bodies = [], saved = new Map();
    const context = vm.createContext({ crypto: globalThis.crypto,
        sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) },
        api: async (_url, options) => {
            bodies.push(JSON.parse(options.body));
            if (bodies.length === 1) throw Error('响应丢失');
            return { batch: { id: 'batch' } };
        } });
    vm.runInContext(app.slice(app.indexOf('async function submitBulkManifest('), app.indexOf('async function submitSingleProduct(')), context);
    const send = () => context.submitBulkManifest([{ sourceStoreId: 'source', sourceBatchId: 'batch', spuIds: ['p'] }], [{ storeId: 'target' }]);
    await assert.rejects(send(), /响应丢失/);
    await send();
    await send();
    assert.equal(new Set(bodies.map(body => body.requestId)).size, 3);
});

/** 存储模拟返回克隆，避免共享引用掩盖未提交写入；抽取的是实际后台收件实现。 */
function fixture() {
    const storage = { tasks: [] };
    const context = vm.createContext({ crypto: globalThis.crypto, TextEncoder,
        TARGET_UPLOAD_TASKS_KEY: 'tasks', MAX_TARGET_UPLOAD_TASKS: 30, MAX_TARGET_UPLOAD_TASKS_BYTES: 4 * 1024 * 1024,
        getUtf8ByteLength: text => Buffer.byteLength(text), getTargetUploadTasks: async () => structuredClone(storage.tasks),
        chrome: { storage: { local: { set: async data => Object.assign(storage, structuredClone(data)), get: async key => ({ [key]: structuredClone(storage[key]) }), remove: async () => {} } } } });
    const start = background.indexOf('async function saveTargetUploadTasks(');
    vm.runInContext(integrity + '\n' + background.slice(start, background.indexOf('async function updateDirectTaskProgress', start)), context);
    return { storage, receive: items => context.receiveTargetUploadTasks(items, 'target') };
}

function packet(jobId = 'click-1', value = 'original') {
    const snapshot = { spuId: 'p', arbitrary: value };
    return { jobId, spuId: 'p', targetStoreId: 'target', snapshot, transferIntegrity: transferManifest(snapshot), claimToken: 'token' };
}

test('同包重复先合并，不虚占容量；重传不追加，新的点击仍可入队', async () => {
    const f = fixture(), item = packet();
    await f.receive(Array.from({ length: 31 }, () => structuredClone(item)));
    assert.equal(f.storage.tasks.length, 1);
    f.storage.tasks[0].directState = 'creating';
    await f.receive([{ ...item, claimToken: 'renewed' }]);
    assert.equal(f.storage.tasks.length, 1);
    assert.equal(f.storage.tasks[0].directState, 'creating');
    assert.equal(f.storage.tasks[0].claimToken, 'renewed');
    await f.receive([packet('click-2')]);
    assert.equal(f.storage.tasks.length, 2);
    await assert.rejects(f.receive([packet('click-1', 'changed')]), /快照/);
});

test('同包同标识不同内容整包拒收，不静默选择其中一个', async () => {
    const f = fixture();
    await assert.rejects(f.receive([packet(), packet('click-1', 'changed')]), /快照/);
    assert.equal(f.storage.tasks.length, 0);
});

test('不同店铺不共享去重键，混店包仍拒收', async () => {
    const f = fixture();
    f.storage.tasks.push({ ...packet(), targetStoreId: 'other' });
    await f.receive([packet()]);
    assert.equal(f.storage.tasks.length, 2);
    const before = structuredClone(f.storage.tasks);
    await assert.rejects(f.receive([packet('new'), { ...packet('new'), targetStoreId: 'other' }]), /store_mismatch/);
    assert.deepEqual(f.storage.tasks, before);
});
