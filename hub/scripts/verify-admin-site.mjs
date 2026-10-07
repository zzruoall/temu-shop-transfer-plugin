/**
 * 管理站（独立页面 /admin）回归。
 *
 * 锁住四条边界：
 *   1. 普通会话误入 /admin 应转到管理员登录，管理 API 仍拒绝普通身份；
 *   2. 未登录访问 /admin 也拿不到内容；
 *   3. 管理站是独立页面，不加载业务工作台那一整套逻辑；
 *   4. 业务 SPA 里不再持有管理界面代码（否则两处维护、权限判断容易分叉）。
 * 全程使用临时目录与假服务，不连真实环境。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUsers } from "../lib/users.mjs";

const hubDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(hubDir, "public");
const root = await mkdtemp(path.join(os.tmpdir(), "admin-site-"));
const credentialPath = path.join(root, "credentials.json");
await writeFile(credentialPath, JSON.stringify({ deviceToken: "d", passwordHash: "p", salt: "s" }), "utf8");

// 预置两种账号：一个管理员、一个普通用户。
const users = createUsers(root);
const admin = await users.register({ username: "13800000001", password: "admin12345" });
await users.setRole(admin.id, "admin");
await users.register({ username: "13800000002", password: "user12345" });

async function startServer(port) {
    const env = {
        ...process.env,
        ZINIAO_PORT: String(port), ZINIAO_BIND: "127.0.0.1",
        ZINIAO_DATA_ROOT: root, TEMU_CREDENTIALS: credentialPath,
        ZINIAO_INSTANCE_ID: "admin-site-test", TEMU_MYSQL_CONFIG: "", ZINIAO_SEED: "0"
    };
    delete env.TEMU_BASE_PATH;
    const child = spawn(process.execPath, ["server.mjs"], { cwd: hubDir, env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 80; i += 1) {
        await wait(200);
        try { const probe = await fetch(`http://127.0.0.1:${port}/login`); if (probe.ok) return child; } catch {}
    }
    child.kill("SIGKILL");
    throw new Error(`服务未启动：${stderr.slice(-300)}`);
}

const port = 21300 + Math.floor(Math.random() * 200);
const child = await startServer(port);
const base = `http://127.0.0.1:${port}`;
const origin = base;

/** 登录并返回会话 cookie。 */
async function login(username, password) {
    const response = await fetch(`${base}/session`, {
        method: "POST", redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", origin },
        body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`
    });
    return (response.headers.get("set-cookie") || "").split(";")[0];
}

try {
    const adminCookie = await login("13800000001", "admin12345");
    const userCookie = await login("13800000002", "user12345");
    assert.ok(adminCookie.startsWith("temu_session="), "管理员登录必须成功");
    assert.ok(userCookie.startsWith("temu_session="), "普通用户登录必须成功");

    /**
     * 一、未登录访问 /admin：跳到管理员登录，不是业务登录页。
     * 两个入口分开设计：管理员在管理站登录、普通用户在业务站登录，
     * 避免"管理员被送到业务登录页、登录完却落在业务工作台"的错位。
     */
    {
        const response = await fetch(`${base}/admin`, {
            redirect: "manual",
            headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }
        });
        assert.equal(response.status, 303, `未登录访问 /admin 必须进入管理登录，实际 ${response.status}`);
        assert.equal(response.headers.get('location'), '/admin/login');
        const loginResponse = await fetch(base + response.headers.get('location'));
        assert.equal(loginResponse.status, 200);
        const body = await loginResponse.text();
        assert.ok(body.includes("管理员登录"), "必须是管理登录页");
        assert.ok(body.includes('action="/admin/session"'), "管理登录必须提交到独立端点");
        assert.ok(!body.includes('action="/session"'), "管理登录不应提交到普通登录端点");
        assert.ok(!body.includes(">注册<"), "管理登录页不提供自助注册");
        assert.ok(body.includes("普通用户登录"), "必须给出普通用户的正确入口");
        assert.ok(!body.includes("请先登录中转仓"), "页面请求不应返回 JSON 错误体");
    }

    /**
     * 一之二、普通登录页保持原样：未登录访问 /login 是业务登录页，带注册链接。
     */
    {
        const response = await fetch(`${base}/login`, { headers: { accept: "text/html" } });
        const body = await response.text();
        assert.ok(body.includes("<title>登录 · 中转仓</title>"), "业务登录页标题必须保持原样");
        assert.ok(body.includes('action="/session"'), "业务登录必须提交到 /session");
        assert.ok(body.includes(">注册</a>"), "业务登录页必须保留注册入口");
        assert.ok(!body.includes("管理员登录"), "业务登录页不应出现管理登录字样");
    }

    /**
     * 一之三、普通用户误入管理登录页：即使口令正确也必须被拒。
     * 否则"分开设计"就只是外观上的分开。
     */
    {
        const response = await fetch(`${base}/admin/session`, {
            method: "POST", redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded", origin },
            body: "username=13800000002&password=user12345"
        });
        assert.equal(response.status, 403, `普通用户从管理登录页登录必须 403，实际 ${response.status}`);
        const body = await response.text();
        assert.ok(body.includes("不是管理员"), "必须说明原因，而不是笼统报错");
    }

    /** 一之四、管理员从管理登录页登录：应落到 /admin。 */
    {
        const response = await fetch(`${base}/admin/session`, {
            method: "POST", redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded", origin },
            body: "username=13800000001&password=admin12345"
        });
        assert.equal(response.status, 303, "管理员登录必须成功");
        assert.ok(String(response.headers.get("location") || "").endsWith("/admin"), "登录后必须落在管理站");
    }

    // 一之二、接口请求仍保持 JSON 401：调用方需要状态码，不是 HTML。
    {
        const response = await fetch(`${base}/api/admin/users`, {
            redirect: "manual",
            headers: { accept: "application/json" }
        });
        assert.equal(response.status, 401, `未登录调管理接口必须 401，实际 ${response.status}`);
        const body = await response.json().catch(() => ({}));
        assert.ok(body.error, "接口未登录应返回 JSON 错误体");
    }

    // 普通会话仅用于继续工作台业务，不能阻止打开管理员登录，也不能直接取得管理数据。
    {
        const response = await fetch(`${base}/admin`, { headers: { cookie: userCookie }, redirect: "manual" });
        assert.equal(response.status, 303, "普通会话误入管理员入口应转到管理员登录");
        assert.equal(response.headers.get('location'), '/admin/login');
        assert.equal(response.headers.get('set-cookie'), null, '打开管理员登录不能直接清掉普通登录');
        const loginResponse = await fetch(base + '/admin/login', { headers: { cookie: userCookie } });
        const body = await loginResponse.text();
        assert.equal(loginResponse.status, 200);
        assert.ok(body.includes('管理员登录') && body.includes('action="/admin/session"'));
        assert.ok(!body.includes('无权访问') && !body.includes('admin-store-list'));
    }

    // 带普通会话提交真实管理员口令时，登录端点必须被处理而非被普通会话短路成静态 404。
    {
        const response = await fetch(base + '/admin/session', { method: 'POST', redirect: 'manual',
            headers: { cookie: userCookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'username=13800000001&password=admin12345' });
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), '/admin');
        const switchedCookie = response.headers.get('set-cookie').split(';')[0];
        assert.ok(switchedCookie.startsWith('temu_session='));
        const me = await (await fetch(base + '/api/me', { headers: { cookie: switchedCookie } })).json();
        assert.equal(me.isAdmin, true);
        const denied = await fetch(base + '/admin/session', { method: 'POST', redirect: 'manual',
            headers: { cookie: userCookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
            body: 'username=13800000002&password=user12345' });
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get('set-cookie'), null);
        const crossOrigin = await fetch(base + '/admin/session', { method: 'POST', redirect: 'manual',
            headers: { cookie: userCookie, origin: 'https://evil.invalid', 'content-type': 'application/x-www-form-urlencoded' },
            body: 'username=13800000001&password=admin12345' });
        assert.equal(crossOrigin.status, 403);
        assert.equal(crossOrigin.headers.get('set-cookie'), null);
        const logout = await fetch(base + '/admin/logout', { method: 'POST', redirect: 'manual', headers: { cookie: switchedCookie, origin } });
        assert.equal(logout.status, 303);
        assert.equal(logout.headers.get('location'), '/admin/login');
        assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    }
    // 同一页面的别名与反代挂载前缀不能绕过入口规则，返回目标也不得跳出站点。
    for (const prefix of ['', '/temu']) {
        for (const alias of ['/admin', '/admin/', '/admin.html']) {
            const response = await fetch(base + prefix + alias, { redirect: 'manual', headers: { cookie: userCookie } });
            assert.equal(response.status, 303);
            assert.equal(response.headers.get('location'), prefix + (alias === '/admin' ? '/admin/login' : '/admin'));
        }
        const page = await fetch(base + prefix + '/admin/login?next=https://evil.invalid', { headers: { cookie: adminCookie } });
        assert.equal(page.status, 200, '显式登录页不根据现有身份自动跳回工作台');
        assert.ok((await page.text()).includes(`action="${prefix}/admin/session"`));
    }

    // 三、管理员访问 /admin：拿到独立的管理页，且不包含业务工作台的内容。
    {
        const response = await fetch(`${base}/admin`, { headers: { cookie: adminCookie } });
        assert.equal(response.status, 200, "管理员必须能打开 /admin");
        const body = await response.text();
        assert.ok(body.includes("管理控制台"), "管理页标题必须存在");
        assert.ok(body.includes("./admin.js"), "管理页必须加载自己的脚本，而不是业务 app.js");
        assert.ok(body.includes("./admin.css"), "管理页必须加载自己的样式");
        assert.ok(!body.includes("./app.js"), "管理页不得加载业务工作台脚本");
        // 业务功能不应当出现在管理站：这里是管理，不是日常业务。
        for (const word of ["商品库", "任务台", "工作日志"]) {
            assert.ok(!body.includes(word), `管理站不应出现业务入口「${word}」`);
        }
    }

    // 四、管理站的静态资源可加载（否则页面会是无样式白板）。
    {
        for (const asset of ["/admin.js", "/admin.css"]) {
            const response = await fetch(`${base}${asset}`);
            assert.equal(response.status, 200, `${asset} 必须可访问，实际 ${response.status}`);
        }
    }

    // 五、管理站脚本自身不引用业务工作台逻辑。
    {
        const source = await readFile(path.join(publicDir, "admin.js"), "utf8");
        for (const forbidden of ["renderProducts", "renderJobs", "renderHome", "renderStores", "uploadFiles"]) {
            assert.ok(!source.includes(forbidden), `管理站脚本不应包含业务函数 ${forbidden}`);
        }
        assert.ok(source.includes("confirmDestructive"), "管理站必须自带破坏性操作确认弹窗");
    }

    // 六、业务 SPA 不再持有管理界面：避免两处维护、权限判断分叉。
    {
        const appSource = await readFile(path.join(publicDir, "app.js"), "utf8");
        assert.ok(!appSource.includes("renderAdminUsers"), "业务 SPA 不应再有管理界面渲染函数");
        assert.ok(!appSource.includes('data-admin-view-button'), "业务 SPA 不应再有管理标签页");
        assert.ok(appSource.includes("/admin"), "业务 SPA 应保留指向管理站的入口或跳转");
    }

    // 七、业务导航指向独立管理站，而不是本页 hash 路由。
    {
        const html = await readFile(path.join(publicDir, "index.html"), "utf8");
        assert.ok(html.includes('href="./admin"'), "业务导航的管理入口必须指向独立页面");
        assert.ok(!html.includes('href="#/admin"'), "业务导航不应再使用 hash 路由进管理页");
    }

    // 八、管理接口本身仍按角色拦截（页面被绕过也拿不到数据）。
    {
        const response = await fetch(`${base}/api/admin/users`, { headers: { cookie: userCookie } });
        assert.equal(response.status, 403, "普通用户调管理接口必须 403");
    }

    console.log("admin site checks passed（普通会话转管理员登录、带旧会话重新登录有效、角色及跨源拒绝、退出与前缀别名、管理数据权限不放宽）");
} finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 500));
}
