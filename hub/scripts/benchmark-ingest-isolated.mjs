/** 隔离并发入库探测：只绑定随机回环端口、只写临时目录，不访问真实店铺或生产服务。 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJobQueue } from '../lib/job-queue.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 子进程只观测内存和事件循环，不给业务代码增加性能统计接口。 */
async function runServer() {
    if (!process.send || process.env.ZINIAO_BIND !== '127.0.0.1' || !process.env.ZINIAO_DATA_ROOT?.includes('temu-load-')) {
        throw new Error('隔离条件不足，拒绝启动');
    }
    const lag = monitorEventLoopDelay({ resolution: 20 });
    lag.enable();
    const timer = setInterval(() => {
        process.send?.({ rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed,
            lagMaxMs: lag.max / 1e6, cpu: process.cpuUsage() });
        lag.reset();
    }, 250);
    timer.unref();
    await import('../server.mjs');
}

/** 每轮使用独立端口与空仓，避免上轮积累的数据量污染并发档位对比。 */
async function freePort() {
    return new Promise((resolve, reject) => {
        const socket = net.createServer();
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', () => {
            const port = socket.address().port;
            socket.close(error => error ? reject(error) : resolve(port));
        });
    });
}

/** 合成商品使用唯一 SPU、货号、SKU；大包通过真实详情与 SKU 数量增加体积，不靠无关填充字段。 */
function packet(index, heavy) {
    const storeId = `load-store-${index}`;
    const rows = Array.from({ length: 20 }, (_, i) => {
        const id = 8000000000 + index * 100 + i;
        return {
            productId: id, goodsId: id + 1000000000, productSkcId: id + 2000000000,
            productName: `Synthetic product ${id}`, productOuterId: `LOAD-${id}`,
            mainImageUrl: `https://images.invalid/load/${id}.jpg`,
            descriptionHtml: `<p>${'Synthetic product description. '.repeat(heavy ? 220 : 24)}</p>`,
            productSkuSummaries: Array.from({ length: heavy ? 60 : 8 }, (_, n) => ({
                productSkuId: id * 100 + n, productSkuOuterId: `SKU-${id}-${n}`,
                thumbUrl: `https://images.invalid/load/${id}-${n}.jpg`,
                productSkuSpecList: [{ parentSpecName: 'Size', specName: `Variant ${n}` }]
            }))
        };
    });
    return JSON.stringify({ fileName: `load-${index}.json`, packet: {
        schemaVersion: 4, kind: 'full-capture-packet', exportMode: 'full-capture',
        source: { sourceStoreId: storeId, sourceStoreName: storeId, shopName: storeId,
            pageUrl: 'https://agentseller.temu.com/goods/list', allowedSpuIds: rows.map(row => String(row.productId)) },
        products: rows.map(row => ({ spuId: String(row.productId), goodsId: String(row.goodsId) })),
        records: rows.map(row => ({ dataType: 'product-detail', identity: { productIds: [String(row.productId)] },
            source: { pageProductId: String(row.productId) }, payload: { result: row } }))
    }});
}

/** 仅结束本脚本创建的子进程；不查杀现有 Node 服务，不删除任何正式目录。 */
async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    for (let i = 0; i < 30; i++) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await delay(100);
    }
    child.kill('SIGKILL');
    for (let i = 0; i < 30; i++) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await delay(100);
    }
    throw new Error(`测试子进程未退出：${child.pid}`);
}

/** 耗时按完整 HTTP 响应计算，错误请求仍计入延迟，不能用成功样本掩盖超时。 */
function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const at = p => sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]) : null;
    return { count: sorted.length, p50Ms: at(.5), p95Ms: at(.95), maxMs: at(1) };
}

/** 固定总上传数与初始库存；探测过程中读商品分页接口，模拟用户仍在浏览商品库。 */
async function scenario(base, concurrency, heavy, total) {
    const dataRoot = await mkdtemp(path.join(base, `c${concurrency}-${heavy ? 'large' : 'small'}-`));
    const port = await freePort();
    const identity = randomUUID();
    const token = randomUUID();
    const origin = `http://127.0.0.1:${port}`;
    let output = '', rss = 0, heap = 0, lag = 0, memoryStopped = false;
    const child = spawn(process.execPath, ['--max-old-space-size=768', fileURLToPath(import.meta.url), '--server'], {
        cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, TEMU_CREDENTIALS: '', TEMU_PLUGIN_TOKENS: path.join(dataRoot, 'tokens.json'),
            TEMU_BASE_PATH: '', ZINIAO_BIND: '127.0.0.1', ZINIAO_PORT: String(port),
            ZINIAO_DATA_ROOT: dataRoot, ZINIAO_WATCH_DIR: path.join(dataRoot, 'inbox'),
            ZINIAO_INGEST_TOKEN: token, ZINIAO_SEED: '0', ZINIAO_INSTANCE_ID: identity }
    });
    const capture = chunk => { output = (output + chunk).slice(-12000); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.on('message', m => {
        rss = Math.max(rss, m.rss || 0); heap = Math.max(heap, m.heap || 0); lag = Math.max(lag, m.lagMaxMs || 0);
        if (rss > 1200 * 1024 * 1024) { memoryStopped = true; child.kill(); }
    });
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
    const call = async (endpoint, options = {}) => {
        const response = await fetch(`${origin}${endpoint}`, { ...options, headers,
            signal: options.signal || AbortSignal.timeout(60000) });
        const body = await response.json();
        return { status: response.status, body };
    };
    let probeStop = false, probePromise = null, mixedPromise = null, heartbeatPromise = null;
    const result = { concurrency, profile: heavy ? 'large' : 'small', total, productsPerRequest: 20,
        requestBytes: Buffer.byteLength(packet(1, heavy)), dataRoot };
    try {
        let ready = false;
        for (let i = 0; i < 80; i++) {
            if (child.exitCode !== null) throw new Error(`启动失败 ${output}`);
            const ping = await call('/api/ingest-info', { signal: AbortSignal.timeout(1000) }).catch(() => null);
            if (ping?.body?.instanceId === identity) { ready = true; break; }
            await delay(100);
        }
        if (!ready) throw new Error('启动等待超时');
        for (let n = 0; n < 5; n++) {
            const seeded = await call('/api/ingest', { method: 'POST', body: packet(10000 + n, heavy) });
            if (seeded.status !== 200 || seeded.body.batch?.productCount !== 20) throw new Error(`种子入库异常 ${JSON.stringify(seeded)}`);
        }
        // 混合负载仅模拟平台回执：六家目标店竞争三个许可，另外一百店发送心跳，不调用平台接口。
        let targets = [];
        if (process.env.LOAD_MIXED === '1') {
            const products = Array.from({ length: 12 }, (_, n) => ({ spuId: String(9100000000 + n), ready: true,
                title: `Frozen ${n}`, images: ['https://images.invalid/mixed.jpg'], skuIds: ['1'], skcIds: ['2'] }));
            const queue = createJobQueue(dataRoot, { getBatch: async () => ({ sourceStoreId: 'mixed-source', products }), listOverview: async () => ({ products: [] }) });
            for (let n = 0; n < 100; n++) {
                const identity = { storeId: `temu:${700000 + n}`, mallId: String(700000 + n), executionMode: 'plugin-api',
                    storeName: `Mixed ${n}`, pageStoreName: `Mixed ${n}`, pluginInstanceId: `mixed-instance-${n}`,
                    pluginVersion: '10.10.53', pluginDetected: true, identityMatched: true };
                await queue.registerAgent(identity);
                if (n < 6) {
                    const job = await queue.createJob({ sourceStoreId: 'mixed-source', sourceBatchId: 'mixed-batch',
                        targetStoreId: identity.storeId, targetStoreName: identity.storeName, spuIds: products.map(p => p.spuId),
                        requireOnline: true, directCreate: true, complianceVersion: 'V2.0' });
                    targets.push({ identity, job });
                }
            }
        }
        const bodies = Array.from({ length: total }, (_, n) => packet(n + 1, heavy));
        const timings = [], failures = [], reads = [], readErrors = [];
        const started = performance.now();
        probePromise = (async () => {
            while (!probeStop) {
                const begin = performance.now();
                try {
                    const response = await call('/api/overview?productLimit=20&productOffset=0', { signal: AbortSignal.timeout(10000) });
                    if (response.status !== 200) readErrors.push(response.status);
                } catch (error) { readErrors.push(error.name); }
                reads.push(performance.now() - begin);
                await delay(1000);
            }
        })();
        const mixed = { created: 0, deferred: 0, peakPublishing: 0, active: 0, heartbeats: 0, heartbeatErrors: [], errors: [] };
        if (targets.length) {
            const post = (endpoint, body) => call(endpoint, { method: 'POST', body: JSON.stringify(body) });
            heartbeatPromise = (async () => {
                let n = 0;
                while (!probeStop) {
                    const identity = { storeId: `temu:${700000 + n}`, mallId: String(700000 + n), executionMode: 'plugin-api',
                        storeName: `Mixed ${n}`, pageStoreName: `Mixed ${n}`, pluginInstanceId: `mixed-instance-${n}`,
                        pluginVersion: '10.10.53', pluginDetected: true, identityMatched: true };
                    try {
                        const beat = await post('/api/agents/register', identity);
                        if (beat.status === 200) mixed.heartbeats++;
                        else mixed.heartbeatErrors.push(beat.status);
                    } catch (error) { if (!probeStop) mixed.heartbeatErrors.push(error.message); }
                    n = (n + 1) % 100;
                    await delay(80);
                }
            })();
            mixedPromise = Promise.allSettled(targets.map(async ({ identity, job }) => {
                const claims = await post('/api/jobs/claim', { ...identity, claimManualUploads: true });
                if (claims.status !== 200 || claims.body.claimed?.length !== 12) throw new Error('模拟任务领取数量错误');
                for (const task of claims.body.claimed) {
                    const base = { ...identity, jobId: job.id, spuId: task.spuId, claimToken: task.claimToken };
                    const received = await post('/api/jobs/report', { ...base, status: 'received' });
                    if (received.status !== 200) throw new Error(`接收回执 ${received.status}`);
                    const authorizationKey = randomUUID();
                    let permit;
                    while (performance.now() - started < 180000) {
                        await post('/api/agents/register', identity);
                        permit = await post('/api/jobs/direct-progress', { ...base, phase: 'begin', authorizationKey, requestHash: 'a'.repeat(64) });
                        if (permit.status === 200) break;
                        if (permit.status !== 429 || permit.body.error !== 'direct_capacity_wait') throw new Error(`许可错误 ${JSON.stringify(permit)}`);
                        mixed.deferred++;
                        await delay(1000);
                    }
                    if (!permit?.body.attemptId) throw new Error('模拟发布等待超时');
                    mixed.active++; mixed.peakPublishing = Math.max(mixed.peakPublishing, mixed.active);
                    await delay(2000);
                    const receipt = await post('/api/jobs/direct-progress', { ...base, phase: 'created',
                        attemptId: permit.body.attemptId, productId: `88${task.spuId}`, verified: true });
                    if (receipt.status !== 200) throw new Error(`结果回执 ${receipt.status}`);
                    mixed.active--; mixed.created++;
                }
            })).then(results => {
                for (const result of results) if (result.status === 'rejected') mixed.errors.push(result.reason.message);
            });
        }
        let cursor = 0, successes = 0;
        await Promise.all(Array.from({ length: concurrency }, async () => {
            while (cursor < bodies.length && performance.now() - started < 150000 && !memoryStopped) {
                const n = cursor++;
                const begin = performance.now();
                try {
                    const response = await call('/api/ingest', { method: 'POST', body: bodies[n] });
                    if (response.status === 200 && response.body.batch?.productCount === 20 && !response.body.reused) successes++;
                    else failures.push({ request: n, status: response.status, error: response.body.error || 'count_or_reused' });
                } catch (error) { failures.push({ request: n, error: error.name }); }
                timings.push(performance.now() - begin);
            }
        }));
        const elapsedMs = Math.round(performance.now() - started);
        if (mixedPromise) await mixedPromise;
        probeStop = true;
        await probePromise;
        if (heartbeatPromise) await heartbeatPromise;
        // 直接读隔离索引核对落盘数量，HTTP 成功不等于并发写入没有丢商品。
        const index = JSON.parse(await readFile(path.join(dataRoot, 'data', 'index.json'), 'utf8'));
        Object.assign(result, { elapsedMs, successes, attempted: cursor, failures, upload: stats(timings),
            pageReads: stats(reads), readErrors, batchesOnDisk: index.batches.length,
            productsOnDisk: index.products.length, expectedProducts: (5 + total) * 20,
            requestsPerSecond: Number((successes * 1000 / elapsedMs).toFixed(2)) });
        if (targets.length) result.mixed = mixed;
    } catch (error) { result.error = String(error.message).slice(0, 1500); }
    finally {
        probeStop = true;
        await stop(child);
        if (probePromise) await probePromise;
        if (heartbeatPromise) await heartbeatPromise;
        Object.assign(result, { peakRssMiB: Math.round(rss / 1024 / 1024), peakHeapMiB: Math.round(heap / 1024 / 1024),
            observedEventLoopMaxMs: Math.round(lag), memoryStopped });
        await writeFile(path.join(dataRoot, 'server.log'), output);
    }
    return result;
}

/** 每档固定负载；达到错误、超时或页面延迟阈值就停止升档，不以压垮本机为目标。 */
async function main() {
    const base = await mkdtemp(path.join(tmpdir(), 'temu-load-'));
    const reportDir = path.join(root, 'test-artifacts');
    await mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `ingest-load-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const report = { createdAt: new Date().toISOString(), node: process.version,
        machine: { logicalCpus: cpus().length, memoryGiB: Number((totalmem() / 2 ** 30).toFixed(1)) },
        limitations: 'Local synthetic short-run HTTP ingestion only; no production, TLS, WAN, real plugin auth, target publish or SSE fanout. Initial 100 products; child heap cap 768 MiB, RSS stop 1200 MiB. Page probes wait for completion then 1s, so slow responses reduce sampling frequency. Not a sustained capacity guarantee.',
        thresholds: { uploadP95Ms: 10000, pageP95Ms: 2000, allowedErrors: 0 }, base, results: [] };
    console.log(JSON.stringify({ reportPath, base }));
    const levels = (process.env.LOAD_LEVELS || '1,5,10,20,50,100').split(',').map(Number);
    const total = Number(process.env.LOAD_TOTAL || 100);
    if (!Number.isInteger(total) || total < 1 || total > 200 || levels.some(n => !Number.isInteger(n) || n < 1 || n > 100)) throw new Error('超过隔离测试边界');
    // 可只复测某种包型，避免已发现稳定性问题后继续扩大无意义的压测负载。
    const profiles = process.env.LOAD_PROFILES === 'small' ? [false] : process.env.LOAD_PROFILES === 'large' ? [true] : [false, true];
    for (const heavy of profiles) {
        for (const concurrency of levels) {
            console.log(JSON.stringify({ starting: concurrency, profile: heavy ? 'large' : 'small' }));
            const result = await scenario(base, concurrency, heavy, total);
            report.results.push(result);
            await writeFile(reportPath, JSON.stringify(report, null, 2));
            console.log(JSON.stringify(result));
            if (result.error || result.memoryStopped || result.successes !== total || result.productsOnDisk !== result.expectedProducts
                || result.upload.p95Ms > 10000 || result.pageReads.p95Ms > 2000 || result.readErrors.length) break;
        }
    }
    console.log(JSON.stringify({ completed: true, reportPath }));
}

if (process.argv.includes('--server')) await runServer();
else await main();
