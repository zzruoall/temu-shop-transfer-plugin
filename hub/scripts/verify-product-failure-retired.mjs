/** 停用回执的独立回归：隔离目录中预存历史红标，真实旧签名与畸形正文均不得触发写入。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.mjs';

/** 模拟旧服务已签发且未过期的授权，不依赖已退出服务运行链的签发模块。 */
export function legacyFailureBody(secret, input) {
    const payload = Buffer.from(JSON.stringify({ jobId: randomUUID(), sourceOwnerId: '', targetOwnerId: '',
        sourceClaimId: '', targetClaimId: '', failureEpoch: 0, ...input,
        expiresAt: Date.now() + 60 * 60 * 1000 })).toString('base64url');
    const signature = createHmac('sha256', secret).update(`product-failure-v1:${payload}`).digest('base64url');
    return { pluginInstanceId: input.pluginInstanceId, failureGrant: `${payload}.${signature}`,
        kind: 'rejected', reason: '旧插件迟到的失败回执' };
}

/** 仅用于小型隔离测试库：逐表比较所有行，并检查文件内容与修改时间，捕获同值重写和旁路副作用。 */
export async function snapshotRelayPersistence(root, database = null) {
    const files = {};
    async function visit(directory) {
        for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) await visit(target);
            else {
                const info = await stat(target);
                files[path.relative(root, target)] = { bytes: info.size, modified: info.mtimeMs,
                    digest: createHash('sha256').update(await readFile(target)).digest('hex') };
            }
        }
    }
    await visit(root);
    const tables = {};
    if (database) {
        const [names] = await database.query('maintenance', 'SHOW TABLES');
        for (const name of names.map(row => Object.values(row)[0]).sort()) {
            assert.match(name, /^hub_[a-z_]+$/, '只读取本测试创建的服务端表');
            const [rows] = await database.query('maintenance', `SELECT * FROM \`${name}\``);
            tables[name] = rows.map(row => JSON.stringify(row)).sort();
        }
    }
    return { files, tables };
}

// 被 HTTP 闭环复用时只提供取证函数，避免导入副作用重复启动独立测试服务。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    test('停用服务启动保留历史红标，合法旧签名、异常正文与并发回执均返回410且零写入', { timeout: 30000 }, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'temu-failure-retired-'));
        const token = 'failure-retired-isolated-token', instanceId = randomUUID();
        let child, output = '';
        try {
            const store = createStore(root);
            await store.ensure();
            await store.markProductBlocked({ storeId: 'temu:111', spuId: '1234567890', reason: '停用前的历史红标' });
            const historical = JSON.parse(await readFile(path.join(root, 'data/index.json'), 'utf8')).blockedProducts;
            child = fork(new URL('../server.mjs', import.meta.url), [], { silent: true, windowsHide: true,
                env: { ...process.env, TEMU_CREDENTIALS: '', TEMU_BASE_PATH: '', TEMU_MYSQL_CONFIG: '',
                    ZINIAO_DATA_ROOT: root, ZINIAO_BIND: '127.0.0.1', ZINIAO_TEST_EPHEMERAL: '1',
                    ZINIAO_INSTANCE_ID: instanceId, ZINIAO_INGEST_TOKEN: token, ZINIAO_SEED: '0' } });
            child.stdout.on('data', chunk => { output += chunk; });
            child.stderr.on('data', chunk => { output += chunk; });
            const [{ port, instanceId: actualInstance }] = await Promise.race([once(child, 'message'),
                once(child, 'exit').then(([code]) => { throw Error(`服务退出${code}: ${output}`); })]);
            assert.equal(actualInstance, instanceId);
            assert.deepEqual(JSON.parse(await readFile(path.join(root, 'data/index.json'), 'utf8')).blockedProducts, historical,
                '停用服务启动不能清理历史红标');
            const origin = `http://127.0.0.1:${port}`;
            await fetch(origin + '/api/live', { signal: AbortSignal.timeout(5000) });
            const before = await snapshotRelayPersistence(root);
            const notice = legacyFailureBody(token, { spuId: '1234567890', sourceStoreId: 'temu:111',
                sourceBatchId: 'historical-batch', targetStoreId: 'temu:222', pluginInstanceId: 'old-plugin-instance' });
            const bodies = [JSON.stringify(notice), JSON.stringify({ ...notice, kind: 'unknown' }),
                JSON.stringify({ ...notice, kind: 'preflight_failed' }), '{', '{}', 'null', '[]', 'x'.repeat(20 * 1024)];
            const results = await Promise.all(bodies.map(async body => {
                const response = await fetch(origin + '/api/products/failure', { method: 'POST',
                    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
                    signal: AbortSignal.timeout(5000) });
                return { status: response.status, body: await response.json() };
            }));
            for (const result of results) {
                assert.equal(result.status, 410);
                assert.equal(result.body.error, 'product_failure_retired');
                assert.equal(Object.hasOwn(result.body, 'ok'), false, '不能伪装成已接受的回执');
            }
            assert.deepEqual(await snapshotRelayPersistence(root), before, '停用请求不能改写任何持久化文件');
        } catch (error) {
            error.message += `\n${output.slice(-2000)}`;
            throw error;
        } finally {
            if (child && child.exitCode === null && child.signalCode === null) {
                const exited = once(child, 'exit'); child.kill(); await exited;
            }
            // 只回收本测试创建的临时目录，历史库存与插件文件均不在此目录中。
            assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
            await rm(root, { recursive: true, force: true });
        }
    });
}
