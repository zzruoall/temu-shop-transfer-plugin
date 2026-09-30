import { watch } from "node:fs";
import path from "node:path";

/**
 * 单进程 SSE 通知总线：磁盘提交后合并通知，同一账号的多个标签共享一次快照计算。
 * 推送的只是不可逆版本摘要，具体业务数据仍由原有鉴权接口读取；重连发送完整当前版本补漏。
 */
export function createLiveEvents({ rootDir, snapshot, authorize }) {
    const clients = new Set();
    const watchers = new Map();
    let scheduled = null;
    let running = false;
    let dirty = false;
    let heartbeat = null;

    /** 断开慢消费者，避免长连接积压响应占满内存；客户端重连后按快照补同步。 */
    function write(client, message) {
        if (client.res.destroyed || client.res.writableEnded) return false;
        if (!client.res.write(message)) {
            client.res.destroy();
            return false;
        }
        return true;
    }

    /** 监听目录而非文件，兼容业务文件通过临时文件原子替换；缺失目录在保活时补挂。 */
    function ensureWatchers() {
        for (const dir of [rootDir, path.join(rootDir, "data"), path.join(rootDir, "data", "work-logs")]) {
            if (watchers.has(dir)) continue;
            try {
                const watcher = watch(dir, { persistent: false }, (_event, filename) => {
                    const name = String(filename || "");
                    if (!name || /\.json$/.test(name) || name === "work-logs") notify();
                });
                watcher.on("error", () => { watcher.close(); watchers.delete(dir); });
                watchers.set(dir, watcher);
            } catch (error) {
                if (error.code !== "ENOENT") console.error("SSE 目录监听失败", error.code);
            }
        }
    }

    /** 无客户端就释放所有资源，不因 SSE 引入常驻仓库扫描。 */
    function stopIdle() {
        if (clients.size) return;
        clearTimeout(scheduled);
        scheduled = null;
        clearInterval(heartbeat);
        heartbeat = null;
        for (const watcher of watchers.values()) watcher.close();
        watchers.clear();
    }

    async function flush() {
        scheduled = null;
        if (running) { dirty = true; return; }
        if (!clients.size) return;
        running = true;
        dirty = false;
        const snapshots = new Map();
        try {
            for (const client of [...clients]) {
                try {
                    // 每次推送前重验会话与角色，账户被禁用或权限收回后不继续沿用连接时权限。
                    const identity = await authorize(client.req);
                    if (!identity) {
                        write(client, "event: auth-expired\ndata: {}\n\n");
                        client.res.end();
                        continue;
                    }
                    if (!snapshots.has(identity)) snapshots.set(identity, snapshot(client.req));
                    const data = JSON.stringify(await snapshots.get(identity));
                    if (!clients.has(client)) continue;
                    if (client.last !== data && write(client, `event: live\ndata: ${data}\n\n`)) client.last = data;
                } catch (error) {
                    // 不发送伪造的空版本；保留上次快照，下轮或重连后重试。
                    console.error("SSE 快照读取失败", error.code || error.name);
                }
            }
        } finally {
            running = false;
            if (dirty && clients.size) notify();
        }
    }

    /** 合并同一批次的多次落盘，防止上传和心跳产生推送风暴。 */
    function notify() {
        if (!clients.size) return;
        if (running) { dirty = true; return; }
        if (!scheduled) scheduled = setTimeout(() => void flush(), 250);
    }

    /** 路由必须先完成初始认证；连接上限避免同一账号无限创建长连接。 */
    function connect(req, res) {
        const owner = req.temuUser?.id || (req.temuLocalMode ? "local" : "device");
        if (clients.size >= 500 || [...clients].filter(client => client.owner === owner).length >= 20) {
            res.writeHead(429, { "content-type": "application/json", "retry-after": "60" });
            res.end(JSON.stringify({ error: "too_many_event_connections" }));
            return;
        }
        res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no"
        });
        res.flushHeaders();
        req.socket.setTimeout(0);
        const client = { req, res, owner, last: null, connectedAt: Date.now() };
        clients.add(client);
        res.on("close", () => { clients.delete(client); stopIdle(); });
        res.on("error", () => { clients.delete(client); stopIdle(); });
        write(client, "retry: 5000\n: connected\n\n");
        ensureWatchers();
        if (!heartbeat) {
            // 保活不触发前端渲染；共享检查仅补偿掉线超时与文件监听丢失，不按连接重复查询。
            heartbeat = setInterval(() => {
                for (const entry of clients) {
                    // 定期重建连接，让其他标签退出登录后当前 Cookie 也能重新参与鉴权。
                    if (Date.now() - entry.connectedAt >= 300000) entry.res.end();
                    else write(entry, ": heartbeat\n\n");
                }
                ensureWatchers();
                notify();
            }, 15000);
            heartbeat.unref();
        }
        notify();
    }

    return { connect, notify };
}
