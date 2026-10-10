/** 用真实内容脚本模板和弹窗函数做离线 Chromium 验收，禁止访问平台与正式服务。 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'E:/project/chajian/node_modules/playwright');
const source = await readFile(new URL('../../plugin/content-app.js', import.meta.url), 'utf8');
const template = source.slice(source.indexOf('root.innerHTML = `') + 'root.innerHTML = `'.length,
    source.indexOf('`;', source.indexOf('root.innerHTML = `')));
assert.ok(template.includes('transfer-errors'));
/** 从真实函数边界提取实现，不能由测试另写一个相似弹窗代替。 */
function implementation(name) {
    const start = source.indexOf(`    function ${name}(`);
    assert.ok(start >= 0, name);
    const text = source.slice(start), end = /^    }\r?$/m.exec(text);
    assert.ok(end);
    return text.slice(0, end.index + end[0].length);
}
const functions = ['currentStoreTransferTasks', 'directErrorEntries', 'directErrorsText', 'closeForeignErrorDialog', 'openDirectErrors'].map(implementation).join('\n');
const output = new URL('../../output/playwright/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    const context = await browser.newContext({ acceptDownloads: true });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['narrow', { width: 375, height: 640 }]]) {
        await page.setViewportSize(viewport);
        await page.setContent('<!doctype html><html lang="zh"><meta charset="utf-8"><body><div id="fixture"></div></body></html>');
        await page.evaluate(({ template, functions }) => {
            const root = document.getElementById('fixture').attachShadow({ mode: 'open' });
            root.innerHTML = template;
            // 两级货号都故意含长文本和 HTML 字符，验证完整保留、换行与纯文本渲染。
            const tasks = [{ jobId: 'batch', spuId: '10001', targetStoreId: 'temu:fixture', directCreate: true,
                directState: 'rejected', productCodes: ['P-' + 'A'.repeat(150)], skuCodes: ['S-1', 'S-2'],
                reason: '<img src=x onerror="window.fixtureXss=true">净含量必填（错误码 2000135）' },
            { jobId: 'batch', spuId: '10002', targetStoreId: 'temu:fixture', directCreate: true, directState: 'unknown', reason: '结果未知，禁止自动重发' },
            { jobId: 'batch', spuId: '10003', targetStoreId: 'temu:fixture', directCreate: true, directState: 'duplicate_wait', reason: '查重超时，未提交' },
            { jobId: 'batch', spuId: '10004', targetStoreId: 'temu:fixture', directCreate: true, directState: 'qualification_failed', productId: '9876543210',
                reason: '商品已创建，资质未完成', qualificationItems: [{ certType: 1421, name: '检测报告', state: 'failed', reason: '目标要求英文报告' }] },
            { jobId: 'batch', spuId: '10005', targetStoreId: 'temu:fixture', directCreate: true, directState: 'qualification_unknown', reason: '资质提交结果待核对' },
            { jobId: 'other', spuId: '99999', targetStoreId: 'temu:other', directCreate: true, directState: 'rejected', reason: '其他店私有错误' }];
            window.fixtureXss = false;
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.fixtureCopied = value; } } });
            new Function('root', 'tasks', `const state = { transferTasks: tasks }; const currentPageIdentity = () => ({ storeId: 'temu:fixture' });
                ${functions}
                const button = root.querySelector('.transfer-errors'); button.hidden = false; button.textContent = '查看异常（5 件）';
                root.querySelector('.transfer-progress').hidden = false;
                button.addEventListener('click', openDirectErrors);
                window.fixtureCloseForeign = closeForeignErrorDialog;`)(root, tasks);
        }, { template, functions });
        await page.getByRole('button', { name: '查看异常（5 件）' }).click();
        const dialog = page.getByRole('dialog', { name: '本店异常商品' });
        await dialog.waitFor({ state: 'visible' });
        assert.equal(await dialog.locator('.error-item').count(), 5);
        const text = await dialog.innerText();
        assert.match(text, /S-1、S-2/);
        assert.match(text, /结果待核对/);
        assert.match(text, /查重等待/);
        assert.match(text, /检测报告.*目标要求英文报告/s);
        assert.doesNotMatch(text, /99999|其他店私有错误/);
        assert.equal(await dialog.locator('img').count(), 0, '平台原文不能成为可执行 HTML');
        const bounds = await dialog.evaluate(node => ({ left: node.getBoundingClientRect().left,
            right: node.getBoundingClientRect().right, width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth }));
        assert.ok(bounds.left >= 8 && bounds.right <= bounds.width - 8, JSON.stringify(bounds));
        assert.ok(bounds.scroll <= bounds.client + 1, '长货号不得横向溢出');
        await dialog.getByRole('button', { name: '复制清单' }).click();
        assert.match(await page.evaluate(() => window.fixtureCopied), /商品货号：P-A/);
        const downloading = page.waitForEvent('download');
        await dialog.getByRole('button', { name: '导出清单' }).click();
        const download = await downloading;
        assert.match(download.suggestedFilename(), /^temu-errors-\d+\.txt$/);
        assert.equal(await download.failure(), null);
        await page.screenshot({ path: new URL(`plugin-errors-10.10.71-${name}.png`, output).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
        await page.keyboard.press('Escape');
        assert.equal(await dialog.count(), 0);
        assert.equal(await page.getByRole('button', { name: '查看异常（5 件）' }).evaluate(node => node.getRootNode().activeElement === node), true);
        assert.equal(await page.evaluate(() => window.fixtureXss), false);
        await page.getByRole('button', { name: '查看异常（5 件）' }).click();
        await page.evaluate(() => window.fixtureCloseForeign('temu:other', [{ targetStoreId: 'temu:other', directCreate: true, directState: 'rejected' }]));
        assert.equal(await dialog.count(), 0, '切到非空的新店队列也不得保留旧店弹窗');
    }
    console.log(JSON.stringify({ passed: true, viewports: 2, errors: 5, pureText: true, copy: true, export: true, escapeFocus: true, realNetworkRequests: 0 }));
} finally { await browser.close(); }
