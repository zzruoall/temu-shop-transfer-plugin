/** 逐工作占位保留原执行身份；账户runtime只管理当前准备进程，不能用后来任务的代次结算前一店。 */
export async function initializeElasticWorkSlots(database) {
    await database.query('maintenance', `CREATE TABLE IF NOT EXISTS hub_elastic_work_slots (
        work_id VARCHAR(255) PRIMARY KEY, account_id VARCHAR(255) NOT NULL,
        store_id VARCHAR(255) NOT NULL, run_id VARCHAR(255) NOT NULL,
        worker_epoch BIGINT NOT NULL, state VARCHAR(30) NOT NULL,
        updated_at VARCHAR(30) NOT NULL, UNIQUE KEY(store_id), INDEX(account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);
    await assertElasticWorkSlotsReady(database);
}

/** 切换要求旧任务已排空或已拥有槽证据，禁止用空表让未决工作丢失占用。 */
export async function assertElasticWorkSlotsReady(database) {
    await database.query('query', 'SELECT work_id,account_id,store_id,run_id,worker_epoch,state,updated_at FROM hub_elastic_work_slots LIMIT 0');
    const [keys] = await database.query('query', `SELECT INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='hub_elastic_work_slots' AND NON_UNIQUE=0 GROUP BY INDEX_NAME`);
    if (!keys.some(key => key.cols === 'work_id') || !keys.some(key => key.cols === 'store_id')) throw Error('elastic_unique_indexes_missing');
    const [[row]] = await database.query('query', `SELECT COUNT(*) AS n FROM hub_account_work w
        LEFT JOIN hub_elastic_work_slots s ON s.work_id=w.work_id
        WHERE w.status IN ('running','waiting','unknown') AND s.work_id IS NULL`);
    if (Number(row.n)) throw Error('elastic_cutover_requires_drained_work');
    const [[invalid]] = await database.query('query', `SELECT COUNT(*) AS n FROM hub_elastic_work_slots s
        LEFT JOIN hub_account_work w ON w.work_id=s.work_id WHERE w.work_id IS NULL
        OR w.account_id<>s.account_id OR w.store_id<>s.store_id OR w.run_id<>s.run_id
        OR w.status NOT IN ('running','waiting','unknown') OR w.status<>s.state`);
    if (Number(invalid.n)) throw Error('elastic_slot_evidence_conflict');
    // 重启要核对原许可与prepared投影的代次，不能只比较槽和工作的归属字段。
    const [[epochs]] = await database.query('query', `SELECT COUNT(*) AS n FROM hub_elastic_work_slots s
        JOIN hub_account_work w ON w.work_id=s.work_id
        LEFT JOIN hub_account_runtime r ON r.current_work_id=s.work_id AND r.account_id=s.account_id
        LEFT JOIN hub_job_items i ON i.job_id=w.job_id AND i.spu_id=w.item_spu
        WHERE (r.account_id IS NOT NULL AND (r.worker_epoch<>s.worker_epoch OR r.run_id<>s.run_id))
        OR EXISTS(SELECT 1 FROM hub_resource_leases l WHERE l.work_id=s.work_id AND l.kind='platform' AND l.state='held'
            AND (l.worker_epoch<>s.worker_epoch OR l.account_id<>s.account_id))
        OR (JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.accountWork.preparedEpoch')) IS NOT NULL
            AND JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.accountWork.preparedEpoch'))<>'null'
            AND CAST(JSON_UNQUOTE(JSON_EXTRACT(i.body,'$.accountWork.preparedEpoch')) AS UNSIGNED)<>s.worker_epoch)`);
    if (Number(epochs.n)) throw Error('elastic_slot_epoch_conflict');
}

/** 退回旧模式前必须排空业务槽，否则已分离进程的回执会失去合法身份。 */
export async function assertElasticDisabledSafe(database) {
    try {
        const [[row]] = await database.query('query', 'SELECT COUNT(*) AS n FROM hub_elastic_work_slots');
        if (Number(row.n)) throw Error('elastic_disable_requires_drained_work');
    } catch (error) { if (error.code !== 'ER_NO_SUCH_TABLE') throw error; }
}

/** 调用方必须已持有account-admission事务锁；只为可执行新工作分配，不改变已有许可。 */
export async function reserveElasticSlot(connection, work, epoch, budget) {
    const [slots] = await connection.query('SELECT * FROM hub_elastic_work_slots FOR UPDATE');
    const own = slots.filter(s => s.account_id === work.account_id).length;
    if (!Number.isInteger(budget.businessLimit) || !Number.isInteger(budget.perAccountLimit)
        || slots.length >= budget.businessLimit || own >= budget.perAccountLimit) return 'elastic_capacity_wait';
    if (slots.some(s => s.store_id === work.store_id)) return 'elastic_store_busy';
    // 仍有可运行且占用较少的账户时，不让已借用账户继续抢空位。所有借用都在持久首锁内判定。
    if (own) {
        const [ready] = await connection.query(`SELECT DISTINCT w.account_id FROM hub_account_work w
            WHERE w.status='queued' AND (w.next_run_at='' OR w.next_run_at<=?)
            AND w.account_id<>? AND w.actor_id<>'' AND w.run_id<>'' AND w.execution_run_id=w.run_id AND w.ownership_generation<>''
            AND NOT EXISTS(SELECT 1 FROM hub_elastic_work_slots s WHERE s.store_id=w.store_id)
            AND NOT EXISTS(SELECT 1 FROM hub_account_runtime r WHERE r.account_id=w.account_id AND r.current_work_id<>'' AND r.state<>'idle')`,
        [new Date().toISOString(), work.account_id]);
        if (ready.some(r => slots.filter(s => s.account_id === r.account_id).length < own)) return 'elastic_fair_share_wait';
    }
    await connection.query('INSERT INTO hub_elastic_work_slots VALUES(?,?,?,?,?,?,?)',
        [work.work_id, work.account_id, work.store_id, work.run_id, epoch, 'running', new Date().toISOString()]);
    return '';
}
