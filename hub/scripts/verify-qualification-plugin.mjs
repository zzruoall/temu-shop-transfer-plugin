/** 加载真实开发插件，使用离线页面和模拟客户端贯通勾选、同步采集、IndexedDB 落库和资料包解析。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { sourceProduct, qualificationSnapshot, spuId } from './qualification-fixture.mjs';
import { parseImportedFiles } from '../lib/parse-capture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'E:/project/chajian/node_modules/playwright');
const pluginDir=fileURLToPath(new URL('../../plugin/',import.meta.url));
// 慢双件模式复现用户日志：单次资质请求未超时，但两次累计超过旧详情计时器期限。
const slowMulti=process.argv.includes('--slow-multi');
const fixtures=[structuredClone(sourceProduct)];
if(slowMulti){
    const second=structuredClone(sourceProduct);second.productId=String(BigInt(spuId)+1n);
    second.productSkcList[0].productSkcId='112965156093147';second.productSkcList[0].extCode='TEST-ARTICLE-SECOND';
    second.productSkcList[0].productSkuList[0].productSkuId='464860473011';second.productSkcList[0].productSkuList[0].extCode='SKU-TEST-SECOND';
    fixtures.push(second);
}
const profile=await mkdtemp(path.join(os.tmpdir(),'temu-qualification-plugin-'));
assert.equal(path.dirname(path.resolve(profile)),path.resolve(os.tmpdir()));assert.ok(path.basename(profile).startsWith('temu-qualification-plugin-'));
let context;
try{
    context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,proxy:{server:'http://127.0.0.1:9'},
        args:[`--disable-extensions-except=${pluginDir}`,`--load-extension=${pluginDir}`,'--no-first-run','--no-default-browser-check']});
    await context.route('**/*',route=>route.request().url()==='https://agentseller.temu.com/goods/list'
        ?route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html lang="zh"><meta charset="utf-8"><title>离线商品列表</title><body><table><tbody>${fixtures.map(product=>`<tr><td><input type="checkbox"></td><td>SPU ID：${product.productId} SKC ID：${product.productSkcList[0].productSkcId}</td></tr>`).join('')}</tbody></table></body></html>`})
        :route.abort());
    const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
    await worker.evaluate(()=>chrome.storage.local.set({ingestSettingsV1:{settingsVersion:3,autoPush:false}}));
    const page=context.pages()[0]||await context.newPage();
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto('https://agentseller.temu.com/goods/list');
    await page.waitForSelector('[data-plugin-version]');
    await page.evaluate(({products,snapshot,slow})=>{
        function factory(){return '.postWithoutMallId= .mallIdClient= getMallIdAsync';}
        window.__qualificationFixtureCalls=[];
        const runtime=()=>({mallIdClient:{getMallIdAsync:async()=>'fixture-mall'},post:async(url,input)=>{
            window.__qualificationFixtureCalls.push({url,input});
            if(url==='/visage-agent-seller/product/skc/pageQuery')return {pageItems:products.map(product=>({productId:product.productId,productSkcId:product.productSkcList[0].productSkcId,removeStatus:0}))};
            if(url==='/visage-agent-seller/product/query')return products.find(product=>product.productId===input.productId);
            if(slow&&window.__qualificationFixtureCalls.filter(call=>call.url==='/visage-agent-seller/product/query').length===1
                &&url.startsWith('/mms/arbok/product_cert/query/'))await new Promise(resolve=>setTimeout(resolve,9000));
            if(url==='/mms/arbok/product_cert/query/list')return {if_semi_managed:false,total:1,product_with_cert_list:[{product_base_info:{product_id:input.product_ids[0]},product_cert_info_list:[snapshot.items[0].summary]}]};
            if(url==='/mms/arbok/product_cert/query/detail')return {product_cert_info:snapshot.items[0].detail};
            throw Error('出现非只读接口：'+url);
        }});
        runtime.m={12345:factory};const chunks=[];chunks.push=entry=>entry[2](runtime);window.chunkLoadingGlobal_temu_sca_goods=chunks;
    },{products:fixtures,snapshot:qualificationSnapshot(),slow:slowMulti});
    for(const checkbox of await page.locator('tbody input').all())await checkbox.check();
    await page.waitForFunction(count=>document.querySelector('[data-plugin-version]')?.getAttribute('data-selected-count')===String(count),fixtures.length);
    // 面板使用关闭的 Shadow DOM；CDP 只负责点击真正按钮，不调用后台方法代替用户启动流程。
    const cdp=await context.newCDPSession(page),{root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true}),nodes=[];
    const walk=node=>{
        const attrs=node.attributes||[],index=attrs.indexOf('class'),className=index<0?'':attrs[index+1];
        if(node.nodeName==='BUTTON'&&className.split(/\s+/).includes('start-selected'))nodes.push(node.nodeId);
        (node.children||[]).forEach(walk);(node.shadowRoots||[]).forEach(walk);
    };walk(root);assert.equal(nodes.length,1);
    const {object}=await cdp.send('DOM.resolveNode',{nodeId:nodes[0]});
    await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:'function(){this.click();}',returnByValue:true});
    await page.waitForFunction(count=>document.querySelector('[data-plugin-version]')?.getAttribute('data-completed-count')===String(count),fixtures.length,{timeout:45000});
    const {queue,packet}=await worker.evaluate(async()=>{
        const values=await chrome.storage.session.get(null),queue=Object.entries(values).find(([key])=>key.startsWith('detailSupplementTab:'))?.[1];
        const records=await getAllRecords();
        return {queue,packet:makeFullCapturePacket(records,{sourceStoreId:'offline-source-store',allowedSpuIds:queue.items.map(item=>item.spuId)})};
    });
    assert.equal(queue.active,false);assert.ok(queue.items.every(item=>item.qualificationStatus==='complete'));assert.equal(queue.finalization.ingest.status,'skipped');
    assert.equal(packet.records.filter(record=>record.dataType==='product-qualifications').length,fixtures.length);
    assert.equal(packet.records.filter(record=>record.dataType==='product-detail').length,fixtures.length);
    const products=parseImportedFiles([{originalName:'temu-full-capture-plugin-test.json',payload:packet}]).products;
    assert.equal(products.length,fixtures.length);assert.equal(products[0].qualifications.items[0].files.length,4);
    assert.equal(products[0].qualifications.items[0].content.authCode,'TEST-CERT-2026');
    assert.equal(products[0].images.some(url=>/report|cert|example|history/.test(url)),false);
    const calls=await page.evaluate(()=>window.__qualificationFixtureCalls);
    assert.equal(calls.length,1+fixtures.length*3);assert.ok(calls.every(call=>/query|pageQuery/.test(call.url)));
    assert.deepEqual(errors,[]);
    console.log(`真实插件资质闭环通过：${fixtures.length}件商品，${calls.length}次模拟只读查询，慢资质模式=${slowMulti}；选择采集、落库、资料包和解析均通过，真实平台/服务器调用0`);
}finally{
    if(context)await context.close();
    await rm(profile,{recursive:true,force:true});
}
