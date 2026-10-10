/** 商品库真实行模板与错误弹窗的离线 Chromium 验收；禁止连接线上或目标平台。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const module = await readFile(new URL('../public/product-error-ui.js', import.meta.url), 'utf8');
/** 只提取生产函数，不在测试里重新设计另一套商品行。 */
function implementation(name) {
    const start = app.indexOf(`function ${name}(`); assert.ok(start >= 0, name);
    const text = app.slice(start), end = /^}\r?$/m.exec(text); assert.ok(end);
    return text.slice(0, end.index + end[0].length);
}
const libraryHelpers = app.slice(app.indexOf('const isCatalogRoute'), app.indexOf('const storeViews'));
const functions = `const currentAccount = { isAdmin: false };\n${libraryHelpers}\n` + ['escapeHtml', 'safeImageUrl', 'productExtCodes', 'skuExtCodes', 'identifierText', 'renderProductRows'].map(implementation).join('\n');
const output = new URL('../../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext(); await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 700 }]]) {
        await page.setViewportSize(viewport);
        await page.setContent('<!doctype html><html lang="zh"><meta charset="utf-8"><body><main id="app" style="margin:16px"></main></body></html>');
        await page.addStyleTag({ content: css }); await page.addScriptTag({ content: module });
        await page.evaluate(({ functions }) => {
            const product = { spuId: '1234567890', spuIds: ['1234567890'], title: '商品资料异常示例',
                articleNo: 'MERCHANT-' + 'A'.repeat(140), productExtCodes: [], skuIds: ['SKU-1'], category: '身体护理',
                sourceStoreIds: ['temu:1'], batchIds: ['batch'], sendBlocked: true,
                errorNotice: { sourceStoreId: 'temu:1', spuId: '1234567890', sourceInstanceId: 'fixture', noticeEpoch: 1,
                    summary: 'SKU-A 包装重量必须大于0，资料校验失败：' + '长错误原因'.repeat(80) } };
            const batches = [{ id: 'batch', sourceStoreId: 'temu:1', sourceStoreName: '来源验证店' }];
            document.getElementById('app').innerHTML = '<div class="product-list">' + new Function('product', 'batches', `${functions}; return renderProductRows([product],true,[{}],batches)`)(product, batches) + '</div>';
            window.fixtureProduct = product;
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copied = text; } } });
            document.querySelector('[data-product-error]').addEventListener('click', event => {
                void TemuProductErrorUI.open(product, event.currentTarget, async () => ({ sendBlocked: true, notice: {
                    reason: '<img src=x onerror="window.xss=true">SKU-A 包装重量必须大于0\n' + '平台详细原因'.repeat(160),
                    skuCode: 'SKU-' + 'S'.repeat(160), code: 'PRODUCT_SKU_INVALID', stage: '提交', truncated: true,
                    targetStoreName: '目标验证店', at: '2026-10-07T10:00:00.000Z' } }));
            });
        }, { functions });
        assert.equal(await page.locator('[data-transfer-spu]').isEnabled(), false, '标红入口首次渲染即禁用');
        await page.locator('.product-row').scrollIntoViewIfNeeded();
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.match(await page.locator('.product-error-summary').innerText(), /包装重量/,
            JSON.stringify(await page.locator('.product-error-summary').evaluate(node => ({ html: node.outerHTML, display: getComputedStyle(node).display, rect: node.getBoundingClientRect().toJSON(), parent: node.parentElement.outerHTML }))));
        const boxes = await page.locator('.product-row').evaluate(row => {
            const nodes = [...row.children];
            const overlaps = [];
            for (let a = 0; a < nodes.length; a++) for (let b = a + 1; b < nodes.length; b++) {
                const x = nodes[a].getBoundingClientRect(), y = nodes[b].getBoundingClientRect();
                if (x.width && y.width && Math.min(x.right, y.right) - Math.max(x.left, y.left) > 1
                    && Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 1) overlaps.push([nodes[a].className, nodes[b].className]);
            }
            return { overlaps, rowWidth: row.scrollWidth, rowClient: row.clientWidth, documentWidth: document.documentElement.scrollWidth, viewport: innerWidth };
        });
        assert.deepEqual(boxes.overlaps, [], JSON.stringify(boxes));
        assert.ok(boxes.documentWidth <= boxes.viewport + 1, JSON.stringify(boxes));
        await page.screenshot({ path: new URL(`product-error-row-${name}.png`, output).pathname.slice(1), fullPage: true });
        await page.getByRole('button', { name: '错误详情' }).click();
        const dialog = page.getByRole('dialog', { name: '商品错误详情' }); await dialog.waitFor();
        assert.match(await dialog.innerText(), /回传内容已截断/);
        assert.equal(await dialog.locator('img').count(), 0);
        assert.equal(await page.evaluate(() => Boolean(window.xss)), false);
        const bounds = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
            viewport: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
        assert.ok(bounds.left >= 0 && bounds.right <= bounds.viewport && bounds.scroll <= bounds.client + 1, JSON.stringify(bounds));
        await page.screenshot({ path: new URL(`product-error-dialog-${name}.png`, output).pathname.slice(1), fullPage: true });
        await page.getByRole('button', { name: '复制错误信息' }).click();
        assert.match(await page.evaluate(() => window.copied), /SKU-SS/);
        await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' });
        assert.equal(await page.locator('[data-product-error]').evaluate(node => node === document.activeElement), true);
        await page.evaluate(async () => {
            await TemuProductErrorUI.open(window.fixtureProduct, document.querySelector('[data-product-error]'), async () => { throw Error('403 无权读取'); });
        });
        assert.match(await page.getByRole('dialog').innerText(), /无法读取错误详情.*403/);
        await page.evaluate(() => TemuProductErrorUI.close());
        await page.evaluate(async () => {
            await TemuProductErrorUI.open({ ...window.fixtureProduct, errorNotice: null, sendBlocked: true, blocked: true, blockedReason: '历史真实原因' },
                document.querySelector('[data-product-error]'), () => { throw Error('旧红标不调用新详情'); });
        });
        assert.match(await page.getByRole('dialog').innerText(), /历史真实原因/);
        assert.match(await page.getByRole('dialog').innerText(), /已停止后续分发/);
        await page.evaluate(() => TemuProductErrorUI.close());
    }
    console.log(JSON.stringify({ passed: true, viewports: 2, realRowTemplate: true, pureText: true, focusReturned: true, permissionFailure: true, legacyFallback: true, realPlatformRequests: 0 }));
} finally { await browser.close(); }
