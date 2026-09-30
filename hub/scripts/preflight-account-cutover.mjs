/** 只读发布门禁：旧平台未知尝试不能在切换时被漏算，也不能靠清理任务假装不存在。 */
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
const database = await openMysqlDatabase();
if (!database) throw Error('preflight_requires_mysql');
try {
    const [legacy] = await database.query('feedback', `SELECT i.job_id,i.spu_id,i.status AS item_status,i.direct_state,j.target_store,
        JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.directAttemptId')) AS attempt_id,
        JSON_UNQUOTE(JSON_EXTRACT(j.body,'$.targetStoreName')) AS target_store_name
        FROM hub_job_items i JOIN hub_jobs j ON j.id=i.job_id
        WHERE i.direct_state IN ('creating','unknown')
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.accountWork.workId')),'')=''
        ORDER BY j.created_at,i.position`);
    const [[bulk]] = await database.query('query', "SELECT COUNT(*) AS n FROM hub_bulk_dispatch WHERE status IN ('queued','paused')");
    const [[ingest]] = await database.query('query', "SELECT COUNT(*) AS n FROM hub_ingest_requests WHERE status IN ('processing','queued')");
    const ready = legacy.length === 0 && Number(bulk.n) === 0 && Number(ingest.n) === 0;
    console.log(JSON.stringify({ ready, legacyUnresolved: legacy, pendingBulk: Number(bulk.n), pendingIngest: Number(ingest.n),
        action: ready ? 'backup_and_isolated_restore_required' : 'reconcile_or_explicitly_stop_pending_work_before_cutover', productionChanged: false }, null, 2));
    if (!ready) process.exitCode = 1;
} finally { await database.close(); }
