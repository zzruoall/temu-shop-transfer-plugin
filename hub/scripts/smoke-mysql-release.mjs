import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { openMysqlDatabase } from "../lib/mysql-database.mjs";

// 切换流量前仅在随机回环端口检查查询链路，不注册插件、不领取或执行真实任务。
const database=await openMysqlDatabase();
assert.ok(database,"缺少 MySQL 配置");
const credentials=process.env.TEMU_CREDENTIALS ? JSON.parse(await readFile(process.env.TEMU_CREDENTIALS,"utf8")) : null;
const watch=await mkdtemp(path.join(tmpdir(),"temu-readonly-smoke-"));
const instanceId=`mysql-smoke-${Date.now()}`;
let child;
try {
    const [[counts]]=await database.query("query",`SELECT (SELECT COUNT(*) FROM hub_products) AS products,
        (SELECT COUNT(*) FROM hub_jobs) AS jobs,(SELECT COUNT(*) FROM hub_job_items) AS items,
        (SELECT COUNT(*) FROM hub_agents) AS agents`);
    child=fork("server.mjs",[],{env:{...process.env,ZINIAO_BIND:"127.0.0.1",ZINIAO_TEST_EPHEMERAL:"1",ZINIAO_INSTANCE_ID:instanceId,ZINIAO_SEED:"0",ZINIAO_WATCH_DIR:watch},stdio:["ignore","ignore","pipe","ipc"],windowsHide:true});
    let stderr="";
    child.stderr.on("data",chunk=>stderr+=chunk);
    const port=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(`启动超时: ${stderr}`)),20000);
        child.once("error",error=>{clearTimeout(timer);reject(error);});
        child.once("exit",code=>{clearTimeout(timer);reject(new Error(`启动退出 ${code}: ${stderr}`));});
        child.on("message",message=>{if(message.type==="listening"&&message.instanceId===instanceId){clearTimeout(timer);resolve(message.port);}});
    });
    const headers=credentials ? {authorization:`Bearer ${credentials.deviceToken}`} : {};
    const paths=["/api/overview?productLimit=20","/api/jobs?limit=20","/api/jobs/dashboard","/api/stores?limit=20","/api/work-log?limit=20","/api/live"];
    for(const endpoint of paths){
        const started=Date.now();
        const response=await fetch(`http://127.0.0.1:${port}${endpoint}`,{headers,signal:AbortSignal.timeout(20000)});
        assert.equal(response.status,200,endpoint);
        const body=await response.json();
        if(endpoint.startsWith("/api/overview"))assert.equal(body.productCount,Number(counts.products));
        if(endpoint.startsWith("/api/jobs?"))assert.equal(body.total,Number(counts.jobs));
        console.log(JSON.stringify({endpoint,status:response.status,ms:Date.now()-started}));
    }
    assert.equal(stderr,"","启动产生错误日志");
    console.log(JSON.stringify({mysqlSmoke:true,counts,realPlatformCalls:0}));
} finally {
    if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill();await exited;}
    await database.close();
}
