import assert from "node:assert/strict";
import { mkdtemp,writeFile,mkdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import mysql from "mysql2/promise";
import { openMysqlDatabase } from "../lib/mysql-database.mjs";
import { initializeMysqlSchema } from "../lib/mysql-schema.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";

// 只构造隔离库的历史明细与模拟回执；绝不调用 TEMU 或正式服务器。
const admin=await mysql.createConnection({host:"127.0.0.1",port:33917,user:"root"});
const name=`temu_load_test_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root=await mkdtemp(path.join(tmpdir(),"temu-mysql-load-"));
const config=path.join(root,"mysql.json");
await writeFile(config,JSON.stringify({host:"127.0.0.1",port:33917,user:"root",database:name}));
const db=await openMysqlDatabase(config);
const results={stores:200,productsPerHistoryStore:5000,historyItems:1000000,platformCalls:0};
async function bounded(items,limit,fn){let next=0;await Promise.all(Array.from({length:limit},async()=>{while(next<items.length){const i=next++;await fn(items[i],i);}}));}
const samples={heartbeat:[],feedback:[],page:[],live:[]};
async function measure(kind,fn){const start=performance.now();const value=await fn();samples[kind].push(performance.now()-start);return value;}
try{
    await initializeMysqlSchema(db);
    const product={spuId:"9100000000",ready:true,title:"隔离并发商品",images:["https://invalid/a"],skuIds:["1"],skcIds:["2"]};
    const queue=createJobQueue(root,{getBatch:async()=>({sourceStoreId:"source",products:[product]}),listOverview:async()=>({products:[]})},{database:db});
    const cases=Array.from({length:200},(_,n)=>({identity:{storeId:`temu:${710000+n}`,mallId:String(710000+n),executionMode:"plugin-api",storeName:`Load ${n}`,pageStoreName:`Load ${n}`,pluginInstanceId:`load-instance-${n}`,pluginVersion:"10.10.53",pluginDetected:true,identityMatched:true}}));
    const seedStart=performance.now();
    await bounded(cases,8,async entry=>{
        await queue.registerAgent(entry.identity);
        entry.job=await queue.createJob({sourceStoreId:"source",sourceBatchId:"batch",targetStoreId:entry.identity.storeId,targetStoreName:entry.identity.storeName,spuIds:[product.spuId],requireOnline:true,directCreate:true,complianceVersion:"V2.0"});
        entry.item=(await queue.claimJobs({...entry.identity,claimManualUploads:true,manualUploadsOnly:true})).claimed[0];
        await queue.reportProgress({...entry.identity,jobId:entry.job.id,spuId:product.spuId,claimToken:entry.item.claimToken,status:"received"});
    });
    await db.query("maintenance","CREATE TABLE benchmark_numbers(n INT PRIMARY KEY)");
    for(let offset=0;offset<5000;offset+=500)await db.query("maintenance","INSERT INTO benchmark_numbers(n) VALUES ?",[Array.from({length:500},(_,n)=>[offset+n])]);
    // 历史任务只用于测试百万行索引和统计，执行正文不伪装成真实采集包。
    await db.query("maintenance",`INSERT INTO hub_jobs(id,source_store,target_store,created_at,updated_at,status,record_group,body,summary)
        SELECT CONCAT('history-',id),source_store,target_store,created_at,updated_at,'uploaded','done',
        JSON_OBJECT('id',CONCAT('history-',id),'sourceStoreId',source_store,'targetStoreId',target_store,'status','uploaded','createdAt',created_at,'updatedAt',updated_at),
        JSON_OBJECT('id',CONCAT('history-',id),'sourceStoreId',source_store,'targetStoreId',target_store,'status','uploaded','counts',JSON_OBJECT('total',5000,'uploaded',5000),'items',JSON_ARRAY()) FROM hub_jobs`);
    await db.query("maintenance",`INSERT INTO hub_job_items(job_id,spu_id,position,status,direct_state,updated_at,body)
        SELECT j.id,CAST(9000000000+n.n AS CHAR),n.n,'uploaded','created',j.updated_at,
        JSON_OBJECT('spuId',CAST(9000000000+n.n AS CHAR),'title',CONCAT('历史商品 ',n.n),'status','uploaded','directState','created')
        FROM hub_jobs j CROSS JOIN benchmark_numbers n WHERE j.id LIKE 'history-%'`);
    // 直接生成历史行必须同时建立写路径正常维护的统计投影；这部分属于准备成本，不计页面耗时。
    await db.query("maintenance",`INSERT INTO hub_job_daily(job_id,day,uploaded,attention)
        SELECT id,DATE_FORMAT(DATE_ADD(CAST(REPLACE(LEFT(updated_at,19),'T',' ') AS DATETIME),INTERVAL 8 HOUR),'%Y-%m-%d'),5000,0 FROM hub_jobs WHERE id LIKE 'history-%'`);
    await db.query("maintenance",`INSERT INTO hub_product_rank(pair_key,spu_id,source_store,target_store,title,total)
        SELECT 'global',CAST(9000000000+n AS CHAR),'','',CONCAT('历史商品 ',n),200 FROM benchmark_numbers`);
    await db.query("maintenance",`INSERT INTO hub_product_rank(pair_key,spu_id,source_store,target_store,title,total)
        SELECT SHA2(CONCAT(j.source_store,':',j.target_store),256),CAST(9000000000+n.n AS CHAR),j.source_store,j.target_store,CONCAT('历史商品 ',n.n),1
        FROM hub_jobs j CROSS JOIN benchmark_numbers n WHERE j.id LIKE 'history-%'`);
    results.seedSeconds=(performance.now()-seedStart)/1000;
    const [[count]]=await db.query("query","SELECT COUNT(*) AS n FROM hub_job_items");
    assert.equal(Number(count.n),1000200);
    await bounded(cases,8,entry=>queue.registerAgent(entry.identity));
    const runStart=performance.now();
    await bounded(cases,8,async(entry,index)=>{
        const request={...entry.identity,jobId:entry.job.id,spuId:product.spuId,claimToken:entry.item.claimToken,phase:"begin",requestHash:"b".repeat(64),authorizationKey:`load-authorization-${index}-stable`};
        const begun=await measure("feedback",()=>queue.directProgress(request));
        await measure("heartbeat",()=>queue.registerAgent(entry.identity));
        await measure("feedback",()=>queue.directProgress({...request,phase:"created",attemptId:begun.attemptId,productId:String(8800000000+index),verified:true}));
        if(index%10===0){
            const page=await measure("page",()=>queue.listJobsPage({limit:20,offset:index,includeAgents:false}));
            assert.equal(page.total,400);
            await measure("live",()=>queue.liveSignature(new Set([entry.identity.storeId])));
        }
    });
    results.runSeconds=(performance.now()-runStart)/1000;
    const dashboardStart=performance.now();
    const dashboard=await queue.listDashboard({});
    results.dashboardMs=performance.now()-dashboardStart;
    assert.equal(dashboard.todaySent,1000200);
    for(const [kind,values] of Object.entries(samples)){
        values.sort((a,b)=>a-b);
        results[kind]={samples:values.length,p95Ms:values[Math.ceil(values.length*.95)-1],maxMs:values.at(-1)};
    }
    results.nodeRssMiB=process.memoryUsage().rss/1024/1024;
    results.errors=0;
    results.completedSimulatedSubmissions=200;
    await mkdir("test-artifacts",{recursive:true});
    const output=`test-artifacts/mysql-load-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;
    await writeFile(output,JSON.stringify(results,null,2));
    console.log(JSON.stringify({output,...results}));
}finally{
    await db.close();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
}
