/** 使用真实详情渲染器核验资质作用域、读取状态、附件地址和来源 HTML；不请求真实网页。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { parseQualificationRecord } from '../lib/product-qualifications.mjs';
import { qualificationRecord, qualificationSnapshot } from './qualification-fixture.mjs';
const source = await readFile(new URL('../public/product-detail.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, URL });
vm.runInContext(source, context);
const render = captures => context.window.ProductDetailView.render({ qualificationCaptures: captures });
const capture = () => ({ ...parseQualificationRecord(qualificationRecord()).qualifications, sourceStoreId: '测试来源店' });
test('资质显示具体要求、国家、销售影响、附件与已填写内容', () => {
    const html = render([capture()]);
    for (const word of ['商品资质', '欧盟包装有害物质成分', '韩国', '100 mg/kg', '无法上架', '证书.pdf', 'TEST-CERT-2026', '已填写的商品说明']) assert.ok(html.includes(word), word);
    assert.ok(!html.includes('example.png')); assert.ok(!html.includes('history.jpg'));
    assert.ok(!html.includes('<img'));
});
test('多个原始SPU分开显示，失败重采不冒充最新读取成功', () => {
    const first = capture(); first.lastAttempt = {status:'failed',reason:'资质读取超时',capturedAt:'2026-10-08T12:00:00.000Z'};
    const second = {...capture(),spuId:'45962715609',sourceStoreId:'第二来源店'};
    const html = render([first,second]);
    assert.match(html,/SPU 45962715608/); assert.match(html,/SPU 45962715609/);
    assert.match(html,/最近读取：读取失败/); assert.match(html,/资质读取超时/);
    assert.doesNotMatch(html,/审核通过/);
});
test('空记录、失败、未知平台枚举不混淆', () => {
    assert.match(render([{...capture(),items:[]}]),/本次查询无商品资质记录/);
    assert.match(render([{...capture(),status:'failed',items:[],reason:'未授权'}]),/未取得完整资质资料/);
    const item = capture(); item.items[0].uploadStatus=99;item.items[0].auditStatus=4;
    assert.match(render([item]),/平台状态码 99/); assert.match(render([item]),/平台状态码 4/);
});
test('来源内容全部转义，危险协议和非平台附件不生成可点击入口', () => {
    const value = capture(); value.items[0].displayName='<script>window.bad=1</script>';
    value.items[0].requirements=['<img src=x onerror=alert(1)>'];
    value.items[0].content.authCode='</pre><script>alert(2)</script>';
    value.items[0].files.push({name:'危险',url:'javascript:alert(1)'},{name:'第三方',url:'https://kwcdn.com.evil.invalid/file.pdf'});
    const html=render([value]);assert.doesNotMatch(html,/<script>|onerror="|href="javascript:|href="https:\/\/kwcdn.com.evil/);
    assert.match(html,/&lt;script&gt;/);
});

test('每项资质默认收起，标题及附件缺失提示可见，正文和填写内容仍完整保留', () => {
    const value = capture();
    value.items.push({ ...structuredClone(value.items[0]), certType: 439, displayName: '美国化妆品小企业证明' });
    value.items[0].files[0].reason = '私有附件下载失败（HTTP 403），请确认来源店铺登录和文件权限';
    const html = render([value]);
    assert.equal((html.match(/<details class="detail-qualification">/g) || []).length, 2);
    assert.equal((html.match(/<summary class="qualification-summary">/g) || []).length, 2);
    assert.doesNotMatch(html, /<details[^>]*\bopen(?:\s|=|>)/);
    assert.match(html, /附件未完整/); assert.match(html, /HTTP 403/);
    assert.match(html, /100 mg\/kg/); assert.match(html, /TEST-CERT-2026/);
});
