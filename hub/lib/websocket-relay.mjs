import { WebSocketServer, WebSocket } from 'ws';
import { hasRelayPlugin } from './plugin-version.mjs';

/** 长连接仅维护身份和网络活性；商品通过原发送入口交接，不接收成功回执或执行状态。 */
export function installWebsocketRelay(server, { relay, pathMatches, authenticate, register,
    validate, heartbeatMs = 15000, authTimeoutMs = 10000, maxConnections = 512,
    maxBufferedBytes = 32 * 1024 * 1024 }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
    const connections = new Set();
    server.on('upgrade', (req, socket, head) => {
        if (!pathMatches(req) || connections.size >= maxConnections) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });
    wss.on('connection', (ws, req) => {
        const entry = { ws, ready: false, alive: true, busy: false, detach: null, auth: null, identity: null };
        connections.add(entry);
        const deadline = setTimeout(() => ws.close(4401, 'authentication_timeout'), authTimeoutMs);
        deadline.unref();
        const close = (code, reason) => { entry.detach?.(); entry.detach = null; ws.close(code, reason); };
        ws.on('error', () => close(1011, 'connection_error'));
        ws.on('close', () => { clearTimeout(deadline); entry.detach?.(); connections.delete(entry); });
        ws.on('message', async (raw, binary) => {
            if (binary) return close(4400, 'invalid_message');
            let message;
            try { message = JSON.parse(raw.toString()); } catch { return close(4400, 'invalid_json'); }
            if (entry.ready) {
                if (message?.type !== 'pong') return close(4400, 'unsupported_message');
                entry.alive = true; return;
            }
            if (entry.busy) return close(4400, 'invalid_message');
            entry.busy = true;
            try {
                if (message?.type !== 'authenticate') throw Error('authentication_required');
                const verified = await authenticate(req, message);
                if (ws.readyState !== WebSocket.OPEN) return;
                entry.auth = verified.auth; entry.identity = verified.identity;
                const agent = await register(entry.identity);
                if (ws.readyState !== WebSocket.OPEN) return;
                // 目录字段并非拒绝措施；不支持收件协议的版本不能进入实际商品通道。
                if (!hasRelayPlugin(agent) || agent.canReceiveUploads !== true) throw Error('unsupported_plugin');
                if (agent.storeId !== entry.identity.storeId || agent.pluginInstanceId !== entry.identity.pluginInstanceId
                    || agent.relaySessionId !== entry.identity.relaySessionId || !agent.identityMatched) throw Error('store_connection_occupied');
                entry.detach = relay.attach(entry.identity, {
                    available: () => ws.readyState === WebSocket.OPEN,
                    close: () => ws.close(4409, 'connection_replaced'),
                    deliver: claimed => {
                        const text = JSON.stringify({ type: 'products', claimed });
                        if (ws.readyState !== WebSocket.OPEN) throw Object.assign(Error('relay_not_connected'), { status: 409 });
                        // 慢连接共用总缓冲预算，不能让每家店分别堆积几十 MiB 耗尽小服务器内存。
                        const buffered = [...connections].reduce((total, current) => total + current.ws.bufferedAmount, 0);
                        if (buffered + Buffer.byteLength(text) > maxBufferedBytes) throw Object.assign(Error('relay_capacity'), { status: 429 });
                        ws.send(text, error => { if (error) close(1011, 'send_failed'); });
                    }
                });
                entry.ready = true; clearTimeout(deadline);
                ws.send(JSON.stringify({ type: 'ready', agent }));
            } catch (error) {
                // 不将令牌、认证响应或原始请求内容写入关闭原因，避免日志泄露。
                close(4403, ['store_connection_occupied', 'invalid_identity'].includes(error.message) ? error.message : 'authentication_failed');
            } finally { entry.busy = false; }
        });
    });
    // 由服务器主动探测通道，客户端只响应活性消息，不定时查询任务或执行进度。
    const timer = setInterval(async () => {
        for (const entry of connections) {
            if (!entry.ready || entry.busy) continue;
            if (!entry.alive) { entry.detach?.(); entry.ws.terminate(); continue; }
            entry.alive = false; entry.busy = true;
            try {
                await validate(entry.auth, entry.identity);
                const agent = await register(entry.identity);
                if (!hasRelayPlugin(agent) || agent.canReceiveUploads !== true) throw Error('unsupported_plugin');
                if (entry.ws.readyState === WebSocket.OPEN) entry.ws.send(JSON.stringify({ type: 'ping' }));
            } catch { entry.detach?.(); entry.ws.close(4403, 'permission_changed'); }
            finally { entry.busy = false; }
        }
    }, heartbeatMs);
    timer.unref();
    server.on('close', () => { clearInterval(timer); for (const entry of connections) entry.ws.terminate(); wss.close(); });
    return { close: () => { clearInterval(timer); for (const entry of connections) entry.ws.terminate(); } };
}
