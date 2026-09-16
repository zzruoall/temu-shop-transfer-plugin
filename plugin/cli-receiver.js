/** CLI 专用接收边界：仅接受本机签名、绑定当前插件实例且未过期的资料包，绝不执行发布命令。 */
const TemuCliReceiver = (() => {
    const publicKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzPbLlK4UTx7OdOi0b/1YbfNi603gI7AlqqY7tHcIxS4DSFNsVjr5zofuFiwXHEPDeVrhYY9Ri9+ttgnYryAm+dahrH8y+DA/XOvHObTW4MFVMUukxriWlTIg+tdMl+or7s/sVPTz5JdFrbbPIJzxl4fa8Qp2hCM4Jy8URrjvbpS56PDFBYx9JwI5Z5Bl4fYWE7vj6NTDYPCT/drfI2ucLC0KPnhCKdkcxtwKUbIBuzsi27opps0ehwxDzjwuUyPEVaVwhDZaPEpWEJoys9A0CJhrtWTtEw+YcVO/gp/bNoqOsNx4j2SWcP/t9X1vdevFeHxyNY88S9ep16lFQxSVdQIDAQAB";
    const bytes = value => Uint8Array.from(atob(value), c => c.charCodeAt(0));
    let busy = false;
    async function receive(envelope, context) {
        if (busy) throw new Error("cli_receiver_busy");
        busy = true;
        try {
            if (typeof envelope?.body !== "string" || envelope.body.length > 2000000 || typeof envelope.signature !== "string" || envelope.signature.length > 1024) throw new Error("cli_invalid_envelope");
            const key = await crypto.subtle.importKey("spki", bytes(publicKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
            if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, bytes(envelope.signature), new TextEncoder().encode(envelope.body))) throw new Error("cli_signature_invalid");
            const payload = JSON.parse(envelope.body);
            if (payload.protocol !== "temu-cli-delivery-v1" || !Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now() || payload.expiresAt > Date.now() + 120000) throw new Error("cli_expired");
            if (payload.pluginInstanceId !== await getPluginInstanceId() || !context.pageStoreName || payload.pageStoreName !== context.pageStoreName || payload.pageOrigin !== context.pageOrigin) throw new Error("cli_identity_mismatch");
            const task = payload.task;
            if (typeof payload.storeId !== "string" || !/^\d{1,30}$/.test(payload.storeId)) throw new Error("cli_store_invalid");
            // 店铺映射只能来自已验签的当前实例资料包，已有异店绑定不得被任务覆盖。
            const bound = await getBoundStore();
            if (bound.storeId && bound.storeId !== payload.storeId) throw new Error("cli_store_conflict");
            // 签名同步只按服务端明确终态清理本店快照，不根据缺失条目猜测取消，也不自动打开页面。
            if (payload.action === "sync") {
                if (!Array.isArray(payload.syncStates) || payload.syncStates.length > 3000) throw new Error("cli_sync_invalid");
                const states = new Map(payload.syncStates.map(item => [`${item.jobId}::${item.spuId}`, item.status]));
                const current = await getTargetUploadTasks();
                // 在清理终态快照前保留接口创建结果，导出日志仍能看到新SPU和失败原因。
                for (const item of current.filter(item=>item.targetStoreId===payload.storeId && item.directCreate)) {
                    const update=payload.syncStates.find(s=>s.jobId===item.jobId&&s.spuId===item.spuId);
                    if(update && update.directState!==item.directState) {
                        item.directState=String(update.directState||"");
                        item.reason=String(update.reason||"").slice(0,1000);
                        await TemuOperationLog.append({action:"direct-create-result",status:update.directState==="created"?"succeeded":"pending",jobId:item.jobId,spuId:item.spuId,reason:item.reason});
                    }
                }
                const next = current.filter(item => item.targetStoreId !== payload.storeId || !["cancelled", "failed", "uploaded", "identity_mismatch", "blocked"].includes(states.get(`${item.jobId}::${item.spuId}`)));
                for (const item of next) {
                    if (item.targetStoreId === payload.storeId && item.openRequested && states.get(`${item.jobId}::${item.spuId}`) === "upload_opened") {
                        item.status = "upload_opened";
                        item.openRequested = false;
                        item.uploadOpenedAt = new Date().toISOString();
                    }
                }
                await saveTargetUploadTasks(next);
                await saveBoundStore({ storeId: payload.storeId, storeName: payload.pageStoreName });
                const scoped = next.filter(item => item.targetStoreId === payload.storeId);
                await chrome.storage.local.set({ cliConnectedAt: Date.now() });
                if (next.length !== current.length || scoped.some(item => item.openRequested || item.completionRequested)) {
                    await TemuOperationLog.append({ action: "cli-task-sync", status: "succeeded", storeId: payload.storeId,
                        taskCount: scoped.length, reason: `已清理 ${current.length - next.length} 个终态任务，操作者请求等待回传` });
                }
                return { requestId: payload.requestId, storeId: payload.storeId, status: "synced",
                    tasks: scoped.map(({ jobId, spuId, status, openRequested, completionRequested }) => ({ jobId, spuId, status, openRequested: Boolean(openRequested), completionRequested: Boolean(completionRequested) })),
                    pendingUploadCount: scoped.length, pendingUploadBytes: new TextEncoder().encode(JSON.stringify(scoped)).length };
            }
            if (!task || !/^\d{6,20}$/.test(task.spuId) || task.targetStoreId !== payload.storeId || !task.jobId || !task.claimToken || String(task.snapshot?.spuId) !== task.spuId) throw new Error("cli_task_invalid");
            // 相同任务只认相同快照；不允许重放时偷偷替换已保存的商品。
            const existing = (await getTargetUploadTasks()).find(t => t.jobId === task.jobId && t.spuId === task.spuId);
            if (existing && (existing.targetStoreId !== task.targetStoreId || JSON.stringify(existing.snapshot) !== JSON.stringify(task.snapshot))) throw new Error("cli_task_conflict");
            // 回执丢失后服务端租约可能刷新；只有同一快照、未打开的任务可接受新的签名凭证。
            if (existing && existing.claimToken !== task.claimToken) {
                if (existing.status !== "received" || existing.openRequested) throw new Error("cli_task_conflict");
                const current = await getTargetUploadTasks();
                const renewed = current.find(item => item.jobId === task.jobId && item.spuId === task.spuId);
                renewed.claimToken = task.claimToken;
                await saveTargetUploadTasks(current);
            }
            await receiveTargetUploadTasks([task], payload.storeId);
            const saved = (await getTargetUploadTasks()).find(t => t.jobId === task.jobId && t.spuId === task.spuId);
            if (!saved) throw new Error("cli_save_failed");
            await saveBoundStore({ storeId: payload.storeId, storeName: payload.pageStoreName });
            await TemuOperationLog.append({ action: "cli-task-received", status: "succeeded", jobId: task.jobId, spuId: task.spuId });
            return { requestId: payload.requestId, jobId: task.jobId, spuId: task.spuId, storeId: payload.storeId, status: "received" };
        } finally { busy = false; }
    }
    return { receive };
})();
