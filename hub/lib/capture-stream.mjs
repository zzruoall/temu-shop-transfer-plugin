import { createReadStream } from 'node:fs';
import chain from 'stream-chain';
import { parser } from 'stream-json';
import { pick } from 'stream-json/filters/pick.js';
import { ignore } from 'stream-json/filters/ignore.js';
import { streamValues } from 'stream-json/streamers/stream-values.js';
import { streamObject } from 'stream-json/streamers/stream-object.js';

/** 在组装对象之前限制嵌套和单个值的工作集；超限明确失败，不截断来源内容。 */
function tokenBudget({ grouped = false, maxBytes = 16 * 1024 * 1024 } = {}) {
    let depth = 0, units = 0, stringUnits = 0;
    return token => {
        if (token.name === 'startObject' || token.name === 'startArray') {
            if (++depth > 128) throw Error('capture_depth_exceeded');
        }
        if (/^start(?:String|Key|Number)$/.test(token.name)) stringUnits = 0;
        if (typeof token.value === 'string') {
            stringUnits += token.value.length * 2;
            if (stringUnits > maxBytes) throw Error('capture_scalar_workset_exceeded');
        }
        units += 64 + (typeof token.value === 'string' ? token.value.length * 2 : 0);
        if (grouped && units > maxBytes) throw Error('capture_record_workset_exceeded');
        if (token.name === 'endObject' || token.name === 'endArray') depth--;
        if (grouped && depth === 0 && /^(endObject|endArray|endString|endNumber|nullValue|trueValue|falseValue)$/.test(token.name)) units = 0;
        return token;
    };
}

/** 原包始终保存在磁盘；逐响应处理，跳过其他响应时不把整包拼回内存。 */
export function streamCaptureValues(filePath, filter) {
    return chain([createReadStream(filePath, { highWaterMark: 64 * 1024 }),
        parser(), tokenBudget(),
        pick({ filter, maxDepth: 128 }), tokenBudget({ grouped: true }), streamValues()]);
}

/** 头部仅包含元数据，不组装records/products数组；元数据总工作集也有硬上限。 */
export async function readCaptureHeader(filePath, prefix = '') {
    const keys = [], seen = new Set();
    let depth = 0;
    const rootKeys = token => {
        if (token.name === 'startObject' || token.name === 'startArray') depth++;
        if (token.name === 'keyValue' && depth === 1) {
            if (seen.has(token.value)) throw Error('capture_duplicate_root_key');
            seen.add(token.value); keys.push(token.value);
        }
        if (token.name === 'endObject' || token.name === 'endArray') depth--;
        return token;
    };
    const stream = chain([createReadStream(filePath, { highWaterMark: 64 * 1024 }),
        parser(), tokenBudget(), ...(prefix ? [pick({ filter: prefix, maxDepth: 128 })] : []), rootKeys,
        ignore({ filter: /^(records|products)(\.|$)/, maxDepth: 128 }), tokenBudget({ grouped: true }), streamObject()]);
    const metadata = Object.create(null);
    for await (const { key, value } of stream) metadata[key] = value;
    return { metadata, keys };
}

/** 普通商品准备只需要头部元数据；传输规范化额外读取根键清单以保持完整摘要。 */
export async function readCaptureMetadata(filePath) { return (await readCaptureHeader(filePath)).metadata; }
