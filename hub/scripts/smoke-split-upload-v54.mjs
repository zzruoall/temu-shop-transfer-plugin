/** 正式发布后只读校验协议和静态资源；不投递任务、不登记店铺、不提交商品或资质。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pluginVersionAtLeast } from '../lib/plugin-version.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const get = async endpoint => {
    const response = await fetch(base + endpoint, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, endpoint); return response;
};
const protocol = await (await get('/api/direct-create-capability')).json();
assert.equal(protocol.minimumPluginVersion, '11.0.4');
assert.deepEqual(protocol.actionTypes, ['product_create', 'qualification_upload']);
const version = JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url))).version;
// 任务拆分协议继续兼容后续11系列插件；安装包升级不改变服务端的最低收件版本。
assert.match(version, /^11\.\d+\.\d+$/); assert.ok(pluginVersionAtLeast(version, [11, 0, 4]));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of ['app.js', 'styles.css', `downloads/temu-transfer-plugin-${version}.crx`, `downloads/temu-transfer-plugin-${version}.zip`]) {
    const response = await get('/' + file);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/' + file, import.meta.url))));
}
const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
assert.match(app, /qualification_upload/); assert.match(app, /product_create/);
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
// 商品任务同时排除证书和独立实拍图，允许空白格式变化；不能因旧单行写法失效而误判业务退化。
assert.match(server, /if \(actionType === 'product_create'\)\s*\{\s*delete snapshot\.qualifications;\s*delete snapshot\.livePhotos;\s*\}/);
console.log(JSON.stringify({ splitUploadSmoke: true, version, actionTypes: protocol.actionTypes, sourceAssetsMatched: true,
    productionWrites: 0, realPlatformCalls: 0 }));
