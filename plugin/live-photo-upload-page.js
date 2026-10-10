/** 实拍图附件只在独立实拍图页面使用其官方 SDK，不下载执行脚本、不打开系统文件选择器。 */
(() => {
    'use strict';
    const states = new Map();
    async function run(operation, payload) {
        const binding = window.__temuLivePhotoUploadBinding;
        const assertCurrent = () => {
            if (location.origin + location.pathname !== 'https://agentseller.temu.com/govern/compliant-live-photos'
                || !binding || binding.token !== payload.photoToken || binding.stopped && operation !== 'status' || binding.mallId !== payload.mallId) throw Error('实拍图执行页或轮次已变化');
        };
        assertCurrent();
        let runtime;
        window.webpackChunkbgb_sc_govern?.push([[crypto.randomUUID()], {}, value => { runtime = value; }]);
        const moduleFor = predicate => {
            const matches = Object.entries(runtime?.m || {}).filter(([, factory]) => predicate(String(factory)));
            if (matches.length !== 1) throw Error('实拍图官方页面模块不兼容');
            return runtime(matches[0][0]);
        };
        const identity = moduleFor(source => source.includes('agentseller-mall-info-id') && source.includes('getItem') && source.includes('vx:'));
        const assertMall = () => {
            assertCurrent();
            if (typeof identity.vx !== 'function' || String(identity.vx()) !== payload.mallId) throw Error('目标商城身份变化，未上传实拍图');
        };
        assertMall();
        if (operation === 'status') return states.get(payload.attemptId) || { state: 'unknown', reason: '实拍图附件结果已丢失，未重发' };
        if (operation !== 'photo-upload' || !payload.attemptId || states.has(payload.attemptId)) throw Error('禁止重复或未知实拍图附件写入');
        const sdk = moduleFor(source => source.includes('PUBLIC_C_US') && source.includes('uploadImage=function') && source.includes('setSignature=function'));
        const client = moduleFor(source => source.includes('govern_verify_auth_token') && source.includes('anti-content') && source.includes('Mallid')).Z;
        if (typeof client?.post !== 'function' || typeof sdk.ZP !== 'function' || sdk.cJ?.PUBLIC_C_US !== 1) throw Error('实拍图 SDK 或客户端导出变化');
        const asset = payload.asset;
        if (!asset || !['image/jpeg', 'image/png'].includes(asset.mimeType) || !Number.isSafeInteger(asset.bytes)
            || asset.bytes <= 0 || asset.bytes > 3 * 1024 * 1024) throw Error('实拍图格式或大小不符合平台要求');
        const bytes = Uint8Array.from(atob(asset.dataBase64), char => char.charCodeAt(0));
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (bytes.byteLength !== asset.bytes || hash !== asset.sha256) throw Error('实拍图归档哈希校验失败');
        const uploaderClient = new sdk.ZP();
        const methods = ['setScene', 'isProduct', 'setTag', 'setTimeout', 'setUploadHost', 'setMaxRetryCount', 'init', 'uploadImage'];
        if (methods.some(method => typeof uploaderClient[method] !== 'function')) throw Error('实拍图 SDK 方法变化，未上传');
        uploaderClient.setScene(sdk.cJ.PUBLIC_C_US).isProduct(true).setTag('flash-tag').setTimeout(60000)
            .setUploadHost(location.host).setMaxRetryCount(0).init();
        const uploader = uploaderClient.uploadImage();
        if (['setSignature', 'setData', 'build'].some(method => typeof uploader?.[method] !== 'function')) throw Error('实拍图上传器不兼容');
        assertMall();
        const raw = await client.post('/ms/bg-flux-ms/compliance_property/signature', { tag: 'flash-tag' });
        const signature = typeof raw === 'string' ? raw : typeof raw?.result === 'string' ? raw.result : raw?.signature || raw?.result?.signature;
        if (typeof signature !== 'string' || !signature) throw Error('实拍图签名未确认');
        assertMall();
        states.set(payload.attemptId, { state: 'submitting' });
        // 签名仅用于本次上传，不落盘；平台不明响应保留未知，零自动重试。
        void uploader.setSignature(signature).setData(new File([bytes], asset.name, { type: asset.mimeType })).build().then(result => {
            if (!/^https:\/\//.test(result?.url || '') || !Number.isSafeInteger(result.imageInfo?.width) || !Number.isSafeInteger(result.imageInfo?.height)
                || result.imageInfo.width <= 0 || result.imageInfo.height <= 0 || result.imageInfo.width > 8000 || result.imageInfo.height > 8000) throw Error('实拍图地址或尺寸未确认');
            states.set(payload.attemptId, { state: 'uploaded', url: result.url });
        }).catch(error => states.set(payload.attemptId, { state: 'unknown', reason: `实拍图附件结果待核对：${String(error?.errorMsg || error?.message || error).slice(0, 500)}` }));
        return { state: 'submitting' };
    }
    window.__temuLivePhotoUploadPage ||= { run };
})();
