/** 逐响应合并必须与既有解析器一致，额外字段仍留在原始资料中。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readCaptureMetadata, streamCaptureValues } from '../lib/capture-stream.mjs';
import { createSingleProductCapture, parseImportedFiles } from '../lib/parse-capture.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'capture-stream-'));
try {
    const file = path.join(root, 'source.json');
    const packet = { kind: 'full-capture-packet', source: { sourceStoreId: 'temu:123', allowedSpuIds: ['111', '222'] },
        products: [{ spuId: '111' }, { spuId: '222' }], records: [
            { payload: { result: { pageItems: [{ productId: 111, productName: 'name', productSkuSummaries: [] }, { productId: 222 }] } } },
            { dataType: 'product-detail', identity: { productIds: ['111'] }, source: { pageProductId: '111', requestUrl: '/visage-agent-seller/product/query' },
                payload: { success: true, result: { productId: '111', productName: 'name', arbitrary: { keep: true } } } }
        ] };
    await writeFile(file, JSON.stringify(packet));
    const metadata = await readCaptureMetadata(file);
    assert.equal(metadata.records, undefined);
    const aggregate = createSingleProductCapture(metadata, '111');
    for await (const { value } of streamCaptureValues(file, /^products\.\d+$/)) aggregate.seed(value);
    for await (const { value } of streamCaptureValues(file, /^records\.\d+$/)) aggregate.record(value);
    const actual = aggregate.finish();
    const expected = parseImportedFiles([{ originalName: 'capture.json', payload: packet }]).products.find(item => item.spuId === '111');
    assert.deepEqual(actual.products, [expected]);
    assert.equal(actual.products[0].publicationData.sourceProduct.arbitrary.keep, true);
    await writeFile(file, JSON.stringify({ records: [{ text: 'x'.repeat(9 * 1024 * 1024) }] }));
    await assert.rejects(async () => { for await (const _entry of streamCaptureValues(file, /^records\.\d+$/)) {} }, /workset_exceeded/);
    await writeFile(file, '{"nested":' + '['.repeat(130) + '0' + ']'.repeat(130) + '}');
    await assert.rejects(() => readCaptureMetadata(file), /depth_exceeded/);
    console.log('流式商品合并、工作集超限和深度限制3项通过');
} finally { await rm(root, { recursive: true, force: true }); }
