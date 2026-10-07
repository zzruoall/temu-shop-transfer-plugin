/** 发布后只读核对当前红标与实际来源引用一致；不注册插件、不向目标发送、不创建错误事实。 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { createStore } from '../lib/store.mjs';
const base = process.env.TEMU_SMOKE_BASE;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/temu$/);
const credentials = JSON.parse(await readFile(process.env.TEMU_CREDENTIALS, 'utf8'));
const response = await fetch(base + '/api/overview?productLimit=20', { headers: { authorization: `Bearer ${credentials.deviceToken}` }, signal: AbortSignal.timeout(20000) });
assert.equal(response.status, 200);
const overview = await response.json();
const database = await openMysqlDatabase();
assert.ok(database);
try {
    const [[schema]] = await database.query('query', 'SELECT data_root FROM hub_schema WHERE id=1');
    const store = createStore(schema.data_root, { database });
    for (const product of overview.products) {
        assert.equal(product.sendBlocked, Boolean(product.blocked || product.errorNotice), '红色展示与发送资格必须一致');
        for (const sourceStoreId of product.sourceStoreIds || []) {
            const ids = product.spuIds || [product.spuId];
            const refs = await store.noticeRefs(sourceStoreId, ids);
            assert.equal(refs.length, ids.length);
            for (const ref of refs) assert.equal(ref.sendBlocked, product.sendBlocked, '交接读取的来源资格不能漏掉历史红标');
        }
    }
    console.log(JSON.stringify({ redFilterSmoke: true, examined: overview.products.length,
        eligible: overview.products.filter(p => !p.sendBlocked).length,
        skipped: overview.products.filter(p => p.sendBlocked).length, realPlatformCalls: 0 }));
} finally { await database.close(); }
