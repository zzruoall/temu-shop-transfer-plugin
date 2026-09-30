/** 固定回环测试实例和随机新库；验证断线续跑、权限撤销、并发和增量入库，不触发真实店铺请求。 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { createJobQueue, makeProductVersion } from '../lib/job-queue.mjs';
import { createBulkDispatch } from '../lib/bulk-dispatch.mjs';
import { createStore } from '../lib/store.mjs';
const admin = await mysql.createConnection({ host: '127.0.0.1', port: 33917, user: 'root' });
const name = `temu_test_bulk_${Date.now()}`;
await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
const root = await mkdtemp(path.join(tmpdir(), 'temu-bulk-'));
const config = path.join(root, 'mysql.json');
await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: name }));
const db = await openMysqlDatabase(config);
let success = false;
try {
    await initializeMysqlSchema(db);
    const products = Array.from({ length: 105 }, (_, n) => ({ spuId: String(8000000000 + n), title: `P${n}`, ready: false, publicationData: { sourceProduct: { productId: String(8000000000 + n) } } }));
    const store = { getBatch: async () => ({ sourceStoreId: 'source', products }), listOverview: async () => ({ products }), verifyBatchTransfer: async (_batch, items) => items };
    const queue = createJobQueue(root, store, { database: db });
    const identities = Array.from({ length: 4 }, (_, n) => ({ storeId: `temu:${700000 + n}`, mallId: String(700000 + n), storeName: `target${n}`, pageStoreName: `target${n}`, executionMode: 'plugin-api', pluginInstanceId: `instance${n}`, pluginVersion: '10.10.56', pluginDetected: true, identityMatched: true }));
    for (const identity of identities) await queue.registerAgent(identity);
    let loseResponse = true, denied = false;
    const authorize = async () => { if (denied) throw Object.assign(Error('账户权限已撤销'), { status: 403 }); return null; };
    const worker = () => createBulkDispatch({ database: db, store, authorize, queue: { createJob: async (...args) => {
        const job = await queue.createJob(...args);
        if (loseResponse) { loseResponse = false; throw Error('模拟已提交但响应丢失'); }
        return job;
    },
    // 清单提交会核对目标店的页面轮次，桩必须转发到真实队列。
    listAgents: (...args) => queue.listAgents(...args) } });
    let bulk = worker();
    const input = { requestId: crypto.randomUUID(), complianceVersion: 'V2.0', groups: [{ sourceStoreId: 'source', sourceBatchId: 'batch', spuIds: products.map(p => p.spuId) }], targets: identities.map(i => ({ storeId: i.storeId, storeName: i.storeName })) };
    const plan = await bulk.submit(input, '');
    assert.equal((await bulk.submit(input, '')).id, plan.id);
    await assert.rejects(bulk.submit({ ...input, targets: input.targets.slice(0, 1) }, ''), /不同清单/);
    await bulk.tick();
    bulk = worker();
    // 控制测试时钟窗口，不等待生产退避间隔；重启后的同一子任务不能再新建一遍。
    for (let i = 0; i < 18; i++) {
        const [[row]] = await db.query('query', 'SELECT state FROM hub_bulk_dispatch WHERE id=?', [plan.id]);
        const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
        for (const target of state.targets) target.nextAt = '';
        await db.query('maintenance', "UPDATE hub_bulk_dispatch SET state=?,next_run_at='' WHERE id=?", [JSON.stringify(state), plan.id]);
        await bulk.tick();
    }
    const final = await bulk.get(plan.id, '');
    assert.equal(final.status, 'completed'); assert.equal(final.sent, 420); assert.equal(final.jobs, 12);
    const [[counts]] = await db.query('query', 'SELECT COUNT(*) AS n FROM hub_jobs');
    assert.equal(Number(counts.n), 12, '提交后断线不能重复建任务');
    // 再次人工点击已发送的商品必须独立投递；取五件避免测试占满每店真实容量保护。
    const repeatedClick = await bulk.submit({ ...input, requestId: crypto.randomUUID(),
        groups: [{ ...input.groups[0], spuIds: input.groups[0].spuIds.slice(0, 5) }] }, '');
    assert.notEqual(repeatedClick.id, plan.id);
    for (let i = 0; i < 18; i++) {
        // 与第一批相同，只推进隔离库里的调度时钟，不在测试中等待生产退避。
        const [[row]] = await db.query('query', 'SELECT state FROM hub_bulk_dispatch WHERE id=?', [repeatedClick.id]);
        const state = typeof row.state === 'string' ? JSON.parse(row.state) : row.state;
        for (const target of state.targets) target.nextAt = '';
        await db.query('maintenance', "UPDATE hub_bulk_dispatch SET state=?,next_run_at='' WHERE id=?", [JSON.stringify(state), repeatedClick.id]);
        await bulk.tick();
    }
    assert.equal((await bulk.get(repeatedClick.id, '')).sent, 20);
    const [[newCounts]] = await db.query('query', 'SELECT COUNT(*) AS n FROM hub_jobs');
    assert.equal(Number(newCounts.n), 16);
    const [[cancelledCount]] = await db.query('query', "SELECT COUNT(*) AS n FROM hub_job_items WHERE status='cancelled'");
    assert.equal(Number(cancelledCount.n), 0, '新点击不能覆盖上一批');
    // 相同账户请求键跨店竞争时，只能一个成功；不能在同一任务ID下混入两个目标。
    const conflictId = crypto.randomUUID();
    products.push({ spuId: '8000000999', publicationData: { sourceProduct: { productId: '8000000999' } } });
    const conflicting = await Promise.allSettled(identities.slice(0, 2).map(identity => queue.createJob({
        ...input.groups[0], spuIds: ['8000000999'], targetStoreId: identity.storeId, targetStoreName: identity.storeName,
        requestId: conflictId, requireOnline: true, directCreate: true, complianceVersion: 'V2.0'
    }, { principalId: 'conflict-test' })));
    assert.equal(conflicting.filter(result => result.status === 'fulfilled').length, 1);
    assert.match(conflicting.find(result => result.status === 'rejected').reason.message, /请求|编号/);
    // 已取消批次即使旧执行器仍持有租约编号，也不能创建下一片。
    const cancelled = await bulk.submit({ ...input, requestId: crypto.randomUUID() }, '');
    await db.query('maintenance', "UPDATE hub_bulk_dispatch SET lease_id='expired-worker',lease_until='' WHERE id=?", [cancelled.id]);
    await bulk.control(cancelled.id, 'cancel', '');
    await assert.rejects(queue.createJob({ ...input.groups[0], targetStoreId: identities[0].storeId,
        requestId: crypto.randomUUID(), bulkId: cancelled.id, directCreate: true, complianceVersion: 'V2.0'
    }, { bulkLeaseId: 'expired-worker' }), /批次已停止/);
    const cases = [];
    for (const identity of identities) {
        const claimed = (await queue.claimJobs({ ...identity, claimManualUploads: true, manualUploadsOnly: true })).claimed[0];
        const base = { ...identity, jobId: claimed.jobId, spuId: claimed.spuId, claimToken: claimed.claimToken };
        await queue.reportProgress({ ...base, status: 'received', snapshotSha256: claimed.transferIntegrity.sha256 });
        cases.push({ ...base, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: crypto.randomUUID() });
    }
    const permits = await Promise.allSettled(cases.map(input => queue.directProgress(input)));
    assert.equal(permits.filter(p => p.status === 'fulfilled').length, 3, 'MySQL跨店同时许可不得超过3');
    const active = permits.findIndex(p => p.status === 'fulfilled'), waiting = permits.findIndex(p => p.status === 'rejected');
    await queue.directProgress({ ...cases[active], phase: 'unknown', attemptId: permits[active].value.attemptId });
    assert.ok((await queue.directProgress(cases[waiting])).attemptId, '待核对仅隔离本店，不占其他店全局预算');
    // 200店×5000商品只保存清单，接收操作不生成100万明细。
    const many = Array.from({ length: 5000 }, (_, n) => ({ spuId: String(9000000000 + n), publicationData: { sourceProduct: { productId: String(9000000000 + n) } } }));
    const large = createBulkDispatch({ database: db, store: { getBatch: async () => ({ sourceStoreId: 'source', products: many }) }, queue, authorize });
    const huge = await large.submit({ ...input, requestId: crypto.randomUUID(), groups: [{ sourceStoreId: 'source', sourceBatchId: 'large', spuIds: many.map(p => p.spuId) }], targets: Array.from({ length: 200 }, (_, n) => ({ storeId: `target:${n}`, storeName: `shop${n}` })) }, '');
    assert.equal(huge.total, 1000000); assert.equal(huge.jobs, 0);
    denied = true;
    await db.query('maintenance', "UPDATE hub_bulk_dispatch SET next_run_at='' WHERE id=?", [huge.id]);
    await large.tick(); denied = false;
    assert.equal((await large.get(huge.id, '')).targets.filter(t => t.paused).length, 1, '权限变化后停止该目标分发');
    const realStore = createStore(root, { database: db }); await realStore.ensure();
    const capture = (n, title = `item${n}`) => ({ originalName: `capture${n}.json`, payload: { kind: 'full-capture-packet', source: { sourceStoreId: 'inventory' }, records: [{ payload: { result: { pageItems: [{ productId: String(6000000000 + n), productName: title, extCode: `code${n}` }] } } }] } });
    for (let n = 0; n < 5; n++) await realStore.importFiles([capture(n)], { sourceStoreId: 'inventory' });
    await realStore.importFiles([capture(1, 'changed')], { sourceStoreId: 'inventory' });
    const page = await realStore.listOverviewPage(null, new URL('http://local/?productLimit=2'));
    assert.equal(page.productCount, 5, '增量更新不能删除未受影响的商品');
    assert.equal(page.products.length, 2); assert.ok(page.batches.length <= 3);
    assert.equal((await realStore.getProduct('6000000001')).product.title, 'changed');
    // MySQL JSON重排与原包恢复不能让确认时版本和下发时版本无故不同。
    await realStore.importFiles([{ originalName: 'detail.json', payload: { kind: 'full-capture-packet', schemaVersion: 5,
        source: { sourceStoreId: 'detail-source' }, products: [{ spuId: '6000000999' }], records: [{ dataType: 'product-detail',
            identity: { productIds: ['6000000999'] }, source: { pageProductId: '6000000999', requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
            payload: { success: true, result: { productId: '6000000999', productName: 'detail' } } }] } }], { sourceStoreId: 'detail-source' });
    const [[batchRow]] = await db.query('query', 'SELECT id FROM hub_batches WHERE store_id=? ORDER BY id LIMIT 1', ['detail-source']);
    const savedBatch = await realStore.getBatch(batchRow.id);
    const verified = await realStore.verifyBatchTransfer(savedBatch, savedBatch.products);
    assert.equal(makeProductVersion(savedBatch.products[0]), makeProductVersion(verified[0]), '原包核验不能改变已确认版本');
    await queue.repairProjections(); await queue.cleanupPayloads();

    /*
     * 多账户公平：两个持续就绪的账户，连续 tick 必须交替被选中。
     * 这一项是**回归保护**：scheduler.pick 改为只选择不记账后，
     * 任何调用方漏掉 recordServed 都会让虚拟时间停止推进，
     * 排序退化成反复选中靠前账户（实测 A=6、B=0）。真实 bulk.tick 必须自己记账。
     */
    {
        const counts = { A: 0, B: 0 };
        const fairManifest = owner => ({ groups: [{ sourceStoreId: `source-${owner}`, sourceBatchId: `batch-${owner}`,
            spuIds: Array.from({ length: 1000 }, (_, i) => String(i)), versions: {} }],
            targets: [{ storeId: `target-${owner}`, storeName: owner }], sameStoreConfirmed: false });
        const fairState = { nextTarget: 0, targets: [{ done: false, paused: false, nextAt: '', cursor: 0, sent: 0, jobs: 0 }] };
        for (const owner of ['A', 'B']) {
            await db.query('maintenance', `INSERT INTO hub_bulk_dispatch(id,owner_id,input_hash,status,created_at,updated_at,
                next_run_at,lease_until,lease_id,manifest,state) VALUES(?,?,?,'queued',?,?,'','','',?,?)`,
                [owner.repeat(64), owner, 'h', '2026-01-01', '2026-01-01', JSON.stringify(fairManifest(owner)), JSON.stringify(fairState)]);
        }
        const fair = createBulkDispatch({ database: db, store, authorize,
            queue: { createJob: async (_input, access) => { counts[access.principalId] += 1; return {}; } } });
        try {
            for (let i = 0; i < 6; i += 1) {
                // 每轮都让两者重新可执行：模拟两个账户始终有待办。
                await db.query('maintenance', "UPDATE hub_bulk_dispatch SET next_run_at='' WHERE status='queued'");
                assert.equal(await fair.tick(), true, '每轮都应有批次被选中');
            }
        } finally { fair.stop(); }
        assert.ok(Math.abs(counts.A - counts.B) <= 1, `真实 bulk.tick 六轮必须公平，实际 ${JSON.stringify(counts)}`);
        assert.ok(counts.A > 0 && counts.B > 0, `两个账户都必须被服务，实际 ${JSON.stringify(counts)}`);
    }

    success = true;
    console.log(JSON.stringify({ passed: true, dispatchItems: 420, duplicateJobs: 0, simultaneousPermits: 3, millionItemManifest: true, incrementalInventory: true, bulkAccountFairness: true, realPlatformRequests: 0 }));
} finally {
    await db.close();
    if (success) await admin.query(`DROP DATABASE ${name}`);
    else console.error('保留隔离测试库', name);
    await admin.end();
}
