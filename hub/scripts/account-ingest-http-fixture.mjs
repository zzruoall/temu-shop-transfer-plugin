import { randomUUID, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { transferManifest } from '../lib/transfer-integrity.mjs';

/** 测试按真实插件协议登记实例、申请许可再上传，不绕过on模式的授权链。 */
export async function submitAccountIngest({ origin, token, packet, fileName = 'capture.json', requestId = randomUUID() }) {
    const storeId = packet.source.sourceStoreId;
    const pluginInstanceId = `fixture-${createHash('sha256').update(storeId).digest('hex').slice(0, 24)}`;
    const identity = { storeId, storeName: packet.source.sourceStoreName || storeId, mallId: storeId.replace('temu:', ''),
        pluginInstanceId, pluginVersion: '10.10.67', executionMode: 'plugin-api', pluginDetected: true,
        identityMatched: true, pageUrl: 'https://agentseller.temu.com/goods/list', schedulingProtocol: 1 };
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-plugin-instance': pluginInstanceId };
    const registered = await fetch(`${origin}/api/agents/register`, { method: 'POST', headers, body: JSON.stringify(identity) });
    /**
     * 登记失败时**返回响应**而不是抛错。
     *
     * 调用方（门控用例）要断言失败关闭的**状态码**；fixture 直接 assert 会让
     * "服务端正确拒绝"变成"测试自己报错"，掩盖真正的语义。
     */
    if (!registered.ok) return registered;
    const body = JSON.stringify({ packet: { ...packet, source: { ...packet.source, pluginInstanceId } }, fileName });
    // 摘要覆盖实际发出的包，实例信息属于来源证据，不能在算摘要后再修改。
    const upload = JSON.parse(body);
    upload.transferIntegrity = transferManifest(upload.packet);
    const serialized = JSON.stringify(upload);
    const prepared = await fetch(`${origin}/api/ingest/prepare`, { method: 'POST', headers,
        body: JSON.stringify({ ...identity, accountExecutionProtocol: 1, requestId,
            sha256: upload.transferIntegrity.sha256, bytes: Buffer.byteLength(serialized) }) });
    const permit = await prepared.json();
    // 准入被拒同样返回原响应：调用方按状态码断言，不被 fixture 的 assert 打断。
    if (!prepared.ok || !permit.token) {
        return new Response(JSON.stringify(permit), { status: prepared.status, headers: { 'content-type': 'application/json' } });
    }
    return fetch(`${origin}/api/ingest`, { method: 'POST', headers: { ...headers, 'x-ingest-permit': permit.token }, body: serialized });
}
