/** 轮次权限只使用临时文件状态机和模拟商品仓库；不启动服务、不连接数据库或真实店铺。 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJobQueue } from '../lib/job-queue.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'temu-execution-runs-'));
const runA = 'execution-round-a', runB = 'execution-round-b', runC = 'execution-round-c';

/** 每个场景独占仓库；时间边界仅改写该场景的临时 JSON，不休眠也不修改全局时钟。 */
async function fixture(name) {
    const location = path.join(root, name);
    const stateFile = path.join(location, 'data', 'jobs.json');
    const products = ['9100894431', '9100894432', '9100894433'].map(spuId => ({
        spuId, ready: false, title: '轮次模拟商品', publicationData: { sourceProduct: { productId: spuId } }
    }));
    const store = {
        getBatch: async () => ({ sourceStoreId: 'temu:111', products }),
        listOverview: async () => ({ products: [] }),
        verifyBatchTransfer: async (_batch, selected) => selected
    };
    const queue = createJobQueue(location, store);
    const identity = { storeId: 'temu:222', mallId: '222', storeName: 'target', pageStoreName: 'target',
        executionMode: 'plugin-api', pluginInstanceId: 'execution-run-test-instance', pluginVersion: '10.10.60',
        pluginDetected: true, identityMatched: true, schedulingProtocol: 1, executionRunProtocol: 1 };
    await queue.registerAgent(identity);
    const readState = async () => JSON.parse(await readFile(stateFile, 'utf8'));
    const editState = async edit => {
        const state = await readState();
        edit(state);
        await writeFile(stateFile, JSON.stringify(state));
    };
    const control = (action, executionRunId, previousRunId = '', stopReason = '') => queue.controlExecutionRun({
        ...identity, action, executionRunId, previousRunId, stopReason
    });
    const create = (spuIds = products.map(product => product.spuId), extra = {}) => queue.createJob({
        sourceStoreId: 'temu:111', sourceBatchId: 'simulated-batch', targetStoreId: identity.storeId,
        targetStoreName: identity.storeName, requireOnline: true, directCreate: true, complianceVersion: 'V2.0', spuIds, ...extra
    });
    const claim = executionRunId => queue.claimJobs({ ...identity, executionRunId,
        claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: 0, pendingUploadBytes: 0 });
    const receive = async (task, executionRunId) => {
        const base = { ...identity, executionRunId, jobId: task.jobId, spuId: task.spuId,
            claimToken: task.claimToken, directRetrySequence: Number(task.directRetrySequence || 0) };
        await queue.reportProgress({ ...base, status: 'received', snapshotSha256: task.transferIntegrity.sha256 });
        return base;
    };
    const begin = base => ({ ...base, phase: 'begin', requestHash: 'a'.repeat(64), authorizationKey: randomUUID() });
    return { queue, identity, products, readState, editState, control, create, claim, receive, begin };
}

/** 失效轮次必须明确拒绝，不能用任意异常掩盖身份字段丢失或代码执行错误。 */
function inactive(error) {
    assert.equal(error.status, 409);
    assert.equal(error.code, 'execution_run_inactive');
    return true;
}

try {
    // 创建、重复开始、续租和旧控制消息都必须保持同一条轮次因果链。
    {
        const f = await fixture('lifecycle');
        await assert.rejects(f.create(), inactive);
        await assert.rejects(f.claim(''), inactive);
        const started = await f.control('start', runA);
        assert.equal(started.executionRunId, runA);
        assert.equal((await f.readState()).agents[0].executionRun.active, true);
        assert.equal((await f.control('start', runA)).expiresAt, started.expiresAt, '重复开始仅确认原轮次');

        await f.editState(state => { state.agents[0].executionRun.expiresAt = new Date(Date.now() + 5000).toISOString(); });
        const before = (await f.readState()).agents[0].executionRun.expiresAt;
        await f.claim(runA);
        const renewed = (await f.readState()).agents[0];
        assert.equal(renewed.executionRunProtocol, 1, '领取重建 agent 时不能丢协议字段');
        assert.equal(renewed.executionRun.id, runA);
        assert.ok(Date.parse(renewed.executionRun.expiresAt) > Date.parse(before) + 60000, '领取必须持久化续租');
        await f.queue.registerAgent(f.identity);
        assert.equal((await f.readState()).agents[0].executionRun.id, runA, '注册心跳不能清掉已启用轮次');

        const oldWaiting = await f.create([f.products[0].spuId]);
        await f.control('start', runB, runA);
        assert.equal((await f.queue.getJob(oldWaiting.id)).items[0].status, 'cancelled', '启用新轮次也要清旧轮未提交项');
        const newWaiting = await f.create([f.products[1].spuId]);
        const current = (await f.readState()).agents[0].executionRun;
        await assert.rejects(f.control('start', runA), inactive);
        await assert.rejects(f.control('start', runC, runA), inactive);
        assert.equal((await f.control('stop', runA)).stale, true);
        assert.deepEqual((await f.readState()).agents[0].executionRun, current, '迟到开始和停止都不能覆盖新轮次');
        assert.equal((await f.queue.getJob(newWaiting.id)).items[0].status, 'queued', '旧轮停止不能取消新轮商品');
        await assert.rejects(f.claim(runA), inactive);
        await assert.rejects(f.control('touch', runA), inactive);
        await f.control('stop', runB);
        await assert.rejects(f.claim(runB), inactive);
        await assert.rejects(f.control('start', runB, runB), inactive);

        await f.control('start', runC, runB);
        const waiting = await f.create([f.products[0].spuId]);
        await f.editState(state => { state.agents[0].executionRun.expiresAt = new Date(Date.now() - 1).toISOString(); });
        await assert.rejects(f.claim(runC), inactive);
        await f.queue.expireExecutionRun({ storeId: f.identity.storeId });
        assert.equal((await f.queue.getJob(waiting.id)).items[0].status, 'cancelled', '租约超时清除未提交项');
        assert.equal((await f.readState()).agents[0].executionRun.active, false);
    }

    // 停止清掉已领取但未提交的项；unknown 保留凭证并允许原实例切店后补报。
    {
        const f = await fixture('stop-and-receipts');
        await f.control('start', runA);
        const job = await f.create();
        assert.equal((await f.readState()).jobs.find(entry => entry.id === job.id).executionRunId, runA);
        const { claimed } = await f.claim(runA);
        assert.equal(claimed.length, 3);
        assert.ok(claimed.every(task => task.executionRunId === runA), '领取协议必须携带轮次');
        const first = await f.receive(claimed[0], runA);
        await f.receive(claimed[1], runA);
        const permit = await f.queue.directProgress(f.begin(first));
        const unknown = { ...first, phase: 'unknown', attemptId: permit.attemptId, receiptId: randomUUID(), reason: '模拟提交响应丢失' };
        await f.queue.directProgress(unknown);
        const held = (await f.queue.getJob(job.id)).items.find(item => item.spuId === first.spuId);
        // 外部终止（例如刷新页面）要清走未提交项，同时保留未知结果的证据。
        const stoppedResult = await f.control('stop', runA, '', 'page_refresh');
        assert.equal(stoppedResult.cancelled, 2);
        assert.equal(stoppedResult.purged.kept, 1, '未知结果项必须留下证据');
        const stopped = await f.queue.getJob(job.id);
        for (const item of stopped.items) {
            if (item.spuId === first.spuId) {
                assert.equal(item.directState, 'unknown');
                assert.equal(item.directAttemptId, held.directAttemptId);
                assert.equal(item.claimToken, held.claimToken, '停止不能撤销已提交结果的回执凭证');
            } else {
                assert.equal(item.status, 'cancelled');
                assert.equal(item.claimToken, '');
            }
        }
        assert.equal((await f.control('stop', runA, '', 'page_refresh')).cancelled, 0, '重复停止不能重复清理');
        await assert.rejects(f.queue.directProgress(f.begin(first)), inactive);
        assert.equal((await f.queue.directProgress(unknown)).acknowledged, true, '停止后原回执可幂等确认');

        await f.queue.registerAgent({ ...f.identity, storeId: 'temu:333', mallId: '333', storeName: 'other', pageStoreName: 'other' });
        const created = { ...first, phase: 'created', attemptId: permit.attemptId,
            receiptId: randomUUID(), productId: '8002250622', verified: true, reason: '原店迟到成功回执' };
        for (const mismatch of [{ attemptId: randomUUID() }, { pluginInstanceId: 'other-instance' },
            { mallId: '333' }, { claimToken: 'wrong-token' }]) {
            await assert.rejects(f.queue.directProgress({ ...created, ...mismatch }), error => {
                assert.equal(error.status, 409);
                return true;
            });
        }
        assert.equal((await f.queue.directProgress({ ...unknown, receiptId: randomUUID() })).state, 'unknown', '切店后仍接受原 unknown 回执');
        assert.equal((await f.queue.directProgress(created)).state, 'created');
        assert.equal((await f.queue.directProgress(created)).acknowledged, true);
        assert.equal((await f.queue.getJob(job.id)).items.find(item => item.spuId === first.spuId).status, 'uploaded');
    }

    // 显式人工确认才可将未知项交给当前新轮；取消项、旧许可及旧回执不能随之复活。
    {
        const f = await fixture('manual-retry');
        await f.control('start', runA);
        const job = await f.create([f.products[0].spuId, f.products[1].spuId]);
        const { claimed } = await f.claim(runA);
        const first = await f.receive(claimed[0], runA);
        const permit = await f.queue.directProgress(f.begin(first));
        const unknown = { ...first, phase: 'unknown', attemptId: permit.attemptId, receiptId: randomUUID(), reason: '待人工核对' };
        await f.queue.directProgress(unknown);
        await f.control('stop', runA, '', 'page_refresh');
        const retry = { jobId: job.id, spuId: first.spuId, storeId: f.identity.storeId };
        await assert.rejects(f.queue.directRetry({ ...retry, confirmed: true }), inactive);
        await f.control('start', runB, runA);
        const automatic = await f.claim(runB);
        assert.equal(automatic.claimed.length, 0, '新轮启用不得自动重放旧轮 unknown 或取消项');
        await assert.rejects(f.queue.directProgress(f.begin(first)), inactive);
        await assert.rejects(f.queue.directProgress(f.begin({ ...first, executionRunId: runB })), inactive);
        await assert.rejects(f.queue.directRetry(retry), /人工确认/);
        await assert.rejects(f.queue.directRetry({ ...retry, spuId: claimed[1].spuId, confirmed: true }), /已取消/);
        assert.equal((await f.readState()).jobs.find(entry => entry.id === job.id).executionRunId, runA, '拒绝的人工操作不得改写轮次');
        const retried = await f.queue.directRetry({ ...retry, confirmed: true });
        assert.equal(retried.retrySequence, 1);
        const rebound = (await f.readState()).jobs.find(entry => entry.id === job.id);
        assert.equal(rebound.executionRunId, runB);
        const retriedItem = rebound.items.find(item => item.spuId === first.spuId);
        assert.equal(retriedItem.directAttemptId, '');
        assert.equal(retriedItem.directAttemptHistory.length, 1, '人工重试必须保留旧许可证据');
        const history = retriedItem.directAttemptHistory[0];
        assert.equal(history.attemptId, permit.attemptId);
        assert.equal(history.state, 'unknown');
        assert.equal(history.pluginInstanceId, first.pluginInstanceId);
        assert.equal(history.mallId, first.mallId);
        assert.equal(history.requestHash, 'a'.repeat(64));
        assert.equal(history.retrySequence, 0);
        assert.ok(Number.isFinite(Date.parse(history.closedAt)));
        assert.equal(rebound.items.find(item => item.spuId === claimed[1].spuId).status, 'cancelled');
        await assert.rejects(f.queue.directProgress(unknown), /回执重试轮次已失效/);

        await f.editState(state => {
            const item = state.jobs.find(entry => entry.id === job.id).items.find(entry => entry.spuId === first.spuId);
            item.retryAt = new Date(Date.now() - 1).toISOString();
        });
        const next = (await f.claim(runB)).claimed;
        assert.equal(next.length, 1);
        assert.equal(next[0].spuId, first.spuId);
        assert.equal(next[0].executionRunId, runB);
        assert.equal(next[0].directRetrySequence, 1);
        const current = await f.receive(next[0], runB);
        const nextPermit = await f.queue.directProgress(f.begin(current));
        assert.notEqual(nextPermit.attemptId, permit.attemptId, '人工新尝试必须使用新许可');
    }
    // 撤销是不可逆终态：停止通知先于启动请求到达时，同一轮次不得再被启用或续租。
    {
        const f = await fixture('stop-before-start');
        // 全新店没有任何轮次记录时先收到 stop：必须登记撤销，而不是当成无关请求丢弃。
        const stale = await f.control('stop', runA);
        assert.equal(stale.stale, true);
        await assert.rejects(f.control('start', runA), inactive, '先前已撤销的轮次不得被迟到启动复活');
        await assert.rejects(f.control('touch', runA), inactive);
        assert.equal((await f.control('stop', runA)).stale, true, '重复停止仍是幂等确认');

        // 撤销只针对该轮次编号；换用新编号仍可在同一店铺正常启用。
        const fresh = await f.control('start', runB);
        assert.equal(fresh.executionRunId, runB);
        assert.equal((await f.readState()).agents[0].executionRun.active, true);
        await assert.rejects(f.control('start', runA), inactive, '撤销记录不能因新轮次启用而失效');

        // 心跳重建 agent 时必须保留撤销记录，否则下一次心跳就把它洗掉了。
        await f.queue.registerAgent(f.identity);
        assert.equal((await f.readState()).agents[0].runRevocations.some(entry => entry.id === runA), true,
            '注册心跳不能清掉撤销记录');
        await assert.rejects(f.control('start', runA), inactive);
    }

    // 停止与领取交错：撤销提交后，持有旧轮次编号的领取和新增许可都不能再通过。
    {
        const f = await fixture('stop-before-begin');
        await f.control('start', runA);
        const job = await f.create([f.products[0].spuId]);
        const { claimed } = await f.claim(runA);
        const base = await f.receive(claimed[0], runA);
        // 先拿到服务端撤销，再尝试用原轮次申请新增许可。
        const stopResult = await f.control('stop', runA, '', 'page_refresh');
        await assert.rejects(f.queue.directProgress(f.begin(base)), inactive, '撤销后不得再发出新增许可');
        await assert.rejects(f.claim(runA), inactive);
        // 外部终止会把该轮任务整条清出队列：没有在途结果的项不再留在可执行状态。
        assert.equal(stopResult.purged?.removed, 1, '外部终止应清走该轮任务');
        assert.equal(await f.queue.getJob(job.id), null, '被清任务不应还能查到');
        // 迟到启动同样被拦，说明撤销先于启动生效且不可逆。
        await assert.rejects(f.control('start', runA, runA), inactive);
    }

    // 外部终止（刷新页面、插件更新、切店）必须把该轮任务整条清出队列；
    // 只有操作者主动暂停才保留任务，两种语义不能混用。
    {
        const f = await fixture('external-clear');
        await f.control('start', runA);
        const externalJob = await f.create([f.products[0].spuId]);
        // 刷新页面终止该轮：任务应整条消失，不留在待处理队列里。
        const cleared = await f.control('stop', runA, '', 'page_refresh');
        assert.equal(cleared.purged?.removed, 1, '刷新页面必须清走该轮任务');
        assert.equal(await f.queue.getJob(externalJob.id), null, '清除后任务不应还能查到');
        const remaining = (await f.readState()).jobs || [];
        assert.equal(remaining.some(job => job.id === externalJob.id), false, '被清任务不能留在队列数据里');

        // 插件更新同样清除。
        await f.control('start', runB, runA);
        const upgradeJob = await f.create([f.products[1].spuId]);
        const upgraded = await f.control('stop', runB, '', 'plugin_upgrade');
        assert.equal(upgraded.purged?.removed, 1, '插件更新必须清走该轮任务');
        assert.equal(((await f.readState()).jobs || []).some(job => job.id === upgradeJob.id), false, '更新后任务不能残留');

        // 操作者主动暂停是唯一保留任务的路径。
        await f.control('start', runC, runB);
        const pausedJob = await f.create([f.products[2].spuId]);
        const paused = await f.control('stop', runC, '', 'manual_stop');
        assert.equal(paused.purged, undefined, '手动暂停不应触发清除');
        assert.equal(paused.cancelled, 0, '手动暂停不取消未提交项，任务保留待继续');
        const keptJob = await f.queue.getJob(pausedJob.id);
        assert.equal(keptJob.id, pausedJob.id, '手动暂停后任务必须仍在');
        assert.equal(keptJob.items[0].status, 'queued', '手动暂停后商品项应保持可继续状态');

        // 已部署的 10.10.61 包不发送 stopReason：不带原因时必须按保留处理。
        // 否则操作者点"暂停"（意图保留）会被误判成外部终止，清空他正要留下的队列。
        const runD = 'execution-round-d';
        await f.control('start', runD, runC);
        const bareJob = await f.create([f.products[0].spuId]);
        const bare = await f.control('stop', runD);
        assert.equal(bare.purged, undefined, '旧包不带终止原因时不得清除任务');
        assert.equal((await f.queue.getJob(bareJob.id)).id, bareJob.id, '不带原因的停止必须保留任务');
    }

    // 已经在平台提交或有未知结果的项必须留下证据：清除队列不能丢掉可能已创建的凭证。
    {
        const f = await fixture('purge-keeps-evidence');
        await f.control('start', runA);
        const job = await f.create([f.products[0].spuId, f.products[1].spuId]);
        const { claimed } = await f.claim(runA);
        const submitted = await f.receive(claimed[0], runA);
        const permit = await f.queue.directProgress(f.begin(submitted));
        await f.queue.directProgress({ ...submitted, phase: 'unknown', attemptId: permit.attemptId, receiptId: randomUUID(), reason: '待核对' });
        const result = await f.control('stop', runA, '', 'page_refresh');
        assert.equal(result.purged?.removed, 0, '存在未知结果的轮次不能整条删除');
        assert.ok(result.purged?.kept >= 1, '未知结果项必须计入保留数');
        const survivor = await f.queue.getJob(job.id);
        assert.equal(survivor.items.find(item => item.spuId === f.products[0].spuId).directAttemptId, permit.attemptId, '未知结果凭证必须保留');
        assert.equal(survivor.items.find(item => item.spuId === f.products[1].spuId).status, 'cancelled', '同一轮里未提交的项仍要作废');
    }

    // 旧协议店铺（未声明轮次）本来就用无轮次任务工作：维护和领取都不能把它堵死。
    // 这条用例防的是"按有没有轮次一刀切"导致的误伤，生产上曾经全部是这种店铺。
    {
        const f = await fixture('legacy-protocol');
        // 把店铺改回旧协议，模拟插件尚未升级。
        await f.editState(state => {
            for (const agent of state.agents || []) { agent.executionRunProtocol = 0; delete agent.executionRun; }
        });
        const legacyJob = await f.create([f.products[0].spuId], { executionRunId: '' });
        const created = (await f.readState()).jobs.find(job => job.id === legacyJob.id);
        assert.equal(created.executionRunId, '', '旧协议店铺的任务不带轮次');

        // 维护不得终结旧协议店铺的现役任务。
        const retired = await f.queue.retireLegacyDirectJobs();
        assert.equal(retired.retired, 0, '旧协议店铺的任务不能被当成历史遗留清掉');
        assert.equal((await f.queue.getJob(legacyJob.id)).items[0].status, 'queued', '旧协议任务必须仍可执行');

        // 领取同样不能因为"没有轮次"就跳过。这里沿用同一个实例，只把它降回旧协议：
        // 另起一个实例会被"同店已有在线插件"占用规则拦下，那不是这里要验的事。
        await f.editState(state => {
            for (const agent of state.agents || []) agent.executionRunProtocol = 0;
        });
        const claimed = await f.queue.claimJobs({ ...f.identity, executionRunProtocol: 0, executionRunId: '',
            claimManualUploads: true, manualUploadsOnly: true, pendingUploadCount: 0, pendingUploadBytes: 0 });
        assert.equal(claimed.claimed.length, 1, '旧协议店铺必须能领到自己的任务');

        // 同一家店升级到轮次协议后，升级前留下的无轮次任务才应被终结。
        await f.editState(state => {
            for (const agent of state.agents || []) agent.executionRunProtocol = 1;
        });
        const afterUpgrade = await f.queue.retireLegacyDirectJobs();
        assert.equal(afterUpgrade.retired, 1, '店铺升级后，升级前遗留的无轮次任务必须终结');
        assert.equal(await f.queue.getJob(legacyJob.id), null, '遗留任务应从队列移除');
    }

    // 面板"取消本店待传任务"：只取消还没提交的项，已提交或结果未知的必须保留证据。
    // 保留不是保守：那些可能已在平台建成商品，删掉凭证会导致重复创建。
    {
        const f = await fixture('cancel-store-tasks');
        await f.control('start', runA);
        const job = await f.create([f.products[0].spuId, f.products[1].spuId]);
        const { claimed } = await f.claim(runA);
        // 第一件提交到平台（进入 creating），第二件只领取未提交。
        const submitted = await f.receive(claimed[0], runA);
        const permit = await f.queue.directProgress(f.begin(submitted));

        const result = await f.queue.cancelStoreTasks({ storeId: f.identity.storeId });
        assert.equal(result.cancelled, 1, `只应取消未提交的那一件，实际 ${result.cancelled}`);
        assert.equal(result.kept, 1, `已提交的项必须保留，实际 ${result.kept}`);

        const after = await f.queue.getJob(job.id);
        const submittedItem = after.items.find(item => item.spuId === f.products[0].spuId);
        const pendingItem = after.items.find(item => item.spuId === f.products[1].spuId);
        assert.equal(submittedItem.directAttemptId, permit.attemptId, '已提交项的证据不能被清除');
        assert.equal(submittedItem.directState, 'creating', '已提交项的状态不能因取消而改动');
        assert.equal(pendingItem.status, 'cancelled', '未提交项必须被取消');
        assert.equal(pendingItem.claimToken, '', '取消后必须清掉领取凭证');

        // 取消后可执行项为 0：不会再被领取上传。
        const { claimed: reclaimed } = await f.claim(runA);
        assert.equal(reclaimed.filter(item => item.spuId === f.products[1].spuId).length, 0, '被取消的项不能被重新领取');
    }

    // 取消只影响本店：另一家店的任务不受牵连。
    {
        const f = await fixture('cancel-scope');
        const other = { ...f.identity, storeId: 'temu:333', mallId: '333', storeName: 'other', pageStoreName: 'other', pluginInstanceId: 'other-inst' };
        await f.queue.registerAgent(other);
        // 另一家店也要有自己的活跃轮次，否则创建任务会被轮次校验拦下，测不到"取消不越界"。
        await f.queue.controlExecutionRun({ ...other, action: 'start', executionRunId: 'execution-round-other-333', previousRunId: '' });
        await f.control('start', runA);
        const mine = await f.create([f.products[0].spuId]);
        const theirs = await f.queue.createJob({ sourceStoreId: 'temu:111', sourceBatchId: 'simulated-batch',
            targetStoreId: other.storeId, targetStoreName: other.storeName, requireOnline: true, directCreate: true,
            complianceVersion: 'V2.0', spuIds: [f.products[1].spuId] });
        const result = await f.queue.cancelStoreTasks({ storeId: f.identity.storeId });
        assert.equal(result.cancelled, 1, '本店应取消 1 项');
        assert.equal((await f.queue.getJob(mine.id)).items[0].status, 'cancelled', '本店项应被取消');
        assert.equal((await f.queue.getJob(theirs.id)).items[0].status, 'queued', '其他店的项不得被取消');
    }

    // 插件令牌只绑定实例、不绑定店铺：取消接口必须校验调用实例确实登记在该店铺名下，
    // 否则任一插件实例都能用别人的 storeId 取消其他店的任务。
    {
        const f = await fixture('cancel-cross-instance');
        await f.control('start', runA);
        const job = await f.create([f.products[0].spuId]);
        // 用一个不属于本店的实例去取消。
        await assert.rejects(
            f.queue.cancelStoreTasks({ storeId: f.identity.storeId, pluginInstanceId: 'someone-else-instance' }),
            /不匹配/,
            '别的插件实例不得取消本店任务');
        assert.equal((await f.queue.getJob(job.id)).items[0].status, 'queued', '非法取消请求不得改动任务');
        // 本店实例可以取消。
        const ok = await f.queue.cancelStoreTasks({ storeId: f.identity.storeId, pluginInstanceId: f.identity.pluginInstanceId });
        assert.equal(ok.cancelled, 1, '本店实例应能取消自己的任务');
    }

    console.log('轮次模拟检查通过：开始/停止、迟到控制、领取续租、旧轮拒绝、跨店结果回执及人工重试');
} finally {
    // 只删除本脚本创建的临时目录；路径校验失败时保留现场，绝不扩大清理范围。
    const resolved = path.resolve(root);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('temu-execution-runs-')) {
        throw Error('临时目录边界异常，拒绝清理');
    }
    await rm(resolved, { recursive: true, force: true });
}
