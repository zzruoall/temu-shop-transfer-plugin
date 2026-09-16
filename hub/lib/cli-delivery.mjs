/** 本机发送适配：调用者先核验店铺并取得领取租约；只构造签名资料及 CLI 脚本，不自动发布。 */
import { sign, randomUUID } from "node:crypto";
/** 商品投递携带租约；状态同步不带商品正文，两者均把店铺及实例纳入签名。 */
export function makeCliDelivery({ task, storeId = task?.targetStoreId, syncStates, pluginInstanceId, pageStoreName, pageOrigin, privateKey }) {
    if (!storeId || (task && (!task.claimToken || task.targetStoreId !== storeId)) || (!task && !Array.isArray(syncStates)) || !pluginInstanceId || !pageStoreName || pageOrigin !== "https://agentseller.temu.com") throw new Error("cli_delivery_context_missing");
    const requestId = randomUUID();
    const body = JSON.stringify({ protocol: "temu-cli-delivery-v1", requestId, expiresAt: Date.now()+60000,
        pluginInstanceId, pageStoreName, pageOrigin, storeId, ...(task ? { task } : { action: "sync", syncStates }) });
    if (body.length > 2000000) throw new Error("cli_delivery_too_large");
    const envelope = JSON.stringify({ body, signature: sign("sha256", Buffer.from(body), privateKey).toString("base64") });
    // 不把商品正文拼成可执行代码；序列化为字符串，回执只接受当前请求编号。
    const slot = `__temuReceipt_${requestId.replaceAll("-", "")}`;
    // CLI 不等待 Promise：先建立有限生命周期回执槽，再由本机单独轮询读取。
    const script = `(()=>{const key=${JSON.stringify(slot)};window[key]=null;const done=value=>{clearTimeout(timer);window.removeEventListener('temu-cli-delivery-result',listener);window[key]=value;setTimeout(()=>delete window[key],60000);};const listener=e=>{try{const r=JSON.parse(e.detail);if((r.receipt?.requestId||r.requestId)===${JSON.stringify(requestId)})done(r);}catch{}};const timer=setTimeout(()=>done({ok:false,error:'cli_receipt_timeout'}),15000);window.addEventListener('temu-cli-delivery-result',listener);window.dispatchEvent(new CustomEvent('temu-cli-delivery',{detail:${JSON.stringify(envelope)}}));return 'sent';})()`;
    const readScript = `JSON.stringify(window[${JSON.stringify(slot)}]||null)`;
    return { requestId, script, readScript, envelope };
}
