/** 后台真实落库/推进边界采用内存事件库和当前文档夹具，验证资质不会丢在最终入库包之外。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto, createHash } from 'node:crypto';
import { qualificationSnapshot, sourceProduct, spuId } from './qualification-fixture.mjs';
import { parseImportedFiles } from '../lib/parse-capture.mjs';
const source = await readFile(new URL('../../plugin/background.js',import.meta.url),'utf8');
const helper = await readFile(new URL('../../plugin/qualification-reader.js',import.meta.url),'utf8');

/** 把原始响应存到数组中，其他函数仍从真正后台源码执行，不复制业务逻辑到测试。 */
function harness() {
    const data={},events=[],logs=[];
    const binding={tabId:7,documentId:'doc-1',captureToken:'token-1'};
    const ctx=vm.createContext({crypto:webcrypto,TextEncoder,URL,URLSearchParams,atob,btoa,console,structuredClone,setTimeout,clearTimeout,importScripts(){},
        chrome:{storage:{session:{get:async key=>({[key]:structuredClone(data[key])}),set:async value=>Object.assign(data,structuredClone(value)),remove:async key=>{delete data[key];}},
            local:{get:async()=>({}),set:async()=>{},remove:async()=>{}}},
            runtime:{getManifest:()=>({version:'local-development'})},tabs:{update:async()=>{throw Error('禁止导航');}}}});
    vm.runInContext(helper,ctx);vm.runInContext(source.split('chrome.runtime.onMessage.addListener')[0],ctx);
    Object.assign(ctx,{binding,events,logs});
    vm.runInContext(`
        isIngestPageActive=async()=>true;
        ingestPageBinding=async()=>binding;
        invalidateIngestTab=async()=>{};
        saveCapture=async(event,sender)=>{events.push(structuredClone(event));return {eventId:'event-'+events.length,productRelated:true,
            detailCapture:event.payload.result.schemaVersion?null:summarizeDetailCapture(event.payload,event.requestUrl,sender.tab.url,200)};};
        appendCaptureLog=async value=>logs.push(value);
        getIngestSettings=async()=>({autoPush:false});
    `,ctx);
    data['captureEnabledTab:7']=true;
    data['capturePageBinding:7']=structuredClone(binding);
    const sender={tab:{id:7,url:'https://agentseller.temu.com/goods/list'},documentId:'doc-1'};
    return {ctx,events,data,sender,binding};
}
test('单件同步资质的两份事件一起进入队列与最终包，不能增加创建请求',async()=>{
    const h=harness();const queue=await h.ctx.beginDetailSupplement({spuIds:[spuId],captureToken:'token-1',listUrl:h.sender.tab.url},h.sender);
    const input={runId:queue.runId,spuId,payload:{success:true,result:sourceProduct},qualifications:qualificationSnapshot()};
    const result=await h.ctx.withDetailQueue(7,()=>h.ctx.captureApiDetail(input,h.sender));
    assert.equal(h.events.length,2);assert.equal(h.events[1].payload.result.status,'complete');
    assert.equal(result.queue.qualificationComplete,1);assert.equal(result.queue.completed,1);assert.equal(result.queue.eventIds.length,2);
    assert.equal(result.queue.finalization.ingest.status,'skipped');
    await assert.rejects(()=>h.ctx.captureApiDetail(input,h.sender),/stale_detail_run/);
});
test('资质失败保存商品资料，普通失败继续下件，超时则停止并锁定结果不明',async()=>{
    const h=harness();const queue=await h.ctx.beginDetailSupplement({spuIds:[spuId,'45962715609'],captureToken:'token-1',listUrl:h.sender.tab.url},h.sender);
    const input={runId:queue.runId,spuId,payload:{success:true,result:sourceProduct},qualifications:qualificationSnapshot({status:'failed'})};
    const result=await h.ctx.captureApiDetail(input,h.sender);assert.equal(result.queue.active,true);assert.equal(result.queue.qualificationFailed,1);
    const id='45962715609';
    const stopped=await h.ctx.captureApiDetail({runId:queue.runId,spuId:id,payload:{success:true,result:{...sourceProduct,productId:id}},
        qualifications:qualificationSnapshot({id,status:'failed'}),stopBatch:true,stopReason:'资质查询超时'},h.sender);
    assert.equal(stopped.queue.active,false);assert.equal(stopped.queue.status,'partial');assert.equal(stopped.queue.completed,2);
    await assert.rejects(()=>h.ctx.clearDetailSupplement(h.sender),/刷新/);
});
test('旧文档、错SPU及旧轮次回执不能写入资质',async()=>{
    const h=harness();const queue=await h.ctx.beginDetailSupplement({spuIds:[spuId],captureToken:'token-1',listUrl:h.sender.tab.url},h.sender);
    const input={runId:queue.runId,spuId,payload:{success:true,result:sourceProduct},qualifications:qualificationSnapshot()};
    await assert.rejects(()=>h.ctx.captureApiDetail(input,{...h.sender,documentId:'old-doc'}),/stale_capture_round/);
    await assert.rejects(()=>h.ctx.captureApiDetail({...input,runId:'old-run'},h.sender),/stale_detail_run/);
    await assert.rejects(()=>h.ctx.captureApiDetail({...input,qualifications:qualificationSnapshot({id:'45962715609'})},h.sender),/归属/);
    assert.equal(h.events.length,0);
});

test('已返回的业务错误即使文案含超时也不永久锁；真实在途不明保持锁定',async()=>{
    for(const uncertain of [false,true]){
        const h=harness();const queue=await h.ctx.beginDetailSupplement({spuIds:[spuId],captureToken:'token-1',listUrl:h.sender.tab.url},h.sender);
        await h.ctx.captureApiDetail({runId:queue.runId,spuId,payload:{success:true,result:sourceProduct},
            qualifications:qualificationSnapshot({status:'failed'}),stopBatch:true,stopReason:'接口已返回429，错误文案含超时',queryUncertain:uncertain},h.sender);
        const saved=h.data['detailSupplementTab:7'];assert.equal(saved.platformUncertain,uncertain);
        if(uncertain)await assert.rejects(()=>h.ctx.clearDetailSupplement(h.sender),/刷新/);
        else await h.ctx.clearDetailSupplement(h.sender);
    }
});

test('真实不明结果先于资料落库保存，保存失败及后续错误标记不能解除锁',async()=>{
    const h=harness();const queue=await h.ctx.beginDetailSupplement({spuIds:[spuId],captureToken:'token-1',listUrl:h.sender.tab.url},h.sender);
    h.ctx.saveCapture=async()=>{throw Error('QuotaExceededError');};
    await assert.rejects(()=>h.ctx.captureApiDetail({runId:queue.runId,spuId,payload:{success:true,result:sourceProduct},
        qualifications:qualificationSnapshot({status:'failed'}),stopBatch:true,queryUncertain:true},h.sender),/QuotaExceeded/);
    assert.equal(h.data['detailSupplementTab:7'].platformUncertain,true);
    await h.ctx.advanceDetailSupplement({runId:queue.runId,spuId,status:'failed',reason:'QuotaExceededError',queryUncertain:false},h.sender);
    await assert.rejects(()=>h.ctx.clearDetailSupplement(h.sender),/刷新/);
});

test('真实落库分类和下载导出共同保留资质，不能让模板商品ID污染当前包',async()=>{
    const h=harness();
    const records=[],downloads=[];
    Object.assign(h.ctx,{records,downloads});
    for (const name of ['packet.js','transfer-integrity.js']) vm.runInContext(await readFile(new URL(`../../plugin/${name}`,import.meta.url),'utf8'),h.ctx);
    // 仅替换 IndexedDB 传输层；分类、归属、完整性摘要和导出仍执行真正的后台实现。
    vm.runInContext(`
        saveCapture = ${source.slice(source.indexOf('async function saveCapture('),source.indexOf('\nfunction getAllRecords()'))};
        runTransaction=async(_,fn)=>new Promise((resolve,reject)=>{
            const request=result=>{const req={result};setTimeout(()=>req.onsuccess(),0);return req;};
            fn({get:()=>request(null),add:value=>{records.push(value);return request();}},resolve,{abort:()=>reject(Error('事务被拒绝'))});
        });
        getAllRecords=async()=>records;
        packetSourceOptions=async value=>({...value,sourceStoreId:'fixture-store'});
        chrome.downloads={download:async value=>{downloads.push(value);return 1;}};
    `,h.ctx);
    const snapshot=qualificationSnapshot();
    // 真正走后台保存和导出边界：10MiB 文件的 base64 超过旧 8MiB 上限，不能只测解析器。
    const bytes=Buffer.alloc(10*1024*1024);bytes.write('%PDF-1.7');
    snapshot.assets=[{url:'https://bstatic.kwcdn.com/cert.pdf',name:'证书.pdf',mimeType:'application/pdf',bytes:bytes.length,
        sha256:createHash('sha256').update(bytes).digest('hex'),dataBase64:bytes.toString('base64')}];
    snapshot.archive={status:'partial',errors:[{url:'https://img.kwcdn.com/report.jpg',name:'检测报告.jpg',reason:'离线夹具未归档其他材料'}]};
    snapshot.items[0].detail.certNeedUpload.otherProduct={productId:'99999999999',productSkuId:'88888888888',removeStatus:1};
    const result=await h.ctx.saveCapture({kind:'network-json',requestUrl:'https://agentseller.temu.com/mms/arbok/product_cert/query/list',
        responseStatus:200,payload:{success:true,result:snapshot}},h.sender);
    assert.deepEqual(Array.from(result.productIds),[spuId]);assert.equal(result.detailRequestSeen,false);
    assert.equal(result.removedProductIds.length,0);assert.equal(result.activeProductIds.length,0);
    assert.equal(records[0].source.pageProductId,spuId);assert.equal(records[0].dataType,'product-qualifications');
    assert.equal(records[0].identity.skuIds.length,0);
    const exported=await h.ctx.exportFullPacketToDownload({eventIds:[result.eventId],allowedSpuIds:[spuId]});
    assert.equal(exported.exported,true);
    const packet=JSON.parse(decodeURIComponent(downloads[0].url.split(',').slice(1).join(',')));
    assert.equal(packet.records.length,1);assert.equal(packet.products.length,1);
    const parsed=parseImportedFiles([{originalName:'temu-full-capture-test.json',payload:packet}]);
    assert.equal(parsed.products[0].qualifications.items[0].files.length,4);
    assert.equal(parsed.products[0].qualifications.items[0].files[0].asset.bytes,bytes.length);
    assert.equal(packet.records[0].payload.result.assets[0].dataBase64,snapshot.assets[0].dataBase64);
    assert.equal(parsed.products[0].publicationData,undefined);
    await assert.rejects(()=>h.ctx.exportFullPacketToDownload({eventIds:['missing']}),/缺失/);
});
