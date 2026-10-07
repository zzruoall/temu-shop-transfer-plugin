/** 发布后只读核对实际商品和详情资源；不登记插件，不投递商品，不调用创建或删除接口。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/temu$/);
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS, 'utf8'));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const hash = value => createHash('sha256').update(value).digest('hex');
const get = async endpoint => {
    const response = await fetch(base + endpoint, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, endpoint);
    return response;
};
for (const file of ['index.html', 'app.js', 'styles.css', 'product-detail.js']) {
    const response = await get(file === 'index.html' ? '/' : '/' + file);
    if (file.endsWith('.js')) assert.match(response.headers.get('content-type'), /javascript/);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/' + file, import.meta.url))), `资源不一致:${file}`);
}
const context = vm.createContext({ window: {}, URL });
vm.runInContext(await readFile(new URL('../public/product-detail.js', import.meta.url), 'utf8'), context);
const overview = await (await get('/api/overview?productLimit=1')).json();
let modules = [];
if (overview.products?.length) {
    const payload = await (await get('/api/products/' + encodeURIComponent(overview.products[0].spuId))).json();
    const html = context.window.ProductDetailView.render(payload.product);
    modules = [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1]);
    assert.ok(modules.includes('基本信息'));
    assert.doesNotMatch(html, /完整度检查|当前完整包没有解析到 SKU|原始响应已保留/);
}
console.log(JSON.stringify({ detailLayoutSmoke: true, modules, productCount: overview.productCount, pluginVersion: JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url))).version, realPlatformCalls: 0 }));
