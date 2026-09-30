import { AsyncLocalStorage } from "node:async_hooks";

// 小规模的归属与删除目录按条存储；锁只约束同一目录，不阻塞商品入库或任务回执。
export const MAP_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS hub_map_locks (
        domain VARCHAR(64) NOT NULL PRIMARY KEY
    ) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS hub_map_entries (
        domain VARCHAR(64) NOT NULL, entry_key VARCHAR(255) NOT NULL, body JSON NOT NULL,
        PRIMARY KEY(domain, entry_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

/** 复用已有归属业务规则，事务内读写逐条目录；跨进程认领也不能出现两个所有者。 */
export function createMysqlMap(database, domain, field) {
    const context = new AsyncLocalStorage();
    const parse = value => typeof value === "string" ? JSON.parse(value) : value;
    async function read() {
        const sql = "SELECT entry_key, body FROM hub_map_entries WHERE domain=?";
        const conn = context.getStore();
        let rows;
        try {
            [rows] = conn ? await conn.query(sql, [domain]) : await database.query("query", sql, [domain]);
        } catch (error) {
            /**
             * 目录表读取失败是**依赖不可用**，必须报 503 而不是冒成 500。
             *
             * 500 会让调用方以为"服务端有 bug"而放弃重试；而归属/删除名单读不到
             * 只是暂时不可查，客户端稍后重试即可。这一层是所有目录调用方的公共入口，
             * 在这里分类一次，胜过让每个调用方各自包裹 try/catch。
             */
            throw Object.assign(new Error('map_directory_unavailable'), {
                status: 503, retryAfter: 5, code: 'map_directory_unavailable',
                detail: String(error?.code || error?.message || error)
            });
        }
        return { version: 1, [field]: Object.fromEntries(rows.map(row => [row.entry_key, parse(row.body)])) };
    }
    async function write(state) {
        const conn = context.getStore();
        if (!conn) throw new Error("目录写入必须处于事务内");
        const before = await read();
        for (const key of Object.keys(before[field])) {
            if (!Object.hasOwn(state[field], key)) await conn.query("DELETE FROM hub_map_entries WHERE domain=? AND entry_key=?", [domain, key]);
        }
        for (const [key, value] of Object.entries(state[field])) {
            if (JSON.stringify(before[field][key]) === JSON.stringify(value)) continue;
            await conn.query("INSERT INTO hub_map_entries(domain,entry_key,body) VALUES(?,?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)", [domain, key, JSON.stringify(value)]);
        }
    }
    async function transaction(fn) {
        if (context.getStore()) return fn();
        return database.transaction("maintenance", async conn => {
            await conn.query("INSERT INTO hub_map_locks(domain) VALUES(?) ON DUPLICATE KEY UPDATE domain=VALUES(domain)", [domain]);
            return context.run(conn, fn);
        });
    }
    return { read, write, transaction };
}
