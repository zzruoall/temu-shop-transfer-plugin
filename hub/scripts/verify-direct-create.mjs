/** 隔离任务状态和模拟页面回执，不调用真实店铺新增接口。 */
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {createJobQueue} from '../lib/job-queue.mjs';
import {createDirectProduct} from '../../worker/direct-create.mjs';
const product={spuId:'9100894431',ready:true,title:'测试',images:['https://example.com/a'],skuIds:['1'],skcIds:['2'],publicationData:{sourceProduct:{productId:'9100894431'}}};
// 第二个商品只用于验证“插件掉线后人工重置”，与主流程商品隔离，避免两条链路互相占用同店同货号。
const strayProduct={spuId:'9100894432',ready:true,title:'测试2',images:['https://example.com/b'],skuIds:['3'],skcIds:['4'],publicationData:{sourceProduct:{productId:'9100894432'}}};
const root=await mkdtemp(path.join(os.tmpdir(),'direct-create-test-'));
// 人工下发前服务端要核对来源原包；桩只做一致性透传，不代表真实校验逻辑。
const queue=createJobQueue(root,{getBatch:async()=>({sourceStoreId:'11111111',products:[product,strayProduct]}),listOverview:async()=>({}),verifyBatchTransfer:async(_batch,items)=>items});
const identity={storeId:'22222222',storeName:'target',pageStoreName:'target',pluginInstanceId:'test',pluginDetected:true,identityMatched:true,pluginVersion:'10.10.61'};
await queue.registerAgent(identity);
const input={sourceStoreId:'11111111',targetStoreId:'22222222',targetStoreName:'target',sourceBatchId:'batch',spuIds:[product.spuId],requireOnline:true,directCreate:true,complianceVersion:'V2.0'};
await assert.rejects(queue.createJob({...input,complianceVersion:''}));
const job=await queue.createJob(input);
await queue.reportOpenResult({jobId:job.id,storeId:identity.storeId,status:'opened'});
const {claimed}=await queue.claimJobs({...identity,claimManualUploads:true,manualUploadsOnly:true,pendingUploadCount:0,pendingUploadBytes:0});
assert.equal(claimed[0].directCreate,true);
const base={...identity,jobId:job.id,spuId:product.spuId,claimToken:claimed[0].claimToken};
await queue.reportProgress({...base,status:'received',snapshotSha256:claimed[0].transferIntegrity.sha256});
await assert.rejects(queue.reportProgress({...base,status:'uploaded'}));
const begin={...base,phase:'begin',requestHash:'a'.repeat(64),mallId:'123456',authorizationKey:'authkey-aaaaaaaaaaaaaaaa'};
// 同一授权键的并发请求必须收敛到同一个许可：后到者幂等重放，不得再生成第二次提交。
const results=await Promise.allSettled([queue.directProgress(begin),queue.directProgress(begin)]);
const fulfilled=results.filter(r=>r.status==='fulfilled');
assert.equal(fulfilled.length,2,'同一授权键的并发请求都应得到应答');
assert.equal(new Set(fulfilled.map(r=>r.value.attemptId)).size,1,'并发请求不得产生两个提交许可');
assert.equal(fulfilled.filter(r=>r.value.resumed).length,1,'后到者必须是幂等重放');
const attemptId=results.find(r=>r.status==='fulfilled').value.attemptId;
await assert.rejects(queue.cancelJob(job.id));
// 新点击可独立投递同一商品，不能改变旧执行尝试；投递成功不等于立即获得平台执行许可。
const independentSend = await queue.createJob({...input});
assert.notEqual(independentSend.id, job.id);
assert.equal((await queue.getJob(job.id)).items[0].directAttemptId, attemptId);
await queue.cancelJob(independentSend.id);
await queue.directProgress({...base,phase:'unknown',attemptId,productId:'8002250622',reason:'测试未知结果'});
assert.equal((await queue.getJob(job.id)).items[0].createdProductId,'8002250622');
// 同一授权键重传只确认原许可，绝不产生第二次提交；结果未知时也不得自动重发。
const replayed=await queue.directProgress(begin);
assert.equal(replayed.attemptId,attemptId,'重传不得生成新的提交许可');
assert.equal(replayed.resumed,true,'重传必须是幂等重放');
assert.equal(replayed.state,'unknown','未知结果必须保留，不能借重传重新提交');
await assert.rejects(queue.cancelJob(job.id));
await queue.directProgress({...base,phase:'created',attemptId,productId:'8002250622',verified:true});
// 网络重传的相同完成回执可幂等确认，错误商品编号不能覆盖成功结果。
assert.equal((await queue.directProgress({...base,phase:'created',attemptId,productId:'8002250622',verified:true})).state,'created');
await assert.rejects(queue.directProgress({...base,phase:'created',attemptId,productId:'8002250623',verified:true}));
// 心跳过期不应阻断已授权结果补传，但不能因此放行新的创建授权。
const {writeFile}=await import('node:fs/promises');
const {readdir}=await import('node:fs/promises');
const stateFiles=await readdir(root);
for(const file of await readdir(path.join(root,'data'))) {
    if(!file.endsWith('.json'))continue;
    const location=path.join(root,'data',file);
    const data=JSON.parse(await readFile(location,'utf8'));
    if(!Array.isArray(data.agents))continue;
    for(const agent of data.agents)agent.lastSeenAt='2000-01-01T00:00:00.000Z';
    await writeFile(location,JSON.stringify(data));
}
assert.equal((await queue.directProgress({...base,phase:'created',attemptId,productId:'8002250622',verified:true})).state,'created');
// 心跳过期后重传同一授权键仍只确认原许可，不能因心跳变化重新授权或重复提交。
const staleReplay=await queue.directProgress(begin);
assert.equal(staleReplay.attemptId,attemptId,'心跳过期后重传不得生成新许可');
assert.equal(staleReplay.resumed,true,'心跳过期后重传必须是幂等重放');
assert.equal(staleReplay.state,'created','已提交成功的尝试不能被重传改写');
// 心跳已过期的店铺不能拿到新的下发，恢复心跳后才允许重新创建；这里必须先恢复，否则下面会被离线校验拦住。
await queue.registerAgent(identity);
// 任务结束后同一店铺与商品可以再次下发，是否已存在由目标店插件在平台内自行检索。
const reissued=await queue.createJob({...input,replaceExisting:true});
assert.equal(reissued.items[0].status,'queued');
// 编译所有动态脚本，模拟单次成功，确保服务端占位发生在新增调用之前。
let submitted=0;const phases=[];
await createDirectProduct({job:{id:'mock-job',targetStoreId:identity.storeId},item:{spuId:product.spuId,claimToken:'mock',snapshot:{publicationData:{sourceProduct:{productId:product.spuId}}}},identity,
 hubPost:async(_url,body)=>{phases.push(body.phase);return {attemptId:'mock-test'};},
 executePage:async(_store,tab,script)=>{new vm.Script(script);if(!tab)return {targetId:'tab',result:JSON.stringify({url:'https://agentseller.temu.com/goods/list',name:'target',instance:'test'})};if(script.includes("'submitted_once'")){assert.deepEqual(phases,['begin']);submitted++;}if(script.startsWith('JSON.stringify(window['))return {result:JSON.stringify(submitted?{state:'created',productId:'8002250622',verified:true}:{state:'ready',hash:'a'.repeat(64),mall:'123456',skuCount:1,imageCount:1})};return {result:'ok'};}});
assert.equal(submitted,1);assert.deepEqual(phases,['begin','created']);
const integrity=vm.runInNewContext(await readFile(new URL('../../worker/direct-integrity.js',import.meta.url),'utf8'));
const source={carouselImageUrls:['a'],productSkcList:[{productSkuList:[{extCode:'x',supplierPrice:1800,productSkuSpecList:[{specId:1}],productSkuMultiPack:{productSkuNetContent:{netContentNumber:100000,netContentUnitCode:2}}}]}]};
const request={carouselImageUrls:['a'],productSkcReqs:[{productSkuReqs:[{extCode:'x',supplierPrice:1800,thumbUrl:'a',productSkuSpecReqs:[{specId:1}],productSkuMultiPackReq:{productSkuNetContentReq:{netContentNumber:100000,netContentUnitCode:2}}}]}]};
assert.equal(integrity(source,request),true);request.productSkcReqs[0].productSkuReqs[0].productSkuMultiPackReq={};assert.throws(()=>integrity(source,request));
// 平台转换器回传的规格字段可能是类数组实例（有 length 与索引，但 Array.isArray 为 false）。
// 曾因此把目标规格读成空集合，让没有内容差异的商品在预检阶段被误判为失败。
const arrayLike=(items)=>{const fake={length:items.length};items.forEach((item,index)=>{fake[index]=item;});Object.defineProperty(fake,Symbol.toStringTag,{value:'Array'});return fake;};
const arrayLikeSource={carouselImageUrls:['a'],productSkcList:[{productSkuList:[{extCode:'ZWX007',supplierPrice:1800,productSkuSpecList:[{specId:229550}]}]}]};
const arrayLikeRequest={carouselImageUrls:['a'],productSkcReqs:[{productSkuReqs:[{extCode:'ZWX007',supplierPrice:1800,thumbUrl:'a',productSkuSpecReqs:arrayLike([{specId:229550}])}]}]};
assert.equal(Array.isArray(arrayLikeRequest.productSkcReqs[0].productSkuReqs[0].productSkuSpecReqs),false,'测试前提：该字段必须是类数组而非真数组');
assert.equal(integrity(arrayLikeSource,arrayLikeRequest),true,'类数组规格必须能读取规格编号，不能被当成空集合');
// 商品级成分下传到 SKU 级是正确行为：来源 SKU 级为空、商品级有成分时，目标请求带商品级成分不能判为丢失。
const cosmeticSource={carouselImageUrls:['a'],productNonAuditExtAttr:{cosmeticInfoVO:{propertyInfoList:[{vid:11},{vid:22}]}},productSkcList:[{productSkuList:[{extCode:'x',supplierPrice:1800,productSkuSpecList:[{specId:1}],productSkuNonAuditExtAttr:null}]}]};
const cosmeticRequest={carouselImageUrls:['a'],productSkcReqs:[{productSkuReqs:[{extCode:'x',supplierPrice:1800,thumbUrl:'a',productSkuSpecReqs:[{specId:1}],productSkuNonAuditExtAttrReq:{productSkuCosmeticInfoReqList:[{propertyInfoList:[{vid:11},{vid:22}]}]}}]}]};
assert.equal(integrity(cosmeticSource,cosmeticRequest),true,'商品级成分下传后必须与商品级成分一致，不能判为丢失');
// 成分确实丢失时仍必须拦截，避免放宽成“任何成分差异都放过”。
const cosmeticBroken=JSON.parse(JSON.stringify(cosmeticRequest));cosmeticBroken.productSkcReqs[0].productSkuReqs[0].productSkuNonAuditExtAttrReq.productSkuCosmeticInfoReqList=[{propertyInfoList:[{vid:11}]}];
assert.throws(()=>integrity(cosmeticSource,cosmeticBroken),'成分少传时必须仍然拦截');
// 平台明确拒绝时属于当前 attempt 的终态：必须把平台原文写进任务并停止自动复核，
// 否则已授权过的任务会被判为“重复提交”而丢掉失败原因，运营在工作日志里看不到真实问题。
await queue.registerAgent(identity);
const rejectedClaim=await queue.claimJobs({...identity,claimManualUploads:true,manualUploadsOnly:true,pendingUploadCount:0,pendingUploadBytes:0});
const rejectedItem=rejectedClaim.claimed.find(item=>item.jobId===reissued.id);
assert.ok(rejectedItem,'重新下发的任务必须能被目标店领取');
const rejectedBase={...identity,jobId:reissued.id,spuId:product.spuId,claimToken:rejectedItem.claimToken};
await queue.reportProgress({...rejectedBase,status:'received',snapshotSha256:rejectedItem.transferIntegrity.sha256});
const rejectedAttempt=await queue.directProgress({...rejectedBase,phase:'begin',requestHash:'b'.repeat(64),mallId:'123456',authorizationKey:'authkey-bbbbbbbbbbbbbbbb'});
await assert.rejects(queue.directProgress({...rejectedBase,phase:'preflight_failed',attemptId:'wrong-attempt',reason:'当前类目净含量必填'}));
assert.equal((await queue.directProgress({...rejectedBase,phase:'preflight_failed',attemptId:rejectedAttempt.attemptId,reason:'当前类目净含量必填（错误码 2000135）'})).state,'preflight_failed');
const rejectedJob=await queue.getJob(reissued.id);
// 回执通道对旧插件仍回 preflight_failed，数据库存准确的 rejected；两者不能混为一谈。
assert.equal(rejectedJob.items[0].directState,'rejected');
assert.equal(rejectedJob.items[0].status,'failed');
assert.match(String(rejectedJob.items[0].reason),/净含量/);
// 人工确认重试是 unknown / preflight_failed / rejected 之后唯一能重新排队的入口：
// 未确认必须拒绝；确认后旧 attempt 的授权键、请求指纹和商城标识全部作废，任务回到队尾等插件重新做货号复核。
await assert.rejects(queue.directRetry({jobId:reissued.id,storeId:identity.storeId,spuId:product.spuId}),/人工确认/);
const retried=await queue.directRetry({jobId:reissued.id,storeId:identity.storeId,spuId:product.spuId,confirmed:true});
assert.equal(retried.state,'queued_for_retry');
assert.equal(retried.retrySequence,1);
const retriedItem=(await queue.getJob(reissued.id)).items[0];
assert.equal(retriedItem.status,'retry_wait');
assert.equal(retriedItem.directState,'');
assert.equal(retriedItem.directAttemptId,'');
assert.equal(retriedItem.directPluginInstanceId,'');
assert.equal(retriedItem.authorizationKey,'');
assert.equal(retriedItem.requestHash,'');
assert.equal(retriedItem.targetMallId,'');
assert.equal(retriedItem.submitted,false);
// 已经回到队尾的项目不能再重复确认，否则一次人工点击会膨胀成多次创建尝试。
await assert.rejects(queue.directRetry({jobId:reissued.id,storeId:identity.storeId,spuId:product.spuId,confirmed:true}),/尚未结束/);
assert.ok((await queue.listActivity()).entries.some(entry=>entry.jobId===reissued.id&&entry.type==='direct_manual_retry'));

// 插件中途掉线会在服务器留下两种“自己已经停下、服务器仍占位”的项目：快照已送达但预检从未开始，
// 以及提交已发出但长时间没有进度更新。两者都必须能人工重置，否则同店同货号会被永久挡住。
const strayInput={...input,spuIds:[strayProduct.spuId]};
const stranded=await queue.createJob({...strayInput,replaceExisting:true});
const strandedClaim=await queue.claimJobs({...identity,claimUploads:true,claimManualUploads:true,manualUploadsOnly:true,pendingUploadCount:0,pendingUploadBytes:0});
const strandedItem=strandedClaim.claimed.find(item=>item.jobId===stranded.id);
assert.equal(strandedItem.directRetrySequence,0,'首次下发不带人工重试代次');
const strandedBase={...identity,jobId:stranded.id,spuId:strayProduct.spuId,claimToken:strandedItem.claimToken};
await queue.reportProgress({...strandedBase,status:'received',snapshotSha256:strandedItem.transferIntegrity.sha256});
const strandedRetry=await queue.directRetry({jobId:stranded.id,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true});
assert.equal(strandedRetry.state,'queued_for_retry');
assert.equal(strandedRetry.retrySequence,1,'人工重试必须递增代次，插件据此清掉本地旧 attempt');
await assert.rejects(queue.directRetry({jobId:stranded.id,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true}),/尚未结束/);
// 让出占位后再验证下一种卡住状态，否则新任务会被同店同货号的在途项拦住。
await queue.cancelJob(stranded.id);
assert.equal((await queue.getJob(stranded.id)).status,'cancelled');
// 提交中断只有超过静默窗口才允许重置，避免把仍在页面里跑着的提交判成失败。
const creating=await queue.createJob({...strayInput,replaceExisting:true});
const creatingClaim=await queue.claimJobs({...identity,claimUploads:true,claimManualUploads:true,manualUploadsOnly:true,pendingUploadCount:0,pendingUploadBytes:0});
const creatingItem=creatingClaim.claimed.find(item=>item.jobId===creating.id);
const creatingBase={...identity,jobId:creating.id,spuId:strayProduct.spuId,claimToken:creatingItem.claimToken};
await queue.reportProgress({...creatingBase,status:'received',snapshotSha256:creatingItem.transferIntegrity.sha256});
await queue.directProgress({...creatingBase,phase:'begin',requestHash:'c'.repeat(64),mallId:'123456',authorizationKey:'authkey-cccccccccccccccc'});
await assert.rejects(queue.directRetry({jobId:creating.id,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true}),/尚未结束/);
{
    // 直接改写落盘状态来模拟插件掉线 11 分钟：不能依赖测试环境真的等待静默窗口。
    const {readFile,writeFile}=await import('node:fs/promises');
    const {readdir}=await import('node:fs/promises');
    // 任务状态落在 <root>/data/jobs.json，不能只扫根目录，否则改写落空会让断言假通过。
    for(const file of (await readdir(path.join(root,'data'))).filter(name=>name.endsWith('.json'))) {
        const location=path.join(root,'data',file);
        const data=JSON.parse(await readFile(location,'utf8'));
        if(!Array.isArray(data.jobs))continue;
        let touched=false;
        for(const entry of data.jobs) {
            for(const item of entry.items||[]) {
                if(entry.id===creating.id&&item.spuId===strayProduct.spuId) { item.directUpdatedAt=new Date(Date.now()-11*60*1000).toISOString(); touched=true; }
            }
        }
        if(touched)await writeFile(location,JSON.stringify(data));
    }
}
assert.equal((await queue.directRetry({jobId:creating.id,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true})).state,'queued_for_retry');
// 越过店铺边界的人工重试必须落空，避免借 jobId 解锁另一家店的任务。
await assert.rejects(queue.directRetry({jobId:creating.id,storeId:'99999999',spuId:strayProduct.spuId,confirmed:true}),/任务不存在/);
// 已取消的项目会留着历史 directState；人工重试不能让取消过的商品重新排队。
await queue.cancelJob(creating.id);
await assert.rejects(queue.directRetry({jobId:creating.id,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true}),/已取消/);
// 已授权提交即使掉线、超时也不能被新任务覆盖；新点击允许独立投递，保留旧回执凭证。
const liveGuard=await queue.createJob({...strayInput});
const liveGuardClaim=await queue.claimJobs({...identity,claimUploads:true,claimManualUploads:true,manualUploadsOnly:true,pendingUploadCount:0,pendingUploadBytes:0});
const liveGuardClaimItem=liveGuardClaim.claimed.find(item=>item.jobId===liveGuard.id);
assert.ok(liveGuardClaimItem,'先确认目标店能领取旧任务，再验证新点击不会覆盖它');
const liveGuardBase={...identity,jobId:liveGuard.id,spuId:strayProduct.spuId,claimToken:liveGuardClaimItem.claimToken};
await queue.reportProgress({...liveGuardBase,status:'received',snapshotSha256:liveGuardClaimItem.transferIntegrity.sha256});
await queue.directProgress({...liveGuardBase,phase:'begin',requestHash:'e'.repeat(64),mallId:'123456',authorizationKey:'authkey-eeeeeeeeeeeeeeee'});
const liveResend = await queue.createJob({...strayInput});
assert.notEqual(liveResend.id, liveGuard.id);
assert.equal((await queue.getJob(liveGuard.id)).items[0].claimToken, liveGuardClaimItem.claimToken);
await queue.cancelJob(liveResend.id);
{
    // 同样直接改写落盘状态模拟插件掉线 11 分钟，避免测试真的等待静默窗口。
    const {readFile,writeFile}=await import('node:fs/promises');
    const {readdir}=await import('node:fs/promises');
    for(const file of (await readdir(path.join(root,'data'))).filter(name=>name.endsWith('.json'))) {
        const location=path.join(root,'data',file);
        const data=JSON.parse(await readFile(location,'utf8'));
        if(!Array.isArray(data.jobs))continue;
        let touched=false;
        for(const entry of data.jobs) {
            if(entry.id!==liveGuard.id)continue;
            for(const item of entry.items||[]) {
                if(item.spuId===strayProduct.spuId) { item.directUpdatedAt=new Date(Date.now()-11*60*1000).toISOString(); touched=true; }
            }
        }
        if(touched)await writeFile(location,JSON.stringify(data));
    }
}
const lateResend = await queue.createJob({...strayInput});
assert.notEqual(lateResend.id, liveGuard.id);
await queue.cancelJob(lateResend.id);
assert.equal((await queue.getJob(liveGuard.id)).items[0].directState,'creating');
await queue.directRetry({jobId:liveGuard.id,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true});
await queue.cancelJob(liveGuard.id);
// 同一个货号同时挂在两个任务下时，逐个重试必须保持只有一个在途项，否则两件都会各自提交。
const pairA=await queue.createJob({...strayInput,replaceExisting:true});
const pairAClaim=await queue.claimJobs({...identity,claimUploads:true,claimManualUploads:true,manualUploadsOnly:true,pendingUploadCount:0,pendingUploadBytes:0});
const pairAItem=pairAClaim.claimed.find(item=>item.jobId===pairA.id);
await queue.reportProgress({...identity,jobId:pairA.id,spuId:strayProduct.spuId,claimToken:pairAItem.claimToken,status:'received',snapshotSha256:pairAItem.transferIntegrity.sha256});
await queue.directProgress({...identity,jobId:pairA.id,spuId:strayProduct.spuId,claimToken:pairAItem.claimToken,phase:'begin',requestHash:'d'.repeat(64),mallId:'123456',authorizationKey:'authkey-dddddddddddddddd'});
const pairAAttempt=(await queue.directProgress({...identity,jobId:pairA.id,spuId:strayProduct.spuId,claimToken:pairAItem.claimToken,phase:'unknown',attemptId:(await queue.getJob(pairA.id)).items[0].directAttemptId,reason:'测试未知结果'})).state;
assert.equal(pairAAttempt,'unknown');
// 直接构造缺少现代投递编号的历史任务，继续覆盖人工重试的兼容保护，不代表新点击禁止投递。
const pairBId='legacy-pair-b';
{
    const {readFile,writeFile}=await import('node:fs/promises');
    const {readdir}=await import('node:fs/promises');
    for(const file of (await readdir(path.join(root,'data'))).filter(name=>name.endsWith('.json'))) {
        const location=path.join(root,'data',file);
        const data=JSON.parse(await readFile(location,'utf8'));
        if(!Array.isArray(data.jobs))continue;
        const source=data.jobs.find(entry=>entry.id===pairA.id);
        if(!source)continue;
        const clone={...source,id:pairBId,items:source.items.map(item=>({...item,status:'received',directState:'',claimToken:'legacy-token'}))};
        data.jobs=[clone,...data.jobs];
        await writeFile(location,JSON.stringify(data));
    }
}
// 先重试历史遗留项：此时另一项还停在 unknown，并未在途，允许重排。
assert.equal((await queue.directRetry({jobId:pairBId,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true})).state,'queued_for_retry');
// 重排后同店同货号已经有在途项，第二件必须被拦下，否则两件会各自提交造成重复创建。
await assert.rejects(queue.directRetry({jobId:pairA.id,storeId:identity.storeId,spuId:strayProduct.spuId,confirmed:true}),/已有任务在排队或提交中/);
console.log('Direct create: authorization, concurrency, cancellation, unknown-state, platform-rejection terminal state, manual retry, duplicate guard, injected script syntax and integrity passed');
