/** 执行真实后台代码，平台与网络均为隔离模拟；覆盖同店共享、主动推送和无重放边界。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { transferManifest } from '../lib/transfer-integrity.mjs';

async function fixture() {
    const session = {}, local = {}, messages = [], runs = [], sockets = [], tabs = new Map(), listeners = [];
    // 等待真实接收与广播 Promise，而非猜测事件循环次数；摘要计算在不同内核上的耗时不相同。
    const flush = async () => {
        for (let i = 0; i < 12; i++) {
            await new Promise(resolve => setImmediate(resolve));
            await Promise.all(sockets.map(socket => socket.pending).filter(Boolean));
            await Promise.all(vm.runInContext('[...storeChannels.values()].map(record => record.incoming)', ctx));
            await Promise.all(vm.runInContext('[...storeSnapshotWrites.values()]', ctx));
        }
    };
    const area = (saved, name) => ({ get: async keys => keys === null ? structuredClone(saved) : Object.fromEntries([].concat(keys).map(key => [key, structuredClone(saved[key])])),
        set: async values => { const changes = {}; for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: saved[key], newValue: structuredClone(value) }; saved[key] = structuredClone(value); } queueMicrotask(() => listeners.forEach(fn => fn(changes, name))); },
        remove: async keys => { const changes = {}; for (const key of [].concat(keys)) { changes[key] = { oldValue: saved[key] }; delete saved[key]; } queueMicrotask(() => listeners.forEach(fn => fn(changes, name))); } });
    class Socket {
        constructor(url) { this.url = url; this.sent = []; sockets.push(this); }
        send(text) { this.sent.push(JSON.parse(text)); }
        close() { this.closed = true; this.onclose?.({ code: 1000 }); }
        ready() { this.onmessage({ data: JSON.stringify({ type: 'ready', agent: { ...this.sent[0].identity, pluginInstanceId: 'fixture-instance' } }) }); }
        products(claimed) {
            this.onmessage({ data: JSON.stringify({ type: 'products', claimed }) });
            // 切店处理中旧通道会先从索引移除，仍须等待已进入处理链的消息结束。
            this.pending = Promise.all(vm.runInContext('[...storeChannels.values()].map(record => record.incoming)', ctx));
        }
    }
    const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, URL, console, Date, Promise,
        setTimeout, clearTimeout, queueMicrotask, WebSocket: Socket,
        chrome: { storage: { session: area(session, 'session'), local: area(local, 'local'), onChanged: { addListener: fn => listeners.push(fn) } },
            runtime: { getManifest: () => ({ version: '10.10.78' }) },
            tabs: { get: async id => { const tab = tabs.get(id); if (!tab) throw Error('closed'); return { id, url: tab.url }; },
                sendMessage: async (id, message, options) => { messages.push({ id, message: structuredClone(message), options }); } },
            scripting: { executeScript: async ({ target }) => { const tab = tabs.get(target.tabId); if (!tab || target.documentIds?.[0] !== tab.documentId) throw Error('页面已变化'); return [{ documentId: tab.documentId, result: {} }]; } } },
        TemuOperationLog: { append: async () => {} }, getUtf8ByteLength: text => Buffer.byteLength(text) });
    const bg = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
    const code = await Promise.all(['transfer-integrity.js', 'direct-executor.js', 'execution-round.js', 'ingest-endpoint.js'].map(file => readFile(new URL('../../plugin/' + file, import.meta.url), 'utf8')));
    vm.runInContext(code.join('\n') + '\n' + bg.slice(bg.indexOf('const BOUND_STORE_KEY'), bg.indexOf('function hubApiUrl'))
        + '\n' + bg.slice(bg.indexOf('async function getPluginInstanceId'), bg.indexOf('let directPauseControlQueue'))
        + '\n' + bg.slice(bg.indexOf('let directPauseControlQueue'), bg.indexOf('chrome.runtime.onMessage.addListener')), ctx);
    ctx.bootstrapIngestToken = async settings => settings;
    ctx.getIngestSettings = async () => ({ endpoint: 'https://fixture.invalid/temu/api/ingest', token: 'fixture-token' });
    ctx.ensureIngestPermission = async () => true;
    ctx.hubApiUrl = (endpoint, pathname) => ctx.TemuIngestEndpoint.apiUrl(endpoint, pathname);
    ctx.getPluginInstanceId = async () => 'fixture-instance';
    ctx.runDirectTasks = async (tabId, identity) => runs.push({ tabId, identity });
    // 本夹具没有来源采集请求；切店仍走真实绑定逻辑，采集取消由独立入库回归覆盖。
    ctx.invalidateIngestTab = async () => {};
    ctx.directPage = async (id, phase) => { assert.equal(phase, 'identity'); return { mallId: tabs.get(id).mallId }; };
    vm.runInContext(await readFile(new URL('../../plugin/store-channel.js', import.meta.url), 'utf8'), ctx);
    // 后台启动恢复在空会话中完成，后续用例另行验证重连，不混入夹具准备期的定时事件。
    await new Promise(resolve => setTimeout(resolve, 0));
    await flush();
    const sender = (id, mallId = '222', documentId = `doc-${id}`) => {
        tabs.set(id, { mallId, documentId, url: 'https://agentseller.temu.com/goods/list' });
        return { tab: { id, url: tabs.get(id).url }, documentId };
    };
    const subscribe = async user => { const result = await ctx.subscribeStoreChannel(user, { pageStoreName: '测试店' }); await flush(); return result; };
    const open = async socket => { await socket.onopen(); socket.ready(); await flush(); };
    const packet = (state, code, jobId = 'fixture-batch') => { const snapshot = { publicationData: { sourceProduct: { productId: code } } }; return { jobId, spuId: code, targetStoreId: state.storeId,
        snapshot, transferIntegrity: transferManifest(snapshot), transportOnly: true, directCreate: true, executionRunId: state.relaySessionId }; };
    return { ctx, session, local, messages, runs, sockets, sender, subscribe, open, packet, flush, tabs,
        dispose: async () => { vm.runInContext('for (const record of storeChannels.values()) closeStoreChannel(record)', ctx); await flush(); } };
}

test('同店两页共用一个连接和队列，观看页不抢执行文档', async () => {
    const f = await fixture();
    try {
        const owner = f.sender(1), viewer = f.sender(2);
        await f.subscribe(owner); await f.subscribe(viewer);
        assert.equal(f.sockets.length, 1); await f.open(f.sockets[0]);
        assert.equal(f.session['directPause:temu:222'].tabId, 1);
        f.sockets[0].products([f.packet(f.session['directPause:temu:222'], 'p1')]); await f.flush();
        assert.equal(f.session.targetUploadTasksV1.length, 1); assert.equal(f.runs.length, 1); assert.equal(f.runs[0].tabId, 1);
        for (const id of [1, 2]) {
            const pushed = f.messages.filter(message => message.id === id && message.message.snapshot.connection.phase === 'connected').at(-1);
            assert.equal(pushed.message.snapshot.tasks.length, 1); assert.equal(pushed.message.snapshot.tasks[0].spuId, 'p1');
        }
        assert.equal(f.sockets[0].sent.some(message => /claim|progress|receipt/.test(message.type)), false);
        assert.equal(Object.hasOwn(f.sockets[0].sent[0].identity, 'executionRunId'), false);
        assert.equal(Object.hasOwn(f.sockets[0].sent[0].identity, 'documentId'), false);
    } finally { await f.dispose(); }
});

test('登记成功主动显示已连接，无商品也不等待12秒', async () => {
    const f = await fixture();
    try {
        await f.subscribe(f.sender(1)); await f.open(f.sockets[0]);
        assert.equal(f.messages.at(-1).message.snapshot.connection.phase, 'connected');
        assert.equal(f.messages.at(-1).message.snapshot.tasks.length, 0);
        f.sockets[0].onmessage({ data: JSON.stringify({ type: 'ping' }) });
        assert.equal(f.sockets[0].sent.at(-1).type, 'pong');
        assert.equal(f.sockets[0].sent.length, 2);
    } finally { await f.dispose(); }
});

test('观看页暂停继续都操作同一执行页，刷新观看页不清任务', async () => {
    const f = await fixture();
    try {
        const owner = f.sender(1), viewer = f.sender(2); await f.subscribe(owner); await f.subscribe(viewer); await f.open(f.sockets[0]);
        f.sockets[0].products([f.packet(f.session['directPause:temu:222'], 'p1')]); await f.flush();
        await f.ctx.setDirectCreatePaused(viewer, {}, true); await f.flush();
        assert.equal(f.session['directPause:temu:222'].paused, true);
        await f.ctx.setDirectCreatePaused(viewer, {}, false); await f.flush();
        assert.equal(f.session['directPause:temu:222'].tabId, 1); assert.equal(f.runs.at(-1).tabId, 1);
        await f.ctx.invalidateExecutionTab(2, '观看页刷新');
        assert.equal(f.session.targetUploadTasksV1.length, 1);
        await f.subscribe(f.sender(2, '222', 'doc-2-new'));
        assert.equal(f.session.targetUploadTasksV1.length, 1); assert.equal(f.sockets.length, 1);
    } finally { await f.dispose(); }
});

test('执行页关闭终止旧批次，其他页接管的是空队列，旧推送无效', async () => {
    const f = await fixture();
    try {
        await f.subscribe(f.sender(1)); await f.subscribe(f.sender(2)); await f.open(f.sockets[0]);
        const old = { ...f.session['directPause:temu:222'] }, packet = f.packet(old, 'old');
        f.sockets[0].products([packet]); await f.flush();
        f.ctx.detachStoreChannelTab(1); await f.ctx.invalidateExecutionTab(1, '执行页关闭'); f.tabs.delete(1);
        await f.ctx.recoverStoreChannel('temu:222'); await f.flush();
        assert.equal(f.session.targetUploadTasksV1.length, 0); assert.equal(f.session['directPause:temu:222'].tabId, 2);
        assert.notEqual(f.session['directPause:temu:222'].relaySessionId, old.relaySessionId);
        f.sockets[0].products([packet]); await f.flush(); assert.equal(f.session.targetUploadTasksV1.length, 0);
    } finally { await f.dispose(); }
});

test('不同商城各有一条连接，另一店页面不能看到或控制本店队列', async () => {
    const f = await fixture();
    try {
        await f.subscribe(f.sender(1)); const other = f.sender(3, '333'); await f.subscribe(other);
        assert.equal(f.sockets.length, 2); await f.open(f.sockets[0]); await f.open(f.sockets[1]);
        f.sockets[0].products([f.packet(f.session['directPause:temu:222'], 'p1')]); await f.flush();
        const view = await f.ctx.targetUploadTaskView(other, 'temu:222'); assert.equal(view.tasks.length, 0);
        await f.ctx.setDirectCreatePaused(other, { storeId: 'temu:222' }, true);
        assert.equal(f.session['directPause:temu:222'].paused, false); assert.equal(f.session['directPause:temu:333'].paused, true);
        assert.equal(f.messages.filter(message => message.id === 3).at(-1).message.snapshot.tasks.length, 0);
    } finally { await f.dispose(); }
});

test('结束清空共享队列并换连接，旧批不会在新连接重放', async () => {
    const f = await fixture();
    try {
        await f.subscribe(f.sender(1)); const viewer = f.sender(2); await f.subscribe(viewer); await f.open(f.sockets[0]);
        const state = { ...f.session['directPause:temu:222'] }; f.sockets[0].products([f.packet(state, 'old')]); await f.flush();
        await f.ctx.cancelStoreTasks(viewer, {}); await f.flush();
        assert.equal(f.session.targetUploadTasksV1.length, 0); assert.notEqual(f.session['directPause:temu:222'].relaySessionId, state.relaySessionId);
        assert.equal(f.session['directPause:temu:222'].tabId, 1); assert.equal(f.sockets.length, 2); assert.equal(f.sockets[0].closed, true);
    } finally { await f.dispose(); }
});

test('实际新插件入口没有任务轮询，非工作页身份探测被拒绝', async () => {
    const bg = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
    const content = await readFile(new URL('../../plugin/content-app.js', import.meta.url), 'utf8');
    assert.equal(bg.includes('hubJson("/api/jobs/claim"'), false);
    assert.equal(content.includes('send("claimStoreJobs"'), false);
    assert.equal(content.includes('AGENT_SYNC_INTERVAL_MS'), false);
    const f = await fixture();
    try { await assert.rejects(f.ctx.subscribeStoreChannel({ tab: { id: 1, url: 'https://agentseller.temu.com/govern/upload-qualifications' }, documentId: 'doc' }), /请打开商品列表页/); }
    finally { await f.dispose(); }
});

test('同文档切换商城后，旧通道商品不得进入队列或启动执行', async () => {
    const f = await fixture();
    try {
        const owner = f.sender(1); await f.subscribe(owner); await f.open(f.sockets[0]);
        const old = { ...f.session['directPause:temu:222'] };
        f.tabs.get(1).mallId = '333';
        f.sockets[0].products([f.packet(old, 'wrong-store')]); await f.flush();
        assert.equal(f.session.targetUploadTasksV1?.length || 0, 0);
        assert.equal(f.runs.length, 0); assert.equal(f.sockets[0].closed, true);
        assert.equal(f.session['directPause:temu:222'], undefined);
        await f.subscribe(owner); assert.equal(f.session['directPause:temu:333'].mallId, '333');
    } finally { await f.dispose(); }
});
