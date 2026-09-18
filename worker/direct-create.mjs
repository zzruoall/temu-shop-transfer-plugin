/** 单商品接口创建器：先生成请求，服务端原子占位，再提交一次并回查；无自动重试。 */
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execute} from './cli-transport.mjs';

export async function createDirectProduct({job,item,identity,hubPost,executePage=execute}) {
    const storeId=job.targetStoreId;
    const initial=await executePage(storeId,null,`JSON.stringify({url:location.origin+location.pathname,name:document.getElementById('temu-local-dataset-panel')?.dataset.pageStoreName,instance:document.getElementById('temu-local-dataset-panel')?.dataset.pluginInstanceId})`);
    const context=JSON.parse(initial.result||'null');
    if(!initial.targetId || context?.url!=='https://agentseller.temu.com/goods/list' || context.name!==identity.pageStoreName || context.instance!==identity.pluginInstanceId) throw Error('请保持目标店商品列表页打开，并等待插件身份识别完成');
    const tab=initial.targetId;
    const slot='__temuDirect'+randomUUID().replaceAll('-','');
    const exec=async script=>{const r=await executePage(storeId,tab,script);if(r.exceptionDetails)throw Error('目标页面执行失败');return r.result;};
    const report=extra=>hubPost('/api/jobs/direct-progress',{...identity,jobId:job.id,spuId:item.spuId,claimToken:item.claimToken,...extra});
    let attemptId='';
    // 每次使用独立容器；旧页面任务或超时回调不能成为本次准备结果。
    const s=`window[${JSON.stringify(slot)}]`;
    try {
        const source=item.snapshot?.publicationData?.sourceProduct;
        if(!source||String(source.productId)!==String(item.spuId))throw Error('来源完整商品资料或SPU不匹配');
        const encoded=Buffer.from(JSON.stringify(source)).toString('base64');
        if(encoded.length>180000)throw Error('商品资料超过本版接口创建传输上限');
        await exec(`${s}={encoded:'',state:'loading'};setTimeout(()=>delete ${s},300000);'ready'`);
        for(let offset=0;offset<encoded.length;offset+=6000)await exec(`${s}.encoded+=${JSON.stringify(encoded.slice(offset,offset+6000))};'chunk'`);
        const prepare=await readFile(new URL('./direct-create-prepare.js',import.meta.url),'utf8');
        const integrity=await readFile(new URL('./direct-integrity.js',import.meta.url),'utf8');
        await exec(`(async()=>{const box=${s};try{const source=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(box.encoded),c=>c.charCodeAt(0))));delete box.encoded;const p=await ${prepare}(source);if(p.blockers.length)throw Error(p.blockers.join('；'));const r=p.request;box.check=${integrity};box.check(source,r);const oldSkus=(source.productSkcList||[]).flatMap(k=>k.productSkuList||[]);const skus=r.productSkcReqs.flatMap(k=>k.productSkuReqs||[]);if(!skus.length||skus.length!==oldSkus.length||r.productSkcReqs.length!==source.productSkcList.length||r.productSkcReqs.some(k=>k.productSkcId)||skus.some(k=>k.productSkuId))throw Error('SKU数量或新增ID校验失败');if((r.carouselImageUrls||[]).length!==(source.carouselImageUrls||[]).length)throw Error('主图数量变化，停止创建');const protocol=r.productComplianceStatementReq;if(protocol?.protocolVersion!=='V2.0'||protocol.protocolUrl!=='https://dl.kwcdn.com/seller-public-file-us-tag/2079f603b6/56888d17d8166a6700c9f3e82972e813.html')throw Error('平台合规声明已变化，请重新确认');let runtime;self.chunkLoadingGlobal_temu_sca_goods.push([[${JSON.stringify(slot)}], {},v=>runtime=v]);const ids=Object.entries(runtime.m).filter(([,f])=>{const t=String(f).replace(/\\s+/g,'');return t.includes('getMallIdAsync')&&t.includes('.postWithoutMallId=')&&t.includes('.mallIdClient=')});if(ids.length!==1)throw Error('平台请求客户端已变化');box.client=runtime(ids[0][0]);box.mall=String(await box.client.mallIdClient.getMallIdAsync());box.request=r;box.hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(r)))),b=>b.toString(16).padStart(2,'0')).join('');box.state='ready';box.summary={state:'ready',hash:box.hash,mall:box.mall,skuCount:skus.length,imageCount:r.carouselImageUrls?.length};}catch(e){box.state='preflight_failed';box.summary={state:box.state,error:String(e.message).slice(0,800)}}})();'preparing'`);
        let pre;
        for(let i=0;i<60;i++){pre=JSON.parse(await exec(`JSON.stringify(${s}?.summary||null)`));if(pre)break;await new Promise(r=>setTimeout(r,500));}
        if(pre?.state!=='ready')throw Error(pre?.error||'请求准备超时，未提交');
        const started=await report({phase:'begin',requestHash:pre.hash,mallId:pre.mall,reason:`正在通过新增接口创建：${pre.skuCount}个SKU、${pre.imageCount}张主图；不打开表单`});
        attemptId=started.attemptId;
        // 服务端占位已持久化才允许发布；CLI 超时不能再次调用此代码。
        await exec(`(async()=>{const box=${s};try{const panel=document.getElementById('temu-local-dataset-panel');if(location.origin+location.pathname!=='https://agentseller.temu.com/goods/list'||panel?.dataset.pageStoreName!==${JSON.stringify(identity.pageStoreName)}||panel?.dataset.pluginInstanceId!==${JSON.stringify(identity.pluginInstanceId)}||String(await box.client.mallIdClient.getMallIdAsync())!==box.mall)throw Error('提交前目标店身份变化');const lock=${JSON.stringify('temu-direct-'+job.id+'-'+item.spuId)};if(sessionStorage.getItem(lock))throw Error('本任务已经提交过');sessionStorage.setItem(lock,${JSON.stringify(attemptId)});const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(box.request)))),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==${JSON.stringify(pre.hash)})throw Error('请求指纹变化');box.state='submitting';const result=await box.client.post('/visage-agent-seller/product/add',box.request);const id=String(result?.productId||'');if(!/^\\d{6,20}$/.test(id))throw Error('新增响应没有商品ID');box.productId=id;box.state='verifying';const saved=await box.client.post('/visage-agent-seller/product/query',{productId:id});if(!saved||saved.productName!==box.request.productName||saved.productSkcList?.length!==box.request.productSkcReqs.length)throw Error('新增后回查未匹配');box.check(saved,box.request);box.summary={state:'created',productId:id,verified:true};}catch(e){box.summary={state:'unknown',productId:box.productId||'',error:String(e.message).slice(0,800)}}})();'submitted_once'`);
        let result;
        for(let i=0;i<60;i++){result=JSON.parse(await exec(`JSON.stringify(${s}?.summary||null)`));if(['created','unknown'].includes(result?.state))break;await new Promise(r=>setTimeout(r,500));}
        if(!['created','unknown'].includes(result?.state))result={state:'unknown',error:'等待平台结果超时，禁止重发，请先核对目标店商品列表'};
        // 仅保存脱敏回执，不把完整请求、签名图片地址或账号凭证写进工作日志。
        const folder=new URL('../test-artifacts/direct-results/',import.meta.url);await mkdir(folder,{recursive:true});
        await writeFile(new URL(`${attemptId}.json`,folder),JSON.stringify({jobId:job.id,spuId:item.spuId,storeId,attemptId,...result},null,2));
        await report({phase:result.state,attemptId,productId:result.productId,verified:result.verified,reason:result.state==='created'?`接口创建并回查成功，新SPU ${result.productId}；不代表已审核上架`:`结果待核对${result.productId?'，平台已返回SPU '+result.productId:''}：${result.error}；禁止自动重试`});
    } catch(error) {
        await report({phase:attemptId?'unknown':'preflight_failed',attemptId,reason:`${attemptId?'提交状态待核对，禁止重试':'预检未通过，未提交'}：${String(error.message).slice(0,800)}`}).catch(()=>{});
        throw error;
    } finally {
        // 不终止已经发出的请求；保留五分钟回执窗口供结果不明时人工核对。
        if(!attemptId)await exec(`delete ${s};'cleaned'`).catch(()=>{});
    }
}
