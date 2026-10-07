import assert from 'node:assert/strict';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { createMysqlInventory } from '../lib/mysql-inventory.mjs';
import { createStore } from '../lib/store.mjs';
import { PRODUCT_NOTICE_SCHEMA, PRODUCT_NOTICE_REQUIRED_COLUMNS } from '../lib/product-notice-state.mjs';

// 必须先停服和备份；本脚本不会在启动时执行，也不会读取或修改线上插件运行状态。
if (!process.argv.includes('--confirm-offline') || !process.env.TEMU_MYSQL_CONFIG) {
    throw Error('请先停服并备份，再设置 TEMU_MYSQL_CONFIG 执行 migrate-product-notice-state.mjs --confirm-offline');
}
const database = await openMysqlDatabase();
try {
    const [[before]] = await database.query('maintenance', `SELECT
        (SELECT COUNT(*) FROM hub_batches) AS batches,(SELECT COUNT(*) FROM hub_batch_products) AS members,
        (SELECT COUNT(*) FROM hub_products) AS products`);
    // 生产运行账号仅有读写权限；部署管理员预建表后这里只校验字段并回填，不能给运行账号长期授予 DDL 权限。
    if (!process.argv.includes('--schema-precreated')) {
        for (const statement of PRODUCT_NOTICE_SCHEMA) await database.query('maintenance', statement);
    }
    for (const [table, columns] of Object.entries(PRODUCT_NOTICE_REQUIRED_COLUMNS)) {
        await database.query('maintenance', `SELECT ${columns.map(name => `\`${name}\``).join(',')} FROM ${table} LIMIT 0`);
    }
    // 旧版本同 SPU 改货号可能留下过期投影；只回填实例会让网页一直选择旧批次并被版本门禁拒绝。
    // 使用迁移库记录的资料目录，禁止依赖启动目录而意外读写另一个库存根目录。
    const [[schema]] = await database.query('maintenance', 'SELECT data_root FROM hub_schema WHERE id=1');
    assert.ok(schema?.data_root, '库存库未记录资料目录，不能执行通知迁移');
    const store = createStore(schema.data_root, { database });
    const [stores] = await database.query('maintenance', "SELECT DISTINCT store_id FROM hub_batches WHERE store_id<>'' ORDER BY store_id");
    for (const { store_id: storeId } of stores) await store.rebuildNoticeProjection(storeId);
    const result = await createMysqlInventory(database).backfillNoticeStates();
    const [[after]] = await database.query('maintenance', `SELECT
        (SELECT COUNT(*) FROM hub_batches) AS batches,(SELECT COUNT(*) FROM hub_batch_products) AS members,
        (SELECT COUNT(*) FROM hub_products) AS products`);
    assert.deepEqual(after, before, '通知迁移不得改变原采集成员或库存投影数量');
    const [[coverage]] = await database.query('maintenance', `SELECT COUNT(*) AS missing FROM hub_batch_products p
        JOIN hub_batches b ON b.id=p.batch_id LEFT JOIN hub_product_notice_states n
        ON n.store_id=b.store_id AND n.spu_id=p.spu_id WHERE b.store_id<>'' AND n.id IS NULL`);
    assert.equal(Number(coverage.missing), 0, '来源实例回填不完整，不能启动新协议');
    console.log(JSON.stringify({ migrated: true, ...result, countsPreserved: true, oldRedMarksPromoted: false }));
} finally {
    await database.close();
}
