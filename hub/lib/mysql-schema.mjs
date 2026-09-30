import path from "node:path";
import { INVENTORY_SCHEMA } from "./mysql-inventory.mjs";
import { JOB_SCHEMA } from "./mysql-job-repository.mjs";
import { MAP_SCHEMA } from "./mysql-map.mjs";
import { BULK_SCHEMA } from "./bulk-dispatch.mjs";
import { INGEST_PROTOCOL_SCHEMA } from './ingest-protocol.mjs';
import { ACCOUNT_PROCESS_EXTRA_TABLES } from './account-execution-schema.mjs';

/**
 * 账户进程模式依赖的字段清单。
 * 模式校验会逐列 SELECT，缺列即判未就绪——只看"表存在"会放过缺列的半成品 schema。
 * 清单必须覆盖**实际读写用到的列**：入队、检查点、结算、租约、历史隔离各自用到的
 * 标识列、时间列与状态列都要在列内，不能只覆盖上一次探针恰好删掉的那一列。
 */
export const ACCOUNT_PROCESS_REQUIRED_COLUMNS = Object.freeze({
    hub_account_work: ['work_id', 'account_id', 'store_id', 'direction', 'job_id', 'item_spu', 'request_id',
        'run_id', 'idem_key', 'input_fingerprint', 'actor_id', 'ownership_generation', 'execution_run_id',
        'source_ref', 'source_hash', 'source_hash_algorithm', 'expected_bytes', 'status', 'next_run_at', 'checkpoint_ref', 'created_at', 'updated_at'],
    ...ACCOUNT_PROCESS_EXTRA_TABLES,
    hub_account_runtime: ['account_id', 'current_work_id', 'store_id', 'run_id', 'state', 'worker_epoch', 'worker_lease_until', 'updated_at'],
    hub_resource_leases: ['lease_id', 'kind', 'account_id', 'work_id', 'attempt_id', 'worker_epoch', 'state', 'expires_at', 'created_at', 'updated_at'],
    hub_process_control: ['id', 'supervisor_epoch', 'heartbeat_at', 'mode', 'config_version', 'updated_at'],
    hub_jobs: ['id', 'account_id', 'actor_id', 'status', 'record_group', 'source_store', 'target_store', 'body', 'summary', 'updated_at']
});

/** DDL 仅由迁移工具执行，正式服务账号启动时只校验版本和资料目录。 */
export async function initializeMysqlSchema(database) {
    await database.query("maintenance", `CREATE TABLE IF NOT EXISTS hub_schema (
        id INT PRIMARY KEY, version INT NOT NULL, state VARCHAR(20) NOT NULL, data_root TEXT NOT NULL, manifest JSON
    ) ENGINE=InnoDB`);
    for (const statement of [...INVENTORY_SCHEMA, ...JOB_SCHEMA, ...MAP_SCHEMA, ...BULK_SCHEMA, INGEST_PROTOCOL_SCHEMA]) await database.query("maintenance", statement);
}

/** 未完整迁移时拒绝启动；不能在数据库故障时回退旧 JSON 造成两个数据源分叉。 */
export async function assertMysqlReady(database, rootDir) {
    const [[row]] = await database.query("maintenance", "SELECT version,state,data_root FROM hub_schema WHERE id=1");
    if (!row || row.version !== 1 || row.state !== "ready" || path.resolve(row.data_root) !== path.resolve(rootDir)) {
        throw new Error("MySQL 迁移未完成、版本不匹配或原始资料目录不一致，停止启动");
    }
    // 扩展表必须先经部署迁移创建，不能启动成功后才让用户发送操作失败。
    await database.query("maintenance", "SELECT id FROM hub_bulk_dispatch LIMIT 0");
    await database.query("maintenance", "SELECT bulk_id FROM hub_bulk_failures LIMIT 0");
    await database.query('maintenance', 'SELECT store_id FROM hub_execution_wait LIMIT 0');
    await database.query('maintenance', 'SELECT id FROM hub_ingest_requests LIMIT 0');
}

/**
 * 账户进程模式的就绪校验。
 *
 * 方案要求：迁移未完成时**拒绝开启新模式**，不能等运行中才发现表不存在。
 * 模式取值：
 * - off：沿原路径，不需要新表；
 * - shadow：只计算与观测，不启动子进程、不签发新许可，需要新表可读；
 * - on：统一新门控，需要新表可读且监督器领导行存在。
 *
 * 校验必须覆盖**迁移实际依赖的字段**，不能只看表能否 SELECT：
 * 少一列（例如 input_fingerprint）时表仍可查，但入队会失败。
 * 表或列缺失一律抛错，不静默降级成 off。
 */
/**
 * 归一化账户进程模式。
 *
 * 非法值必须**明确报错**，不能悄悄降级成 off 或规范化成 on：
 * - 悄悄降级成 off：运维以为开了新模式，实际还在旧路径上跑；
 * - 悄悄规范化成 on：拼错的值会打开一个没准备好的执行链。
 * 两种情况都属于"模式失真"，所以这里把判定权交给调用方（`invalid: true`）。
 */
export function normalizeAccountProcessMode(requested) {
    const raw = String(requested ?? '').trim();
    if (raw === '') return { mode: 'off', invalid: false, raw };
    if (raw === 'off' || raw === 'shadow' || raw === 'on') return { mode: raw, invalid: false, raw };
    // 大小写或未知值：标记非法，由启动路径拒绝，不猜运维的意图。
    return { mode: 'off', invalid: true, raw };
}

export async function assertAccountProcessMode(database, requested = 'off') {
    const normalized = normalizeAccountProcessMode(requested);
    if (normalized.invalid) {
        throw Object.assign(new Error(`账户进程模式取值非法：${normalized.raw}（只接受 off/shadow/on）`),
            { code: 'account_mode_invalid' });
    }
    const mode = normalized.mode;
    if (mode === 'off') return { mode, checked: false };
    try {
        for (const [table, columns] of Object.entries(ACCOUNT_PROCESS_REQUIRED_COLUMNS)) {
            const list = columns.map(name => `\`${name}\``).join(',');
            await database.query('maintenance', `SELECT ${list} FROM ${table} LIMIT 0`);
        }
    } catch (error) {
        throw new Error(`账户进程模式 ${mode} 需要先完成账户执行账本迁移：${error.message}`);
    }
    const [[control]] = await database.query('maintenance', 'SELECT supervisor_epoch,mode FROM hub_process_control WHERE id=1');
    if (!control) throw new Error(`账户进程模式 ${mode} 缺少监督器领导行，请重新执行迁移`);
    return { mode, checked: true, supervisorEpoch: Number(control.supervisor_epoch), recordedMode: control.mode };
}
