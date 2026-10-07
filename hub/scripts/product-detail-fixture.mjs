/** 详情布局验收使用脱敏构造资料；覆盖真实接口字段形状，不连接店铺或写入业务库。 */
const image = 'https://img.kwcdn.com/product/fancy/ff5731e2-ac5a-42bc-b647-c477dafe3c64.jpg';
export const detailFixture = {
    spuId: '4251456883', category: '女士剃毛和美容护理套装', skcIds: ['58646307735'],
    publicationData: { sourceProduct: {
        productName: '柠檬蜂蜜脱毛蜜蜡套装，含护理精油，150g+45ml',
        productI18nList: [{ language: 'en', productName: 'Lemon honey hair removal wax kit, with post-wax care oil, 150g+45ml' }],
        imageLanguageList: ['en'], carouselImageUrls: [image, 'https://img.kwcdn.com/product/fancy/c27d77a6-1174-4bee-8d35-6fdd2a48d452.jpg', 'https://img.kwcdn.com/product/fancy/ad5ae961-465d-4186-a9ef-b2683d335ea0.jpg'], materialImgUrl: image,
        productWhExtAttr: { productOrigin: { countryName: '中国大陆', region2Name: '广东省' }, productOuterPackage: { packageShapeName: '盒装', packageTypeName: '独立包装' } },
        productSaleExtAttr: { manufacturingLocation: [{ countryName: '中国大陆' }] },
        productPropertyList: [{ propName: '有可能的使用', propValue: '身体' }, { propName: '功效', propValue: '脱毛' }, { propName: '实物重量', propValue: '≤300g' }, { propName: '系列线', propValue: '欧洲专项' }],
        outerPackageImages: [{ imageUrl: image }],
        productSkcList: [{ productSkcId: '58646307735', extCode: 'UAMCA1', productSkuList: [{
            productSkuId: '33838620843', extCode: 'UAMCA1', supplierPrice: 1870, currencyType: 'CNY', thumbUrl: image,
            productSkuSpecList: [{ parentSpecName: '容量', specName: '150g+45ml' }],
            productSkuWhExtAttr: { productSkuVolume: { len: 110, width: 80, height: 60 }, productSkuWeight: { value: 300000 }, productSkuSensitiveAttr: { isSensitive: 1 } },
            productSkuMultiPack: { skuClassificationName: '单品', numberOfPieces: 1 },
            productSkuNonAuditExtAttr: { cosmeticInfo: [{ cosmeticEnName: 'SUGAR WAX', propertyInfoList: ['Maltose', 'Honey', 'Citrus Limon (Lemon) Fruit Extract', 'Tocopherol', 'Water'].map(name => ({ langPromptMap: { en: name } })) }] }
        }] }],
        goodsLayerDecorationVOList: [{ text: '柠檬蜂蜜脱毛蜜蜡套装', imageUrl: image }],
        unknownFutureModule: { hidden: '未设计模块' }
    } }
};

/** 长标签、多规格和不可信 HTML 仅在隔离预览里使用，不能成为真实商品资料。 */
export const detailBoundaryFixture = structuredClone(detailFixture);
const boundarySource = detailBoundaryFixture.publicationData.sourceProduct;
boundarySource.productName = '长标题边界：' + '商品名称和实际规格需要在所有尺寸完整显示。'.repeat(12);
boundarySource.productPropertyList.push({ propName: 'VeryLongUnbrokenAttributeName'.repeat(8), propValue: '不遮盖右侧属性值' });
const baseSku = boundarySource.productSkcList[0].productSkuList[0];
boundarySource.productSkcList[0].productSkuList = ['红色', '蓝色', '绿色'].map((color, index) => ({ ...structuredClone(baseSku), productSkuId: String(index + 1), productSkuSpecList: [{ parentSpecName: '颜色', specName: color }, { parentSpecName: '尺码', specName: ['M', 'L', 'XL'][index] }] }));
boundarySource.goodsLayerDecorationVOList = [{ contentList: [{ content: '<p>安全正文</p><script>document.body.dataset.unsafe="1"</script><img src="javascript:alert(1)" onerror="alert(2)">' }, { imageUrl: image }, { text: '结束段落' }] }];
