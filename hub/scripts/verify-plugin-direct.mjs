/** 隔离模拟插件后台与页面通信，绝不向平台发送真实请求。 */
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import { directExecutorFixture, seedExecutionRounds } from './direct-platform-fixture.mjs';
const source=await directExecutorFixture();
for(const scenario of ['success','submit-timeout','resume','verify-timeout','unknown-recovery','platform-rejected','prepare-injection-failed','prepare-business-blocked','server-retry-sequence']){
    const data={},phases=[],bodies=[],logs=[];let submits=0,prepareCalls=0;
    // 未知结果保留旧 attempt，心跳不得自动复核或重新申请新增。
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
            return [{result:{}}];
        }}},getTargetUploadTasks:async()=>[{jobId:'job',spuId:'9100894431',targetStoreId:'temu:123',claimToken:'secret',directCreate:true,directState:scenario==='unknown-recovery'?'unknown':'',directRetrySequence:scenario==='server-retry-sequence'?1:0,snapshot:{publicationData:{sourceProduct:{productId:'9100894431'}}}}],
        getPluginInstanceId:async()=> 'instance',TemuOperationLog:{append:async entry=>{logs.push(entry);}},hubJson:async(url,body)=>{phases.push(body.phase);bodies.push(body);return {attemptId:'attempt',resumed:scenario==='resume'};}});
    await seedExecutionRounds(ctx);
    vm.runInContext(source,ctx);
    await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])",ctx);
    await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])",ctx);
    // unknown 只能隔离并等待人工确认；不能因为再次心跳就自动发起第二个 attempt。
    assert.equal(submits,['resume','unknown-recovery','prepare-injection-failed','prepare-business-blocked'].includes(scenario)?0:1);
    /**
     * 回查超时不能改判成失败：平台已经返回商品ID，说明商品确实创建成功了，
     * 只是我们没读到回查结果。这时若把它当成失败，平台创建的正是好商品，运营却要重新采集一件。
     * 因此 verify-timeout 也应收在 created，只把回查失败写进备注。
     */
    assert.equal(data['directAttempt:job:9100894431'].done===true,['success','verify-timeout','platform-rejected','prepare-injection-failed','prepare-business-blocked','server-retry-sequence'].includes(scenario),`场景 ${scenario} 的完成状态与预期不符`);
    if(scenario==='verify-timeout'){
        const created=bodies.find(body=>body.phase==='created');
        assert.ok(created,'回查超时必须按创建成功上报，不能改判为失败');
        assert.match(String(created.reason),/回查未通过/,'必须备注回查未通过，供人工核对');
    }
    if(scenario==='unknown-recovery')assert.equal(bodies.find(body=>body.phase==='begin'),undefined);
    // 只有"提交结果真的没读到"才上报 unknown；回查超时是已创建但没读到回查结果，不算 unknown。
    if(!['success','verify-timeout','unknown-recovery','platform-rejected','prepare-injection-failed','prepare-business-blocked','server-retry-sequence'].includes(scenario))assert.ok(phases.includes('unknown'));
    // 平台明确拒绝使用独立 rejected 回执并保留原文，不能降级成未知结果。
    if(scenario==='platform-rejected'){
        assert.ok(phases.includes('rejected'),'平台拒绝必须上报 rejected');
        assert.ok(!phases.includes('unknown'),'平台拒绝不能上报为结果待核对');
        const report=bodies.find(body=>body.phase==='rejected');
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
    const started=[], data={};
    const ctx=vm.createContext({console,crypto:globalThis.crypto,Set,Promise,setTimeout,clearTimeout,
        chrome:{storage:{local:{get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,structuredClone(value))}},scripting:{executeScript:async()=>{
            started.push(Date.now());
            await new Promise(resolve=>setTimeout(resolve,40));
            return [];
        }}},
        getTargetUploadTasks:async()=>[],
        getPluginInstanceId:async()=>'instance',
        TemuOperationLog:{append:async()=>{}},
        hubJson:async()=>({})
    });
    await seedExecutionRounds(ctx, [{storeId:'temu:111',mallId:'111',tabId:11},{storeId:'temu:222',mallId:'222',tabId:22}]);
    vm.runInContext(source,ctx);
    await Promise.all([
        vm.runInContext("runDirectTasks(11,executionIdentities['temu:111'])",ctx),
        vm.runInContext("runDirectTasks(22,executionIdentities['temu:222'])",ctx)
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
    await seedExecutionRounds(ctx);
    vm.runInContext(source,ctx);
    await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])",ctx);
    assert.equal(prepareSources.length,1,'历史任务完成判重后必须进入预检');
    assert.equal(prepareSources[0].productPropertyList[0].propName,'香味','摘要属性必须合并回来源商品');
    assert.equal(prepareSources[0].productPropertyList[0].refPid,386,'摘要属性编号不能丢失');
}
// 结果待核对时重复心跳也不能重新预检或新增，旧 attempt 必须持续保留。
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
    await seedExecutionRounds(ctx);
    vm.runInContext(source,ctx);
    for(let round=0;round<4;round++)await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])",ctx);
    // unknown 任务在每轮心跳都保持隔离，不再自动复核或发起新的预检。
    assert.equal(prepares,0,'结果未知时不得自动发起新的预检');
    assert.equal(submits,0,'预检从未通过时不允许提交');
    assert.equal(data['directAttempt:job:9100894431'].stage,'unknown','结果未知必须保持隔离');
}
console.log('插件接口模拟通过：同轮成功、提交断线、许可重读、未知结果隔离、回查失败不重复新增；两店执行互不覆盖');

/**
 * 同文档后台回收后，尚未授权的 authorizing 记录必须重新判重。
 * 页面刷新或停止会结束轮次，不属于此处允许继续的场景。
 */
{
    const data = {
        'directAttempt:job:9100894431': {
            stage: 'authorizing',
            request: { productName: 'test', productSkcReqs: [{ extCode: 'UAD05*2', productSkuReqs: [{ extCode: 'UAD05*2' }] }] },
            hash: 'a'.repeat(64), hashLength: 64, authorizationKey: 'key-1', mallId: '123', retrySequence: 0
        }
    };
    const searches = [], submits = [];
    const ctx = vm.createContext({
        console, crypto: globalThis.crypto, Set, Map, Promise, setTimeout, clearTimeout,
        chrome: {
            runtime: { getManifest: () => ({ version: '10.10.48' }) },
            storage: { local: {
                get: async k => ({ [k]: data[k] }),
                set: async obj => Object.assign(data, structuredClone(obj)),
                remove: async k => { delete data[k]; } } },
            scripting: { executeScript: async spec => {
                if (spec.files) return [];
                const [op] = spec.args;
                // 判重注入的载荷带 mallId，用它区分判重与其它页面操作。
                if (op && typeof op === 'object' && op.mallId !== undefined) {
                    searches.push('检索目标店');
                    return [{ result: { state: 'exists', productId: '5886465868', matchedBy: 'productExtCode' } }];
                }
                if (op === 'prepare') return [{ result: { request: { productName: 'test' }, hash: 'a'.repeat(64) } }];
                if (op === 'submit') { submits.push('提交'); return [{ result: { started: true } }]; }
                if (op === 'submit-status') return [{ result: { state: 'created', productId: '8000000001' } }];
                if (op === 'verify') return [{ result: { verified: true } }];
                return [{}];
            } }
        },
        getTargetUploadTasks: async () => [{
            jobId: 'job', spuId: '9100894431', targetStoreId: 'temu:123', claimToken: 't',
            directCreate: true, directState: '', directRetrySequence: 0,
            snapshot: { publicationData: { sourceProduct: { productId: '9100894431' } } }
        }],
        getPluginInstanceId: async () => 'instance',
        TemuOperationLog: { append: async () => {} },
        hubJson: async (url, body) => {
            if (body.phase === 'begin') submits.push('申请授权');
            return { attemptId: 'att', resumed: false };
        }
    });
    await seedExecutionRounds(ctx);
    vm.runInContext(source, ctx);
    await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])", ctx);

    assert.ok(searches.length > 0, '同文档后台回收后必须重新检索，不能只凭本地记录直接提交');
    assert.equal(submits.length, 0, '目标店已有该商品时必须跳过，绝不能提交创建');
    assert.equal(data['directAttempt:job:9100894431'].stage, 'duplicate_exists', '跳过结论必须落本地终态，避免心跳反复重试');
    assert.equal(data['directAttempt:job:9100894431'].done, true);
}

/**
 * 对照场景：当前轮次内复查确认目标店没有该商品时，必须照常提交。
 * 判重一旦保守过头，正常商品会被自己的复查挡住，永远传不上去。
 */
{
    const data = {
        'directAttempt:job:9100894432': {
            stage: 'authorizing',
            request: { productName: 'test', productSkcReqs: [{ extCode: 'U5EQ5', productSkuReqs: [{ extCode: 'U5EQ5' }] }] },
            hash: 'b'.repeat(64), hashLength: 64, authorizationKey: 'key-2', mallId: '123', retrySequence: 0
        }
    };
    const searches = [], submits = [];
    const ctx = vm.createContext({
        console, crypto: globalThis.crypto, Set, Map, Promise, setTimeout, clearTimeout,
        chrome: {
            runtime: { getManifest: () => ({ version: '10.10.48' }) },
            storage: { local: {
                get: async k => ({ [k]: data[k] }),
                set: async obj => Object.assign(data, structuredClone(obj)),
                remove: async k => { delete data[k]; } } },
            scripting: { executeScript: async spec => {
                if (spec.files) return [];
                const [op] = spec.args;
                if (op && typeof op === 'object' && op.mallId !== undefined) {
                    searches.push('检索目标店');
                    return [{ result: { state: 'not_found', scanned: 0, pages: 0, queryMode: 'skuExtCodes' } }];
                }
                if (op === 'prepare') return [{ result: { request: { productName: 'test' }, hash: 'b'.repeat(64) } }];
                if (op === 'preserve') return [{ result: { preserved: true } }];
                if (op === 'submit') { submits.push('提交'); return [{ result: { started: true } }]; }
                if (op === 'submit-status') return [{ result: { state: 'created', productId: '8000000002' } }];
                if (op === 'verify') return [{ result: { verified: true } }];
                return [{}];
            } }
        },
        getTargetUploadTasks: async () => [{
            jobId: 'job', spuId: '9100894432', targetStoreId: 'temu:123', claimToken: 't',
            directCreate: true, directState: '', directRetrySequence: 0,
            snapshot: { publicationData: { sourceProduct: { productId: '9100894432' } } }
        }],
        getPluginInstanceId: async () => 'instance',
        TemuOperationLog: { append: async () => {} },
        hubJson: async (url, body) => {
            if (body.phase === 'begin') submits.push('申请授权');
            return { attemptId: 'att', resumed: false };
        }
    });
    await seedExecutionRounds(ctx);
    vm.runInContext(source, ctx);
    await vm.runInContext("runDirectTasks(1,executionIdentities['temu:123'])", ctx);

    assert.ok(searches.length > 0, '同轮 authorizing 记录必须重新检索目标店');
    assert.ok(submits.includes('提交'), '复查确认不存在时必须照常提交，不能被复查挡住');
    assert.equal(data['directAttempt:job:9100894432'].stage, 'created', '正常提交后应进入创建完成状态');
}
console.log('同文档同轮次复查通过：目标店已有则跳过、确认不存在则照常提交');
