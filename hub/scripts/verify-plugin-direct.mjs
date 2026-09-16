/** 隔离模拟插件后台与页面通信，绝不向平台发送真实请求。 */
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../plugin/direct-executor.js',import.meta.url),'utf8');
for(const scenario of ['success','submit-timeout','resume','verify-timeout','unknown-recovery','platform-rejected','prepare-injection-failed','prepare-business-blocked','server-retry-sequence']){
    const data={},phases=[],bodies=[],logs=[];let submits=0,prepareCalls=0;
    // 结果待核对的历史任务：本地只留有 request/hash，必须靠插件复核后才能重新授权提交。
    if(scenario==='unknown-recovery')data['directAttempt:job:9100894431']={stage:'unknown',request:{productName:'test'},hash:'a'.repeat(64),mallId:'123',attemptId:'old-attempt'};
    if(scenario==='server-retry-sequence')data['directAttempt:job:9100894431']={stage:'preflight_failed',done:true,businessError:'上一轮失败',retrySequence:0};
    const ctx=vm.createContext({console,crypto:globalThis.crypto,Set,Promise,setTimeout,clearTimeout,
        chrome:{runtime:{getManifest:()=>({version:'10.10.41'})},storage:{local:{get:async k=>({[k]:data[k]}),set:async obj=>Object.assign(data,structuredClone(obj)),remove:async k=>{delete data[k];}}},scripting:{executeScript:async spec=>{
            if(spec.files)return [];
            const [op]=spec.args;
            if(op && typeof op==='object')return [{result:{state:'not_found'}}];
            if(op==='identity')return [{result:{mallId:'123'}}];
            if(op==='duplicate-check')return [{result:{state:'not_found'}}];
            if(op==='prepare'){
                prepareCalls++;
                if(scenario==='prepare-injection-failed')return [{}];
                if(scenario==='prepare-business-blocked')return [{exceptionDetails:{exception:{description:'Error: 缺少必填属性：留香时长'}}}];
                return [{result:{request:{productName:'test'},hash:'a'.repeat(64)}}];
            }
            if(op==='submit'){submits++;if(scenario==='submit-timeout')throw Error('timeout');return [{result:{started:true}}];}
            if(op==='submit-status'){
                if(scenario==='submit-timeout')return [{result:{state:'unknown',error:'timeout'}}];
                // 平台以普通对象明确拒绝：商品确定没有创建，不能记成“结果待核对”。
                if(scenario==='platform-rejected')return [{result:{state:'rejected',error:'当前类目净含量必填（错误码 2000135）',errorCode:2000135}}];
                return [{result:{state:'created',productId:'8002250622'}}];
            }
            if(op==='verify'){if(scenario==='verify-timeout')throw Error('query timeout');return [{result:{verified:true}}];}
        }}},getTargetUploadTasks:async()=>[{jobId:'job',spuId:'9100894431',targetStoreId:'temu:123',claimToken:'secret',directCreate:true,directState:scenario==='unknown-recovery'?'unknown':'',directRetrySequence:scenario==='server-retry-sequence'?1:0,snapshot:{publicationData:{sourceProduct:{productId:'9100894431'}}}}],
        getPluginInstanceId:async()=> 'instance',TemuOperationLog:{append:async entry=>{logs.push(entry);}},hubJson:async(url,body)=>{phases.push(body.phase);bodies.push(body);return {attemptId:'attempt',resumed:scenario==='resume'};}});
    vm.runInContext(source,ctx);
    await vm.runInContext("runDirectTasks(1,{storeId:'temu:123',mallId:'123'})",ctx);
    await vm.runInContext("runDirectTasks(1,{storeId:'temu:123',mallId:'123'})",ctx);
    // unknown 只能隔离并等待人工确认；不能因为再次心跳就自动发起第二个 attempt。
    assert.equal(submits,['resume','unknown-recovery','prepare-injection-failed','prepare-business-blocked'].includes(scenario)?0:1);
    assert.equal(data['directAttempt:job:9100894431'].done===true,['success','platform-rejected','prepare-injection-failed','prepare-business-blocked','server-retry-sequence'].includes(scenario));
    if(scenario==='unknown-recovery')assert.equal(bodies.find(body=>body.phase==='begin'),undefined);
    if(!['success','unknown-recovery','platform-rejected','prepare-injection-failed','prepare-business-blocked','server-retry-sequence'].includes(scenario))assert.ok(phases.includes('unknown'));
    // 平台明确拒绝必须停在预检失败并带上平台原文；写成 "[object Object]" 等于没有可诊断信息。
    if(scenario==='platform-rejected'){
        assert.ok(phases.includes('preflight_failed'),'平台拒绝必须上报预检失败');
        assert.ok(!phases.includes('unknown'),'平台拒绝不能上报为结果待核对');
        const report=bodies.find(body=>body.phase==='preflight_failed');
        assert.match(String(report?.reason),/净含量/,'预检失败原因必须保留平台原文');
        const failed=logs.find(entry=>entry.status==='failed');
        assert.match(String(failed?.error),/净含量/,'操作日志必须记录平台原文');
        assert.ok(!String(failed?.error).includes('[object Object]'),'操作日志不能出现 [object Object]');
        assert.equal(data['directAttempt:job:9100894431'].stage,'rejected');
    }
    if(scenario==='prepare-injection-failed'){
        // directPage 会为短暂页面重载重试一次，但同一心跳只能产生一次预检结论；第二次心跳必须直接跳过。
        assert.equal(prepareCalls,2,'页面注入失败时只在当前心跳内执行一次有限重试');
        assert.equal(submits,0,'预检未通过时不允许提交');
        assert.equal(data['directAttempt:job:9100894431']?.stage,'preflight_failed');
        assert.equal(data['directAttempt:job:9100894431']?.done,true,'预检失败必须落终态，避免心跳重复失败');
        const report=bodies.find(body=>body.phase==='preflight_failed');
        assert.match(String(report?.reason),/页面注入未返回结果/,'服务端必须收到页面注入失败原文');
    }
    if(scenario==='prepare-business-blocked'){
        assert.equal(prepareCalls,2,'页面抛错时保留一次有限重试，以覆盖路由切换窗口');
        assert.equal(submits,0,'预检未通过时不允许提交');
        assert.equal(data['directAttempt:job:9100894431']?.stage,'preflight_failed');
        assert.equal(data['directAttempt:job:9100894431']?.done,true,'业务阻断必须落终态');
        const report=bodies.find(body=>body.phase==='preflight_failed');
        assert.match(String(report?.reason),/缺少必填属性：留香时长/,'必须保留页面抛出的业务原因');
        assert.doesNotMatch(String(report?.reason),/页面注入未返回结果/,'不能把业务阻断误报成页面未响应');
    }
    if(scenario==='server-retry-sequence'){
        assert.equal(prepareCalls,1,'服务器人工重试后必须重新执行预检');
        assert.equal(submits,1,'服务器重试序号必须解除旧 attempt 的完成保护');
        assert.equal(data['directAttempt:job:9100894431']?.retrySequence,1,'新 attempt 必须记录服务器重试序号');
        assert.equal(data['directAttempt:job:9100894431']?.stage,'created','重试成功应进入创建完成状态');
    }
}
{
    const started=[];
    const ctx=vm.createContext({console,crypto:globalThis.crypto,Set,Promise,setTimeout,clearTimeout,
        chrome:{storage:{local:{get:async()=>({}),set:async()=>{}}},scripting:{executeScript:async()=>{
            started.push(Date.now());
            await new Promise(resolve=>setTimeout(resolve,40));
            return [];
        }}},
        getTargetUploadTasks:async()=>[],
        getPluginInstanceId:async()=>'instance',
        TemuOperationLog:{append:async()=>{}},
        hubJson:async()=>({})
    });
    vm.runInContext(source,ctx);
    await Promise.all([
        vm.runInContext("runDirectTasks(11,{storeId:'temu:111',mallId:'111'})",ctx),
        vm.runInContext("runDirectTasks(22,{storeId:'temu:222',mallId:'222'})",ctx)
    ]);
    assert.equal(started.length,2);
}
// 旧任务快照只有摘要属性时，提交前也必须把摘要补回来源商品，避免列表属性在历史任务中再次丢失。
{
    const data={},prepareSources=[];
    const ctx=vm.createContext({console,crypto:globalThis.crypto,Set,Promise,setTimeout,clearTimeout,
        chrome:{runtime:{getManifest:()=>({version:'10.10.41'})},storage:{local:{get:async k=>({[k]:data[k]}),set:async obj=>Object.assign(data,structuredClone(obj))}},scripting:{executeScript:async spec=>{
            if(spec.files)return [];
            const [op]=spec.args;
            if(op && typeof op==='object')return [{result:{state:'not_found'}}];
            if(op==='identity')return [{result:{mallId:'123'}}];
            if(op==='prepare'){prepareSources.push(spec.args[1].source);return [{result:{request:{productName:'test'},hash:'a'.repeat(64)}}];}
            if(op==='submit-status')return [{result:{state:'created',productId:'8002250622'}}];
            if(op==='verify')return [{result:{verified:true}}];
            return [{result:{started:true}}];
        }}},
        getTargetUploadTasks:async()=>[{
            jobId:'job',spuId:'9100894431',targetStoreId:'temu:123',claimToken:'secret',directCreate:true,directState:'',
            snapshot:{
                attributes:[{name:'香味',value:'玫瑰',unit:'',refPid:386,vid:4253}],
                publicationData:{sourceProduct:{productId:'9100894431',productPropertyList:[],productSkcList:[{extCode:'ZWX019',productSkuList:[]}]}}
            }
        }],
        getPluginInstanceId:async()=>'instance',TemuOperationLog:{append:async()=>{}},hubJson:async()=>({attemptId:'attempt',resumed:false})});
    vm.runInContext(source,ctx);
    await vm.runInContext("runDirectTasks(1,{storeId:'temu:123',mallId:'123'})",ctx);
    assert.equal(prepareSources.length,1,'历史任务完成判重后必须进入预检');
    assert.equal(prepareSources[0].productPropertyList[0].propName,'香味','摘要属性必须合并回来源商品');
    assert.equal(prepareSources[0].productPropertyList[0].refPid,386,'摘要属性编号不能丢失');
}
// 结果待核对且复核持续失败：自动复核必须有次数上限，不能每 8 秒无限重试。
{
    const data={'directAttempt:job:9100894431':{stage:'unknown',request:{productName:'test'},hash:'a'.repeat(64),mallId:'123',attemptId:'old-attempt'}};
    let prepares=0,submits=0;
    const ctx=vm.createContext({console,crypto:globalThis.crypto,Set,Promise,setTimeout,clearTimeout,
        chrome:{storage:{local:{get:async k=>({[k]:data[k]}),set:async obj=>Object.assign(data,structuredClone(obj))}},scripting:{executeScript:async spec=>{
            if(spec.files)return [];
            const [op]=spec.args;
            if(op && typeof op==='object')return [{result:{state:'not_found'}}];
            if(op==='prepare'){prepares++;throw Error('prepare failed');}
            if(op==='submit'){submits++;return [{result:{started:true}}];}
            return [{result:{}}];
        }}},getTargetUploadTasks:async()=>[{jobId:'job',spuId:'9100894431',targetStoreId:'temu:123',claimToken:'secret',directCreate:true,directState:'unknown',snapshot:{publicationData:{sourceProduct:{productId:'9100894431'}}}}],
        getPluginInstanceId:async()=>'instance',TemuOperationLog:{append:async()=>{}},hubJson:async()=>({attemptId:'attempt'})});
    vm.runInContext(source,ctx);
    for(let round=0;round<4;round++)await vm.runInContext("runDirectTasks(1,{storeId:'temu:123',mallId:'123'})",ctx);
    // unknown 任务在每轮心跳都保持隔离，不再自动复核或发起新的预检。
    assert.equal(prepares,0,'结果未知时不得自动发起新的预检');
    assert.equal(submits,0,'预检从未通过时不允许提交');
    assert.equal(data['directAttempt:job:9100894431'].stage,'unknown','结果未知必须保持隔离');
}
console.log('插件接口模拟通过：成功、提交断线、授权恢复、结果待核对复核恢复与次数上限、回查失败均不重复新增；两店可并行自动创建');
