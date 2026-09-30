import { createHash, randomUUID } from 'node:crypto';
import { makeProductVersion } from './job-queue.mjs';
import { createAccountScheduler } from './account-scheduler.mjs';

export const BULK_SCHEMA = [`CREATE TABLE IF NOT EXISTS hub_bulk_dispatch (
    id CHAR(64) PRIMARY KEY,owner_id VARCHAR(255) NOT NULL,input_hash CHAR(64) NOT NULL,
    status VARCHAR(20) NOT NULL,created_at VARCHAR(30) NOT NULL,updated_at VARCHAR(30) NOT NULL,
    next_run_at VARCHAR(30) NOT NULL,lease_until VARCHAR(30) NOT NULL,lease_id VARCHAR(40) NOT NULL,
    manifest JSON NOT NULL,state JSON NOT NULL,
    INDEX(status,next_run_at),INDEX(owner_id,created_at),INDEX(created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`, `CREATE TABLE IF NOT EXISTS hub_bulk_failures (
    bulk_id CHAR(64) NOT NULL,target_store VARCHAR(255) NOT NULL,source_batch VARCHAR(255) NOT NULL,
    spu_id VARCHAR(30) NOT NULL,reason VARCHAR(400) NOT NULL,at VARCHAR(30) NOT NULL,
    PRIMARY KEY(bulk_id,target_store,source_batch,spu_id),INDEX(bulk_id,at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`];
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (message, status = 400) => Object.assign(Error(message), { status });
const CHUNK = 50;

/** 持久化发送清单，不预先展开商品×店铺笛卡尔积；短租约和子任务幂等保证进程重启可续跑。 */
export function createBulkDispatch({ database, store, queue, authorize, scheduler = createAccountScheduler() }) {
    if (!database) return null;
    const q = (sql, params = []) => database.query('dispatch', sql, params);
    /** API 不返回商品原文和租约，只展示分发进度；创建数不代表平台上架成功。 */
    function summary(row) {
        const state = parse(row.state), manifest = parse(row.manifest);
        return { id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
            total: manifest.groups.reduce((n, group) => n + group.spuIds.length, 0) * manifest.targets.length,
            sent: state.targets.reduce((n, target) => n + target.sent, 0),
            failed: state.targets.reduce((n, target) => n + Number(target.failed || 0), 0),
            jobs: state.targets.reduce((n, target) => n + target.jobs, 0),
            targets: state.targets.map((target, i) => ({ ...target, storeId: manifest.targets[i].storeId, storeName: manifest.targets[i].storeName })) };
    }
    /** 请求仅保存一次；同账户同键不同清单拒绝，响应丢失后重试不会再建总批次。 */
    async function submit(input, owner) {
        if (!/^[a-zA-Z0-9-]{16,80}$/.test(input.requestId || '')) throw error('批量请求编号不合法');
        if (input.complianceVersion !== 'V2.0') throw error('请确认商品合规声明');
        if (!Array.isArray(input.groups) || !input.groups.length || input.groups.length > 500
            || !Array.isArray(input.targets) || !input.targets.length || input.targets.length > 200) throw error('每批最多500个来源批次、200家目标店');
        const groups = input.groups.map(group => ({ sourceStoreId: String(group.sourceStoreId || '').trim(), sourceBatchId: String(group.sourceBatchId || '').trim(),
            spuIds: [...new Set((Array.isArray(group.spuIds) ? group.spuIds : []).map(String))].sort() }))
            .sort((a, b) => a.sourceBatchId.localeCompare(b.sourceBatchId));
        const targets = input.targets.map(target => ({ storeId: String(target.storeId || '').trim(), storeName: String(target.storeName || '').trim().slice(0, 255) }))
            .sort((a, b) => a.storeId.localeCompare(b.storeId));
        if (new Set(targets.map(target => target.storeId)).size !== targets.length || targets.some(target => !target.storeId)
            || new Set(groups.map(group => group.sourceBatchId)).size !== groups.length
            || groups.some(group => !group.sourceStoreId || !group.sourceBatchId || !group.spuIds.length || group.spuIds.some(id => !/^\d{1,30}$/.test(id)))) throw error('清单存在重复或无效的店铺、批次、商品编号');
        if (groups.reduce((n, group) => n + group.spuIds.length, 0) > 10000) throw error('单批最多10000个商品，请拆为多个批次');
        const sameStoreConfirmed = input.sameStoreConfirmed === true;
        if (!sameStoreConfirmed && targets.some(target => groups.some(group => group.sourceStoreId === target.storeId))) throw error('请二次确认发送到商品来源店铺', 409);
        const normalized = { groups, targets, sameStoreConfirmed, complianceVersion: 'V2.0' };
        const id = hash([owner || 'operator', input.requestId]), inputHash = hash(normalized);
        await authorize(owner, [...groups.map(group => group.sourceStoreId), ...targets.map(target => target.storeId)]);
        const [[existing]] = await q('SELECT * FROM hub_bulk_dispatch WHERE id=?', [id]);
        if (existing) {
            if (existing.input_hash !== inputHash) throw error('批量请求编号已用于不同清单', 409);
            return summary(existing);
        }
        // 清单固定目标店当前页面轮次；刷新后即使重新启用，旧清单也不能接到新轮次继续下发。
        const agents = await queue.listAgents();
        for (const target of targets) {
            const agent = (Array.isArray(agents) ? agents : agents.agents || []).find(agent => agent.storeId === target.storeId);
            if (agent?.executionRunProtocol === 1) {
                if (!agent.executionRunId) throw error('目标店尚未启用本轮任务，请先在目标店启用', 409);
                target.executionRunId = agent.executionRunId;
            }
        }
        // 固定确认时的商品版本；单件异常交给分发隔离，不能偷偷使用排队期间变更后的商品资料。
        for (const group of groups) {
            const batch = await store.getBatch(group.sourceBatchId);
            if (!batch || batch.sourceStoreId !== group.sourceStoreId) throw error('来源批次不存在或不属于所选来源店', 409);
            const selected = (batch.products || []).filter(product => group.spuIds.includes(String(product.spuId)));
            // 旧派生快照会从原包恢复，必须对恢复后的有效版本签名，不能用旧解析结果制造假冲突。
            let verified = selected;
            try {
                const result = store.verifyBatchTransfer ? await store.verifyBatchTransfer(batch, selected, { collectErrors: true }) : selected;
                verified = Array.isArray(result) ? result : result.products;
            } catch (e) {
                // 原包损坏仍必须阻止该商品发送，但不能拒收其他来源批次的整份清单。
                if (e.status !== 422) throw e;
            }
            const byId = new Map([...selected, ...verified].map(product => [String(product.spuId), product]));
            group.versions = Object.fromEntries(group.spuIds.map(id => {
                if (!byId.has(id)) return [id, null];
                return [id, makeProductVersion(byId.get(id))];
            }));
        }
        const now = new Date().toISOString();
        const state = { nextTarget: 0, targets: targets.map(() => ({ cursor: 0, sent: 0, jobs: 0, done: false, paused: false, attempts: 0, nextAt: '', error: '' })) };
        await database.transaction('dispatch', async conn => {
            // 全局锁只用于接收清单和限制积压量，不包住来源解压或后台分发。
            await conn.query("INSERT INTO hub_queue_locks(id) VALUES('bulk-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            const [[old]] = await conn.query('SELECT input_hash FROM hub_bulk_dispatch WHERE id=?', [id]);
            if (old) { if (old.input_hash !== inputHash) throw error('批量请求编号已用于不同清单', 409); return; }
            const [pending] = await conn.query("SELECT owner_id,manifest,state FROM hub_bulk_dispatch WHERE status IN ('queued','paused')");
            if (pending.length >= 100 || pending.filter(row => row.owner_id === (owner || '')).length >= 10) throw error('批量队列已满：全局最多100批、每账户最多10批，请先处理已有任务', 429);
            // 限制未物化的需求总量，不能用小清单绕过容量限制后积压无限个目标项。
            const remaining = pending.reduce((sum, row) => {
                const m = parse(row.manifest), s = parse(row.state);
                return sum + m.groups.reduce((n, g) => n + g.spuIds.length, 0) * m.targets.length - s.targets.reduce((n, t) => n + t.sent + Number(t.failed || 0), 0);
            }, 0);
            if (remaining + groups.reduce((n, g) => n + g.spuIds.length, 0) * targets.length > 2000000) throw error('待处理目标项已达200万，请等待现有任务处理后再提交', 429);
            const [[payloads]] = await conn.query('SELECT COALESCE(SUM(OCTET_LENGTH(body)),0) AS bytes FROM hub_task_payloads');
            if (Number(payloads.bytes) >= 512 * 1024 * 1024) throw error('任务快照已达512MiB，请先处理积压任务', 429);
            await conn.query('INSERT INTO hub_bulk_dispatch VALUES(?,?,?,?,?,?,?,?,?,?,?)', [id, owner || '', inputHash, 'queued', now, now, now, '', '', JSON.stringify(normalized), JSON.stringify(state)]);
        });
        return get(id, owner);
    }
    async function get(id, owner) {
        const [[row]] = await q('SELECT * FROM hub_bulk_dispatch WHERE id=?', [id]);
        if (!row || owner && row.owner_id !== owner) throw error('批量任务不存在', 404);
        // 原创建者仍可查看历史进度和停止分发；店铺授权撤回不能让其失去取消入口。
        await authorize(owner, []);
        const result = summary(row);
        if (result.failed) {
            const [samples] = await q('SELECT target_store AS storeId,source_batch AS sourceBatchId,spu_id AS spuId,reason FROM hub_bulk_failures WHERE bulk_id=? ORDER BY at,target_store,source_batch,spu_id LIMIT 20', [id]);
            result.failureSamples = samples;
        }
        return result;
    }
    /** 异常明细沿用批次所有者权限并分页，避免大量异常商品一次性撑大状态响应。 */
    async function failures(id, owner, offset = 0) {
        await get(id, owner);
        const start = Math.max(0, Math.floor(Number(offset) || 0));
        const [rows] = await q('SELECT target_store AS storeId,source_batch AS sourceBatchId,spu_id AS spuId,reason FROM hub_bulk_failures WHERE bulk_id=? ORDER BY at,target_store,source_batch,spu_id LIMIT 21 OFFSET ?', [id, start]);
        return { failures: rows.slice(0, 20), hasMore: rows.length > 20, offset: start };
    }
    /** 按创建账户分页历史进度，不向店铺的新所有者暴露旧账号清单。 */
    async function list(owner, offset = 0) {
        const [rows] = await q(`SELECT id FROM hub_bulk_dispatch ${owner ? 'WHERE owner_id=?' : ''} ORDER BY created_at DESC,id LIMIT 20 OFFSET ?`, [...(owner ? [owner] : []), Math.max(0, Math.floor(Number(offset) || 0))]);
        const result = [];
        for (const row of rows) {
            try { result.push(await get(row.id, owner)); } catch (e) { if (e.status !== 403) throw e; }
        }
        return { batches: result, hasMore: rows.length === 20 };
    }
    /** 停止仅阻止尚未分发的商品，已生成的子任务须走原有取消/待核对流程。 */
    async function control(id, action, owner) {
        await get(id, owner);
        if (!['cancel', 'resume'].includes(action)) throw error('未知批量操作');
        await database.transaction('dispatch', async conn => {
            const [[row]] = await conn.query('SELECT * FROM hub_bulk_dispatch WHERE id=? FOR UPDATE', [id]);
            if (row.lease_until > new Date().toISOString()) throw error('当前分片正在写入，请稍后再操作', 409);
            if (['completed', 'completed_errors', 'cancelled'].includes(row.status)) throw error('已结束的批次不能重新分发', 409);
            const state = parse(row.state);
            if (action === 'resume') for (const target of state.targets) { target.paused = false; target.attempts = 0; target.nextAt = ''; target.error = ''; }
            const now = new Date().toISOString();
            await conn.query("UPDATE hub_bulk_dispatch SET status=?,state=?,updated_at=?,next_run_at=?,lease_id='',lease_until='' WHERE id=?", [action === 'cancel' ? 'cancelled' : 'queued', JSON.stringify(state), now, now, id]);
        });
        return get(id, owner);
    }
    /** 每次只发一个目标店的50件，然后轮换目标；租约到期只能重放同一子任务请求键。 */
    async function tick() {
        const now = new Date().toISOString(), leaseId = randomUUID();
        // 先看有哪些批次可运行，再按账户公平挑一个，而不是按 next_run_at 先到先服务。
        // 只取 id 与 owner_id：大清单 JSON 进入 filesort 会在默认排序缓冲下失败。
        const [candidates] = await database.query('dispatch',
            "SELECT id,owner_id FROM hub_bulk_dispatch WHERE status='queued' AND next_run_at<=? AND lease_until<=? ORDER BY created_at,id LIMIT 200", [now, now]);
        if (!candidates.length) return false;
        const { picked } = scheduler.pick(candidates.map(item => ({ owner: item.owner_id, id: item.id })));
        const chosenId = picked ? picked.id : candidates[0].id;
        const row = await database.transaction('dispatch', async conn => {
            // 选中后仍要重新校验资格并加租约：期间它可能已被取消、暂停或续租。
            const [[fresh]] = await conn.query("SELECT id FROM hub_bulk_dispatch WHERE id=? AND status='queued' AND next_run_at<=? AND lease_until<=? FOR UPDATE", [chosenId, now, now]);
            if (!fresh) return null;
            const [[row]] = await conn.query('SELECT * FROM hub_bulk_dispatch WHERE id=?', [fresh.id]);
            await conn.query('UPDATE hub_bulk_dispatch SET lease_id=?,lease_until=? WHERE id=?', [leaseId, new Date(Date.now() + 10 * 60000).toISOString(), row.id]);
            return row;
        });
        if (!row) return false;
        const manifest = parse(row.manifest), state = parse(row.state);
        const chunks = manifest.groups.flatMap(group => Array.from({ length: Math.ceil(group.spuIds.length / CHUNK) }, (_, i) => ({ ...group, spuIds: group.spuIds.slice(i * CHUNK, (i + 1) * CHUNK) })));
        let index = -1;
        for (let n = 0; n < state.targets.length; n++) {
            const i = (state.nextTarget + n) % state.targets.length, target = state.targets[i];
            if (!target.done && !target.paused && target.nextAt <= now) { index = i; break; }
        }
        let failure = null;
        // 本轮是否真的把子任务交给了队列：只有它为真才算一次成功服务。
        let submitted = false;
        if (index >= 0) {
            const progress = state.targets[index], target = manifest.targets[index], group = chunks[progress.cursor];
            const part = progress.parts?.[0] || { spuIds: group.spuIds, path: '' };
            /** 每个子分片有稳定请求键；推进只发生在确定下发或明确隔离之后，重启不重建已提交任务。 */
            const advance = () => {
                if (progress.parts) { progress.parts.shift(); if (!progress.parts.length) delete progress.parts; }
                if (!progress.parts) progress.cursor++;
                progress.done = progress.cursor === chunks.length;
                progress.error = ''; progress.errorCode = ''; progress.attempts = 0; progress.nextAt = '';
            };
            try {
                const access = await authorize(row.owner_id, [group.sourceStoreId, target.storeId]);
                await queue.createJob({ ...group, spuIds: part.spuIds, expectedVersions: group.versions, targetStoreId: target.storeId, targetStoreName: target.storeName,
                    executionRunId: target.executionRunId || '',
                    requestId: `bulk:${row.id}:${index}:${progress.cursor}${part.path ? ':' + part.path : ''}`, bulkId: row.id, requireOnline: true,
                    directCreate: true, complianceVersion: 'V2.0', sameStoreConfirmed: manifest.sameStoreConfirmed }, { ...access, principalId: row.owner_id || 'operator', bulkLeaseId: leaseId });
                progress.sent += part.spuIds.length; progress.jobs++; advance();
                submitted = true;
            } catch (e) {
                progress.error = String(e.message || e).slice(0, 400); progress.attempts++;
                progress.errorCode = String(e.code || '');
                if (e.code === 'bulk_product_invalid' || e.status === 422) {
                    // 只对来源数据错误二分定位；授权、商城及未知执行结果错误绝不以拆分方式绕过。
                    if (part.spuIds.length > 1) {
                        const mid = Math.ceil(part.spuIds.length / 2);
                        progress.parts = [{ spuIds: part.spuIds.slice(0, mid), path: part.path + 'l' },
                            { spuIds: part.spuIds.slice(mid), path: part.path + 'r' }, ...(progress.parts?.slice(1) || [])];
                        progress.attempts = 0; progress.nextAt = '';
                    } else {
                        failure = { target: target.storeId, batch: group.sourceBatchId, spuId: part.spuIds[0], reason: progress.error };
                        progress.failed = Number(progress.failed || 0) + 1; advance();
                    }
                } else {
                    // 离线和容量不足只是等待条件；持续有界退避，恢复在线后自动续跑原幂等分片。
                    const waiting = ['target_offline', 'bulk_backpressure'].includes(e.code);
                    if (waiting) progress.attempts = 0;
                    progress.paused = !waiting && ((e.status && ![429, 503].includes(e.status)) || progress.attempts >= 8);
                    progress.nextAt = new Date(Date.now() + (waiting ? 30000 : Math.min(300000, 5000 * 2 ** progress.attempts))).toISOString();
                }
            }
            state.nextTarget = (index + 1) % state.targets.length;
        }
        const status = state.targets.every(target => target.done) ? (state.targets.some(target => target.failed) ? 'completed_errors' : 'completed') : state.targets.every(target => target.done || target.paused) ? 'paused' : 'queued';
        // 没有可运行目标时直接等到最近退避期限，不每五秒改写进度触发无意义的SSE刷新。
        const readyTimes = state.targets.filter(target => !target.done && !target.paused).map(target => Date.parse(target.nextAt) || 0);
        const nextRun = new Date(Math.max(Date.now() + 100, readyTimes.length ? Math.min(...readyTimes) : Date.now() + 30000)).toISOString();
        await database.transaction('dispatch', async conn => {
            // 异常明细和游标同事务提交，取消或租约被接管后旧执行器不得补写失败计数。
            const [[current]] = await conn.query('SELECT status,lease_id FROM hub_bulk_dispatch WHERE id=? FOR UPDATE', [row.id]);
            if (current.status !== 'queued' || current.lease_id !== leaseId) return;
            if (failure) await conn.query('INSERT IGNORE INTO hub_bulk_failures VALUES(?,?,?,?,?,?)', [row.id, failure.target, failure.batch, failure.spuId, failure.reason, now]);
            await conn.query("UPDATE hub_bulk_dispatch SET state=?,status=?,updated_at=?,next_run_at=?,lease_until='',lease_id='' WHERE id=?",
                [JSON.stringify(state), status, index < 0 ? row.updated_at : new Date().toISOString(), nextRun, row.id]);
        });
        // 本轮确实提交了子任务才算一次服务，然后**恰好记一次**账。
        // scheduler.pick 现在只做选择（调用方可能拿不到资源），所以每个调用方都必须显式记账。
        // 漏记会让两个持续就绪账户的虚拟时间都不变，排序退化成反复选中靠前账户
        // （真实 bulk.tick 六轮实测 A=6、B=0）。失败或无可运行目标时不计账。
        if (submitted) scheduler.recordServed(row.owner_id || '', 1);
        return true;
    }
    let timer, busy = false;
    function start() {
        if (timer) return;
        timer = setInterval(async () => {
            if (busy) return;
            busy = true;
            // 四个短工人并行处理不同批次，单批次租约和同店数据库锁仍保证游标及接收顺序。
            try { await Promise.all(Array.from({ length: 4 }, () => tick())); }
            catch (e) { console.error('批量分发暂缓', e.code || e.name); }
            finally { busy = false; }
        }, 1000);
        timer.unref();
    }
    async function version(owner) {
        const [[row]] = await q(`SELECT MAX(updated_at) AS updated,COUNT(*) AS n FROM hub_bulk_dispatch ${owner ? 'WHERE owner_id=?' : ''}`, owner ? [owner] : []);
        return hash(row);
    }
    return { submit, get, failures, list, control, tick, start, version, stop: () => { clearInterval(timer); timer = null; } };
}
