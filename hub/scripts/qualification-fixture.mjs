/** 基于已观察到的资质接口字段构造无私人附件的离线样本；附件链接仅为测试域下的虚构文件。 */
export const spuId = '45962715608';
export const sourceProduct = { productId: spuId, productName: '资质采集测试商品', carouselImageUrls: ['https://img.kwcdn.com/main.jpg'],
    productSkcList: [{ productSkcId: '112965156093146', extCode: 'TEST-ARTICLE', productSkuList: [{ productSkuId: '464860473010', extCode: 'SKU-TEST' }] }],
    goodsLayerDecorationVOList: [], goodsLayerDecorationCustomizeI18nVOList: [] };
export function qualificationSnapshot({ id = spuId, at = '2026-10-08T10:00:00.000Z', status = 'complete' } = {}) {
    return { schemaVersion: 1, productId: id, mallId: 'mall-fixture', capturedAt: at, status, reason: status === 'complete' ? '' : '读取被限流',
        items: status === 'failed' ? [] : [{ certType: 1421, summary: { certType: 1421, certName: 'EU PPWR Substances in Packaging', showName: '欧盟包装有害物质成分', uploadStatus: 1, auditStatus: 1,
            allowSiteList: [119], siteCertSaleEffects: [{ sites: [{ siteId: 119, siteName: '韩国' }], saleEffectShowText: '<span>商品因缺失资质，无法上架</span>', showCheckItems: [{ vidList: [{ vname: '甲醛限量' }] }] }] },
            detail: { certType: 1421, certName: 'EU PPWR Substances in Packaging', authCode: 'TEST-CERT-2026', model: 'MODEL-A',
                certNeedUpload: { instruction: '请提交检测报告', certNeedUploadItems: [{ newUploadExample: { uploadRequire: '<p>包装重金属总和不得超过 100 mg/kg。</p>', uploadExamplePicUrl: ['https://bstatic.kwcdn.com/example.png'] } }] },
                productCertFiles: [{ fileName: '证书.pdf', fileUrl: 'https://bstatic.kwcdn.com/cert.pdf' }], inspectReportFiles: [{ fileName: '检测报告.jpg', fileUrl: 'https://img.kwcdn.com/report.jpg' }],
                historyPictures: ['https://img.kwcdn.com/history.jpg'], multiLangProductCertFileMap: { en: [{ fileName: 'English.pdf', fileUrl: 'https://bstatic.kwcdn.com/en.pdf' }] },
                uploadedContents: { note: '已填写的商品说明', files: [{ fileName: '补充.pdf', fileUrl: 'https://bstatic.kwcdn.com/supplement.pdf' }] } }, status: 'complete', reason: '' }] };
}
export function productRecord(id = spuId) {
    return { eventId: `product-${id}`, dataType: 'product-detail', identity: { productIds: [id], goodsIds: [], skcIds: [], skuIds: [] },
        source: { requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query', pageUrl: 'https://agentseller.temu.com/goods/list', pageProductId: id },
        payload: { success: true, result: { ...structuredClone(sourceProduct), productId: id } } };
}
export function qualificationRecord(snapshot = qualificationSnapshot()) {
    return { eventId: `qualification-${snapshot.productId}-${snapshot.capturedAt}`, dataType: 'product-qualifications', identity: { productIds: [snapshot.productId] },
        source: { requestUrl: 'https://agentseller.temu.com/mms/arbok/product_cert/query/list', pageUrl: 'https://agentseller.temu.com/goods/list', pageProductId: snapshot.productId },
        payload: { success: true, result: snapshot } };
}
export function packet(snapshot = qualificationSnapshot(), storeId = 'test-store') {
    return { kind: 'full-capture-packet', source: { sourceStoreId: storeId, sourceStoreName: '离线测试店', allowedSpuIds: [snapshot.productId] },
        records: [productRecord(snapshot.productId), qualificationRecord(snapshot)] };
}
