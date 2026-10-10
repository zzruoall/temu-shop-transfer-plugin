/** 实拍图独立归档，位置、视角和 SKU 归属不能从主图、证书附件或示例推断。 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { decodeAsset, qualificationFileUrl, qualificationReferences, mergeQualificationCapture } from './product-qualifications.mjs';
import { transferHash } from './transfer-integrity.mjs';
const array = value => Array.isArray(value) ? value : [];
const validId = value => typeof value === 'string' && /^\d{6,20}$/.test(value);
const fail = () => { throw Error('实拍图采集归属、分类或归档结构无效'); };
export const livePhotoReferences = qualificationReferences;
export const mergeLivePhotoCapture = mergeQualificationCapture;

/**
 * 旧资质照片仅能证明来源包有归档图片，不能证明新版 SKU/视角映射；诊断不授予上传或替换目标图权限。
 * 只交叉核对同一商品、同一资质条目的实际 realPictures 与归档引用，不读取主图、要求、示例或历史快照。
 */
export function legacyLivePhotoCompatibility(product = {}) {
    const quals = product.qualifications;
    if (product.livePhotos != null || !validId(product.spuId) || quals?.schemaVersion !== 1
        || quals.spuId !== product.spuId || !Array.isArray(quals.items) || quals.items.length > 200) return null;
    const hashes = new Set(), positions = new Set();
    let inspected = 0, missingPosition = false;
    const legalUrl = url => typeof url === 'string' && url.length > 0 && url.length <= 2048 && qualificationFileUrl(url) === url;
    for (const item of quals.items) {
        const pictures = array(item?.content?.realPictures), files = array(item?.files);
        // 输入和输出都有硬预算；超限不生成不完整计数，也不递归扫描任意旧正文。
        inspected += pictures.length + files.length;
        if (inspected > 40000) return null;
        if (item?.status !== 'complete' || !pictures.length) continue;
        const archived = new Map();
        for (const file of files) {
            const asset = file?.asset;
            if (file?.role !== '资质实拍图' || file.archiveStatus !== 'archived' || !legalUrl(file.url)
                || asset?.url !== file.url || typeof asset?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
                || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > 10 * 1024 * 1024
                || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(asset.mimeType)) continue;
            archived.set(file.url, asset.sha256);
        }
        for (const picture of pictures) {
            if (!legalUrl(picture?.imageUrl) || !archived.has(picture.imageUrl)) continue;
            // 相同字节跨类型/链接只计一张；位置仅采信显式整数，MIME、数组顺序和 SKU 列表不提供分类证据。
            hashes.add(archived.get(picture.imageUrl));
            if (Number.isSafeInteger(picture.position) && picture.position >= 0) positions.add(picture.position);
            else missingPosition = true;
            if (hashes.size > 40 || positions.size > 200) return null;
        }
    }
    if (!hashes.size) return null;
    return { state: 'legacy-unclassified', imageCount: hashes.size, knownPositions: [...positions].sort((a, b) => a - b),
        missingFields: ['sku', 'view', ...(missingPosition ? ['position'] : [])],
        reason: '旧资质图片缺少可核验的 SKU 归属和视角，需要来源店重新采集独立实拍图；不可直接上传或替换目标图片' };
}

/** 仅专用采集快照可入库；未经分类的官方原始响应不进入通用商品解析器。 */
export function parseLivePhotoRecord(record) {
    if (record?.dataType !== 'product-live-photos') return null;
    const url = new URL(record.source?.requestUrl || '', 'https://invalid.invalid');
    const value = record.payload?.result, spuId = String(record.source?.pageProductId || value?.productId || '');
    if (url.origin !== 'https://agentseller.temu.com' || url.pathname !== '/api/flash/real_picture/detail'
        || record.payload?.success !== true || record.identity?.productIds?.length !== 1
        || String(record.identity.productIds[0]) !== spuId || !value || value.schemaVersion !== 1
        || !validId(value.productId) || value.productId !== spuId || !validId(value.mallId)
        || value.goodsId !== undefined && !validId(value.goodsId) || !Number.isFinite(Date.parse(value.capturedAt))
        || !['complete', 'partial', 'failed'].includes(value.status)
        || !['captured', 'empty', 'not-found', 'failed'].includes(value.captureState)
        || !Array.isArray(value.skus) || value.skus.length > 1000 || !Array.isArray(value.groups) || value.groups.length > 200
        || !Array.isArray(value.assets) || value.assets.length > 200 || !value.archive
        || !['complete', 'partial', 'failed', 'metadata-only'].includes(value.archive.status)
        || !Array.isArray(value.archive.errors) || value.archive.errors.length > 202) fail();
    // 元数据不能夹带字节或原型字段；正文只允许顶层 assets，先限制深度再序列化。
    const { assets, ...metadata } = value;
    const scan = (node, depth = 0) => {
        if (depth > 80) fail();
        if (!node || typeof node !== 'object') return;
        for (const [key, child] of Object.entries(node)) {
            if (['__proto__', 'constructor', 'prototype', 'dataBase64'].includes(key)) fail();
            scan(child, depth + 1);
        }
    };
    scan(metadata);
    if (Buffer.byteLength(JSON.stringify(metadata)) > 8 * 1024 * 1024) fail();
    const skus = new Set(), positions = new Set(), urls = new Set();
    for (const sku of value.skus) {
        if (!validId(sku?.skuId) || skus.has(sku.skuId) || typeof sku.skuExtCode !== 'string' || typeof sku.productExtCode !== 'string') fail();
        skus.add(sku.skuId);
    }
    let images = 0;
    for (const group of value.groups) {
        if (!Number.isSafeInteger(group?.position) || group.position < 0 || positions.has(group.position)
            || typeof group.label !== 'string' || typeof group.isSameSku !== 'boolean'
            || !Array.isArray(group.skuIds) || !group.skuIds.length || new Set(group.skuIds).size !== group.skuIds.length
            || group.skuIds.some(id => !skus.has(id)) || !Array.isArray(group.images)) fail();
        positions.add(group.position);
        const owners = new Set();
        for (const image of group.images) {
            if (image?.skuId === '0' ? !group.isSameSku : !group.skuIds.includes(image?.skuId)) fail();
            if (!Number.isSafeInteger(image.positionType) || image.positionType < 0 || typeof image.typeLabel !== 'string'
                || !image.url || qualificationFileUrl(image.url) !== image.url || new URL(image.url).search || new URL(image.url).hash
                || typeof image.name !== 'string' || image.name.length > 240) fail();
            owners.add(image.skuId); urls.add(image.url); images++;
        }
        if (group.isSameSku && owners.size > 1) fail();
    }
    if (images > 200 || ['empty', 'not-found'].includes(value.captureState) && images
        || value.captureState === 'captured' && !images || value.status === 'complete' && value.captureState === 'failed') fail();
    let total = 0;
    const archived = new Set();
    for (const asset of assets) {
        if (!urls.has(asset?.url) || archived.has(asset.url) || !asset.mimeType?.startsWith('image/') || asset.name?.length > 240) fail();
        total += asset.bytes || 0;
        if (total > 32 * 1024 * 1024) fail();
        decodeAsset(asset); archived.add(asset.url);
    }
    for (const error of value.archive.errors) {
        if (typeof error?.url !== 'string' || error.url && (qualificationFileUrl(error.url) !== error.url || new URL(error.url).search || new URL(error.url).hash)
            || typeof error.name !== 'string' || error.name.length > 240 || typeof error.reason !== 'string' || !error.reason || error.reason.length > 180) fail();
    }
    const errors = value.archive.errors.length, state = value.archive.status;
    if (state === 'complete' && (errors || value.status !== 'complete' || archived.size !== urls.size)
        || state === 'partial' && (!errors || !assets.length) || state === 'failed' && (!errors || assets.length)
        || state === 'metadata-only' && (assets.length || errors)) fail();
    return { spuId, livePhotos: livePhotoReferences(value), sources: ['product-live-photos'] };
}

/** 重采时间不构成业务重复，但位置、原图哈希和读取状态变化必须保留新批次。 */
export function livePhotoContentHash(value) {
    if (!value) return '';
    const { capturedAt, lastAttempt, ...content } = value;
    return transferHash(content);
}

/** 按当前来源店/SPU引用读取原包，哈希不是跨账户授权；删除或解绑后不能继续投递已读字节。 */
export async function readLivePhotoAsset(store, { spuId, sha256, sourceStoreId, scope = null }) {
    const view = await store.getProduct(spuId, scope, sourceStoreId);
    if (!view?.product.sourceStoreIds?.includes(sourceStoreId)) return null;
    const captures = array(view.product.livePhotoCaptures).length ? view.product.livePhotoCaptures
        : view.product.livePhotos ? [{ ...view.product.livePhotos, sourceStoreId }] : [];
    if (!captures.some(capture => capture.productId === spuId && capture.sourceStoreId === sourceStoreId
        && array(capture.assets).some(asset => asset.sha256 === sha256))) return null;
    for (const linked of array(view.batches)) {
        if (!view.product.batchIds?.includes(linked.id)) continue;
        const batch = await store.getBatch(linked.id);
        if (batch?.sourceStoreId !== sourceStoreId || !array(batch.products).some(p => String(p.spuId) === spuId)) continue;
        for (const file of array(batch.files)) {
            if (!file.storedName || path.basename(file.storedName) !== file.storedName) continue;
            let raw;
            try {
                if (store.filesDir) {
                    const full = path.join(store.filesDir, file.storedName);
                    if ((await stat(full)).size > 64 * 1024 * 1024) throw Error('实拍图原包超过读取预算');
                    const bytes = await readFile(full);
                    if (file.fileSha256 && (bytes.length !== Number(file.fileBytes)
                        || createHash('sha256').update(bytes).digest('hex') !== file.fileSha256)) throw Error('实拍图原包字节校验失败');
                    raw = JSON.parse(bytes.toString('utf8'));
                    if (file.contentSha256 && transferHash(raw) !== file.contentSha256) throw Error('实拍图原包内容校验失败');
                } else raw = (await store.readStoredFile(file.storedName)).json;
            } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (raw.source?.sourceStoreId && raw.source.sourceStoreId !== sourceStoreId
                || Array.isArray(raw.source?.allowedSpuIds) && !raw.source.allowedSpuIds.map(String).includes(spuId)) continue;
            for (const record of array(raw.records).concat(raw.record || (raw.dataType ? raw : []))) {
                if (record?.dataType !== 'product-live-photos' || record.payload?.result?.productId !== spuId) continue;
                const parsed = parseLivePhotoRecord(record);
                if (!parsed.livePhotos.assets.some(asset => asset.sha256 === sha256)) continue;
                const asset = record.payload.result.assets.find(asset => asset.sha256 === sha256);
                const current = await store.getProduct(spuId, scope, sourceStoreId), active = await store.getBatch(batch.id);
                if (!current?.product.batchIds?.includes(batch.id) || active?.sourceStoreId !== sourceStoreId
                    || !array(active.products).some(p => String(p.spuId) === spuId)) return null;
                // 重采可撤销原图引用但保留同一批次，必须核对当前照片归属，不能仅靠旧批次还存在放行。
                const currentCaptures = array(current.product.livePhotoCaptures).length ? current.product.livePhotoCaptures
                    : current.product.livePhotos ? [{ ...current.product.livePhotos, sourceStoreId }] : [];
                if (!current.product.sourceStoreIds?.includes(sourceStoreId)
                    || !currentCaptures.some(capture => capture.productId === spuId && capture.sourceStoreId === sourceStoreId
                        && array(capture.assets).some(asset => asset.sha256 === sha256))) return null;
                return { ...livePhotoReferences(asset), data: decodeAsset(asset) };
            }
        }
    }
    return null;
}
