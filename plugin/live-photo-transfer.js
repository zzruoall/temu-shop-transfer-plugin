/** 实拍图只按位置、视角和货号映射；绝不使用主图、证书附件或数组下标补齐目标槽位。 */
var TemuLivePhotoTransfer = (() => {
    'use strict';
    const fail = message => { throw Error(message); };
    const id = value => TemuQualificationReader.productId(value);
    const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
    /** 整份目标状态参与提交前核对，保留已有图和模板；未知的历史非空位置不能被请求静默抹掉。 */
    function fingerprint(target) {
        // 已核验的上传位置、视角及SKU按自身标识定义含义，展示顺序变化不是模板变化；不删任何字段或重复条目。
        const orderKeys = { positionInfoList: 'position', positionDetail: 'position', positionTypeInfo: 'type', skus: 'skuId', skuInfo: 'skuId', skuPhotoInfoList: 'skuId' };
        const normalize = (value, field = '') => {
            if (Array.isArray(value)) {
                const array = value.map(child => normalize(child));
                const key = orderKeys[field];
                return key ? array.sort((left, right) => String(left?.[key]).localeCompare(String(right?.[key]))) : array;
            }
            return value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalize(child, key)])) : value;
        };
        return JSON.stringify(stable(normalize(target)));
    }
    function plan(source, target) {
        // 任务只含归档引用；原包字节校验在采集落库、下载和SDK上传边界分别执行。
        if (source.assets?.some(asset => Object.hasOwn(asset, 'dataBase64'))) TemuLivePhotoReader.validateSnapshot(source, source.productId);
        else TemuLivePhotoReader.validateReferenceSnapshot(source, source.productId);
        if (source.status !== 'complete' || source.archive?.status !== 'complete') fail('来源实拍图尚未完整归档');
        if (!['captured', 'empty', 'not-found'].includes(source.captureState)) fail('来源实拍图采集状态未确认');
        const { detail, config, skus } = target;
        id(target.productId); id(target.goodsId);
        if (String(detail?.spuId) !== target.productId || String(detail?.goodsId) !== target.goodsId
            || !Array.isArray(detail.positionDetail) || !Array.isArray(config?.positionInfoList)
            || !Array.isArray(detail.skuInfo) || !Array.isArray(skus) || !skus.length) fail('目标实拍图归属或配置未确认');
        const targetIds = skus.map(sku => id(sku.skuId));
        if (new Set(targetIds).size !== targetIds.length || detail.skuInfo.length !== targetIds.length
            || detail.skuInfo.some(sku => !targetIds.includes(id(sku.skuId)))) fail('目标实拍图 SKU 与商品详情不一致');
        const sourceIds = source.skus.map(sku => sku.skuId);
        const byCode = new Map();
        for (const sku of skus) {
            if (!sku.skuExtCode || byCode.has(sku.skuExtCode)) fail('没有匹配到内容：目标 SKU 货号缺失或重复');
            byCode.set(sku.skuExtCode, sku.skuId);
        }
        const mapping = new Map();
        for (const sku of source.skus) {
            const targetId = byCode.get(sku.skuExtCode);
            if (!sku.skuExtCode || !targetId || [...mapping.values()].includes(targetId)) fail('没有匹配到内容：来源 SKU 货号缺失、重复或目标不唯一');
            mapping.set(sku.skuId, targetId);
        }
        if (mapping.size !== targetIds.length) fail('没有匹配到内容：来源与目标 SKU 数量或货号不一致');
        const definitions = new Map();
        for (const position of config.positionInfoList) {
            if (!Number.isSafeInteger(position.position) || definitions.has(position.position) || !Array.isArray(position.positionTypeInfo)) fail('目标图片位置配置重复或无效');
            const types = new Map();
            for (const type of position.positionTypeInfo) {
                if (!Number.isSafeInteger(type.type) || types.has(type.type) || !Number.isSafeInteger(type.limitNums) || type.limitNums <= 0) fail('目标图片视角或数量上限未确认');
                types.set(type.type, type.limitNums);
            }
            definitions.set(position.position, types);
        }
        const existing = new Map();
        for (const group of detail.positionDetail) {
            if (!Number.isSafeInteger(group.position) || existing.has(group.position) || typeof group.isSameSku !== 'boolean'
                || !Array.isArray(group.skuPhotoInfoList)) fail('目标图片槽结构不兼容');
            if (!definitions.has(group.position) && group.skuPhotoInfoList.some(row => row.imageList?.length)) fail('目标含未支持的历史图片位置，未提交');
            const rows = new Map();
            for (const row of group.skuPhotoInfoList) {
                const owner = group.isSameSku && ['0', '-1'].includes(String(row.skuId)) ? '0' : id(row.skuId);
                if (rows.has(owner) || owner !== '0' && !targetIds.includes(owner) || !Array.isArray(row.imageList)) fail('目标图片 SKU 归属冲突');
                const images = row.imageList.map(image => {
                    if (!definitions.get(group.position)?.has(image.positionType) || !TemuQualificationReader.assetUrl(image.imageUrl)) fail('目标已有图片分类未知，未覆盖');
                    return { imageUrl: image.imageUrl, positionType: image.positionType };
                });
                rows.set(owner, images);
            }
            if (group.isSameSku && rows.size > 1) fail('目标共用图片结构未经核验');
            existing.set(group.position, { isSameSku: group.isSameSku, rows });
        }
        const assets = new Map(source.assets.map(asset => [asset.url, asset]));
        const items = [], additions = [], seen = new Set();
        for (const group of source.groups) {
            if (group.images.length && group.isSameSku && (group.skuIds.length !== sourceIds.length || sourceIds.some(skuId => !group.skuIds.includes(skuId)))) fail('来源共用图片只属于部分SKU，未自动复制给其他SKU');
            for (const image of group.images) {
            const key = `${group.position}:${image.positionType}:${image.skuId}`;
            let item = items.find(value => value.key === key);
            if (!item) { item = { key, name: `${group.label}·${image.typeLabel}·${image.skuId === '0' ? '共用' : mapping.get(image.skuId)}`, state: 'pending', reason: '' }; items.push(item); }
            if (![1, 2].includes(group.position) || !definitions.get(group.position)?.has(image.positionType)) {
                item.state = 'failed'; item.reason = '目标没有匹配的采集位置或视角，未猜测上传位置'; continue;
            }
            const current = existing.get(group.position);
            const hasImages = current && [...current.rows.values()].some(rows => rows.length);
            const owners = group.isSameSku ? targetIds : [mapping.get(image.skuId)];
            if (!owners[0] || !sourceIds.includes(image.skuId) && image.skuId !== '0') fail('来源图片 SKU 归属无效');
            // 目标所需 SKU 的对应视角已有图就跳过；不补传时无需强求来源与目标共用模式一致。
            if (owners.some(owner => (current?.rows.get(current.isSameSku ? [...current.rows.keys()][0] : owner) || []).some(value => value.positionType === image.positionType))) {
                // 共用来源覆盖多个 SKU；仅部分 SKU 已有图时不能整槽跳过或覆盖，须明确留待人工核对。
                if (!owners.every(owner => (current?.rows.get(current.isSameSku ? [...current.rows.keys()][0] : owner) || []).some(value => value.positionType === image.positionType))) {
                    item.state = 'failed'; item.reason = '目标仅部分SKU已有该视角图片，未覆盖或改变共用模式'; continue;
                }
                item.state = 'existing'; item.reason = '目标该位置和视角已有图片，未追加或覆盖'; continue;
            }
            if (hasImages && current.isSameSku !== group.isSameSku) {
                item.state = 'failed'; item.reason = '来源与目标的共用/SKU独立模式不同，未改写已有图片'; continue;
            }
            const asset = assets.get(image.url);
            if (!asset || !['image/jpeg', 'image/png'].includes(asset.mimeType) || asset.bytes > 3 * 1024 * 1024) {
                item.state = 'failed'; item.reason = '实拍图仅支持已归档的 JPEG/PNG 且不超过平台 3MB 上限'; continue;
            }
            const unique = `${key}:${asset.sha256}`;
            if (seen.has(unique)) continue;
            seen.add(unique);
            additions.push({ key, position: group.position, positionType: image.positionType, owners, isSameSku: group.isSameSku, asset });
            }
        }
        // 相同槽内图片超过平台上限时整槽跳过，不截断伪装完整；其它槽仍可继续。
        for (const item of items) {
            const rows = additions.filter(row => row.key === item.key);
            if (rows.length > (rows.length ? definitions.get(rows[0].position).get(rows[0].positionType) : 0)) {
                item.state = 'failed'; item.reason = '来源该视角图片数量超过目标上限，未截断提交';
            }
        }
        return { items, additions: additions.filter(row => items.find(item => item.key === row.key).state === 'pending'), target, guard: fingerprint(target) };
    }
    /** 构造独立实拍图正文，保留所有目标已有槽位；只把成功上传的图片填入原采集位置。 */
    function requestFor(plan, uploaded) {
        const target = plan.target;
        const positions = target.config.positionInfoList.map(definition => {
            const old = target.detail.positionDetail.find(group => group.position === definition.position);
            const added = plan.additions.filter(row => row.position === definition.position && uploaded.has(row.asset.sha256));
            const nonempty = old?.skuPhotoInfoList.some(row => row.imageList.length);
            const isSameSku = nonempty ? old.isSameSku : added[0]?.isSameSku ?? old?.isSameSku ?? true;
            return { position: definition.position, isSameSku, skuPhotoInfoList: target.skus.map(sku => {
                const previous = old?.skuPhotoInfoList.find(row => old.isSameSku || String(row.skuId) === sku.skuId);
                const imageList = (previous?.imageList || []).map(image => ({ imageUrl: image.imageUrl, positionType: image.positionType }));
                for (const row of added.filter(row => row.owners.includes(sku.skuId))) {
                    const url = uploaded.get(row.asset.sha256);
                    if (!TemuQualificationReader.assetUrl(url)) fail('实拍图上传回执地址无效');
                    if (!imageList.some(image => image.positionType === row.positionType && image.imageUrl === url)) imageList.push({ imageUrl: url, positionType: row.positionType });
                }
                return { skuId: sku.skuId, imageList };
            }) };
        });
        return { spuId: target.productId, goodsId: target.goodsId, realPictureInfoList: positions };
    }
    const api = { plan, requestFor, fingerprint };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return api;
})();
