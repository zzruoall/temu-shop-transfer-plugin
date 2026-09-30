import { readFile } from "node:fs/promises";

/**
 * 连接池按职责预留容量；分发堆积不能用光回执和心跳所需的数据库连接。
 *
 * control 只服务**停止/撤销与必要短事务**（含监督器领导代次 CAS），
 * feedback 只处理回执。两者必须分开：否则一次长迁移或批量扫描会占住 control，
 * 让"停止"这个最需要及时响应的操作排在它后面。
 * 初始总上限保持 14，不因为新增通道而放宽。
 */
const LANES = Object.freeze({ ingest: 2, dispatch: 4, feedback: 2, control: 2, query: 3, maintenance: 1 });

/** 配置只从受保护文件加载，不把密码放进命令行、网页响应或启动日志。 */
export async function openMysqlDatabase(configPath = process.env.TEMU_MYSQL_CONFIG) {
    if (!configPath) return null;
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (!config.database || !config.user) throw new Error("MySQL 配置缺少数据库或专用账号");
    const { createPool } = await import("mysql2/promise");
    const pools = new Map();
    const listeners = new Set();
    // 仅聚合运行指标，不采集SQL参数和凭证，反馈积压优先触发降速。
    const metrics = { pending: {}, waitMs: 0, errors: 0, updatedAt: Date.now() };
    for (const [lane, limit] of Object.entries(LANES)) {
        pools.set(lane, createPool({
            host: config.host || "127.0.0.1", port: Number(config.port) || 3306,
            user: config.user, password: config.password || "", database: config.database,
            ...(config.socketPath ? { socketPath: config.socketPath } : {}),
            charset: "utf8mb4_bin", timezone: "Z", supportBigNumbers: true, bigNumberStrings: true,
            connectionLimit: limit, maxIdle: limit, idleTimeout: 60000,
            waitForConnections: true, queueLimit: lane === "feedback" ? 512 : 128, connectTimeout: 10000,
            multipleStatements: false, enableKeepAlive: true,
        }));
    }
    const poolFor = lane => {
        const pool = pools.get(lane);
        if (!pool) throw new Error(`未知数据库职责: ${lane}`);
        return pool;
    };
    /** 未取得连接时的过载可安全退避；已经执行的事务仍必须明确提交或回滚。 */
    async function withConnection(lane, fn) {
        let connection;
        const started = Date.now();
        metrics.pending[lane] = (metrics.pending[lane] || 0) + 1;
        try { connection = await poolFor(lane).getConnection(); }
        catch (error) {
            metrics.errors++; metrics.updatedAt = Date.now();
            if (/queue limit/i.test(error.message) || ['ER_CON_COUNT_ERROR', 'ER_USER_LIMIT_REACHED'].includes(error.code)) throw Object.assign(new Error("数据库请求已排队，请稍后重试"), { status: 503, retryAfter: 5, code: "database_capacity_wait" });
            throw error;
        }
        finally { metrics.pending[lane]--; metrics.waitMs = metrics.waitMs * 0.8 + (Date.now() - started) * 0.2; }
        try { return await fn(connection); }
        catch (error) { if (!error.status || error.status >= 500) { metrics.errors++; metrics.updatedAt = Date.now(); } throw error; }
        finally { connection.release(); }
    }
    // 不透明重试业务事务：回调可能涉及商品文件和外部状态，自动重跑会产生重复副作用。
    async function transaction(lane, fn) {
        return withConnection(lane, async connection => {
            await connection.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
            await connection.beginTransaction();
            try {
                const value = await fn(connection);
                await connection.commit();
                for (const listener of listeners) {
                    try { listener(); } catch { /* 通知失败不能把已提交事务误报成业务失败。 */ }
                }
                return value;
            } catch (error) {
                await connection.rollback().catch(() => {});
                throw error;
            }
        });
    }
    const database = {
        withConnection, transaction,
        query: (lane, sql, params = []) => withConnection(lane, connection => connection.query(sql, params)),
        close: async () => { for (const pool of pools.values()) await pool.end(); },
        name: config.database,
        pressure: () => ({ dbWaitMs: metrics.waitMs, feedbackPending: metrics.pending.feedback || 0, errors: Date.now() - metrics.updatedAt < 30000 ? metrics.errors : (metrics.errors = 0) }),
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    };
    try {
        const [[row]] = await database.query("maintenance", "SELECT VERSION() AS version");
        if (!/^8\./.test(row.version)) throw new Error("中转仓数据库要求 MySQL 8.x");
    } catch (error) { await database.close(); throw error; }
    return database;
}
