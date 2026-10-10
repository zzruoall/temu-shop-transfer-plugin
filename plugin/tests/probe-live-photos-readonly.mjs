/** 显式指定来源店、商品和已打开页面的只读探针；不导航、不入库、不上传、不识别、不确认声明。 */
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const [storeId, spuId, targetId] = process.argv.slice(2);
if (!/^\d{6,20}$/.test(storeId || '') || !/^\d{6,20}$/.test(spuId || '') || !/^[A-Fa-f0-9]{32}$/.test(targetId || '')) {
    throw Error('必须明确提供来源店铺 ID、SPU ID 和已打开页面 ID');
}
const qualification = await readFile(new URL('../qualification-reader.js', import.meta.url), 'utf8');
const photos = await readFile(new URL('../live-photo-reader.js', import.meta.url), 'utf8');
const key = `__temuLivePhotoProbe_${Date.now()}`;
const run = script => {
    const args = ['page', 'exec', '--store-id', storeId, '--target-id', targetId, '--timeout', '12000', '--script', script];
    const entry = process.env.ZINIAO_CLI_JS || path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@ziniao-open', 'cli', 'scripts', 'run.js');
    const result = JSON.parse(execFileSync(process.platform === 'win32' ? process.execPath : 'ziniao-cli',
        process.platform === 'win32' ? [entry, ...args] : args, { encoding: 'utf8', maxBuffer: 1024 * 1024 }));
    if (!result.ok || result.data?.data?.exceptionDetails) throw Error('只读探针执行失败');
    return result.data.data.result;
};
// 分两次载入隔离闭包以避开 Windows 命令行长度上限；不覆盖运行中的插件全局采集器。
run(`(()=>{if(location.href!=='https://agentseller.temu.com/goods/list')throw Error('只能在来源商品列表页执行');
    ${qualification}
    window[${JSON.stringify(key)}]={helper:TemuQualificationReader,pending:true};return '只读采集器已准备';})()`);
let completed = false;
try {
    run(`((TemuQualificationReader)=>{${photos}
        const probe=window[${JSON.stringify(key)}];
        (async()=>{
            let runtime;window.chunkLoadingGlobal_temu_sca_goods.push([[crypto.randomUUID()],{},r=>runtime=r]);
            const matches=Object.entries(runtime.m).filter(([,f])=>{const s=String(f).replace(/\\s+/g,'');return s.includes('getMallIdAsync')&&s.includes('.postWithoutMallId=')&&s.includes('.mallIdClient=');});
            if(matches.length!==1)throw Error('来源客户端候选不唯一');
            const client=runtime(matches[0][0]),url=location.href,mallId=String(await client.mallIdClient.getMallIdAsync());
            if(!/^\\d{6,20}$/.test(mallId))throw Error('来源店铺身份未确认');
            const assertCurrent=async()=>{if(location.href!==url||String(await client.mallIdClient.getMallIdAsync())!==mallId)throw Object.assign(Error('来源切店或切页'),{stopBatch:true});};
            const post=async(address,input,ms)=>{let timer;try{return await Promise.race([client.post(address,input),new Promise((_,reject)=>timer=setTimeout(()=>reject(Object.assign(Error('只读查询超时'),{stopBatch:true})),ms))]);}finally{clearTimeout(timer);}};
            const raw=await post('/visage-agent-seller/product/query',{productId:${JSON.stringify(spuId)}},15000);
            if(raw.success===false||raw.errorCode&&!['0','1000000'].includes(String(raw.errorCode)))throw Error('商品详情读取失败');
            const sourceProduct=raw.result||raw.res||raw;
            const {snapshot,stopBatch}=await TemuLivePhotoReader.readSnapshot(client,{spuId:${JSON.stringify(spuId)},mallId,sourceProduct,
                pageOrigin:location.origin,assertCurrent,post,fetch:window.fetch.bind(window)});
            probe.summary={status:snapshot.status,reason:snapshot.reason,captureState:snapshot.captureState,stopBatch,
                imageCount:snapshot.groups.reduce((n,g)=>n+g.images.length,0),archiveStatus:snapshot.archive.status,
                archivedImages:snapshot.assets.length,archivedBytes:snapshot.assets.reduce((n,a)=>n+a.bytes,0),
                archiveErrors:snapshot.archive.errors.map(e=>e.reason),groups:snapshot.groups.map(g=>({position:g.position,label:g.label,
                    isSameSku:g.isSameSku,skuCount:g.skuIds.length,images:g.images.map(i=>({positionType:i.positionType,typeLabel:i.typeLabel}))}))};
            probe.pending=false;
        })().catch(error=>{probe.pending=false;probe.error=String(error.message);});
        return '只读原图采集已启动';
    })(window[${JSON.stringify(key)}].helper)`);
    for (let i = 0; i < 45; i++) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        const state = JSON.parse(run(`JSON.stringify({pending:window[${JSON.stringify(key)}]?.pending,summary:window[${JSON.stringify(key)}]?.summary,error:window[${JSON.stringify(key)}]?.error})`));
        if (state.pending) continue;
        completed = true;
        console.log(JSON.stringify(state, null, 2));
        if (state.error || state.summary?.status !== 'complete') process.exitCode = 1;
        break;
    }
    if (!completed) throw Error('只读采集超过探针等待期限');
} finally {
    // 超时不删除仍在工作的闭包；不向迟到请求发出任何上传或自动重试。
    if (completed) run(`delete window[${JSON.stringify(key)}]`);
}
