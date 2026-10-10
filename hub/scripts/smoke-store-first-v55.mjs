/** 线上只读验证弹窗结构、脚本摘要和动作协议；不提交商品或资质，不读取其他账户店铺。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of ['app.js', 'styles.css']) {
    const response = await fetch(`${base}/${file}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/' + file, import.meta.url))));
}
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const dialog = source.slice(source.indexOf('<dialog id="single-target-dialog"'), source.indexOf('<section class="catalog-workspace"'));
assert.match(dialog, /本账户绑定的在线店铺/);
assert.doesNotMatch(dialog, /upload-action-types|name="upload-action-type"|value="apply"/);
assert.match(dialog, /value="product_create"[^>]*>上架商品<\/button>/);
assert.match(dialog, /value="qualification_upload"[^>]*>补全资质<\/button>/);
assert.doesNotMatch(dialog, /id="upload-target-fields"[^>]*\b(?:hidden|disabled)\b/);
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
assert.match(server, /async function targetStoreScope\(req\)/);
assert.match(server, /ownership\.ownedStoreIds\(req\.temuUser\?\.id\)/);
console.log(JSON.stringify({ storeFirstDialog: true, ownBoundStores: true, directCommands: ['product_create', 'qualification_upload'],
    sourceAssetsMatched: true, pluginVersion: JSON.parse(await readFile(new URL('../../plugin/manifest.json', import.meta.url))).version,
    productionWrites: 0, realPlatformCalls: 0 }));
