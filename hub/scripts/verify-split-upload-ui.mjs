/** 独立运行真实网页的拆分上传回归；沿用仓库 Playwright，全部网络拦截，只保存本地验证截图。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const files = new Map(await Promise.all(['index.html', 'app.js', 'styles.css', 'product-detail.js', 'product-error-ui.js', 'favicon.svg']
    .map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
for (const name of ['Archivo.ttf', 'ArchivoNarrow.ttf']) {
    files.set(`fonts/${name}`, await readFile(new URL(`../public/fonts/${name}`, import.meta.url)));
}
const origin = 'https://split-upload-preview.invalid';
const actionTypes = ['product_create', 'qualification_upload'];
const browser = await chromium.launch({ headless: true });
const output = new URL('../../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
let scenarios = 0;

/** 合成账户只返回自己的在线店；控制发送与能力响应，稳定验证并发、红标及离页竞态。 */
async function fixture({ viewport = { width: 1440, height: 900 }, count = 6, online = true, red = 2, sameStore = false } = {}) {
    const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
    await context.addInitScript(() => { globalThis.EventSource = class { readyState = 1; addEventListener() {} close() {} }; });
    const page = await context.newPage(), errors = [], sends = [], writes = [], gates = [], capabilityGates = [];
    const products = Array.from({ length: count }, (_, i) => ({ spuId: String(9100000001 + i), spuIds: [String(9100000001 + i)],
        productKey: (i + 1).toString(16).padStart(64, '0'), sourceIdentity: (i + 1).toString(16).padStart(64, '0'),
        title: `合成商品 ${i + 1}`, articleNo: `SYNTH-${i + 1}`, category: '身体护理', images: [],
        sourceStoreIds: ['temu:111'], batchIds: ['batch'], publicationData: { sourceBatchId: 'batch' },
        blocked: i === 0 && red > 0, sendBlocked: i > 0 && i < red, errorNotice: null }));
    const makeAgent = id => ({ storeId: `temu:${id}`, storeName: `自己的在线店 ${id}`, online: true,
        pluginDetected: true, identityMatched: true, canReceiveUploads: true, pluginVersion: '11.0.4' });
    let agents = online ? (sameStore ? ['111'] : ['222', '333', '444']).map(makeAgent) : [];
    let holdSends = false, holdCapability = false, version = 1, overviewReads = 0;
    let capability = { actionTypes, minimumPluginVersion: '11.0.4' }, sendFailure = false, capabilityReads = 0;
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        assert.equal(url.origin, origin, '所有请求必须留在离线模拟域名，禁止真实商品操作');
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (request.method() !== 'GET' && url.pathname !== '/api/products/status-read') writes.push(url.pathname);
        if (url.pathname === '/api/me') return json({ user: { id: 'synthetic-owner', username: '隔离测试账户' }, isAdmin: false });
        if (url.pathname === '/api/overview') {
            overviewReads++;
            const offset = Number(url.searchParams.get('productOffset')) || 0, limit = Number(url.searchParams.get('productLimit')) || 20;
            return json({ products: products.slice(offset, offset + limit), productCount: count, productTotal: count,
                batches: [{ id: 'batch', sourceStoreId: 'temu:111', sourceStoreName: '合成来源店' }], sourceStores: [] });
        }
        if (url.pathname === '/api/agents') {
            const offset = Number(url.searchParams.get('offset')) || 0;
            return json({ agents: agents.slice(offset, offset + 100), total: agents.length, hasMore: offset + 100 < agents.length,
                directoryVersion: String(version) });
        }
        if (url.pathname === '/api/live') return json({ inventory: '1', claims: '1', agents: '1', directory: '1' });
        if (url.pathname === '/api/products/status-read') {
            const refs = request.postDataJSON().products, states = [], staleIds = [];
            for (const ref of refs) {
                const product = products.find(p => p.productKey === ref.productKey);
                if (!product || product.sourceIdentity !== ref.sourceIdentity) { staleIds.push(ref.spuId); continue; }
                states.push({ spuId: product.spuId, sourceIdentity: product.sourceIdentity, blocked: product.blocked,
                    sendBlocked: product.sendBlocked, blockedReason: '', blockedAt: null, errorNotice: null });
            }
            return json({ products: states, staleIds });
        }
        if (url.pathname === '/api/direct-create-capability') {
            capabilityReads++;
            if (holdCapability) await new Promise(resolve => capabilityGates.push(resolve));
            return json(capability);
        }
        if (url.pathname === '/api/relay/send') {
            const body = request.postDataJSON(); sends.push(body);
            assert.ok(actionTypes.includes(body.actionType));
            assert.ok(body.spuIds.length > 0 && body.spuIds.length <= 10);
            if (holdSends) await new Promise(resolve => gates.push(resolve));
            if (sendFailure) return json({ error: '目标店插件版本过低，最低 11.0.4' }, 409);
            return json({ sent: body.spuIds.length, skippedBlocked: [] });
        }
        if (url.pathname === '/api/stores') return json({ stores: [], total: 0, counts: {} });
        if (url.pathname === '/api/ziniao/stores') return json({ stores: [] });
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (files.has(file)) return route.fulfill({ status: 200, body: files.get(file), contentType:
            file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml'
                : file.endsWith('.ttf') ? 'font/ttf' : 'text/html' });
        throw Error(`隔离测试未提供此路径：${request.method()} ${url.pathname}`);
    });
    await page.goto(origin + '/#/products');
    await page.locator('[data-product-row]').first().waitFor();
    const notify = async () => {
        version++;
        await page.evaluate(async v => {
            const live = { inventory: String(v), claims: '1', agents: String(v), directory: String(v) };
            await refreshCatalogTargets(live, () => true);
            await refreshCatalogStatus(live, () => true, v);
        }, version);
    };
    return { page, context, products, sends, writes, errors, notify,
        get overviewReads() { return overviewReads; }, get capabilityReads() { return capabilityReads; },
        setAgents(ids) { agents = ids.map(makeAgent); }, setVersion(value) { agents = agents.map(agent => ({ ...agent, pluginVersion: value })); }, setCapability(value) { capability = value; },
        hold() { holdSends = true; }, release() { holdSends = false; gates.splice(0).forEach(resolve => resolve()); },
        holdCapability() { holdCapability = true; }, releaseCapability() { holdCapability = false; capabilityGates.splice(0).forEach(resolve => resolve()); },
        failSend() { sendFailure = true; },
        async close() {
            assert.deepEqual(errors, [], '网页不得产生未捕获异常');
            assert.ok(writes.every(path => path === '/api/relay/send'), '不得预创建任务或写入其他业务接口');
            await context.close(); scenarios++;
        } };
}

/** 通过真实入口打开共用弹窗，不绕过选店及底部命令提交。 */
async function openBatch(f) {
    await f.page.locator('label:has(#select-all-products)').click();
    assert.equal(await f.page.locator('#batch-direct-create').isEnabled(), true, '没有预选店也可打开');
    await f.page.locator('#batch-direct-create').click();
    assert.equal(await f.page.locator('#single-target-dialog').getAttribute('data-mode'), 'batch');
    assert.equal(await f.page.locator('dialog[open]').count(), 1);
    assert.equal(await f.page.locator('#upload-target-fields').isVisible(), true, '打开立即显示本账户店铺');
    assert.equal(await f.page.locator('.upload-action-types').count(), 0);
    assert.equal(await f.page.locator('.single-target-dialog-actions button').count(), 2);
    assert.equal(f.sends.length, 0);
    assert.equal(f.capabilityReads, 0, '开窗不得启动提交前检查');
}

async function chooseTask(page, actionType, ids = ['222', '333', '444']) {
    assert.ok(actionTypes.includes(actionType));
    assert.equal(await page.locator('#upload-product-compliance').isVisible(), true);
    for (const id of ids) await page.locator(`#single-target-options label:has(input[value="temu:${id}"])`).click();
}

async function finish(f, copies) {
    await f.page.waitForFunction(n => document.querySelector('#catalog-toast')?.textContent.includes(`实际发出 ${n} 份`), copies);
    assert.doesNotMatch(await f.page.locator('#catalog-toast').innerText(), /上架成功|补全成功|创建成功/);
}

/** 截图作为交付证据；两个命令都要在窄屏首屏可见，不能重叠或挤出弹窗。 */
async function checkLayout(page, actionType) {
    const bounds = await page.locator('#single-target-dialog').evaluate(dialog => {
        const rect = dialog.getBoundingClientRect();
        const buttons = [...dialog.querySelectorAll('.single-target-dialog-actions button')].map(button => {
            const box = button.getBoundingClientRect();
            return { left: box.left, right: box.right, bottom: box.bottom, textFits: button.scrollWidth <= button.clientWidth };
        });
        return { viewport: innerWidth, height: innerHeight, left: rect.left, right: rect.right, bottom: rect.bottom, scrollWidth: dialog.scrollWidth, width: dialog.clientWidth,
            buttons };
    });
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport + 1, JSON.stringify(bounds));
    assert.ok(bounds.scrollWidth <= bounds.width + 1, JSON.stringify(bounds));
    for (const button of bounds.buttons) {
        assert.ok(button.left >= bounds.left && button.right <= bounds.right && button.textFits, JSON.stringify(bounds));
        assert.ok(button.bottom <= Math.min(bounds.bottom, bounds.height), '两个命令必须在弹窗首屏可见');
    }
    assert.ok(bounds.buttons[0].right <= bounds.buttons[1].left, '两个命令不得重叠');
    assert.ok((await page.screenshot({ path: fileURLToPath(new URL(`split-upload-${page.viewportSize().width}-${actionType}.png`, output)) }))
        .byteLength > 5000, '真实网页截图不得为空');
}

try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        for (const actionType of actionTypes) {
            const f = await fixture({ viewport });
            await openBatch(f);
            assert.match(await f.page.locator('#single-target-spu').innerText(), /可发送 4 个，标红跳过 2 个/);
            await chooseTask(f.page, actionType);
            assert.equal(await f.page.locator(`#single-target-dialog button[value="${actionType}"]`).isEnabled(), true);
            await checkLayout(f.page, actionType);
            assert.equal(f.sends.length, 0, '确认前不得发送');
            await f.page.locator(`#single-target-dialog button[value="${actionType}"]`).click();
            await finish(f, 12);
            assert.equal(f.sends.length, 3);
            for (const body of f.sends) {
                assert.equal(body.actionType, actionType);
                assert.deepEqual(body.spuIds, f.products.slice(2).map(p => p.spuId));
                assert.equal(body.sourceStoreId, 'temu:111'); assert.equal(body.sourceBatchId, 'batch');
            }
            await f.close();
        }
    }

    // 关闭及 Escape 不产生任务，重新打开也不能沿用上次命令的返回值。
    const cancel = await fixture();
    await openBatch(cancel); await chooseTask(cancel.page, 'qualification_upload');
    await cancel.page.locator('#single-target-search').fill('222');
    await cancel.page.locator('#single-target-search').press('Enter');
    assert.equal(await cancel.page.locator('#single-target-dialog').isVisible(), true, '搜索回车不能关闭弹窗或发送');
    assert.equal(cancel.sends.length, 0);
    await cancel.page.locator('#single-target-dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await cancel.page.locator('#batch-direct-create').click();
    assert.equal(await cancel.page.locator('#single-target-dialog').evaluate(dialog => dialog.returnValue), '');
    await cancel.page.keyboard.press('Escape');
    assert.equal(cancel.sends.length, 0); assert.equal(cancel.capabilityReads, 0); await cancel.close();

    // 无在线店时两种入口均可打开，但两个命令都不能在没有接收方时提交。
    const empty = await fixture({ online: false, red: 0 });
    await openBatch(empty); await chooseTask(empty.page, 'qualification_upload', []);
    assert.equal(await empty.page.locator('#single-target-dialog button[value="product_create"]').isDisabled(), true);
    await empty.page.locator('#single-target-options').getByText('暂无在线目标店铺。').waitFor();
    await empty.page.keyboard.press('Escape');
    await empty.page.locator('[data-transfer-spu]').first().click();
    await chooseTask(empty.page, 'product_create', []);
    assert.equal(await empty.page.locator('#single-target-dialog button[value="product_create"]').isDisabled(), true);
    assert.equal(empty.sends.length, 0); await empty.close();

    // 两种单商品任务都带入已选店，并允许改为多店；只发本行，不受批量勾选影响。
    for (const actionType of actionTypes) {
        const single = await fixture();
        await single.page.locator('#batch-target-trigger').click();
        await single.page.locator('#batch-target-options label:has(input[value="temu:222"])').click();
        await single.page.locator('#batch-target-dialog button[value="apply"]').click();
        await single.page.locator('[data-transfer-spu]').nth(2).click();
        assert.equal(await single.page.locator('#single-target-dialog').getAttribute('data-mode'), 'single');
        assert.equal(await single.page.locator('#single-target-options input[value="temu:222"]').isChecked(), true);
        await chooseTask(single.page, actionType, ['222', '333', '444']);
        await single.page.locator(`#single-target-dialog button[value="${actionType}"]`).click();
        await finish(single, 2);
        assert.deepEqual(single.sends.map(body => body.targetStoreId).sort(), ['temu:333', 'temu:444']);
        for (const body of single.sends) { assert.equal(body.actionType, actionType); assert.deepEqual(body.spuIds, [single.products[2].spuId]); }
        await single.close();
    }

    // 批量预选店也作为可调整草稿；搜索仅筛选当前店，全选不覆盖隐藏选项。
    const draft = await fixture({ red: 0 });
    await draft.page.locator('#batch-target-trigger').click();
    await draft.page.locator('#batch-target-options label:has(input[value="temu:222"])').click();
    await draft.page.locator('#batch-target-dialog button[value="apply"]').click();
    await openBatch(draft);
    assert.equal(await draft.page.locator('#single-target-options input[value="temu:222"]').isChecked(), true);
    await draft.page.locator('#single-target-search').fill('333');
    assert.equal(await draft.page.locator('#single-target-options label:has(input[value="temu:222"])').isVisible(), false);
    await draft.page.locator('label:has(#single-target-select-all)').click();
    assert.equal(await draft.page.locator('#single-target-options input[value="temu:333"]').isChecked(), true);
    await draft.page.locator('#single-target-search').fill('');
    await draft.page.locator('#single-target-options label:has(input[value="temu:222"])').click();
    await draft.page.locator('#single-target-dialog button[value="product_create"]').click();
    await finish(draft, 6); assert.equal(draft.sends[0].targetStoreId, 'temu:333'); await draft.close();

    // 搜索、店铺勾选和原行节点在实时刷新中保留；新红标立即禁用两个命令。
    for (const mode of ['batch', 'single']) {
        const live = await fixture({ count: 1, red: 0 });
        if (mode === 'batch') await openBatch(live); else await live.page.locator('[data-transfer-spu]').click();
        await chooseTask(live.page, 'qualification_upload', ['222']);
        await live.page.locator('#single-target-search').fill('222');
        await live.page.evaluate(() => { window.savedRow = document.querySelector('[data-product-row]'); });
        const reads = live.overviewReads;
        live.products[0].sendBlocked = true; await live.notify();
        assert.equal(await live.page.locator('#single-target-dialog button[value="product_create"]').isDisabled(), true);
        assert.equal(await live.page.locator('#single-target-dialog button[value="qualification_upload"]').isDisabled(), true);
        assert.equal(await live.page.locator('[data-transfer-spu]').isDisabled(), true);
        assert.equal(await live.page.locator('#single-target-search').inputValue(), '222');
        assert.equal(await live.page.locator('#single-target-options input[value="temu:222"]').isChecked(), true);
        assert.equal(await live.page.evaluate(() => window.savedRow === document.querySelector('[data-product-row]')), true);
        assert.equal(live.overviewReads, reads);
        live.products[0].sendBlocked = false; await live.notify();
        assert.equal(await live.page.locator('#single-target-dialog button[value="product_create"]').isEnabled(), true);
        assert.equal(await live.page.locator('#single-target-dialog button[value="qualification_upload"]').isEnabled(), true);
        live.setAgents([]); await live.notify();
        assert.equal(await live.page.locator('#single-target-dialog button[value="product_create"]').isDisabled(), true);
        assert.equal(await live.page.locator('#single-target-dialog button[value="qualification_upload"]').isDisabled(), true);
        live.setAgents(['333']); await live.notify();
        await live.page.locator('#single-target-search').fill('');
        assert.equal(await live.page.locator('#single-target-options input').count(), 1);
        assert.equal(live.sends.length, 0); await live.close();
    }

    // 分段共享类型及人工标识，最多两店在途；新红标只过滤未发分段。
    for (const actionType of actionTypes) {
        const chunks = await fixture({ count: 20, red: 2 });
        await openBatch(chunks); await chooseTask(chunks.page, actionType); chunks.hold();
        await chunks.page.locator(`#single-target-dialog button[value="${actionType}"]`).click();
        await chunks.page.waitForFunction(() => document.querySelector('#batch-direct-create')?.textContent === '发送中…');
        for (let i = 0; i < 100 && chunks.sends.length < 2; i++) await chunks.page.waitForTimeout(10);
        assert.equal(chunks.sends.length, 2, '第三店不得突破两店并发');
        await chunks.page.locator('#clear-product-selection').click();
        chunks.products[19].sendBlocked = true; await chunks.notify(); chunks.release();
        await finish(chunks, 51);
        assert.equal(chunks.sends.length, 6);
        for (const body of chunks.sends.slice(2)) assert.ok(!body.spuIds.includes(chunks.products[19].spuId));
        for (const target of ['temu:222', 'temu:333', 'temu:444']) {
            const sends = chunks.sends.filter(body => body.targetStoreId === target);
            assert.equal(new Set(sends.map(body => body.manualSendId)).size, 1);
        }
        assert.ok(chunks.sends.every(body => body.actionType === actionType)); await chunks.close();
    }

    // 导航停止后续分段及第三店，不撤回已经发出的请求，两种任务完全相同。
    for (const actionType of actionTypes) {
        const leave = await fixture({ count: 20, red: 0 });
        await openBatch(leave); await chooseTask(leave.page, actionType); leave.hold();
        await leave.page.locator(`#single-target-dialog button[value="${actionType}"]`).click();
        for (let i = 0; i < 100 && leave.sends.length < 2; i++) await leave.page.waitForTimeout(10);
        assert.equal(leave.sends.length, 2);
        await leave.page.getByRole('link', { name: '店铺认领', exact: true }).click();
        await leave.page.getByRole('heading', { name: '店铺认领', exact: true }).waitFor();
        leave.release(); await leave.page.waitForFunction(() => !batchUploadBusy);
        assert.equal(leave.sends.length, 2); await leave.close();
    }

    // 能力未声明类型时必须失败关闭，不能把资质默认为创建；旧插件拒绝不自动重试。
    for (const mode of ['batch', 'single']) {
        const unsupported = await fixture({ red: 0 });
        unsupported.setCapability({ directCreate: true, actionTypes: ['product_create'] });
        if (mode === 'batch') await openBatch(unsupported); else await unsupported.page.locator('[data-transfer-spu]').first().click();
        await chooseTask(unsupported.page, 'qualification_upload', ['222']);
        await unsupported.page.locator('#single-target-dialog button[value="qualification_upload"]').click();
        await unsupported.page.locator('#catalog-toast').getByText(/后台尚未启用所选上传任务类型/).waitFor();
        assert.equal(unsupported.sends.length, 0); await unsupported.close();
    }
    const oldServer = await fixture({ red: 0 }); oldServer.setCapability({ directCreate: true });
    await openBatch(oldServer); await chooseTask(oldServer.page, 'product_create', ['222']);
    await oldServer.page.locator('#single-target-dialog button[value="product_create"]').click();
    await oldServer.page.locator('#catalog-toast').getByText(/后台尚未启用所选上传任务类型/).waitFor();
    assert.equal(oldServer.sends.length, 0); await oldServer.close();
    const oldPlugin = await fixture({ count: 1, red: 0 }); oldPlugin.failSend();
    await openBatch(oldPlugin); await chooseTask(oldPlugin.page, 'qualification_upload', ['222']);
    await oldPlugin.page.locator('#single-target-dialog button[value="qualification_upload"]').click();
    await oldPlugin.page.locator('#catalog-toast').getByText(/最低 11\.0\.4/).waitFor();
    assert.equal(oldPlugin.sends.length, 1); assert.equal(await oldPlugin.page.locator('#batch-direct-create').isEnabled(), true);
    await oldPlugin.close();

    // 保留在线/绑定展示，但旧版不能被拆分任务选择，前端先阻止无效发送。
    const oldTarget = await fixture({ count: 1, red: 0 }); oldTarget.setVersion('11.0.3'); await oldTarget.notify();
    await openBatch(oldTarget);
    assert.equal(await oldTarget.page.locator('#single-target-dialog button[value="product_create"]').isDisabled(), true);
    assert.equal(await oldTarget.page.locator('#single-target-dialog [data-store-id]').count(), 0);
    assert.equal(oldTarget.sends.length, 0); await oldTarget.close();

    // 模拟BFCache保留DOM的离页，不能靠节点仍连接继续下一分段或下一店铺。
    for (const mode of ['batch', 'single']) {
        const hidden = await fixture({ count: 20, red: 0 });
        if (mode === 'batch') await openBatch(hidden); else await hidden.page.locator('[data-transfer-spu]').first().click();
        await chooseTask(hidden.page, 'product_create'); hidden.hold();
        await hidden.page.locator('#single-target-dialog button[value="product_create"]').click();
        for (let i = 0; i < 100 && hidden.sends.length < 2; i++) await hidden.page.waitForTimeout(10);
        assert.equal(hidden.sends.length, 2);
        await hidden.page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
        hidden.release(); await hidden.page.waitForFunction(() => !singleUploadBusy && !batchUploadBusy);
        assert.equal(hidden.sends.length, 2); await hidden.close();
    }

    // 同来源确认在共用弹窗关闭后才出现，取消不发；等待能力时离页也不能迟到发送。
    const same = await fixture({ count: 1, red: 0, sameStore: true });
    await openBatch(same); await chooseTask(same.page, 'qualification_upload', ['111']);
    await same.page.locator('#single-target-dialog button[value="qualification_upload"]').click();
    const sameDialog = same.page.getByRole('dialog', { name: '确认发送到来源店铺' }); await sameDialog.waitFor();
    assert.equal(await same.page.locator('dialog[open]').count(), 1, '不得嵌套模态弹窗');
    await sameDialog.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(same.sends.length, 0); await same.close();
    for (const mode of ['batch', 'single']) {
        const waiting = await fixture({ red: 0 }); waiting.holdCapability();
        if (mode === 'batch') await openBatch(waiting); else await waiting.page.locator('[data-transfer-spu]').first().click();
        await chooseTask(waiting.page, 'product_create', ['222']);
        await waiting.page.locator('#single-target-dialog button[value="product_create"]').click();
        await waiting.page.waitForFunction(() => singleUploadBusy || batchUploadBusy);
        for (let i = 0; i < 100 && !waiting.capabilityReads; i++) await waiting.page.waitForTimeout(10);
        await waiting.page.getByRole('link', { name: '店铺认领', exact: true }).click();
        await waiting.page.getByRole('heading', { name: '店铺认领', exact: true }).waitFor();
        waiting.releaseCapability(); await waiting.page.waitForFunction(() => !singleUploadBusy && !batchUploadBusy);
        assert.equal(waiting.sends.length, 0); await waiting.close();
    }
    console.log(JSON.stringify({ passed: true, scenarios, viewports: 2, actionTypes, maxConcurrent: 2,
        liveRedFiltering: true, noPrecreatedTasks: true, routeStopsRemaining: true, realPlatformRequests: 0 }));
} finally { await browser.close(); }
