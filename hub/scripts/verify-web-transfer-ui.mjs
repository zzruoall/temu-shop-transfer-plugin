/** 离线 Chromium 运行完整网站，网络全部替换为模拟接口；不连接生产或 Temu。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const files = new Map(await Promise.all(['index.html', 'app.js', 'styles.css', 'product-detail.js', 'product-error-ui.js', 'favicon.svg']
    .map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
const origin = 'https://temu-preview.invalid';
const output = new URL('../../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });

/** 模拟真实目录字段，持有发送响应以证明另一店能同时发起，不用真实平台延迟碰运气。 */
async function fixture(viewport, count = 6) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage(), errors = [], sends = [], gates = [];
    let hold = true, overviewReads = 0;
    const products = Array.from({ length: count }, (_, i) => ({ spuId: String(9100000001 + i), spuIds: [String(9100000001 + i)],
        title: `测试商品 ${i + 1}`, articleNo: `CODE-${i + 1}`, category: '身体护理', images: [], batchIds: ['batch'],
        publicationData: { sourceBatchId: 'batch' }, blocked: i < 2, sendBlocked: i < 2,
        blockedReason: i < 2 ? '当前类目净含量必填（错误码 2000135）' : '', sourceStoreIds: ['temu:111'] }));
    const agents = ['222', '333', '444'].map(id => ({ storeId: `temu:${id}`, storeName: `目标店 ${id}`, online: true,
        pluginDetected: true, identityMatched: true, canReceiveUploads: true, pluginVersion: '11.0.4' }));
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
        const url = new URL(route.request().url());
        assert.equal(url.origin, origin, '测试不得访问外部站点');
        const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        if (url.pathname === '/api/me') return json({ user: { username: '隔离测试账户' }, isAdmin: false });
        if (url.pathname === '/api/overview') {
            overviewReads++;
            return json({ products, batches: [{ id: 'batch', sourceStoreId: 'temu:111', sourceStoreName: '来源店' }],
                productCount: count, productTotal: count, sourceStores: [] });
        }
        if (url.pathname === '/api/agents') return json({ agents, total: agents.length, hasMore: false });
        if (url.pathname === '/api/live') return json({ inventory: '1', claims: '1', agents: '1', directory: '1' });
        if (url.pathname === '/api/events') return route.abort();
        if (url.pathname === '/api/direct-create-capability') return json({ directCreate: true,
            actionTypes: ['product_create', 'qualification_upload'], minimumPluginVersion: '11.0.4' });
        if (url.pathname === '/api/stores') return json({ stores: [], total: 0, counts: {} });
        if (url.pathname === '/api/ziniao/stores') return json({ stores: [] });
        if (url.pathname === '/api/relay/send') {
            const body = route.request().postDataJSON(); sends.push(body);
            if (hold) await new Promise(resolve => gates.push(resolve));
            return json({ sent: body.spuIds.length, skippedBlocked: [] });
        }
        const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        if (files.has(file)) return route.fulfill({ status: 200, body: files.get(file), contentType:
            file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
        return route.fulfill({ status: 404, body: '隔离测试未提供此路径' });
    });
    await page.goto(origin + '/#/products');
    await page.locator('[data-product-row]').first().waitFor();
    return { page, context, products, sends, errors, get overviewReads() { return overviewReads; },
        release() { hold = false; gates.splice(0).forEach(resolve => resolve()); } };
}

/** 未预选店直接打开共用弹窗选店；点击底部命令前不得产生发送。 */
async function selectAndConfirm(page) {
    await page.locator('label:has(#select-all-products)').click();
    assert.equal(await page.locator('#select-all-products').isChecked(), true);
    assert.equal(await page.locator('#batch-target-stores').evaluate(select => select.selectedOptions.length), 0);
    assert.equal(await page.locator('#batch-direct-create').isEnabled(), true);
    await page.locator('#batch-direct-create').click();
    const confirm = page.locator('#single-target-dialog');
    await page.locator('label:has(#single-target-select-all)').click();
    assert.equal(await page.locator('#single-target-select-all').isChecked(), true);
    assert.match(await confirm.innerText(), /标红跳过 2 个/);
    return confirm;
}

try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 390, height: 844 }]]) {
        const f = await fixture(viewport), { page } = f;
        assert.equal(await page.locator('a[href="#/products/all"]').count(), 0);
        assert.equal(await page.locator('[data-transfer-spu]').first().isEnabled(), false);
        // 模拟在线目录版本变化，实际更新函数不得重新启用标红行。
        await page.evaluate(async () => { await refreshCatalogTargets({ agents: 'next', claims: 'next' }, () => true); });
        assert.equal(await page.locator('[data-transfer-spu]').first().isEnabled(), false);
        const confirm = await selectAndConfirm(page);
        assert.match(await page.locator('#selection-count').innerText(), /已选择 6 个.*可发送 4 个.*标红跳过 2 个/);
        assert.match(await confirm.innerText(), /可发送 4 个/);
        const width = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
        assert.ok(width.width <= width.viewport + 1, JSON.stringify(width));
        await page.screenshot({ path: new URL(`web-transfer-confirm-${name}.png`, output).pathname.slice(1), fullPage: true });
        assert.equal(f.sends.length, 0);
        await confirm.locator('button[value="product_create"]').click();
        await page.waitForFunction(() => {
            const message = document.querySelector('#catalog-toast')?.textContent || '';
            if (message.includes('发送失败')) throw Error(message);
            return document.querySelector('#batch-direct-create')?.textContent === '发送中…';
        });
        // 两条网络请求都必须在任何一条响应前到达；第三店不能突破并发上限。
        for (let i = 0; i < 100 && f.sends.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal(f.sends.length, 2);
        assert.notEqual(f.sends[0].targetStoreId, f.sends[1].targetStoreId);
        for (const body of f.sends) {
            assert.deepEqual(body.spuIds, f.products.slice(2).map(p => p.spuId));
            assert.equal(body.actionType, 'product_create');
        }
        f.release();
        await page.waitForFunction(() => document.querySelector('#catalog-toast')?.textContent.includes('实际发出 12 份'));
        assert.equal(f.sends.length, 3); assert.deepEqual(f.errors, []);
        // 商品库仅通过插件采集入库，不再提供手工导入或展示模式的选择入口。
        assert.equal(await page.locator('#catalog-files, #catalog-upload-button, #product-view-mode').count(), 0);
        assert.equal(await page.getByRole('button', { name: '导入资料', exact: true }).count(), 0);
        assert.equal(new URL(page.url()).hash, '#/products');
        assert.doesNotMatch(await page.locator('#app').innerText(), /完整度|核验说明|响应数/);
        await page.screenshot({ path: new URL(`web-transfer-result-${name}.png`, output).pathname.slice(1), fullPage: true });
        await f.context.close();
    }
    const f = await fixture({ width: 1280, height: 900 }, 20), { page } = f;
    const confirm = await selectAndConfirm(page);
    await confirm.locator('button[value="product_create"]').click();
    for (let i = 0; i < 100 && f.sends.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.sends.length, 2);
    await page.getByRole('link', { name: '店铺认领', exact: true }).click();
    await page.getByRole('heading', { name: '店铺认领', exact: true }).waitFor();
    f.release();
    await page.waitForFunction(() => batchUploadBusy === false);
    assert.equal(f.sends.length, 2, '离页不能继续第二分段或第三店');
    for (const hash of ['#/products/all', '#/batch/old']) {
        await page.goto(origin + '/' + hash);
        await page.locator('[data-product-row]').first().waitFor();
        assert.equal(new URL(page.url()).hash, '#/products');
    }
    assert.deepEqual(f.errors, []); await f.context.close();
    console.log(JSON.stringify({ passed: true, viewports: 2, realApp: true, redButtonsRemainDisabled: true,
        selected: 6, perStoreSent: 4, maxConcurrent: 2, routeStopsRemaining: true, removedImportAndViewMode: true, oldRoutesRedirect: true,
        realPlatformRequests: 0 }));
} finally { await browser.close(); }
