/** 发布后只读核对网页、插件与权限边界，不写正式商品、不触发店铺任务。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { parseQualificationRecord } from '../lib/product-qualifications.mjs';
import { qualificationRecord } from './qualification-fixture.mjs';
import { pluginVersionAtLeast } from '../lib/plugin-version.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const version = JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url))).version;
// 安装包可独立升级，验收兼容能力门槛而不是把历史发布版本锁死为唯一版本。
assert.match(version, /^11\.\d+\.\d+$/); assert.ok(pluginVersionAtLeast(version, [11, 0, 3]));
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const suffix of ['crx', 'zip']) {
    const name = `temu-transfer-plugin-${version}.${suffix}`;
    const denied = await fetch(`${base}/downloads/${name}`, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert.equal(denied.status, 401); await denied.body?.cancel();
    const response = await fetch(`${base}/downloads/${name}`, { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/downloads/' + name, import.meta.url))));
}
for (const name of ['product-detail.js', 'styles.css']) {
    const response = await fetch(`${base}/${name}`, { headers, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    assert.ok((response.headers.get('cache-control') || '').split(',').some(value => value.trim().toLowerCase() === 'no-store'));
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/' + name, import.meta.url))));
}
const context = vm.createContext({ window: {}, URL });
vm.runInContext(await readFile(new URL('../public/product-detail.js', import.meta.url), 'utf8'), context);
const capture = { ...parseQualificationRecord(qualificationRecord()).qualifications, sourceStoreId: 'offline-source' };
const html = context.window.ProductDetailView.render({ qualificationCaptures: [capture] });
assert.match(html, /<details class="detail-qualification">/);
assert.match(html, /<summary class="qualification-summary">/);
assert.doesNotMatch(html, /<details[^>]*\bopen(?:\s|=|>)/);
assert.match(html, /证书.pdf/); assert.match(html, /100 mg\/kg/);
const response = await fetch(base + '/api/overview?productLimit=1', { headers, signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200); assert.doesNotMatch(JSON.stringify(await response.json()), /dataBase64/);
console.log(JSON.stringify({ qualificationDownloadRelease: true, version, packageHashesMatched: true,
    detailAndStylesMatched: true, defaultCollapsed: true, noBodyInOverview: true, productionWrites: 0, realPlatformCalls: 0 }));
