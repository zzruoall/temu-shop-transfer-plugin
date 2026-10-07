/** 隔离浏览器验证管理页的会话失效回退；全部请求为模拟数据，不触及真实账号或店铺。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { adminLoginPage } from '../login.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const files = new Map(await Promise.all(['admin.html', 'admin.js', 'admin.css', 'favicon.svg'].map(async name =>
    [name, await readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')])));
const output = new URL('../../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    for (const [name, viewport] of [['desktop', { width: 1440, height: 900 }], ['mobile', { width: 375, height: 800 }]]) {
        for (const status of [200, 401, 403, 503]) {
            const context = await browser.newContext({ viewport }), page = await context.newPage(), errors = [], apiCalls = [];
            page.on('pageerror', error => errors.push(error.message));
            await context.route('**/*', async route => {
                const url = new URL(route.request().url()); assert.equal(url.origin, 'https://admin-preview.invalid');
                if (url.pathname === '/temu/api/me') {
                    apiCalls.push(url.pathname);
                    return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200
                        ? { user: { username: '普通用户' }, isAdmin: false } : { error: status === 503 ? '服务器暂不可用' : '请先登录' }) });
                }
                assert.ok(!url.pathname.startsWith('/temu/api/admin/'), '身份无效时不得请求管理数据');
                if (url.pathname === '/temu/admin/login') return route.fulfill({ status: 200, contentType: 'text/html', body: adminLoginPage('', '/temu') });
                const file = url.pathname === '/temu/admin' ? 'admin.html' : url.pathname.slice('/temu/'.length);
                if (files.has(file)) return route.fulfill({ status: 200, body: files.get(file), contentType: file.endsWith('.js')
                    ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html' });
                return route.fulfill({ status: 404, body: '测试未提供路径' });
            });
            await page.goto('https://admin-preview.invalid/temu/admin');
            if (status === 503) {
                await page.getByText('读取身份失败：服务器暂不可用').waitFor();
                assert.equal(new URL(page.url()).pathname, '/temu/admin', '服务器故障不应冒充会话失效或自动登录');
            } else {
                await page.waitForURL('**/temu/admin/login');
                await page.getByRole('button', { name: '登录管理控制台', exact: true }).waitFor();
                assert.equal(await page.locator('form').getAttribute('action'), '/temu/admin/session');
                assert.equal(await page.getByText('无权访问管理控制台').count(), 0);
                const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
                assert.ok(size.width <= size.viewport + 1);
                if (status === 200) await page.screenshot({ path: new URL(`admin-login-redirect-${name}.png`, output).pathname.slice(1), fullPage: true });
            }
            assert.equal(apiCalls.length, 1); assert.deepEqual(errors, []); await context.close();
        }
    }
    console.log(JSON.stringify({ adminLoginUi: true, viewports: 2, scenarios: 8, nonAdminRedirects: true, expiredRedirects: true,
        networkErrorsRetained: true, managementDataRequests: 0, productionWrites: 0 }));
} finally { await browser.close(); }
