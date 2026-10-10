/** 列表页只读详情桥：复用网站当前登录客户端，不构造认证头、不开放任意接口调用。 */
(function installApiReader() {
    "use strict";
    const SOURCE = "temu-shop-transfer-api-v1";
    if (window.__temuApiReaderInstalled) return;
    window.__temuApiReaderInstalled = true;
    let busy = false;
    let session = null;
    let activeArchive = null;
    // 文档离开时只取消可中断的附件读取；网站客户端查询的不明结果保护仍按原生命周期执行。
    window.addEventListener("pagehide", () => activeArchive?.controller.abort());
    // 超时只结束等待，不代表网页底层请求取消；本页必须刷新后才能重新查询，防止实际并发叠加。
    let queryUncertain = false;

    /** 只读查询统一超时边界；刷新之前不把尚未返回的请求当成空闲资源。 */
    async function boundedPost(client, url, input, timeoutMs = 15000) {
        let timer;
        try {
            return await Promise.race([
                client.post(url, input),
                new Promise((_, reject) => { timer = setTimeout(() => {
                    queryUncertain = true;
                    reject(Object.assign(new Error("资质查询超时，请刷新店铺页面后重试"), { stopBatch: true }));
                }, timeoutMs); })
            ]);
        } finally { clearTimeout(timer); }
    }

    /** 动态识别当前网页客户端，模块号随发布变化；发现多个候选或签名改变时拒绝猜测。 */
    function resolveClient() {
        const chunks = window.chunkLoadingGlobal_temu_sca_goods;
        if (!Array.isArray(chunks)) throw new Error("商品页面尚未加载查询客户端，请刷新后重试");
        let runtime;
        chunks.push([[`temu-read-${crypto.randomUUID()}`], {}, value => { runtime = value; }]);
        const candidates = Object.entries(runtime?.m || {}).filter(([, factory]) => {
            const source = String(factory).replace(/\s+/g, "");
            return source.includes("getMallIdAsync") && source.includes(".postWithoutMallId=") && source.includes(".mallIdClient=");
        });
        if (candidates.length !== 1) throw new Error("网站查询客户端已变化，请导出日志；未使用普通请求替代");
        const client = runtime(candidates[0][0]);
        if (typeof client?.post !== "function" || typeof client?.mallIdClient?.getMallIdAsync !== "function") throw new Error("查询客户端不兼容");
        return client;
    }

    // 页面消息只能查询明确数字SPU；后台还会核验用户启用状态、队列批次和当前商品。
    window.addEventListener("message", async event => {
        const message = event.data;
        // 取消只能命中正在读取的同批次、同商品、同请求；旧回合消息不能中断下一件附件。
        if (event.source === window && event.origin === location.origin && message?.source === SOURCE && message.kind === "cancel-archive") {
            if (activeArchive && message.requestId === activeArchive.requestId && message.runId === activeArchive.runId && message.spuId === activeArchive.spuId) activeArchive.controller.abort();
            return;
        }
        // 删除状态查询：只按当前页商品自己的 SKC ID 取行，不按货号检索整店，也不读取店铺其他商品。
        if (event.source === window && event.origin === location.origin && message?.source === SOURCE && message.kind === "removal") {
            const requestId = message.requestId;
            if (!/^[a-zA-Z0-9-]{1,80}$/.test(requestId || "")) return;
            const skcIds = Array.isArray(message.skcIds)
                ? [...new Set(message.skcIds.map(value => String(value || "").trim()).filter(value => /^\d{6,20}$/.test(value)))].slice(0, 200)
                : [];
            const reply = data => window.postMessage({ source: SOURCE, kind: "removal-result", requestId, runId: message.runId, ...data }, location.origin);
            if (!skcIds.length) { reply({ error: "当前页没有可核验的 SKC ID" }); return; }
            if (busy || queryUncertain) { reply({ error: queryUncertain ? "上一条查询结果未确认，请刷新店铺页面" : "上一条查询仍在进行，请稍后重新采集" }); return; }
            busy = true;
            let timer;
            try {
                if (location.hostname !== "agentseller.temu.com" || location.pathname !== "/goods/list") throw new Error("目前仅支持已验证的 agentseller 商品列表页");
                const client = resolveClient();
                const mallId = String(await client.mallIdClient.getMallIdAsync());
                if (mallId === "-1" || mallId === "null") throw new Error("未确认当前店铺登录身份");
                const payload = await Promise.race([
                    client.post("/visage-agent-seller/product/skc/pageQuery", { page: 1, pageSize: skcIds.length, productSkcIds: skcIds }),
                    new Promise((_, reject) => { timer = setTimeout(() => { queryUncertain = true; reject(new Error("删除状态查询超时，请刷新后重新采集")); }, 15000); })
                ]);
                if (payload?.success === false || (payload?.errorCode && payload.errorCode !== 1000000)) throw new Error("删除状态接口返回业务失败");
                const root = payload?.result || payload?.res || payload;
                const rows = Array.isArray(root?.pageItems) ? root.pageItems : null;
                if (!rows) throw new Error("删除状态接口返回结构未知");
                // 只回报本次请求的 SKC 对应的商品；出现请求范围外的行说明过滤未生效，按未知处理而不是标记删除。
                const requested = new Set(skcIds);
                const items = rows
                    .filter(row => requested.has(String(row?.productSkcId || "").trim()))
                    .map(row => {
                        const rawStatus = row?.removeStatus;
                        const removeStatus = rawStatus === 0 || rawStatus === 1
                            ? rawStatus
                            : (typeof rawStatus === "string" && /^[01]$/.test(rawStatus.trim()) ? Number(rawStatus) : null);
                        return { productId: String(row?.productId || "").trim(), productSkcId: String(row?.productSkcId || "").trim(), removeStatus };
                    })
                    .filter(row => /^\d{6,20}$/.test(row.productId));
                if (rows.length && !items.length) throw new Error("删除状态接口未按当前页商品返回结果");
                const returnedSkcIds = new Set(items.map(item => item.productSkcId));
                if (items.some(item => item.removeStatus === null) || items.length !== returnedSkcIds.size || skcIds.some(skcId => !returnedSkcIds.has(skcId))) {
                    throw new Error("删除状态接口未返回当前页全部商品的明确状态");
                }
                reply({ payload: { success: true, items } });
            } catch (error) {
                reply({ error: String(error?.message || "删除状态查询失败").slice(0, 180) });
            } finally { clearTimeout(timer); busy = false; }
            return;
        }
        if (event.source !== window || event.origin !== location.origin || message?.source !== SOURCE || message.kind !== "query") return;
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(message.requestId || "") || !/^\d{6,20}$/.test(message.spuId || "")) return;
        // 结果不明是请求生命周期事实，不让下游根据错误文案中的“超时”猜测是否仍有在途请求。
        const reply = data => window.postMessage({ source: SOURCE, kind: "result", requestId: message.requestId, runId: message.runId, spuId: message.spuId, queryUncertain, ...data }, location.origin);
        if (busy || queryUncertain) { reply({ error: queryUncertain ? "上一条查询结果未确认，请刷新店铺页面" : "上一条查询仍在进行，请稍后重新采集" }); return; }
        busy = true;
        let timer;
        try {
            if (location.hostname !== "agentseller.temu.com" || location.pathname !== "/goods/list") throw new Error("目前仅支持已验证的 agentseller 商品列表页");
            const client = resolveClient();
            const mallId = await client.mallIdClient.getMallIdAsync();
            if (mallId == null || String(mallId) === "-1") throw new Error("未确认当前店铺登录身份");
            if (!session || session.runId !== message.runId) session = { runId: message.runId, mallId: String(mallId), url: location.href };
            if (session.mallId !== String(mallId) || session.url !== location.href) throw new Error("店铺或页面已切换，请重新采集");
            const sourceSession = session;
            let payload;
            // 详情截止时间只覆盖详情请求；资质有各自的截止时间，不能让已成功的详情误锁下一件商品。
            try {
                payload = await Promise.race([
                    client.post("/visage-agent-seller/product/query", { productId: message.spuId }),
                    new Promise((_, reject) => { timer = setTimeout(() => { queryUncertain = true; reject(new Error("详情查询超时，已停止批次，请刷新后重试")); }, 15000); })
                ]);
            } finally { clearTimeout(timer); }
            if (payload?.success === false || (payload?.errorCode && payload.errorCode !== 1000000)) throw new Error("详情接口返回业务失败，未保存；请导出日志检查");
            const product = payload?.result || payload?.res || payload;
            if (String(product?.productId || "") !== message.spuId) throw new Error("详情返回的商品ID不匹配，未保存");
            if (String(await client.mallIdClient.getMallIdAsync()) !== session.mallId || session.url !== location.href) throw new Error("查询期间切换了店铺或页面，未保存");
            if (new TextEncoder().encode(JSON.stringify(product)).byteLength > 8 * 1024 * 1024) throw new Error("单件详情超过安全大小限制");
            // 已核对的合规只读接口可直接复用商品列表客户端；逐件附带读取，不导航也不修改原生筛选。
            // 附件由源页面下载，不经过扩展后台导出登录状态；独立取消不设置 queryUncertain。
            const archiveController = typeof AbortController === "function" ? new AbortController() : null;
            if (archiveController) activeArchive = { controller: archiveController, requestId: message.requestId, runId: message.runId, spuId: message.spuId };
            const qualifications = await TemuQualificationReader.readSnapshot(client, {
                spuId: message.spuId, mallId: sourceSession.mallId, pageOrigin: location.origin,
                post: (url, input, timeoutMs) => boundedPost(client, url, input, timeoutMs),
                fetch: typeof window.fetch === "function" ? window.fetch.bind(window) : undefined,
                signal: archiveController?.signal,
                assertCurrent: async () => {
                    if (session !== sourceSession || String(await client.mallIdClient.getMallIdAsync()) !== sourceSession.mallId || sourceSession.url !== location.href) {
                        throw Object.assign(new Error("资质查询期间切换了店铺或页面，已停止"), { stopBatch: true });
                    }
                }
            });
            if (String(await client.mallIdClient.getMallIdAsync()) !== session.mallId || session.url !== location.href) throw new Error("查询期间切换了店铺或页面，未保存");
            reply({ payload: { success: true, result: product }, qualifications: qualifications.snapshot, stopBatch: qualifications.stopBatch, stopReason: qualifications.stopReason });
        } catch (error) {
            reply({ error: String(error?.message || "网站拒绝详情查询，请检查登录状态后重试").slice(0, 180) });
        } finally {
            clearTimeout(timer);
            activeArchive?.controller.abort();
            activeArchive = null;
            busy = false;
        }
    });
})();
