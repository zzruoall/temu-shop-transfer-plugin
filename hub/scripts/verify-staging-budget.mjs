/** 暂存额度、认领切换和请求重放边界使用独立库，测试结束删除自身夹具。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createStagingBudget } from '../lib/staging-budget.mjs';
import { createIngestProtocol } from '../lib/ingest-protocol.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'staging-budget-'));
let isolated, database;
try {
    isolated = await openIsolatedDatabase({ prefix: 'temu_staging_budget', label: '暂存和请求生命周期' });
    const config = path.join(root, 'mysql.json');
    await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name }));
    database = await openMysqlDatabase(config);
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const budget = createStagingBudget({ database, stagingDir: path.join(root, 'data/staging'), accountBytes: 100, globalBytes: 500 });
    const a = await budget.reserve('a', 60);
    await assert.rejects(() => budget.reserve('a', 41), e => e.code === 'staging_account_quota');
    await assert.rejects(() => budget.reserve('a', 101), e => e.status === 413);
    const b = await budget.reserve('b', 100);
    await assert.rejects(() => budget.reserve('c', 100), e => e.code === 'staging_global_quota');
    const ref = 'data/staging/' + 'a'.repeat(64) + '-capture.json';
    await budget.link(a, ref);
    const admit = (account, source, bytes, id) => database.transaction('control', c => budget.admitSource(c, account, source, bytes, id));
    await admit('a', ref, 60, a);
    await assert.rejects(() => admit('b', ref, 60, a), e => e.code === 'staging_reservation_mismatch');
    await assert.rejects(() => admit('a', ref + '.other', 60, a), e => e.code === 'staging_reservation_mismatch');
    await assert.rejects(() => admit('a', ref, 61, a), e => e.code === 'staging_reservation_mismatch');
    await budget.release(a); await budget.release(b);
    const contenders = await Promise.allSettled([budget.reserve('race', 60), budget.reserve('race', 60)]);
    assert.equal(contenders.filter(r => r.status === 'fulfilled').length, 1);
    await budget.release(contenders.find(r => r.status === 'fulfilled').value);

    const options = { database, admission: { acquire: async () => () => {} } };
    const protocol = createIngestProtocol(options), otherInstance = createIngestProtocol(options);
    const input = { storeId: 'temu:123', requestId: randomUUID(), bytes: 60, sha256: 'a'.repeat(64) };
    const ready = await protocol.prepare('plugin', input);
    const lease = await protocol.consume('plugin', ready.token, 60);
    await protocol.begin(lease, input.sha256);
    assert.equal((await otherInstance.prepare('plugin', input)).state, 'reconciling');
    const [[processing]] = await database.query('query', 'SELECT status FROM hub_ingest_requests WHERE id=?', [lease.id]);
    assert.equal(processing.status, 'processing', '其他服务无本地许可不能推断原接收已失败');
    await protocol.cancel('plugin', input.requestId); await lease.finish();
    const expiring = { ...input, requestId: randomUUID() };
    const old = await protocol.prepare('plugin', expiring);
    const oldLease = await protocol.consume('plugin', old.token, 60);
    await oldLease.finish();
    await database.query('control', 'UPDATE hub_ingest_requests SET updated_at=? WHERE id=?', ['2000-01-01T00:00:00.000Z', oldLease.id]);
    assert.equal((await protocol.prepare('plugin', expiring)).state, 'cancelled', '过期未消费许可应退休，不重开旧请求');
    console.log('暂存账户/全局配额、并发预留、原账户文件绑定、跨服务核对、过期退休全部通过');
} finally {
    await database?.close(); await isolated?.drop();
    const relative = path.relative(tmpdir(), root);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) await rm(root, { recursive: true, force: true });
}
