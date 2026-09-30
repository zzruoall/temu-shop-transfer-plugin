/** 仅在固定回环测试实例新建随机库；不连接真实店铺，验证接收恢复和创建许可超时。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33917, user: 'root' });
const name = `temu_test_receive_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root = await mkdtemp(path.join(tmpdir(), 'temu-receive-'));
const config = path.join(root, 'mysql.json');
await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: name }));
const db = await openMysqlDatabase(config);
let success = false;
try {
    await initializeMysqlSchema(db);
    const products = Array.from({ length: 30 }, (_, i) => ({ spuId: String(8000000000 + i), publicationData: { sourceProduct: { productId: String(8000000000 + i) } } }));
    const store = { getBatch: async () => ({ sourceStoreId: 'source', products }), listOverview: async () => ({ products }), verifyBatchTransfer: async (_batch, items) => items };
    const queue = createJobQueue(root, store, { database: db });
    const shops = Array.from({ length: 4 }, (_, i) => ({ storeId: `temu:${100000 + i}`, mallId: String(100000 + i), storeName: `shop${i}`, pageStoreName: `shop${i}`, pluginInstanceId: `instance${i}`, pluginVersion: '10.10.57', pluginDetected: true, identityMatched: true, executionMode: 'plugin-api' }));
    const jobs = [], claims = [];
    for (const shop of shops) {
        await queue.registerAgent(shop);
        jobs.push(await queue.createJob({ sourceStoreId: 'source', sourceBatchId: 'batch', spuIds: products.map(p => p.spuId), targetStoreId: shop.storeId, targetStoreName: shop.storeName, requireOnline: true, directCreate: true, complianceVersion: 'V2.0' }));
        claims.push((await queue.claimJobs({ ...shop, manualUploadsOnly: true })).claimed);
    }
    assert.equal(claims[0].length, 30);
    const refs = claims[0].map(task => ({ jobId: task.jobId, spuId: task.spuId, claimToken: task.claimToken, directRetrySequence: 0, snapshotSha256: task.transferIntegrity.sha256 }));
    // 模拟一件先经历正常领取租约回收，再一次恢复满额的30件本地持有记录。
    await db.query('maintenance', "UPDATE hub_job_items SET body=JSON_SET(body,'$.claimExpiresAt','2000-01-01T00:00:00.000Z') WHERE job_id=? AND spu_id=?", [jobs[0].id, refs[0].spuId]);
    await queue.claimJobs({ ...shops[0], pendingUploadCount: 30, pendingUploadBytes: 4 * 1024 * 1024 });
    assert.equal((await queue.getJob(jobs[0].id)).items[0].status, 'queued');
    const request = { ...shops[0], pendingUploadCount: 30, pendingUploadBytes: 4 * 1024 * 1024, receivedReceipts: refs };
    const repaired = await queue.claimJobs(request);
    assert.equal(repaired.claimed.length, 0); assert.equal(repaired.receivedReceipts.length, 30);
    assert.ok((await queue.getJob(jobs[0].id)).items.every(item => item.status === 'received'));
    assert.notEqual(repaired.receivedReceipts[0].claimToken, refs[0].claimToken);
    const replay = await queue.claimJobs(request);
    assert.equal(replay.receivedReceipts[0].claimToken, repaired.receivedReceipts[0].claimToken, '恢复响应丢失必须幂等重放');
    // 错摘要、跨店和另一实例均不能利用恢复绕过接收校验。
    assert.equal((await queue.claimJobs({ ...request, receivedReceipts: [{ ...refs[1], snapshotSha256: '0'.repeat(64) }] })).receivedReceipts.length, 0);
    assert.equal((await queue.claimJobs({ ...request, storeId: shops[1].storeId, mallId: shops[1].mallId })).receivedReceipts.length, 0);
    assert.equal((await queue.claimJobs({ ...request, pluginInstanceId: 'stranger' })).receivedReceipts.length, 0);
    const attempts = [];
    for (let i = 0; i < 4; i++) {
        const task = claims[i][i ? 0 : 1];
        const base = { ...shops[i], jobId: task.jobId, spuId: task.spuId, claimToken: task.claimToken };
        if (i) await queue.reportProgress({ ...base, status: 'received', snapshotSha256: task.transferIntegrity.sha256 });
        const begin = { ...base, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: crypto.randomUUID() };
        if (i < 3) attempts.push({ begin, permit: await queue.directProgress(begin) });
        else attempts.push({ begin });
    }
    await assert.rejects(queue.directProgress(attempts[3].begin), /direct_capacity_wait/);
    // 仅模拟前两家超过窗口，第三家仍在执行，不能被维护错误释放。
    for (const job of jobs.slice(0, 2)) await db.query('maintenance', "UPDATE hub_job_items SET updated_at='2000-01-01T00:00:00.000Z',body=JSON_SET(body,'$.directUpdatedAt','2000-01-01T00:00:00.000Z') WHERE job_id=? AND direct_state='creating'", [job.id]);
    assert.equal((await queue.expireDirectPermits()).expired, 2);
    assert.equal((await queue.expireDirectPermits()).expired, 0);
    assert.ok((await queue.directProgress(attempts[3].begin)).attemptId);
    const late = attempts[0];
    assert.equal((await queue.directProgress(late.begin)).state, 'unknown');
    const next = refs[2];
    await assert.rejects(queue.directProgress({ ...shops[0], ...next, phase: 'begin', requestHash: 'b'.repeat(64), authorizationKey: crypto.randomUUID() }), /direct_capacity_wait/);
    await queue.directProgress({ ...late.begin, phase: 'created', attemptId: late.permit.attemptId, productId: '9000000001', verified: true, receiptId: crypto.randomUUID() });
    assert.equal((await queue.getJob(jobs[0].id)).items.find(item => item.spuId === late.begin.spuId).directState, 'created');
    // 人工重试要求重领，旧代次只能释放本地快照，不能恢复成received绕过新的任务代次。
    await queue.directRetry({ storeId: shops[0].storeId, jobId: jobs[0].id, spuId: refs[3].spuId, confirmed: true });
    const stale = await queue.claimJobs({ ...request, receivedReceipts: [refs[3]] });
    assert.equal(stale.receivedReceipts[0].reload, true);
    success = true;
    console.log(JSON.stringify({ passed: true, fullInboxRecovery: 30, recoveryReplay: true, stalePermitsReleased: 2, lateSuccessAccepted: true, sameStoreIsolated: true, realPlatformRequests: 0 }));
} finally {
    await db.close();
    if (success) await admin.query(`DROP DATABASE ${name}`);
    else console.error('保留隔离检查库', name);
    await admin.end();
}
