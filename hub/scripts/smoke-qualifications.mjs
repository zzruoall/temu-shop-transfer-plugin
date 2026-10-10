/** 发布后只读核对详情资源、真实商品和测试附件展示；测试资料不写生产库，也不向店铺发送。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { parseImportedFiles } from '../lib/parse-capture.mjs';
import { inventoryListSummary } from '../lib/mysql-inventory.mjs';
import { packet } from './qualification-fixture.mjs';
const base=process.env.TEMU_SMOKE_BASE;
assert.match(base,/^https:\/\/www\.ruofei\.com\.cn\/temu$|^http:\/\/127\.0\.0\.1:\d+\/temu$/);
const credentials=JSON.parse(await readFile(process.env.TEMU_CREDENTIALS,'utf8'));
const headers={authorization:`Bearer ${credentials.deviceToken}`};
const hash=value=>createHash('sha256').update(value).digest('hex');
const get=async(relative,authenticated=true)=>fetch(base+relative,{headers:authenticated?headers:{},redirect:'manual',signal:AbortSignal.timeout(20000)});
for(const name of ['product-detail.js','styles.css']){
    const res=await get('/'+name);assert.equal(res.status,200);
    // 反向代理与应用都可能声明 no-store，合并后的重复指令仍然有效，不能要求头值逐字唯一。
    assert.ok((res.headers.get('cache-control')||'').split(',').map(value=>value.trim().toLowerCase()).includes('no-store'));
    assert.equal(hash(Buffer.from(await res.arrayBuffer())),hash(await readFile(new URL('../public/'+name,import.meta.url))));
}
const context=vm.createContext({window:{},URL});
vm.runInContext(await readFile(new URL('../public/product-detail.js',import.meta.url),'utf8'),context);
const product=parseImportedFiles([{originalName:'temu-full-capture-offline.json',payload:packet()}]).products[0];
product.qualificationCaptures=[{...product.qualifications,sourceStoreId:'offline-source'}];
const rendered=context.window.ProductDetailView.render(product);
for(const value of ['商品资质','欧盟包装有害物质成分','证书.pdf','TEST-CERT-2026','已填写内容'])assert.ok(rendered.includes(value),value);
assert.ok(!rendered.includes('example.png'));assert.equal(inventoryListSummary(product).qualificationCaptures,undefined);
const overview=await get('/api/overview?productLimit=1');assert.equal(overview.status,200);const body=await overview.json();
if(body.products?.length){const res=await get('/api/products/'+encodeURIComponent(body.products[0].spuId));assert.equal(res.status,200);assert.ok((await res.json()).product);}
for(const format of ['crx','zip']){
    const name=`temu-transfer-plugin-10.10.77.${format}`,relative='/downloads/'+name;
    const denied=await get(relative,false);assert.ok([401,403,302,303].includes(denied.status));await denied.arrayBuffer();
    const res=await get(relative);assert.equal(res.status,200);
    assert.equal(hash(Buffer.from(await res.arrayBuffer())),hash(await readFile(new URL('../public/downloads/'+name,import.meta.url))));
}
console.log(JSON.stringify({qualificationSmoke:true,pluginVersion:'10.10.77',productCount:body.productCount,staticDetails:true,fixtureFiles:4,
    listHasNoQualificationBody:true,downloadsProtected:true,realPlatformCalls:0,productionWrites:0}));
