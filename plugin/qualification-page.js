/** 只复用商品页已加载的官方客户端与文件 SDK，不动态执行下载脚本，也不接触云仓令牌。 */
(() => {
    'use strict';
    const states = new Map();
    const text = error => String(error?.errorMsg || error?.errorMessage || error?.message || error || '资质接口失败').slice(0, 1000);
    async function run(operation, payload) {
        if (location.origin + location.pathname !== 'https://agentseller.temu.com/goods/list') throw Error('执行页已离开商品列表');
        if (window.__temuExecutionRound?.id !== payload.executionRunId || window.__temuExecutionRound.stopped && operation !== 'status') throw Error('本轮已停止，未执行资质操作');
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
            // 暂停禁止新增写入，但同一轮已发出附件的结果仍须读取并保存，避免恢复时无回执而重传。
            if (window.__temuExecutionRound?.id !== payload.executionRunId || window.__temuExecutionRound.stopped && operation !== 'status') throw Error('本轮已停止，未提交资质');
        };
        await assertMall();
        /** 实拍图使用独立全托管接口；实际状态和配置一并取回，任何身份变化都阻止后续写入。 */
        const readPhotos = async () => {
            const post = async (path, body) => {
                await assertMall();
                let timer;
                const raw = await Promise.race([client.post(path, body), new Promise((_, reject) => {
                    timer = setTimeout(() => reject(Error('目标实拍图读取超时')), 15000);
                })]).finally(() => clearTimeout(timer));
                await assertMall();
                const value = TemuQualificationReader.normalizeKeys(raw);
                if (!value || value.success === false || value.errorCode && ![0, 1000000].includes(Number(value.errorCode))) throw Error('目标实拍图读取失败');
                return value.result || value.res || value;
            };
            const list = await post(TemuLivePhotoReader.LIST_PATH, { spu_id_list: [payload.productId], page: 1, page_size: 10, page_version: 1 });
            if (list.isSemiManagedMall !== false || list.total !== 1 || list.items?.length !== 1
                || String(list.items[0].spuId) !== payload.productId || list.items[0].newPopUpGray !== true) throw Error('目标实拍图入口尚未生成或不是已核验的新模板');
            const goodsId = TemuQualificationReader.productId(list.items[0].goodsId);
            const detail = await post(TemuLivePhotoReader.DETAIL_PATH, { spu_id: payload.productId, goods_id: goodsId });
            const config = await post(TemuLivePhotoReader.CONFIG_PATH, { spu_id: payload.productId, goods_id: goodsId });
            const product = await post('/visage-agent-seller/product/query', { productId: payload.productId });
            if (String(product.productId) !== payload.productId || !Array.isArray(product.productSkcList)) throw Error('目标实拍图商品详情未确认');
            const skus = product.productSkcList.flatMap(skc => {
                if (!Array.isArray(skc.productSkuList)) throw Error('目标 SKU 列表未确认');
                return skc.productSkuList.map(sku => ({ skuId: TemuQualificationReader.productId(sku.productSkuId ?? sku.skuId),
                    skuExtCode: String(sku.extCode || sku.skuExtCode || '').trim() }));
            });
            return { productId: payload.productId, goodsId, detail, config, skus };
        };
        if (operation === 'photo-read') return readPhotos();
        if (operation === 'read') {
            const result = await TemuQualificationReader.readSnapshot(client, {
            spuId: payload.productId, mallId: payload.mallId, assertCurrent: assertMall, certTypes: payload.certTypes,
            skipExistingDetails: true,
            post: async (path, body, timeout) => {
                let timer;
                try { return await Promise.race([client.post(path, body), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('目标资质读取超时')), timeout); })]); }
                finally { clearTimeout(timer); }
            }
            });
            if (result.stopBatch) throw Error(result.stopReason || '目标资质身份或读取状态失效');
            return result.snapshot;
        }
        if (operation === 'status') return states.get(payload.attemptId) || { state: 'unknown', reason: '资质结果已丢失，未自动重发' };
        if (!payload.attemptId || states.has(payload.attemptId)) throw Error('禁止重复资质写入');
        if (operation === 'photo-upload') throw Error('实拍图附件必须在独立实拍图页面上传');
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
            // 平台 SDK 使用 setMaxRetryCount；先核对完整调用边界，再请求签名，避免方法变更后半途写入。
            const uploadClient = new sdk.Ay();
            const clientMethods = ['setScene', 'isProduct', 'setTag', 'setUploadHost', 'setSignatureHost', 'setTimeout',
                'setMaxRetryCount', 'init', 'uploadImage', 'uploadFile'];
            if (clientMethods.some(method => typeof uploadClient[method] !== 'function')) throw Error('平台文件 SDK 上传方法变化，未上传');
            // 附件 SDK 默认允许重试两次；显式设为零，资质正文仍只提交一次，未知结果不自动重发。
            const asset = payload.asset;
            const tag = 'product-cert-private-tag';
            uploadClient.setScene(sdk.ju.PUBLIC_C).isProduct(true).setTag(tag)
                .setUploadHost(location.host).setSignatureHost(location.host).setTimeout(30000).setMaxRetryCount(0).init();
            const file = new File([bytes], asset.name, { type: asset.mimeType });
            const image = asset.mimeType.startsWith('image/');
            const uploader = image ? uploadClient.uploadImage() : uploadClient.uploadFile();
            const uploaderMethods = ['setSignature', 'setUrlSign', 'setData', 'build', ...(!image ? ['setContentType', 'setContentDisposition'] : [])];
            if (uploaderMethods.some(method => typeof uploader?.[method] !== 'function')) throw Error('平台文件 SDK 附件方法变化，未上传');
            if (!image) uploader.setContentType(asset.mimeType)
                .setContentDisposition(`inline; filename="qualification.pdf"; filename*=UTF-8''${encodeURIComponent(asset.name)}`);
            await assertMall();
            const raw = await client.post('/ms/bg-flux-ms/compliance_property/signature', { tag });
            const signature = typeof raw === 'string' ? raw : typeof raw?.result === 'string' ? raw.result : raw?.result?.signature || raw?.signature;
            if (typeof signature !== 'string' || !signature) throw Error('资质附件签名结构未确认');
            await assertMall();
            states.set(payload.attemptId, { state: 'submitting' });
            uploader.setSignature(signature);
            uploader.setUrlSign(1);
            void uploader.setData(file).build().then(result => {
                const url = TemuQualificationReader.normalizeKeys(result)?.url;
                if (!url || !/^https:\/\//.test(url)) throw Error('目标文件上传未返回链接');
                states.set(payload.attemptId, { state: 'uploaded', url });
            }).catch(error => { states.set(payload.attemptId, { state: 'unknown', reason: `附件上传结果未确认：${text(error)}` }); });
            return { state: 'submitting' };
        }
        if (operation === 'photo-submit') {
            const latest = await readPhotos();
            if (TemuLivePhotoTransfer.fingerprint(latest) !== payload.expectedTarget) return { state: 'rejected', reason: '发出前目标图片或模板已变化，未覆盖' };
            // 页面重新从可信采集快照规划正文，不能让后台任意覆盖已有图，也不自动绕过识别或选择免责。
            const plan = TemuLivePhotoTransfer.plan(payload.source, latest);
            if (!Array.isArray(payload.allowedKeys) || !Array.isArray(payload.uploaded)) throw Error('实拍图提交槽位回执无效');
            plan.additions = plan.additions.filter(row => payload.allowedKeys.includes(row.key));
            const uploaded = new Map(payload.uploaded);
            if (plan.additions.some(row => !uploaded.has(row.asset.sha256))) throw Error('实拍图槽位尚未全部上传，未提交残缺内容');
            const request = TemuLivePhotoTransfer.requestFor(plan, uploaded);
            if (!plan.additions.length || !payload.uploaded.length) return { state: 'existing', reason: '目标没有缺失的可补传图片位置' };
            if (String(request.spuId) !== payload.productId) throw Error('实拍图提交归属无效');
            const snake = value => Array.isArray(value) ? value.map(snake) : value && typeof value === 'object'
                ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`), snake(child)])) : value;
            await assertMall();
            states.set(payload.attemptId, { state: 'submitting' });
            // 官方全托管新抽屉首先提交 pre_verification；未通过时不能自动调用 upload_new 的人工确认选项。
            void client.post('/api/flash/real_picture/pre_verification', snake(request)).then(raw => {
                const value = TemuQualificationReader.normalizeKeys(raw);
                if (!value || value.success === false || value.errorCode && ![0, 1000000].includes(Number(value.errorCode))) throw value || Error('实拍图响应为空');
                const result = value.result || value.res || value;
                const accepted = result.checkResult === true && !result.asyDoTip;
                states.set(payload.attemptId, { state: accepted ? 'submitted' : 'unknown',
                    reason: accepted ? '平台已接收实拍图，不代表审核通过' : '实拍图已发出，平台要求异步识别或人工核对，未自动确认或重复发送' });
            }).catch(error => { states.set(payload.attemptId, { state: 'unknown', reason: `实拍图提交结果待核对：${text(error)}` }); });
            return { state: 'submitting' };
        }
        if (operation === 'submit') {
            if (String(payload.request?.productId) !== payload.productId || payload.request?.productCatCertReqList?.length !== 1) throw Error('目标资质提交归属无效');
            // 后台保存期间人工可能提交过资质；在页面真正发请求前再核对缺失状态和模板，不覆盖已有内容。
            const certType = Number(payload.request.productCatCertReqList[0].certType);
            if (payload.request.realPictures !== undefined) throw Error('商品实拍图必须走独立实拍图入口，未混入资质文件提交');
            const latest = await run('read', { ...payload, certTypes: [certType] });
            const current = latest.items?.find(item => item.certType === certType);
            if (latest.status !== 'complete' || !current) throw Error('发出前目标资质未确认');
            const status = Number(current.summary?.uploadStatus);
            if ([2, 4].includes(status)) return { state: 'existing', reason: '发出前目标已有已提交资质，未覆盖' };
            if (status !== 1) throw Error('发出前目标资质不是缺失状态，未覆盖');
            const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
                ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
            const guardDetail = detail => {
                if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null;
                // 仍保留整份详情校验；null 与字段缺失不同，不以忽略材料、历史或显示状态的方式绕过变化。
                const result = { ...detail };
                const requirements = result.certNeedUpload?.certNeedUploadItems;
                // 与预检一致，只有顶层条目排列不影响含义；完整字段、重复数量和内部选项顺序全部保留。
                if (Array.isArray(requirements)) result.certNeedUpload = { ...result.certNeedUpload,
                    certNeedUploadItems: requirements.map(item => stable(item)).sort((a, b) => {
                        const left = JSON.stringify(a), right = JSON.stringify(b);
                        return left < right ? -1 : left > right ? 1 : 0;
                    }) };
                return stable(result);
            };
            const expected = guardDetail(payload.expectedTargetDetail), actual = guardDetail(current.detail);
            if (!expected || !actual || JSON.stringify(actual) !== JSON.stringify(expected)) {
                // 只输出固定结构字段名；动态 Map 的键也可能是私有编号。本分支未发请求，明确记为拒绝。
                const knownFields = new Set(['certType', 'productId', 'certNeedUpload', 'fileUploadType', 'needUploadLanguages',
                    'needAgreement', 'needConfirm', 'productCertFiles', 'inspectReportFiles', 'realPictures', 'selectedCheckItems',
                    'authCode', 'authCodes', 'multiLangProductCertFileMap', 'multiLangInspectReportMap']);
                const changes = [...new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]
                    .filter(key => JSON.stringify(expected?.[key]) !== JSON.stringify(actual?.[key]))
                    .map(key => knownFields.has(key) ? key : '其他字段'))].slice(0, 6);
                return { state: 'rejected', reason: `发出前目标资质要求或填写内容已变化（${changes.join('、') || 'detail'}），未提交` };
            }
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
