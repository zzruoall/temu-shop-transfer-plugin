/**
 * 云端认证：用户会话 + 插件令牌，两者权限边界严格分离。
 *
 * 关键安全约束：插件令牌只允许访问插件侧接口（上传采集包、登记店铺、领取任务、回传结果），
 * 绝不能读改用户数据。此前插件令牌与管理员等价，任何能伪造 Origin 头的客户端都能拿到全量权限。
 *
 * 用户口令一律 scrypt 加盐，会话用独立 sessionSecret 签名，不与任何用户口令哈希共用密钥。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomBytes, createHmac } from 'node:crypto';
import path from 'node:path';
import { loginPage, registerPage, adminLoginPage } from './login.mjs';
import { createUsers } from './lib/users.mjs';
import { normalizeBasePathValue, resolveRequestBasePath, stripRequestBasePath } from './lib/ingest-auth.mjs';

/**
 * 插件令牌的可访问路径白名单。只有这些接口允许用插件令牌访问；
 * 用户数据接口（商品库、任务列表、日志、导入、删除等）一律要求用户会话或设备令牌。
 */
const PLUGIN_SCOPED_PATHS = /^\/api\/(?:ingest(?:\/prepare|\/requests\/[a-zA-Z0-9-]{16,80}(?:\/cancel)?)?|ingest-info|plugin\/register|agents\/register|jobs\/(?:claim|report|target-task-states|direct-progress))$/;

export function createCloudAuth({ dataRoot, credentialPath }) {
    const users = createUsers(dataRoot);
    const failurePath = String(process.env.TEMU_CREDENTIALS || credentialPath || '').trim();
    const failures = new Map();
    // 插件令牌：随机值 + 服务端撤销状态，绝不把管理员口令或用户令牌放进扩展包。
    const pluginTokens = new Map();
    // 令牌状态必须放在共享数据目录，不能放在发布目录里：
    // 发布目录每次部署都会换新（releases/v10 → v11），放里面等于每次部署都清空所有插件令牌。
    const pluginStateFile = process.env.TEMU_PLUGIN_TOKENS || path.join(dataRoot, 'plugin-tokens.json');
    let config = null;
    let deviceToken = '';
    let pluginTokensLoaded = null;

    /**
     * 令牌是长期凭证（7 天），必须跨重启保持有效。
     * 只写不读会让每次部署/重启都作废所有插件的令牌，迫使每台机器重新注册，
     * 期间插件请求全部 401，表现为"插件突然掉线"。
     * 用 promise 缓存避免并发请求重复读盘；读取失败按空表处理，不阻断启动。
     */
    function ensurePluginTokensLoaded() {
        if (!pluginTokensLoaded) {
            pluginTokensLoaded = (async () => {
                try {
                    const parsed = JSON.parse(await readFile(pluginStateFile, 'utf8'));
                    for (const [token, item] of Object.entries(parsed || {})) {
                        if (!token.startsWith('pt_') || !item || typeof item !== 'object') continue;
                        const issuedAt = Number(item.issuedAt) || 0;
                        // 过期的令牌不再恢复，避免陈旧凭证长期留存。
                        if (!issuedAt || Date.now() - issuedAt >= 7 * 86400000) continue;
                        pluginTokens.set(token, {
                            instanceId: String(item.instanceId || ''),
                            disabled: Boolean(item.disabled),
                            issuedAt
                        });
                    }
                } catch {
                    // 文件不存在或损坏时按无令牌启动，插件会自行重新注册。
                }
            })();
        }
        return pluginTokensLoaded;
    }

    async function loadConfig() {
        await ensurePluginTokensLoaded();
        if (!failurePath) return;
        try {
            const parsed = JSON.parse(await readFile(failurePath, 'utf8'));
            config = parsed && typeof parsed === 'object' ? parsed : null;
            deviceToken = String(config && config.deviceToken || '');
        } catch {
            config = null;
        }
    }

    function pluginScopeAllowed(pathname) {
        return PLUGIN_SCOPED_PATHS.test(String(pathname || '').split('?')[0]);
    }

    async function savePluginTokens() {
        await mkdir(new URL('.', `file://${pluginStateFile}`).pathname, { recursive: true }).catch(() => {});
        await writeFile(pluginStateFile, JSON.stringify(Object.fromEntries(pluginTokens)), 'utf8').catch(() => {});
    }

    function issuePluginToken(instanceId) {
        const id = String(instanceId || '').trim();
        if (!/^[a-zA-Z0-9-]{8,100}$/.test(id)) return null;
        for (const [token, item] of pluginTokens) {
            if (item.instanceId === id && !item.disabled && Date.now() - item.issuedAt < 7 * 86400000) return token;
        }
        const token = `pt_${randomBytes(32).toString('hex')}`;
        pluginTokens.set(token, { instanceId: id, disabled: false, issuedAt: Date.now() });
        savePluginTokens();
        return token;
    }

    function disablePluginInstance(instanceId) {
        let count = 0;
        for (const item of pluginTokens.values()) {
            if (item.instanceId === String(instanceId)) { item.disabled = true; count += 1; }
        }
        savePluginTokens();
        return count;
    }

    function validPluginToken(token) {
        const item = pluginTokens.get(String(token || ''));
        return Boolean(item && !item.disabled && Date.now() - item.issuedAt < 7 * 86400000);
    }

    function readCookie(req, name) {
        return String(req.headers.cookie || '').split(';').map((value) => value.trim())
            .find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1) || '';
    }

    /**
     * cookie 的 Path 必须与实际挂载前缀一致：
     * 写死 /temu/ 会让本机直连（根路径）拿不到会话，写死 / 又会让 cookie 泄给同域其他站点。
     */
    function cookiePath(basePrefix) {
        const prefix = normalizeBasePathValue(basePrefix);
        return prefix ? `${prefix}/` : '/';
    }

    function sessionCookie(value, maxAgeSeconds, basePrefix) {
        return `temu_session=${value}; Path=${cookiePath(basePrefix)}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
    }

    function clearSessionCookie(basePrefix) {
        return `temu_session=; Path=${cookiePath(basePrefix)}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
    }

    function clientIp(req) {
        return String(req.headers['x-real-ip'] || req.socket.remoteAddress || '');
    }

    function isThrottled(ip) {
        const state = failures.get(ip);
        return Boolean(state && state.until > Date.now());
    }

    function noteFailure(ip) {
        const state = failures.get(ip) || { count: 0, until: 0 };
        if (failures.size > 1000) failures.clear();
        failures.set(ip, { count: state.count + 1, until: state.count >= 9 ? Date.now() + 60000 : 0 });
    }

    async function readJsonBody(req, limit) {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > limit) return null;
        }
        try { return JSON.parse(body); } catch { return null; }
    }

    async function readFormBody(req, limit) {
        let body = '';
        for await (const chunk of req) {
            body += chunk;
            if (Buffer.byteLength(body) > limit) return null;
        }
        try { return new URLSearchParams(body); } catch { return null; }
    }

    /**
     * 登录后要回到的页面。
     *
     * 用白名单而不是直接信任参数：开放重定向会把我们的登录页变成钓鱼跳板
     * （攻击者构造 /login?next=https://evil.example 就能借我们的域名把人带走）。
     * 只认站内路径，且必须以 / 开头、不含协议与双斜杠。
     */
    function safeNext(value, basePrefix) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        // 只接受站内绝对路径；//evil.com 与 http(s):// 一律拒绝。
        if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '';
        /**
         * 剥离挂载前缀时要带上分隔符比较。
         * 只写 startsWith(basePrefix) 会把 /temuadmin 也当成 /temu 下的页面，
         * 而它其实是另一个站点（同域但不同路径），不该被我们当作返回目标。
         */
        let path = raw;
        if (basePrefix && (raw === basePrefix || raw.startsWith(`${basePrefix}/`))) {
            path = raw.slice(basePrefix.length) || '/';
        }
        if (path === '/login' || path === '/register' || path === '/session') return '';
        return `${basePrefix}${path}`;
    }

    async function handleLogin(req, res, basePrefix) {
        const ip = clientIp(req);
        if (isThrottled(ip)) {
            res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' });
            res.end(loginPage('尝试次数过多，请一分钟后再试。', basePrefix));
            return false;
        }
        const fields = await readFormBody(req, 4096);
        if (!fields) {
            res.writeHead(413); res.end(); return false;
        }
        try {
            const user = await users.verify({ username: fields.get('username'), password: fields.get('password') });
            failures.delete(ip);
            const session = await users.signSession(user.id);
            /**
             * 回到用户原本要去的页面。
             * 之前一律跳回首页，导致"从 /admin 被送到登录页 → 登录成功 → 回到业务工作台"，
             * 管理员以为管理界面没生效。next 由登录页表单带上，并经过白名单校验。
             */
            const destination = safeNext(fields.get('next'), basePrefix) || `${basePrefix}/`;
            res.writeHead(303, { location: destination, 'set-cookie': sessionCookie(session.value, session.maxAgeSeconds, basePrefix), 'cache-control': 'no-store' });
            res.end();
            return false;
        } catch (error) {
            noteFailure(ip);
            res.writeHead(error && error.status === 403 ? 403 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(loginPage(String(error && error.message || '账号或密码错误，请重新输入。'), basePrefix, fields.get('next')));
            return false;
        }
    }

    /**
     * 管理员登录：与普通登录分成两条路径。
     *
     * 关键在于"非管理员一律拒绝"：普通用户即使打开管理登录页、输入自己的正确口令，
     * 也不能拿到管理站的会话——否则"分开设计"就只是外观上的分开。
     * 文案与普通登录一致地含糊（"账号或密码错误"），避免被用来枚举哪个账号是管理员。
     */
    async function handleAdminLogin(req, res, basePrefix) {
        const ip = clientIp(req);
        if (isThrottled(ip)) {
            res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' });
            res.end(adminLoginPage('尝试次数过多，请一分钟后再试。', basePrefix));
            return false;
        }
        const fields = await readFormBody(req, 4096);
        if (!fields) { res.writeHead(413); res.end(); return false; }
        try {
            const user = await users.verify({ username: fields.get('username'), password: fields.get('password') });
            if (user.role !== 'admin') {
                // 口令是对的、但不是管理员：给出明确原因（这与"账号不存在"不同，
                // 用户能自己意识到走错了入口），但不透露该账号是否存在其他权限。
                noteFailure(ip);
                res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(adminLoginPage('该账号不是管理员，无法登录管理控制台。请使用普通用户登录。', basePrefix));
                return false;
            }
            failures.delete(ip);
            const session = await users.signSession(user.id);
            res.writeHead(303, { location: `${basePrefix}/admin`, 'set-cookie': sessionCookie(session.value, session.maxAgeSeconds, basePrefix), 'cache-control': 'no-store' });
            res.end();
            return false;
        } catch (error) {
            noteFailure(ip);
            res.writeHead(error && error.status === 403 ? 403 : 401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(adminLoginPage(String(error && error.message || '账号或密码错误，请重新输入。'), basePrefix));
            return false;
        }
    }

    /**
     * 管理站退出：回到管理登录页，而不是业务登录页。
     * 两个站点各有各的入口，退出后应该留在自己这边。
     */
    function handleAdminLogout(res, basePrefix) {
        res.writeHead(303, { location: `${basePrefix}/admin`, 'set-cookie': clearSessionCookie(basePrefix), 'cache-control': 'no-store' });
        res.end();
        return false;
    }

    async function handleRegister(req, res, basePrefix) {
        const ip = clientIp(req);
        if (isThrottled(ip)) {
            res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' });
            res.end(registerPage('尝试次数过多，请一分钟后再试。', true, basePrefix));
            return false;
        }
        const fields = await readFormBody(req, 4096);
        if (!fields) { res.writeHead(413); res.end(); return false; }
        const password = fields.get('password') || '';
        if (password !== (fields.get('confirm') || '')) {
            res.writeHead(400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(registerPage('两次输入的密码不一致。', true, basePrefix));
            return false;
        }
        try {
            const user = await users.register({ username: fields.get('username'), password });
            // 注册成功直接登录，避免用户再输一遍。
            const session = await users.signSession(user.id);
            res.writeHead(303, { location: `${basePrefix}/`, 'set-cookie': sessionCookie(session.value, session.maxAgeSeconds, basePrefix), 'cache-control': 'no-store' });
            res.end();
            return false;
        } catch (error) {
            noteFailure(ip);
            res.writeHead(error && error.status || 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(registerPage(String(error && error.message || '注册失败，请重试。'), true, basePrefix));
            return false;
        }
    }

    function handleLogout(res, basePrefix) {
        res.writeHead(303, { location: `${basePrefix}/login`, 'set-cookie': clearSessionCookie(basePrefix), 'cache-control': 'no-store' });
        res.end();
        return false;
    }

    /**
     * 认证入口。通过时把身份写到 req 上：
     *   req.temuUser      当前登录用户（网页会话）
     *   req.temuIsAdmin   是否管理员
     *   req.temuPluginToken 是否为插件令牌（受限身份）
     */
    async function authenticate(req, res) {
        await loadConfig();
        const url = new URL(req.url, `http://${String(req.headers.host || 'localhost')}`);
        // 前缀解析与路由剥离共用同一实现，避免云认证与静态服务对前缀的判断不一致。
        const basePrefix = resolveRequestBasePath(req, url.pathname);
        const pathname = stripRequestBasePath(req, url.pathname);
        const origin = req.headers.origin;
        const authorization = String(req.headers.authorization || '');
        const extensionOrigin = origin === 'chrome-extension://efojbbfhfniieifmppafmigfmndbledc';
        const deviceBearer = Boolean(deviceToken) && authorization === `Bearer ${deviceToken}`;
        const pluginBearer = authorization.startsWith('Bearer pt_') && validPluginToken(authorization.slice(7));
        // 插件注册不带令牌（首次连接尚无令牌）；注册后所有请求必须带插件令牌或用户身份。
        const pluginRegistration = req.method === 'POST' && pathname === '/api/plugin/register'
            && ['https://agentseller.temu.com', 'https://www.temu.com', 'chrome-extension://efojbbfhfniieifmppafmigfmndbledc', 'https://*.kuajingmaihuo.com']
                .some((value) => value === 'https://*.kuajingmaihuo.com' ? String(origin || '').endsWith('.kuajingmaihuo.com') : origin === value);
        req.headers['x-temu-path'] = pathname;
        /**
         * 同源判定：正式站点、本机回环地址都算可信来源。
         * 只允许生产域名会让本地/局域网部署无法登录（浏览器提交表单必然带 Origin），
         * 而回环地址上的页面只可能是本机自己打开的，放行不引入跨站风险。
         */
        const isTrustedPageOrigin = (value) => {
            const text = String(value || '').trim();
            if (!text) return true;
            if (text === 'https://www.ruofei.com.cn') return true;
            try {
                const parsed = new URL(text);
                return parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname);
            } catch {
                return false;
            }
        };
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !isTrustedPageOrigin(origin)
            && !pluginRegistration && !deviceBearer && !(extensionOrigin && pluginBearer)) {
            res.writeHead(403); res.end('origin_denied'); return false;
        }

        // 1. 设备令牌：机器级内部调用，保留全量权限（迁移期兼容）。
        if (deviceBearer) {
            req.temuDeviceBearer = true;
            return true;
        }

        // 2. 插件令牌：权限被限制在插件侧接口内，不能读写用户数据。
        if (pluginBearer) {
            if (!pluginScopeAllowed(pathname) && !pluginRegistration) {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ error: 'plugin_scope_denied' }));
                return false;
            }
            req.temuPluginToken = true;
            // 实例身份只能来自已验证令牌，不能信任插件请求体自行声明的实例编号。
            req.temuPluginInstanceId = pluginTokens.get(authorization.slice(7)).instanceId;
            return true;
        }

        // 3. 登录页与注册页：无论是否已登录都要自己渲染。
        // 已登录时如果把 /login 交给静态服务，会因它不是磁盘文件而返回 not_found；
        // 已登录访问 /login 视为"已登录，回首页"，避免出现空白错误页。
        const isLoginPage = req.method === 'GET' && (pathname === '/' || pathname === '/login');
        const isRegisterPage = req.method === 'GET' && pathname === '/register';
        /**
         * 退出登录必须在会话分支之前处理：它本来就是"已登录"才做的动作，
         * 若放在下面，已登录请求会在会话分支里直接 return true 交给静态服务，
         * 而 /logout 不是磁盘文件，于是退出永远是 404，会话也就永远清不掉。
         */
        if (req.method === 'POST' && pathname === '/logout') {
            return handleLogout(res, basePrefix);
        }
        const sessionUser = await users.verifySession(readCookie(req, 'temu_session'));
        if (sessionUser) {
            req.temuUser = sessionUser;
            req.temuIsAdmin = sessionUser.role === 'admin';
            // 已登录再访问登录/注册页没有意义，回首页；但首页本身要交给静态服务渲染 SPA，
            // 否则会形成"首页重定向到首页"的死循环。
            if (pathname === '/login' || pathname === '/register') {
                res.writeHead(303, { location: `${basePrefix}/`, 'cache-control': 'no-store' });
                res.end();
                return false;
            }
            /**
             * 管理站是独立页面（/admin），权限在这里按路径拦下。
             * 不能只靠前端隐藏入口：那样任何人手输地址就能进管理页。
             * 非管理员明确返回 403 并给出返回入口，而不是悄悄跳走——静默跳转会让人以为页面坏了。
             */
            if (pathname === '/admin' && !req.temuIsAdmin) {
                res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>无权访问</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#eef2f6;color:#10243a;font:15px system-ui,sans-serif"><main style="text-align:center"><h1 style="font-size:18px">无权访问管理控制台</h1><p style="color:#5b7288">当前账号不是管理员。</p><p><a href="${basePrefix}/" style="color:#2f7cd0">返回工作台</a></p></main></body></html>`);
                return false;
            }
            return true;
        }

        // 未登录时提供登录/注册页与表单提交。
        if (req.method === 'POST' && pathname === '/session') {
            if (!isTrustedPageOrigin(origin)) {
                res.writeHead(403); res.end('origin_denied'); return false;
            }
            return handleLogin(req, res, basePrefix);
        }
        /**
         * 管理站的登录与退出走独立端点。
         * 与普通登录分开：管理登录页提交到这里，服务端额外校验管理员角色，
         * 普通用户即使拿到登录页也拿不到管理会话。
         */
        if (req.method === 'POST' && pathname === '/admin/session') {
            if (!isTrustedPageOrigin(origin)) {
                res.writeHead(403); res.end('origin_denied'); return false;
            }
            return handleAdminLogin(req, res, basePrefix);
        }
        if (req.method === 'POST' && pathname === '/admin/logout') {
            return handleAdminLogout(res, basePrefix);
        }
        if (req.method === 'POST' && pathname === '/register') {
            if (!isTrustedPageOrigin(origin)) {
                res.writeHead(403); res.end('origin_denied'); return false;
            }
            return handleRegister(req, res, basePrefix);
        }
        if (isLoginPage) {
            // 登录页把"原本要去的页面"通过 next 参数带下去，登录成功后回到那里。
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(loginPage('', basePrefix, safeNext(url.searchParams.get('next'), basePrefix)));
            return false;
        }
        /**
         * 未登录访问 /admin：直接给管理登录页，而不是把他送去业务登录页。
         * 两个入口各管各的：管理员在管理站登录，普通用户在业务站登录，
         * 不会出现"管理员被送到业务登录页、登录完却落在业务工作台"的错位。
         */
        if (req.method === 'GET' && pathname === '/admin') {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(adminLoginPage('', basePrefix));
            return false;
        }
        if (isRegisterPage) {
            const status = await users.registrationStatus();
            res.writeHead(status.registrationOpen ? 200 : 403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
            res.end(status.registrationOpen ? registerPage('', true, basePrefix) : registerPage('管理员已关闭注册，请联系管理员开通账号。', false, basePrefix));
            return false;
        }
        /**
         * 静态资源放行给未登录访问：登录页自己要加载 styles.css 与 favicon.svg，
         * 若这里一并拦截，登录页会变成无样式白板且无法提交。
         * 只放行静态文件，/api/* 始终需要身份；页面本体（/、/login、/register）仍走上面的独立分支。
         */
        const isStaticAsset = req.method === 'GET' && !pathname.startsWith('/api/')
            && /\.(?:css|js|svg|png|jpg|jpeg|gif|ico|webp|woff2?|ttf|otf|map|json)$/i.test(pathname);
        if (isStaticAsset) return true;
        if (pluginRegistration || (req.method === 'POST' && pathname === '/api/plugin/register' && origin === 'https://www.ruofei.com.cn')) {
            return true;
        }
        /**
         * 未登录访问页面时跳转到登录页，而不是回一串 JSON。
         * 浏览器地址栏里打开 /admin（或会话过期后刷新）如果收到 {"error":"请先登录中转仓"}，
         * 用户看到的就是一片白底黑字，只会认为"网站打不开"。
         * /api/* 保持 JSON 401，接口调用方需要的是状态码而不是 HTML。
         */
        const wantsHtml = req.method === 'GET' && !pathname.startsWith('/api/')
            && String(req.headers.accept || '').includes('text/html');
        if (wantsHtml) {
            /**
             * 带上 next，让登录成功后回到用户原本要去的页面。
             * 没有它，管理员从 /admin 被送来登录，登录完却落在业务工作台，
             * 会以为管理界面不存在。
             */
            const target = pathname === '/' ? '' : `?next=${encodeURIComponent(`${basePrefix}${pathname}`)}`;
            res.writeHead(303, { location: `${basePrefix}/login${target}`, 'cache-control': 'no-store' });
            res.end();
            return false;
        }
        res.writeHead(401, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: '请先登录中转仓' }));
        return false;
    }

    return { authenticate, issuePluginToken, disablePluginInstance, users, pluginScopeAllowed, getDeviceToken: () => deviceToken };
}
