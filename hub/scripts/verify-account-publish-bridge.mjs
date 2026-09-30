/** 发布桥接隔离验收：仅33917随机测试库，平台调用为零；不写共享报告，不启动server或runtime。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
import { createAccountWorkRepository } from '../lib/account-work-repository.mjs';
import { createAccountPublishBridge } from '../lib/account-publish-bridge.mjs';
import { createIngestStaging } from '../lib/ingest-staging.mjs';
import { openIsolatedDatabase } from './account-process-harness.mjs';

const isolated = await openIsolatedDatabase({ prefix: 'temu_publish_bridge', label: '发布桥接验收' });
const pool = mysql.createPool({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name, connectionLimit: 4 });
const root = await mkdtemp(path.join(tmpdir(), 'ziniao-publish-bridge-'));
let failSql = '';
/** 故障只注入本测试事务，用来证明permit释放失败会回滚job/work/slot，不修改生产代码。 */
const database = {
    query: (_lane, sql, params = []) => pool.query(sql, params),
    async withConnection(_lane, action) {
        const connection = await pool.getConnection();
        try { return await action(connection); } finally { connection.release(); }
    },
    async transaction(_lane, action) {
        const conn = await pool.getConnection();
        try {
            await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
            await conn.beginTransaction();
            const connection = { query(sql, params = []) {
                if (failSql && sql.includes(failSql)) throw new Error('injected_transaction_failure');
                return conn.query(sql, params);
            } };
            const result = await action(connection);
            await conn.commit();
            return result;
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
    }
};

const results = [];
/** 按真实因果顺序执行；失败立即停止，防止前置未完成仍把后续空操作算作通过。 */
async function check(name, action) { await action(); results.push(name); console.log(`PASS ${name}`); }

try {
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const staging = createIngestStaging({ dataRoot: root });
    const bridge = createAccountPublishBridge({ database, staging, maxUnsettledPublishes: 1 });
    const repo = createAccountWorkRepository(database);
    const products = ['100001', '100002'].map(spuId => ({ spuId, title: spuId, ready: true, images: [],
        publicationData: { sourceProduct: { productId: spuId } } }));
    const store = { getBatch: async id => ({ sourceStoreId: `temu:source-${id}`, products }),
        listOverview: async () => ({}), verifyBatchTransfer: async (_batch, items) => items };
    const queue = createJobQueue(root, store, { database, accountExecution: bridge });
    const identities = {};
    for (const [name, mall] of [['A', '123456'], ['B', '234567'], ['C', '345678']]) {
        const ownerId = `owner-${name}`;
        for (const storeId of [`temu:${mall}`, `temu:source-${name}`]) {
            await pool.query("INSERT INTO hub_map_entries(domain,entry_key,body) VALUES('ownership',?,?)",
                [storeId, JSON.stringify({ ownerId, claimedAt: '2026-09-28T00:00:00.000Z' })]);
        }
        const identity = { storeId: `temu:${mall}`, mallId: mall, storeName: name, pageStoreName: name,
            pluginInstanceId: `plugin-${name}`, pluginVersion: '10.10.61', pluginDetected: true, identityMatched: true,
            executionMode: 'plugin-api', executionRunProtocol: 1, schedulingProtocol: 1,
            executionRunId: `real-publish-run-${name}-0000` };
        await queue.registerAgent(identity);
        await queue.controlExecutionRun({ ...identity, action: 'start', previousRunId: '' });
        identities[name] = identity;
    }

    /** 只创建真实队列任务，账户字段不从客户端传入，由桥接读取ownership冻结。 */
    const create = (name, ids = ['100001']) => queue.createJob({ sourceStoreId: `temu:source-${name}`,
        targetStoreId: identities[name].storeId, targetStoreName: name, sourceBatchId: name, spuIds: ids,
        requireOnline: true, directCreate: true, complianceVersion: 'V2.0', clientRequestId: `publish-request-${name}-0000` }, { userId: `owner-${name}` });
    const getWork = async (jobId, spu = '100001') => (await pool.query('SELECT * FROM hub_account_work WHERE job_id=? AND item_spu=?', [jobId, spu]))[0][0];
    const claim = name => queue.claimJobs({ ...identities[name], claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: 0, pendingUploadBytes: 0 });
    /** 模拟运行器精确领取与真实摘要回执；不假设prepared会结算done。 */
    async function prepare(work) {
        const runtime = await repo.runtimeOf(work.account_id);
        const result = await repo.claimAccountWork(work.account_id, { workId: work.work_id, storeId: work.store_id,
            direction: 'publish', runId: work.run_id, workerEpoch: Number(runtime?.worker_epoch || 0), advanceEpoch: true });
        assert.equal(result.claimed, true);
        const epoch = Number((await repo.runtimeOf(work.account_id)).worker_epoch);
        const prepared = await database.transaction('maintenance', connection => bridge.onPrepared({ connection, work: result.work, workerEpoch: epoch,
            result: { sourceRead: true, sourceRef: work.source_ref, contentHash: work.source_hash, byteLength: Number(work.expected_bytes) } }));
        assert.deepEqual(prepared, { prepared: true, keepRunning: true });
    }

    let a, b, aWork, bWork, aBase, bBase, aAttempt, bAttempt;
    await check('create同事务冻结真实轮次和目标账户，未prepared不能claim', async () => {
        a = await create('A', ['100001', '100002']);
        aWork = await getWork(a.id);
        assert.equal(aWork.account_id, 'owner-A');
        assert.equal(aWork.run_id, identities.A.executionRunId);
        assert.equal(aWork.execution_run_id, aWork.run_id);
        assert.ok(aWork.source_ref && aWork.source_hash);
        assert.equal((await claim('A')).claimed.length, 0);
        assert.equal((await pool.query('SELECT COUNT(*) AS n FROM hub_account_work WHERE job_id=?', [a.id]))[0][0].n, 2);
    });

    await check('prepared保留running槽，只领取当前work而非同job其他SPU', async () => {
        await prepare(aWork);
        assert.equal((await repo.workOf(aWork.work_id)).status, 'running');
        assert.equal((await repo.runtimeOf('owner-A')).current_work_id, aWork.work_id);
        const response = await claim('A');
        assert.equal(response.claimed.length, 1);
        assert.equal(response.claimed[0].spuId, '100001');
        aBase = { ...identities.A, jobId: a.id, spuId: '100001', claimToken: response.claimed[0].claimToken };
        await queue.reportProgress({ ...aBase, status: 'received', snapshotSha256: response.claimed[0].transferIntegrity.sha256 });
    });

    await check('begin幂等原attempt，unknown同时保留槽和持久permit', async () => {
        const input = { ...aBase, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: 'authorization-A-0000' };
        aAttempt = await queue.directProgress(input);
        assert.equal((await queue.directProgress(input)).attemptId, aAttempt.attemptId);
        await queue.directProgress({ ...aBase, phase: 'unknown', attemptId: aAttempt.attemptId });
        assert.equal((await repo.workOf(aWork.work_id)).status, 'unknown');
        assert.equal((await repo.runtimeOf('owner-A')).state, 'unknown');
        assert.equal(await repo.pendingPlatformLeases(), 1);
    });

    await check('unknown占据全局permit总额，其他账户prepared后begin仍等待', async () => {
        b = await create('B'); bWork = await getWork(b.id); await prepare(bWork);
        const response = await claim('B');
        bBase = { ...identities.B, jobId: b.id, spuId: '100001', claimToken: response.claimed[0].claimToken };
        await queue.reportProgress({ ...bBase, status: 'received', snapshotSha256: response.claimed[0].transferIntegrity.sha256 });
        assert.equal((await queue.directProgress({ ...bBase, phase: 'begin', requestHash: 'b'.repeat(64), authorizationKey: 'authorization-B-0000' })).state, 'waiting');
        assert.equal(await repo.pendingPlatformLeases(), 1);
        await assert.rejects(queue.directProgress({ ...aBase, phase: 'created', attemptId: 'wrong', productId: '88888888', verified: true }));
    });

    await check('旧轮停止后原attempt成功仍可原子结算，重复反馈不重复释放', async () => {
        await queue.controlExecutionRun({ ...identities.A, action: 'stop' });
        const input = { ...aBase, phase: 'created', attemptId: aAttempt.attemptId, productId: '88888888', verified: true };
        await queue.directProgress(input);
        await queue.directProgress(input);
        assert.equal((await repo.workOf(aWork.work_id)).status, 'done');
        assert.equal((await repo.runtimeOf('owner-A')).state, 'idle');
        assert.equal(await repo.pendingPlatformLeases(), 0);
        assert.equal((await queue.getJob(a.id)).items.find(item => item.spuId === '100001').status, 'uploaded');
    });

    await check('释放permit时故障，job/work/slot四方整体回滚', async () => {
        bAttempt = await queue.directProgress({ ...bBase, phase: 'begin', requestHash: 'b'.repeat(64), authorizationKey: 'authorization-B-0000' });
        failSql = "UPDATE hub_resource_leases SET state='released'";
        try { await assert.rejects(queue.directProgress({ ...bBase, phase: 'created', attemptId: bAttempt.attemptId, productId: '99999999', verified: true }), /injected_transaction_failure/); }
        finally { failSql = ''; }
        assert.equal((await repo.workOf(bWork.work_id)).status, 'running');
        assert.equal((await repo.runtimeOf('owner-B')).state, 'running');
        assert.equal(await repo.pendingPlatformLeases(), 1);
        assert.equal((await queue.getJob(b.id)).items[0].directState, 'creating');
        await queue.directProgress({ ...bBase, phase: 'rejected', attemptId: bAttempt.attemptId, reason: '平台明确拒绝' });
        assert.equal((await repo.workOf(bWork.work_id)).status, 'failed');
        assert.equal((await repo.runtimeOf('owner-B')).state, 'idle');
        assert.equal(await repo.pendingPlatformLeases(), 0);
    });

    await check('创建事务失败不留下job或可执行work，取消queued同步作废', async () => {
        failSql = 'INSERT INTO hub_jobs';
        try { await assert.rejects(create('C'), /injected_transaction_failure/); } finally { failSql = ''; }
        assert.equal((await pool.query("SELECT COUNT(*) AS n FROM hub_account_work WHERE account_id='owner-C'"))[0][0].n, 0);
        const c = await create('C');
        const work = await getWork(c.id);
        await queue.cancelJob(c.id, { userId: 'owner-C' });
        assert.equal((await repo.workOf(work.work_id)).status, 'cancelled');
    });

    await check('旧epoch准备回执拒绝，取消prepared工作同时释放running业务槽', async () => {
        const c = await create('C');
        const work = await getWork(c.id);
        await prepare(work);
        const epoch = Number((await repo.runtimeOf('owner-C')).worker_epoch);
        await assert.rejects(database.transaction('maintenance', connection => bridge.onPrepared({ connection, work,
            workerEpoch: epoch - 1, result: { sourceRead: true, sourceRef: work.source_ref, contentHash: work.source_hash, byteLength: Number(work.expected_bytes) } })), /stale_worker/);
        await queue.cancelJob(c.id, { userId: 'owner-C' });
        assert.equal((await repo.workOf(work.work_id)).status, 'cancelled');
        assert.equal((await repo.runtimeOf('owner-C')).state, 'idle');
    });

    await check('worker失败回调与运行器失败结算使用同一事务更新业务项', async () => {
        const c = await create('C');
        const work = await getWork(c.id);
        const epoch = Number((await repo.runtimeOf('owner-C')).worker_epoch);
        const claimed = await repo.claimAccountWork('owner-C', { workId: work.work_id, runId: work.run_id, workerEpoch: epoch });
        assert.equal(claimed.claimed, true);
        await database.transaction('maintenance', async connection => {
            await repo.settleInTransaction(connection, { workId: work.work_id, state: 'failed', accountId: 'owner-C', runId: work.run_id, workerEpoch: epoch });
            await bridge.onFailure({ connection, work, reason: 'worker_crashed' });
        });
        assert.equal((await queue.getJob(c.id)).items[0].status, 'failed');
        assert.equal((await repo.runtimeOf('owner-C')).state, 'idle');
    });

    await check('预检判重没有平台attempt许可，仍原子结束当前work并释放槽', async () => {
        const c = await create('C');
        const work = await getWork(c.id);
        await prepare(work);
        const response = await claim('C');
        const received = response.claimed[0];
        const base = { ...identities.C, jobId: c.id, spuId: '100001', claimToken: received.claimToken };
        await queue.reportProgress({ ...base, status: 'received', snapshotSha256: received.transferIntegrity.sha256 });
        await queue.directProgress({ ...base, phase: 'duplicate_exists', reason: '平台查到同货号' });
        assert.equal((await repo.workOf(work.work_id)).status, 'done');
        assert.equal((await repo.runtimeOf('owner-C')).state, 'idle');
        assert.equal(await repo.pendingPlatformLeases(), 0);
    });

    await check('两个账户并发begin不能突破一个持久permit的硬上限', async () => {
        const inputs = [];
        for (const name of ['B', 'C']) {
            const job = await create(name);
            const work = await getWork(job.id);
            await prepare(work);
            const received = (await claim(name)).claimed[0];
            const base = { ...identities[name], jobId: job.id, spuId: '100001', claimToken: received.claimToken };
            await queue.reportProgress({ ...base, status: 'received', snapshotSha256: received.transferIntegrity.sha256 });
            inputs.push({ ...base, phase: 'begin', requestHash: name.toLowerCase().repeat(64), authorizationKey: `concurrent-${name}-00000000` });
        }
        const replies = await Promise.all(inputs.map(input => queue.directProgress(input)));
        assert.equal(replies.filter(reply => reply.state === 'creating').length, 1);
        assert.equal(replies.filter(reply => reply.state === 'waiting').length, 1);
        assert.equal(await repo.pendingPlatformLeases(), 1);
    });

    console.log(JSON.stringify({ passed: true, checks: results.length, realPlatformCalls: 0 }));
} finally {
    await pool.end();
    await isolated.drop();
    // 只清理本次mkdtemp产生的测试根，禁止把调用方工作目录或任意外部路径交给递归删除。
    if (path.dirname(root) === path.resolve(tmpdir()) && path.basename(root).startsWith('ziniao-publish-bridge-')) await rm(root, { recursive: true, force: true });
}
