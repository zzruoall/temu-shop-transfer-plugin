/** 线上只验证升级路由及认证拒绝；不登记虚构店铺、不抢真实会话、不投递或提交商品。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^(?:http:\/\/127\.0\.0\.1:\d+|https:\/\/www\.ruofei\.com\.cn)\/temu$/);
// 安装包沿用登录保护；仅在服务端进程内使用既有只读设备凭证，不输出或写入日志。
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS, 'utf8'));
assert.ok(credentials.deviceToken);
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
const socket = new WebSocket(base.replace(/^http/, 'ws') + '/api/relay/socket');
let upgrade = false;
try {
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { socket.terminate(); reject(Error('推送路由验收超时')); }, 15000);
        socket.on('error', error => { clearTimeout(timeout); reject(error); });
        socket.on('upgrade', response => { assert.equal(response.statusCode, 101); upgrade = true; });
        socket.on('open', () => socket.send(JSON.stringify({ type: 'authenticate', token: 'invalid-smoke-token',
            pluginInstanceId: randomUUID(), identity: { storeId: 'temu:99999999999999999999', mallId: '99999999999999999999',
                relaySessionId: randomUUID(), relayProtocol: 1, executionMode: 'plugin-api', identityMatched: true,
                pageUrl: 'https://agentseller.temu.com/goods/list', pluginVersion: '10.10.78' } })));
        socket.on('close', code => { clearTimeout(timeout); try { assert.equal(code, 4403); resolve(); } catch (error) { reject(error); } });
    });
    assert.ok(upgrade, '必须通过真实 HTTP 101，不能只测试静态文件存在');
    for (const name of ['temu-transfer-plugin-10.10.78.crx', 'temu-transfer-plugin-10.10.78.zip']) {
        const denied = await fetch(base + '/downloads/' + name, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
        assert.equal(denied.status, 401, '安装包不得因发布推送而开放匿名下载');
        const response = await fetch(base + '/downloads/' + name, { headers, signal: AbortSignal.timeout(20000) });
        assert.equal(response.status, 200);
        const hash = bytes => createHash('sha256').update(bytes).digest('hex');
        assert.equal(hash(Buffer.from(await response.arrayBuffer())), hash(await readFile(new URL('../public/downloads/' + name, import.meta.url))));
    }
    console.log(JSON.stringify({ pushRoute: true, http101: upgrade, invalidTokenRejected: true,
        downloadsMatched: true, agentRegistrationWrites: 0, realPlatformCalls: 0 }));
} finally { socket.terminate(); }
