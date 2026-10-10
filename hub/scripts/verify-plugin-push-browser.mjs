/** 实际扩展双页验收：仅使用本地中转和合成平台页面，不连接真实商城或生产仓库。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, cp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installWebsocketRelay } from '../lib/websocket-relay.mjs';
import { createOneShotRelay } from '../lib/one-shot-relay.mjs';
import { transferManifest } from '../lib/transfer-integrity.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const root = await mkdtemp(path.join(tmpdir(), 'temu-push-browser-'));
const server = createServer((req, res) => { res.writeHead(404); res.end(); });
const relay = createOneShotRelay(); let identity, authenticates = 0;
installWebsocketRelay(server, { relay, pathMatches: req => req.url === '/api/relay/socket', heartbeatMs: 1000,
    authenticate: async (_req, message) => { assert.equal(message.token, 'browser-fixture-token'); identity = { ...message.identity, pluginInstanceId: message.pluginInstanceId }; authenticates++; return { auth: {}, identity }; },
    register: async value => value, validate: async () => {} });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
/** 有界等待只用于测试同步，不进入插件源码，不向网络读取状态。 */
async function until(action, predicate, label) {
    const deadline = Date.now() + 15000; let value;
    do { value = await action(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 75)); } while (Date.now() < deadline);
    throw Error(label + ': ' + JSON.stringify(value));
}
/** CDP 穿透 closed shadow root，检查实际渲染文字及按钮，不以后台值冒充界面更新。 */
async function panel(page, click = '') {
    const client = await context.newCDPSession(page);
    try {
        const { root: dom } = await client.send('DOM.getDocument', { depth: -1, pierce: true });
        let shadow;
        const visit = node => { const attributes = node.attributes || []; if (attributes.includes('temu-local-dataset-panel')) shadow = node.shadowRoots?.[0]; (node.children || []).forEach(visit); (node.shadowRoots || []).forEach(visit); };
        visit(dom); if (!shadow) return {};
        const { object } = await client.send('DOM.resolveNode', { nodeId: shadow.nodeId });
        if (click) await client.send('Runtime.callFunctionOn', { objectId: object.objectId, arguments: [{ value: click }], functionDeclaration: `function(selector){const button=this.querySelector(selector);if(!button||!button.getClientRects().length)throw Error('按钮不可见');button.click();}` });
        const { result } = await client.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: `function(){ return { text:[...this.querySelectorAll('.head-stage,.agent-status,.message,.transfer-progress')].filter(node=>node.getClientRects().length).map(node=>node.textContent).join(' '), pause:this.querySelector('.transfer-pause')?.textContent.trim(), connection:this.querySelector('.agent-status')?.textContent.trim() }; }` });
        return result.value;
    } finally { await client.detach(); }
}
try {
    const plugin = path.join(root, 'plugin'); await cp(new URL('../../plugin', import.meta.url), plugin, { recursive: true });
    const manifest = JSON.parse(await readFile(path.join(plugin, 'manifest.json'), 'utf8'));
    // 测试构建仅增加随机本地端口权限；正式清单和发布包不改动。
    manifest.host_permissions.push(origin + '/*'); await writeFile(path.join(plugin, 'manifest.json'), JSON.stringify(manifest));
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), { channel: 'chromium', headless: true,
        proxy: { server: 'http://127.0.0.1:9', bypass: '127.0.0.1,localhost' },
        args: [`--disable-extensions-except=${plugin}`, `--load-extension=${plugin}`, '--no-first-run'] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async endpoint => {
        await chrome.storage.local.set({ ingestSettingsV1: { endpoint: endpoint + '/api/ingest', token: 'browser-fixture-token', settingsVersion: 3, autoPush: false } });
        // 浏览器验收不运行商品平台接口；执行器单元测试单独覆盖提交安全边界。
        runDirectTasks = async () => {};
    }, origin);
    const requests = [];
    context.on('request', req => requests.push(req.url()));
    const runtimeCode = `function clientModule(){return '.postWithoutMallId= .mallIdClient= getMallIdAsync';} const runtime=()=>({mallIdClient:{getMallIdAsync:async()=>'999000000000001'}});runtime.m={42:clientModule};window.chunkLoadingGlobal_temu_sca_goods=[];window.chunkLoadingGlobal_temu_sca_goods.push=function(entry){entry[2]?.(runtime);};`;
    await context.route('**/*', route => {
        const url = route.request().url();
        if (url === 'https://agentseller.temu.com/fixture-runtime.js') return route.fulfill({ contentType: 'application/javascript', body: runtimeCode });
        if (url.startsWith('https://agentseller.temu.com/goods/list')) {
            const setup = url.includes('delayed=1') ? `setTimeout(()=>{const script=document.createElement('script');script.src='/fixture-runtime.js';document.body.append(script);},2000);` : runtimeCode;
            return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head><meta charset="utf-8"><title>商品列表</title></head><body><header><span class="shop-name">合成测试商城</span></header><main><input type="checkbox">SPU ID：1234567890</main><script>${setup}</script></body></html>` });
        }
        return route.abort();
    });
    const first = await context.newPage(), second = await context.newPage();
    await first.goto('https://agentseller.temu.com/goods/list'); await second.goto('https://agentseller.temu.com/goods/list');
    await until(() => worker.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter(key => key.startsWith('executionViewer:')).length), count => count === 2, '两个观看页必须就绪');
    await until(() => Promise.resolve(relay.snapshot()), value => value.channels === 1, '同店只有一条网络通道');
    assert.equal(authenticates, 1);
    for (const page of [first, second]) await until(() => panel(page), value => /已连接/.test(value.text || ''), '空队列连接及时显示');
    await worker.evaluate(async storeId => {
        const saved = await chrome.storage.session.get(null); const state = saved['directPause:' + storeId];
        const viewer = saved['executionViewer:' + state.tabId];
        await setDirectCreatePaused({ tab: await chrome.tabs.get(viewer.tabId), documentId: viewer.documentId }, viewer, true);
    }, identity.storeId);
    const snapshot = { publicationData: { sourceProduct: { productId: '1234567890' } } };
    const task = { jobId: 'browser-fixture-batch', spuId: '1234567890', targetStoreId: identity.storeId,
        snapshot, transferIntegrity: transferManifest(snapshot), transportOnly: true, directCreate: true, executionRunId: identity.relaySessionId };
    await relay.send(identity, [task]);
    for (const page of [first, second]) await until(() => panel(page), value => value.pause === '继续' && /已暂停/.test(value.text || ''), '两页共享暂停队列');
    await panel(second, '.transfer-pause');
    for (const page of [first, second]) await until(() => panel(page), value => value.pause === '暂停' && !/已暂停/.test(value.text || ''), '观看页继续更新两页');
    await panel(second, '.transfer-pause');
    for (const page of [first, second]) await until(() => panel(page), value => value.pause === '继续', '观看页再次暂停更新两页');
    // 刷新非执行页不能清掉另一页的队列或建立第二条连接。
    const owner = await worker.evaluate(async storeId => (await chrome.storage.session.get('directPause:' + storeId))['directPause:' + storeId].tabId, identity.storeId);
    const viewerId = await worker.evaluate(async () => Object.values(await chrome.storage.session.get(null)).find(item => item?.documentId && item?.tabId !== undefined && item.tabId !== Array.from(executionActiveTabs.keys())[0])?.tabId);
    assert.notEqual(owner, viewerId);
    await second.reload();
    await until(() => panel(second), value => value.pause === '继续', '刷新观看页继承共享状态');
    assert.equal(relay.snapshot().channels, 1); assert.equal(authenticates, 1);
    second.once('dialog', dialog => void dialog.accept());
    await panel(second, '.transfer-cancel');
    for (const page of [first, second]) await until(() => panel(page), value => /准备就绪/.test(value.text || '') && !/已暂停/.test(value.text || ''), '结束后两页回到初态');
    await until(() => Promise.resolve(identity), value => value.relaySessionId !== task.executionRunId, '结束更换接收会话');
    await worker.evaluate(async storeId => {
        const saved = await chrome.storage.session.get(null), state = saved['directPause:' + storeId], viewer = saved['executionViewer:' + state.tabId];
        await setDirectCreatePaused({ tab: await chrome.tabs.get(viewer.tabId), documentId: viewer.documentId }, viewer, true);
    }, identity.storeId);
    await relay.send(identity, [{ ...task, jobId: 'new-browser-batch', executionRunId: identity.relaySessionId }]);
    await until(() => panel(second), value => value.pause === '继续', '新批处于共享队列');
    await first.reload();
    for (const page of [first, second]) await until(() => panel(page), value => /准备就绪/.test(value.text || '') && !/已暂停/.test(value.text || ''), '执行页刷新丢弃旧批次');
    const queue = await worker.evaluate(async () => (await chrome.storage.session.get('targetUploadTasksV1')).targetUploadTasksV1 || []);
    assert.equal(queue.length, 0, '执行页刷新不得迁移旧任务');
    const delayed = await context.newPage(); await delayed.goto('https://agentseller.temu.com/goods/list?delayed=1');
    await until(() => panel(delayed), value => value.connection === '已连接', '平台运行时晚到，脚本加载事件重新订阅');
    assert.equal(relay.snapshot().channels, 1, '晚加载观看页不新增通道');
    assert.equal(requests.some(url => /\/api\/(?:jobs\/claim|agents\/register)/.test(url)), false, '没有网络轮询或登记请求');
    await mkdir(new URL('../../output/playwright', import.meta.url), { recursive: true });
    await first.screenshot({ path: new URL('../../output/playwright/shared-store-first.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
    await second.screenshot({ path: new URL('../../output/playwright/shared-store-second.png', import.meta.url).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
    console.log(JSON.stringify({ passed: true, actualChromium: true, views: 3, oneChannel: true, noClaimHttp: true, pausedAndEndedShared: true, viewerRefreshSafe: true, ownerRefreshNoReplay: true, actualControlButtons: true, latePlatformReadyEvent: true }));
} finally {
    await context?.close(); relay.snapshot(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
}
