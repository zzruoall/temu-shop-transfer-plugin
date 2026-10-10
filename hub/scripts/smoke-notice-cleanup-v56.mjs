/** 只读核验弹窗说明已删除，保留两条命令及旧插件门槛；不登记店铺或提交商品。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const file of ['app.js', 'styles.css']) {
    const response = await fetch(`${base}/${file}`, { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/' + file, import.meta.url))));
}
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const dialog = source.slice(source.indexOf('<dialog id="single-target-dialog"'), source.indexOf('<section class="catalog-workspace"'));
assert.doesNotMatch(dialog, /upload-task-notice|upload-product-compliance|商品合规声明|已发内容不撤回/);
assert.match(dialog, /value="product_create"[^>]*>上架商品<\/button>/);
assert.match(dialog, /value="qualification_upload"[^>]*>补全资质<\/button>/);
// 静态资源核验附带纯函数边界检查，不把它当作真实店铺已经能够执行的证明。
const match = source.match(/function canReceiveSplitUpload\(agent\)\s*\{([\s\S]*?)\n\}/);
assert.ok(match);
const receives = new Function('agent', match[1]);
const ready = { online: true, pluginDetected: true, identityMatched: true, canReceiveUploads: true, storeId: 'synthetic' };
assert.equal(receives({ ...ready, pluginVersion: '11.0.3' }), false);
assert.equal(receives({ ...ready, pluginVersion: '11.0.4' }), true);
assert.equal(receives({ ...ready, pluginVersion: '11.0.4', online: false }), false);
assert.match(source, /\.filter\(canReceiveSplitUpload\)/);
const server = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
assert.match(server, /pluginVersionAtLeast\(target\.pluginVersion, \[11, 0, 4\]\)/);
console.log(JSON.stringify({ noticesRemoved: true, bothCommandsPreserved: true, versionAndOnlineBoundariesChecked: true, productionWrites: 0 }));
