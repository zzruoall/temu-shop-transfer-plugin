/** 商品实拍图独立只读采集：不读取示例、主图或素材下载区，不调用上传、识别、确认或豁免接口。 */
var TemuLivePhotoReader = (() => {
    'use strict';
    const LIST_PATH = '/api/flash/real_picture/list';
    const DETAIL_PATH = '/api/flash/real_picture/detail';
    const CONFIG_PATH = '/api/flash/real_picture/query_upload_param';
    const MAX_IMAGES = 200;
    const helper = () => TemuQualificationReader;
    const fail = (reason, stopBatch = false) => { throw Object.assign(Error(reason), { stopBatch }); };
    const id = value => helper().productId(value);
    const count = snapshot => snapshot.groups.reduce((sum, group) => sum + group.images.length, 0);

    /** 货号取自同一次商品详情，不从 SKU 显示名称猜货号；保留来源 ID，后续跨店映射不能直接复用。 */
    function sourceSkus(product, productId) {
        if (id(product?.productId) !== productId) fail('实拍图与商品详情归属不一致', true);
        const skus = new Map();
        for (const skc of product.productSkcList || []) {
            const rows = [...(skc.productSkuList || []), ...Object.values(skc.productSkuMap || {})];
            for (const sku of rows) {
                const skuId = id(sku.productSkuId ?? sku.skuId);
                const value = { skuId, skuExtCode: String(sku.extCode || sku.skuExtCode || '').trim(),
                    productExtCode: String(skc.extCode || skc.skcExtCode || '').trim() };
                if (skus.has(skuId) && JSON.stringify(skus.get(skuId)) !== JSON.stringify(value)) fail('来源 SKU 货号有冲突', true);
                skus.set(skuId, value);
            }
        }
        if (!skus.size) fail('来源商品详情未提供可核验的 SKU，未猜测图片归属');
        return skus;
    }

    /** 官方只读接口可能直接返回正文；明确业务失败或经营模式不一致不能被解释为没有图片。 */
    function root(raw) {
        const value = helper().normalizeKeys(raw);
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail('实拍图响应结构未知');
        if (value.success === false || value.errorCode && ![0, 1000000].includes(Number(value.errorCode)) || value.errorMsg || value.errorMessage) {
            const fatal = [40001, 54001, 403, 429].includes(Number(value.errorCode))
                || /登录|权限|验证码|captcha|unauthor|forbidden/i.test(String(value.errorMsg || value.errorMessage || ''));
            fail('实拍图接口返回业务失败，未解释为空图', fatal);
        }
        return value.result || value.res || value;
    }

    /** 只提取官方详情的实际上传槽；位置与视角是两个不同字段，数组顺序不决定图片用途。 */
    function groupsFromDetail(detail, config, knownSkus) {
        if (!Array.isArray(detail.skuInfo) || !detail.skuInfo.length || !Array.isArray(detail.positionDetail)
            || !Array.isArray(config.positionInfoList)) fail('实拍图详情或位置配置未完整返回');
        const skus = detail.skuInfo.map(sku => id(sku.skuId));
        if (new Set(skus).size !== skus.length || skus.some(skuId => !knownSkus.has(skuId))) fail('实拍图返回其他 SKU，已拒绝关联', true);
        const positions = new Map();
        for (const position of config.positionInfoList) {
            if (!Number.isSafeInteger(position.position) || position.position < 0 || positions.has(position.position)
                || !Array.isArray(position.positionTypeInfo)) fail('实拍图位置配置冲突');
            const types = new Map();
            for (const type of position.positionTypeInfo) {
                if (!Number.isSafeInteger(type.type) || type.type < 0 || types.has(type.type)) fail('实拍图视角配置冲突');
                types.set(type.type, String(type.desc || '').slice(0, 120));
            }
            positions.set(position.position, { label: String(position.desc || '').slice(0, 120), types });
        }
        const seen = new Set();
        const groups = detail.positionDetail.map(position => {
            if (!Number.isSafeInteger(position.position) || position.position < 0 || seen.has(position.position)
                || typeof position.isSameSku !== 'boolean' || !Array.isArray(position.skuInfo)
                || !Array.isArray(position.skuPhotoInfoList)) fail('实拍图上传槽结构未知，未解释为空图');
            seen.add(position.position);
            const skuIds = position.skuInfo.map(sku => id(sku.skuId));
            if (!skuIds.length || new Set(skuIds).size !== skuIds.length || skuIds.some(skuId => !skus.includes(skuId))) fail('实拍图位置的 SKU 归属不一致', true);
            const definition = positions.get(position.position);
            const images = [], owners = new Set();
            for (const entry of position.skuPhotoInfoList) {
                // 平台以 0 保存共用图片；不能把它当真实 SKU，也不能把独立 SKU 图片自动复制给其他 SKU。
                const owner = position.isSameSku && [0, -1, '0', '-1'].includes(entry.skuId) ? '0' : id(entry.skuId);
                if (owners.has(owner) || !Array.isArray(entry.imageList) || owner !== '0' && !skuIds.includes(owner)
                    || position.isSameSku && position.skuPhotoInfoList.length > 1) fail('实拍图共用状态或 SKU 图片归属冲突', true);
                owners.add(owner);
                for (const image of entry.imageList) {
                    const url = helper().assetUrl(image.imageUrl);
                    if (!url || !Number.isSafeInteger(image.positionType) || image.positionType < 0
                        || !definition?.types.has(image.positionType)) fail('实拍图地址或视角分类未经确认');
                    const imageUrl = new URL(url);
                    const extension = /\.(jpe?g|png|webp|gif)$/i.exec(imageUrl.pathname)?.[1] || 'jpg';
                    images.push({ skuId: owner, positionType: image.positionType, typeLabel: definition.types.get(image.positionType),
                        url, name: `${position.position}-${owner}-${image.positionType}-${images.length + 1}.${extension}` });
                }
            }
            // 平台会保留空的旧位置 3、5；无图片时保留编号但不猜位置名称。有图片则必须有当前配置。
            return { position: position.position, label: definition?.label || '', isSameSku: position.isSameSku, skuIds, images };
        });
        if (groups.reduce((sum, group) => sum + group.images.length, 0) > MAX_IMAGES) fail('实拍图超过 200 张安全预算，未截断保存');
        return { skus: skus.map(skuId => ({ ...knownSkus.get(skuId) })), groups };
    }

    /** 只把实际上传槽 URL 交给字节归档器，同一原图跨位置引用只下载一次，分类引用全部保留。 */
    function files(snapshot) {
        const seen = new Set(), result = [];
        for (const group of snapshot.groups) for (const image of group.images) {
            const key = helper().publicAssetUrl(image.url);
            if (!seen.has(key)) { seen.add(key); result.push({ url: image.url, name: image.name }); }
        }
        return result;
    }

    /** 列表用于精确定位 SPU，详情用于取已上传图片，配置仅用于解释位置；查询不改变页面筛选或选择。 */
    async function readSnapshot(client, context) {
        const productId = id(context.spuId), deadline = Date.now() + 60000;
        const snapshot = { schemaVersion: 1, productId, mallId: String(context.mallId), capturedAt: new Date().toISOString(),
            status: 'failed', captureState: 'failed', reason: '', skus: [], groups: [] };
        let stopBatch = false;
        const request = async (path, input) => {
            if (context.signal?.aborted) fail('实拍图采集已取消', true);
            if (Date.now() >= deadline) fail('实拍图读取超过时间预算', true);
            await context.assertCurrent();
            const value = root(await context.post(path, input, Math.min(15000, deadline - Date.now())));
            await context.assertCurrent();
            if (context.signal?.aborted) fail('实拍图采集已取消', true);
            if (helper().metadataBytes(value) > 8 * 1024 * 1024) fail('实拍图响应超过大小限制');
            return value;
        };
        try {
            const known = sourceSkus(context.sourceProduct, productId);
            const list = await request(LIST_PATH, { spu_id_list: [productId], page: 1, page_size: 10, page_version: 1 });
            if (list.isSemiManagedMall !== false || !Array.isArray(list.items) || !Number.isSafeInteger(list.total)
                || list.total < 0 || list.total > 1 || list.items.length !== list.total) fail('实拍图经营模式或精确查询结果未经确认');
            if (!list.total) {
                snapshot.status = 'complete'; snapshot.captureState = 'not-found';
                snapshot.reason = '来源实拍图列表没有该商品，未将主图或示例当作实拍图';
            } else {
                const row = list.items[0];
                if (id(row.spuId) !== productId) fail('实拍图列表返回其他商品', true);
                const goodsId = id(row.goodsId);
                const detail = await request(DETAIL_PATH, { spu_id: productId, goods_id: goodsId });
                if (id(detail.spuId) !== productId || id(detail.goodsId) !== goodsId) fail('实拍图详情商品归属不一致', true);
                const config = await request(CONFIG_PATH, { spu_id: productId, goods_id: goodsId });
                Object.assign(snapshot, groupsFromDetail(detail, config, known));
                snapshot.goodsId = goodsId; snapshot.status = 'complete';
                snapshot.captureState = count(snapshot) ? 'captured' : 'empty';
                snapshot.reason = count(snapshot) ? '' : '来源实拍图上传槽为空';
            }
        } catch (error) {
            snapshot.reason = String(error.message || '实拍图查询失败').slice(0, 300);
            stopBatch = error.stopBatch === true;
        }
        try {
            await helper().archiveAssets(snapshot, context, deadline, files(snapshot), { maxAssets: MAX_IMAGES, archiveMs: 45000,
                maxTotalAssetBytes: context.assetBudgetBytes });
            // 实拍图只能归档图片，不能因链接下载到了 PDF 就宣称图片已采集。
            const invalid = snapshot.assets.filter(asset => !asset.mimeType.startsWith('image/'));
            if (invalid.length) {
                snapshot.assets = snapshot.assets.filter(asset => asset.mimeType.startsWith('image/'));
                snapshot.archive.errors.push(...invalid.map(asset => ({ url: asset.url, name: asset.name, reason: '实拍图链接返回非图片文件' })));
                snapshot.archive.status = snapshot.assets.length ? 'partial' : 'failed';
            }
        } catch (error) {
            snapshot.status = 'failed'; snapshot.captureState = 'failed';
            snapshot.reason = String(error.message || '实拍图归档失败').slice(0, 300);
            stopBatch ||= error.stopBatch === true;
        }
        if (snapshot.status === 'complete' && snapshot.archive.status !== 'complete') {
            snapshot.status = 'partial'; snapshot.reason = '实拍图位置已读取，但原图尚未完整归档';
        }
        snapshot.groups = helper().scrubMetadata(snapshot.groups);
        if (helper().metadataBytes(snapshot) > 8 * 1024 * 1024) {
            snapshot.groups = []; snapshot.skus = []; snapshot.assets = [];
            snapshot.status = 'failed'; snapshot.captureState = 'failed'; snapshot.reason = '实拍图元数据超过大小预算，未截断保存';
            snapshot.archive = { status: 'failed', errors: [{ url: '', name: '', reason: snapshot.reason }] };
        }
        validateSnapshot(snapshot, productId);
        return { snapshot, stopBatch, stopReason: stopBatch ? snapshot.reason : '' };
    }

    /** 服务端引用投影独立校验，允许不携带正文，但不放松位置、SKU、哈希和归档状态约束。 */
    function validateReferenceSnapshot(value, expectedSpu) {
        helper().normalizeKeys(value);
        if (!value || value.schemaVersion !== 1 || id(value.productId) !== String(expectedSpu) || !String(value.mallId || '').trim()
            || !Number.isFinite(Date.parse(value.capturedAt)) || !['complete', 'partial', 'failed'].includes(value.status)
            || !['captured', 'empty', 'not-found', 'failed'].includes(value.captureState) || !Array.isArray(value.skus)
            || !Array.isArray(value.groups) || value.groups.length > 200 || value.skus.length > 1000
            || helper().metadataBytes(value) > 8 * 1024 * 1024) fail('实拍图快照结构或归属无效');
        const skus = new Set(value.skus.map(sku => id(sku.skuId))), seen = new Set();
        if (skus.size !== value.skus.length) fail('实拍图 SKU 重复');
        for (const group of value.groups) {
            if (!Number.isSafeInteger(group.position) || group.position < 0 || seen.has(group.position)
                || typeof group.isSameSku !== 'boolean' || !Array.isArray(group.skuIds) || !Array.isArray(group.images)
                || !group.skuIds.length || new Set(group.skuIds).size !== group.skuIds.length || group.skuIds.some(sku => !skus.has(sku))) fail('实拍图位置归属无效');
            seen.add(group.position);
            for (const image of group.images) {
                if (image.skuId === '0' ? !group.isSameSku : !group.skuIds.includes(image.skuId)) fail('实拍图图片 SKU 归属无效');
                if (!Number.isSafeInteger(image.positionType) || image.positionType < 0 || !image.url
                    || helper().publicAssetUrl(image.url) !== image.url || typeof image.name !== 'string') fail('实拍图图片分类或地址无效');
            }
            if (group.isSameSku && new Set(group.images.map(image => image.skuId)).size > 1) fail('共用实拍图含多个独立 SKU 所有者');
        }
        if (count(value) > MAX_IMAGES || ['empty', 'not-found'].includes(value.captureState) && count(value)
            || value.captureState === 'captured' && !count(value) || value.status === 'complete' && value.captureState === 'failed') fail('实拍图完整状态与图片数量不一致');
        if (!Array.isArray(value.assets) || !value.archive) fail('实拍图快照缺少原图归档回执');
        if (value.assets.length > MAX_IMAGES || !['complete', 'partial', 'failed', 'metadata-only'].includes(value.archive.status)
            || !Array.isArray(value.archive.errors) || value.archive.errors.length > MAX_IMAGES + 2) fail('实拍图归档引用结构无效');
        const urls = new Set(files(value).map(file => file.url)), seenUrls = new Set();
        let total = 0;
        for (const asset of value.assets) {
            if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(asset?.mimeType)) fail('实拍图归档MIME无效或包含非图片文件');
            if (!asset || !urls.has(asset.url) || seenUrls.has(asset.url) || helper().publicAssetUrl(asset.url) !== asset.url
                || typeof asset.name !== 'string' || !asset.name || asset.name.length > 240
                || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isSafeInteger(asset.bytes)
                || asset.bytes <= 0 || asset.bytes > 10 * 1024 * 1024) fail('实拍图归档引用无效');
            total += asset.bytes; seenUrls.add(asset.url);
        }
        if (total > 32 * 1024 * 1024 || value.archive.status === 'complete'
            && (value.status !== 'complete' || value.archive.errors.length || seenUrls.size !== urls.size)
            || value.archive.status === 'partial' && (!value.archive.errors.length || !value.assets.length)
            || value.archive.status === 'failed' && (!value.archive.errors.length || value.assets.length)
            || value.archive.status === 'metadata-only' && (value.assets.length || value.archive.errors.length)) fail('实拍图归档状态与引用不一致');
        return value;
    }
    /** 原始采集包仍须验证真实字节；引用投影不能绕过原包落库的哈希和MIME检查。 */
    function validateSnapshot(value, expectedSpu) {
        validateReferenceSnapshot(value, expectedSpu);
        helper().validateArchive(value, () => files(value), MAX_IMAGES);
        return value;
    }
    const api = { readSnapshot, validateSnapshot, validateReferenceSnapshot, LIST_PATH, DETAIL_PATH, CONFIG_PATH };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return api;
})();
