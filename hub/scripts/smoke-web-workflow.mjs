/** 发布后核对真实发布模块的分类出口；只运行纯函数，不伪造错误通知或写生产红标。 */
import assert from 'node:assert/strict';
import { parseProductErrorNotice } from '../lib/product-notice-token.mjs';

const sample = { pluginInstanceId: 'readonly-smoke', noticeToken: 'unused-by-parser', eventId: 'readonly-event-20261007',
    errorScope: 'product_data', errorStage: '提交', errorCode: '2000225', reason: '化妆品成分不存在，请删除：Mentha Piperita (Peppermint) Extract' };
assert.equal(parseProductErrorNotice(sample).mark, true);
assert.equal(parseProductErrorNotice({ ...sample, errorCode: '2000135', reason: '净含量为必填项' }).mark, true);
assert.equal(parseProductErrorNotice({ ...sample, errorStage: '预检' }).mark, false);
assert.equal(parseProductErrorNotice({ ...sample, errorScope: 'unknown' }).mark, false);
assert.equal(parseProductErrorNotice({ ...sample, reason: '登录已过期' }).mark, false);
assert.equal(parseProductErrorNotice({ ...sample, errorCode: '429', reason: '请求过于频繁' }).mark, false);
assert.equal(parseProductErrorNotice({ ...sample, errorCode: 'PRODUCT_FIELD_INVALID' }).mark, true);
console.log(JSON.stringify({ numericErrorClassificationSmoke: true, cases: 7, productionWrites: 0, realPlatformCalls: 0 }));
