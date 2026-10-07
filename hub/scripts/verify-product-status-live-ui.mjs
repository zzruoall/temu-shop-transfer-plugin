/** 完整网页在隔离 Chromium 中接收版本通知，验证局部状态同步不打断操作；禁止访问真实店铺。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const files = new Map(await Promise.all(['index.html', 'app.js', 'styles.css', 'product-detail.js', 'product-error-ui.js', 'favicon.svg']
    .map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
const origin = 'https://status-preview.invalid';
const output = new URL('../../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });

/** 使用真实分页、目录和状态协议；控制响应的释放时间，稳定复现竞态而不依赖生产延迟。 */
async function fixture(viewport, count = 25) {
    const context = await browser.newContext({ viewport });
    // 模拟健康 SSE，事件经真实页面的 receiveLiveSnapshot 入口进入，不启动断线兜底轮询。
    await context.addInitScript(() => { globalThis.EventSource = class { readyState = 1; addEventListener() {} close() {} }; });
    const page = await context.newPage(), errors = [], sends = [], statusReads = [], gates = [];
    let version = 1, overviewReads = 0, failed = false, holdSends = false, holdStatus = false, directoryFails = false, holdOverview = false;
    const statusGates = [];
    const overviewGates = [];
    const products = Array.from({ length: count }, (_, i) => ({ spuId: String(9100000001 + i), spuIds: [String(9100000001 + i)],
        sourceIdentity: (i + 1).toString(16).padStart(64, '0'), productKey: (i + 1).toString(16).padStart(64, '0'),
        title: `测试商品 ${i + 1}`, articleNo: `CODE-${i + 1}`,
        category: '身体护理', images: [], batchIds: ['batch'], sourceStoreIds: ['temu:111'],
        publicationData: { sourceBatchId: 'batch' }, blocked: false, sendBlocked: false, errorNotice: null }));
    const agents = ['222', '333', '444'].map(id => ({ storeId: `temu:${id}`, storeName: `目标店 ${id}`, online: true,
        pluginDetected: true, identityMatched: true, canReceiveUploads: true }));
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const url = new URL(route.request().url()); assert.equal(url.origin, origin);
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname === '/api/me') return json({ user: { username: '隔离账户' }, isAdmin: false });
        if (url.pathname === '/api/overview') {
            overviewReads++;
            const offset = Number(url.searchParams.get('productOffset')), limit = Number(url.searchParams.get('productLimit')) || 20;
            const response = structuredClone({ products: products.slice(offset, offset + limit), productCount: count, productTotal: count,
                batches: [{ id: 'batch', sourceStoreId: 'temu:111', sourceStoreName: '来源店' }], sourceStores: [] });
            if (holdOverview) await new Promise(resolve => overviewGates.push(resolve));
            return json(response);
        }
        if (url.pathname === '/api/agents') return directoryFails ? json({ error: '目录读取失败' }, 503)
            : json({ agents, total: agents.length, hasMore: false, directoryVersion: 'stable' });
        if (url.pathname === '/api/live') return json({ inventory: String(version), claims: '1', agents: '1', directory: '1' });
        if (url.pathname === '/api/products/status-read') {
            const refs = route.request().postDataJSON().products;
            assert.ok(refs.length <= 100); statusReads.push(refs);
            const states = [], staleIds = [];
            for (const ref of refs) {
                const product = products.find(p => p.spuId === ref.spuId);
                if (!product || ref.sourceIdentity !== product.sourceIdentity) { staleIds.push(ref.spuId); continue; }
                states.push({ spuId: product.spuId, sourceIdentity: product.sourceIdentity, blocked: product.blocked,
                    sendBlocked: product.sendBlocked, blockedReason: '', blockedAt: null, errorNotice: structuredClone(product.errorNotice) });
            }
            if (holdStatus) await new Promise(resolve => statusGates.push(resolve));
            return failed ? json({ error: '读取失败' }, 503) : json({ products: states, staleIds });
        }
        if (url.pathname === '/api/products/error-details') {
            const p = products.find(p => p.spuId === url.searchParams.get('spuId'));
            return json({ sendBlocked: p.sendBlocked, notice: { reason: p.errorNotice?.summary, skuCode: 'SKU-ERROR', code: '2000225' } });
        }
        if (url.pathname === '/api/direct-create-capability') return json({ directCreate: true });
        if (url.pathname === '/api/relay/send') {
            const body = route.request().postDataJSON(); sends.push(body);
            if (holdSends) await new Promise(resolve => gates.push(resolve));
            return json({ sent: body.spuIds.length, skippedBlocked: [] });
        }
        if (url.pathname === '/api/stores') return json({ stores: [], total: 0, counts: {} });
        if (url.pathname === '/api/ziniao/stores') return json({ stores: [] });
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (files.has(file)) return route.fulfill({ status: 200, body: files.get(file), contentType:
            file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
        return route.fulfill({ status: 404, body: '隔离测试未提供此路径' });
    });
    await page.goto(origin + '/#/products');
    await page.locator('[data-product-row]').first().waitFor();
    await page.evaluate(() => receiveLiveSnapshot({ inventory: '1', claims: '1', agents: '1', directory: '1' }));
    await page.waitForFunction(() => latestLive && !catalogStatusBusy && !autoRefreshBusy);
    return { page, context, products, sends, statusReads, errors, get overviewReads() { return overviewReads; },
        fail(value) { failed = value; }, failDirectory(value) { directoryFails = value; },
        hold() { holdSends = true; }, release() { holdSends = false; gates.splice(0).forEach(resolve => resolve()); },
        holdStatus() { holdStatus = true; }, releaseStatus() { holdStatus = false; statusGates.splice(0).forEach(resolve => resolve()); },
        holdOverview() { holdOverview = true; }, releaseOverview() { holdOverview = false; overviewGates.splice(0).forEach(resolve => resolve()); },
        async notify() { version++; await page.evaluate(v => receiveLiveSnapshot({ inventory: String(v), claims: '1', agents: String(v), directory: '1' }), version); },
        mark(index, reason = '化妆品成分不存在，请删除指定成分') {
            const p = products[index]; p.sendBlocked = p.blocked = true;
            p.errorNotice = { sourceStoreId: 'temu:111', spuId: p.spuId, sourceInstanceId: 'isolated-instance',
                summary: reason, code: '2000225', noticeEpoch: 1 };
        },
        unblock(index) { products[index].blocked = products[index].sendBlocked = false; products[index].errorNotice = null; } };
}

/** 通过真实弹窗选择目标店，不直接改隐藏 select 冒充用户操作。 */
async function targets(page) {
    await page.locator('#batch-target-trigger').click();
    await page.locator('label:has(#batch-target-select-all)').click();
    await page.locator('#batch-target-dialog button[value="apply"]').click();
}

try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 800 }]]) {
        const f = await fixture(viewport), { page } = f;
        await page.locator('.row-select').first().click();
        await page.locator('#product-page-next').click();
        await page.locator('[data-spu="9100000021"]').waitFor();
        await page.locator('.row-select').first().click();
        await page.locator('#product-search').fill('未提交的搜索草稿');
        await page.locator('#batch-target-trigger').click();
        await page.locator('#batch-target-search').fill('目标店');
        await page.locator('#batch-target-options label').first().click();
        await page.locator('#batch-target-search').focus();
        await page.evaluate(() => { globalThis.savedRow = document.querySelector('[data-product-row]'); globalThis.savedScroll = scrollY; });
        const reads = f.overviewReads;
        f.failDirectory(true); f.mark(0); f.mark(20, '<img src=x onerror=alert(1)>净含量缺失'); await f.notify();
        await page.waitForFunction(() => document.querySelector('[data-product-row]')?.dataset.blocked === '1');
        assert.equal(await page.evaluate(() => globalThis.savedRow === document.querySelector('[data-product-row]')), true);
        assert.equal(await page.evaluate(() => scrollY === globalThis.savedScroll), true);
        assert.equal(await page.locator('#product-search').inputValue(), '未提交的搜索草稿');
        assert.equal(await page.locator('#batch-target-search').inputValue(), '目标店');
        assert.equal(await page.locator('#batch-target-dialog').evaluate(node => node.open), true);
        assert.equal(await page.locator('#batch-target-options input').first().isChecked(), true);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'batch-target-search');
        assert.match(await page.locator('#selection-count').innerText(), /已选择 2 个.*可发送 0 个.*标红跳过 2 个/);
        assert.equal(await page.locator('[data-transfer-spu]').first().isDisabled(), true);
        assert.equal(f.overviewReads, reads, '操作中不得重读或重建列表');
        assert.ok(f.statusReads.at(-1).some(ref => ref.spuId === f.products[0].spuId), '跨页选择必须同步');
        await page.locator('#batch-target-dialog button[value="apply"]').click();
        await page.screenshot({ path: new URL(`product-status-marked-${name}.png`, output).pathname.slice(1), fullPage: true });
        const bounds = await page.locator('[data-product-row]').first().evaluate(row => {
            const status = row.querySelector('[data-product-status]').getBoundingClientRect();
            const main = row.querySelector('.product-row-main').getBoundingClientRect();
            const actions = row.querySelector('.row-actions').getBoundingClientRect();
            const overlap = (a, b) => Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top);
            return { overlapMain: overlap(status, main), overlapActions: overlap(status, actions) };
        });
        assert.deepEqual(bounds, { overlapMain: false, overlapActions: false });
        await page.locator('[data-product-error]').click();
        await page.getByRole('dialog', { name: '商品错误详情' }).getByText('<img src=x onerror=alert(1)>净含量缺失', { exact: true }).waitFor();
        assert.equal(await page.locator('.product-error-dialog img').count(), 0, '错误原因不得成为 HTML');
        await page.getByRole('dialog', { name: '商品错误详情' }).getByRole('button', { name: '关闭', exact: true }).click();
        f.failDirectory(false); f.unblock(0); f.unblock(20); await f.notify();
        await page.waitForFunction(() => document.querySelector('[data-product-row]')?.dataset.blocked === '0');
        assert.match(await page.locator('#selection-count').innerText(), /可发送 2 个.*标红跳过 0 个/);
        assert.equal(await page.locator('#batch-direct-create').isEnabled(), true);
        f.fail(true); f.mark(20); await f.notify();
        await page.waitForTimeout(200);
        assert.equal(await page.locator('[data-product-row]').first().getAttribute('data-blocked'), '0', '失败保持已有状态');
        f.fail(false);
        await page.waitForFunction(() => document.querySelector('[data-product-row]')?.dataset.blocked === '1');
        // 相同 SPU 重导为另一实例时旧行失效，不承接新实例，也不继续沿用旧选择。
        f.products[20].sourceIdentity = 'f'.repeat(64); f.unblock(20); await f.notify();
        await page.getByText('来源已变化，请刷新列表', { exact: true }).waitFor();
        assert.match(await page.locator('#selection-count').innerText(), /已选择 1 个/);
        assert.equal(await page.locator('[data-transfer-spu]').first().isDisabled(), true);
        assert.equal(await page.locator('[data-product-row]').first().getAttribute('data-blocked'), '0', '旧实例标记不能染红替换后的来源');
        const width = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
        assert.ok(width.width <= width.viewport + 1);
        await page.screenshot({ path: new URL(`product-status-live-${name}.png`, output).pathname.slice(1), fullPage: true });
        assert.deepEqual(f.errors, []); await f.context.close();
    }
    const foreground = await fixture({ width: 1280, height: 900 });
    await foreground.page.locator('.row-select').first().click();
    // 前台恢复强制核对当前实例，即使最后收到的版本号相同也不依赖旧内存状态。
    foreground.mark(0);
    await foreground.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await foreground.page.waitForFunction(() => document.querySelector('[data-product-row]')?.dataset.blocked === '1');
    const previousReads = foreground.statusReads.length;
    await foreground.page.evaluate(() => receiveLiveSnapshot(latestLive));
    await foreground.page.waitForTimeout(1200);
    assert.equal(foreground.statusReads.length, previousReads, '相同通知不得重复下载状态');
    await foreground.context.close();
    const racing = await fixture({ width: 1280, height: 900 });
    racing.holdOverview(); const initialReads = racing.overviewReads; await racing.notify();
    for (let i = 0; i < 100 && racing.overviewReads === initialReads; i++) await racing.page.waitForTimeout(10);
    assert.ok(racing.overviewReads > initialReads, '必须先挂起真实结构读取');
    racing.mark(0); await racing.notify();
    await racing.page.waitForFunction(() => document.querySelector('[data-product-row]')?.dataset.blocked === '1');
    await racing.page.evaluate(() => {
        globalThis.staleRedCleared = false;
        new MutationObserver(() => { if (document.querySelector('[data-spu="9100000001"]')?.dataset.blocked === '0') globalThis.staleRedCleared = true; })
            .observe(document.querySelector('.product-list'), { subtree: true, childList: true, attributes: true });
    });
    racing.releaseOverview(); await racing.page.waitForTimeout(1600);
    assert.equal(await racing.page.evaluate(() => globalThis.staleRedCleared), false, '迟到旧列表不能覆盖新红标');
    assert.deepEqual(racing.errors, []); await racing.context.close();
    const f = await fixture({ width: 1280, height: 900 }, 25), { page } = f;
    await page.locator('label:has(#select-all-products)').click(); await targets(page);
    f.hold(); await page.locator('#batch-direct-create').click();
    await page.getByRole('dialog', { name: '确认批量上架' }).getByRole('button', { name: '确认发送', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#batch-direct-create')?.textContent === '发送中…');
    for (let i = 0; i < 100 && f.sends.length < 2; i++) await page.waitForTimeout(10);
    assert.equal(f.sends.length, 2);
    await page.locator('#product-page-next').click();
    await page.locator('[data-spu="9100000021"]').waitFor();
    await page.locator('#clear-product-selection').click();
    f.holdStatus(); f.mark(19); await f.notify();
    await page.waitForFunction(() => catalogStatusBusy);
    assert.ok(f.statusReads.at(-1).some(ref => ref.spuId === f.products[19].spuId), '清空勾选及翻页不能移除发送快照状态');
    f.releaseStatus(); await page.waitForFunction(() => !catalogStatusBusy);
    f.release();
    await page.waitForFunction(() => document.querySelector('#catalog-toast')?.textContent.includes('实际发出 57 份'));
    assert.equal(f.sends.length, 6);
    for (const send of f.sends.slice(2)) assert.ok(!send.spuIds.includes(f.products[19].spuId));
    assert.deepEqual(f.errors, []); await f.context.close();
    // 旧页状态响应晚于导航返回时，必须丢弃，不能在店铺认领页写入商品单元格。
    const stale = await fixture({ width: 1280, height: 900 });
    stale.holdStatus(); stale.mark(0); await stale.notify();
    await stale.page.waitForFunction(() => catalogStatusBusy);
    await stale.page.getByRole('link', { name: '店铺认领', exact: true }).click();
    await stale.page.getByRole('heading', { name: '店铺认领', exact: true }).waitFor();
    stale.releaseStatus(); await stale.page.waitForFunction(() => !catalogStatusBusy);
    assert.equal(await stale.page.locator('[data-product-row]').count(), 0);
    assert.deepEqual(stale.errors, []); await stale.context.close();
    console.log(JSON.stringify({ passed: true, viewports: 2, realApp: true, crossPage: true, operationPreserved: true,
        directoryIndependent: true, failureRetries: true, staleIdentityRejected: true, unstartedChunksFiltered: true, realPlatformRequests: 0 }));
} finally { await browser.close(); }
