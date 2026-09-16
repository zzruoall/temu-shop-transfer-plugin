/** 隔离验证 CLI 打开/完成意图不依赖 HTTP，也不会未授权就允许打开。 */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const tasks = [{ jobId: "job", spuId: "12345678", targetStoreId: "store", status: "received" }];
const context = vm.createContext({ importScripts() {}, TextEncoder, URL, console,
    chrome: { storage: { local: { get: async () => ({cliConnectedAt:Date.now()}) } } } });
vm.runInContext(fs.readFileSync(new URL("../../plugin/background.js",import.meta.url),"utf8").split("chrome.runtime.onMessage.addListener")[0],context);
context.testTasks = tasks;
vm.runInContext(`getTargetUploadTasks=async()=>testTasks; saveTargetUploadTasks=async()=>{};
getBoundStore=async()=>({storeId:'store',storeName:'shop'}); boundMatchesPage=()=>true;
reportStoreJob=async()=>{throw Error('HTTP must not be called')};`,context);
const payload = {jobId:"job",spuId:"12345678",storeId:"store",pageStoreName:"shop",identityMatched:true,status:"upload_opened"};
assert.equal((await context.reportTargetUploadTask(payload)).pending,true);
assert.equal(tasks[0].status,"received");
assert.equal(tasks[0].openRequested,true);
await assert.rejects(context.reportTargetUploadTask({...payload,status:"uploaded"}),/not_opened/);
tasks[0].status="upload_opened";
assert.equal((await context.reportTargetUploadTask(payload)).pending,undefined);
assert.equal((await context.reportTargetUploadTask({...payload,status:"uploaded"})).pending,true);
assert.equal(tasks[0].completionRequested,true);
await assert.rejects(context.reportTargetUploadTask({...payload,storeId:"other"}),/store_mismatch/);
console.log("CLI open: intent, authorization, completion and cross-store checks passed");
