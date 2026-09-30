/** 登录与注册页：独立页面不依赖已认证静态资源，错误文案只来自服务端固定文本。 */
import { normalizeBasePathValue } from './lib/ingest-auth.mjs';

const SHARED_STYLE = `
body{margin:0;background:#f4f8fc;color:#122b43;font:16px system-ui,sans-serif;min-height:100vh;display:grid;place-items:center}
main{box-sizing:border-box;background:white;border:1px solid #ccdae8;border-radius:12px;padding:32px;width:min(420px,calc(100% - 32px))}
h1{margin:0 0 12px;color:#0f3c64}p{line-height:1.6;color:#425c73}
label{display:block;margin:20px 0 8px}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:6px;font:inherit}
input{border:1px solid #91a9be}button{margin-top:24px;background:#0968c8;color:white;border:0;cursor:pointer}
button:hover{background:#064d97}input:focus-visible,button:focus-visible{outline:3px solid #0061b8;outline-offset:3px}
.error{color:#a21b24}.foot{margin:18px 0 0;font-size:14px}.foot a{color:#0968c8}
.secret{position:relative}
.secret input{padding-right:76px}
/* 明文切换只在客户端生效，不改变提交内容；放在输入框内以免多占一行空间。 */
.secret-toggle{position:absolute;top:50%;right:8px;transform:translateY(-50%);width:auto;margin:0;padding:6px 10px;background:#e8f0f9;color:#0f3c64;font-size:13px;border-radius:4px}
.secret-toggle:hover{background:#d3e3f5}
`;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

/**
 * 页面链接必须带对外挂载前缀：线上站点挂在 /temu 下，
 * 若生成 /register 这类根绝对路径，浏览器会跳出 /temu 落到同域的其他站点上。
 * 前缀由调用方按请求上下文传入，这里只做规整与合法性校验（拒绝被路径转换污染的 Windows 路径）。
 */
function prefix(base) {
    return normalizeBasePathValue(base);
}

/**
 * 密码输入框 + 明文切换。
 * 用 <button type="button"> 而不是 checkbox：不会参与表单提交，也不会被回车误触发。
 * 脚本内联在页面里，登录页不依赖任何外部资源即可使用。
 */
function secretField(id, label, { autocomplete, placeholder = '', minlength = 0 }) {
    return `<label for="${id}">${label}</label>
<div class="secret">
<input id="${id}" name="${id}" type="password" autocomplete="${autocomplete}" required${minlength ? ` minlength="${minlength}"` : ''} maxlength="200"${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}>
<button type="button" class="secret-toggle" data-toggle="${id}" aria-label="显示${label}" aria-pressed="false">显示</button>
</div>`;
}

/** 切换脚本：点击后在明文/密文之间切换，同步按钮文案与无障碍状态。 */
const TOGGLE_SCRIPT = `<script>
document.addEventListener('click',function(event){
    var button=event.target.closest?event.target.closest('[data-toggle]'):null;
    if(!button)return;
    event.preventDefault();
    var input=document.getElementById(button.getAttribute('data-toggle'));
    if(!input)return;
    var reveal=input.type==='password';
    input.type=reveal?'text':'password';
    button.textContent=reveal?'隐藏':'显示';
    button.setAttribute('aria-pressed',reveal?'true':'false');
    button.setAttribute('aria-label',(reveal?'隐藏':'显示')+button.getAttribute('aria-label').replace(/^(显示|隐藏)/,''));
});
</script>`;

export function loginPage(error = '', base = '', next = '') {
    const root = prefix(base);
    /**
     * 登录后回到用户原本要去的页面（例如从 /admin 被送来登录页的管理员）。
     * 用隐藏字段带回服务端，服务端会再做一次白名单校验——前端传什么都不可信。
     */
    const carry = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : '';
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 中转仓</title><style>${SHARED_STYLE}</style><main><h1>登录中转仓</h1><p>使用手机号登录。中转仓账号与商城账号独立，互不影响。</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" action="${root}/session">${carry}<label for="username">手机号</label><input id="username" name="username" type="tel" inputmode="numeric" autocomplete="username" required maxlength="40" placeholder="11 位手机号">${secretField('password', '密码', { autocomplete: 'current-password' })}<button type="submit">登录</button></form><p class="foot">还没有账号？<a href="${root}/register">注册</a></p></main>${TOGGLE_SCRIPT}</html>`;
}

/**
 * 管理员登录页：与业务登录页刻意分开。
 *
 * 分开的理由：
 *   1. 两边面向不同的人、做不同的事——业务站是日常上传，管理站是不可逆的账号与店铺操作，
 *      混用一个入口容易让人误把管理操作当日常操作；
 *   2. 深色外观与业务站的蓝白界面明确区分，让人一眼知道当前在管理站；
 *   3. 表单提交到独立端点，服务端会额外校验管理员角色，
 *      普通用户即使拿到这个页面也登不进去。
 *
 * 不提供"注册"链接：管理员只能由既有管理员在管理控制台里指派，没有自助注册通道。
 */
export function adminLoginPage(error = '', base = '') {
    const root = prefix(base);
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理员登录 · 中转仓</title><style>${ADMIN_STYLE}</style><main>
<div class="brand"><strong>管理控制台</strong><span>中转仓 · 仅限管理员</span></div>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="${root}/admin/session"><label for="username">管理员账号</label><input id="username" name="username" type="text" autocomplete="username" required maxlength="40" placeholder="手机号或管理员账号">${secretField('password', '密码', { autocomplete: 'current-password' })}<button type="submit">登录管理控制台</button></form>
<p class="foot"><a href="${root}/login">普通用户登录 →</a></p>
</main>${TOGGLE_SCRIPT}</html>`;
}

/** 管理员登录页样式：深色，与业务登录页的蓝白外观明确区分。 */
const ADMIN_STYLE = `
body{margin:0;background:#16283d;color:#eaf1f8;font:16px system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh;display:grid;place-items:center}
main{box-sizing:border-box;background:#1e3348;border:1px solid #2c4560;border-radius:12px;padding:34px;width:min(420px,calc(100% - 32px))}
.brand{display:grid;gap:4px;margin-bottom:20px}
.brand strong{font-size:20px;letter-spacing:.5px}
.brand span{color:#8fa8c0;font-size:12px}
p{line-height:1.6;color:#b9cde0;margin:0}
label{display:block;margin:20px 0 8px;color:#cfdcea;font-size:13px}
input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:6px;font:inherit}
input{border:1px solid #3a5771;background:#16283d;color:#eaf1f8}
input::placeholder{color:#6f8aa4}
button{margin-top:26px;background:#2f7cd0;color:white;border:0;cursor:pointer;font-weight:600}
button:hover{background:#2668b3}
input:focus-visible,button:focus-visible{outline:3px solid #5aa9ee;outline-offset:2px}
.error{color:#ffb4b4;margin-top:14px}
.foot{margin:20px 0 0;font-size:13px}
.foot a{color:#7fb8e8;text-decoration:none}
.foot a:hover{text-decoration:underline}
.secret{position:relative}
.secret input{padding-right:76px}
.secret-toggle{position:absolute;top:50%;right:8px;transform:translateY(-50%);width:auto;margin:0;padding:6px 10px;background:#263f57;color:#cfdcea;font-size:13px;border-radius:4px}
.secret-toggle:hover{background:#2f4d69}
`;

/** 注册页：注册成功即登录，避免用户再输一遍。allowSubmit=false 时只展示提示，不显示表单。 */
export function registerPage(error = '', allowSubmit = true, base = '') {
    const root = prefix(base);
    const form = allowSubmit
        ? `<form method="post" action="${root}/register"><label for="username">手机号</label><input id="username" name="username" type="tel" inputmode="numeric" autocomplete="username" required maxlength="40" placeholder="11 位手机号，用于登录与识别归属">${secretField('password', '密码', { autocomplete: 'new-password', placeholder: '至少 8 位', minlength: 8 })}${secretField('confirm', '确认密码', { autocomplete: 'new-password', placeholder: '再输入一次', minlength: 8 })}<button type="submit">注册并登录</button></form>`
        : '';
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>注册 · 中转仓</title><style>${SHARED_STYLE}</style><main><h1>注册中转仓账号</h1><p>用手机号注册。注册后需要认领自己的店铺才能采集和上传；店铺归账号所有，商品数据随店铺归属。</p>${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}${form}<p class="foot">已有账号？<a href="${root}/login">登录</a></p></main>${TOGGLE_SCRIPT}</html>`;
}
