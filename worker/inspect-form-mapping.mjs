/** 单商品只读映射验证：借目标页面自身转换器生成候选值，不调用表单提交或写入平台。 */
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { unwrapCliData } from "../hub/lib/ziniao-cli.mjs";
const storeId = "27751811499835";
async function exec(script) {
    const cli = path.join(process.env.APPDATA, "npm/node_modules/@ziniao-open/cli/scripts/run.js");
    const result = await new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[cli,"page","exec","--store-id",storeId,"--target-id","8BA24D537BF75A614210FAB12FA8BDA2","--script",script],{shell:false,windowsHide:true});
        let out=""; child.stdout.on("data",v=>out+=v);child.on("error",reject);child.on("close",code=>code?reject(Error("cli_failed")):resolve(out));
    });
    const value=unwrapCliData(JSON.parse(result));
    if(value.exceptionDetails) throw Error("page_exception");
    return value.result;
}
const jobs=await fetch("http://127.0.0.1:18380/api/jobs").then(r=>r.json());
const task=jobs.jobs.find(j=>j.id==="f86e6add-f4a"&&j.targetStoreId===storeId)?.items.find(i=>i.spuId==="9100894431");
if(!task?.snapshot?.publicationData?.sourceProduct)throw Error("source_missing");
const key="__temuMappingProbe";
const data=Buffer.from(JSON.stringify(task.snapshot.publicationData.sourceProduct)).toString("base64");
await exec(`window.${key}='';setTimeout(()=>delete window.${key},60000);'ready'`);
try {
    for(let i=0;i<data.length;i+=6000)await exec(`window.${key}+=${JSON.stringify(data.slice(i,i+6000))};'chunk'`);
    // 显式参数才向空白草稿填入；页面模块内禁止提交与覆盖，测试结果只回传字段计数。
    if (process.argv.includes("--fill-empty-form")) {
        await exec(fs.readFileSync(new URL("../plugin/form-fill.js",import.meta.url),"utf8"));
        console.log(await exec(`(()=>{let result;const listener=e=>result=JSON.parse(e.detail);window.addEventListener('temu-fill-result',listener);try{window.dispatchEvent(new CustomEvent('temu-fill-product',{detail:JSON.stringify({requestId:'local-fill-test',product:JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(window.${key}),c=>c.charCodeAt(0))))})}));return JSON.stringify(result)}finally{window.removeEventListener('temu-fill-result',listener)}})()`));
        process.exitCode = 0;
    }
    console.log(await exec(`(()=>{let req;self.chunkLoadingGlobal_temu_sca_goods.push([[Date.now()],{},r=>req=r]);const module=req(67464);const e=document.querySelector('textarea');let f=e?.[Object.keys(e).find(k=>k.startsWith('__reactFiber'))],store;for(;f;f=f.return)if(f.memoizedProps?.value?.form){store=f.memoizedProps.value.form;break}if(!store||store.productId||store.catId!==18813)throw Error('wrong_form');const source=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(window.${key}),c=>c.charCodeAt(0))));module.X9({productInfo:source,matchSupportPersonalization:false,isSupportPersonalizationCat:false});const values=module.FC(source,store,{},store.formApi.getValues().materialMultiLanguages,{});return JSON.stringify({mode:'mapping-only',title:Boolean(values.productName),keys:Object.keys(values),skuCount:Object.keys(values.productSkuMap||{}).length,skcCount:values.productSkcList?.length,imageCount:values.noCostumeCarouselImgsI18n?.common?.length,sourceProductId:source.productId??null,category:store.catId})})()`));
} finally {await exec(`delete window.${key};'cleaned'`).catch(()=>{});}
