/** 发布验收只读取接口和安装包，使用无效令牌验证拒绝；不登记店铺、不写产品或资质。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pluginVersionAtLeast } from '../lib/plugin-version.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const version = JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url))).version;
assert.equal(version, '11.0.2'); assert.ok(pluginVersionAtLeast(version, [10, 10, 69]));
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const suffix of ['crx', 'zip']) {
    const name = `temu-transfer-plugin-${version}.${suffix}`;
    assert.equal((await fetch(`${base}/downloads/${name}`, { redirect: 'manual', signal: AbortSignal.timeout(20000) })).status, 401);
    const response = await fetch(`${base}/downloads/${name}`, { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/downloads/' + name, import.meta.url))));
}
const asset = await fetch(`${base}/api/qualification-assets/9999999999/${'a'.repeat(64)}?sourceStoreId=temu:999999`,
    { headers: { authorization: 'Bearer pt_invalid', 'x-plugin-instance': 'invalid' }, redirect: 'manual', signal: AbortSignal.timeout(10000) });
assert.ok([401, 403].includes(asset.status));
const overview = await fetch(base + '/api/overview?productLimit=1', { headers, signal: AbortSignal.timeout(20000) });
assert.equal(overview.status, 200); assert.doesNotMatch(JSON.stringify(await overview.json()), /dataBase64/);
const detail = await fetch(base + '/product-detail.js', { headers, signal: AbortSignal.timeout(10000) });
assert.equal(detail.status, 200);
assert.equal(hash(Buffer.from(await detail.arrayBuffer())), hash(await readFile(new URL('../public/product-detail.js', import.meta.url))));
console.log(JSON.stringify({ qualificationTransferRelease: true, version, packageHashesMatched: true, assetInvalidTokenRejected: true,
    noAttachmentBodyInOverview: true, detailSourceMatched: true, authenticatedAssetTransfer: 'isolated_HTTP_regression', productionWrites: 0, realPlatformCalls: 0 }));
