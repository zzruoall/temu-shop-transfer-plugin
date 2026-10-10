/** 发布后仅做认证读取及内存渲染；不登记店铺、入库材料或投递任务，避免验收影响用户的真实商品。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { parseImportedFiles } from '../lib/parse-capture.mjs';
import { livePhotoPacket } from './live-photo-fixture.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const get = (route, auth = true) => fetch(base + route, { headers: auth ? headers : {}, redirect: 'manual', signal: AbortSignal.timeout(20000) });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const name of ['product-detail.js', 'styles.css', 'downloads/temu-transfer-plugin-11.0.9.crx', 'downloads/temu-transfer-plugin-11.0.9.zip']) {
    const response = await get('/' + name);
    assert.equal(response.status, 200, name);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/' + name, import.meta.url))));
}
const denied = await get('/api/live-photo-assets/999999999999/0000000000000000000000000000000000000000000000000000000000000000?sourceStoreId=temu%3A999999999999', false);
assert.equal(denied.status, 401); await denied.body?.cancel();
const missing = await get('/api/live-photo-assets/999999999999/0000000000000000000000000000000000000000000000000000000000000000?sourceStoreId=temu%3A999999999999');
assert.equal(missing.status, 404); await missing.body?.cancel();
const overview = await get('/api/overview?productLimit=1');
assert.equal(overview.status, 200); assert.doesNotMatch(JSON.stringify(await overview.json()), /dataBase64/);
const context = vm.createContext({ window: {}, URL, URLSearchParams });
vm.runInContext(await readFile(new URL('../public/product-detail.js', import.meta.url), 'utf8'), context);
const product = parseImportedFiles([{ originalName: 'memory-only.json', payload: livePhotoPacket() }]).products[0];
product.livePhotoCaptures = [{ ...product.livePhotos, sourceStoreId: 'temu:634418214794015' }];
const html = context.window.ProductDetailView.render(product);
assert.match(html, /商品实拍图/); assert.match(html, /商品主体实拍图/); assert.match(html, /商品外包装实拍图/);
assert.match(html, /\.\/api\/live-photo-assets\//); assert.doesNotMatch(html, /<details[^>]*\bopen(?:\s|=|>)/);
assert.doesNotMatch(html, /dataBase64/);
console.log(JSON.stringify({ livePhotoRelease: true, protectedRoute: true, missingAsset404: true, matchedResources: true,
    defaultCollapsed: true, overviewHasNoPhotoBytes: true, pluginVersion: '11.0.9', productionWrites: 0, realPlatformCalls: 0 }));
