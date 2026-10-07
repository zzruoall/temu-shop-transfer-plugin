/** 商品状态身份与合并行边界使用真实状态函数；不通过同货号伪造相同商品。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyNoticeViews, noticeStateKey, productStatusResponse } from '../lib/product-notice-state.mjs';

function fixture() {
    const product = { spuId: '1', spuIds: ['1', '2'], sourceStoreIds: ['source'], batchIds: ['b1', 'b2'], blocked: false };
    const states = Object.fromEntries(['1', '2'].map(id => [noticeStateKey('source', id), {
        sourceStoreId: 'source', spuId: id, sourceInstanceId: `instance-${id}`, sourceVersion: `version-${id}`, noticeEpoch: 1, notice: null }]));
    applyNoticeViews([product], states);
    const ref = { spuId: product.spuId, sourceIdentity: product.sourceIdentity, productKey: product.productKey };
    return { product, states, ref };
}

test('合并行任一原子错误使当前行禁传，标记与解除不更换来源身份', () => {
    const { product, states, ref } = fixture();
    states[noticeStateKey('source', '2')].notice = { reason: 'SKU-2净含量缺失', code: '2000225', at: '2026-10-07T00:00:00Z' };
    applyNoticeViews([product], states);
    const result = productStatusResponse([ref], [product]);
    assert.equal(result.products[0].blocked, true);
    assert.equal(result.products[0].errorNotice.spuId, '2');
    assert.equal(product.sourceIdentity, ref.sourceIdentity);
    states[noticeStateKey('source', '2')].notice = null;
    states[noticeStateKey('source', '2')].noticeEpoch++;
    applyNoticeViews([product], states);
    assert.equal(product.sourceIdentity, ref.sourceIdentity);
    assert.equal(productStatusResponse([ref], [product]).products[0].sendBlocked, false);
});

test('同SPU重新导入、来源换版和归并关联改变均拒绝旧状态引用', () => {
    for (const change of [f => { f.states[noticeStateKey('source', '2')].sourceInstanceId = 'new-instance'; },
        f => { f.states[noticeStateKey('source', '2')].sourceVersion = 'new-version'; },
        f => { f.product.spuIds = ['1']; }, f => { f.product.batchIds = ['new-batch']; }]) {
        const f = fixture(); change(f); applyNoticeViews([f.product], f.states);
        assert.deepEqual(productStatusResponse([f.ref], [f.product]), { products: [], staleIds: ['1'] });
    }
});

test('权限裁剪、删除和伪造投影键不泄露新实例或正文；历史标记仍保留原因', () => {
    const { product, ref } = fixture();
    assert.deepEqual(productStatusResponse([ref], []), { products: [], staleIds: ['1'] });
    assert.deepEqual(productStatusResponse([{ ...ref, productKey: 'f'.repeat(64) }], [product]), { products: [], staleIds: ['1'] });
    product.blocked = true; product.blockedReason = '历史资料缺失';
    product.publicationData = { sensitive: '不应出现在状态接口' }; product.images = ['https://example.invalid/a.jpg'];
    const state = productStatusResponse([ref], [product]).products[0];
    assert.equal(state.blockedReason, '历史资料缺失'); assert.equal(state.blocked, true);
    assert.doesNotMatch(JSON.stringify(state), /sensitive|images|publicationData/);
});
