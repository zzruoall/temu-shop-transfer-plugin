/**
 * 账户执行账本：账户专属进程模式的持久调度索引。
 *
 * 职责边界（对应方案第 4 节）：
 * - `hub_account_runtime`：每账户一行，旧模式记录业务占用，弹性模式仅记录当前准备工作。
 *   弹性业务并发由独立的hub_elastic_work_slots约束，不通过更改账户主键伪造更多账户。
 * - `hub_account_work`：调度索引，一条记录=一次可调度的商品工作单元，
 *   幂等键绑定账户/方向/原任务/原轮次，防止重复入队。
 * - `hub_resource_leases`：统一资源令牌（进程名额、业务槽、平台未决许可）。
 *   平台未决许可不能按租约到期自动删除——那会把"可能已提交"当成"未提交"。
 * - `hub_process_control`：单一监督器领导代次，重启产生新 epoch。
 *
 * 这些表只做调度和资源索引；上架任务与回执的权威状态仍在既有 hub_jobs/hub_job_items，
 * 两边的状态变更必须走同一事务提交，不允许各自维护一套成功状态。
 */

export const ACCOUNT_EXECUTION_SCHEMA = [
    // 接收中的文件预算必须持久化；重启不能因内存计数丢失而重复放大磁盘预留。
    `CREATE TABLE IF NOT EXISTS hub_staging_reservations (
        id CHAR(36) PRIMARY KEY, account_id VARCHAR(255) NOT NULL,
        owner_pid INT NOT NULL, owner_identity VARCHAR(191) NOT NULL DEFAULT '',
        bytes BIGINT NOT NULL, source_ref VARCHAR(512) NOT NULL DEFAULT '', created_at VARCHAR(30) NOT NULL,
        INDEX(account_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    // 每账户一行：主键只用账户，避免"上传一条+上架一条"绕过每账户 1 件限制。
    `CREATE TABLE IF NOT EXISTS hub_account_runtime (
        account_id VARCHAR(255) PRIMARY KEY,
        current_work_id VARCHAR(255) NOT NULL DEFAULT '',
        store_id VARCHAR(255) NOT NULL DEFAULT '',
        run_id VARCHAR(255) NOT NULL DEFAULT '',
        state VARCHAR(30) NOT NULL DEFAULT 'idle',
        worker_epoch BIGINT NOT NULL DEFAULT 0,
        worker_lease_until VARCHAR(30) NOT NULL DEFAULT '',
        updated_at VARCHAR(30) NOT NULL,
        INDEX(state,updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    // 调度索引：幂等键用定长哈希，不用长字符串联合键——
    // utf8mb4 下 5 列 VARCHAR(255) 联合唯一键会超过 InnoDB 3072 字节上限。
    // idem_key = sha256(accountId|direction|业务身份)；input_fingerprint 用于识别
    // "同幂等键但业务输入不同"的冲突，不能静默吞并成同一工作单元。
    `CREATE TABLE IF NOT EXISTS hub_account_work (
        work_id VARCHAR(255) PRIMARY KEY,
        account_id VARCHAR(255) NOT NULL,
        store_id VARCHAR(255) NOT NULL,
        direction VARCHAR(20) NOT NULL,
        job_id VARCHAR(255) NOT NULL DEFAULT '',
        item_spu VARCHAR(255) NOT NULL DEFAULT '',
        request_id VARCHAR(255) NOT NULL DEFAULT '',
        run_id VARCHAR(255) NOT NULL DEFAULT '',
        idem_key CHAR(64) NOT NULL,
        input_fingerprint CHAR(64) NOT NULL DEFAULT '',
        -- 持久执行上下文（计划任务2）：刷新撤销、来源版本与授权复核都要靠这些字段，
        -- 不能用"运行时猜"或只比较 ID。
        actor_id VARCHAR(255) NOT NULL DEFAULT '',
        ownership_generation VARCHAR(64) NOT NULL DEFAULT '',
        execution_run_id VARCHAR(255) NOT NULL DEFAULT '',
        source_ref VARCHAR(512) NOT NULL DEFAULT '',
        source_hash CHAR(64) NOT NULL DEFAULT '',
        source_hash_algorithm VARCHAR(32) NOT NULL DEFAULT '',
        expected_bytes BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(30) NOT NULL,
        next_run_at VARCHAR(30) NOT NULL DEFAULT '',
        checkpoint_ref VARCHAR(255) NOT NULL DEFAULT '',
        created_at VARCHAR(30) NOT NULL,
        updated_at VARCHAR(30) NOT NULL,
        UNIQUE KEY uniq_work_idem (idem_key),
        INDEX(status,next_run_at,account_id,work_id),
        INDEX(account_id,status,next_run_at,work_id),
        INDEX(account_id,run_id,status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    // 统一资源令牌；kind 区分进程名额/业务槽/平台未决许可。
    `CREATE TABLE IF NOT EXISTS hub_resource_leases (
        lease_id VARCHAR(255) PRIMARY KEY,
        kind VARCHAR(30) NOT NULL,
        account_id VARCHAR(255) NOT NULL DEFAULT '',
        work_id VARCHAR(255) NOT NULL DEFAULT '',
        attempt_id VARCHAR(255) NOT NULL DEFAULT '',
        worker_epoch BIGINT NOT NULL DEFAULT 0,
        state VARCHAR(30) NOT NULL DEFAULT 'held',
        expires_at VARCHAR(30) NOT NULL DEFAULT '',
        created_at VARCHAR(30) NOT NULL,
        updated_at VARCHAR(30) NOT NULL,
        INDEX(kind,state,expires_at),
        INDEX(account_id,kind,state),
        INDEX(work_id,kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    // 单一监督器领导代次：重启后旧 epoch 一律失效。
    // 领导代次只由**数据库**授予：两个主服务同时启动时，只有抢到领导的那个能签发许可，
    // 失联或失去领导的一侧必须停止新授权（内存里计数做不到这一点）。
    `CREATE TABLE IF NOT EXISTS hub_process_control (
        id INT PRIMARY KEY,
        supervisor_epoch BIGINT NOT NULL DEFAULT 0,
        heartbeat_at VARCHAR(30) NOT NULL DEFAULT '',
        mode VARCHAR(10) NOT NULL DEFAULT 'off',
        config_version INT NOT NULL DEFAULT 1,
        updated_at VARCHAR(30) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    /**
     * 会改变持久状态的 IPC 消息去重结果。
     * 键绑定账户 + worker 代次 + messageId：重复消息返回**相同结果**，不重复执行副作用。
     * 只保留引用与摘要，不保存大正文。
     *
     * state 三态是并发幂等的关键：`claimed` 是**原子占位**（抢占唯一键），
     * `done` 才带可重放结果。没有占位就会出现"并发两次都看到没记录、于是各执行一次"。
     */
    `CREATE TABLE IF NOT EXISTS hub_worker_messages (
        message_id VARCHAR(191) PRIMARY KEY,
        account_id VARCHAR(255) NOT NULL DEFAULT '',
        worker_epoch BIGINT NOT NULL DEFAULT 0,
        operation VARCHAR(40) NOT NULL DEFAULT '',
        work_id VARCHAR(255) NOT NULL DEFAULT '',
        state VARCHAR(20) NOT NULL DEFAULT 'claimed',
        claimed_at VARCHAR(30) NOT NULL DEFAULT '',
        claim_token CHAR(36) NOT NULL DEFAULT '',
        completed_at VARCHAR(30) NOT NULL DEFAULT '',
        result_json JSON NULL,
        created_at VARCHAR(30) NOT NULL,
        INDEX(account_id,worker_epoch),
        INDEX(work_id),
        INDEX(state,created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    /**
     * 进程资源租约：保存 pid 与**启动身份**，PID 重用不能误认作旧 worker。
     * 监督器领导代次与 worker 代次分开管理。
     */
    `CREATE TABLE IF NOT EXISTS hub_process_leases (
        lease_id VARCHAR(191) PRIMARY KEY,
        account_id VARCHAR(255) NOT NULL DEFAULT '',
        worker_epoch BIGINT NOT NULL DEFAULT 0,
        supervisor_epoch BIGINT NOT NULL DEFAULT 0,
        pid INT NOT NULL DEFAULT 0,
        boot_id VARCHAR(191) NOT NULL DEFAULT '',
        state VARCHAR(20) NOT NULL DEFAULT 'live',
        heartbeat_at VARCHAR(30) NOT NULL DEFAULT '',
        created_at VARCHAR(30) NOT NULL,
        updated_at VARCHAR(30) NOT NULL,
        INDEX(account_id,state),
        INDEX(state,heartbeat_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`
];

/** 进程租约与消息去重表的必需列，供模式校验使用。 */
export const ACCOUNT_PROCESS_EXTRA_TABLES = Object.freeze({
    hub_staging_reservations: ['id', 'account_id', 'owner_pid', 'owner_identity', 'bytes', 'source_ref', 'created_at'],
    hub_worker_messages: ['message_id', 'account_id', 'worker_epoch', 'operation', 'work_id', 'state', 'claimed_at', 'claim_token', 'completed_at', 'result_json', 'created_at'],
    hub_process_leases: ['lease_id', 'account_id', 'worker_epoch', 'supervisor_epoch', 'pid', 'boot_id', 'state', 'heartbeat_at', 'created_at', 'updated_at']
});

/** 任务表补账户列：创建时冻结可信执行账户，之后不随认领变化改归属。 */
export const ACCOUNT_COLUMN_MIGRATIONS = [
    { table: 'hub_jobs', column: 'account_id', ddl: "ALTER TABLE hub_jobs ADD COLUMN account_id VARCHAR(255) NOT NULL DEFAULT ''" },
    { table: 'hub_jobs', column: 'account_index', ddl: 'ALTER TABLE hub_jobs ADD INDEX(account_id,record_group,updated_at)' },
    // actor 与 owner 分开：管理员代操作不改变任务归属。
    { table: 'hub_jobs', column: 'actor_id', ddl: "ALTER TABLE hub_jobs ADD COLUMN actor_id VARCHAR(255) NOT NULL DEFAULT ''" }
];

/**
 * 列/索引是否存在。迁移可重复执行的关键：先查再改，不用"忽略错误"掩盖失败。
 */
export async function columnExists(database, table, column) {
    const [[row]] = await database.query('maintenance',
        "SELECT COUNT(*) AS n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?",
        [table, column]);
    return Number(row.n) > 0;
}

/**
 * 表是否存在。增量迁移必须先判断这一点：
 * 对还不存在的表做 ALTER 会直接报错，而"表已存在但缺列"正是需要补的旧库形态。
 */
export async function tableExists(database, table) {
    const [[row]] = await database.query('maintenance',
        'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=?',
        [table]);
    return Number(row.n) > 0;
}

export async function indexExists(database, table, indexName) {    const [[row]] = await database.query('maintenance',
        "SELECT COUNT(*) AS n FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?",
        [table, indexName]);
    return Number(row.n) > 0;
}

/**
 * 历史任务隔离：无法确定归属的旧任务进入 needs_confirmation，不自动授权。
 *
 * 当前认领关系不能证明历史提交时的归属和授权，来源店铺更不是上架执行账户。
 * 即使调用方提供当前 assignments，也只隔离旧任务，不自动回填并激活。
 *
 * 关键：旧领取链读取的是 **body/summary JSON 列**而不是 status 标量列
 * （见 mysql-job-repository 的 readState），所以只改标量列等于没隔离——
 * 旧链仍会从 body 里读到 queued 并选中它。必须三处同步：
 * 标量 status、body.status、summary.status，并把 record_group 移出 active。
 * 原始状态与 attempt 证据保留在 body 的 originalStatus 字段里，不直接清成新任务。
 */
export async function isolateUnownedHistory(database) {
    // 注意：这里**必须包含**已经是 needs_confirmation 的行。
    // 上一版迁移只改了标量列就把行标成待确认，body/summary 仍写着 queued；
    // 若查询排除已标记录，重跑迁移永远修不好这些残留（复核 T4）。
    const [rows] = await database.query('maintenance',
        "SELECT id,source_store,status,body,summary,record_group FROM hub_jobs WHERE account_id='' AND record_group<>'done'");
    let backfilled = 0, isolated = 0, repaired = 0;
    const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
    for (const row of rows) {
        const body = parse(row.body) || {};
        const summary = parse(row.summary) || {};
        const originalStatus = String(body.originalStatus || body.status || row.status || '');
        // 判定"是否需要隔离/修复"：标量、body、summary 三处任一还不是终态隔离值，都算。
        const scalarIsolated = row.status === 'needs_confirmation';
        const bodyIsolated = body.status === 'needs_confirmation';
        const summaryIsolated = summary.status === 'needs_confirmation';
        if (scalarIsolated && bodyIsolated && summaryIsolated && row.record_group === 'attention') continue;
        // 三处状态同步为待确认，并移出 active；原状态写入 originalStatus 保留核对依据。
        body.originalStatus = body.originalStatus || originalStatus;
        body.status = 'needs_confirmation';
        body.quarantinedAt = body.quarantinedAt || new Date().toISOString();
        body.quarantineReason = body.quarantineReason || '历史任务无法确定归属，需人工确认后再决定是否执行';
        summary.originalStatus = summary.originalStatus || originalStatus;
        summary.status = 'needs_confirmation';
        await database.query('maintenance',
            "UPDATE hub_jobs SET status='needs_confirmation',record_group='attention',body=?,summary=? WHERE id=?",
            [JSON.stringify(body), JSON.stringify(summary), row.id]);
        if (scalarIsolated) repaired += 1; else isolated += 1;
    }
    return { scanned: rows.length, backfilled, isolated, repaired };
}

/**
 * 增量迁移：建新表（幂等）+ 补 hub_jobs 列（先查后加）+ 隔离无归属历史。
 * 返回实际执行的步骤，便于对账"重跑不重复改动"。
 */
export async function migrateAccountExecution(database, { assignments = null } = {}) {
    const applied = [];
    for (const statement of ACCOUNT_EXECUTION_SCHEMA) {
        await database.query('maintenance', statement);
        const match = /CREATE TABLE IF NOT EXISTS (\w+)/.exec(statement);
        if (match) applied.push(`table:${match[1]}`);
    }
    if (!await columnExists(database, 'hub_jobs', 'account_id')) {
        await database.query('maintenance', "ALTER TABLE hub_jobs ADD COLUMN account_id VARCHAR(255) NOT NULL DEFAULT ''");
        applied.push('column:hub_jobs.account_id');
    }
    if (!await indexExists(database, 'hub_jobs', 'account_index')) {
        await database.query('maintenance', 'ALTER TABLE hub_jobs ADD INDEX account_index(account_id,record_group,updated_at)');
        applied.push('index:hub_jobs.account_index');
    }
    if (!await columnExists(database, 'hub_jobs', 'actor_id')) {
        await database.query('maintenance', "ALTER TABLE hub_jobs ADD COLUMN actor_id VARCHAR(255) NOT NULL DEFAULT ''");
        applied.push('column:hub_jobs.actor_id');
    }
    // 既有库补 input_fingerprint 列（新建表已含，旧库需要补）。
    if (!await columnExists(database, 'hub_account_work', 'input_fingerprint')) {
        await database.query('maintenance', "ALTER TABLE hub_account_work ADD COLUMN input_fingerprint CHAR(64) NOT NULL DEFAULT ''");
        applied.push('column:hub_account_work.input_fingerprint');
    }
    /**
     * 既有库补持久执行上下文列（计划任务2）。
     *
     * 这些列承载"来源引用/摘要/所有权代次/轮次"，是撤销与授权复核的依据。
     * 旧库升级时必须逐列补齐：`CREATE TABLE IF NOT EXISTS` 对已存在的表不做任何事，
     * 只靠"新库建表两次"自证会漏掉真实升级路径。
     * 默认值一律为空/0——**不**给旧行编造来源摘要，宁可让它们显式缺证据。
     */
    for (const [column, ddl] of [
        ['actor_id', "VARCHAR(255) NOT NULL DEFAULT ''"],
        ['ownership_generation', "VARCHAR(64) NOT NULL DEFAULT ''"],
        ['execution_run_id', "VARCHAR(255) NOT NULL DEFAULT ''"],
        ['source_ref', "VARCHAR(512) NOT NULL DEFAULT ''"],
        ['source_hash', "CHAR(64) NOT NULL DEFAULT ''"],
        ['source_hash_algorithm', "VARCHAR(32) NOT NULL DEFAULT ''"],
        ['expected_bytes', "BIGINT NOT NULL DEFAULT 0"]
    ]) {
        if (!await columnExists(database, 'hub_account_work', column)) {
            await database.query('maintenance', `ALTER TABLE hub_account_work ADD COLUMN ${column} ${ddl}`);
            applied.push(`column:hub_account_work.${column}`);
        }
    }
    /**
     * 旧消息表补增量列。
     *
     * `CREATE TABLE IF NOT EXISTS` 对**已存在**的表什么都不做，所以上一版建出的
     * hub_worker_messages 不会自动获得 state/claimed_at/completed_at，broker 一调用就报
     * `Unknown column 'state'`。迁移必须显式 ALTER，不能只靠"新库建表两次"自证。
     */
    if (await tableExists(database, 'hub_worker_messages')) {
        if (!await columnExists(database, 'hub_worker_messages', 'state')) {
            await database.query('maintenance', "ALTER TABLE hub_worker_messages ADD COLUMN state VARCHAR(20) NOT NULL DEFAULT 'claimed'");
            applied.push('column:hub_worker_messages.state');
        }
        if (!await columnExists(database, 'hub_worker_messages', 'claimed_at')) {
            await database.query('maintenance', "ALTER TABLE hub_worker_messages ADD COLUMN claimed_at VARCHAR(30) NOT NULL DEFAULT ''");
            applied.push('column:hub_worker_messages.claimed_at');
        }
        if (!await columnExists(database, 'hub_worker_messages', 'claim_token')) {
            // 旧行没有持有者令牌：留空表示"无法确认当前持有人"，
            // 这类行的回执不会被任何 token 写回，只能靠 done 状态重放或人工核对。
            await database.query('maintenance', "ALTER TABLE hub_worker_messages ADD COLUMN claim_token CHAR(36) NOT NULL DEFAULT ''");
            applied.push('column:hub_worker_messages.claim_token');
        }
        if (!await columnExists(database, 'hub_worker_messages', 'completed_at')) {
            await database.query('maintenance', "ALTER TABLE hub_worker_messages ADD COLUMN completed_at VARCHAR(30) NOT NULL DEFAULT ''");
            applied.push('column:hub_worker_messages.completed_at');
        }
        if (!await indexExists(database, 'hub_worker_messages', 'state')) {
            await database.query('maintenance', 'ALTER TABLE hub_worker_messages ADD INDEX state(state,created_at)');
            applied.push('index:hub_worker_messages.state');
        }
        /**
         * 旧行回填：有 result_json 的说明当时已经算出结果，必须标成 **done**，
         * 不能留在默认的 claimed——claimed 会被当作"可能还没算完"，
         * 租期一过就会被接管重做，等于让已完成的副作用再执行一次。
         * 没有结果的旧行保守留在 claimed，等调用方重试或人工处理，不臆测它已完成。
         */
        const [backfill] = await database.query('maintenance',
            `UPDATE hub_worker_messages SET state='done',
                completed_at=CASE WHEN completed_at='' THEN created_at ELSE completed_at END,
                claimed_at=CASE WHEN claimed_at='' THEN created_at ELSE claimed_at END
             WHERE state='claimed' AND result_json IS NOT NULL`);
        if (Number(backfill?.affectedRows || 0) > 0) applied.push(`rows:hub_worker_messages.done:${Number(backfill.affectedRows)}`);
        const [orphan] = await database.query('maintenance',
            "UPDATE hub_worker_messages SET claimed_at=created_at WHERE claimed_at=''");
        if (Number(orphan?.affectedRows || 0) > 0) applied.push(`rows:hub_worker_messages.claimed_at:${Number(orphan.affectedRows)}`);
    }
    await database.query('maintenance',
        "INSERT INTO hub_process_control(id,supervisor_epoch,heartbeat_at,mode,config_version,updated_at) VALUES(1,0,'','off',1,?) ON DUPLICATE KEY UPDATE id=VALUES(id)",
        [new Date().toISOString()]);
    applied.push('row:hub_process_control#1');
    // 迁移必须同时隔离无归属历史：否则旧任务仍留在可执行状态，新模式一旦打开就会执行它们。
    const history = await isolateUnownedHistory(database, assignments);
    if (history.isolated) applied.push(`history:isolated:${history.isolated}`);
    if (history.backfilled) applied.push(`history:backfilled:${history.backfilled}`);
    // 旧账户工作行也要分类，不能留着 queued 被新运行器自动重放。
    const legacyWork = await classifyLegacyAccountWork(database);
    if (legacyWork.classified) applied.push(`accountWork:classified:${legacyWork.classified}`);
    return applied;
}

/**
 * 分类存量账户工作行（计划任务2）。
 *
 * 打开新模式后**绝不能**把历史的 queued 行当成"待执行"直接跑起来：
 * 那些行来自旧导入路径，既没有来源引用/摘要，也没有所有权代次，
 * 自动重放等于绕过新的身份与资源约束。
 *
 * 分类规则（保守，缺证据一律不动它去执行）：
 * - 缺轮次、可信归属或来源证据的待执行行 → needs_confirmation；
 * - 已终态及unknown保持原样，不清除可能已产生副作用的证据；
 * - 上下文齐全也不等于授权有效，领取时仍要复核当前归属和撤销状态。
 */
export async function classifyLegacyAccountWork(database) {
    if (!await tableExists(database, 'hub_account_work')) return { classified: 0 };
    if (!await columnExists(database, 'hub_account_work', 'source_hash')) return { classified: 0 };
    // 只处理待执行行，不能把未知结果改成可以安全重新提交的普通失败。
    const [result] = await database.query('maintenance',
        `UPDATE hub_account_work SET status='needs_confirmation', updated_at=?
         WHERE status IN ('queued','waiting') AND
           (account_id='' OR store_id='' OR run_id='' OR execution_run_id='' OR actor_id=''
            OR ownership_generation='' OR source_ref='' OR source_hash='' OR source_hash_algorithm<>'sha256'
            OR expected_bytes<=0)`,
        [new Date().toISOString()]);
    return { classified: Number(result?.affectedRows || 0) };
}
