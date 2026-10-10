/** 合成图片只用于隔离测试，不含真实商品照片或店铺凭证。 */
import { createHash } from 'node:crypto';
import { productRecord, spuId } from './qualification-fixture.mjs';
export const sourceStoreId = 'temu:634418214794015';
export function livePhotoSnapshot(id = spuId) {
    const data = Buffer.from([255, 216, 255, 224, 10, 20, 30]);
    const url = 'https://pos.file.temu.com/flash-tag/fixture.jpeg';
    return { schemaVersion: 1, productId: id, mallId: sourceStoreId.slice(5), capturedAt: '2026-10-10T07:00:00.000Z',
        status: 'complete', captureState: 'captured', reason: '', goodsId: '607030089729277',
        skus: [{ skuId: '464860473010', skuExtCode: 'SKU-TEST', productExtCode: 'TEST-ARTICLE' }],
        groups: [1, 2].map(position => ({ position, label: position === 1 ? '商品主体实拍图' : '商品外包装实拍图',
            isSameSku: true, skuIds: ['464860473010'], images: [{ skuId: '0', positionType: 0, typeLabel: '正视图', url, name: 'fixture.jpeg' }] })),
        assets: [{ url, name: 'fixture.jpeg', mimeType: 'image/jpeg', bytes: data.length,
            sha256: createHash('sha256').update(data).digest('hex'), dataBase64: data.toString('base64') }], archive: { status: 'complete', errors: [] } };
}
export function livePhotoRecord(snapshot = livePhotoSnapshot()) {
    return { eventId: `photo-${snapshot.productId}-${snapshot.capturedAt}`, dataType: 'product-live-photos', identity: { productIds: [snapshot.productId] },
        source: { requestUrl: 'https://agentseller.temu.com/api/flash/real_picture/detail', pageUrl: 'https://agentseller.temu.com/goods/list', pageProductId: snapshot.productId },
        payload: { success: true, result: snapshot } };
}
export function livePhotoPacket(snapshot = livePhotoSnapshot()) {
    return { schemaVersion: 5, kind: 'full-capture-packet', source: { sourceStoreId, allowedSpuIds: [snapshot.productId] },
        records: [productRecord(snapshot.productId), livePhotoRecord(snapshot)] };
}
