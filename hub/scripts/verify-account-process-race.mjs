/**
 * 步骤2 验收补充：多连接并发竞态与状态机不变量。
 *
 * 复核报告指出原实现的漏检：`Promise.all` 共用 maintenance 单连接池（上限 1），
 * 实际在同一个连接上排队，并没有覆盖多连接数据库竞争；异常还被 catch 成
 * claimed:false，数据库错误也会被算作"互斥成功"。
 *
 * 本脚本改用多个独立连接同时争抢同一账户槽，并区分"业务拒绝"与"数据库错误"。
 * 只连隔离 MySQL（33917）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openIsolatedDatabase, createTrace } from './account-process-harness.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';
import { createAccountWorkRepository, WORK_STATUS } from '../lib/account-work-repository.mjs';

const isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_race', label: '多连接竞态' });
const root = await mkdtemp(path.join(tmpdir(), 'temu-accproc-race-'));
await writeFile(path.join(root, 'mysql.json'), JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name }));
const database = await openMysqlDatabase(path.join(root, 'mysql.json'));
try {
    await initializeMysqlSchema(database);
    await migrateAccountExecution(database);
    const repo = createAccountWorkRepository(database);

    // 一、多连接并发争抢同一账户槽：必须恰好一个成功，且失败原因是业务拒绝而非数据库错误。
    await repo.enqueue({ accountId: 'race-account', storeId: 'temu:990000009', direction: 'publish', jobId: 'race-job', spuId: 'spu-race', runId: 'race-run' });
    // 用独立连接池模拟多个进程同时领取：每个连接各自持有一条事务。
    const connections = await Promise.all(Array.from({ length: 4 }, async () => {
        const db = await openMysqlDatabase(path.join(root, 'mysql.json'));
        return { db, repo: createAccountWorkRepository(db) };
    }));
    const results = await Promise.all(connections.map(({ repo: r }) =>
        r.claimAccountWork('race-account', { runId: 'race-run', workerEpoch: 0 }).then(
            value => ({ kind: 'value', value }),
            error => ({ kind: 'error', message: String(error.message || error) }))));
    const claimed = results.filter(r => r.kind === 'value' && r.value.claimed);
    const dbErrors = results.filter(r => r.kind === 'error');
    assert.equal(claimed.length, 1, `多连接并发只应有一个成功，实际成功 ${claimed.length} 个`);
    assert.equal(dbErrors.length, 0, `不应出现数据库错误，实际 ${JSON.stringify(dbErrors.map(e => e.message).slice(0, 2))}`);
    const refused = results.filter(r => r.kind === 'value' && !r.value.claimed);
    assert.equal(refused.length, 3, `其余三个应是业务拒绝，实际 ${refused.length}`);
    for (const item of refused) {
        assert.ok(['account_busy', 'no_work', 'unknown_pending'].includes(item.value.reason),
            `拒绝原因必须是明确的业务原因，实际 ${item.value.reason}`);
    }
    await Promise.all(connections.map(({ db }) => db.close?.()));

    // 二、终态不可回退：done 之后任何结算都不能改变状态（幂等返回原值）。
    const work = await repo.enqueue({ accountId: 'immutable-account', storeId: 'temu:990000010', direction: 'publish', jobId: 'imm-job', spuId: 'spu-imm', runId: 'imm-run' });
    await repo.claimAccountWork('immutable-account', { runId: 'imm-run', workerEpoch: 0 });
    await repo.settleWork(work.work_id, { state: WORK_STATUS.done, accountId: 'immutable-account', runId: 'imm-run', workerEpoch: 0 });
    for (const state of [WORK_STATUS.unknown, WORK_STATUS.running, WORK_STATUS.waiting, WORK_STATUS.failed]) {
        const again = await repo.settleWork(work.work_id, { state, accountId: 'immutable-account', runId: 'imm-run', workerEpoch: 0 });
        assert.equal(again.idempotent, true, `终态再结算应幂等，state=${state}`);
        assert.equal(again.state, WORK_STATUS.done, `终态不得被改成 ${state}`);
    }
    const [[stored]] = await database.query('maintenance', 'SELECT status FROM hub_account_work WHERE work_id=?', [work.work_id]);
    assert.equal(stored.status, WORK_STATUS.done, '数据库中状态必须保持 done');

    // 三、旧 epoch 写入被拒：epoch 不匹配时结算与检查点都不能生效。
    const epochWork = await repo.enqueue({ accountId: 'epoch-account', storeId: 'temu:990000011', direction: 'publish', jobId: 'epoch-job', spuId: 'spu-epoch', runId: 'epoch-run' });
    await repo.claimAccountWork('epoch-account', { runId: 'epoch-run', workerEpoch: 0 });
    await database.query('maintenance', 'UPDATE hub_account_runtime SET worker_epoch=7 WHERE account_id=?', ['epoch-account']);
    const staleCheckpoint = await repo.checkpointWork(epochWork.work_id, { accountId: 'epoch-account', runId: 'epoch-run',
        workerEpoch: 3, checkpointRef: 'stale', state: WORK_STATUS.waiting });
    assert.equal(staleCheckpoint.changed, false, '旧 epoch 的检查点必须被拒绝');
    assert.equal(staleCheckpoint.reason, 'stale_context', `拒绝原因应为 stale_context，实际 ${staleCheckpoint.reason}`);
    let staleSettleRejected = false;
    try { await repo.settleWork(epochWork.work_id, { state: WORK_STATUS.done, accountId: 'epoch-account', runId: 'epoch-run', workerEpoch: 3 }); }
    catch (error) { staleSettleRejected = /代次已过期|stale_epoch/.test(String(error.code || error.message)); }
    assert.equal(staleSettleRejected, true, '旧 epoch 的结算必须被拒绝');
    const [[afterStale]] = await database.query('maintenance', 'SELECT status FROM hub_account_work WHERE work_id=?', [epochWork.work_id]);
    assert.equal(afterStale.status, WORK_STATUS.running, '被拒的旧 epoch 写入不得改动状态');

    // 四、unknown 占用必须计入并发观测（基座能力验证）。
    const trace = createTrace();
    trace.work('start', { accountId: 't-1', workId: 'w1' });
    trace.work('settle', { accountId: 't-1', workId: 'w1', state: 'unknown' });
    trace.work('start', { accountId: 't-1', workId: 'w2' });
    assert.equal(trace.maxAccountActiveObserved(), 2, 'unknown 之后又启动一件，必须被观测为并发违规');

    console.log(JSON.stringify({
        passed: true,
        multiConnectionRace: claimed.length,
        databaseErrors: dbErrors.length,
        businessRefusals: refused.length,
        terminalImmutable: true,
        staleEpochRejected: true,
        unknownCountedAsActive: true,
        realPlatformCalls: 0
    }));
} finally {
    await database.close?.();
    await isolated.drop();
}
