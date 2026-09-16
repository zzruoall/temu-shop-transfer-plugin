/**
 * 校验页面请求指纹的规范化行为：请求在扩展存储与页面之间往返后必须得到同一指纹，
 * 而真实内容变化必须改变指纹。全程本地执行，不接触 Temu。
 */
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../../plugin/direct-fingerprint.js', import.meta.url), 'utf8');
const context = vm.createContext({ window: {}, crypto, TextEncoder, JSON, Object, Array, Number, String, Date, Symbol });
vm.runInContext(source, context);
const fingerprint = vm.runInContext('window.__temuDirectFingerprint', context);

/** 模拟请求穿过扩展消息边界的常见表示：JSON 往返。 */
function throughBoundary(value) {
    return JSON.parse(JSON.stringify(value));
}

/**
 * 递归把对象键按倒序重建，用来验证指纹不受键顺序影响。
 * 先按 JSON 形态展开，既模拟真实报文的重排，也避免可观察数组在只遍历属性时被当成空对象。
 */
function shuffleKeys(value) {
    const walk = node => {
        if (Array.isArray(node)) return node.map(walk);
        if (!node || typeof node !== 'object') return node;
        const out = {};
        for (const key of Object.keys(node).sort().reverse()) out[key] = walk(node[key]);
        return out;
    };
    return walk(JSON.parse(JSON.stringify(value)));
}

/**
 * 模拟 Temu 新增请求里的 MobX 可观察数组：真实数据挂在原型与不可枚举属性上，
 * Object.keys 返回空，只有 JSON 序列化（经由 toJSON）才能看到内容。
 * 这是此前线上真实故障的形态，必须保证指纹不会对它视而不见。
 */
function observableArray(items) {
    const proto = Object.create(Array.prototype);
    items.forEach((item, index) => { proto[index] = item; });
    proto.length = items.length;
    proto.toJSON = function toJSON() { return Array.prototype.slice.call(this); };
    const value = Object.create(proto);
    Object.defineProperty(value, '$mobx', { value: { values: items }, enumerable: false });
    return value;
}

const request = {
    productName: 'SUMAX 99ml 芦荟保湿液',
    carouselImageUrls: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    productPropertyReqs: [{ refPid: 1, vidList: [10, 11] }, { refPid: 2, vidList: [] }],
    productSkcReqs: [{
        extCode: 'UAC05',
        productSkuReqs: [
            { extCode: 'UAC05', supplierPrice: 1800, thumbUrl: 'https://example.com/1.jpg', productSkuSpecList: [{ specId: 7 }], productSkuSpecReqs: observableArray([{ parentSpecId: 1, specId: 7, specName: '1pc' }]) },
            { extCode: 'UAC05', supplierPrice: 1800, thumbUrl: 'https://example.com/2.jpg', productSkuSpecList: [{ specId: 8 }] }
        ]
    }],
    productComplianceStatementReq: { protocolVersion: 'V2.0' },
    optionalEmpty: null,
    optionalMissing: undefined
};

const base = await fingerprint(request);
assert.match(base.hash, /^[a-f0-9]{64}$/);

// 1) JSON 往返后指纹必须一致：这是之前的真实故障点。
const roundTripped = await fingerprint(throughBoundary(request));
assert.equal(roundTripped.hash, base.hash, 'JSON 往返后指纹必须一致');

// 2) 键顺序被打乱后指纹必须一致。
const reordered = shuffleKeys(request);
assert.equal((await fingerprint(reordered)).hash, base.hash, '键顺序变化不应影响指纹');

// 3) 原始对象里的 undefined 在序列化时就被丢弃，跨边界副本因此与原件天然一致。
assert.equal((await fingerprint(throughBoundary(request))).hash, base.hash, 'undefined 字段序列化后被丢弃，往返必须一致');
// 3b) “字段为 null”和“没有该字段”是两份不同的报文，必须给出不同指纹，否则会漏检真实差异。
const withNullField = JSON.parse(JSON.stringify(request));
withNullField.optionalMissing = null;
assert.notEqual((await fingerprint(withNullField)).hash, base.hash, 'null 字段不能等同于字段缺失');

// 4) 数组里的 undefined 补成 null 不能改变指纹，也不能让下标前移。
const withArrayHole = { ...request, vidList: [10, undefined, 12] };
const withArrayNull = { ...request, vidList: [10, null, 12] };
assert.equal((await fingerprint(withArrayHole)).hash, (await fingerprint(withArrayNull)).hash, '数组中 undefined 与 null 必须等价');

// 5) 真实内容变化必须改变指纹，否则授权检查形同虚设。
const changedPrice = JSON.parse(JSON.stringify(request));
changedPrice.productSkcReqs[0].productSkuReqs[0].supplierPrice = 1801;
assert.notEqual((await fingerprint(changedPrice)).hash, base.hash, '价格变化必须改变指纹');

const droppedSku = JSON.parse(JSON.stringify(request));
droppedSku.productSkcReqs[0].productSkuReqs.pop();
assert.notEqual((await fingerprint(droppedSku)).hash, base.hash, 'SKU 数量变化必须改变指纹');

const changedImage = JSON.parse(JSON.stringify(request));
changedImage.carouselImageUrls[1] = 'https://example.com/c.jpg';
assert.notEqual((await fingerprint(changedImage)).hash, base.hash, '主图变化必须改变指纹');

// 6) 非有限数字按 JSON 语义写成 null：与显式 null 等价，但不能等同于“字段不存在”。
assert.equal(
    (await fingerprint({ a: NaN, b: Infinity, c: 1 })).hash,
    (await fingerprint({ a: null, b: null, c: 1 })).hash,
    'NaN/Infinity 必须按 JSON 语义写成 null'
);
assert.notEqual(
    (await fingerprint({ a: NaN, b: Infinity, c: 1 })).hash,
    (await fingerprint({ c: 1 })).hash,
    '非有限数字不能等同于字段缺失'
);

// 7) 长度用于指纹不一致时定位差异方向，必须稳定且为正整数。
assert.ok(Number.isInteger(base.length) && base.length > 0, '规范化文本长度必须是正整数');
assert.equal((await fingerprint(reordered)).length, base.length, '指纹一致时长度也必须一致');

// 8) MobX 可观察数组必须参与指纹：Object.keys 看不到它，序列化才看得到。
assert.ok(JSON.stringify(request.productSkcReqs[0].productSkuReqs[0]).includes('parentSpecId'), '可观察数组必须出现在序列化报文中');
assert.deepEqual(Object.keys(request.productSkcReqs[0].productSkuReqs[0].productSkuSpecReqs), [], '可观察数组自身没有可枚举键，用于证明只遍历属性会漏判');
assert.equal((await fingerprint(throughBoundary(request))).hash, base.hash, '含可观察数组的请求 JSON 往返后指纹必须一致');
const changedSpec = JSON.parse(JSON.stringify(request));
changedSpec.productSkcReqs[0].productSkuReqs[0].productSkuSpecReqs[0].specId = 999;
assert.notEqual((await fingerprint(changedSpec)).hash, base.hash, '可观察数组内的规格变化必须改变指纹');
const emptySpec = JSON.parse(JSON.stringify(request));
emptySpec.productSkcReqs[0].productSkuReqs[0].productSkuSpecReqs = [];
assert.notEqual((await fingerprint(emptySpec)).hash, base.hash, '可观察数组被清空必须改变指纹');

console.log('请求指纹检查通过：跨边界往返与键顺序不影响指纹，字段增删改（含可观察数组）必然改指纹');
