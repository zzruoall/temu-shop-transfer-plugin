/** 发布后只读核对接口、网页和安装包；设备令牌仅从私有文件读取，不输出、不触发业务。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
const origin = process.argv[2] || 'http://127.0.0.1:18480/temu';
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS, 'utf8'));
const headers = { authorization: `Bearer ${credentials.deviceToken}` };
// 协议版本不代表调度器就绪：读取真实领导代次及持续心跳，发布切换后必须取得新的领导权。
const database = await openMysqlDatabase();
assert.ok(database, '缺少只读核对数据库配置');
try {
    const previousEpoch = Number(process.env.EXPECTED_PREVIOUS_EPOCH || -1);
    let firstHeartbeat = '', healthy = false;
    for (let attempt = 0; attempt < 25; attempt++) {
        const [[row]] = await database.query('query', 'SELECT supervisor_epoch,heartbeat_at,mode FROM hub_process_control WHERE id=1');
        if (row?.mode === 'on' && Number(row.supervisor_epoch) > previousEpoch && Date.now() - Date.parse(row.heartbeat_at) < 10000) {
            if (firstHeartbeat && firstHeartbeat !== row.heartbeat_at) { healthy = true; break; }
            firstHeartbeat = row.heartbeat_at;
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    assert.ok(healthy, '账户调度器未取得新领导权或心跳未推进');
    console.log(JSON.stringify({ accountSchedulerHeartbeat: true, newLeadershipRequired: previousEpoch >= 0 }));
} finally { await database.close(); }
for (const endpoint of ['/api/ingest-info', '/api/overview?productLimit=20', '/api/jobs?limit=20', '/api/stores?limit=20', '/api/live']) {
    const response = await fetch(origin + endpoint, { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, endpoint);
    const body = await response.json();
    if (endpoint === '/api/ingest-info') assert.equal(body.accountExecutionProtocol, 1);
    console.log(JSON.stringify({ endpoint, status: response.status }));
}
for (const [asset, expected] of [
    ['/app.js', '0bba6f8f90f0eed5aaf031d300fd7802c1f1ebc3451535789c9e1a8e7ca04169'],
    ['/downloads/temu-transfer-plugin-10.10.68.crx', 'fb31066db5078412fb22791d2cc18670a0f68fe09880da094dca3d15998509cf'],
    ['/downloads/temu-transfer-plugin-10.10.68.zip', '2dde27e24acbb7d8e36683d6da78a4a35b13ec03e1ffc50654f110efbfa3f8f8']
]) {
    const response = await fetch(origin + asset, { headers, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200, asset);
    const hash = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    assert.equal(hash, expected, asset);
    console.log(JSON.stringify({ asset, sha256: hash, matched: true }));
}
