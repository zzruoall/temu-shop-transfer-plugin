/** 在隔离存储中验证签名接收，不领取真实任务、不调用商品接口。 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import assert from "node:assert/strict";
import { sign, webcrypto } from "node:crypto";
const tasks = [];
let boundStore = { storeId: "", storeName: "" };
const context = vm.createContext({ crypto: webcrypto, atob, Uint8Array, TextEncoder, Date,
    chrome: { storage: { local: { set: async () => {} } } },
    saveTargetUploadTasks: async next => { tasks.splice(0,tasks.length,...next); },
    getBoundStore: async () => boundStore,
    saveBoundStore: async value => { boundStore = value; return value; },
    getPluginInstanceId: async () => "test-instance",
    getTargetUploadTasks: async () => tasks,
    receiveTargetUploadTasks: async incoming => { for (const task of incoming) if (!tasks.some(t => t.jobId === task.jobId)) tasks.push(task); },
    TemuOperationLog: { append: async () => {} }
});
vm.runInContext(fs.readFileSync(new URL("../../plugin/cli-receiver.js", import.meta.url), "utf8") + ";globalThis.receiver=TemuCliReceiver;", context);
// 生产签名私钥不随网站项目复制；提供路径时做完整签名回归，否则只报告跳过而不伪造安全结论。
const privateKeyPath = String(process.env.ZINIAO_CLI_PRIVATE_KEY || fileURLToPath(new URL("../../ziniao.pem", import.meta.url))).trim();
if (!fs.existsSync(privateKeyPath)) {
    console.log("CLI receiver: skipped (未提供本地签名私钥，未复制生产密钥)");
    process.exit(0);
}
const privateKey = fs.readFileSync(privateKeyPath);
const payload = { protocol: "temu-cli-delivery-v1", requestId: "test", expiresAt: Date.now()+60000, pluginInstanceId: "test-instance", pageOrigin: "https://agentseller.temu.com", pageStoreName: "test-store", storeId: "12345678", task: { jobId: "test-job", spuId: "87654321", targetStoreId: "12345678", claimToken: "test-token", snapshot: { spuId: "87654321" } } };
const envelope = value => { const body=JSON.stringify(value); return { body, signature: sign("sha256",Buffer.from(body),privateKey).toString("base64") }; };
const scope = { pageOrigin: payload.pageOrigin, pageStoreName: payload.pageStoreName };
assert.equal((await context.receiver.receive(envelope(payload),scope)).status,"received");
await context.receiver.receive(envelope(payload),scope);
assert.equal(tasks.length,1);
assert.equal(boundStore.storeId,payload.storeId);
assert.equal(boundStore.storeName,payload.pageStoreName);
boundStore = { storeId: "99999999", storeName: "other-store" };
await assert.rejects(context.receiver.receive(envelope(payload),scope),/store_conflict/);
assert.equal(boundStore.storeId,"99999999");
boundStore = { storeId: payload.storeId, storeName: payload.pageStoreName };
await assert.rejects(context.receiver.receive(envelope({...payload,pluginInstanceId:"wrong"}),scope),/identity/);
await assert.rejects(context.receiver.receive(envelope({...payload,expiresAt:0}),scope),/expired/);
const invalid=envelope(payload); invalid.body += " ";
await assert.rejects(context.receiver.receive(invalid,scope),/signature/);
// 签名同步必须保留其他店任务，且只有操作者已请求的项目才可反映打开授权。
tasks.push({jobId:"other",spuId:"87654321",targetStoreId:"99999999",status:"received"});
tasks[0].openRequested = true;
const sync = { ...payload, task: undefined, action: "sync", syncStates: [{ jobId: "test-job", spuId: "87654321", status: "upload_opened" }] };
const synced = await context.receiver.receive(envelope(sync),scope);
assert.equal(synced.status,"synced");
assert.equal(tasks[0].status,"upload_opened");
assert.equal(synced.pendingUploadCount,1);
await context.receiver.receive(envelope({...sync,syncStates:[{jobId:"test-job",spuId:"87654321",status:"cancelled"},{jobId:"other",spuId:"87654321",status:"cancelled"}]}),scope);
assert.equal(tasks.length,1);
assert.equal(tasks[0].targetStoreId,"99999999");
console.log("CLI receiver: signature, identity, expiry, duplicate, signed synchronization checks passed");
