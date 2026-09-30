/**
 * 账户专属子进程入口。
 *
 * 边界（对应方案第 3.1 节，务必保持）：
 * - 不监听端口、不创建 MySQL 连接池、不启动全局维护/分发/心跳定时器；
 * - 只处理父进程通过 IPC 下发的本账户任务，消息只含引用不含大包；
 * - 平台新增请求不在此发出——由目标店铺插件执行，本进程只做准备与结果方案。
 *
 * 生命周期：收到 start 处理本账户当前一件；完成后通知父进程并可退出（让位）。
 * 收到 yield 时在安全点退出；进程退出不等于撤销用户轮次。
 */
import { realpath, stat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { readCaptureMetadata, streamCaptureValues } from '../lib/capture-stream.mjs';
import { createSingleProductCapture } from '../lib/parse-capture.mjs';

const accountId = String(process.env.WORKER_ACCOUNT_ID || '');
const supervisorEpoch = Number(process.env.WORKER_SUPERVISOR_EPOCH || 0);

/** 只接受父进程发来的白名单命令，拒绝任何其他操作。 */
const ALLOWED_OPERATIONS = new Set(['start', 'yield', 'ping']);

let yielding = false;
let busy = false;

/** 回传：只带标识与阶段，不带商品正文、令牌或密码。 */
function reply(message) {
    try { process.send({ protocol: 1, accountId, supervisorEpoch, ...message }); }
    catch { /* 父进程已断开：子进程直接退出，不留挂起句柄 */ process.exit(0); }
}

process.on('message', async message => {
    if (!message || message.protocol !== 1) return;
    // 账户固定绑定：**必须**声明账户且与本进程绑定一致。
    // 缺账户不是"跳过校验"，而是拒绝——否则省略字段就能绕过绑定（复核 T8）。
    if (!message.accountId) {
        reply({ type: 'rejected', reason: 'missing_account', workId: message.workId || '' });
        return;
    }
    if (message.accountId !== accountId) {
        reply({ type: 'rejected', reason: 'account_mismatch', workId: message.workId || '' });
        return;
    }
    // 监督器代次同样必填：重启后旧代次消息一律拒绝，不能推动新任务。
    if (message.supervisorEpoch === undefined || message.supervisorEpoch === null) {
        reply({ type: 'rejected', reason: 'missing_epoch', workId: message.workId || '' });
        return;
    }
    if (Number(message.supervisorEpoch) !== supervisorEpoch) {
        reply({ type: 'rejected', reason: 'stale_epoch', workId: message.workId || '' });
        return;
    }
    if (!ALLOWED_OPERATIONS.has(message.operation)) {
        reply({ type: 'rejected', reason: 'operation_not_allowed', operation: String(message.operation || '') });
        return;
    }
    if (message.operation === 'ping') { reply({ type: 'pong', workId: message.workId || '' }); return; }
    if (message.operation === 'yield') {
        yielding = true;
        reply({ type: 'yielding', workId: message.workId || '' });
        // 空闲时立即退出；正在准备时由 start 的 finally 在安全点退出。
        if (!busy) { reply({ type: 'exiting', workId: message.workId || '' }); process.exit(0); }
        return;
    }

    // start仅处理本账户这一件的准备；实际平台提交仍由目标插件完成。
    if (busy) { reply({ type: 'rejected', reason: 'worker_busy', workId: message.workId || '' }); return; }
    busy = true;
    reply({ type: 'started', workId: message.workId || '', stage: 'prepare' });
    try {
        // 测试可注入纯函数处理器覆盖默认行为。
        const handler = globalThis.__accountWorkerHandler;
        const result = typeof handler === 'function' ? await handler(message) : await prepareAssignedSource(message);
        busy = false;
        reply({ type: 'prepared', workId: message.workId || '', result });
    } catch (error) {
        busy = false;
        reply({ type: 'failed', workId: message.workId || '', reason: String(error?.message || error) });
    } finally {
        if (yielding) {
            // 让位：通知父进程后退出，由父进程回收名额。
            reply({ type: 'exiting', workId: message.workId || '' });
            process.exit(0);
        }
    }
});

/**
 * 默认准备：读取父进程指定的原始文件并产出**可核对**的结果。
 *
 * 为什么不能再回 `{ready:true}`：那种回执既没读文件也没有可验证产出，
 * 上游无法区分"准备好了"与"什么也没做"，业务结果也就永远回不到原表。
 * 上传逐响应解析当前商品并落盘准备结果；上架核对已冻结的下发快照。
 *
 * 只读父进程签发的相对引用，流式核对真实文件边界、长度与摘要；不发平台请求、不连数据库。
 */
async function prepareAssignedSource(message) {
    const sourceRef = String(message?.sourceRef || '').trim();
    if (!sourceRef) {
        // 没有引用时不能假装完成：明确报告缺料，由父进程决定重派或隔离。
        throw new Error('missing_source_ref');
    }
    if (path.isAbsolute(sourceRef) || sourceRef.split(/[\\/]/).includes('..')) {
        throw Object.assign(new Error('source_ref_not_allowed'), { code: 'source_ref_not_allowed' });
    }
    const base = await realpath(String(process.env.WORKER_SOURCE_ROOT || process.cwd()));
    const full = await realpath(path.resolve(base, sourceRef));
    const relative = path.relative(base, full);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw Object.assign(new Error('source_ref_outside_root'), { code: 'source_ref_outside_root' });
    }
    const fact = await stat(full);
    const expected = message.expectedBytes;
    if (!fact.isFile() || fact.size > 64 * 1024 * 1024) throw new Error('source_size_not_allowed');
    if (expected !== undefined && Number(expected) !== fact.size) throw new Error('source_size_mismatch');
    if (message.sourceHashAlgorithm && message.sourceHashAlgorithm !== 'sha256') throw new Error('source_hash_algorithm_not_allowed');
    // 流式摘要避免每个账户为64MiB原包同时分配完整Buffer；读途中增长同样受实际累计字节约束。
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of createReadStream(full, { highWaterMark: 64 * 1024 })) {
        bytes += chunk.length;
        if (bytes > fact.size || bytes > 64 * 1024 * 1024) throw new Error('source_size_mismatch');
        hash.update(chunk);
    }
    const contentHash = hash.digest('hex');
    if (bytes !== fact.size) throw new Error('source_size_mismatch');
    if (message.sourceHash && contentHash !== message.sourceHash) throw new Error('source_hash_mismatch');
    let prepared = {};
    if (message.direction === 'ingest' && message.spuId) {
        const metadata = await readCaptureMetadata(full);
        if (metadata.source?.sourceStoreId && metadata.source.sourceStoreId !== message.storeId) throw Error('capture_source_store_mismatch');
        if (Array.isArray(metadata.source?.allowedSpuIds) && !metadata.source.allowedSpuIds.map(String).includes(String(message.spuId))) throw Error('capture_assigned_product_not_allowed');
        const aggregate = createSingleProductCapture(metadata, message.spuId);
        for await (const { value } of streamCaptureValues(full, /^products\.\d+$/)) aggregate.seed(value);
        for await (const { value } of streamCaptureValues(full, /^records\.\d+$/)) aggregate.record(value);
        const artifact = Buffer.from(JSON.stringify({ sourceRef, sourceHash: contentHash, expectedBytes: bytes,
            spuId: message.spuId, parsed: aggregate.finish() }));
        if (artifact.length > 12 * 1024 * 1024) throw Error('capture_product_workset_exceeded');
        const directory = path.join(base, 'data', 'prepared');
        await mkdir(directory, { recursive: true });
        const name = `${createHash('sha256').update(`${message.workId}:${contentHash}`).digest('hex')}.json`;
        const target = path.join(directory, name), temp = `${target}.${randomUUID()}.tmp`;
        try { await writeFile(temp, artifact, { flag: 'wx' }); await rename(temp, target); }
        finally { await rm(temp, { force: true }); }
        prepared = { preparedRef: `data/prepared/${name}`, preparedHash: createHash('sha256').update(artifact).digest('hex'), preparedBytes: artifact.length };
    }
    // 只回摘要与计数，不回正文：IPC 消息有 64KiB 上限，也不该把商品内容送进信道。
    return {
        sourceRead: true,
        sourceRef,
        contentHash,
        byteLength: bytes,
        preparedAt: new Date().toISOString(),
        workId: String(message?.workId || ''),
        ...prepared
    };
}

// 父进程若已断开，子进程不应变成孤儿：直接退出。
process.on('disconnect', () => process.exit(0));
reply({ type: 'ready', stage: 'idle' });
