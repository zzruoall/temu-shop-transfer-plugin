import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const INVENTORY_SCHEMA = [
    `CREATE TABLE IF NOT EXISTS hub_inventory_revision (id INT PRIMARY KEY, revision BIGINT NOT NULL) ENGINE=InnoDB`,
    `INSERT IGNORE INTO hub_inventory_revision VALUES(1,0)`,
    `CREATE TABLE IF NOT EXISTS hub_inventory_locks (id CHAR(64) PRIMARY KEY) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS hub_inventory_store_meta (
        store_id VARCHAR(255) PRIMARY KEY, body JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_inventory_payloads (id CHAR(64) PRIMARY KEY, body LONGBLOB NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_batches (
        id VARCHAR(255) PRIMARY KEY, store_id VARCHAR(255) NOT NULL, position BIGINT NOT NULL,
        body JSON NOT NULL, digest CHAR(64) NOT NULL, INDEX(store_id), INDEX(position)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_batch_products (
        batch_id VARCHAR(255) NOT NULL, position INT NOT NULL, spu_id VARCHAR(255) NOT NULL,
        payload_id CHAR(64) NOT NULL, PRIMARY KEY(batch_id,position), INDEX(spu_id), INDEX(payload_id),
        FOREIGN KEY(batch_id) REFERENCES hub_batches(id) ON DELETE CASCADE,
        FOREIGN KEY(payload_id) REFERENCES hub_inventory_payloads(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_products (
        id CHAR(64) PRIMARY KEY, store_id VARCHAR(255) NOT NULL, position BIGINT NOT NULL, payload_id CHAR(64) NOT NULL,
        body JSON NOT NULL, search_text LONGTEXT NOT NULL, ready BOOLEAN NOT NULL, blocked BOOLEAN NOT NULL,
        missing_detail BOOLEAN NOT NULL, empty_detail BOOLEAN NOT NULL, missing_image BOOLEAN NOT NULL,
        INDEX(position), INDEX(store_id,position), INDEX(payload_id), INDEX(ready,position), INDEX(blocked,position),
        FOREIGN KEY(payload_id) REFERENCES hub_inventory_payloads(id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_product_sources (
        product_id CHAR(64) NOT NULL, store_id VARCHAR(255) NOT NULL, batch_id VARCHAR(255) NOT NULL,
        PRIMARY KEY(product_id,batch_id), INDEX(store_id,product_id), INDEX(batch_id,product_id),
        FOREIGN KEY(product_id) REFERENCES hub_products(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_inventory_meta (id INT PRIMARY KEY, body JSON NOT NULL) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS hub_inventory_file_locks (id CHAR(64) PRIMARY KEY) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS hub_batch_files (
        batch_id VARCHAR(255) NOT NULL, file_id CHAR(64) NOT NULL, stored_name TEXT NOT NULL,
        PRIMARY KEY(batch_id,file_id), INDEX(file_id),
        FOREIGN KEY(batch_id) REFERENCES hub_batches(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_inventory_file_gc (
        id CHAR(64) PRIMARY KEY, stored_name TEXT NOT NULL, queued_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6),
        INDEX(queued_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
    `CREATE TABLE IF NOT EXISTS hub_inventory_payload_gc (
        id CHAR(64) PRIMARY KEY, queued_at TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP(6), INDEX(queued_at)
    ) ENGINE=InnoDB`,
];
const hash = value => createHash("sha256").update(value).digest("hex");
const parse = value => typeof value === "string" ? JSON.parse(value) : value;
// Windows 文件系统不区分大小写并忽略末尾点和空格，同一物理文件必须共享引用与锁。
const fileId = name => hash(process.platform === "win32" ? name.replace(/[. ]+$/, "").toLowerCase() : name);

/** MySQL JSON 会重排对象键；摘要忽略键顺序，避免未修改批次在读回后被重复写入。 */
function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
    return value;
}

/** 完整资料按内容寻址压缩存一份，列表只读取投影；复制给目标店不复制原始采集文件。 */
export function createMysqlInventory(database, { removeFile } = {}) {
    const context = new AsyncLocalStorage();
    const query = (sql, params = []) => context.getStore()
        ? context.getStore().conn.query(sql, params) : database.query("query", sql, params);
    /** 多表读取使用同一只读快照，删除与入库并发时不能读到半份关联。 */
    async function readSnapshot(fn) {
        if (context.getStore()) return fn();
        return database.withConnection("query", async conn => {
            await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
            await conn.query("START TRANSACTION READ ONLY");
            try {
                const result = await context.run({ conn, stores: null }, fn);
                await conn.commit();
                return result;
            } catch (error) { await conn.rollback(); throw error; }
        });
    }
    /** 来源店是读改写边界；SPU 锁只用于跨来源导入冲突检查，不让其他来源正文进入内存。 */
    async function runMutation(fn, stores, spuIds = [], connection = null) {
        if (context.getStore()) return fn();
        if (!Array.isArray(stores)) throw new Error("库存写入必须指定来源店范围");
        const scope = [...new Set(stores.map(String))].sort();
        // 账户结算可注入已有事务；库存和工作终态必须共同提交或回滚，不能另开连接。
        const execute = async conn => {
            const keys = [...new Set([...scope.map(id => `store:${id}`), ...spuIds.map(id => `spu:${id}`)])].sort();
            for (const key of keys) {
                // UPSERT 直接取得排他锁，不能先 INSERT IGNORE 取得共享锁再升级而相互死锁。
                await conn.query("INSERT INTO hub_inventory_locks(id) VALUES(?) ON DUPLICATE KEY UPDATE id=VALUES(id)", [hash(key)]);
            }
            const ctx = { conn, stores: scope, mutation: true, changed: false };
            const value = await context.run(ctx, fn);
            // 全局版本只在业务 SQL 完成后短暂更新，不在解压和文件处理期间持锁。
            if (ctx.changed) await conn.query("UPDATE hub_inventory_revision SET revision=revision+1 WHERE id=1");
            return value;
        };
        const result = connection ? await execute(connection) : await database.transaction("ingest", execute);
        // 清理失败不改变已经提交的业务结果；持久化候选会在重启或后续写入时重试。
        if (!connection) await cleanup().catch(() => {});
        return result;
    }

    /** 写原文件、新增引用和清理共用同一把文件锁，防止提交间隙删掉重新引用的文件。 */
    async function protectFile(name) {
        if (!context.getStore()?.mutation) throw new Error("文件引用必须在库存事务内修改");
        const id = fileId(name);
        await query("INSERT INTO hub_inventory_file_locks(id) VALUES(?) ON DUPLICATE KEY UPDATE id=VALUES(id)", [id]);
    }

    /** 候选和引用变更同事务提交；不能在这里删除物理文件。 */
    async function queueFiles(names) {
        if (!context.getStore()?.mutation) throw new Error("文件清理候选必须在库存事务内登记");
        for (const name of [...new Set(names)].sort()) {
            // 与清理器保持“文件锁 -> 候选行”的相同锁序，避免删除与重新引用互相等待。
            await protectFile(name);
            await query("INSERT IGNORE INTO hub_inventory_file_gc(id,stored_name) VALUES(?,?)", [fileId(name), name]);
        }
    }

    /** 有界清理持久化候选；文件删除幂等，断电或删除失败后仍能从队列恢复。 */
    async function cleanup(limit = 32) {
        const count = Math.min(128, Math.max(1, Math.floor(Number(limit) || 32)));
        const [files] = removeFile ? await database.query("maintenance", "SELECT id,stored_name FROM hub_inventory_file_gc ORDER BY queued_at,id LIMIT ?", [count]) : [[]];
        for (const file of files) {
            try {
                await database.transaction("maintenance", async conn => {
                    await conn.query("INSERT INTO hub_inventory_file_locks(id) VALUES(?) ON DUPLICATE KEY UPDATE id=VALUES(id)", [file.id]);
                    const [refs] = await conn.query("SELECT batch_id FROM hub_batch_files WHERE file_id=? LIMIT 1", [file.id]);
                    if (!refs.length) await removeFile(file.stored_name);
                    await conn.query("DELETE FROM hub_inventory_file_gc WHERE id=?", [file.id]);
                });
            } catch {
                // 失败项排到队尾，避免一个无法删除的文件饿死后续候选。
                await database.query("maintenance", "UPDATE hub_inventory_file_gc SET queued_at=CURRENT_TIMESTAMP(6) WHERE id=?", [file.id]);
            }
        }
        const [payloads] = await database.query("maintenance", "SELECT id FROM hub_inventory_payload_gc ORDER BY queued_at,id LIMIT ?", [count]);
        for (const { id } of payloads) await database.transaction("maintenance", async conn => {
            await conn.query("SELECT id FROM hub_inventory_payloads WHERE id=? FOR UPDATE", [id]);
            const [[refs]] = await conn.query(`SELECT EXISTS(SELECT 1 FROM hub_batch_products WHERE payload_id=?)
                OR EXISTS(SELECT 1 FROM hub_products WHERE payload_id=?) AS present`, [id, id]);
            if (!refs.present) await conn.query("DELETE FROM hub_inventory_payloads WHERE id=?", [id]);
            await conn.query("DELETE FROM hub_inventory_payload_gc WHERE id=?", [id]);
        });
    }

    /** 商品归属查询只读关联索引；删除和解红据此挑选来源店，不读其他来源 payload。 */
    async function storesForSpus(ids, includeBlocked = false) {
        if (!ids.length) return [];
        const [rows] = await query(`SELECT DISTINCT b.store_id FROM hub_batches b JOIN hub_batch_products p ON p.batch_id=b.id WHERE p.spu_id IN (?)`, [ids]);
        const stores = new Set(rows.map(row => row.store_id));
        if (includeBlocked) {
            const [meta] = await query("SELECT store_id,body FROM hub_inventory_store_meta");
            for (const row of meta) if (Object.keys(parse(row.body).blockedProducts || {}).some(key => ids.includes(key.split("\u0000")[1]))) stores.add(row.store_id);
        }
        return [...stores];
    }

    /** 导入已持有 SPU 锁；跨店同 SPU 仍沿用原拒收规则，不能因局部读取绕过。 */
    async function assertSource(ids, storeId) {
        const stores = await storesForSpus(ids);
        if (stores.some(id => id && id !== storeId)) throw Object.assign(new Error("SPU来源店冲突，已拒收以避免混店"), { status: 409 });
    }

    /** 删除预览只按索引统计历史跨来源同 SPU，不为共享数量读取其他来源正文。 */
    async function sharedSpuCount(storeId) {
        const [[row]] = await query(`SELECT COUNT(DISTINCT p.spu_id) AS n FROM hub_batches b
            JOIN hub_batch_products p ON p.batch_id=b.id WHERE b.store_id=? AND EXISTS(
                SELECT 1 FROM hub_batch_products other JOIN hub_batches source ON source.id=other.batch_id
                WHERE other.spu_id=p.spu_id AND source.store_id<>?)`, [storeId, storeId]);
        return Number(row.n);
    }
    async function payload(value) {
        const json = JSON.stringify(value);
        const id = hash(json);
        await query("INSERT INTO hub_inventory_payloads(id,body) VALUES(?,?) ON DUPLICATE KEY UPDATE id=VALUES(id)", [id, gzipSync(json)]);
        return id;
    }
    async function loadPayloads(ids) {
        const out = new Map();
        const unique = [...new Set(ids)];
        for (let offset = 0; offset < unique.length; offset += 100) {
            const keys = unique.slice(offset, offset + 100);
            const [rows] = await query("SELECT id,body FROM hub_inventory_payloads WHERE id IN (?)", [keys]);
            for (const row of rows) {
                const json = gunzipSync(row.body).toString("utf8");
                // 内容寻址必须在读取时验证，不能把损坏正文重新打包成一个看似有效的新任务摘要。
                if (hash(json) !== row.id) throw new Error("商品存储正文摘要不一致，停止发送");
                out.set(row.id, JSON.parse(json));
            }
        }
        if (out.size !== unique.length) throw new Error("商品版本资料缺失，停止读取");
        return out;
    }
    /** 入库只解压受影响的货号/SPU连通集合；保留旧投影的所有SPU，避免同货号历史合并被拆散。 */
    async function prepareImport(products, codesOf, fingerprint) {
        const ctx = context.getStore();
        if (!ctx?.mutation || ctx.stores.length !== 1 || !ctx.stores[0] || !products.length) return;
        const [[legacy]] = await query("SELECT body FROM hub_inventory_store_meta WHERE store_id=?", [ctx.stores[0]]);
        if (parse(legacy?.body || {}).excludedSpuIds?.length) return;
        const [[sameFile]] = await query("SELECT id FROM hub_batches WHERE store_id=? AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.fingerprint'))=? LIMIT 1", [ctx.stores[0], fingerprint]);
        // 旧解析结果升级可能修改整个批次，保留原全量兼容路径；正常新采集使用增量路径。
        if (sameFile) return;
        const [rows] = await query('SELECT id,body FROM hub_products WHERE store_id=?', [ctx.stores[0]]);
        const ids = new Set(products.map(product => String(product.spuId))), codes = new Set(products.flatMap(codesOf));
        const selected = new Set();
        const candidates = rows.map(row => ({ id: row.id, product: parse(row.body) }));
        let changed;
        do {
            changed = false;
            for (const row of candidates) {
                if (selected.has(row.id)) continue;
                const spus = row.product.spuIds || [row.product.spuId], keys = codesOf(row.product);
                if (!spus.some(id => ids.has(String(id))) && !keys.some(key => codes.has(key))) continue;
                selected.add(row.id); spus.forEach(id => ids.add(String(id))); keys.forEach(key => codes.add(key)); changed = true;
            }
        } while (changed);
        ctx.partialImport = { ids: [...ids], productIds: selected, baseline: new Map() };
    }
    async function read(stores = context.getStore()?.stores) {
        if (stores && !stores.length) return { version: 1, batches: [], products: [], blockedProducts: {} };
        const params = stores ? [stores] : [];
        const [batchRows] = await query(`SELECT id,body FROM hub_batches${stores ? " WHERE store_id IN (?)" : ""} ORDER BY position,id`, params);
        const partial = context.getStore()?.partialImport;
        const [members] = await query(`SELECT p.batch_id,p.payload_id FROM hub_batch_products p JOIN hub_batches b ON b.id=p.batch_id${stores ? " WHERE b.store_id IN (?)" : ""}${partial ? ' AND p.spu_id IN (?)' : ''} ORDER BY p.batch_id,p.position`, [...params, ...(partial ? [partial.ids] : [])]);
        const [productRows] = partial ? [[]] : await query(`SELECT payload_id FROM hub_products${stores ? " WHERE store_id IN (?)" : ""} ORDER BY position,id`, params);
        const bodies = await loadPayloads([...members, ...productRows].map(row => row.payload_id));
        const batches = batchRows.map(row => ({ ...parse(row.body), products: [] }));
        const byId = new Map(batches.map(batch => [batch.id, batch]));
        for (const row of members) byId.get(row.batch_id).products.push(structuredClone(bodies.get(row.payload_id)));
        if (partial) for (const batch of batches) partial.baseline.set(batch.id, JSON.stringify(batch));
        const [meta] = await query("SELECT body FROM hub_inventory_meta WHERE id=1");
        const [localMeta] = await query(`SELECT body FROM hub_inventory_store_meta${stores ? " WHERE store_id IN (?)" : ""}`, params);
        const blockedProducts = Object.assign({}, ...localMeta.map(row => parse(row.body).blockedProducts || {}));
        const excludedSpuIds = [...new Set(localMeta.flatMap(row => parse(row.body).excludedSpuIds || []))];
        return { ...(meta[0] ? parse(meta[0].body) : { version: 1 }), blockedProducts, excludedSpuIds, batches,
            products: productRows.map(row => structuredClone(bodies.get(row.payload_id))) };
    }
    async function write(index) {
        const ctx = context.getStore();
        if (!ctx?.mutation) throw new Error("库存写入必须处于来源店事务内");
        const scope = new Set(ctx.stores);
        if ((index.batches || []).some(batch => !scope.has(String(batch.sourceStoreId || "")))) throw new Error("批次超出库存事务来源店范围");
        if (!scope.size) return;
        const [oldBatches] = await query("SELECT id,digest,position FROM hub_batches WHERE store_id IN (?)", [ctx.stores]);
        const partial = ctx.partialImport;
        const [oldProducts] = partial && !partial.productIds.size ? [[]] : await query(`SELECT id,payload_id,position FROM hub_products WHERE store_id IN (?)${partial ? ' AND id IN (?)' : ''}`, [ctx.stores, ...(partial ? [[...partial.productIds]] : [])]);
        const old = new Map(oldBatches.map(row => [row.id, row]));
        const ids = new Set();
        for (let batch of index.batches || []) {
            if (partial?.baseline.get(batch.id) === JSON.stringify(batch)) { ids.add(batch.id); continue; }
            if (partial?.baseline.has(batch.id)) {
                // 文件补回仅改批次证据，不得用局部商品列表覆盖完整历史成员。
                const before = JSON.parse(partial.baseline.get(batch.id));
                if (JSON.stringify(before.products) !== JSON.stringify(batch.products)) throw new Error('增量导入不能替换未完整加载的历史批次');
                batch = { ...batch, products: (await getBatch(batch.id)).products };
            }
            // 时间排序不依赖全仓或单店数组下标，新增一个批次不必重写旧行的位置。
            const position = -(Date.parse(batch.createdAt) || 0);
            const { products = [], ...body } = batch;
            const digest = hash(JSON.stringify(canonical(batch)));
            ids.add(batch.id);
            if (old.get(batch.id)?.digest === digest) {
                if (Number(old.get(batch.id).position) !== position) await query("UPDATE hub_batches SET position=? WHERE id=?", [position, batch.id]);
                continue;
            }
            await retireBatch(batch.id);
            // 新批次发生标识碰撞必须失败，不能用 UPSERT 把范围外的来源店悄悄覆盖。
            await query(`INSERT INTO hub_batches(id,store_id,position,body,digest) VALUES(?,?,?,?,?)${old.has(batch.id) ? " ON DUPLICATE KEY UPDATE store_id=VALUES(store_id),position=VALUES(position),body=VALUES(body),digest=VALUES(digest)" : ""}`,
                [batch.id, String(batch.sourceStoreId || ""), position, JSON.stringify(body), digest]);
            const batchFiles = new Map((batch.files || []).filter(file => file.storedName).map(file => [fileId(file.storedName), file.storedName]));
            for (const [id, name] of [...batchFiles].sort(([a], [b]) => a.localeCompare(b))) {
                await protectFile(name);
                await query("INSERT INTO hub_batch_files(batch_id,file_id,stored_name) VALUES(?,?,?)", [batch.id, id, name]);
            }
            await query("DELETE FROM hub_batch_products WHERE batch_id=?", [batch.id]);
            for (const [itemPosition, product] of products.entries()) {
                await query("INSERT INTO hub_batch_products(batch_id,position,spu_id,payload_id) VALUES(?,?,?,?)", [batch.id, itemPosition, String(product.spuId || ""), await payload(product)]);
            }
        }
        for (const row of oldBatches) if (!ids.has(row.id)) {
            await retireBatch(row.id);
            await query("DELETE FROM hub_batches WHERE id=?", [row.id]);
        }
        const previous = new Map(oldProducts.map(row => [row.id, row]));
        const current = new Set();
        const batches = new Map((index.batches || []).map(batch => [batch.id, batch]));
        for (const product of index.products || []) {
            const sourceIds = [...new Set((product.batchIds || []).map(id => String(batches.get(id)?.sourceStoreId || "")))];
            if (sourceIds.length !== 1 || !scope.has(sourceIds[0])) throw new Error("商品投影必须只属于一个来源店");
            const position = -(product.batchIds || []).reduce((latest, id) => Math.max(latest, Date.parse(batches.get(id)?.createdAt) || 0), 0);
            const id = hash(JSON.stringify([product.sourceStoreIds || [], product.spuIds || [product.spuId], sourceIds[0] ? null : product.batchIds]));
            current.add(id);
            const json = JSON.stringify(product);
            const payloadId = hash(json);
            if (previous.get(id)?.payload_id === payloadId) {
                if (Number(previous.get(id).position) !== position) await query("UPDATE hub_products SET position=? WHERE id=?", [position, id]);
                continue;
            }
            if (previous.has(id)) await queuePayload(previous.get(id).payload_id);
            await payload(product);
            // 发布大正文不随商品列表返回；列表选择来源只需要不可变来源批次标识。
            const { publicationData, detail, ...summary } = product;
            if (publicationData) summary.publicationData = { sourceBatchId: publicationData.sourceBatchId };
            const search = [product.title, product.spuId, ...(product.spuIds || []), product.goodsId, product.category, product.articleNo,
                ...(product.productExtCodes || []), ...(product.skuExtCodes || []), ...(product.skus || []).map(sku => sku.extCode)].filter(Boolean).join(" ").toLocaleLowerCase();
            await query(`INSERT INTO hub_products(id,store_id,position,payload_id,body,search_text,ready,blocked,missing_detail,empty_detail,missing_image)
                VALUES(?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE position=VALUES(position),payload_id=VALUES(payload_id),body=VALUES(body),search_text=VALUES(search_text),ready=VALUES(ready),blocked=VALUES(blocked),missing_detail=VALUES(missing_detail),empty_detail=VALUES(empty_detail),missing_image=VALUES(missing_image)`,
            [id, sourceIds[0], position, payloadId, JSON.stringify(summary), search, !!product.ready, !!product.blocked,
                !product.completeness?.hasDetail && !product.completeness?.hasPrimaryDetail, product.completeness?.detailState === "source-empty", !product.completeness?.hasImages]);
            await query("DELETE FROM hub_product_sources WHERE product_id=?", [id]);
            for (const batchId of product.batchIds || []) await query("INSERT INTO hub_product_sources(product_id,store_id,batch_id) VALUES(?,?,?)", [id, String(batches.get(batchId)?.sourceStoreId || ""), batchId]);
        }
        for (const row of oldProducts) if (!current.has(row.id)) {
            await queuePayload(row.payload_id);
            await query("DELETE FROM hub_products WHERE id=?", [row.id]);
        }
        for (const storeId of scope) {
            const blockedProducts = Object.fromEntries(Object.entries(index.blockedProducts || {}).filter(([key]) => key.split("\u0000")[0] === storeId));
            const spus = new Set((index.batches || []).filter(batch => String(batch.sourceStoreId || "") === storeId).flatMap(batch => (batch.products || []).map(product => product.spuId)));
            const excludedSpuIds = (index.excludedSpuIds || []).filter(id => spus.has(id));
            await query("INSERT INTO hub_inventory_store_meta(store_id,body) VALUES(?,?) ON DUPLICATE KEY UPDATE body=VALUES(body)", [storeId, JSON.stringify({ blockedProducts, excludedSpuIds })]);
        }
        ctx.changed = true;
    }

    /** 只登记本次替换的旧 payload，不在入库热路径扫描历史垃圾。 */
    async function queuePayload(id) {
        // 清理器也是先锁正文再删候选，业务端不能反过来持有候选等待正文。
        await query("SELECT id FROM hub_inventory_payloads WHERE id=? FOR UPDATE", [id]);
        await query("INSERT IGNORE INTO hub_inventory_payload_gc(id) VALUES(?)", [id]);
    }

    /** 批次引用变更前留存清理候选；实际清理必须等待外层事务提交。 */
    async function retireBatch(id) {
        const [files] = await query("SELECT stored_name FROM hub_batch_files WHERE batch_id=?", [id]);
        await queueFiles(files.map(row => row.stored_name));
        await query("DELETE FROM hub_batch_files WHERE batch_id=?", [id]);
        const [items] = await query("SELECT DISTINCT payload_id FROM hub_batch_products WHERE batch_id=?", [id]);
        for (const row of items) await queuePayload(row.payload_id);
    }

    /** 仅离线迁移保存全局元数据；运行期只写来源店元数据，避免两个来源互相覆盖红标。 */
    async function importMeta(index) {
        if (!context.getStore()?.mutation) throw new Error("迁移元数据必须处于库存事务内");
        const { batches, products, blockedProducts, excludedSpuIds, ...meta } = index;
        await query("INSERT INTO hub_inventory_meta(id,body) VALUES(1,?) ON DUPLICATE KEY UPDATE body=VALUES(body)", [JSON.stringify(meta)]);
    }
    async function getBatch(id) {
        const [rows] = await query("SELECT body FROM hub_batches WHERE id=?", [id]);
        if (!rows.length) return null;
        const [items] = await query("SELECT payload_id FROM hub_batch_products WHERE batch_id=? ORDER BY position", [id]);
        const bodies = await loadPayloads(items.map(row => row.payload_id));
        return { ...parse(rows[0].body), products: items.map(row => bodies.get(row.payload_id)) };
    }
    async function signature() {
        const [[row]] = await query("SELECT revision FROM hub_inventory_revision WHERE id=1");
        return String(row.revision);
    }
    /** 发送校验只读所选商品的投影，不把整仓版本资料载入分发过程。 */
    async function transferRows(ids, storeId) {
        if (!ids.length) return { products: [] };
        const [rows] = await query(`SELECT p.body FROM hub_products p WHERE JSON_OVERLAPS(JSON_EXTRACT(p.body,'$.spuIds'),CAST(? AS JSON))
            AND EXISTS(SELECT 1 FROM hub_product_sources s WHERE s.product_id=p.id AND s.store_id=?)`, [JSON.stringify(ids.map(String)),storeId]);
        return { products: rows.map(row => parse(row.body)) };
    }
    async function getProduct(spuId) {
        const [rows] = await query("SELECT payload_id FROM hub_products WHERE JSON_CONTAINS(JSON_EXTRACT(body,'$.spuIds'),CAST(? AS JSON)) LIMIT 1", [JSON.stringify(String(spuId))]);
        if (!rows.length) return null;
        const bodies = await loadPayloads([rows[0].payload_id]);
        const product = bodies.get(rows[0].payload_id);
        const [batchRows] = product.batchIds?.length ? await query("SELECT body FROM hub_batches WHERE id IN (?) ORDER BY position", [product.batchIds]) : [[]];
        return { product, batches: batchRows.map(row => parse(row.body)) };
    }
    async function versions() {
        const [rows] = await query("SELECT store_id,id,digest FROM hub_batches ORDER BY id");
        const groups = new Map();
        for (const row of rows) {
            if (!groups.has(row.store_id)) groups.set(row.store_id, []);
            groups.get(row.store_id).push([row.id, row.digest]);
        }
        // 红标等视图字段也参与通知，但只读取小型哈希和关联，不读压缩发布资料。
        const [views] = await query("SELECT s.store_id,p.id,p.payload_id FROM hub_products p JOIN hub_product_sources s ON s.product_id=p.id ORDER BY s.store_id,p.id,s.batch_id");
        for (const row of views) {
            if (!groups.has(row.store_id)) groups.set(row.store_id, []);
            groups.get(row.store_id).push([row.id, row.payload_id]);
        }
        return { all: hash(JSON.stringify([...groups])), stores: new Map([...groups].map(([id, values]) => [id, hash(JSON.stringify(values))])) };
    }
    async function hasUnmapped(input) {
        const instance = String(input.pluginInstanceId || "").trim();
        const page = String(input.pageStoreName || "").trim().toLowerCase();
        const [rows] = await query(`SELECT id FROM hub_batches WHERE store_id='' AND (
            (?<>'' AND JSON_UNQUOTE(JSON_EXTRACT(body,'$.pluginInstanceId'))=?) OR
            (COALESCE(JSON_UNQUOTE(JSON_EXTRACT(body,'$.pluginInstanceId')),'')='' AND ?<>''
                AND LOWER(TRIM(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(body,'$.pageStoreName')),''),JSON_UNQUOTE(JSON_EXTRACT(body,'$.shopName')),'')))=?)) LIMIT 1`,
        [instance, instance, page, page]);
        return rows.length > 0;
    }
    /** 数据库先按可见店铺过滤再分页，普通用户不能借搜索或数量统计看到其他店的库存。 */
    async function page(scope, url) {
        const params = [];
        const visible = [];
        if (scope) {
            if (!scope.size) visible.push("0=1");
            else { visible.push("EXISTS(SELECT 1 FROM hub_product_sources s WHERE s.product_id=p.id AND s.store_id IN (?))"); params.push([...scope]); }
        }
        const base = visible.length ? visible.join(" AND ") : "1=1";
        const [counts] = await query(`SELECT COUNT(*) AS productCount,COALESCE(SUM(ready),0) AS readyCount,
            COALESCE(SUM(blocked),0) AS blockedCount,COALESCE(SUM(missing_detail),0) AS missingDetailCount,
            COALESCE(SUM(empty_detail),0) AS sourceEmptyDetailCount,COALESCE(SUM(missing_image),0) AS missingImageCount FROM hub_products p WHERE ${base}`, params);
        const count = Object.fromEntries(Object.entries(counts[0]).map(([key, value]) => [key, Number(value)]));
        const filters = { query: (url.searchParams.get("productQ") || "").trim().toLowerCase(), sourceStoreId: (url.searchParams.get("sourceStoreId") || "").trim(),
            sourceBatchId: (url.searchParams.get("sourceBatchId") || "").trim(), blocked: (url.searchParams.get("blocked") || "").trim(), readyOnly: /^(1|true|yes)$/i.test(url.searchParams.get("readyOnly") || "") };
        const clauses = [base];
        for (const [value, column] of [[filters.sourceStoreId, "store_id"], [filters.sourceBatchId, "batch_id"]]) {
            if (value) { clauses.push(`EXISTS(SELECT 1 FROM hub_product_sources s WHERE s.product_id=p.id AND s.${column}=?)`); params.push(value); }
        }
        if (filters.blocked === "blocked") clauses.push("p.blocked=1");
        if (filters.blocked === "normal") clauses.push("p.blocked=0");
        if (filters.readyOnly) clauses.push("p.ready=1");
        if (filters.query) { clauses.push("LOCATE(?,p.search_text)>0"); params.push(filters.query); }
        const where = clauses.join(" AND ");
        const [[totals]] = await query(`SELECT COUNT(*) AS total,COALESCE(SUM(ready),0) AS ready FROM hub_products p WHERE ${where}`, params);
        const limit = Math.min(200, Math.max(0, Number(url.searchParams.get("productLimit") ?? 100) || 0));
        const offset = Math.max(0, Math.floor(Number(url.searchParams.get("productOffset")) || 0));
        const [rows] = await query(`SELECT body FROM hub_products p WHERE ${where} ORDER BY position,id LIMIT ? OFFSET ?`, [...params, Math.floor(limit), offset]);
        const products = rows.map(row => parse(row.body));
        const batchParams = scope?.size ? [[...scope]] : [];
        const batchWhere = scope ? scope.size ? "store_id IN (?)" : "0=1" : "1=1";
        // 统计、店铺目录与当前页关联批次分开查询；商品翻页不下载所有历史批次 JSON。
        const [[batchCounts]] = await query(`SELECT COUNT(*) AS n,COALESCE(SUM(JSON_LENGTH(JSON_EXTRACT(body,'$.files'))),0) AS files FROM hub_batches WHERE ${batchWhere}`, batchParams);
        const [sourceRows] = await query(`SELECT store_id,MAX(COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(body,'$.sourceStoreName')),''),JSON_UNQUOTE(JSON_EXTRACT(body,'$.shopName')),store_id)) AS name FROM hub_batches WHERE ${batchWhere} GROUP BY store_id`, batchParams);
        const batchIds = new Set(products.flatMap(product => product.batchIds || []));
        const directory = url.searchParams.get('includeAllBatches') === '1';
        const batchOffset = Math.max(0, Math.floor(Number(url.searchParams.get('batchOffset')) || 0));
        const batchLimit = Math.min(200, Math.max(1, Math.floor(Number(url.searchParams.get('batchLimit')) || 100)));
        let batchRows = [];
        if (directory) [batchRows] = await query(`SELECT body FROM hub_batches WHERE ${batchWhere} ORDER BY position,id LIMIT ? OFFSET ?`, [...batchParams, batchLimit, batchOffset]);
        else if (batchIds.size) [batchRows] = await query(`SELECT body FROM hub_batches WHERE ${batchWhere} AND id IN (?) ORDER BY position,id`, [...batchParams, [...batchIds]]);
        const batches = batchRows.map(row => parse(row.body));
        return { ...count, incompleteCount: count.productCount - count.readyCount, batchCount: Number(batchCounts.n),
            fileCount: Number(batchCounts.files), excludedCount: 0, batchOffset, batchesHasMore: directory && batchOffset + batchRows.length < Number(batchCounts.n),
            productTotal: Number(totals.total), filteredReadyCount: Number(totals.ready), productOffset: offset,
            productPageSize: limit, productsHasMore: limit > 0 && offset + limit < Number(totals.total), products,
            sourceStores: sourceRows.filter(row => row.store_id).map(row => ({ storeId: row.store_id, storeName: row.name || row.store_id })),
            productFilters: filters, batches };
    }
    /** 回执和商品索引同事务提交，避免已经入库但回执尚未写入时崩溃后永久等待。 */
    async function ingestReceipt(id, receipt) {
        if (!context.getStore()) throw Error('入库回执必须在库存事务内写入');
        const [result] = await query("UPDATE hub_ingest_requests SET status='completed',receipt=?,updated_at=? WHERE id=? AND status='processing'", [JSON.stringify(receipt), new Date().toISOString(), id]);
        if (result.affectedRows !== 1) throw Error('入库请求状态已失效');
    }
    async function lockIngest(id) {
        const [[row]] = await query('SELECT status FROM hub_ingest_requests WHERE id=? FOR UPDATE', [id]);
        if (row?.status !== 'processing') throw Error('入库请求状态已失效');
    }
    return { read: stores => readSnapshot(() => read(stores ?? context.getStore()?.stores)), write, runMutation, ingestReceipt, lockIngest,
        protectFile, queueFiles, cleanup, storesForSpus, assertSource, sharedSpuCount, importMeta, prepareImport,
        getBatch: id => readSnapshot(() => getBatch(id)), getProduct: id => readSnapshot(() => getProduct(id)),
        transferRows, signature, versions: () => readSnapshot(versions), hasUnmapped,
        page: (scope,url) => readSnapshot(() => page(scope,url)) };
}
