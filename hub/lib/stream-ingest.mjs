import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readCaptureHeader, streamCaptureValues } from './capture-stream.mjs';
import { canonicalTransferJson, TRANSFER_HASH_ALGORITHM } from './transfer-integrity.mjs';
import { parseImportedFiles, redactSensitive } from './parse-capture.mjs';

/** 接收缓冲固定64KiB；摘要及脱敏逐响应处理，不把64MiB原包拼成主进程对象。 */
export async function receiveAccountCapture({ request, lease, stagingDir, linkReservation = null, maxBytes = 64 * 1024 * 1024 }) {
    await mkdir(stagingDir, { recursive: true });
    const id = lease.storageId || randomUUID();
    if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('staging_reservation_invalid');
    const received = path.join(stagingDir, `.receive-${id}.tmp`);
    const normalized = path.join(stagingDir, `.normalize-${id}.tmp`);
    let sink;
    try {
        let receivedBytes = 0;
        const limit = new Transform({ transform(chunk, _encoding, callback) {
            receivedBytes += chunk.length;
            if (receivedBytes > maxBytes || receivedBytes > lease.bytes) return callback(Object.assign(Error('ingest_packet_too_large'), { status: 413 }));
            callback(null, chunk);
        } });
        await pipeline(request, limit, createWriteStream(received, { flags: 'wx', mode: 0o600, highWaterMark: 64 * 1024 }));
        const { metadata, keys } = await readCaptureHeader(received, 'packet');
        if (!keys.length) throw Object.assign(Error('account_packet_envelope_required'), { status: 422 });
        if (metadata.source?.sourceStoreId !== lease.storeId || metadata.source?.pluginInstanceId !== lease.owner) {
            throw Object.assign(Error('ingest_source_mismatch'), { status: 403 });
        }
        let manifest;
        for await (const { value } of streamCaptureValues(received, 'transferIntegrity')) {
            if (manifest) throw Error('duplicate_transfer_manifest');
            manifest = value;
        }
        if (manifest?.algorithm !== TRANSFER_HASH_ALGORITHM || manifest.sha256 !== lease.sha256) throw Object.assign(Error('ingest_request_conflict'), { status: 422 });
        const sourceHash = createHash('sha256'), storedHash = createHash('sha256');
        let storedBytes = 0;
        sink = await open(normalized, 'wx', 0o600);
        const write = async (sourceText, storedText = sourceText) => {
            sourceHash.update(sourceText);
            const bytes = Buffer.from(storedText);
            storedHash.update(bytes); storedBytes += bytes.length;
            if (storedBytes > maxBytes) throw Object.assign(Error('ingest_packet_too_large'), { status: 413 });
            await sink.writeFile(bytes);
        };
        const ids = new Set();
        const allowed = Array.isArray(metadata.source?.allowedSpuIds) ? new Set(metadata.source.allowedSpuIds.map(String)) : null;
        const addId = id => {
            const value = String(id || '').trim();
            if (value && (!allowed || allowed.has(value))) ids.add(value);
            if (ids.size > 1000 || value.length > 255) throw Object.assign(Error('ingest_product_count_exceeded'), { status: 413 });
        };
        // Object.keys会按JSON.stringify规则把整数键排在前面，与现有canonical摘要严格一致。
        const orderedKeys = Object.keys(Object.fromEntries(keys.sort().map(key => [key, null])));
        await write('{');
        for (let index = 0; index < orderedKeys.length; index++) {
            const key = orderedKeys[index];
            await write(`${index ? ',' : ''}${JSON.stringify(key)}:`);
            if (key === 'products' || key === 'records') {
                await write('[');
                let count = 0;
                for await (const { value } of streamCaptureValues(received, new RegExp(`^packet\\.${key}\\.\\d+$`))) {
                    if (count++) await write(',');
                    await write(JSON.stringify(canonicalTransferJson(value)), JSON.stringify(canonicalTransferJson(redactSensitive(value))));
                    if (key === 'products') addId(value?.spuId);
                    // 没有显式名单的历史包只做逐响应身份发现；完整商品合并仍在账户worker中执行。
                    if (key === 'records' && !allowed) {
                        const parsed = parseImportedFiles([{ originalName: 'capture.json', payload: { ...metadata, products: [], records: [value] } }]);
                        parsed.products.forEach(product => addId(product.spuId));
                    }
                }
                await write(']');
            } else {
                const redacted = redactSensitive({ [key]: metadata[key] })[key];
                await write(JSON.stringify(canonicalTransferJson(metadata[key])), JSON.stringify(canonicalTransferJson(redacted)));
            }
        }
        await write('}');
        await sink.close(); sink = null;
        if (sourceHash.digest('hex') !== lease.sha256) throw Object.assign(Error('ingest_transfer_integrity_mismatch'), { status: 422 });
        // 显式范围是采集协议的商品名单，缺少实际资料会由对应worker明确失败，不能静默少收。
        if (allowed) allowed.forEach(addId);
        if (!ids.size) throw Object.assign(Error('no_products'), { status: 422 });
        const hash = storedHash.digest('hex');
        const name = `${hash}-capture.json`;
        if (linkReservation) await linkReservation(lease.storageId, `data/staging/${name}`);
        await rename(normalized, path.join(stagingDir, name));
        return { staged: { sourceRef: `data/staging/${name}`, sourceHash: hash, sourceHashAlgorithm: 'sha256', expectedBytes: storedBytes },
            productIds: [...ids], sourceStoreName: String(metadata.source?.sourceStoreName || metadata.source?.shopName || lease.storeId) };
    } finally {
        await sink?.close();
        await rm(received, { force: true });
        await rm(normalized, { force: true });
    }
}
