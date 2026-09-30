/**
 * 上传暂存：把"接收"与"业务入库"分开。
 *
 * 对应计划任务 5（"上传从导入后补登记改为排队后处理"）。
 *
 * 为什么必须拆开：原实现先 `store.importFiles` 写权威表、再补登记账户工作，
 * 于是**商品在账户工作开始之前就已经入库**——账户槽、公平份额、执行许可都还没生效，
 * 业务结果却已提交。复核实测"缺料时库存仍有 1 行"正是这个顺序造成的。
 *
 * 现在改成两段：
 * 1. **暂存段**：已接收正文落盘为不可变文件，算真实字节摘要，登记账户工作；
 *    此阶段不产生任何业务行。
 * 2. **处理段**：账户运行器在专属进程里读取暂存文件，成功后由父端
 *    账户上传结算器按单商品提交业务行。
 *
 * 暂存文件按内容寻址命名（hash 前缀 + 原文件名），重复上传同一内容自然复用。
 */
import { mkdir, readFile, readdir, link, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** 暂存目录：与永久资料分开，便于按配额清理。 */
export const STAGING_DIR = 'data/staging';

export function createIngestStaging({ dataRoot, maxBytes = 64 * 1024 * 1024 } = {}) {
    if (!dataRoot) throw Object.assign(new Error('暂存需要数据根目录'), { code: 'staging_missing_root' });
    const stagingDir = path.join(dataRoot, STAGING_DIR);

    const ensure = () => mkdir(stagingDir, { recursive: true });

    /** 内容寻址的文件名：同一内容重复上传自然复用，不产生重复文件。 */
    function stagingName(buffer, originalName = 'capture.json') {
        const safe = String(originalName || 'capture.json').replace(/[^\w.-]/g, '_').slice(0, 80) || 'capture.json';
        return `${createHash('sha256').update(buffer).digest('hex')}-${safe}`;
    }

    /**
     * 落盘一份暂存包。返回**实际落盘事实**（相对引用、字节摘要、长度）。
     * 相对引用的根是 dataRoot，与 worker 的 WORKER_SOURCE_ROOT 一致。
     */
    async function stage({ body, originalName = 'capture.json', beforeWrite = null } = {}) {
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), 'utf8');
        if (buffer.length > maxBytes) {
            throw Object.assign(new Error('ingest_packet_too_large'), { status: 413, code: 'ingest_packet_too_large' });
        }
        await ensure();
        const name = stagingName(buffer, originalName);
        if (beforeWrite) await beforeWrite({ sourceRef: `${STAGING_DIR}/${name}`, expectedBytes: buffer.length });
        const full = path.join(stagingDir, name);
        // 文件名不是完整性证据：复用前必须比较实际内容，不能给损坏文件重新签发摘要。
        let reused = false;
        const temp = `${full}.tmp-${randomUUID()}`;
        try {
            await writeFile(temp, buffer, { flag: 'wx' });
            try { await link(temp, full); }
            catch (error) { if (error.code !== 'EEXIST') throw error; reused = true; }
        } finally { await rm(temp, { force: true }); }
        const onDisk = await readFile(full);
        if (!buffer.equals(onDisk)) throw Object.assign(Error('staged_payload_hash_mismatch'), { status: 422, code: 'staged_payload_hash_mismatch' });
        return {
            sourceRef: `${STAGING_DIR}/${name}`,
            sourceHash: createHash('sha256').update(onDisk).digest('hex'),
            sourceHashAlgorithm: 'sha256',
            expectedBytes: onDisk.length,
            reused
        };
    }

    /** 读取暂存包正文；不存在时返回 null，由调用方决定隔离而不是继续。 */
    async function read(sourceRef) {
        const full = await sourcePath(sourceRef);
        if (!full) return null;
        try { return await readFile(full); } catch { return null; }
    }

    /** 对外仅返回受控目录内真实路径，worker产物导入不能借软链接读取其他目录。 */
    async function sourcePath(sourceRef) {
        const rel = String(sourceRef || '').trim();
        if (!rel) return null;
        // 只接受本模块命名的暂存引用：拒绝穿越与绝对路径。
        const normalized = path.normalize(rel).replace(/\\/g, '/');
        if (path.isAbsolute(rel) || normalized.split('/').includes('..') || !normalized.startsWith(`${STAGING_DIR}/`)) {
            return null;
        }
        try {
            const root = await realpath(stagingDir);
            const full = await realpath(path.join(dataRoot, normalized));
            const relative = path.relative(root, full);
            if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
            return full;
        } catch { return null; }
    }

    /** worker只回产物引用；父端校验路径、长度、摘要及原工作绑定后才信任解析索引。 */
    async function prepared(work, result) {
        const name = `${createHash('sha256').update(`${work.work_id}:${work.source_hash}`).digest('hex')}.json`;
        if (result?.preparedRef !== `data/prepared/${name}` || !/^[a-f0-9]{64}$/.test(result.preparedHash || '')
            || result.preparedBytes <= 0 || result.preparedBytes > 12 * 1024 * 1024) throw Error('prepared_reference_invalid');
        const directory = await realpath(path.join(dataRoot, 'data', 'prepared'));
        const file = await realpath(path.join(directory, name));
        if (path.dirname(file) !== directory || (await stat(file)).size !== result.preparedBytes) throw Error('prepared_reference_invalid');
        const bytes = await readFile(file);
        if (createHash('sha256').update(bytes).digest('hex') !== result.preparedHash) throw Error('prepared_hash_mismatch');
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (parsed.sourceRef !== work.source_ref || parsed.sourceHash !== work.source_hash || parsed.expectedBytes !== Number(work.expected_bytes)
            || String(parsed.spuId) !== work.item_spu) throw Error('prepared_work_mismatch');
        const source = await sourcePath(work.source_ref);
        if (!source) throw Error('staged_source_missing');
        // 产物已读入有界工作集，后续不再依赖此临时文件；完整原包仍由持久引用保留。
        await rm(file, { force: true });
        return { ...parsed, sourcePath: source };
    }

    /**
     * 清理暂存文件：只删**明确终态**的工作所引用的那些。
     * 未知结果的文件必须保留——它可能已经产生过平台副作用。
     */
    async function release(sourceRef, { hasReferences } = {}) {
        const rel = String(sourceRef || '').trim();
        // 内容寻址文件可被多个请求共享；没有活跃引用核对器时拒绝删除。
        if (!rel || typeof hasReferences !== 'function' || await hasReferences(rel)) return { removed: 0 };
        const full = path.resolve(dataRoot, rel);
        if (path.dirname(full) !== path.resolve(stagingDir)) return { removed: 0 };
        try {
            await rm(full, { force: true });
            return { removed: 1 };
        } catch { return { removed: 0 }; }
    }

    /** 观测：暂存占用（供配额与排障使用）。 */
    async function usage() {
        try {
            await ensure();
            const names = await readdir(stagingDir);
            let bytes = 0;
            for (const name of names) {
                try { bytes += (await stat(path.join(stagingDir, name))).size; } catch { /* 与清理竞争时忽略 */ }
            }
            return { files: names.length, bytes };
        } catch { return { files: 0, bytes: 0 }; }
    }

    return { stage, read, sourcePath, prepared, release, usage, stagingDir };
}
