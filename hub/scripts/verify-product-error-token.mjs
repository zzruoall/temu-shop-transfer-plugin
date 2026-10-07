/** 独立签名与协议校验测试；错误文案和插件自报身份不能扩大写入授权。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createProductNoticeTokens, parseProductErrorNotice } from '../lib/product-notice-token.mjs';
test('签名持久独立、篡改与过期拒绝，成功字段不属于错误协议', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-notice-key-'));
    let now = 10000;
    try {
        const token = await createProductNoticeTokens(root, { now: () => now, ttlMs: 1000 });
        const ref = { sourceStoreId: 'temu:111', spuId: '1234567890', sourceInstanceId: crypto.randomUUID(),
            sourceVersion: 'digest', noticeEpoch: 0, pluginInstanceId: 'plugin', targetStoreId: 'temu:222' };
        const signed = token.issue(ref);
        assert.equal(token.verify(signed).sourceInstanceId, ref.sourceInstanceId);
        const restarted = await createProductNoticeTokens(root, { now: () => now, ttlMs: 1000 });
        assert.equal(restarted.verify(signed).spuId, ref.spuId);
        assert.throws(() => token.verify('Z' + signed.slice(1)), /authorization_invalid/);
        const body = { pluginInstanceId: 'plugin', noticeToken: signed, eventId: crypto.randomUUID(),
            errorScope: 'product_data', errorCode: 'PRODUCT_SKU_INVALID', reason: '明确商品SKU字段错误' };
        assert.equal(parseProductErrorNotice(body).mark, true);
        assert.equal(parseProductErrorNotice({ ...body, errorCode: '2000135' }).mark, false);
        assert.equal(parseProductErrorNotice({ ...body, errorScope: 'unknown' }).mark, false);
        assert.throws(() => parseProductErrorNotice({ ...body, amount: 1 }), /body_invalid/);
        assert.throws(() => parseProductErrorNotice({ ...body, reason: '' }), /body_invalid/);
        now += 1000; assert.throws(() => token.verify(signed), /authorization_invalid/);
    } finally { await rm(root, { recursive: true, force: true }); }
});
