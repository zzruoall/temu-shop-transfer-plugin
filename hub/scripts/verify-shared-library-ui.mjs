/** 完整网页的离线浏览器验收：切库、同 SPU 来源、测试注册与分类计数，不访问真实平台。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const files = new Map(await Promise.all(['index.html', 'app.js', 'styles.css', 'product-detail.js', 'product-error-ui.js', 'favicon.svg', 'admin.html', 'admin.js', 'admin.css']
    .map(async name => [name, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
const origin = 'https://library-preview.invalid', output = new URL('../../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 800 }]]) {
        const context = await browser.newContext({ viewport });
        await context.addInitScript(() => {
            window.streams = [];
            globalThis.EventSource = class {
                constructor(url) { this.url = url; this.readyState = 1; window.streams.push(this); }
                addEventListener() {} close() { this.closed = true; this.readyState = 2; }
            };
        });
        const page = await context.newPage(), errors = [], sends = [];
        page.on('pageerror', error => errors.push(error.message));
        const products = ['111', '112'].map((id, index) => ({ spuId: '1234567890', spuIds: ['1234567890'],
            title: `来源商品${index}`, sourceStoreIds: [`temu:${id}`], batchIds: [`batch${index}`], images: [],
            productKey: String(index + 1).padStart(64, '0'), sourceIdentity: String(index + 1).padStart(64, '1'),
            publicationData: { sourceBatchId: `batch${index}` }, blocked: false, sendBlocked: false, canDelete: index === 1 }));
        const deletes = [];
        let testUsers = [{ id: 'test1', username: '13800000002', accountType: 'test', role: 'user' }];
        let admin = false;
        await context.route('**/*', async route => {
            const url = new URL(route.request().url()); assert.equal(url.origin, origin);
            const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
            if (url.pathname === '/api/me') return json({ user: { id: 'p1', username: '13810000001', accountType: 'production' }, isAdmin: admin });
            if (url.pathname === '/api/overview') {
                const rows = url.searchParams.get('library') === 'personal' ? products.slice(1) : products;
                return json({ products: rows, productCount: rows.length, productTotal: rows.length,
                    batches: rows.map(p => ({ id: p.batchIds[0], sourceStoreId: p.sourceStoreIds[0], sourceStoreName: p.title })) });
            }
            // 浏览器只删除临时夹具：记录来源限定，不能把相同 SPU 的他人行一起移除。
            if (url.pathname === '/api/products' && route.request().method() === 'DELETE') {
                const body = route.request().postDataJSON(); deletes.push(body);
                assert.deepEqual(body, { spuIds: ['1234567890'], storeIds: ['temu:112'] });
                const index = products.findIndex(p => p.sourceStoreIds.includes('temu:112'));
                assert.ok(index >= 0); products.splice(index, 1);
                return json({ ok: true });
            }
            if (url.pathname === '/api/agents') return json({ agents: [{ storeId: 'temu:222', storeName: '我的目标店', online: true,
                pluginDetected: true, identityMatched: true, canReceiveUploads: true, pluginVersion: '11.0.4' }], total: 1 });
            if (url.pathname.startsWith('/api/products/') && route.request().method() === 'GET') {
                const product = products.find(p => p.sourceStoreIds.includes(url.searchParams.get('sourceStoreId')));
                return json({ product, batches: [] });
            }
            if (url.pathname === '/api/products/status-read') {
                const refs = route.request().postDataJSON().products;
                assert.equal(new Set(refs.map(ref => ref.spuId)).size, refs.length);
                return json({ products: refs.map(ref => ({ spuId: ref.spuId, sourceIdentity: ref.sourceIdentity, blocked: false, sendBlocked: false })), staleIds: [] });
            }
            if (url.pathname === '/api/direct-create-capability') return json({ directCreate: true,
                actionTypes: ['product_create', 'qualification_upload'], minimumPluginVersion: '11.0.4' });
            if (url.pathname === '/api/relay/send') { const body = route.request().postDataJSON(); sends.push(body); return json({ sent: body.spuIds.length }); }
            if (url.pathname === '/api/live') return json({ inventory: '1', claims: '1', agents: '1', directory: '1' });
            if (url.pathname === '/api/ziniao/stores') return json({ stores: [] });
            if (url.pathname === '/api/stores') return json({ stores: [], total: 0, counts: {} });
            if (url.pathname === '/api/admin/stores/deleted') return json({ stores: [] });
            if (url.pathname === '/api/admin/users') return json({ users: [{ id: 'p1', username: '13810000001', accountType: 'production', role: 'admin' }, ...testUsers], registrationOpen: true });
            if (url.pathname === '/api/admin/users/test') {
                const body = route.request().postDataJSON(); assert.deepEqual(Object.keys(body).sort(), ['password', 'username']);
                const user = { id: 'test2', username: body.username, accountType: 'test', role: 'user' };
                testUsers.push(user); return json({ user }, 201);
            }
            const file = url.pathname === '/' ? 'index.html' : url.pathname === '/admin' ? 'admin.html' : url.pathname.slice(1);
            if (files.has(file)) return route.fulfill({ status: 200, body: files.get(file), contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
            return route.fulfill({ status: 404, body: '隔离测试未提供此路径' });
        });
        await page.goto(origin + '/#/products');
        await page.locator('[data-product-row]').nth(1).waitFor();
        // 两种商品库使用同一精简工具栏，已移除的查看方式与导入资料不随切库恢复。
        assert.equal(await page.locator('#product-view-mode, #catalog-upload-button, #catalog-files').count(), 0);
        await page.locator('[data-product-row]').nth(1).locator('.row-select').click();
        assert.match(await page.locator('#selection-count').innerText(), /已选择 1 个/);
        await page.locator('[data-product-row]').first().locator('.row-select').click();
        assert.match(await page.locator('#selection-count').innerText(), /已选择 2 个/);
        assert.equal(await page.locator('[data-delete-spu]').first().isVisible(), false);
        assert.equal(await page.locator('[data-delete-spu]').nth(1).isVisible(), true);
        assert.equal(await page.locator('#delete-selected').isVisible(), true);
        assert.equal(await page.locator('#delete-selected').isEnabled(), true);
        await page.locator('#delete-selected').click();
        assert.match(await page.locator('#inventory-delete-description').innerText(), /另有 1 个商品无删除权限/);
        await page.locator('#inventory-delete-dialog button[value="cancel"]').click();
        assert.deepEqual(deletes, [], '取消删除不发送请求');
        await page.locator('#clear-product-selection').click();
        await page.locator('[data-product-row]').first().locator('.row-select').click();
        assert.equal(await page.locator('#delete-selected').isEnabled(), false, '仅选择他人商品不允许批量删除');
        await page.locator('#clear-product-selection').click();
        await page.locator('[data-product-row]').nth(1).locator('[data-transfer-spu]').click();
        await page.locator('#single-target-options label').click();
        await page.locator('#single-target-dialog button[value="product_create"]').click();
        await page.waitForFunction(() => document.querySelector('#catalog-toast')?.textContent.includes('实际发出 1 份'));
        assert.equal(sends[0].sourceStoreId, 'temu:112'); assert.equal(sends[0].sourceBatchId, 'batch1');
        assert.equal(sends[0].actionType, 'product_create');
        await page.locator('[data-product-row]').first().scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: new URL(`shared-library-${name}.png`, output).pathname.slice(1), fullPage: true });
        await page.locator('[data-product-row]').first().locator('.row-select').click();
        await page.getByRole('link', { name: '个人商品库', exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('[data-product-row]').length === 1);
        assert.equal(await page.locator('#product-view-mode, #catalog-upload-button, #catalog-files').count(), 0);
        assert.match(await page.locator('#selection-count').innerText(), /已选择 0 个/);
        assert.equal(await page.locator('[data-product-row]').getAttribute('data-source-stores'), 'temu:112');
        assert.equal(await page.locator('[data-delete-spu]').isVisible(), true);
        const streams = await page.evaluate(() => streams.map(stream => ({ url: stream.url, closed: !!stream.closed })));
        assert.ok(streams.some(stream => stream.url.endsWith('library=shared') && stream.closed));
        assert.ok(streams.some(stream => stream.url.endsWith('library=personal') && !stream.closed));
        const width = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
        assert.ok(width.width <= width.viewport + 1, JSON.stringify(width));
        await page.locator('[data-product-row]').first().scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.screenshot({ path: new URL(`personal-library-${name}.png`, output).pathname.slice(1), fullPage: true });
        await page.locator('[data-product-row] .row-detail').click();
        await page.locator('.product-detail-top').waitFor();
        assert.equal(await page.locator('#delete-current-product').isVisible(), true);
        assert.equal(await page.locator('.back-link').getAttribute('href'), '#/products/mine');
        await page.locator('.back-link').click();
        await page.locator('[data-product-row]').waitFor();
        await page.getByRole('link', { name: '商品库', exact: true }).last().click();
        await page.locator('[data-product-row]').nth(1).waitFor();
        await page.locator('[data-product-row]').first().locator('.row-detail').click();
        await page.locator('.product-detail-top').waitFor();
        assert.equal(await page.locator('#delete-current-product').isVisible(), false);
        await page.locator('.back-link').click();
        await page.locator('[data-product-row]').nth(1).waitFor();
        await page.locator('[data-product-row]').first().locator('.row-select').click();
        await page.locator('[data-product-row]').nth(1).locator('.row-select').click();
        await page.locator('#delete-selected').click();
        await page.locator('#inventory-delete-dialog button[value="delete"]').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-product-row]').length === 1);
        assert.equal(deletes.length, 1);
        assert.equal(await page.locator('[data-product-row]').getAttribute('data-source-stores'), 'temu:111');
        assert.match(await page.locator('#selection-count').innerText(), /已选择 0 个/);
        admin = true;
        await page.goto(origin + '/admin');
        await page.locator('[data-user-row]').waitFor({ state: 'attached' });
        await page.locator('[data-admin-view-button="users"]').click();
        assert.equal(await page.locator('[data-user-row]').count(), 1);
        assert.match(await page.locator('#user-count').innerText(), /1 个/);
        await page.locator('#admin-account-type').selectOption('test');
        await page.waitForFunction(() => document.querySelector('[data-user-row]')?.textContent.includes('13800000002'));
        assert.equal(await page.locator('[data-user-row]').count(), 1);
        await page.locator('#admin-create-test [name="username"]').fill('13920000001');
        await page.locator('#admin-create-test [name="password"]').fill('isolated-password');
        await page.locator('#admin-create-test button').click();
        await page.waitForFunction(() => document.querySelectorAll('[data-user-row]').length === 2);
        assert.match(await page.locator('#user-count').innerText(), /2 个/);
        assert.ok(!(await page.locator('#admin-user-list').innerText()).includes('13810000001'));
        await page.screenshot({ path: new URL(`test-accounts-${name}.png`, output).pathname.slice(1), fullPage: true });
        assert.deepEqual(errors, []);
        await context.close();
    }
    console.log('shared library UI passed: desktop/mobile, source identity, selections, SSE scope, test registration');
} finally { await browser.close(); }
