/**
 * 用户账户表：注册、登录校验、改密停用与会话签名。
 * 口令一律 scrypt 加盐存储，会话用独立 sessionSecret 签名——绝不复用某个用户的口令哈希，
 * 否则改一个人口令会波及全体会话，且一个用户的口令哈希会变成其他用户会话的签名密钥。
 * 本模块只用 Node 标准库，保持仓库零依赖。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import path from "node:path";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const USERNAME_PATTERN = /^[A-Za-z0-9_.\u4e00-\u9fa5-]{2,40}$/;
// 手机号：11 位、1 开头、第二位 3-9（中国大陆号段）。内部使用不做短信验证，只校验格式。
const PHONE_PATTERN = /^1[3-9]\d{9}$/;
const MIN_PASSWORD_LENGTH = 8;
// scrypt 参数与既有 credentials.json 保持一致，迁移时无需重算口令。
const SCRYPT_KEY_LENGTH = 64;

function text(value) {
    return String(value ?? "").trim();
}

/**
 * 账号标识：手机号或历史用户名。
 * 保留旧用户名是为了兼容存量管理员账号——它的用户名不是手机号，
 * 强制改号会让唯一管理员无法登录，因此两种形式都接受，登录时按原样匹配。
 * 新注册一律要求手机号。
 */
function isPhone(value) {
    return PHONE_PATTERN.test(text(value));
}

/**
 * 手机号脱敏：页面要显示"谁认领了这个店"，但不能把完整号码暴露给所有人。
 * 保留前 3 位与后 4 位，足够在十几个人的团队里认出是谁。
 */
export function maskPhone(value) {
    const raw = text(value);
    // 非手机号的账号（如 admin）没有可脱敏的部分，原样返回便于识别。
    if (!isPhone(raw)) return raw;
    return `${raw.slice(0, 3)}****${raw.slice(-4)}`;
}

/**
 * 比较十六进制摘要（口令哈希、会话 MAC）。
 * 必须显式用 hex 解码：Buffer.from(字符串) 默认按 utf8 处理，会把十六进制文本当成字符逐个比较，
 * 长度翻倍且内容不同，导致口令永远校验不通过。同时拒绝非十六进制输入，避免被静默截断成空值。
 */
function equalHex(left, right) {
    const a = String(left || "");
    const b = String(right || "");
    if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function hashPassword(password, salt) {
    return scryptSync(String(password), String(salt), SCRYPT_KEY_LENGTH).toString("hex");
}

export function createUsers(rootDir) {
    const usersPath = path.join(rootDir, "users.json");
    const credentialsPath = text(process.env.TEMU_CREDENTIALS);
    let queue = Promise.resolve();
    /**
     * 已确认落盘的状态缓存。
     * 读取路径（每个请求的会话校验都会走）绝不能顺带写盘：
     * 写入要删备份、改名主文件，并发读取会在改名窗口里读到"文件不存在"而抛错，
     * 表现为登录后页面间歇性 500、主内容区空白。
     * 只有真正改动了状态才写，因此记录指纹避免无谓重写。
     */
    let cachedState = null;
    // 冷启动时并发请求共用同一次读盘，避免各自初始化出不同的会话密钥。
    let loading = null;

    function withLock(task) {
        const run = queue.then(task);
        queue = run.catch(() => {});
        return run;
    }

    /**
     * 用户表必须原子落盘：写入中断时旧表仍可用，避免所有账号一起失效。
     * 写盘同时更新内存缓存，让后续读取不必再碰磁盘。
     */
    async function writeState(state) {
        const temp = `${usersPath}.tmp`;
        const backup = `${usersPath}.bak`;
        await mkdir(rootDir, { recursive: true });
        const text = JSON.stringify(state, null, 2);
        await writeFile(temp, text, "utf8");
        await rm(backup, { force: true });
        try { await rename(usersPath, backup); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
        try {
            await rename(temp, usersPath);
            await rm(backup, { force: true });
        } catch (error) {
            try { await rename(backup, usersPath); } catch {}
            throw error;
        }
        cachedState = state;
    }

    function normalizeUser(user) {
        return {
            id: text(user && user.id),
            username: text(user && user.username),
            salt: text(user && user.salt),
            passwordHash: text(user && user.passwordHash),
            role: text(user && user.role) === "admin" ? "admin" : "user",
            disabled: Boolean(user && user.disabled),
            createdAt: text(user && user.createdAt),
            passwordChangedAt: text(user && user.passwordChangedAt)
        };
    }

    /**
     * 注册校验：新账号必须是手机号。
     * 存量账号（如 admin）走的是登录路径，不经这里，因此不受影响。
     */
    function validateRegistration(username, password) {
        const name = text(username);
        if (!name) throw Object.assign(new Error("请输入手机号"), { status: 400 });
        if (!isPhone(name)) throw Object.assign(new Error("请填写 11 位手机号（1 开头的中国大陆号码）"), { status: 400 });
        if (String(password || "").length < MIN_PASSWORD_LENGTH) throw Object.assign(new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`), { status: 400 });
        return { name, password: String(password) };
    }

    /** 登录校验的账号格式：手机号与历史用户名都接受，具体匹配交给查找逻辑。 */
    function validateLoginName(username) {
        const name = text(username);
        if (!name) throw Object.assign(new Error("请输入手机号"), { status: 400 });
        if (name.length > 40 || (!isPhone(name) && !USERNAME_PATTERN.test(name))) {
            throw Object.assign(new Error("账号格式不正确，请填写 11 位手机号"), { status: 400 });
        }
        return name;
    }

    /** 对外结构一律带脱敏手机号：页面显示归属账号时用 maskedUsername，绝不返回完整号码。 */
    function publicUser(user) {
        return {
            id: user.id,
            username: user.username,
            maskedUsername: maskPhone(user.username),
            isPhone: isPhone(user.username),
            role: user.role,
            disabled: user.disabled,
            createdAt: user.createdAt
        };
    }

    async function register({ username, password } = {}) {
        const { name, password: secret } = validateRegistration(username, password);
        return withLock(async () => {
            const state = await readState();
            if (!state.registrationOpen) throw Object.assign(new Error("管理员已关闭注册，请联系管理员开通账号"), { status: 403 });
            if (state.users.some((user) => user.username.toLowerCase() === name.toLowerCase())) {
                throw Object.assign(new Error("该手机号已被注册"), { status: 409 });
            }
            const salt = randomBytes(16).toString("hex");
            const user = {
                id: `u_${randomBytes(6).toString("hex")}`,
                username: name,
                salt,
                passwordHash: hashPassword(secret, salt),
                // 自助注册一律普通用户；管理员只能由既有管理员在用户管理里指派。
                role: "user",
                disabled: false,
                createdAt: new Date().toISOString(),
                passwordChangedAt: ""
            };
            state.users.push(user);
            await writeState(state);
            return publicUser(user);
        });
    }

    /** 登录校验：账号不存在与口令错误返回同一结果，避免被用来枚举账号。 */
    async function verify({ username, password } = {}) {
        const state = await readState();
        const name = validateLoginName(username).toLowerCase();
        const user = state.users.find((item) => item.username.toLowerCase() === name);
        const salt = user ? user.salt : randomBytes(16).toString("hex");
        const expected = user ? user.passwordHash : hashPassword(randomBytes(16).toString("hex"), salt);
        const matched = equalHex(hashPassword(String(password || ""), salt), expected);
        if (!user || !matched) throw Object.assign(new Error("手机号或密码错误"), { status: 401 });
        if (user.disabled) throw Object.assign(new Error("该账号已被停用，请联系管理员"), { status: 403 });
        return publicUser(user);
    }

    /**
     * 首次启动时把旧的单账号凭证迁成管理员账号，并就地补出会话密钥。
     * 迁移只做一次；此后 credentials.json 只保留 deviceToken 等机器级内容。
     * 返回是否真的改动过状态——只有改动才需要落盘，否则读取路径不应产生任何写操作。
     */
    async function migrateFromCredentials(state) {
        if (!credentialsPath) return false;
        let legacy = null;
        try {
            legacy = JSON.parse(await readFile(credentialsPath, "utf8"));
        } catch {
            return false;
        }
        if (!legacy || typeof legacy !== "object") return false;
        let changed = false;
        const username = text(legacy.username);
        if (!state.sessionSecret) {
            state.sessionSecret = randomBytes(32).toString("hex");
            changed = true;
        }
        // 已有同名用户说明迁移过，不能重复写入或覆盖口令。
        if (!username || state.users.some((user) => user.username === username)) return changed;
        if (!text(legacy.salt) || !text(legacy.passwordHash)) return changed;
        state.users.unshift({
            id: `u_${randomBytes(6).toString("hex")}`,
            username,
            salt: text(legacy.salt),
            passwordHash: text(legacy.passwordHash),
            role: "admin",
            disabled: false,
            createdAt: new Date().toISOString(),
            passwordChangedAt: ""
        });
        return true;
    }

    /**
     * 读取用户表。命中内存缓存直接返回，避免每个请求都读盘。
     *
     * 关键：这里绝不写盘。此前每次读取都无条件 writeState()，而 writeState 要
     * 删备份、再把 users.json 改名为 .bak——并发请求正好落在改名窗口时读不到主文件，
     * 兜底又去读同样被移走的文件，最终抛出异常；对外表现就是登录后静态资源间歇性 500、
     * 页面主内容区一片空白。
     * 只有首次初始化与旧凭证迁移才落盘，其余情况纯读。
     */
    async function loadState() {
        if (cachedState) return cachedState;
        await mkdir(rootDir, { recursive: true });
        let state = null;
        try {
            state = JSON.parse(await readFile(usersPath, "utf8"));
        } catch {
            for (const candidate of [`${usersPath}.tmp`, `${usersPath}.bak`]) {
                try {
                    const parsed = JSON.parse(await readFile(candidate, "utf8"));
                    await writeFile(usersPath, JSON.stringify(parsed, null, 2), "utf8");
                    state = parsed;
                    break;
                } catch {}
            }
        }
        const initialized = !state || typeof state !== "object";
        if (initialized) {
            state = { version: 1, sessionSecret: randomBytes(32).toString("hex"), registrationOpen: true, users: [] };
        }
        state.users = (Array.isArray(state.users) ? state.users : []).map(normalizeUser).filter((user) => user.id && user.username);
        if (typeof state.registrationOpen !== "boolean") state.registrationOpen = true;
        const migrated = await migrateFromCredentials(state);
        // 首次初始化与账号迁移必须落盘，否则重启会重新生成会话密钥、导致全体被登出。
        if (initialized || migrated) {
            await writeState(state);
        } else {
            cachedState = state;
        }
        return state;
    }

    /** 并发冷启动只允许一次真正读盘，避免多个请求同时初始化出不同的会话密钥。 */
    function readState() {
        if (cachedState) return Promise.resolve(cachedState);
        if (!loading) {
            // 不能借用 withLock：register 等写操作本身已在锁内，锁内再取锁会互相等待。
            loading = loadState().finally(() => { loading = null; });
        }
        return loading;
    }

    async function listUsers() {
        const state = await readState();
        return state.users.map(publicUser);
    }

    async function getState() {
        return readState();
    }

    async function findById(id) {
        const state = await readState();
        const user = state.users.find((item) => item.id === text(id));
        return user ? publicUser(user) : null;
    }

    async function changePassword(id, newPassword) {
        const secret = String(newPassword || "");
        if (secret.length < MIN_PASSWORD_LENGTH) throw Object.assign(new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            const user = state.users.find((item) => item.id === text(id));
            if (!user) throw Object.assign(new Error("用户不存在"), { status: 404 });
            user.salt = randomBytes(16).toString("hex");
            user.passwordHash = hashPassword(secret, user.salt);
            user.passwordChangedAt = new Date().toISOString();
            await writeState(state);
            return publicUser(user);
        });
    }

    async function setDisabled(id, disabled) {
        return withLock(async () => {
            const state = await readState();
            const user = state.users.find((item) => item.id === text(id));
            if (!user) throw Object.assign(new Error("用户不存在"), { status: 404 });
            if (user.role === "admin" && disabled) {
                // 必须留一个可用管理员，否则无人能再管理账号与店铺归属。
                const activeAdmins = state.users.filter((item) => item.role === "admin" && !item.disabled && item.id !== user.id);
                if (!activeAdmins.length) throw Object.assign(new Error("至少保留一个可用的管理员账号"), { status: 409 });
            }
            user.disabled = Boolean(disabled);
            await writeState(state);
            return publicUser(user);
        });
    }

    async function setRole(id, role) {
        const next = text(role) === "admin" ? "admin" : "user";
        return withLock(async () => {
            const state = await readState();
            const user = state.users.find((item) => item.id === text(id));
            if (!user) throw Object.assign(new Error("用户不存在"), { status: 404 });
            if (user.role === "admin" && next !== "admin") {
                const activeAdmins = state.users.filter((item) => item.role === "admin" && !item.disabled && item.id !== user.id);
                if (!activeAdmins.length) throw Object.assign(new Error("至少保留一个可用的管理员账号"), { status: 409 });
            }
            user.role = next;
            await writeState(state);
            return publicUser(user);
        });
    }

    async function removeUser(id) {
        return withLock(async () => {
            const state = await readState();
            const user = state.users.find((item) => item.id === text(id));
            if (!user) throw Object.assign(new Error("用户不存在"), { status: 404 });
            if (user.role === "admin") {
                const activeAdmins = state.users.filter((item) => item.role === "admin" && !item.disabled && item.id !== user.id);
                if (!activeAdmins.length) throw Object.assign(new Error("至少保留一个可用的管理员账号"), { status: 409 });
            }
            state.users = state.users.filter((item) => item.id !== user.id);
            await writeState(state);
            return { removed: true, id: user.id, username: user.username };
        });
    }

    async function setRegistrationOpen(open) {
        return withLock(async () => {
            const state = await readState();
            state.registrationOpen = Boolean(open);
            await writeState(state);
            return { registrationOpen: state.registrationOpen };
        });
    }

    async function registrationStatus() {
        const state = await readState();
        return { registrationOpen: state.registrationOpen, userCount: state.users.length };
    }

    /**
     * 会话值携带用户标识：uid.expiry.mac。签名密钥是独立的 sessionSecret，
     * 这样改某人口令不会让其他人掉线，也不会把口令哈希变成会话签名密钥。
     */
    async function signSession(userId) {
        const state = await readState();
        const expiry = String(Date.now() + SESSION_TTL_MS);
        const mac = createHmac("sha256", state.sessionSecret).update(`${text(userId)}.${expiry}`).digest("hex");
        return { value: `${text(userId)}.${expiry}.${mac}`, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
    }

    async function verifySession(cookieValue) {
        const parts = String(cookieValue || "").split(".");
        if (parts.length !== 3) return null;
        const [userId, expiry, mac] = parts;
        if (!/^\d+$/.test(expiry) || Number(expiry) <= Date.now()) return null;
        const state = await readState();
        const expected = createHmac("sha256", state.sessionSecret).update(`${userId}.${expiry}`).digest("hex");
        if (!equalHex(mac, expected)) return null;
        const user = state.users.find((item) => item.id === userId);
        if (!user || user.disabled) return null;
        return publicUser(user);
    }

    return {
        listUsers, getState, findById, register, verify, changePassword, setDisabled, setRole, removeUser,
        setRegistrationOpen, registrationStatus, signSession, verifySession, publicUser, maskPhone
    };
}
