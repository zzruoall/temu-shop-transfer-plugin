/** 复用真实渲染器离线验证折叠及图片归档入口，浏览器全部外网请求拦截。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { livePhotoRecord, sourceStoreId } from './live-photo-fixture.mjs';
import { parseLivePhotoRecord } from '../lib/product-live-photos.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const code = await readFile(new URL('../public/product-detail.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
const previewImage = await readFile(new URL('../../plugin/config/icon_48.png', import.meta.url));
const output = fileURLToPath(new URL('../../output/playwright/', import.meta.url));
await mkdir(output, { recursive: true });
const capture = { ...parseLivePhotoRecord(livePhotoRecord()).livePhotos, sourceStoreId };
capture.assets[0].name = '原图-' + '长文件名'.repeat(25) + '.jpeg';
const browser = await chromium.launch({ headless: true });
try {
    for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => route.request().url().includes('/api/live-photo-assets/')
            ? route.fulfill({ contentType: 'image/png', body: previewImage })
            : route.request().url() === 'http://preview.invalid/temu/' ? route.fulfill({ contentType: 'text/html', body: '<!doctype html><html></html>' }) : route.abort());
        await page.goto('http://preview.invalid/temu/');
        await page.setContent('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>实拍图离线预览</title></head><body><main id="fixture" style="max-width:1000px;margin:0 auto"></main></body></html>');
        await page.addStyleTag({ content: css }); await page.addScriptTag({ content: code });
        await page.evaluate(capture => {
            document.querySelector('#fixture').innerHTML = window.ProductDetailView.render({ title: '采集商品', detail: { content: '详情正文测试内容' }, livePhotoCaptures: [capture] });
        }, capture);
        const sections = page.locator('.detail-collapsible');
        assert.equal(await sections.count(), 2);
        assert.equal(await page.locator('details[open]').count(), 0);
        assert.equal(await sections.first().locator('.qualification-body').isVisible(), false);
        await page.screenshot({ path: path.join(output, `live-photo-collapsed-${width}.png`), fullPage: true });
        await sections.first().locator('summary').first().click();
        assert.equal(await sections.first().locator('.qualification-body').isVisible(), true);
        assert.equal(await sections.nth(1).locator(':scope > .qualification-body').isVisible(), false);
        await sections.nth(1).locator('summary').first().focus(); await page.keyboard.press('Enter');
        const groups = page.locator('details.detail-qualification');
        assert.equal(await groups.count(), 2);
        await groups.first().locator('summary').click();
        await page.waitForFunction(() => document.querySelector('.detail-live-photo img')?.naturalWidth > 0);
        assert.equal(await groups.first().locator('.qualification-body').isVisible(), true);
        assert.equal(await groups.nth(1).locator('.qualification-body').isVisible(), false);
        assert.ok((await page.locator('.detail-live-photo a').first().getAttribute('href')).startsWith('./api/live-photo-assets/'));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(output, `live-photo-expanded-${width}.png`), fullPage: true });
        console.log(`实拍图界面验证通过：${width}px，默认收起、独立展开、键盘操作、长名称无溢出`);
        await page.close();
    }
} finally { await browser.close(); }
