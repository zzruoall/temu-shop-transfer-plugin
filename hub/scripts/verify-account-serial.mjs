/**
 * 账户串行验证：一个账户同时只允许一家店在执行，另一账户不受影响。
 * 走真实的 begin 路径（directProgress），不直接调内部函数。
 * 需要隔离 MySQL（33917）；不操作真实店铺或平台。
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
import { createSchedulingController } from '../lib/scheduling.mjs';

const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33917, user: 'root' });
const name = `temu_test_serial_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root = await mkdtemp(path.join(tmpdir(), 'temu-serial-'));
const config = path.join(root, 'mysql.json');
await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: name }));
const database = await openMysqlDatabase(config);
try {
    await initializeMysqlSchema(database);
    const products = Array.from({ length: 3 }, (_, n) => ({ spuId: String(9200000000 + n), ready: true, title: '串行验证',
        images: ['x'], skuIds: ['1'], skcIds: ['2'], publicationData: { sourceProduct: { productId: String(9200000000 + n) } } }));
    const store = { getBatch: async () => ({ sourceStoreId: 'source', products }), listOverview: async () => ({ products }),
        verifyBatchTransfer: async (_b, items) => items };

    // 认领关系：账号 A 拥有店 A1/A2；账号 B 拥有店 B1。
    const ownership = {
        findOwner: async storeId => ({ 'temu:70000001': { ownerId: 'acct-A' }, 'temu:70000002': { ownerId: 'acct-A' }, 'temu:70000003': { ownerId: 'acct-B' } }[storeId] || null),
        ownedStoreIds: async accountId => new Set(accountId === 'acct-A' ? ['temu:70000001', 'temu:70000002'] : accountId === 'acct-B' ? ['temu:70000003'] : [])
    };
    // 与 server.mjs 一样注入账户解析器。
    const { createAccountResolver } = await import('../lib/account-resolver.mjs');
    const accountResolver = createAccountResolver({ listAssignments: async () => ({
        'temu:70000001': { ownerId: 'acct-A' }, 'temu:70000002': { ownerId: 'acct-A' }, 'temu:70000003': { ownerId: 'acct-B' } }) });
    const scheduling = createSchedulingController({ initial: 12, max: 12 });
    const queue = createJobQueue(root, store, { database, ownership, accountResolver, scheduler: scheduling });

    const agent = n => ({ storeId: `temu:7000000${n}`, mallId: `7000000${n}`, executionMode: 'plugin-api',
        storeName: `店${n}`, pageStoreName: `店${n}`, pluginInstanceId: `inst-${n}`, pluginVersion: '10.10.65',
        schedulingProtocol: 1, executionRunProtocol: 1, pluginDetected: true, identityMatched: true });
    const runId = n => `execution-run-${String(n).padStart(4, '0')}-aaaa`;
    const agents = [agent(1), agent(2), agent(3)];
    for (const a of agents) await queue.registerAgent(a);
    for (const [i, a] of agents.entries()) await queue.controlExecutionRun({ ...a, action: 'start', executionRunId: runId(i + 1), previousRunId: '' });

    // 每家店各建一个任务并领取到 received，准备 begin。
    const bases = [];
    for (const [i, a] of agents.entries()) {
        const job = await queue.createJob({ sourceStoreId: 'source', sourceBatchId: 'batch', targetStoreId: a.storeId,
            targetStoreName: a.storeName, requireOnline: true, directCreate: true, complianceVersion: 'V2.0', spuIds: [products[i].spuId] });
        const { claimed } = await queue.claimJobs({ ...a, executionRunId: runId(i + 1), claimManualUploads: true, manualUploadsOnly: true,
            pendingUploadCount: 0, pendingUploadBytes: 0 });
        const item = claimed.find(x => x.jobId === job.id);
        assert.ok(item, `店${i + 1} 应能领取任务`);
        await queue.reportProgress({ ...a, executionRunId: runId(i + 1), jobId: job.id, spuId: products[i].spuId,
            claimToken: item.claimToken, status: 'received', snapshotSha256: item.transferIntegrity.sha256 });
        bases.push({ agent: a, runId: runId(i + 1), jobId: job.id, spuId: products[i].spuId, claimToken: item.claimToken });
    }
    const begin = (base, key) => ({ ...base.agent, executionRunId: base.runId, jobId: base.jobId, spuId: base.spuId,
        claimToken: base.claimToken, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: `auth-${key}-${'k'.repeat(20)}` });

    // A 账户第一家店开始执行。
    const first = await queue.directProgress(begin(bases[0], 'a1'));
    assert.ok(first.attemptId || first.state === 'creating', `A 账户第一家店应能开始，实际 ${JSON.stringify(first).slice(0, 120)}`);

    // A 账户第二家店必须等待（同账户串行）。
    const second = await queue.directProgress(begin(bases[1], 'a2'));
    assert.equal(second.state, 'waiting', `A 账户第二家店应等待，实际 ${JSON.stringify(second).slice(0, 160)}`);
    assert.equal(second.scheduling?.reasonCode, 'store_execution_wait', '等待原因应是同账户已有店铺在执行');

    // B 账户必须能同时开始（账户之间并行）。
    const other = await queue.directProgress(begin(bases[2], 'b1'));
    assert.ok(other.attemptId || other.state === 'creating', `B 账户应能并行开始，实际 ${JSON.stringify(other).slice(0, 120)}`);

    console.log(JSON.stringify({ passed: true, accountSerial: true, crossAccountParallel: true,
        sameAccountStoreWait: second.scheduling.reasonCode, realPlatformCalls: 0 }));
} finally {
    await database.close?.();
    await admin.query(`DROP DATABASE ${name}`).catch(() => {});
    await admin.end();
}
// 追加：取消任务接口的店铺归属校验
