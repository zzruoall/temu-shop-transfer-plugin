/** 接收链核对完整canonical摘要和脱敏存储摘要，不能把字节摘要混作业务摘要。 */
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { receiveAccountCapture } from '../lib/stream-ingest.mjs';
import { transferManifest, transferHash } from '../lib/transfer-integrity.mjs';
import { redactSensitive } from '../lib/parse-capture.mjs';
const directory = await mkdtemp(path.join(tmpdir(), 'stream-ingest-'));
try {
    const packet = { '10': 'numeric-key', '2': 'ordered-key', kind: 'full-capture-packet',
        source: { sourceStoreId: 'temu:123', pluginInstanceId: 'instance', allowedSpuIds: ['12345', '23456'] },
        products: [{ spuId: '12345' }, { spuId: '23456' }],
        records: [{ payload: { arbitrary: ['中文', null, 123.45], token: 'not-stored' } }], extra: { b: 1, a: false } };
    const buffer = Buffer.from(JSON.stringify({ packet, transferIntegrity: transferManifest(packet) }));
    const lease = { owner: 'instance', storeId: 'temu:123', bytes: buffer.length, sha256: transferHash(packet) };
    const send = value => receiveAccountCapture({ request: Readable.from([value.subarray(0, 100), value.subarray(100)]), lease, stagingDir: directory });
    const result = await send(buffer);
    const stored = JSON.parse(await readFile(path.join(directory, path.basename(result.staged.sourceRef)), 'utf8'));
    assert.deepEqual(stored, redactSensitive(packet));
    assert.deepEqual(result.productIds, ['12345', '23456']);
    assert.equal(transferHash(stored), transferHash(redactSensitive(packet)));
    const broken = Buffer.from(buffer.toString().replace('numeric-key', 'numeric-bad'));
    await assert.rejects(() => send(broken), /integrity_mismatch/);
    await assert.rejects(() => receiveAccountCapture({ request: Readable.from([buffer]), lease: { ...lease, storeId: 'temu:999' }, stagingDir: directory }), /source_mismatch/);
    console.log('流式接收完整性、脱敏、跨店拒绝通过');
} finally { await rm(directory, { recursive: true, force: true }); }
