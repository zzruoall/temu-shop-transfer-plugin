/** 云端独立认证：浏览器使用单管理员口令，设备使用独立令牌；绝不信任代理后的回环地址。 */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {scryptSync,timingSafeEqual,createHmac,randomBytes} from 'node:crypto';
import {loginPage} from './login.mjs';
// 云端认证文件只在正式站点启用；本地验证/开发服务走 ingest-auth 的本机令牌，不能因缺少云端配置而在模块加载阶段崩溃。
const credentialPath=String(process.env.TEMU_CREDENTIALS||'').trim();
const config=credentialPath?JSON.parse(await readFile(credentialPath,'utf8')):null;
const failures=new Map();
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
export const deviceToken=config?.deviceToken||'';
// 插件令牌使用随机值并保留服务端撤销状态，避免把管理员令牌或可推导密钥放进扩展。
const pluginTokens=new Map();
const pluginStateFile=process.env.TEMU_PLUGIN_TOKENS||new URL('./plugin-tokens.json',import.meta.url).pathname;
async function savePluginTokens(){await mkdir(new URL('.',`file://${pluginStateFile}`).pathname,{recursive:true}).catch(()=>{});await writeFile(pluginStateFile,JSON.stringify(Object.fromEntries(pluginTokens)),'utf8').catch(()=>{});}
try{const stored=JSON.parse(await readFile(pluginStateFile,'utf8'));for(const [token,item] of Object.entries(stored||{}))pluginTokens.set(token,item);}catch{}
export function issuePluginToken(instanceId){const id=String(instanceId||'').trim();if(!/^[a-zA-Z0-9-]{8,100}$/.test(id))return null;for(const [token,item] of pluginTokens)if(item.instanceId===id&&!item.disabled&&Date.now()-item.issuedAt<7*86400000)return token;const token=`pt_${randomBytes(32).toString('hex')}`;pluginTokens.set(token,{instanceId:id,disabled:false,issuedAt:Date.now()});savePluginTokens();return token;}
export function disablePluginInstance(instanceId){let count=0;for(const item of pluginTokens.values())if(item.instanceId===String(instanceId)){item.disabled=true;count++;}savePluginTokens();return count;}
function validPluginToken(token){const item=pluginTokens.get(String(token||''));return Boolean(item&&!item.disabled&&Date.now()-item.issuedAt<7*86400000);}
const signature=value=>createHmac('sha256',config?.passwordHash||'').update(value).digest('hex');
export async function cloudAuthenticate(req,res) {
    if(!config){res.writeHead(503,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify({error:'cloud_auth_not_configured'}));return false;}
    const origin=req.headers.origin;
    const authorization=String(req.headers.authorization||'');
    const extensionOrigin=origin==='chrome-extension://efojbbfhfniieifmppafmigfmndbledc';
    const deviceBearer=authorization.startsWith('Bearer ')&&equal(authorization.slice(7),config.deviceToken);
    const pluginBearer=authorization.startsWith('Bearer ')&&validPluginToken(authorization.slice(7));
    const pluginRegistration = req.method==='POST' && req.url==='/api/plugin/register'
        && ['https://agentseller.temu.com','https://www.temu.com','chrome-extension://efojbbfhfniieifmppafmigfmndbledc','https://*.kuajingmaihuo.com'].some(value=>value==='https://*.kuajingmaihuo.com'?String(origin||'').endsWith('.kuajingmaihuo.com'):origin===value);
    // 扩展注册不带令牌；注册后的所有请求必须带该扩展实例令牌，不能仅凭扩展来源放行。
    if(!['GET','HEAD','OPTIONS'].includes(req.method)&&origin&&origin!=='https://www.ruofei.com.cn'&&!pluginRegistration&&!deviceBearer&&!(extensionOrigin&&pluginBearer)) {
        res.writeHead(403);res.end('origin_denied');return false;
    }
    if(deviceBearer){req.temuDeviceBearer=true;return true;}
    if(pluginBearer)return true;
    const session=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('temu_session='))?.slice(13)||'';
    const [expiry,mac]=session.split('.');
    if(/^\d+$/.test(expiry||'')&&Number(expiry)>Date.now()&&Number(expiry)<Date.now()+86400001&&mac&&equal(mac,signature(expiry)))return true;
    const ip=String(req.headers['x-real-ip']||req.socket.remoteAddress);
    const state=failures.get(ip)||{count:0,until:0};
    if(state.until>Date.now()){res.writeHead(429,{'retry-after':'60'});res.end('Too many attempts');return false;}
    if(req.method==='POST'&&req.url==='/session') {
        if(origin!=='https://www.ruofei.com.cn'){res.writeHead(403);res.end('origin_denied');return false;}
        let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>4096){res.writeHead(413);res.end();return false;}}
        const fields=new URLSearchParams(body);
        if(fields.get('username')===config.username&&equal(scryptSync(fields.get('password')||'',config.salt,64),Buffer.from(config.passwordHash,'hex'))) {
            failures.delete(ip);const expires=String(Date.now()+86400000);
            res.writeHead(303,{'location':'/temu/','set-cookie':`temu_session=${expires}.${signature(expires)}; Path=/temu/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400`,'cache-control':'no-store'});res.end();return false;
        }
        if(failures.size>1000)failures.clear();
        failures.set(ip,{count:state.count+1,until:state.count>=9?Date.now()+60000:0});
        res.writeHead(401,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(loginPage('账号或密码错误，请重新输入。'));return false;
    }
    if(pluginRegistration||req.method==='POST'&&req.url==='/api/plugin/register'&&origin==='https://www.ruofei.com.cn')return true;
    const isPage=req.method==='GET'&&(req.url==='/'||req.url==='/login');
    res.writeHead(isPage?200:401,{'content-type':isPage?'text/html; charset=utf-8':'application/json','cache-control':'no-store'});
    res.end(isPage?loginPage():JSON.stringify({error:'请先登录中转仓'}));return false;
}
