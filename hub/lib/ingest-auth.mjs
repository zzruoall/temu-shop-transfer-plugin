/**
 * 入库台直推口的令牌与可访问地址。
 * 中转仓直推口的令牌与可访问地址。
 * 紫鸟扩展不能假定 127.0.0.1 就是这台 Windows 上的仓库，所以启动时同时给出本机和局域网地址。
 * 新中转仓默认端口 18380，避开旧入库台的 17380。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PORT = 18380;

export function getBindHost(env = process.env) {
    const raw = String(env.ZINIAO_BIND || "127.0.0.1").trim();
    return raw || "127.0.0.1";
}

export function getBindPort(env = process.env) {
    const port = Number(env.ZINIAO_PORT || DEFAULT_PORT);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/**
 * 根据监听地址列出插件里应填写的仓库根地址。
 * 绑定 0.0.0.0 时 127.0.0.1 只给本机浏览器，紫鸟通常要填局域网 IPv4。
 */
export function listAdvertisedOrigins(bindHost, port) {
    const hosts = new Set();
    if (bindHost === "0.0.0.0" || bindHost === "::") {
        hosts.add("127.0.0.1");
        for (const items of Object.values(os.networkInterfaces())) {
            for (const item of items || []) {
                const family = item.family === 4 || item.family === "IPv4";
                if (family && item.address && !item.internal) hosts.add(item.address);
            }
        }
    } else {
        hosts.add(bindHost);
    }
    return [...hosts].map((host) => `http://${host}:${port}`);
}

function tokensEqual(left, right) {
    const a = Buffer.from(String(left || ""), "utf8");
    const b = Buffer.from(String(right || ""), "utf8");
    if (!a.length || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

export async function loadIngestAuth(rootDir, env = process.env) {
    if (env.TEMU_CREDENTIALS) {
        const credentials=JSON.parse(await readFile(env.TEMU_CREDENTIALS,"utf8"));
        return {token:credentials.deviceToken,tokenSource:"private-file",bindHost:getBindHost(env),port:getBindPort(env),origins:["https://www.ruofei.com.cn"],endpoints:["https://www.ruofei.com.cn/temu/api/ingest"]};
    }
    const dataDir = path.join(rootDir, "data");
    const filePath = path.join(dataDir, "ingest.json");
    await mkdir(dataDir, { recursive: true });
    const envToken = String(env.ZINIAO_INGEST_TOKEN || "").trim();
    let stored = null;
    try {
        stored = JSON.parse(await readFile(filePath, "utf8"));
    } catch {
        stored = null;
    }
    if (!stored || typeof stored !== "object" || !String(stored.token || "").trim()) {
        stored = {
            token: randomBytes(24).toString("hex"),
            createdAt: new Date().toISOString()
        };
        await writeFile(filePath, JSON.stringify(stored, null, 2), "utf8");
    }
    const token = envToken || String(stored.token).trim();
    const bindHost = getBindHost(env);
    const port = getBindPort(env);
    const origins = listAdvertisedOrigins(bindHost, port);
    return {
        token,
        tokenSource: envToken ? "env" : "file",
        bindHost,
        port,
        origins,
        endpoints: origins.map((origin) => `${origin}/api/ingest`),
        filePath
    };
}

export function readBearerToken(req) {
    const header = String(req && req.headers && req.headers.authorization || "");
    const matched = header.match(/^Bearer\s+(\S+)/i);
    return matched ? matched[1].trim() : "";
}

export function isValidIngestToken(provided, expected) {
    return tokensEqual(provided, expected);
}

/**
 * 令牌和仓库管理免登只给真正的回环请求。
 * 绑定 0.0.0.0 或前面加反向代理时，socket 远端可能变成这台机器的局域网 IP，
 * 不能再把局域网地址当成“本机”，否则公网请求会绕过令牌。
 */
export function isLocalMachineRequest(req) {
    const ip = String(req && req.socket && req.socket.remoteAddress || "").replace("::ffff:", "");
    if (!ip) return false;
    if (ip === "127.0.0.1" || ip === "::1") return true;
    // 绑定 0.0.0.0 或反向代理后，socket 远端可能变成这台机器的局域网 IP。
    // 仓库管理免登只认真正的回环地址，避免公网请求被当成“本机”从而绕过令牌。
    return false;
}
