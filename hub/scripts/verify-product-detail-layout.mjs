/** 详情资料页验收：模块顺序、动态类目、来源边界、空数据和安全输出必须可失败。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { detailFixture } from './product-detail-fixture.mjs';
const context = vm.createContext({ window: {}, URL });
vm.runInContext(await readFile(new URL('../public/product-detail.js', import.meta.url), 'utf8'), context);
const render = context.window.ProductDetailView.render;
const headings = html => [...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1]);

test('参考模块按上下顺序出现，空媒体和未设计模块不占位', () => {
    assert.deepEqual(headings(render(detailFixture)), ['商品素材', '基本信息', '商品属性', '商品规格', '商品包装信息', '敏感属性与体积重量', 'SKU 信息', '货号', '化妆品成分', '详情图文']);
    assert.doesNotMatch(render(detailFixture), /未设计模块|主图视频|尺码表|电子说明书|完整度|待补图/);
    assert.match(render(detailFixture), /CNY 18\.70/);
    assert.match(render(detailFixture), /长 11 cm/);
    assert.match(render(detailFixture), /300 g/);
    assert.match(render(detailFixture), /SUGAR WAX/);
    assert.match(render(detailFixture), /Maltose/);
});

test('没有原始详情时，旧包的属性、规格和多 SKU 仍动态展示', () => {
    const html = render({ title: '衣服', attributes: [{ name: '材质', value: '棉' }, { name: '款式', value: ['圆领', '短袖'] }], skus: [
        { skuId: 'a', specs: [{ name: '颜色', value: '红' }, { name: '尺码', value: 'M' }], price: 0, currency: 'CNY', weight: 0 },
        { skuId: 'b', specs: [{ name: '颜色', value: '蓝' }, { name: '尺码', value: 'XL' }] }
    ] });
    assert.match(html, /材质/);
    assert.match(html, /圆领 \/ 短袖/);
    assert.match(html, /<th scope="col">颜色<\/th>/);
    assert.match(html, /<th scope="col">尺码<\/th>/);
    assert.match(html, /CNY 0\.00/);
    assert.match(html, /0 g/);
    assert.doesNotMatch(html, /容量|化妆品成分|预览图|净重/);
});

test('空包不生成缺失提示、空 SKU 表或不存在模块', () => {
    assert.deepEqual(headings(render({})), []);
    assert.deepEqual(headings(render({ title: '仅标题' })), ['基本信息']);
});

test('已有来源快照不混入历史 SKU、属性、正文与货号', () => {
    const product = structuredClone(detailFixture);
    product.skus = [{ skuId: 'stale', specs: [{ name: '历史规格', value: 'stale' }] }];
    product.attributes = [{ name: '历史属性', value: 'stale' }];
    product.productExtCodes = ['stale'];
    product.detail = { content: 'stale' };
    product.publicationData.sourceProduct.goodsLayerDecorationVOList = [];
    const html = render(product);
    assert.doesNotMatch(html, /stale|历史规格|历史属性|详情图文/);
});

test('SKU Map 与 SKU List 合并同 ID，不能按顺序匹配摘要', () => {
    const product = { skus: [{ skuId: '2', extCode: 'STALE-TWO' }, { skuId: '1', extCode: 'STALE-ONE' }], publicationData: { sourceProduct: { productSkcList: [{ productSkuList: [{ productSkuId: '1', extCode: 'ONE' }], productSkuMap: { two: { productSkuId: '2', extCode: 'TWO' } } }] } } };
    const html = render(product);
    assert.match(html, /<td>1<\/td><td>ONE<\/td>/);
    assert.match(html, /<td>2<\/td><td>TWO<\/td>/);
    assert.doesNotMatch(html, /STALE/);
});

test('同 ID 稀疏 Map 只补缺字段，不覆盖列表的规格、价格、重量', () => {
    const product = structuredClone(detailFixture);
    const skc = product.publicationData.sourceProduct.productSkcList[0];
    skc.productSkuMap = { item: { productSkuId: '33838620843', supplierPrice: 9900, productSkuWhExtAttr: { productSkuNetWeight: { value: 120000 } } } };
    const html = render(product);
    assert.match(html, /CNY 18\.70/);
    assert.match(html, /150g\+45ml/);
    assert.match(html, /300 g/);
    assert.match(html, /120 g/);
    assert.doesNotMatch(html, /99\.00/);
});

test('已有来源快照即使缺字段或显式 null，也不能借历史摘要补齐', () => {
    const product = { title: 'stale', images: ['https://example.com/stale.jpg'], attributes: [{ name: 'stale', value: 'stale' }], detail: { content: 'stale' }, skus: [{ skuId: '1', price: 9900, weight: 99000, thumbUrl: 'https://example.com/stale.jpg', specs: [{ name: 'stale', value: 'stale' }] }], publicationData: { sourceProduct: { productSkcList: [{ productSkuList: [{ productSkuId: '1', supplierPrice: null, productSkuWhExtAttr: { productSkuWeight: null } }] }] } } };
    const html = render(product);
    assert.doesNotMatch(html, /stale|99\.00|99 g|商品素材|商品属性|详情图文|商品规格|敏感属性与体积重量/);
    assert.match(html, /SKU 信息/);
});

test('数字手填属性保留零，其他值后显示扩展说明', () => {
    const html = render({ publicationData: { sourceProduct: { productPropertyList: [{ propName: '容量', propValue: '', numberInputValue: 0, valueUnit: 'ml' }, { propName: '材质', propValue: '其他', valueExtendInfo: '天然纤维' }] } } });
    assert.match(html, /0 ml/);
    assert.match(html, /其他 \/ 天然纤维/);
});

test('物流区按有效展示值出现，未知敏感代码和非法尺寸不占位', () => {
    const wrap = attr => ({ publicationData: { sourceProduct: { productSkcList: [{ productSkuList: [{ productSkuId: '1', productSkuWhExtAttr: attr }] }] } } });
    assert.match(render(wrap({ productSkuSensitiveAttr: { sensitiveName: '易燃' } })), /敏感属性与体积重量/);
    const html = render(wrap({ productSkuSensitiveAttr: { isSensitive: 2 }, productSkuVolume: { len: '', width: 'bad', height: null } }));
    assert.doesNotMatch(html, /敏感属性与体积重量|长 |宽 |高 /);
});

test('图文 contentList 保持子项顺序，旧包正文键继续展示', () => {
    const html = render({ publicationData: { sourceProduct: { goodsLayerDecorationVOList: [{ contentList: [{ text: '第一段' }, { imageUrl: 'https://example.com/detail.png' }, { text: '第三段' }] }] } } });
    assert.match(html, /详情图文/);
    assert.ok(html.indexOf('第一段') < html.indexOf('detail.png'));
    assert.ok(html.indexOf('detail.png') < html.indexOf('第三段'));
    assert.match(render({ detail: { descriptionHtml: '<p>旧包正文</p>' } }), /旧包正文/);
    assert.match(render({ detail: { richText: '旧包富文本', description_text: '旧包文字' } }), /旧包富文本/);
});

test('已采集的多语言轮播容器继续展示，产品译名不能假装图片语言', () => {
    const html = render({ publicationData: { sourceProduct: { carouselImgsI18n: { zh: [{ url: 'https://example.com/zh.jpg' }] }, productI18nList: [{ language: 'de', productName: '名称' }] } } });
    assert.match(html, /商品轮播图/);
    assert.match(html, /zh\.jpg/);
    assert.match(html, /素材语言/);
    assert.doesNotMatch(html, /德语/);
});

test('可用的视频、尺码图和说明书在正确位置显示', () => {
    const product = structuredClone(detailFixture);
    Object.assign(product.publicationData.sourceProduct, {
        carouseVideoVOList: [{ videoUrl: 'https://media.example.com/main.mp4' }], detailVideoVOList: [{ videoUrl: 'https://media.example.com/detail.mp4' }],
        sizeChartImages: ['https://media.example.com/size.png'], productGuideFileNewVOList: [{ fileName: '说明书.pdf', fileUrl: 'https://media.example.com/manual.pdf' }]
    });
    const html = render(product);
    assert.match(html, /controls preload="none"/);
    assert.deepEqual(headings(html), ['商品素材', '基本信息', '商品属性', '商品规格', '尺码表', '商品包装信息', '敏感属性与体积重量', 'SKU 信息', '货号', '化妆品成分', '详情视频', '电子说明书', '详情图文']);
});

test('文本与链接拒绝 XSS、脚本协议和 URL 凭证', () => {
    const html = render({ title: '<img src=x onerror="alert(1)">', images: ['javascript:alert(1)', 'data:image/svg+xml,xx', 'https://user:secret@example.com/a.jpg'], attributes: [{ name: '<script>', value: '</div>' }], detail: { content: '<script>alert(2)</script>' } });
    assert.doesNotMatch(html, /<script>|<img src=x|href="javascript:|data:image|user:secret|onerror="/);
    assert.match(html, /&lt;img/);
});

test('静态入口先加载展示模块，旧检查式详情渲染已删除', async () => {
    const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
    const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.ok(index.indexOf('product-detail.js') < index.indexOf('app.js'));
    assert.match(app, /window\.ProductDetailView\.render\(product\)/);
    assert.doesNotMatch(app, /function renderSkuTable|function renderAttributeList|function renderProductMedia|标准商品字段、来源和完整度检查/);
});
