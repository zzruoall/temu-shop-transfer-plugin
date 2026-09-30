import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { openMysqlDatabase } from "../lib/mysql-database.mjs";
import { initializeMysqlSchema } from "../lib/mysql-schema.mjs";
import { createStore } from "../lib/store.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";
import { createSchedulingController } from "../lib/scheduling.mjs";
import { createStoreOwnership } from "../lib/store-ownership.mjs";

// 固定隔离端口与随机数据库名，不读取正式配置、不接触真实平台或线上库存。
const admin = await mysql.createConnection({host:"127.0.0.1",port:33917,user:"root"});
const name = `temu_test_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root = await mkdtemp(path.join(tmpdir(), "temu-mysql-test-"));
const config = path.join(root,"mysql.json");
await writeFile(config, JSON.stringify({host:"127.0.0.1",port:33917,user:"root",database:name}));
const db = await openMysqlDatabase(config);
let success = false;
try {
    await initializeMysqlSchema(db);
    const store = createStore(root,{database:db});
    await store.ensure();
    for (let n=0;n<12;n++) await store.importFiles([{originalName:`item-${n}.json`,payload:{
        kind:"full-capture-packet",source:{sourceStoreId:`source-${n%2}`},
        records:[{payload:{result:{pageItems:[{productId:8000000000+n,goodsId:9000000000+n,productName:`商品-${n}`} ]}}}]
    }}],{sourceStoreId:`source-${n%2}`});
    const page = await store.listOverviewPage(null,new URL("http://local/?productLimit=5&productOffset=5"));
    assert.equal(page.productCount,12);
    assert.equal(page.products.length,5);
    assert.equal((await store.listOverviewPage(new Set(),new URL("http://local/?productLimit=20"))).productCount,0);
    assert.equal((await store.listOverviewPage(new Set(["source-0"]),new URL("http://local/?productLimit=20"))).productCount,6);
    assert.ok(await store.getProduct("8000000000"));
    const ownership = createStoreOwnership(root,{database:db});
    const races = await Promise.allSettled([ownership.claim("s",{id:"a",username:"a"}),ownership.claim("s",{id:"b",username:"b"})]);
    assert.equal(races.filter(r=>r.status==="fulfilled").length,1);
    // 直推来源必须带可核对身份的原始资料对象，否则会被传输校验拦下。
    const products=Array.from({length:3},(_,n)=>({spuId:String(9100000000+n),ready:true,title:"固定快照",images:["https://invalid/a"],skuIds:["1"],skcIds:["2"],publicationData:{sourceProduct:{productId:String(9100000000+n)}}}));
    // 直推下发前服务端要核对来源原包；桩只做一致性透传，真实校验由传输完整性用例覆盖。
    const fakeStore={getBatch:async()=>({sourceStoreId:"source",products}),listOverview:async()=>({products:[]}),verifyBatchTransfer:async(_b,items)=>items};
    // 本用例核对"没有全局3店上限"：显式给调度器 8 个名额，让 8 家店都能开始。
    // 不给调度器时会落回默认 limit=4，那是调度配额，不是旧的全局3店硬限制。
    const scheduling=createSchedulingController({ initial: 8, max: 8 });
    const queue=createJobQueue(root,fakeStore,{database:db,scheduler:scheduling});
    const queue2=createJobQueue(root,fakeStore,{database:db,scheduler:scheduling});
    const cases=[];
    for(let n=0;n<8;n++) {
        const identity={storeId:`temu:${700000+n}`,mallId:String(700000+n),executionMode:"plugin-api",storeName:`Target ${n}`,pageStoreName:`Target ${n}`,pluginInstanceId:`instance-${n}`,pluginVersion:"10.10.61",schedulingProtocol:1,pluginDetected:true,identityMatched:true};
        await queue.registerAgent(identity);
        const job=await queue.createJob({sourceStoreId:"source",sourceBatchId:"batch",targetStoreId:identity.storeId,targetStoreName:identity.storeName,spuIds:products.map(p=>p.spuId),requireOnline:true,directCreate:true,complianceVersion:"V2.0"});
        const claimed=(await queue.claimJobs({...identity,claimManualUploads:true})).claimed;
        assert.equal(claimed.length,3);
        assert.equal(claimed[0].snapshot.title,"固定快照");
        // 现行协议要求插件回传实际落盘快照的摘要，服务端才认可送达。
        for(const item of claimed) await queue.reportProgress({...identity,jobId:job.id,spuId:item.spuId,claimToken:item.claimToken,status:"received",snapshotSha256:item.transferIntegrity.sha256});
        cases.push({identity,job,claimed});
    }
    const begin=(entry,index=0)=>({...entry.identity,jobId:entry.job.id,spuId:entry.claimed[index].spuId,claimToken:entry.claimed[index].claimToken,phase:"begin",requestHash:"a".repeat(64),authorizationKey:`authorization-${entry.identity.mallId}-${index}`});
    // 八家店必须能同时开始，证明不存在旧的全局 3 店上限（名额由调度器配置决定）。
    const started=await Promise.all(cases.map(entry=>queue.directProgress(begin(entry))));
    assert.equal(started.filter(r=>r.attemptId).length,8,'八家店都必须能同时开始');
    // 新协议插件的等待是调度状态而不是失败：同店第二件应返回 waiting 且原因是本店等待，
    // 不抛错、不标红，插件稍后自动继续。
    { const waiting=await queue2.directProgress(begin(cases[0],1));
      assert.equal(waiting.state,'waiting','同店第二件应进入等待而不是被拒绝');
      assert.equal(waiting.scheduling.reasonCode,'store_execution_wait','等待原因必须是本店上一件结果核对'); }
    await queue.directProgress({...begin(cases[0]),phase:"unknown",attemptId:started[0].attemptId,reason:"隔离模拟网络超时"});
    // 结果未知仍占用本店执行位，第二件继续等待，不会被放行成第二次提交。
    { const waiting2=await queue2.directProgress(begin(cases[0],1));
      assert.equal(waiting2.state,'waiting','结果未知期间同店第二件必须继续等待'); }
    await assert.rejects(queue.directProgress({...begin(cases[0]),claimToken:"forged"}),/身份或授权/);
    const receipt={...begin(cases[0]),phase:"created",attemptId:started[0].attemptId,productId:"8888888888",verified:true};
    await queue.directProgress(receipt);
    await queue2.directProgress(receipt);
    assert.ok((await queue2.directProgress(begin(cases[0],1))).attemptId);
    const [[payloadCount]]=await db.query("query","SELECT COUNT(*) AS n FROM hub_task_payloads");
    assert.equal(Number(payloadCount.n),3);
    const jobsPage=await queue.listJobsPage({scope:new Set([cases[0].identity.storeId]),limit:20});
    assert.equal(jobsPage.total,1);
    assert.equal(jobsPage.jobs[0].items[0].snapshot,undefined);
    assert.equal((await queue.listJobsPage({scope:new Set(),limit:20})).total,0);
    assert.equal((await queue.listDashboard({})).todaySent,24);
    const oldSignature=await queue.liveSignature(null);
    await queue.registerAgent(cases[0].identity);
    const newSignature=await queue.liveSignature(null);
    assert.equal(oldSignature.agents,newSignature.agents);
    assert.equal(oldSignature.jobs,newSignature.jobs);
    assert.ok((await queue.listActivity()).entries.length>0);
    products[0].title="不能改变旧快照";
    const [[snapshot]]=await db.query("query","SELECT COUNT(*) AS n FROM hub_job_items WHERE snapshot_id IS NOT NULL");
    assert.equal(Number(snapshot.n),24);
    // 删除店铺同时清理 SQL 日志和汇总，重复回执不能让删除后的发送计数残留。
    const impact=await queue.storeRecordImpact(cases[0].identity.storeId);
    assert.equal(impact.jobCount,1);
    assert.ok(impact.logCount>0);
    await queue.deleteStoreRecord(cases[0].identity.storeId);
    assert.deepEqual(await queue.storeRecordImpact(cases[0].identity.storeId),{storeId:cases[0].identity.storeId,jobCount:0,agentCount:0,logCount:0});
    assert.equal((await queue.listDashboard({})).todaySent,21);
    success=true;
    console.log(JSON.stringify({passed:true,inventory:12,stores:8,simultaneousPermits:8,immutablePayloads:3,taskItems:24,sourceScope:true,unknownBlocksOwnStore:true,repeatedReceiptSafe:true}));
} finally {
    await db.close();
    if(success) await admin.query(`DROP DATABASE ${name}`);
    else console.error(`保留隔离失败库用于诊断: ${name}`);
    await admin.end();
}
