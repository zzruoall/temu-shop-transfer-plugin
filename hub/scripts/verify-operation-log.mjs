import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

// 使用隔离内存存储验证脱敏、队列、容量、重启与失败；不读取真实店铺凭证或改正式插件数据。
const loggerCode = await readFile(new URL("../../plugin/operation-log.js", import.meta.url), "utf8");
const data = {};
const sessionData = {};
const session = { async get(key) { return structuredClone({ [key]: sessionData[key] }); }, async set(values) { Object.assign(sessionData, structuredClone(values)); } };
let failWrites = false;
const local = {
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(values) { if (failWrites) throw new Error("quota"); Object.assign(data, structuredClone(values)); }
};
function logger() {
    const context = vm.createContext({ chrome: { storage: { local, session } }, URL, TextEncoder });
    vm.runInContext(loggerCode, context);
    return context.TemuOperationLog;
}
const log = logger();
await log.append({ action: "test", status: "failed", token: "secretValue", payload: { title: "private-product" },
    pageUrl: "https://user:password@example.com/goods/list?token=secretValue#secretValue",
    endpoint: "http://localhost:18380/api/ingest?token=secretValue", error: 'token=secretValue Bearer secretValue email@example.com',
    storeId: "123", tokenPresent: false });
const serialized = JSON.stringify(await log.read());
for (const value of ["secretValue", "private-product", "user:password", "email@example.com"]) assert.ok(!serialized.includes(value), value);
await Promise.all(Array.from({ length: 30 }, (_, i) => log.append({ action: `event-${i}`, status: "succeeded" })));
assert.equal((await log.read()).entries.length, 31);
assert.equal((await logger().read()).entries.length, 31, "重启保留日志");
await Promise.all(Array.from({ length: 1480 }, () => log.append({ action: "bounded", status: "changed" })));
assert.equal((await log.read()).entries.length, 1500);
assert.equal((await log.read()).dropped, 11);
failWrites = true;
await log.append({ action: "write-fails" });
assert.equal((await log.read()).writeError, "operation_log_storage_write_failed");
assert.equal((await logger().read()).writeError, "operation_log_storage_write_failed", "备用错误跨工作线程重启保留");
assert.ok(!(JSON.stringify(log.clean({ error: "Cookie: session=abc; otherSession=short-secret", reason: "password=hello world" }))).includes("short-secret"));
assert.ok(!(JSON.stringify(log.clean({ reason: "password=hello world" }))).includes("world"));
failWrites = false;

// 运行真实后台消息边界，确认失败回执及无令牌配置进入导出，而非只验证语法。
let receive;
const bg = vm.createContext({ URL, URLSearchParams, TextEncoder, AbortController, setTimeout, clearTimeout, console,
    importScripts() {}, fetch: async () => { throw new TypeError("Failed to fetch"); },
    chrome: { runtime: { id: "test-extension", getManifest: () => ({ version: "10.5.1" }), onMessage: { addListener(fn) { receive = fn; } } },
        storage: { local }, tabs: { onRemoved: { addListener() {} } }, permissions: { contains: async () => false } } });
vm.runInContext(loggerCode, bg);
const background = await readFile(new URL("../../plugin/background.js", import.meta.url), "utf8");
vm.runInContext(background.split("chrome.runtime.onMessage.addListener")[0], bg);
// 测试后台消息边界；真实 directIdentity 在隔离 VM 中不可用时同样必须进入失败回执和操作日志。
vm.runInContext(`enqueuePendingIngest = async () => {}; getIngestSettings = async () => ({endpoint:'http://127.0.0.1:18380/api/ingest',token:''}); getBoundStore = async () => ({storeId:'123'}); getTargetUploadTasks = async () => [];`, bg);
vm.runInContext("chrome.runtime.onMessage.addListener" + background.split("chrome.runtime.onMessage.addListener")[1], bg);
const message = input => new Promise(resolve => receive(input, { id: "test-extension", tab: { id: 7, url: "https://agentseller.temu.com/goods/list" } }, resolve));
assert.equal((await message({ type: "registerStoreAgent", identity: { storeId: "123" } })).ok, false);
assert.ok((await bg.TemuOperationLog.read()).entries.some(item => item.action === "registerStoreAgent" && item.status === "failed" && item.error));
await assert.rejects(() => bg.diagnosticFetch("http://127.0.0.1:18380/api/ingest-info"));
assert.ok((await bg.TemuOperationLog.read()).entries.some(item => item.action === "hub-http" && item.status === "failed"));
const exported = await message({ type: "getCaptureLogs" });
assert.equal(exported.ok, true);
assert.equal(exported.diagnosticState.tokenPresent, false);
assert.equal(exported.diagnosticState.taskCount, 0);
assert.ok(exported.operationLog.entries.length);
console.log("操作日志：脱敏、串行写入、容量裁剪、重启、配额失败提示、真实后台失败回执与导出通过");
