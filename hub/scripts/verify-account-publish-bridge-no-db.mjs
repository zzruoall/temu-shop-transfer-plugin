/** 发布桥接安全边界：只用内存连接替身，不连接数据库、不启动平台或插件。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createAccountPublishBridge } from '../lib/account-publish-bridge.mjs';

const bytes = Buffer.from('{"spuId":"spu"}');
const work = { work_id: 'work', account_id: 'account', store_id: 'temu:123', job_id: 'job', item_spu: 'spu',
    direction: 'publish', run_id: 'real-run', execution_run_id: 'real-run', actor_id: 'actor', ownership_generation: 'generation',
    source_ref: 'data/staging/source.json', source_hash: createHash('sha256').update(bytes).digest('hex'), expected_bytes: bytes.length, status: 'running' };
const binding = { workId: 'work', accountId: 'account', storeId: 'temu:123', runId: 'real-run', actorId: 'actor',
    ownershipGeneration: 'generation', pluginInstanceId: 'plugin', preparedEpoch: 7 };

/** 连接只接受本组安全检查的读取；任何越过边界的写入或数据库池调用都立即失败。 */
function fixture({ epoch = 7, active = true, owner = 'account', permits = [], count = permits.length } = {}) {
    const item = { spuId: 'spu', status: 'received', accountWork: { ...binding } };
    const job = { id: 'job', targetStoreId: work.store_id, directCreate: true, status: 'queued', items: [item] };
    const calls = [];
    const connection = { async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('hub_queue_locks')) return [{ affectedRows: 1 }];
        if (sql.includes('hub_account_runtime')) return [[{ account_id: 'account', current_work_id: 'work', state: 'running', worker_epoch: epoch, run_id: 'real-run' }]];
        if (sql.includes('hub_account_work')) return [[{ ...work }]];
        if (sql.includes('hub_map_entries')) return [[{ body: { ownerId: owner, claimedAt: 'generation' } }]];
        if (sql.includes('hub_agents')) return [[{ body: { storeId: work.store_id, pluginInstanceId: 'plugin', identityMatched: true, pluginDetected: true,
            executionRun: { id: 'real-run', storeId: work.store_id, active, expiresAt: '2099-01-01T00:00:00.000Z' } } }]];
        if (sql.includes('hub_job_items')) return [[{ body: item }]];
        if (sql.includes('hub_jobs')) return [[{ body: job }]];
        if (sql.includes('COUNT(*)') && sql.includes('hub_resource_leases')) return [[{ n: count }]];
        if (sql.startsWith('SELECT') && sql.includes('hub_resource_leases')) return [permits];
        throw new Error(`unexpected write: ${sql}`);
    } };
    const bridge = createAccountPublishBridge({ database: { query() { throw new Error('pool must not be used'); } },
        staging: { async read() { return bytes; }, async stage() { throw new Error('unexpected staging'); } }, maxUnsettledPublishes: 2 });
    return { bridge, connection, job, item, calls };
}

test('未绑定运行器工作时不能领取，旧epoch不能冒充当前prepared', async () => {
    const f = fixture({ epoch: 8 });
    assert.equal(await f.bridge.canClaim({ connection: f.connection, job: f.job, item: f.item }), false);
    delete f.item.accountWork;
    assert.equal(await f.bridge.canClaim({ connection: f.connection, job: f.job, item: f.item }), false);
});

test('旧轮次与转移归属均拒绝新增授权', async () => {
    for (const options of [{ active: false }, { owner: 'other' }]) {
        const f = fixture(options);
        await assert.rejects(f.bridge.validateWork(f.connection, work), error => error.status === 409 || error.status === 403);
    }
});

test('准备回执摘要不匹配时不得登记prepared或结算done', async () => {
    const f = fixture();
    await assert.rejects(f.bridge.onPrepared({ connection: f.connection, work,
        workerEpoch: 7, result: { sourceRead: true, contentHash: 'wrong', byteLength: bytes.length, sourceRef: work.source_ref } }), /integrity/);
    assert.ok(!f.calls.some(call => call.sql.startsWith('UPDATE')));
});

test('持久permit总额包含unknown，达到上限不得生成新attempt', async () => {
    const f = fixture({ count: 2 });
    const result = await f.bridge.begin({ connection: f.connection, job: f.job, item: f.item, attemptId: 'new-attempt', limit: 10 });
    assert.equal(result.granted, false);
    assert.equal(result.reason, 'platform_permit_limit');
    assert.ok(!f.calls.some(call => call.sql.startsWith('INSERT INTO hub_resource_leases')));
});

test('持久permit已存在时不同attempt不得借原work再次申请', async () => {
    const f = fixture({ permits: [{ lease_id: 'permit', work_id: 'work', attempt_id: 'original', worker_epoch: 7, state: 'held' }] });
    await assert.rejects(f.bridge.begin({ connection: f.connection, job: f.job, item: f.item, attemptId: 'different', limit: 2 }), /attempt/);
});

test('管理删除不能借旧unknown字段跳过held许可保护', async () => {
    const f = fixture({ permits: [{ lease_id: 'permit', work_id: 'work', attempt_id: 'original', worker_epoch: 7, state: 'held' }] });
    Object.assign(f.item, { status: 'cancelled', directState: 'unknown', directAttemptId: 'original' });
    await assert.rejects(f.bridge.syncJob({ connection: f.connection, job: f.job }), /platform_result_pending/);
    assert.ok(!f.calls.some(call => call.sql.startsWith('DELETE') || call.sql.startsWith('UPDATE')));
});
