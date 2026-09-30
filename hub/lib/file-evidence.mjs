import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';

/** 用固定缓冲计算真实字节证据，原包大小不决定主服务常驻内存。 */
export async function fileEvidence(filePath, maxBytes = 64 * 1024 * 1024) {
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(filePath, { highWaterMark: 64 * 1024 })) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw Error('source_size_not_allowed');
        hash.update(chunk);
    }
    return { fileBytes: bytes, fileSha256: hash.digest('hex'), fileSha256Algorithm: 'sha256' };
}
