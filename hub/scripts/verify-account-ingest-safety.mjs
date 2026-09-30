/** 上传闭环边界：单件处理、取消先到、同事务回滚与请求状态，全部使用隔离库。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createStore } from '../lib/store.mjs';
import { createIngestStaging } from '../lib/ingest-staging.mjs';
import { createAccountIngest } from '../lib/account-ingest.mjs';
import { createAccountRuntime } from '../lib/account-runtime.mjs';
import { createIngestProtocol } from '../lib/ingest-protocol.mjs';
import { transferHash } from '../lib/transfer-integrity.mjs';

let database, isolated, runtime;
const root = await mkdtemp(path.join(tmpdir(), 'account-ingest-safety-'));
const checks = [];
try {
    isolated = await openIsolatedDatabase({ prefix: 'temu_ingest_safety', label: '账户上传闭环' });
    const config = path.join(root, 'mysql.json');
    await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name }));
    database = await openMysqlDatabase(config);
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const store = createStore(root, { database });
    await store.ensure();
    const staging = createIngestStaging({ dataRoot: root });
    const ingest = createAccountIngest({ database, staging, store });
    const protocol = createIngestProtocol({ database, admission: { acquire: async () => () => {} } });
    const owner = 'plugin-safety';
    const storeId = 'temu:9988123';
    await database.query('maintenance', "INSERT INTO hub_map_entries VALUES('ownership',?,?)",
        [storeId, JSON.stringify({ ownerId: 'account-safety', claimedAt: '2026-09-28T00:00:00Z' })]);
    const ids = ['7744886901', '7744886902'];
    const packet = { kind: 'full-capture-packet', source: { sourceStoreId: storeId, allowedSpuIds: ids },
        products: ids.map(spuId => ({ spuId })),
        records: ids.map(spuId => ({ identity: { productIds: [spuId] }, payload: { result: { pageItems: [{ productId: Number(spuId), productName: spuId }] } } })) };
    const input = { requestId: randomUUID(), storeId, bytes: Buffer.byteLength(JSON.stringify(packet)), sha256: transferHash(packet) };
    const permit = await protocol.prepare(owner, input);
    const lease = await protocol.consume(owner, permit.token, input.bytes);
    await protocol.begin(lease, input.sha256);
    const accepted = await ingest.accept({ lease, upload: { payload: packet, originalName: 'two-products.json' }, verified: true });
    lease.finish();
    assert.equal(accepted.state, 'queued');
    assert.equal(accepted.total, 2);
    const [[before]] = await database.query('query', 'SELECT COUNT(*) AS n FROM hub_batch_products');
    assert.equal(Number(before.n), 0);
    checks.push('受理两件只排队，不提前入库');
    const replay = await protocol.prepare(owner, input);
    assert.equal(replay.state, 'queued');
    assert.equal(replay.token, undefined);
    checks.push('受理响应丢失后不重复签发上传许可');
    runtime = createAccountRuntime({ database, sourceRoot: root, idleExitMs: 50,
        workerPath: fileURLToPath(new URL('../workers/account-worker.mjs', import.meta.url)),
        validateWork: ingest.validateWork, onCommit: ingest.commit, onFailure: ingest.failed });
    await runtime.scanOnce();
    let counts;
    for (let i = 0; i < 100; i++) {
        [[counts]] = await database.query('query', "SELECT SUM(status='done') AS done,SUM(status='queued') AS queued FROM hub_account_work");
        if (Number(counts.done)) break;
        await new Promise(resolve => setTimeout(resolve, 30));
    }
    assert.equal(Number(counts.done), 1);
    assert.equal(Number(counts.queued), 1);
    const [[after]] = await database.query('query', 'SELECT COUNT(*) AS n FROM hub_batch_products');
    assert.equal(Number(after.n), 1, '第一个work不能把第二个商品顺带入库');
    checks.push('单次账户执行只入库一个商品');
    const status = await protocol.status(owner, input.requestId);
    assert.equal(status.state, 'queued');
    assert.equal(status.receipt.transferIntegrity.verified, false);
    await assert.rejects(() => protocol.status('other-plugin', input.requestId), error => error.status === 404);
    checks.push('部分完成不假报整包完成，其他实例不能查询');
    await protocol.cancel(owner, input.requestId);
    await runtime.scanOnce();
    const [[cancelled]] = await database.query('query', "SELECT SUM(status='done') AS done,SUM(status='cancelled') AS cancelled FROM hub_account_work");
    assert.equal(Number(cancelled.done), 1);
    assert.equal(Number(cancelled.cancelled), 1);
    checks.push('取消保留已完成商品，停止后续商品');
    const late = { ...input, requestId: randomUUID() };
    await protocol.cancel(owner, late.requestId);
    await assert.rejects(() => protocol.prepare(owner, late), error => error.status === 409);
    checks.push('取消先到留下墓碑，迟到prepare不能复活');
    const a = await staging.stage({ body: packet, originalName: 'corrupt.json' });
    await writeFile(path.join(root, a.sourceRef), '{}');
    await assert.rejects(() => staging.stage({ body: packet, originalName: 'corrupt.json' }), error => error.code === 'staged_payload_hash_mismatch');
    checks.push('损坏的内容寻址文件不能重新签发合法摘要');
    console.log(JSON.stringify({ passed: true, checks, productionChanged: false }, null, 2));
} finally {
    await runtime?.stop();
    await database?.close();
    await isolated?.drop();
    const relative = path.relative(tmpdir(), root);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) await rm(root, { recursive: true, force: true });
}
