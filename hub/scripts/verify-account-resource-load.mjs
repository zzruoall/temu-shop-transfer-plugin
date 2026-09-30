/** 大包使用真实流式接收和真实账户worker；Linux结果才可作为受限环境证据，不连接生产库。 */
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalTransferJson } from '../lib/transfer-integrity.mjs';
import { receiveAccountCapture } from '../lib/stream-ingest.mjs';
import { createAccountProcessSupervisor } from '../lib/account-process-supervisor.mjs';
import { readCgroupSample } from '../lib/runtime-resource-budget.mjs';
const root = await mkdtemp(path.join(tmpdir(), 'account-load-'));
const canonical = value => JSON.stringify(canonicalTransferJson(value));
const source = { sourceStoreId: 'temu:123', pluginInstanceId: 'load-instance', allowedSpuIds: ['123456'] };
let supervisor, timer, peakRss = 0, peakCgroup = 0;
const delays = [], results = [];
let last = performance.now();
try {
    timer = setInterval(() => {
        const now = performance.now(); delays.push(Math.max(0, now - last - 100)); last = now;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }, 100);
    for (const mib of [9, 63.5]) {
        const input = path.join(root, `envelope-${mib}.json`), file = await open(input, 'wx');
        const hash = createHash('sha256');
        let packetBytes = 0;
        const write = async text => { hash.update(text); packetBytes += Buffer.byteLength(text); await file.writeFile(text); };
        await file.writeFile('{"packet":');
        await write('{"kind":"full-capture-packet","products":[{"spuId":"123456"}],"records":[');
        const record = canonical({ dataType: 'unrelated', payload: { padding: 'x'.repeat(32 * 1024) } });
        let count = 0;
        while (packetBytes + record.length + 1024 < mib * 1024 * 1024) await write(`${count++ ? ',' : ''}${record}`);
        const detail = { dataType: 'product-detail', identity: { productIds: ['123456'] }, source: { pageProductId: '123456', requestUrl: '/visage-agent-seller/product/query' },
            payload: { success: true, result: { productId: '123456', productName: 'load fixture', unknownField: 'preserved' } } };
        await write(`${count ? ',' : ''}${canonical(detail)}],"source":${canonical(source)}}`);
        const sha256 = hash.digest('hex');
        await file.writeFile(`,"transferIntegrity":${JSON.stringify({ algorithm: 'sha256-json-v1', sha256 })}}`); await file.close();
        const bytes = (await stat(input)).size, start = Date.now();
        assert.ok(bytes < 64 * 1024 * 1024);
        const received = await receiveAccountCapture({ request: createReadStream(input),
            lease: { storeId: source.sourceStoreId, owner: source.pluginInstanceId, bytes, sha256 }, stagingDir: path.join(root, 'data/staging') });
        let resolveReply, rejectReply;
        const reply = new Promise((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
        const deadline = setTimeout(() => rejectReply(Error('worker_timeout')), 180000);
        supervisor = createAccountProcessSupervisor({ sourceRoot: root, workerOldSpaceMiB: 128, maxAccountProcesses: 1,
            workerPath: fileURLToPath(new URL('../workers/account-worker.mjs', import.meta.url)),
            onReply: message => { if (message.type === 'prepared') resolveReply(message); else if (message.type === 'failed') rejectReply(Error(message.reason)); } });
        const launched = await supervisor.spawnFor('load-account', { workId: `load-${mib}`, operation: 'start', direction: 'ingest',
            spuId: '123456', storeId: source.sourceStoreId, ...received.staged });
        assert.equal(launched.started, true);
        let result;
        try { result = await reply; } finally { clearTimeout(deadline); }
        const artifact = JSON.parse(await readFile(path.join(root, result.result.preparedRef), 'utf8'));
        assert.equal(artifact.parsed.products[0].publicationData.sourceProduct.unknownField, 'preserved');
        const sample = await readCgroupSample();
        peakCgroup = Math.max(peakCgroup, Number(sample.memoryCurrentBytes || 0));
        await supervisor.stopAll(); supervisor = null;
        results.push({ inputBytes: bytes, durationMs: Date.now() - start, preserved: true });
    }
    delays.sort((a, b) => a - b);
    const p95 = delays[Math.floor(delays.length * .95)] || 0;
    assert.ok(p95 < 2000, `event_loop_p95=${p95}`);
    console.log(JSON.stringify({ passed: true, platform: process.platform, results, peakParentRss: peakRss, sampledCgroupBytes: peakCgroup,
        timerDelayP95Ms: p95, cgroup: await readCgroupSample(), productionChanged: false, realPlatformCalls: 0 }, null, 2));
} finally {
    clearInterval(timer); await supervisor?.stopAll();
    const relative = path.relative(tmpdir(), root);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await rm(root, { recursive: true, force: true });
}
