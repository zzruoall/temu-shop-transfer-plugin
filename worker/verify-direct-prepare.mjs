/** 对单个指定待办做无提交实测，输出字段计数，不输出凭证或商品图片签名。 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { unwrapCliData } from "../hub/lib/ziniao-cli.mjs";
const cli = path.join(process.env.APPDATA,"npm/node_modules/@ziniao-open/cli/scripts/run.js");
async function exec(script) {
    return new Promise((resolve,reject)=>{
        const child=spawn(process.execPath,[cli,"page","exec","--store-id","27751811499835","--target-id","730469C16FD9337198D6CADEF953CC69","--script",script],{shell:false,windowsHide:true});
        let out="";child.stdout.on("data",chunk=>out+=chunk);child.on("error",reject);child.on("close",code=>{try{if(code)throw Error("cli_failed");const d=unwrapCliData(JSON.parse(out));if(d.exceptionDetails)throw Error("page_exception");resolve(d.result)}catch(error){reject(error)}});
    });
}
const data=await fetch("http://127.0.0.1:18380/api/jobs").then(r=>r.json());
const job=data.jobs.find(j=>j.id==="f86e6add-f4a"&&j.targetStoreId==="27751811499835");
const product=job?.items.find(i=>i.spuId==="9100894431")?.snapshot.publicationData.sourceProduct;
if(!product)throw Error("source_missing");
const encoded=Buffer.from(JSON.stringify(product)).toString("base64");
await exec("delete window.__directPrepared;window.__directSource='';window.__directPreparationResult=null;setTimeout(()=>{delete window.__directSource;delete window.__directPrepared},120000);'ready'");
for(let offset=0;offset<encoded.length;offset+=6000)await exec(`window.__directSource+=${JSON.stringify(encoded.slice(offset,offset+6000))};'chunk'`);
const prepare=fs.readFileSync(new URL("./direct-create-prepare.js",import.meta.url),"utf8");
await exec(`${prepare}(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(window.__directSource),c=>c.charCodeAt(0))))).then(result=>{window.__directPrepared=result;const r=result.request;window.__directPreparationResult={ok:true,keys:Object.keys(r),skcCount:r.productSkcReqs.length,skuKeys:Object.keys(r.productSkcReqs[0]||{}),imageCount:r.carouselImageUrls?.length,attributeCount:r.productPropertyReqs?.length};}).catch(error=>window.__directPreparationResult={ok:false,error:String(error.message)});'started'`);
for(let attempt=0;attempt<30;attempt++){
    const value=await exec("JSON.stringify(window.__directPreparationResult)");
    if(value&&value!=="null"){console.log(value);console.log(await exec("JSON.stringify({blockers:window.__directPrepared?.blockers,requiresComplianceConfirmation:window.__directPrepared?.requiresComplianceConfirmation})"));break;}
    await new Promise(resolve=>setTimeout(resolve,500));
}
await exec("delete window.__directSource;'cleaned'");
