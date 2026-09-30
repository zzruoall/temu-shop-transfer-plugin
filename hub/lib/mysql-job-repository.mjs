import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { namesCompatible } from "./store-names.mjs";
import { jobRequestIdentity } from "./job-idempotency.mjs";

export const JOB_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS hub_execution_wait (store_id VARCHAR(255) PRIMARY KEY,requested_at VARCHAR(30) NOT NULL,last_seen VARCHAR(30) NOT NULL,INDEX(requested_at,store_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_product_rank (pair_key VARCHAR(64) NOT NULL,spu_id VARCHAR(255) NOT NULL,
        source_store VARCHAR(255) NOT NULL,target_store VARCHAR(255) NOT NULL,title VARCHAR(500) NOT NULL,total BIGINT NOT NULL,
        PRIMARY KEY(pair_key,spu_id),INDEX(pair_key,total),INDEX(source_store),INDEX(target_store)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_claim_cursor (store_id VARCHAR(255) PRIMARY KEY,created_at VARCHAR(30) NOT NULL,job_id VARCHAR(255) NOT NULL)
        ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_queue_versions (store_id VARCHAR(255) NOT NULL,domain VARCHAR(32) NOT NULL,revision BIGINT NOT NULL,
        PRIMARY KEY(store_id,domain)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_queue_locks (id VARCHAR(255) PRIMARY KEY) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_agents (id CHAR(64) PRIMARY KEY,store_id VARCHAR(255) NOT NULL,body JSON NOT NULL,INDEX(store_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_task_payloads (id CHAR(64) PRIMARY KEY,body LONGBLOB NOT NULL) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS hub_jobs (
        id VARCHAR(255) PRIMARY KEY,source_store VARCHAR(255) NOT NULL,target_store VARCHAR(255) NOT NULL,
        created_at VARCHAR(30) NOT NULL,updated_at VARCHAR(30) NOT NULL,status VARCHAR(40) NOT NULL,
        record_group VARCHAR(20) NOT NULL,body JSON NOT NULL,summary JSON NOT NULL,
        INDEX(target_store,record_group),INDEX(target_store,created_at,id),INDEX(source_store),INDEX(updated_at),INDEX(record_group,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_job_items (
        job_id VARCHAR(255) NOT NULL,spu_id VARCHAR(255) NOT NULL,position INT NOT NULL,
        status VARCHAR(40) NOT NULL,direct_state VARCHAR(40) NOT NULL,updated_at VARCHAR(30) NOT NULL,
        snapshot_id CHAR(64),body JSON NOT NULL,PRIMARY KEY(job_id,spu_id),
        INDEX(job_id,status,position),INDEX(direct_state),INDEX(updated_at),INDEX(snapshot_id),
        FOREIGN KEY(job_id) REFERENCES hub_jobs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_work_logs (
        id CHAR(64) PRIMARY KEY,store_id VARCHAR(255) NOT NULL,source_store VARCHAR(255) NOT NULL,
        at VARCHAR(30) NOT NULL,body JSON NOT NULL,INDEX(store_id,at),INDEX(source_store,at),INDEX(at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_job_daily (job_id VARCHAR(255) NOT NULL,day CHAR(10) NOT NULL,uploaded INT NOT NULL,attention INT NOT NULL,
        PRIMARY KEY(job_id,day),INDEX(day),FOREIGN KEY(job_id) REFERENCES hub_jobs(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];
const parse = value => typeof value === "string" ? JSON.parse(value) : value;
const hash = value => createHash("sha256").update(value).digest("hex");
const agentKey = agent => hash(agent.pluginInstanceId ? `instance:${agent.pluginInstanceId}` : `store:${agent.storeId}`);
const dayKey=value=>{const time=Date.parse(value);return Number.isFinite(time)?new Date(time+28800000).toISOString().slice(0,10):"";};
const pureQuery = new Set(["listAgents", "resolveIngestSource", "getJob", "storeRecordImpact", "listTargetTaskStates"]);
const agentOnly = new Set(["registerAgent", "listAgents", "resolveIngestSource"]);

/** SQL 适配保留原授权状态机，事务只锁目标店；分发与回执分别使用连接池。 */
export function createMysqlJobRepository(database, { summarizeJob, jobRecordGroup, summarizeAgent, refreshJobStatus, storesOfAccount = null, accountExecution = null }) {
    const context = new AsyncLocalStorage();
    const query = (sql, params = []) => context.getStore()
        ? context.getStore().conn.query(sql, params) : database.query("query", sql, params);
    /** 收集本事务涉及的店铺通知域，提交前一次更新，减少多条回执产生的版本写放大。 */
    function touch(domain, ...stores) {
        const ctx = context.getStore();
        if (!ctx) throw new Error("业务版本必须与状态事务一起提交");
        ctx.versions ||= new Map();
        for (const store of stores.filter(Boolean)) ctx.versions.set(`${store}\0${domain}`, [store,domain]);
    }
    /** 所有事务使用相同顺序更新版本行，避免共享来源店的计数锁交叉。 */
    async function flushVersions(ctx) {
        for (const [, [store,domain]] of [...(ctx.versions || [])].sort(([a],[b]) => a.localeCompare(b))) {
            await ctx.conn.query("INSERT INTO hub_queue_versions(store_id,domain,revision) VALUES(?,?,1) ON DUPLICATE KEY UPDATE revision=revision+1", [store,domain]);
        }
    }
    /** 来源删除取排他锁，普通分发取共享锁；目标店执行始终互斥。 */
    async function lock(conn, key, shared = false) {
        if (shared) {
            await conn.query("INSERT IGNORE INTO hub_queue_locks(id) VALUES(?)", [key]);
            await conn.query("SELECT id FROM hub_queue_locks WHERE id=? FOR SHARE", [key]);
        } else {
            // 重复键 UPDATE 直接取得排他锁，避免 INSERT IGNORE 的共享锁再升级形成死锁。
            await conn.query("INSERT INTO hub_queue_locks(id) VALUES(?) ON DUPLICATE KEY UPDATE id=VALUES(id)", [key]);
        }
    }
    /** 按方法选择连接池及资源锁，不允许请求中无关字段改变授权目标。 */
    async function run(method, args, fn) {
        if (context.getStore()) return fn();
        const input = typeof args[0] === "object" && args[0] ? args[0] : {};
        const lane = ["createJob", "claimJobs", "cancelJob", "directRetry"].includes(method) ? "dispatch" : "feedback";
        const execute = async conn => {
            // on模式与运行器统一先锁资源准入，再锁账户/店铺/任务；禁止店铺持锁后倒取运行器首锁。
            // 默认null不增加任何锁或查询，旧模式事务范围保持不变。
            if (accountExecution && !pureQuery.has(method)) await lock(conn, 'account-admission');
            let lockedTargets = null;
            // 创建按目标店加锁，其余店铺协议按storeId；无关targetStoreId不能改变轮次控制的锁范围。
            let target = String(method === 'createJob' ? input.targetStoreId || '' : input.storeId || '').trim();
            // 参数按职责解释；创建请求中夹带旧 jobId 不能改变实际目标店的锁和冲突查询。
            const jobId = String(["getJob","cancelJob"].includes(method) ? args[0] || ""
                : ["directRetry","directProgress","reportProgress","reportOpenResult","expireDirectPermits"].includes(method) ? input.jobId || "" : "").trim();
            if (jobId) {
                const [[job]] = await conn.query("SELECT target_store FROM hub_jobs WHERE id=?", [jobId]);
                if (job) target = job.target_store;
            }
            if (!pureQuery.has(method)) {
                // 全局许可锁只覆盖 begin 的短事务；回执不取此锁，平台结果未知只隔离本店，不堵住其他店。
                if (method === "expireDirectPermits" || method === "directProgress" && input.phase === "begin") await lock(conn, "direct-admission");
                if (method === "registerAgent") {
                    await lock(conn, "agents");
                    const [agents] = await conn.query("SELECT store_id FROM hub_agents WHERE id=?", [agentKey(input)]);
                    // 实例切店时同时锁旧店和新店，防止授权检查期间绑定被换走。
                    for (const id of [...new Set([target, agents[0]?.store_id].filter(Boolean))].sort()) await lock(conn, `store:${id}`);
                } else if (method === "deleteStoreRecord") {
                    // 删除先锁来源范围，所有新建同样锁来源；因此不会漏掉取列表后新加入的下发任务。
                    await lock(conn, `source:${args[0]}`);
                    const [rows] = await conn.query("SELECT DISTINCT target_store FROM hub_jobs WHERE source_store=? OR target_store=?",[args[0],args[0]]);
                    for (const id of [...new Set([String(args[0]),...rows.map(row=>row.target_store)])].sort()) await lock(conn,`store:${id}`);
                } else if (method === "listOpenRequests") {
                    const [rows] = await conn.query("SELECT DISTINCT target_store FROM hub_jobs WHERE record_group='active' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.mode'))='identity-open-only'");
                    lockedTargets = rows.map(row=>row.target_store);
                    for (const row of rows.sort((a,b)=>a.target_store.localeCompare(b.target_store))) await lock(conn,`store:${row.target_store}`);
                } else if (method === "createJob") {
                    // 批次取消与子任务写入共用行锁；租约失效的旧执行器不能再产生任务。
                    if (args[1]?.bulkLeaseId) {
                        const [[bulk]] = await conn.query('SELECT status,lease_id,lease_until FROM hub_bulk_dispatch WHERE id=? FOR UPDATE', [input.bulkId]);
                        if (!bulk || bulk.status !== 'queued' || bulk.lease_id !== args[1].bulkLeaseId || bulk.lease_until <= new Date().toISOString()) {
                            throw Object.assign(new Error('批次已停止或分发租约已失效'), { status: 409 });
                        }
                    }
                    // 请求键属于账户而非目标店；跨店请求也必须串行检查同一幂等键。
                    const request = jobRequestIdentity(input, args[1]);
                    if (request) await lock(conn, `request:${request.id}`);
                    await lock(conn, `source:${String(input.sourceStoreId || "").trim()}`, true);
                    await lock(conn, `store:${target}`);
                    // 批量与直接发送共用容量边界，避免绕过清单接口挤满某店；幂等重放仍可读取原任务。
                    if (input.bulkId || input.requireOnline === true) {
                        const [[existing]] = await conn.query('SELECT id FROM hub_jobs WHERE id=?', [request?.id || '']);
                        if (!existing) {
                            const [[payloads]] = await conn.query('SELECT COALESCE(SUM(OCTET_LENGTH(body)),0) AS bytes FROM hub_task_payloads');
                            if (Number(payloads.bytes) >= 512 * 1024 * 1024) throw Object.assign(Error('任务快照容量已满，等待清理已结束任务'), { status: 503, code: 'bulk_backpressure' });
                            const [[pending]] = await conn.query("SELECT COUNT(*) AS n FROM hub_job_items i JOIN hub_jobs j ON j.id=i.job_id WHERE j.target_store=? AND j.status<>'cancelled' AND i.status NOT IN ('uploaded','failed','cancelled','blocked','identity_verified','identity_mismatch','skipped')", [target]);
                            if (Number(pending.n) + (input.spuIds || []).length > 200) throw Object.assign(new Error('目标店待处理队列已满，等待执行释放容量'), { status: 503, code: 'bulk_backpressure' });
                        }
                    }
                } else if (target) await lock(conn, `store:${target}`);
                else if (method === "clearStoreActivity") await lock(conn, `store:${args[0]}`);
                else throw new Error(`SQL 写操作缺少店铺边界: ${method}`);
            }
            const ctx={conn,method,input,args,target,jobId,baseline:null,lockedTargets};
            return context.run(ctx,async()=>{
                const result=await fn();
                await flushVersions(ctx);
                return result;
            });
        };
        return pureQuery.has(method) ? database.withConnection("query", execute) : database.transaction(lane, execute);
    }
    /** 向旧状态机提供有界事务视图，不扫描无关店铺或解压未领取商品。 */
    async function readState() {
        const ctx = context.getStore();
        if (!ctx) throw new Error("任务读取缺少 SQL 操作边界");
        if (ctx.state) return ctx.state;
        const [agents] = await query("SELECT body FROM hub_agents ORDER BY JSON_UNQUOTE(JSON_EXTRACT(body,'$.lastSeenAt')) DESC");
        let rows = [];
        if (!agentOnly.has(ctx.method)) {
            if (["controlExecutionRun", "expireExecutionRun"].includes(ctx.method)) [rows] = await query("SELECT * FROM hub_jobs WHERE target_store=? AND record_group<>'done'", [ctx.target]);
            // 面板"取消任务"：读取本店全部未完成任务，逐项判断哪些还没提交。
            else if (ctx.method === "cancelStoreTasks") [rows] = await query("SELECT * FROM hub_jobs WHERE target_store=? AND record_group<>'done'", [ctx.target]);
            else if (["getJob", "reportProgress", "reportOpenResult", "cancelJob", "expireDirectPermits"].includes(ctx.method)) [rows] = await query("SELECT * FROM hub_jobs WHERE id=?", [ctx.jobId]);
            else if (ctx.method === "listOpenRequests" && ctx.lockedTargets?.length) [rows] = await query("SELECT * FROM hub_jobs WHERE target_store IN (?) AND record_group='active' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.mode'))='identity-open-only' ORDER BY created_at LIMIT 100",[ctx.lockedTargets]);
            else if (ctx.method === "listTargetTaskStates") {
                const ids = (ctx.input.tasks || []).slice(0, 30).map(item => item.jobId).filter(Boolean);
                if (ids.length) [rows] = await query("SELECT * FROM hub_jobs WHERE target_store=? AND id IN (?)", [ctx.target, ids]);
            } else if (["storeRecordImpact", "deleteStoreRecord"].includes(ctx.method)) {
                [rows] = await query("SELECT * FROM hub_jobs WHERE source_store=? OR target_store=?", [ctx.args[0], ctx.args[0]]);
            } else if (ctx.jobId) {
                // 回执只取当前任务和可能冲突的同店任务，不扫描同店所有排队商品。
                // 已取消历史项保留原结果用于审计，但不能再占住整家店的执行名额。
                const conflict = ctx.method === "directRetry" ? "i.spu_id=?" : "i.direct_state IN ('creating','unknown') AND i.status NOT IN ('cancelled','failed','uploaded','blocked','identity_verified','identity_mismatch','skipped')";
                [rows] = await query(`SELECT * FROM hub_jobs j WHERE id=? OR (target_store=? AND record_group<>'done'
                    AND EXISTS(SELECT 1 FROM hub_job_items i WHERE i.job_id=j.id AND ${conflict})) ORDER BY created_at DESC`,
                [ctx.jobId,ctx.target,...(ctx.method === "directRetry" ? [String(ctx.input.spuId || "")] : [])]);
            } else if (ctx.method === "createJob") {
                const requestId = jobRequestIdentity(ctx.input, ctx.args[1])?.id || "";
                // 投递幂等仅查询本次操作，不加载同店同商品历史任务，避免无关数据进入新建事务。
                if (requestId) [rows] = await query('SELECT * FROM hub_jobs WHERE id=?', [requestId]);
            } else if (ctx.method === 'claimJobs' && accountExecution) {
                // 直接定位运行器当前授权job，不能再从前200旧任务中猜测哪件可执行。
                const authorized = await accountExecution.claimJobIds(ctx.conn, ctx.target);
                const receipts = (Array.isArray(ctx.input.receivedReceipts) ? ctx.input.receivedReceipts : [])
                    .slice(0, 30).map(item => String(item?.jobId || '')).filter(Boolean);
                const ids = [...new Set([...authorized, ...receipts])];
                if (ids.length) [rows] = await query('SELECT * FROM hub_jobs WHERE target_store=? AND id IN (?)', [ctx.target, ids]);
            } else if (ctx.method === "claimJobs") {
                const mode = ctx.input.manualUploadsOnly === true ? " AND JSON_UNQUOTE(JSON_EXTRACT(j.body,'$.mode'))='manual-plugin-upload'"
                    : ctx.input.claimManualUploads === false ? " AND JSON_UNQUOTE(JSON_EXTRACT(j.body,'$.mode'))<>'manual-plugin-upload'" : "";
                const now=new Date().toISOString();
                const [[cursor]]=await query("SELECT created_at,job_id FROM hub_claim_cursor WHERE store_id=?",[ctx.target]);
                const statement=`SELECT * FROM hub_jobs j WHERE target_store=? AND record_group<>'done'
                    ${mode}
                    -- 隔离屏障同时检查标量与 JSON 两处：历史残留可能只同步了一处，
                    -- 依赖单一副本会让半迁移的行仍被选中（复核 T4）。
                    AND j.status<>'needs_confirmation'
                    AND JSON_UNQUOTE(JSON_EXTRACT(j.body,'$.status'))<>'needs_confirmation'
                    AND EXISTS(SELECT 1 FROM hub_job_items i WHERE i.job_id=j.id AND (
                        i.status IN ('queued','opened','plugin_missing')
                        ${ctx.input.schedulingProtocol === 1 && ctx.input.inventoryComplete === true ? "OR (i.status='received' AND i.direct_state='')" : ''}
                        OR (i.status='claimed' AND (JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.claimedByStoreId'))='' OR JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.claimExpiresAt'))<?))
                        OR (i.status='retry_wait' AND JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.retryAt'))<=?)
                        OR (i.status='opening' AND JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.openingAt'))<?)))
                    AND (j.created_at>? OR (j.created_at=? AND j.id>?)) ORDER BY created_at,id LIMIT 200`;
                const base=[ctx.target,now,now,new Date(Date.now()-180000).toISOString()];
                [rows]=await query(statement,[...base,cursor?.created_at || "",cursor?.created_at || "",cursor?.job_id || ""]);
                if(!rows.length && cursor) [rows]=await query(statement,[...base,"","",""]);
                // 即使整页店名不匹配也推进游标，下次从后续任务继续，不永久卡在固定前缀。
                const eligible=[];
                let last=null;
                for(const row of rows){
                    last=row;
                    const job=parse(row.body);
                    // needs_confirmation：历史任务归属未确认，绝不能被旧领取链选中执行。
                    if(["cancelled","failed","blocked_preflight","needs_confirmation"].includes(job.status))continue;
                    // API商城任务的最终核验在状态机中按实例和mallId执行，不能在SQL预筛阶段因旧名称丢掉候选。
                    if(!job.directCreate && job.targetStoreName && ctx.input.storeName && !namesCompatible(job.targetStoreName,String(ctx.input.storeName).trim()))continue;
                    eligible.push(row);
                    if(eligible.length>=30)break;
                }
                if(last) await query("INSERT INTO hub_claim_cursor(store_id,created_at,job_id) VALUES(?,?,?) ON DUPLICATE KEY UPDATE created_at=VALUES(created_at),job_id=VALUES(job_id)",[ctx.target,last.created_at,last.id]);
                rows=eligible;
                // 接收恢复不消耗新领取名额，租约过期的本地快照也要进入同店事务视图。
                const receiptIds = [...new Set((Array.isArray(ctx.input.receivedReceipts) ? ctx.input.receivedReceipts : []).slice(0,30).map(item => String(item?.jobId || '')).filter(Boolean))];
                if (receiptIds.length) {
                    const [held] = await query('SELECT * FROM hub_jobs WHERE target_store=? AND id IN (?)', [ctx.target, receiptIds]);
                    rows = [...new Map([...rows, ...held].map(row => [row.id, row])).values()];
                }
            }
        }
        const jobs = rows.map(row => ({ ...parse(row.body), items: [] }));
        const byId = new Map(jobs.map(job => [job.id, job]));
        for (let offset = 0; offset < jobs.length; offset += 100) {
            const ids = jobs.slice(offset, offset + 100).map(job => job.id);
            const [items] = await query("SELECT job_id,body,snapshot_id FROM hub_job_items WHERE job_id IN (?) ORDER BY job_id,position", [ids]);
            for (const row of items) {
                const item = parse(row.body);
                // 内部引用不作为插件协议字段；只有真正领取时才解压完整商品。
                Object.defineProperty(item, "_snapshotId", { value: row.snapshot_id, writable: true, enumerable: false });
                byId.get(row.job_id).items.push(item);
            }
        }
        ctx.state = { jobs, agents: agents.map(row => parse(row.body)) };
        ctx.baseline = {
            jobs: new Map(jobs.map(job => [job.id, JSON.stringify(job)])),
            items: new Map(jobs.flatMap(job => job.items.map(item => [`${job.id}\0${item.spuId}`, JSON.stringify(item)]))),
            agents: new Map(ctx.state.agents.map(agent => [agentKey(agent), JSON.stringify(agent)])),
        };
        return ctx.state;
    }
    /** 任务头、变化明细、统计与版本在同一事务提交，快照只保存内容引用。 */
    async function saveJob(job) {
        touch("jobs",job.sourceStoreId,job.targetStoreId);
        const { items = [], ...body } = job;
        const { items: _items, ...summary } = summarizeJob(job);
        // 表格只携带首批状态行；计数来自全部明细，详情接口可单独读取。
        summary.items = items.slice(0, 50).map(({ snapshot, ...item }) => item);
        summary.itemsTruncated = items.length > 50;
        summary.runtimeCounters = {
            queued: items.filter(item=>["queued","opening","opened","claimed","retry_wait"].includes(item.status)).length,
            uploading: items.filter(item=>["received","upload_opened"].includes(item.status) || item.directState==="creating").length,
            failures: items.filter(item=>item.status !== 'cancelled' && (["failed","identity_mismatch"].includes(item.status) || ["unknown","preflight_failed","rejected"].includes(item.directState))).length,
        };
        await query(`INSERT INTO hub_jobs(id,source_store,target_store,created_at,updated_at,status,record_group,body,summary)
            VALUES(?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE updated_at=VALUES(updated_at),status=VALUES(status),record_group=VALUES(record_group),body=VALUES(body),summary=VALUES(summary)`,
        [job.id, job.sourceStoreId || "", job.targetStoreId || "", job.createdAt || "", job.updatedAt || "", job.status || "", jobRecordGroup(job), JSON.stringify(body), JSON.stringify(summary)]);
        const ctx = context.getStore();
        const added=[];
        for (const [position, item] of items.entries()) {
            if (ctx?.baseline?.items.get(`${job.id}\0${item.spuId}`) === JSON.stringify(item)) continue;
            const { snapshot, ...small } = item;
            if(!ctx?.baseline?.items.has(`${job.id}\0${item.spuId}`))added.push(item);
            let snapshotId = item._snapshotId || null;
            if (snapshot) {
                const json = JSON.stringify(snapshot);
                snapshotId = hash(json);
                await query("INSERT IGNORE INTO hub_task_payloads(id,body) VALUES(?,?)", [snapshotId, gzipSync(json)]);
            }
            await query(`INSERT INTO hub_job_items(job_id,spu_id,position,status,direct_state,updated_at,snapshot_id,body)
                VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),direct_state=VALUES(direct_state),updated_at=VALUES(updated_at),snapshot_id=VALUES(snapshot_id),body=VALUES(body)`,
            [job.id, item.spuId, position, item.status || "", item.directState || "", item.directUpdatedAt || job.updatedAt || "", snapshotId, JSON.stringify(small)]);
        }
        if(added.length)await rankDelta(job,added,1);
        const daily=new Map();
        for(const item of items){
            if (item.status === 'cancelled' || job.status === 'cancelled') continue;
            const day=dayKey(item.directUpdatedAt || job.updatedAt);
            if(!day)continue;
            const values=daily.get(day)||{uploaded:0,attention:0};
            if(item.directState==="created"||item.status==="uploaded")values.uploaded++;
            if(["unknown","preflight_failed","rejected"].includes(item.directState)||["failed","identity_mismatch"].includes(item.status))values.attention++;
            daily.set(day,values);
        }
        await query("DELETE FROM hub_job_daily WHERE job_id=?",[job.id]);
        if(daily.size)await query("INSERT INTO hub_job_daily(job_id,day,uploaded,attention) VALUES ?",[[...daily].map(([day,v])=>[job.id,day,v.uploaded,v.attention])]);
    }
    /** 排行只在发送成员增删时计数；状态回执不得把同一件商品再算一次发送。 */
    async function rankDelta(job,items,delta){
        const pair=hash(JSON.stringify([job.sourceStoreId,job.targetStoreId]));
        const rows=items.flatMap(item=>[["global",item.spuId,"","",String(item.title || item.spuId).slice(0,500),delta],
            [pair,item.spuId,job.sourceStoreId || "",job.targetStoreId || "",String(item.title || item.spuId).slice(0,500),delta]]);
        rows.sort((a,b)=>`${a[0]}:${a[1]}`.localeCompare(`${b[0]}:${b[1]}`));
        for(let offset=0;offset<rows.length;offset+=200)await query("INSERT INTO hub_product_rank(pair_key,spu_id,source_store,target_store,title,total) VALUES ? ON DUPLICATE KEY UPDATE total=total+VALUES(total),title=VALUES(title)",[rows.slice(offset,offset+200)]);
    }
    /** 与本次读取基线比较，只更新变化行；未加载的任务绝不能被视作已删除。 */
    async function writeState(state) {
        const ctx = context.getStore();
        if (!ctx) throw new Error("任务写入缺少事务");
        for (const job of state.jobs || []) {
            if (ctx.baseline?.jobs.get(job.id) !== JSON.stringify(job)) {
                // work/slot/permit和业务明细同事务；反馈、取消、轮次清理不能各自漏掉账本。
                if (accountExecution) await accountExecution.syncJob({ connection: ctx.conn, job,
                    previous: ctx.baseline?.jobs.has(job.id) ? parse(ctx.baseline.jobs.get(job.id)) : null });
                await saveJob(job);
            }
        }
        const ids = new Set((state.jobs || []).map(job => job.id));
        for (const id of ctx.baseline?.jobs.keys() || []) if (!ids.has(id)) {
            const old=parse(ctx.baseline.jobs.get(id));
            if (accountExecution) {
                // 删除队列记录只能作废未提交工作；unknown/creating仍有许可时桥接会拒绝并回滚删除。
                await accountExecution.syncJob({ connection: ctx.conn, previous: old,
                    job: { ...old, items: old.items.map(item => ['uploaded', 'failed', 'cancelled', 'blocked', 'skipped'].includes(item.status)
                        ? item : { ...item, status: 'cancelled' }) } });
            }
            touch("jobs",old.sourceStoreId,old.targetStoreId);
            await rankDelta(old,old.items || [],-1);
            await query("DELETE FROM hub_jobs WHERE id=?", [id]);
        }
        // 轮次控制和领取续租只写轮次字段，不能用读取时的目录副本覆盖新的身份心跳。
        if (["controlExecutionRun", "expireExecutionRun", "claimJobs"].includes(ctx.method)) {
            for (const agent of state.agents || []) {
                if (agent.storeId !== ctx.target) continue;
                const key = agentKey(agent), before = ctx.baseline?.agents.get(key);
                if (!before) continue;
                const old = parse(before);
                if (JSON.stringify(old.executionRun) === JSON.stringify(agent.executionRun) && old.executionRunProtocol === agent.executionRunProtocol
                    && JSON.stringify(old.runRevocations || []) === JSON.stringify(agent.runRevocations || [])) continue;
                await query("UPDATE hub_agents SET body=JSON_SET(body,'$.executionRun',CAST(? AS JSON),'$.executionRunProtocol',?,"
                    + "'$.runRevocations',CAST(? AS JSON)) WHERE id=? AND store_id=?",
                    [JSON.stringify(agent.executionRun || null), agent.executionRunProtocol || 0,
                        JSON.stringify(agent.runRevocations || []), key, ctx.target]);
            }
        }
        // 心跳单独负责实例目录；领取不覆盖心跳刚更新的商城身份。
        if (["registerAgent", "deleteStoreRecord", "migration"].includes(ctx.method)) {
            const keys = new Set();
            for (const agent of state.agents || []) {
                const key = agentKey(agent);
                keys.add(key);
                const json = JSON.stringify(agent);
                if (ctx.baseline?.agents.get(key) === json) continue;
                await query("INSERT INTO hub_agents(id,store_id,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE store_id=VALUES(store_id),body=VALUES(body)", [key, agent.storeId || "", json]);
            }
            for (const key of ctx.baseline?.agents.keys() || []) if (!keys.has(key)) await query("DELETE FROM hub_agents WHERE id=?", [key]);
        }
    }
    /** 日志附属于当前状态事务，回滚不留下伪成功记录。 */
    async function appendLog(entry) {
        touch("logs",entry.sourceStoreId,entry.storeId);
        const json = JSON.stringify(entry);
        await query("INSERT IGNORE INTO hub_work_logs(id,store_id,source_store,at,body) VALUES(?,?,?,?,?)", [hash(json), entry.storeId || "", entry.sourceStoreId || "", entry.at, json]);
    }
    /** 空权限集与管理员无范围必须区分，来源或目标归属均可参与只读统计。 */
    function scopeWhere(scope, alias = "") {
        const prefix = alias ? `${alias}.` : "";
        if (!scope) return ["1=1", []];
        if (!scope.size) return ["0=1", []];
        return [`(${prefix}source_store IN (?) OR ${prefix}target_store IN (?))`, [[...scope], [...scope]]];
    }
    /** 任务记录分页与店铺运行汇总分开返回，列表截断不会使状态表漏计。 */
    async function listJobsPage(options = {}) {
        const [where, params] = scopeWhere(options.scope);
        const limit = Math.min(200, Math.max(1, Math.floor(Number(options.limit) || 50)));
        const offset = Math.max(0, Math.floor(Number(options.offset) || 0));
        const [countsRows] = await query(`SELECT record_group,COUNT(*) AS n FROM hub_jobs WHERE ${where} GROUP BY record_group`, params);
        const counts = { total: 0, active: 0, attention: 0, done: 0 };
        for (const row of countsRows) { counts[row.record_group] = Number(row.n); counts.total += Number(row.n); }
        const [rows] = await query(`SELECT summary FROM hub_jobs WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
        const [runtime] = await query(`SELECT target_store AS storeId,COUNT(*) AS activeCount,MAX(updated_at) AS lastActivity,
            SUM(JSON_EXTRACT(summary,'$.runtimeCounters.queued')) AS queued,
            SUM(JSON_EXTRACT(summary,'$.runtimeCounters.uploading')) AS uploading,
            SUM(JSON_EXTRACT(summary,'$.runtimeCounters.failures')) AS failures
            FROM hub_jobs WHERE ${where} AND record_group<>'done' GROUP BY target_store`,params);
        const [active] = await query(`SELECT summary FROM (SELECT summary,ROW_NUMBER() OVER(PARTITION BY target_store ORDER BY updated_at DESC,id DESC) AS rn
            FROM hub_jobs WHERE ${where} AND record_group<>'done') ranked WHERE rn=1`,params);
        const latest=new Map(active.map(row=>{const job=parse(row.summary);return [job.targetStoreId,{id:job.id,status:job.status}];}));
        const [agents] = await query("SELECT body FROM hub_agents");
        return { jobs: rows.map(row => parse(row.summary)), activeJobs: [], runtimeStores: runtime.map(row=>({storeId:row.storeId,
            activeCount:Number(row.activeCount),queued:Number(row.queued),uploading:Number(row.uploading),failures:Number(row.failures),lastActivity:row.lastActivity,current:latest.get(row.storeId)})), counts, total: counts.total,
            limit, offset, hasMore: offset + rows.length < counts.total,
            agents: options.includeAgents === false ? [] : agents.map(row => parse(row.body)).filter(a => !options.scope || options.scope.has(a.storeId)).map(summarizeAgent) };
    }
    /** 看板读取写入阶段维护的投影，避免每次打开扫描完整执行历史。 */
    async function listDashboard(options = {}) {
        const [where, params] = scopeWhere(options.scope, "j");
        const now = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
        const start = new Date(`${now}T00:00:00+08:00`).toISOString();
        const end = new Date(Date.parse(start) + 86400000).toISOString();
        const [[sent]]=await query(`SELECT COALESCE(SUM(JSON_EXTRACT(j.summary,'$.counts.total')),0) AS todaySent FROM hub_jobs j WHERE ${where} AND j.created_at>=? AND j.created_at<?`,[...params,start,end]);
        const [[totals]]=await query(`SELECT COALESCE(SUM(d.uploaded),0) AS todayUploaded,COALESCE(SUM(d.attention),0) AS todayAttention FROM hub_jobs j JOIN hub_job_daily d ON d.job_id=j.id WHERE ${where} AND d.day=?`,[...params,now]);
        totals.todaySent=sent.todaySent;
        const [[active]] = await query(`SELECT COUNT(*) AS n FROM hub_jobs j WHERE ${where} AND record_group<>'done'`, params);
        const [rankWhere,rankParams]=scopeWhere(options.scope);
        const [products] = !options.scope ? await query("SELECT spu_id AS id,title AS name,total AS count FROM hub_product_rank WHERE pair_key='global' AND total>0 ORDER BY total DESC,spu_id LIMIT 8")
            : await query(`SELECT spu_id AS id,MAX(title) AS name,SUM(total) AS count FROM hub_product_rank WHERE pair_key<>'global' AND ${rankWhere} GROUP BY spu_id HAVING SUM(total)>0 ORDER BY count DESC,id LIMIT 8`,rankParams);
        const [sources] = await query(`SELECT j.source_store AS id,MAX(JSON_UNQUOTE(JSON_EXTRACT(j.body,'$.sourceStoreName'))) AS name,SUM(JSON_EXTRACT(j.summary,'$.counts.total')) AS count
            FROM hub_jobs j WHERE ${where} GROUP BY j.source_store ORDER BY count DESC,id LIMIT 8`, params);
        const rank = rows => rows.map(row => ({ ...row, count: Number(row.count), name: row.name || row.id }));
        return { ...Object.fromEntries(Object.entries(totals).map(([key,value]) => [key,Number(value)])), activeJobs: Number(active.n), topProducts: rank(products), topSources: rank(sources) };
    }
    /** SSE 仅读取店铺级业务版本和小型实例目录，不随历史明细数量增长。 */
    async function liveSignature(scope) {
        // 通知只读店铺级版本，历史百万明细和日志不参与每次心跳的摘要计算。
        const [versions] = await query(`SELECT store_id,domain,revision FROM hub_queue_versions${scope ? scope.size ? " WHERE store_id IN (?)" : " WHERE 0=1" : ""} ORDER BY store_id,domain`, scope?.size ? [[...scope]] : []);
        const [agents] = await query("SELECT body FROM hub_agents ORDER BY id");
        const directory = agents.map(row => summarizeAgent(parse(row.body))).map(a => [a.storeId,a.storeName,a.online,a.pluginVersion,a.identityMatched,a.canReceiveUploads]);
        return { jobs: hash(JSON.stringify(versions.filter(v=>v.domain==="jobs"))), directory: hash(JSON.stringify(directory)),
            agents: hash(JSON.stringify(directory.filter(a => !scope || scope.has(a[0])))), logs: hash(JSON.stringify(versions.filter(v=>v.domain==="logs"))) };
    }
    /** 日志先按权限及十五天窗口筛选，再分页；其他账号的日志不能挤掉当前页。 */
    async function listActivity(options = {}) {
        const scope=options.scope;
        const where=scope ? scope.size ? " AND (store_id IN (?) OR source_store IN (?))" : " AND 0=1" : "";
        const params=[new Date(Date.now()-15*86400000).toISOString(),...(scope?.size ? [[...scope],[...scope]]:[])];
        const limit=Math.min(10000,Math.max(1,Math.floor(Number(options.limit)||10000)));
        const offset=Math.max(0,Math.floor(Number(options.offset)||0));
        const [rows] = await query(`SELECT body FROM hub_work_logs WHERE at>=?${where} ORDER BY at DESC,id DESC LIMIT ? OFFSET ?`, [...params,limit,offset]);
        const [[total]]=await query(`SELECT COUNT(*) AS n FROM hub_work_logs WHERE at>=?${where}`,params);
        const [agentRows] = await query("SELECT body FROM hub_agents");
        const stores = new Map(agentRows.map(row => {
            const a = summarizeAgent(parse(row.body));
            return [a.storeId, { storeId:a.storeId,storeName:a.storeName || a.pageStoreName || a.storeId,online:a.online,updatedAt:a.lastSeenAt,entries:[] }];
        }).filter(([id]) => id && (!scope || scope.has(id))));
        for (const row of rows) {
            const e = parse(row.body);
            if (!stores.has(e.storeId)) stores.set(e.storeId,{storeId:e.storeId,storeName:e.targetStoreName || e.storeId,online:false,updatedAt:e.at,entries:[]});
            stores.get(e.storeId).entries.push(e);
        }
        return { retentionDays:15,stores:[...stores.values()],entries:rows.map(row => parse(row.body)),total:Number(total.n),limit,offset,hasMore:offset+rows.length<Number(total.n) };
    }
    async function cleanupLogs() {
        // 每批删除有限行，避免十五天清理与执行回执争用长事务。
        return database.transaction("maintenance", conn=>context.run({conn,method:"cleanup"},async()=>{
            const [rows]=await query("SELECT id,store_id,source_store FROM hub_work_logs WHERE at<? ORDER BY at LIMIT 5000",[new Date(Date.now()-15*86400000).toISOString()]);
            if (!rows.length) return;
            for(const row of rows) touch("logs",row.store_id,row.source_store);
            await query("DELETE FROM hub_work_logs WHERE id IN (?)",[rows.map(row=>row.id)]);
            await flushVersions(context.getStore());
        }));
    }
    /** 离线迁移保留原任务、凭证和尝试编号，禁止把在途提交当成新任务重发。 */
    async function importLegacy(state, logs = []) {
        return database.transaction("maintenance", conn => context.run({ conn, method:"migration",baseline:null }, async () => {
            const [[counts]] = await query("SELECT COUNT(*) AS n FROM hub_jobs");
            if (Number(counts.n)) throw new Error("任务表非空，禁止覆盖迁移");
            await writeState(state);
            for (const job of state.jobs || []) for (const entry of job.activity || []) await appendLog({ ...entry,storeId:entry.storeId || job.targetStoreId,sourceStoreId:entry.sourceStoreId || job.sourceStoreId });
            for (const log of logs) for (const entry of log.entries || []) await appendLog({ ...entry,storeId:entry.storeId || log.storeId });
            await flushVersions(context.getStore());
            return {jobs:(state.jobs || []).length,items:(state.jobs || []).reduce((n,j)=>n+(j.items || []).length,0),agents:(state.agents || []).length};
        }));
    }
    /** 删除确认只查询关联行数，不读取旧文件，也不解压历史任务正文。 */
    async function storeImpact(id) {
        const [[row]] = await query(`SELECT
            (SELECT COUNT(*) FROM hub_jobs WHERE source_store=? OR target_store=?) AS jobCount,
            (SELECT COUNT(*) FROM hub_agents WHERE store_id=?) AS agentCount,
            (SELECT COUNT(*) FROM hub_work_logs WHERE store_id=?) AS logCount`, [id,id,id,id]);
        return { storeId:id,jobCount:Number(row.jobCount),agentCount:Number(row.agentCount),logCount:Number(row.logCount) };
    }
    /** 删除日志同时通知来源及目标可见范围，不影响任务执行记录。 */
    async function clearLog(id) {
        const [rows]=await query("SELECT DISTINCT source_store FROM hub_work_logs WHERE store_id=?",[id]);
        touch("logs",id,...rows.map(row=>row.source_store));
        return query("DELETE FROM hub_work_logs WHERE store_id=?",[id]);
    }
    /** 在业务事务内锁住归属记录，人工重试与取消不能借用别人店铺的任务编号。 */
    async function assertAccess(job, access) {
        if (!access?.userId) return;
        const ids=[...new Set([job.sourceStoreId,job.targetStoreId])];
        const [rows]=await query("SELECT entry_key,body FROM hub_map_entries WHERE domain='ownership' AND entry_key IN (?) FOR SHARE",[ids]);
        if (rows.length!==ids.length || rows.some(row=>parse(row.body).ownerId!==access.userId)) {
            throw Object.assign(new Error("任务来源店或目标店不属于当前账号"),{status:403});
        }
    }
    /** 资格检查通过后才加载这一件正文，避免无效候选占满预取窗口。 */
    async function loadSnapshot(item) {
        if(item.snapshot)return item.snapshot;
        if(!item._snapshotId)throw new Error("任务快照引用缺失");
        const [[row]]=await query("SELECT body FROM hub_task_payloads WHERE id=?",[item._snapshotId]);
        if(!row)throw new Error("任务快照资料缺失");
        item.snapshot=JSON.parse(gunzipSync(row.body).toString("utf8"));
        return item.snapshot;
    }
    /**
     * 使用 direct_state 索引计数已许可的执行；不解压历史正文，也不将待核对占入全局吞吐预算。
     *
     * 账户维度：除全局名额（按店铺数）外，还要求同一账户没有别的店铺在执行中。
     * 一个账户同时只处理自己的一家店，其余店铺排队；账户之间互不挤占名额。
     * 账号由调用方按店铺认领关系解析后传入，任务表本身不存账号。
     */
    async function canBeginDirect(target, limit, fair = false, accountId = '') {
        // 等待队列与许可共用direct-admission锁；新版waiting响应提交事务，保存原排队位置。
        if (fair) {
            const now = new Date().toISOString();
            await query('DELETE FROM hub_execution_wait WHERE last_seen<?', [new Date(Date.now() - 90000).toISOString()]);
            await query('INSERT INTO hub_execution_wait VALUES(?,?,?) ON DUPLICATE KEY UPDATE last_seen=VALUES(last_seen)', [target, now, now]);
        }
        const [[row]] = await query(`SELECT COUNT(DISTINCT j.target_store) AS n FROM hub_job_items i
            JOIN hub_jobs j ON j.id=i.job_id WHERE i.direct_state='creating' AND i.status='upload_opened' AND j.status<>'cancelled'`);
        const slots = limit - Number(row.n);
        if (slots <= 0) return false;
        if (fair) {
            const [waiting] = await query('SELECT store_id FROM hub_execution_wait ORDER BY requested_at,store_id LIMIT ?', [slots]);
            if (!waiting.some(row => row.store_id === target)) return false;
            await query('DELETE FROM hub_execution_wait WHERE store_id=?', [target]);
        }
        // 同账户串行：查出该账户下所有店铺中正在执行的店铺（排除本次要开始的这家）。
        // 返回 'account' 而不是 false：内存侧看不到其他店铺的行，只有这里能判断出
        // "是同一账户的另一家店在跑"，据此回报准确的等待原因。
        if (accountId && typeof storesOfAccount === 'function') {
            const owned = await storesOfAccount(accountId);
            const others = [...owned].filter(storeId => storeId !== target);
            if (others.length) {
                const [[busy]] = await query(`SELECT COUNT(DISTINCT j.target_store) AS n FROM hub_job_items i
                    JOIN hub_jobs j ON j.id=i.job_id WHERE i.direct_state='creating' AND i.status='upload_opened'
                    AND j.status<>'cancelled' AND j.target_store IN (?)`, [others]);
                if (Number(busy.n) > 0) return 'account';
            }
        }
        return true;
    }
    /** 只修正历史投影及明确的旧判重/拒绝状态，不清凭证、不重置尝试、不重新排队。 */
    async function repairProjections(after = '') {
        const [rows] = await database.query('maintenance', 'SELECT id,target_store FROM hub_jobs WHERE id>? ORDER BY id LIMIT 50', [after]);
        for (const row of rows) await database.transaction('maintenance', async conn => {
            await lock(conn, `store:${row.target_store}`);
            await context.run({ conn, method: 'getJob', jobId: row.id, baseline: null }, async () => {
                const state = await readState(), job = state.jobs[0];
                if (!job) return;
                for (const item of job.items) {
                    if (job.status === 'cancelled' || item.status === 'cancelled' || item.directState !== 'preflight_failed') continue;
                    const duplicate = /^目标店已存在商品 .+，按(?:SKU货号|商品货号)确认，未创建/.test(item.reason || '')
                        || item.reason === '同一批次已有相同货号，本件跳过，避免批次内重复创建';
                    if (duplicate) { item.status = 'skipped'; item.directState = 'duplicate_exists'; }
                    else if (item.authorizationKey && item.requestHash) item.directState = 'rejected';
                }
                if (job.status !== 'cancelled') refreshJobStatus(job);
                await saveJob(job); await flushVersions(context.getStore());
            });
        });
        return { count: rows.length, after: rows.at(-1)?.id || after };
    }
    /** 预选有界候选；转换前在许可锁和店铺锁内重新核对，保留先到达的真实回执。 */
    async function listStaleDirectJobs(cutoff) {
        const [rows] = await database.query('maintenance', `SELECT DISTINCT j.id AS jobId,j.target_store AS storeId FROM hub_job_items i
            JOIN hub_jobs j ON j.id=i.job_id WHERE i.direct_state='creating' AND i.status='upload_opened'
            AND i.updated_at<? AND j.status<>'cancelled' ORDER BY j.id LIMIT 50`, [cutoff]);
        return rows;
    }
    let payloadCursor = '';
    let executionRunCursor = '';
    /** 按店分片扫描租约，游标避免超过200店后后排永远得不到清理。 */
    async function listExecutionRunStores() {
        const [rows] = await database.query('maintenance', "SELECT DISTINCT target_store FROM hub_jobs WHERE record_group<>'done' AND target_store>? ORDER BY target_store LIMIT 200", [executionRunCursor]);
        executionRunCursor = rows.length === 200 ? rows.at(-1).target_store : '';
        return rows.map(row => row.target_store);
    }
    /** 每轮只查128个快照引用；仅删除已无任何任务引用的正文，任务历史和未知结果永不按年龄删除。 */
    async function cleanupPayloads() {
        const [rows] = await database.query('maintenance', 'SELECT id FROM hub_task_payloads WHERE id>? ORDER BY id LIMIT 128', [payloadCursor]);
        for (const row of rows) await database.transaction('maintenance', async conn => {
            await conn.query('SELECT id FROM hub_task_payloads WHERE id=? FOR UPDATE', [row.id]);
            const [[ref]] = await conn.query('SELECT job_id FROM hub_job_items WHERE snapshot_id=? LIMIT 1', [row.id]);
            if (!ref) await conn.query('DELETE FROM hub_task_payloads WHERE id=?', [row.id]);
        });
        payloadCursor = rows.length === 128 ? rows.at(-1).id : '';
    }
    /** 运行器回执借用现有事务更新业务项和投影，不另开连接，也不把prepared当发布终态。 */
    async function updateWorkItem(connection, work, mutate) {
        await lock(connection, `store:${work.store_id}`);
        const ctx = { conn: connection, method: 'getJob', jobId: work.job_id, baseline: null };
        return context.run(ctx, async () => {
            const state = await readState();
            const job = state.jobs.find(entry => entry.id === work.job_id);
            const item = job?.items.find(entry => entry.spuId === work.item_spu);
            if (!job || !item || item.accountWork?.workId !== work.work_id) {
                throw Object.assign(new Error('publish_work_revoked'), { status: 409, code: 'publish_work_revoked' });
            }
            await mutate(job, item);
            refreshJobStatus(job);
            job.updatedAt = new Date().toISOString();
            await saveJob(job);
            await flushVersions(ctx);
        });
    }
    accountExecution?.bindRepository({ updateWorkItem });
    return { run,readState,writeState,appendLog,listJobsPage,listDashboard,liveSignature,listActivity,cleanupLogs,importLegacy,clearLog,storeImpact,assertAccess,loadSnapshot,canBeginDirect,listStaleDirectJobs,listExecutionRunStores,repairProjections,cleanupPayloads,
        inContext: () => !!context.getStore(),
        // 只允许已被run包装的业务方法复用连接，缺事务时fail closed，不回退连接池。
        transactionConnection: () => {
            const conn = context.getStore()?.conn;
            if (!conn) throw new Error('任务操作缺少数据库事务边界');
            return conn;
        } };
}
