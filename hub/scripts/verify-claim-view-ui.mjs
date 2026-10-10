/** 离线浏览器核验两类店铺列表、计数和认领迁移；所有接口拦截，不操作真实账户或店铺。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const files = new Map(await Promise.all(['index.html', 'app.js', 'styles.css', 'product-detail.js', 'product-error-ui.js', 'favicon.svg']
    .map(async name => [name, await readFile(new URL('../public/' + name, import.meta.url))])));
for (const name of ['Archivo.ttf', 'ArchivoNarrow.ttf']) files.set('fonts/' + name, await readFile(new URL('../public/fonts/' + name, import.meta.url)));
const origin = 'https://claim-view-preview.invalid';
const output = new URL('../../output/playwright/', import.meta.url); await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        const context = await browser.newContext({ viewport, serviceWorkers: 'block' });
        // 仅派发内存版本通知，模拟另一窗口认领，不建立任何真实推送连接。
        await context.addInitScript(() => { globalThis.EventSource = class {
            readyState = 1; constructor() { globalThis.claimTestStream = this; }
            addEventListener(name, listener) { if (name === 'live') this.onLive = listener; } close() {}
        }; });
        const page = await context.newPage(), errors = [], writes = [];
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.accept());
        const stores = Array.from({ length: 7 }, (_, i) => ({ storeId: `temu:${i + 1}`, storeName: `隔离店铺 ${i + 1}`,
            claimState: i < 4 ? 'mine' : i === 4 ? 'others' : 'unclaimed', online: i < 3 || i === 4,
            pluginVersion: '11.0.4', ownerNameMasked: i < 4 ? '138****0001' : i === 4 ? '138****0002' : '' }));
        await context.route('**/*', async route => {
            const url = new URL(route.request().url()); assert.equal(url.origin, origin, '禁止真实平台请求');
            const json = value => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
            if (url.pathname === '/api/me') return json({ user: { id: 'synthetic-owner', username: '隔离测试', accountType: 'test' } });
            if (url.pathname === '/api/live') return json({ inventory: '1', claims: '1', agents: '1', directory: '1' });
            if (url.pathname === '/api/agents') return json({ agents: [], total: 0 });
            if (url.pathname === '/api/ziniao/stores') return json({ stores: [] });
            if (url.pathname === '/api/overview') return json({ products: [], productCount: 0, productTotal: 0, batches: [] });
            if (url.pathname === '/api/stores') {
                const view = url.searchParams.get('view');
                assert.ok(['online', 'mine'].includes(view));
                const bucket = stores.filter(store => view === 'mine' ? store.claimState === 'mine' : store.claimState !== 'mine');
                const filters = Object.fromEntries(['q', 'online', 'claimState'].map(key => [key, url.searchParams.get(key) || '']));
                const filtered = bucket.filter(store => (!filters.q || store.storeName.includes(filters.q))
                    && (!filters.claimState || filters.claimState === store.claimState)
                    && (!filters.online || String(Number(store.online)) === filters.online));
                const offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
                return json({ stores: filtered.slice(offset, offset + limit), total: filtered.length, hasMore: offset + limit < filtered.length, filters,
                    counts: { online: bucket.filter(s => s.online).length, offline: bucket.filter(s => !s.online).length,
                        mine: stores.filter(s => s.claimState === 'mine').length, others: bucket.filter(s => s.claimState === 'others').length,
                        unclaimed: bucket.filter(s => s.claimState === 'unclaimed').length },
                    ...(view === 'online' ? { unclaimableStoreIds: stores.filter(s => s.claimState !== 'unclaimed').map(s => s.storeId) } : {}) });
            }
            if (['/api/stores/claim', '/api/stores/release'].includes(url.pathname)) {
                writes.push(url.pathname); const body = route.request().postDataJSON();
                const store = stores.find(s => s.storeId === body.storeId); assert.ok(store);
                store.claimState = url.pathname.endsWith('/claim') ? 'mine' : 'unclaimed';
                return json({ ok: true, claimedCount: 1 });
            }
            assert.equal(route.request().method(), 'GET', '除模拟认领接口外不得写入');
            const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
            if (files.has(file)) return route.fulfill({ body: files.get(file), contentType: file.endsWith('.js') ? 'text/javascript'
                : file.endsWith('.css') ? 'text/css' : file.endsWith('.ttf') ? 'font/ttf' : 'text/html' });
            throw Error('未提供隔离路径:' + url.pathname);
        });
        await page.goto(origin + '/#/stores'); await page.locator('#store-list [data-store-row]').first().waitFor();
        assert.equal(await page.locator('#store-list [data-claim-state="mine"]').count(), 0);
        assert.equal(await page.locator('#store-list [data-store-row]').count(), 3);
        assert.equal(await page.locator('[data-store-view-button="online"] b').innerText(), '3');
        assert.equal(await page.locator('[data-store-view-button="mine"] b').innerText(), '4');
        assert.equal(await page.locator('#online-store-filter option[value="mine"]').count(), 0);
        assert.equal(await page.locator('#store-online-count').innerText(), '1');
        const width = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
        assert.ok(width.width <= width.viewport + 1, JSON.stringify(width));
        await page.screenshot({ path: fileURLToPath(new URL(`claim-view-${viewport.width}-all.png`, output)), fullPage: true });
        await page.locator('[data-store-view-button="mine"]').click();
        assert.equal(await page.locator('#mine-store-list [data-store-row]').count(), 4);
        assert.equal(await page.locator('#store-online-count').innerText(), '3');
        await page.screenshot({ path: fileURLToPath(new URL(`claim-view-${viewport.width}-mine.png`, output)), fullPage: true });
        await page.locator('[data-release-store="temu:1"]').click();
        await page.waitForFunction(() => document.querySelector('[data-store-view-button="online"] b')?.textContent === '4');
        assert.equal(await page.locator('#mine-store-list [data-store-row]').count(), 3);
        await page.locator('[data-store-view-button="online"]').click();
        await page.locator('[data-claim-store="temu:1"]').click();
        await page.waitForFunction(() => document.querySelector('[data-store-view-button="online"] b')?.textContent === '3');
        assert.equal(await page.locator('#mine-store-list [data-store-row]').count(), 4);
        assert.deepEqual(writes, ['/api/stores/release', '/api/stores/claim']); assert.deepEqual(errors, []);
        // 保留另一待认领店的跨页选择；目标店被外部认领且本人搜索排除时，必须只撤销失效选择。
        await page.locator('#store-list label.row-select').filter({ has: page.locator('input[value="temu:6"]') }).click();
        await page.locator('#store-list label.row-select').filter({ has: page.locator('input[value="temu:7"]') }).click();
        await page.locator('[data-store-view-button="mine"]').click();
        await page.locator('#mine-store-search').fill('隔离店铺 2');
        await page.locator('#mine-store-search-form button').click();
        await page.waitForFunction(() => document.querySelectorAll('#mine-store-list [data-store-row]').length === 1);
        stores.find(s => s.storeId === 'temu:6').claimState = 'mine';
        await page.evaluate(() => globalThis.claimTestStream.onLive({ data: JSON.stringify({ inventory: '1', claims: '2', agents: '1', directory: '2' }) }));
        await page.waitForFunction(() => document.querySelector('#store-claim-selected-count')?.textContent === '1');
        await page.locator('[data-store-view-button="online"]').click();
        assert.equal(await page.locator('#store-list input[value="temu:6"]').count(), 0);
        assert.equal(await page.locator('#store-list input[value="temu:7"]').isChecked(), true);
        assert.equal(await page.locator('#claim-selected-stores').isEnabled(), true);
        assert.deepEqual(writes, ['/api/stores/release', '/api/stores/claim']); assert.deepEqual(errors, []);
        await context.close();
    }
    console.log(JSON.stringify({ claimViewUI: true, ownHiddenInAll: true, ownKeptInMine: true, claimReleaseMovesRows: true, viewports: 2, realWrites: 0 }));
} finally { await browser.close(); }
