/** 从真实后台源码提取上传链路，以内存假 fetch 和虚拟时钟验证超时及串行恢复，不访问网络或浏览器存储。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const background = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');

/** 按已有函数边界提取生产实现，边界变化时直接失败，避免测试意外执行后台启动逻辑。 */
function sourceBetween(startMarker, endMarker) {
    const start = background.indexOf(startMarker);
    const end = background.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `源码边界缺失：${startMarker}`);
    return background.slice(start, end);
}

const source = [
    sourceBetween('async function diagnosticFetch(', 'async function clearCaptureLogs('),
    sourceBetween('async function authenticatedIngestFetch(', 'async function testIngestConnection('),
    sourceBetween('function stampPacketName(', 'async function maybeAutoPushFullPacket(')
].join('\n');

/** 可控承诺模拟响应头和正文分阶段到达，不依赖真实时间或真实 HTTP。 */
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

/** 仅排空有限轮微任务；生产代码若卡死，断言失败而不是让验证进程无限等待。 */
async function flush() {
    for (let i = 0; i < 100; i++) await Promise.resolve();
}

/** 每个用例独立创建队列、时钟及假网络，连续提交两次上传以验证失败不会阻塞下一任务。 */
async function verifyScenario(mode) {
    const headers = deferred();
    const body = deferred();
    const timers = new Map();
    const scheduled = [];
    const cleared = [];
    const requests = [];
    const logs = [];
    const outcomes = [];
    let now = 0, timerId = 0, bodyReads = 0, aborted = 0;
    const manifest = { algorithm: 'sha256', sha256: 'fixture-sha256' };
    const receipt = {
        reused: true, batchId: 'fixture-batch', warnings: ['fixture-warning'],
        transferIntegrity: { verified: true, algorithm: manifest.algorithm, receivedSha256: manifest.sha256 }
    };
    const networkError = new TypeError('fixture-network-error');

    /** 只推进虚拟期限；正文到达不创建新期限，才能发现错误的分段计时实现。 */
    async function advanceTo(target) {
        assert.ok(target >= now);
        now = target;
        for (const [id, timer] of [...timers]) {
            if (timer.deadline <= now) {
                timers.delete(id);
                timer.callback();
            }
        }
        await flush();
    }

    const context = vm.createContext({
        AbortController,
        crypto,
        TemuIngestOutbox: { get: async () => null, put: async () => {}, remove: async () => {} },
        getPluginInstanceId: async () => 'fixture-instance',
        getBoundStore: async () => ({ storeId: 'temu:123' }),
        getUtf8ByteLength: value => Buffer.byteLength(value),
        hubJson: async () => ({ state: 'ready', token: 'fixture-permit' }),
        setTimeout(callback, delay) {
            assert.equal(delay, 120000, '实际上传期限必须为120秒');
            const id = ++timerId;
            timers.set(id, { callback, deadline: now + delay });
            scheduled.push({ id, start: now, delay });
            return id;
        },
        clearTimeout(id) { cleared.push(id); timers.delete(id); },
        getIngestSettings: async () => ({ endpoint: 'https://ingest.invalid/fixture', token: 'fixture-token' }),
        bootstrapIngestToken: async settings => settings,
        ensureIngestPermission: async () => true,
        getAllRecords: async () => [{ eventId: 'fixture-event' }],
        packetSourceOptions: async options => options,
        makeFullCapturePacket: records => ({ records, products: [{ spuId: 'fixture-spu' }], source: { shopName: '测试店铺' } }),
        TemuTransferIntegrity: { manifest: async () => manifest },
        TemuOperationLog: { append: async entry => { logs.push(entry); } },
        // VM 中唯一的网络入口完全由内存实现；不提供真实 fetch、模块导入或生产配置。
        fetch(url, options) {
            assert.equal(url, 'https://ingest.invalid/fixture');
            assert.equal(options.method, 'POST');
            assert.ok(options.signal instanceof AbortSignal);
            assert.equal(options.signal.aborted, false);
            assert.equal(options.headers.authorization, 'Bearer fixture-token');
            const payload = JSON.parse(options.body);
            assert.equal(payload.label, '测试批次');
            assert.equal(payload.shopName, '测试店铺');
            assert.deepEqual(payload.transferIntegrity, manifest);
            requests.push(options);
            if (requests.length > 1) {
                return Promise.resolve({ ok: true, status: 200, json: async () => receipt });
            }
            if (mode === 'sync-fetch-error') throw networkError;
            options.signal.addEventListener('abort', () => {
                aborted++;
                // 正文未开始读取时不拒绝无人监听的承诺，模拟浏览器取消当前传输阶段。
                if (bodyReads) body.reject(options.signal.reason);
                else headers.reject(options.signal.reason);
            }, { once: true });
            return headers.promise;
        }
    });
    vm.runInContext(source, context, { filename: 'background-ingest-extracted.js' });
    for (let index = 0; index < 2; index++) {
        context.pushFullPacket({ label: '测试批次' }).then(
            value => { outcomes[index] = { value }; },
            error => { outcomes[index] = { error }; }
        );
    }
    await flush();

    if (mode !== 'sync-fetch-error') {
        assert.equal(requests.length, 1, '首任务等待时后续请求必须仍在串行队列中');
        assert.equal(scheduled.length, 1);
        assert.equal(scheduled[0].start, 0);
        assert.equal(outcomes.length, 0);
    }

    if (mode === 'request-hang') {
        await advanceTo(119999);
        assert.equal(requests.length, 1);
        assert.equal(outcomes.length, 0, '期限前不能提前结束请求');
        await advanceTo(120000);
    } else if (mode === 'network-error') {
        headers.reject(networkError);
        await flush();
    } else if (mode !== 'sync-fetch-error') {
        await advanceTo(80000);
        headers.resolve({
            ok: mode !== 'http-error', status: mode === 'http-error' ? 503 : 200,
            json() { bodyReads++; return body.promise; }
        });
        await flush();
        assert.equal(bodyReads, 1);
        assert.equal(timers.size, 1, '收到响应头后仍需保留正文读取期限');
        assert.equal(scheduled.length, 1, '读取正文不能另起120秒期限');
        await advanceTo(119999);
        assert.equal(requests.length, 1, '正文未结束不得释放串行队列');
        assert.equal(outcomes.length, 0);
        if (mode === 'body-hang') {
            await advanceTo(120000);
        } else {
            if (mode === 'invalid-json') body.reject(new SyntaxError('fixture-invalid-json'));
            else if (mode === 'body-error') body.reject(new TypeError('fixture-body-error'));
            else if (mode === 'http-error') body.resolve({ error: 'fixture-http-error' });
            else if (mode === 'integrity-error') body.resolve({ ...receipt, transferIntegrity: {} });
            else body.resolve(receipt);
            await flush();
        }
    }

    assert.ok(outcomes[0], '首任务必须结束，不能永久挂起');
    assert.ok(outcomes[1]?.value, '首任务结束后下一串行任务必须成功');
    assert.equal(requests.length, 2, '每个任务只发送一次，不能增加自动重发');
    assert.notEqual(requests[0].signal, requests[1].signal, '后续任务不能继承已取消的信号');
    assert.equal(outcomes[1].value.batchId, receipt.batchId);
    assert.equal(scheduled.length, 2, '每个任务只持有一个期限');
    assert.deepEqual(cleared, scheduled.map(timer => timer.id), '成功和错误路径都必须执行finally清理');
    assert.equal(timers.size, 0);

    if (mode === 'request-hang' || mode === 'body-hang') {
        assert.match(outcomes[0].error?.message ?? '', /^ingest_timeout:.*120秒.*结果可能已入库.*不能判定未入库.*只能.*幂等核对重试/);
        assert.equal(aborted, 1);
        assert.equal(requests[0].signal.aborted, true);
    } else if (mode === 'success') {
        assert.deepEqual(JSON.parse(JSON.stringify(outcomes[0].value)), {
            reused: true, batchId: receipt.batchId, batch: null,
            warnings: receipt.warnings, recordCount: 1, productCount: 1
        });
    } else if (mode === 'network-error' || mode === 'sync-fetch-error') {
        assert.equal(outcomes[0].error, networkError, '非超时网络错误保留原异常');
        assert.equal(logs.length, 1);
    } else if (mode === 'http-error') {
        assert.equal(outcomes[0].error?.message, 'fixture-http-error');
        assert.equal(logs[0].httpStatus, 503);
    } else {
        assert.match(outcomes[0].error?.message ?? '', /服务端未确认完整接收采集包/);
    }
    await advanceTo(500000);
    assert.equal(requests[1].signal.aborted, false, '成功任务不得被残留计时器取消');
    if (!mode.endsWith('-hang')) {
        assert.equal(aborted, 0);
        assert.equal(requests[0].signal.aborted, false);
    }
    return { scenario: mode, passed: true, nextSerialTaskSucceeded: true };
}

const results = [];
for (const mode of ['request-hang', 'body-hang', 'success', 'network-error', 'sync-fetch-error', 'body-error', 'invalid-json', 'http-error', 'integrity-error']) {
    results.push(await verifyScenario(mode));
}
console.log(JSON.stringify({ passed: true, deadlineMs: 120000, realNetworkRequests: 0, results }, null, 2));
