/** 部署前只读核对指定历史批次；不创建任务、不领取商品、不修改原文件或数据库。 */
import { openMysqlDatabase } from "../lib/mysql-database.mjs";
import { createStore } from "../lib/store.mjs";
const database = await openMysqlDatabase();
if (!database || !process.env.ZINIAO_DATA_ROOT || process.argv.length < 3) throw new Error("必须指定数据库、数据目录及批次编号");
try {
    const store = createStore(process.env.ZINIAO_DATA_ROOT, { database });
    for (const id of process.argv.slice(2)) {
        const batch = await store.getBatch(id);
        if (!batch) throw new Error(`批次不存在: ${id}`);
        const products = await store.verifyBatchTransfer(batch, batch.products);
        console.log(JSON.stringify({ batchId: id, products: products.length, diagnosticNotReady: products.filter(product => !product.ready).length, originalSourceVerified: true, recoveredLegacyCount: products.filter(product => product.publicationData.restoredFromOriginal).length, writes: 0 }));
    }
} finally { await database.close(); }
