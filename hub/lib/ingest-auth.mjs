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

/**
 * 规整挂载前缀声明值。
 * 必须严格校验：Windows/Git Bash 会把 /temu 这类值自动转换成 D:/xxx/temu，
 * 若直接拼进 cookie Path 与跳转地址，会话会写到错误路径导致登录无效。
 * 只接受形如 /temu 或 temu 的纯路径段，其余一律视为未声明。
 */
export function normalizeDeclaredBasePath(env = process.env) {
    return normalizeBasePathValue(env.TEMU_BASE_PATH);
}

/** 把单个原始前缀值规整成 /xxx；不合法（含盘符、反斜杠、非法字符）返回空串表示"未声明"。 */
export function normalizeBasePathValue(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    // 含盘符（D:/xxx）或反斜杠说明被路径转换污染，不能当作 Web 前缀使用。
    if (/^[A-Za-z]:/.test(raw) || raw.includes("\\")) return "";
    const stripped = raw.replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(stripped)) return "";
    return `/${stripped}`;
}

/**
 * 解析本服务对外的挂载前缀，供路由与静态资源统一使用。
 *
 * 两种部署形态看到的路径不同，必须显式区分：
 *   - 本机直连：请求路径自带前缀，可直接识别；
 *   - 线上反代：nginx 用末尾带斜杠的 proxy_pass 剥掉了前缀，服务端只看到 /xxx，
 *     无法从请求推断真实前缀，因此由反代声明（X-Forwarded-Prefix）或 TEMU_BASE_PATH 提供。
 * 不写死某一路径，避免本服务改挂到其他路径或根路径时失效。
 */
export function resolveBasePath(rawPathname, env = process.env) {
    const raw = String(rawPathname || "");
    const declared = normalizeDeclaredBasePath(env);
    const candidates = [declared, "/temu"].filter((value) => value && value !== "/");
    // 请求自带前缀时以请求为准（本机直连）；否则用显式声明（线上反代已把前缀剥离）。
    for (const prefix of candidates) {
        if (raw === prefix || raw.startsWith(`${prefix}/`)) return prefix;
    }
    // 只有在确实声明过合法前缀时才回退；未声明表示服务挂在根路径。
    return declared;
}

/** 读取反代声明的挂载前缀（nginx: proxy_set_header X-Forwarded-Prefix /temu）。 */
export function forwardedBasePath(headers) {
    const raw = headers && headers['x-forwarded-prefix'];
    return normalizeBasePathValue(Array.isArray(raw) ? raw[0] : raw);
}

/**
 * 解析本次请求的对外挂载前缀，优先级从可靠到兜底：
 *   1. 反代声明的 X-Forwarded-Prefix —— 反代用末尾带斜杠的 proxy_pass 剥掉了前缀，
 *      服务端从路径上已看不出真实前缀，这是唯一可靠的来源；
 *   2. 请求路径自带的前缀 —— 本机直连时地址栏里就带着它；
 *   3. TEMU_BASE_PATH —— 反代未声明时的兜底，值同样经过格式校验。
 * 三者都没有表示服务挂在根路径，页面用根相对路径即可。
 */
export function resolveRequestBasePath(req, rawPathname, env = process.env) {
    return forwardedBasePath(req && req.headers) || resolveBasePath(rawPathname, env);
}

/**
 * 从请求路径剥离挂载前缀；剥离后至少是 "/"。
 * 只有"请求路径确实以前缀开头"时才截断——反代场景下路径本身已无前缀，
 * 若此时仍按前缀长度截断，会把 /login 削成 n，导致所有路由都匹配不上。
 */
export function stripBasePath(rawPathname, env = process.env) {
    const raw = String(rawPathname || "");
    const declared = normalizeDeclaredBasePath(env);
    for (const prefix of [declared, "/temu"].filter((value) => value && value !== "/")) {
        if (raw === prefix) return "/";
        if (raw.startsWith(`${prefix}/`)) return raw.slice(prefix.length) || "/";
    }
    return raw || "/";
}

/** 与 resolveRequestBasePath 配套：反代声明了前缀时，即使路径未剥离也能正确截断。 */
export function stripRequestBasePath(req, rawPathname, env = process.env) {
    const forwarded = forwardedBasePath(req && req.headers);
    const raw = String(rawPathname || "");
    if (forwarded && (raw === forwarded || raw.startsWith(`${forwarded}/`))) {
        return raw === forwarded ? "/" : raw.slice(forwarded.length) || "/";
    }
    return stripBasePath(raw, env);
}

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
