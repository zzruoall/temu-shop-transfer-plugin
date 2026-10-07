/** 同规格Linux隔离大包验收；客户驱动不计入服务cgroup，不访问生产库或真实平台。 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema } from '../lib/mysql-schema.mjs';
import { transferManifest } from '../lib/transfer-integrity.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.getuid(), 0, '需要root创建隔离systemd资源组');
const root = await mkdtemp(path.join(tmpdir(), 'temu-relay-load-'));
const name = `temu_relay_load_${Date.now()}`, unit = `temu-v38-load-${Date.now()}`;
const socketPath = '/var/run/mysqld/mysqld.sock';
const config = path.join(root, 'mysql.json');
const admin = await mysql.createConnection({ socketPath, user: 'root' });
let db, started = false, peak = 0;
try {
    await admin.query(`CREATE DATABASE ${name} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
    await writeFile(config, JSON.stringify({ socketPath, user: 'root', database: name }), { mode: 0o600 });
    db = await openMysqlDatabase(config);
    await initializeMysqlSchema(db);
    await db.query('maintenance', "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    // 端口仅用于本轮隔离进程，启动前不占用生产18480或反向代理。
    const port = 19238, token = randomUUID();
    const command = ['--quiet', '--collect', `--unit=${unit}`, '-p', 'MemoryMax=768M', '-p', 'CPUQuota=60%',
        `--working-directory=${path.resolve('.')}`, '--setenv=ZINIAO_BIND=127.0.0.1', `--setenv=ZINIAO_PORT=${port}`,
        `--setenv=ZINIAO_DATA_ROOT=${root}`, `--setenv=TEMU_MYSQL_CONFIG=${config}`, '--setenv=TEMU_CREDENTIALS=',
        '--setenv=TEMU_BASE_PATH=', '--setenv=ZINIAO_SEED=0', `--setenv=ZINIAO_INGEST_TOKEN=${token}`,
        process.execPath, path.resolve('server.mjs')];
    execFileSync('systemd-run', command); started = true;
    const origin = `http://127.0.0.1:${port}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    let ready = false;
    for (let i = 0; i < 60; i++) {
        try { const response = await fetch(origin + '/api/direct-create-capability', { headers, signal: AbortSignal.timeout(1000) });
            if (response.status === 200 && (await response.json()).relayProtocol === 1) { ready = true; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.ok(ready, '隔离服务未就绪');
    const cgroup = execFileSync('systemctl', ['show', `${unit}.service`, '-p', 'ControlGroup', '--value'], { encoding: 'utf8' }).trim();
    const cgroupRoot = '/sys/fs/cgroup' + cgroup;
    assert.equal(Number(await readFile(cgroupRoot + '/memory.max', 'utf8')), 768 * 1024 * 1024);
    const metrics = [], errorsBefore = await readFile(cgroupRoot + '/memory.events', 'utf8');
    for (const mib of [8, 32, 56]) {
        const count = 100, padding = 'x'.repeat(Math.floor(mib * 1024 * 1024 / count));
        const products = Array.from({ length: count }, (_, index) => ({ productId: `${6000000000 + mib * 1000 + index}`,
            productName: `隔离商品${mib}-${index}`, custom: { padding } }));
        const packet = { kind: 'full-capture-packet', schemaVersion: 5,
            source: { sourceStoreId: `temu:load-${mib}`, shopName: '隔离负载店' },
            products: products.map(product => ({ spuId: product.productId })),
            records: products.map(product => ({ dataType: 'product-detail', identity: { productIds: [product.productId] },
                source: { pageProductId: product.productId, requestUrl: 'https://agentseller.temu.com/visage-agent-seller/product/query' },
                payload: { success: true, result: product } })) };
        const body = JSON.stringify({ packet, transferIntegrity: transferManifest(packet) });
        assert.ok(Buffer.byteLength(body) < 64 * 1024 * 1024);
        const sampling = setInterval(() => {
            readFile(cgroupRoot + '/memory.current', 'utf8').then(value => { peak = Math.max(peak, Number(value)); }).catch(() => {});
        }, 50);
        const before = Date.now();
        try {
            const response = await fetch(origin + '/api/ingest', { method: 'POST', headers, body, signal: AbortSignal.timeout(180000) });
            const result = await response.json();
            assert.equal(response.status, 200, JSON.stringify(result));
            assert.equal(result.transferIntegrity.verified, true);
            assert.equal(result.batch.productCount, count);
            metrics.push({ bytes: Buffer.byteLength(body), products: count, ms: Date.now() - before });
        } finally { clearInterval(sampling); }
        assert.equal(execFileSync('systemctl', ['is-active', `${unit}.service`], { encoding: 'utf8' }).trim(), 'active');
    }
    const errorsAfter = await readFile(cgroupRoot + '/memory.events', 'utf8');
    const oom = text => Number(text.match(/^oom_kill (\d+)$/m)?.[1] || 0);
    assert.equal(oom(errorsAfter), oom(errorsBefore), '隔离上传触发OOM');
    const [[row]] = await db.query('query', 'SELECT COUNT(*) AS n FROM hub_products');
    assert.equal(Number(row.n), 300);
    console.log(JSON.stringify({ linuxRelayLoad: true, memoryLimitBytes: 768 * 1024 * 1024, cpuQuota: '60%', peakSampleBytes: peak, metrics, realPlatformCalls: 0 }));
} finally {
    if (started) execFileSync('systemctl', ['stop', `${unit}.service`]);
    await db?.close();
    await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
}
