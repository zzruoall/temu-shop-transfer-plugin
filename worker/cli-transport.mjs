/** 定向 CLI 传输：无 shell 参数拼接，分块送入指定页面；仅保存任务，不调用发布接口。 */
import { spawn } from "node:child_process";
import path from "node:path";
import { makeCliDelivery } from "../hub/lib/cli-delivery.mjs";
import { unwrapCliData } from "../hub/lib/ziniao-cli.mjs";

export async function execute(storeId, targetId, script) {
    const cli = process.env.ZINIAO_CLI_ENTRY || path.join(process.env.APPDATA || "", "npm/node_modules/@ziniao-open/cli/scripts/run.js");
    const args = [cli, "page", "exec", "--store-id", storeId, "--script", script];
    if (targetId) args.push("--target-id", targetId);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, args, { windowsHide: true, shell: false });
        let output = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("cli_timeout")); }, 20000);
        child.stdout.on("data", chunk => { output += chunk; });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", code => { clearTimeout(timer); try { if (code) throw new Error("cli_failed"); resolve(unwrapCliData(JSON.parse(output))); } catch(error) { reject(error); } });
    });
}

export async function deliverCliTask(options) {
    const { task } = options;
    // 同步与商品投递共用固定窗口核验，空任务只允许传递签名状态摘要。
    const storeId = options.storeId || task?.targetStoreId;
    const context = await execute(storeId, null, "JSON.stringify({origin:location.origin,name:document.getElementById('temu-local-dataset-panel')?.getAttribute('data-page-store-name'),instance:document.getElementById('temu-local-dataset-panel')?.getAttribute('data-plugin-instance-id')})");
    const actual = JSON.parse(context.result);
    if (!context.targetId || actual.name !== options.pageStoreName || actual.instance !== options.pluginInstanceId) throw new Error("cli_page_changed");
    const delivery = makeCliDelivery({ ...options, pageOrigin: actual.origin });
    const key = `__temuTransfer_${delivery.requestId.replaceAll("-", "")}`;
    // 只传数据而不执行动态脚本；首版限制包大小和传输耗时，超限明确拒绝而不冒险丢块。
    const encoded = Buffer.from(delivery.envelope).toString("base64");
    if (encoded.length > 120000) throw new Error("cli_packet_needs_large_transfer");
    const started = Date.now();
    await execute(storeId, context.targetId, `window[${JSON.stringify(key)}]='';setTimeout(()=>delete window[${JSON.stringify(key)}],60000);'ready'`);
    try {
        for (let offset=0; offset<encoded.length; offset+=6000) {
            if (Date.now()-started > 35000) throw new Error("cli_transfer_deadline");
            await execute(storeId, context.targetId, `window[${JSON.stringify(key)}]+=${JSON.stringify(encoded.slice(offset,offset+6000))};'chunk'`);
        }
        const receiptKey = `__temuReceipt_${delivery.requestId.replaceAll("-", "")}`;
        await execute(storeId, context.targetId, `(()=>{const key=${JSON.stringify(receiptKey)};window[key]=null;const listener=e=>{try{const r=JSON.parse(e.detail);if((r.receipt?.requestId||r.requestId)===${JSON.stringify(delivery.requestId)}){window[key]=r;window.removeEventListener('temu-cli-delivery-result',listener);}}catch{}};window.addEventListener('temu-cli-delivery-result',listener);setTimeout(()=>{window.removeEventListener('temu-cli-delivery-result',listener);delete window[key]},60000);window.dispatchEvent(new CustomEvent('temu-cli-delivery',{detail:new TextDecoder().decode(Uint8Array.from(atob(window[${JSON.stringify(key)}]),c=>c.charCodeAt(0)))}));return 'sent'})()`);
        const deadline = Date.now()+18000;
        while (Date.now()<deadline) {
            const result = await execute(storeId, context.targetId, delivery.readScript);
            const value = JSON.parse(result.result || "null");
            if (value) {
                if (!value.ok || value.receipt?.requestId !== delivery.requestId || value.receipt?.storeId !== storeId || (task ? value.receipt?.jobId !== task.jobId || value.receipt?.spuId !== task.spuId || value.receipt?.status !== "received" : value.receipt?.status !== "synced" || !Array.isArray(value.receipt?.tasks))) throw new Error(value.error || "cli_receipt_mismatch");
                return value.receipt;
            }
            await new Promise(resolve => setTimeout(resolve,500));
        }
        throw new Error("cli_receipt_timeout");
    } finally { await execute(storeId, context.targetId, `delete window[${JSON.stringify(key)}]`).catch(()=>{}); }
}
