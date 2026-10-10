/** 只复用商品页已加载的官方客户端与文件 SDK，不动态执行下载脚本，也不接触云仓令牌。 */
(() => {
    'use strict';
    const states = new Map();
    const text = error => String(error?.errorMsg || error?.errorMessage || error?.message || error || '资质接口失败').slice(0, 1000);
    async function run(operation, payload) {
        if (location.origin + location.pathname !== 'https://agentseller.temu.com/goods/list') throw Error('执行页已离开商品列表');
        if (window.__temuExecutionRound?.id !== payload.executionRunId || window.__temuExecutionRound.stopped) throw Error('本轮已停止，未执行资质操作');
        let runtime;
        window.chunkLoadingGlobal_temu_sca_goods?.push([[crypto.randomUUID()], {}, value => { runtime = value; }]);
        const clients = Object.entries(runtime?.m || {}).filter(([, fn]) => {
            const source = String(fn).replace(/\s+/g, '');
            return source.includes('getMallIdAsync') && source.includes('.postWithoutMallId=') && source.includes('.mallIdClient=');
        });
        if (clients.length !== 1) throw Error('资质客户端结构不兼容');
        const client = runtime(clients[0][0]);
        const assertMall = async () => {
            if (String(await client.mallIdClient.getMallIdAsync()) !== payload.mallId) throw Error('目标商城身份变化');
            if (window.__temuExecutionRound?.id !== payload.executionRunId || window.__temuExecutionRound.stopped) throw Error('本轮已停止，未提交资质');
        };
        await assertMall();
        if (operation === 'read') return (await TemuQualificationReader.readSnapshot(client, {
            spuId: payload.productId, mallId: payload.mallId, assertCurrent: assertMall,
            post: async (path, body, timeout) => {
                let timer;
                try { return await Promise.race([client.post(path, body), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('目标资质读取超时')), timeout); })]); }
                finally { clearTimeout(timer); }
            }
        })).snapshot;
        if (operation === 'status') return states.get(payload.attemptId) || { state: 'unknown', reason: '资质结果已丢失，未自动重发' };
        if (!payload.attemptId || states.has(payload.attemptId)) throw Error('禁止重复资质写入');
        if (operation === 'upload') {
            const sdkMatches = Object.entries(runtime.m).filter(([, fn]) => {
                const source = String(fn);
                return source.includes('PUBLIC_C') && source.includes('uploadFile=function') && source.includes('setSignature=function');
            });
            if (sdkMatches.length !== 1) throw Error('平台文件 SDK 不兼容，未上传');
            const sdk = runtime(sdkMatches[0][0]);
            // 此兼容范围已从商品页核对；导出改名时拒绝写入，不能随意实例化同名 SDK。
            if (typeof sdk.Ay !== 'function' || sdk.ju?.PUBLIC_C !== 27) throw Error('平台文件 SDK 导出变化');
            const bytes = Uint8Array.from(atob(payload.asset.dataBase64), char => char.charCodeAt(0));
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
            if (bytes.byteLength !== payload.asset.bytes || hash !== payload.asset.sha256) throw Error('归档附件校验失败');
            const raw = await client.post('/ms/bg-flux-ms/compliance_property/signature', { tag: 'product-cert-private-tag' });
            const signature = typeof raw === 'string' ? raw : typeof raw?.result === 'string' ? raw.result : raw?.result?.signature || raw?.signature;
            if (typeof signature !== 'string' || !signature) throw Error('资质附件签名结构未确认');
            const uploadClient = new sdk.Ay().setScene(sdk.ju.PUBLIC_C).isProduct(true).setTag('product-cert-private-tag')
                .setUploadHost(location.host).setSignatureHost(location.host).setTimeout(30000).setRetryCount(0).init();
            const asset = payload.asset;
            const file = new File([bytes], asset.name, { type: asset.mimeType });
            const uploader = asset.mimeType.startsWith('image/') ? uploadClient.uploadImage() : uploadClient.uploadFile().setContentType(asset.mimeType)
                .setContentDisposition(`inline; filename="qualification.pdf"; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
            await assertMall();
            states.set(payload.attemptId, { state: 'submitting' });
            void uploader.setSignature(signature).setUrlSign(1).setData(file).build().then(result => {
                const url = TemuQualificationReader.normalizeKeys(result)?.url;
                if (!url || !/^https:\/\//.test(url)) throw Error('目标文件上传未返回链接');
                states.set(payload.attemptId, { state: 'uploaded', url });
            }).catch(error => { states.set(payload.attemptId, { state: 'failed', reason: text(error) }); });
            return { state: 'submitting' };
        }
        if (operation === 'submit') {
            if (String(payload.request?.productId) !== payload.productId || payload.request?.productCatCertReqList?.length !== 1) throw Error('目标资质提交归属无效');
            // 后台保存期间人工可能提交过资质；在页面真正发请求前再核对缺失状态和模板，不覆盖已有内容。
            const latest = await run('read', payload);
            const certType = Number(payload.request.productCatCertReqList[0].certType);
            const current = latest.items?.find(item => item.certType === certType);
            if (latest.status !== 'complete' || !current) throw Error('发出前目标资质未确认');
            const status = Number(current.summary?.uploadStatus);
            if ([2, 4].includes(status)) return { state: 'existing', reason: '发出前目标已有已提交资质，未覆盖' };
            if (status !== 1) throw Error('发出前目标资质不是缺失状态，未覆盖');
            const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
                ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
            if (!payload.expectedTargetDetail || JSON.stringify(stable(current.detail)) !== JSON.stringify(stable(payload.expectedTargetDetail))) throw Error('发出前目标资质模板已变化，未提交');
            await assertMall();
            states.set(payload.attemptId, { state: 'submitting' });
            // 只发一次；后台等待超时后保留未知，绝不因为收不到结果重新提交。
            void client.post('/bg-lich-mms/cert/product/upload', payload.request).then(raw => {
                const result = raw && TemuQualificationReader.normalizeKeys(raw);
                if (!result || !(result.success === true || Number(result.errorCode) === 1000000) || result.errorMsg || result.errorMessage
                    || result.errorCode && ![0, 1000000].includes(Number(result.errorCode))) throw result || Error('资质提交响应为空');
                states.set(payload.attemptId, { state: 'submitted' });
            }).catch(error => {
                const code = Number(error?.errorCode);
                const definitive = error?.success === false && Number.isFinite(code) && ![1000001, 1000002, 1000004, 1000005, 429, 500, 502, 503, 504].includes(code);
                states.set(payload.attemptId, { state: definitive ? 'rejected' : 'unknown', reason: text(error) });
            });
            return { state: 'submitting' };
        }
        throw Error('未知资质操作');
    }
    window.__temuQualificationPage ||= { run };
})();
