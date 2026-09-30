/**
 * 批次仓库：原始文件落盘，索引与商品名单分开保存。
 * 原始 JSON 始终可回看；商品表只保存核验后的标准字段。
 */
import { access, mkdir, readFile, writeFile, copyFile, rm, stat } from "node:fs/promises";
import { replaceFile } from "./atomic-file.mjs";
import { fileEvidence } from './file-evidence.mjs';
import { readCaptureMetadata, streamCaptureValues } from './capture-stream.mjs';
import { createMysqlInventory } from "./mysql-inventory.mjs";
import { transferHash, assertCapturedSource } from "./transfer-integrity.mjs";
import path from "node:path";
import {skuFingerprint} from "./sku-dedup.mjs";
import { createHash, randomUUID } from "node:crypto";
import { createSingleProductCapture, detectFileKind, getProductCompleteness, hasRealProductDetail, isProductReadyForTransfer, makeBatchId, parseImportedFiles, redactSensitive } from "./parse-capture.mjs";

export function createStore(rootDir, options = {}) {
    const dataDir = path.join(rootDir, "data");
    const filesDir = path.join(dataDir, "files");
    const sql = options.database ? createMysqlInventory(options.database, {
        // 只接受本仓库的单个文件名；持久化队列不能提供路径穿越或目录删除能力。
        removeFile: async name => {
            if (!name || path.basename(name) !== name || name === "." || name === "..") throw new Error("库存清理文件名不合法");
            await rm(path.join(filesDir, name), { force: true });
        }
    }) : null;
    const indexPath = path.join(dataDir, "index.json");
    let mutationQueue = Promise.resolve();
    let initialized = null;
    let viewCache = null;
    // 内部符号不能由HTTP JSON伪造；只有受控worker产物校验后才走已解析导入。
    const preparedImport = Symbol('prepared-import');

    /** 文件模式维持原串行队列；SQL 已按来源店加锁，不能再让无关来源互相排队。 */
    function enqueueMutation(fn) {
        if (sql) return fn();
        const run = mutationQueue.then(fn);
        mutationQueue = run.catch(() => {});
        return run;
    }

    /**
     * 给已有批次的文件补齐新增的文件事实（升级兼容）。
     *
     * 返回值区分"补齐了几个"与"文件已不在"两类，后者必须让调用方看到：
     * 引用为空会被后续授权复核视为缺证据，而不是被当成一条可执行的工作。
     */
    async function backfillFileFacts(batch) {
        let filled = 0;
        const warnings = [];
        for (const file of batch?.files || []) {
            const facts = await readExistingFileFacts(file.storedName);
            if (!facts) {
                // 文件不在：置空引用，明确留下"缺文件"的证据，不编造摘要。
                if (file.sourceRef || file.fileSha256) {
                    file.sourceRef = '';
                    file.fileSha256 = '';
                    file.fileSha256Algorithm = '';
                    file.fileBytes = 0;
                }
                warnings.push(`原始文件缺失，未补齐引用：${file.storedName || '未知'}`);
                continue;
            }
            const needs =
                !file.sourceRef ||
                file.fileSha256 !== facts.fileSha256 ||
                Number(file.fileBytes) !== facts.fileBytes ||
                file.fileSha256Algorithm !== facts.fileSha256Algorithm;
            if (!needs) continue;
            applyFileFacts(file, facts, file.storedName);
            filled += 1;
        }
        return { filled, warnings };
    }

    /**
     * 把**实际落盘事实**合并进文件记录。
     *
     * 三条写文件路径（新上传、丢失补回、部分删除重写）必须共用它：
     * 之前只有新上传那条更新了 sourceRef/fileSha256/fileBytes，
     * 另外两条分别存在"丢弃返回值"和"展开旧字段"的缺陷，
     * 结果旧批次复用与删除后就带着过期引用或旧摘要（第三次复核实测）。
     *
     * 只覆盖与文件字节有关的字段；canonical 摘要等内容语义字段由调用方决定。
     */
    function applyFileFacts(record, onDisk, storedNameForRef) {
        if (!record) return record;
        const name = storedNameForRef || record.storedName || '';
        record.fileBytes = onDisk.fileBytes;
        record.fileSha256 = onDisk.fileSha256;
        record.fileSha256Algorithm = onDisk.fileSha256Algorithm;
        // 相对受控源根的引用：worker 以 WORKER_SOURCE_ROOT(=dataRoot) 解析。
        record.sourceRef = name ? `data/files/${name}` : '';
        return record;
    }

    /**
     * 读回一个**已存在**文件的真实事实（用于旧批次复用与升级兼容）。
     * 文件缺失时返回 null，由调用方决定隔离或报错——不编造摘要。
     */
    async function readExistingFileFacts(storedName) {
        if (!storedName) return null;
        try {
            return await fileEvidence(path.join(filesDir, storedName));
        } catch { return null; }
    }

    /**
     * SQL 原文件写入必须先排除并发清理；文件模式沿用原有内容寻址路径。
     *
     * 返回**实际落盘内容**的指纹与字节数。调用方不能拿"写入前的估算"当文件事实：
     * 文件用两空格缩进写出，而紧凑 JSON 的长度与摘要都与磁盘上的字节不同，
     * 用估算值登记会让后续完整性校验误判损坏。
     */
    async function writeCapturedFile(storedPath, payload) {
        if (sql) await sql.protectFile(path.basename(storedPath));
        await writeFile(storedPath, JSON.stringify(payload, null, 2), "utf8");
        // 回读核验：以磁盘字节为准，而不是以写入前的对象为准。
        const onDisk = await readFile(storedPath);
        // 落盘成功不等于内容一致，回读核验后才能让批次索引引用该资料。
        if (transferHash(JSON.parse(onDisk.toString('utf8'))) !== transferHash(payload)) throw new Error("原始采集文件保存校验失败");
        return {
            // 文件字节摘要（对磁盘内容直接 SHA-256）：与 canonical JSON 摘要是两种语义，必须分开命名。
            fileSha256: createHash('sha256').update(onDisk).digest('hex'),
            fileBytes: onDisk.length,
            fileSha256Algorithm: 'sha256'
        };
    }

    /**
     * 历史红标按“来源店 + SPU”记录，仅用于查询旧失败原因，不再决定当前目标店的发送资格。
     * 货号可能被重建新商品复用，按货号标记会误伤后来的正常商品；SPU 才是这一件商品的稳定标识。
     */
    function blockedProductKey(storeId, spuId) {
        return `${String(storeId || "").trim()}\u0000${String(spuId || "").trim()}`;
    }

    /** 红标表与商品行分开保存：商品行每次读取都由批次重建，标记必须独立持久化才不会被重建清掉。 */
    function readBlockedMap(index) {
        const map = index && index.blockedProducts;
        return map && typeof map === "object" && !Array.isArray(map) ? map : {};
    }

    async function ensure() {
        // 恢复仅在启动时执行一次，不能让普通查询在写入途中触发恢复并覆盖新索引。
        if (!initialized) initialized = initialize().catch(error => { initialized = null; throw error; });
        return initialized;
    }

    /** 初始化与故障恢复共享同一个 Promise，避免首次并发访问重复建立空仓库。 */
    async function initialize() {
        await mkdir(filesDir, { recursive: true });
        if (sql) {
            // 上次进程在提交后退出时，启动继续消费已持久化清理项，不影响资料可用性。
            await sql.cleanup().catch(() => {});
            return;
        }
        try {
            JSON.parse(await readFile(indexPath, "utf8"));
            return;
        } catch (error) {
            const missing = Boolean(error && error.code === "ENOENT");
            // 兼容旧版本替换窗口崩溃留下的临时文件或备份。
            // 只有索引文件不存在才允许初始化空仓库；解析损坏或权限错误必须中止，避免把已有库存静默清成空仓。
            if (await restoreIndexFromFallback()) return;
            if (missing) {
                await writeIndex({ version: 1, batches: [], products: [] });
                return;
            }
            const abort = new Error("仓库索引损坏，已停止启动。请检查 data/index.json，或从 index.json.bak 恢复。");
            abort.status = 500;
            abort.code = "index_corrupt";
            throw abort;
        }
    }

    /** 从 index.json.tmp / .bak 恢复已完整写入的索引；恢复失败时保留当前文件，不覆盖。 */
    async function restoreIndexFromFallback() {
        for (const candidate of [`${indexPath}.tmp`, `${indexPath}.bak`]) {
            try {
                const text = await readFile(candidate, "utf8");
                JSON.parse(text);
                await writeFile(indexPath, text, "utf8");
                return true;
            } catch {}
        }
        return false;
    }

    async function readIndex() {
        await ensure();
        if (sql) return sql.read();
        const info = await stat(indexPath, { bigint: true });
        const key = `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
        // 同一已提交版本只解析、恢复、重建一次；调用方得到独立副本，写操作不会污染共享读取快照。
        if (!viewCache || viewCache.key !== key) {
            const entry = { key, promise: null };
            entry.promise = (async () => {
                const index = JSON.parse(await readFile(indexPath, "utf8"));
                await hydratePublicationData(index);
                refreshBatchReadiness(index);
                rebuildProducts(index);
                return index;
            })().catch(error => { if (viewCache === entry) viewCache = null; throw error; });
            viewCache = entry;
        }
        return structuredClone(await viewCache.promise);
    }

    /** 旧批次按原文件恢复发布资料，只更新读取视图，不改写已领取任务。 */
    async function hydratePublicationData(index) {
        for (const batch of index.batches || []) {
            const needsRecovery = (batch.products || []).some(product => !product.publicationData
                || !(product.productExtCodes || []).length);
            if (!needsRecovery) continue;
            const inputs = [];
            for (const file of batch.files || []) {
                if (!file.storedName || path.basename(file.storedName) !== file.storedName) continue;
                try {
                    const payload = JSON.parse(await readFile(path.join(filesDir, file.storedName), "utf8"));
                    inputs.push({ originalName: file.originalName, payload, bytes: file.bytes });
                } catch {
                    batch.publicationRecoveryError = "原始资料读取失败，发布前需重新导入";
                }
            }
            const recovered = new Map(parseImportedFiles(inputs).products.map(product => [product.spuId, product]));
            for (const product of batch.products || []) {
                const restored = recovered.get(product.spuId);
                if (!restored) continue;
                if (!product.publicationData && restored.publicationData) product.publicationData = restored.publicationData;
                // 旧批次只在索引中保存了 SKU 摘要；重新读取原始响应时补回商品/SKC 货号，无需用户再次导入。
                product.productExtCodes = [...new Set([...(product.productExtCodes || []), ...(restored.productExtCodes || [])])];
                product.skuExtCodes = [...new Set([...(product.skuExtCodes || []), ...(restored.skuExtCodes || [])])];
                // 旧解析器曾把 SKU extCode 回退写成 articleNo，当前解析结果才可信；不能保留这条错误回退值。
                product.articleNo = restored.articleNo || "";
            }
        }
    }

    async function writeIndex(index) {
        if (sql) {
            // SQL 查询不再像文件模式那样读取时重建，红标与解红必须和商品投影一起提交。
            rebuildProducts(index);
            return sql.write(index);
        }
        // 复制备份而非移走主索引：读者始终看到完整旧版或新版，不再出现文件缺失窗口。
        const temp = `${indexPath}.tmp`;
        const backup = `${indexPath}.bak`;
        await writeFile(temp, JSON.stringify(index, null, 2), "utf8");
        try {
            await copyFile(indexPath, backup);
        } catch (error) {
            if (!error || error.code !== "ENOENT") throw error;
        }
        await replaceFile(temp, indexPath);
        viewCache = null;
        // 成功后清除旧索引备份，避免已删除商品仍留在运行目录的备份中。
        await rm(backup, { force: true });
    }

    function rebuildProducts(index) {
        const excluded = new Set((index.excludedSpuIds || []).map((value) => String(value || "")));
        // 商品行按“来源店 + 货号”归并：平台会给同款商品重复分配 SPU（同一个货号在店内出现两个 SPU），
        // 而后台上传只按货号判重，按 SPU 建行会留下两条同货号记录，其中一条上传必然被判为已存在。
        // 货号索引只用于找行，不参与是否有货号的判断，避免把无货号商品误并成一件。
        const rows = new Map();
        const codeIndex = new Map();
        for (const batch of index.batches) {
            // 来源店未映射的暂存批次只能在本批次内归并，否则两家待映射店铺会因同货号被错误合并。
            const storeKey = String(batch.sourceStoreId || "").trim() || `batch\u0000${batch.id}`;
            for (const product of batch.products || []) {
        // 旧索引可能仍带 excludedSpuIds；首次导入会执行物理迁移，此后该兼容分支不再命中。
                if (excluded.has(String(product.spuId || ""))) continue;
                const spuId = String(product.spuId || "");
                const codeKeys = productArticleCodes(product).map((code) => `${storeKey}\u0000${code}`);
                // 命中已有货号就并进那一行；没有货号时退回按 SPU 建行，宁可分行也不猜测同款。
                // SQL 无货号商品也按来源分开，并保留 SPU 前缀，不能与恰好同值的货号键碰撞。
                const rowKey = codeKeys.find((key) => codeIndex.has(key)) || codeKeys[0] || `spu\u0000${sql ? `${storeKey}\u0000` : ""}${spuId}`;
                codeKeys.forEach((key) => codeIndex.set(key, rowKey));
                const row = rows.get(rowKey) || { spuIds: [], publications: [], source: [] };
                rows.set(rowKey, row);
                if (!row.spuIds.includes(spuId)) row.spuIds.push(spuId);
                // 发布资料必须记住它来自哪个 SPU 和哪个批次，定稿时两者要一起选中，见 finalizeProductRow。
                if (product.publicationData) row.publications.push({ spuId, batchId: batch.id, data: product.publicationData });
                row.source.push({ product, batch });
            }
        }
        index.products = [...rows.values()].map(finalizeProductRow);
        // 历史红标只影响展示，在商品行重建后统一贴上，避免旧失败记录被重建覆盖。
        const blocked = readBlockedMap(index);
        const entries = Object.entries(blocked).filter(([, item]) => item && typeof item === "object");
        for (const product of index.products) {
            const matched = entries.filter(([key]) => {
                const [storeId, spuId] = key.split("\u0000");
                return (product.sourceStoreIds || []).includes(storeId) && (product.spuIds || []).includes(spuId);
            });
            if (!matched.length) continue;
            const latest = matched.map(([, item]) => item).sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0];
            product.blocked = true;
            product.blockedReason = String(latest.reason || "上传失败，来源资料需要修正后重新采集").slice(0, 300);
            product.blockedAt = String(latest.at || "");
        }
    }

    /**
     * 商品判重键：只要存在商品/SKC 货号，就只使用商品级货号；完全没有商品货号时才回退到 SKU 货号。
     * articleNo 是页面明确展示的商品货号；productExtCodes 来自列表行或 productSkcList，不能与 SKU 层混成同一集合。
     */
    function productArticleCodes(product) {
        const productCodes = [
            product && product.articleNo,
            ...((product && product.productExtCodes) || [])
        ];
        const values = productCodes.some((value) => String(value || "").trim())
            ? productCodes
            : [
                ...((product && product.skuExtCodes) || []),
                ...((product && product.skus) || []).map((sku) => sku && sku.extCode)
            ];
        return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort();
    }

    /**
     * 把同一件商品（同来源店同货号）的多批采集资料并进一行，字段取并集，缺失值不覆盖已有值。
     * 同一件商品可能先进入样本批次、后进入完整包，汇总时不能让旧样本把新详情和图片覆盖掉。
     * 完整度只从合并后的实际字段推导，不能继承旧批次的布尔标记，否则过去误判的“有图/有标题”
     * 会让当前库存虚假就绪；共享函数也会过滤空图片/空 ID。
     */
    function finalizeProductRow(row) {
        const current = {
            spuId: "",
            spuIds: [],
            goodsId: "",
            title: "",
            category: "",
            articleNo: "",
            productExtCodes: [],
            skuExtCodes: [],
            images: [],
            detail: null,
            skcIds: [],
            skuIds: [],
            skus: [],
            attributes: [],
            sources: [],
            batchIds: [],
            sourceStoreIds: [],
            ready: false,
            completeness: {}
        };
        for (const { product, batch } of row.source) {
            current.goodsId = current.goodsId || product.goodsId || "";
            if (product.title && product.title.length >= current.title.length) current.title = product.title;
            current.category = current.category || product.category || "";
            current.articleNo = current.articleNo || product.articleNo || "";
            current.productExtCodes = [...new Set(current.productExtCodes.concat(product.productExtCodes || []))];
            current.skuExtCodes = [...new Set(current.skuExtCodes.concat(
                product.skuExtCodes || [],
                (product.skus || []).map((sku) => sku && sku.extCode)
            ))];
            if (product.captureEvidence?.primaryDetail === true) current.captureEvidence = { primaryDetail: true, source: "product-query", descriptionState: product.captureEvidence.descriptionState || "unknown" };
            // 同一件商品的详情可能来自多个编辑页接口，按键并集合并，避免后到的图文/合规字段覆盖先到内容。
            if (hasRealProductDetail(product.detail)) {
                current.detail = {
                    ...(current.detail && typeof current.detail === "object" ? current.detail : {}),
                    ...(product.detail && typeof product.detail === "object" ? product.detail : {})
                };
            }
            current.images = [...new Set((current.images || []).concat(product.images || []))];
            current.skcIds = [...new Set(current.skcIds.concat(product.skcIds || []))];
            current.skuIds = [...new Set(current.skuIds.concat(product.skuIds || []))];
            current.skus = mergeStoredSkus(current.skus, product.skus);
            current.skuIds = [...new Set(current.skuIds.concat((current.skus || []).map((item) => item.skuId).filter(Boolean)))];
            if (Array.isArray(product.attributes) && product.attributes.length) {
                const attributeMap = new Map((current.attributes || []).map((item) => [`${item.name}\u0000${item.value}\u0000${item.unit}`, item]));
                product.attributes.forEach((item) => {
                    if (!item || (!item.name && !item.value)) return;
                    attributeMap.set(`${item.name}\u0000${item.value}\u0000${item.unit}`, item);
                });
                current.attributes = [...attributeMap.values()].slice(0, 120);
            }
            current.sources = [...new Set(current.sources.concat(product.sources || []))];
            current.batchIds = [...new Set(current.batchIds.concat(batch.id))];
            // 红标按“来源店 + SPU”判定，行内必须记住自己来自哪些来源店，不能只留下批次 ID。
            if (batch.sourceStoreId) current.sourceStoreIds = [...new Set((current.sourceStoreIds || []).concat(String(batch.sourceStoreId)))];
        }
        // SPU 取“带完整发布资料的那一条”：上传任务按 (来源批次, SPU) 取快照，
        // 两者必须来自同一次采集，错位会取不到商品。没有发布资料时退回第一条 SPU。
        // 优先选带 sourceProduct 的那条：插件按 sourceProduct.productId 取来源资料，
        // 只按批次新旧取会让后来缺少完整来源的快照顶掉可用快照，上传时直接报“缺少来源完整资料”。
        const publication = row.publications.find((entry) => entry.data && entry.data.sourceProduct) || row.publications[0];
        current.spuId = publication ? publication.spuId : (row.spuIds[0] || "");
        current.spuIds = row.spuIds;
        // 保留完整单批次来源，禁止按 SKU 混合不同时刻的配方。
        if (publication) current.publicationData = { ...publication.data, sourceBatchId: publication.batchId };
        current.completeness = getProductCompleteness(current);
        // 与解析批次共用同一门槛，编辑页缺 goodsId/SKC 时不会在库存阶段被二次拦截。
        current.ready = isProductReadyForTransfer(current.completeness);
        return current;
    }

    /**
     * 将旧批次中按 goodsId/SKC 阻断的 ready 标记迁移到当前规则。
     * 批次是任务队列的来源快照，仅刷新其完整度布尔值，不改写原始 records 或文件证据。
     */
    function refreshBatchReadiness(index) {
        let changed = false;
        for (const batch of Array.isArray(index.batches) ? index.batches : []) {
            const products = Array.isArray(batch.products) ? batch.products : [];
            for (const product of products) {
                const completeness = getProductCompleteness(product);
                const ready = isProductReadyForTransfer(completeness);
                if (JSON.stringify(product.completeness || {}) !== JSON.stringify(completeness)
                    || Boolean(product.ready) !== ready) {
                    product.completeness = completeness;
                    product.ready = ready;
                    changed = true;
                }
            }
            // 仅完整采集包才允许批次显示“完整包已齐”。样本/日志即使碰巧字段完整，仍保持原来的证据等级。
            const hasFullPacket = (batch.files || []).some((file) => file && file.kind === "full-packet");
            if (hasFullPacket && products.length) {
                const allReady = products.every((product) => product.ready);
                const status = allReady ? "ready-for-map" : "packet-incomplete";
                const readiness = allReady ? "待映射" : "完整包未齐，不可导入";
                const counts = { ...(batch.counts || {}), ready: products.filter((product) => product.ready).length };
                if (batch.status !== status || batch.readiness !== readiness || Number(batch.counts && batch.counts.ready) !== counts.ready) {
                    batch.status = status;
                    batch.readiness = readiness;
                    batch.counts = counts;
                    changed = true;
                }
            }
        }
        return changed;
    }

    /**
     * 文件模式按索引串行；SQL 按来源店锁定，只重建本次货号/SPU关联的商品集合。
     */
    async function importFiles(uploads, options = {}) {
        if (sql) {
            const prepared = options[preparedImport];
            const parsed = prepared?.parsed || parseImportedFiles(uploads.map(upload => ({ originalName: upload.originalName, payload: redactSensitive(upload.payload) })));
            if (options.ingestMaxProducts && parsed.products.length > options.ingestMaxProducts) throw Object.assign(Error('单个采集包商品过多，请拆分上传'), { status: 413 });
            const owner = String(parsed.sourceStoreId || options.sourceStoreId || "");
            const ids = parsed.products.map(product => String(product.spuId));
            return sql.runMutation(async () => {
                if (options.ingestRequestId) await sql.lockIngest(options.ingestRequestId);
                await sql.assertSource(ids, owner);
                await sql.prepareImport(parsed.products, productArticleCodes, prepared?.fingerprint || makeBatchId(uploads.map(upload => makeStablePayloadHash(redactSensitive(upload.payload)).slice(0, 16)).sort()));
                const result = await importFilesNow(uploads, options);
                if (options.ingestRequestId) {
                    // 传输核验失败则整体回滚；不能把未校验完成的商品提交后再另写成功回执。
                    result.ingestReceipt = await options.confirmIngest(result);
                    await sql.ingestReceipt(options.ingestRequestId, result.ingestReceipt);
                }
                return result;
            }, [owner], ids, options.transactionConnection || null);
        }
        return enqueueMutation(() => importFilesNow(uploads, options));
    }

    /** 账户worker已完成商品解析，父端只核对单件产物及原包字节，再沿用原有库存去重事务。 */
    async function importPreparedCapture(prepared, options = {}) {
        if (prepared.parsed?.products?.length !== 1 || String(prepared.parsed.products[0].spuId) !== String(prepared.spuId)) throw Error('prepared_product_mismatch');
        const facts = await fileEvidence(prepared.sourcePath);
        if (facts.fileSha256 !== prepared.sourceHash || facts.fileBytes !== prepared.expectedBytes) throw Error('prepared_source_mismatch');
        return importFiles([], { ...options, [preparedImport]: { ...prepared,
            fingerprint: makeBatchId([prepared.sourceHash, String(prepared.spuId)]) } });
    }

    /** 原包按完整摘要共享保存；每商品批次仅保存自己的索引，不再复制整个多商品包。 */
    async function savePendingFile(file) {
        if (!file.sourcePath) return writeCapturedFile(file.storedPath, file.payload);
        if (sql) await sql.protectFile(path.basename(file.storedPath));
        const temporary = `${file.storedPath}.${randomUUID()}.tmp`;
        try { await copyFile(file.sourcePath, temporary); await replaceFile(temporary, file.storedPath); }
        finally { await rm(temporary, { force: true }); }
        const facts = await fileEvidence(file.storedPath);
        if (facts.fileSha256 !== file.sourceHash || facts.fileBytes !== file.expectedBytes) throw Error('prepared_copy_mismatch');
        return facts;
    }

    async function importFilesNow(uploads, options = {}) {
        await ensure();
        const parsedFiles = [];
        const savedFiles = [];
        const pendingFiles = [];
        // 按 storedName 找回文件记录：落盘后要用**实际字节事实**覆盖写入前的估算值。
        const fileRecordsById = new Map();
        const prepared = options[preparedImport];
        if (prepared) {
            const record = { id: prepared.sourceHash.slice(0, 16), originalName: 'capture.json', storedName: `${prepared.sourceHash}-capture.json`,
                kind: 'full-packet', bytes: prepared.expectedBytes, contentSha256: '', exportedAt: null, purpose: '' };
            savedFiles.push(record);
            fileRecordsById.set(record.storedName, record);
            pendingFiles.push({ storedPath: path.join(filesDir, record.storedName), sourcePath: prepared.sourcePath,
                sourceHash: prepared.sourceHash, expectedBytes: prepared.expectedBytes });
        }

        for (const upload of uploads) {
            const payload = redactSensitive(upload.payload);
            const bytes = Buffer.byteLength(JSON.stringify(payload));
            const hash = makeStablePayloadHash(payload);
            const kind = detectFileKind(upload.originalName, payload);
            const storedName = `${transferHash(payload).slice(0, 16)}-${sanitizeName(upload.originalName)}`;
            const storedPath = path.join(filesDir, storedName);
            const fileRecord = {
                id: hash.slice(0, 16),
                originalName: upload.originalName,
                storedName,
                kind,
                bytes,
                contentSha256: transferHash(payload),
                exportedAt: payload.exportedAt || null,
                purpose: payload.purpose || ""
            };
            parsedFiles.push({ originalName: upload.originalName, payload, bytes });
            savedFiles.push(fileRecord);
            fileRecordsById.set(fileRecord.storedName, fileRecord);
            pendingFiles.push({ storedPath, payload });
        }

        const parsed = prepared?.parsed || parseImportedFiles(parsedFiles);
        const index = await readIndex();
        // 旧版本把删除商品记录在 excludedSpuIds 中并保留批次正文。新语义要求彻底删除，
        // 因此任意后续导入前先清掉历史排除记录，避免同 SPU 再上传时仍被旧身份拦截。
        if (index.excludedSpuIds && index.excludedSpuIds.length) {
            const legacyPurge = await purgeProductsFromIndex(index, index.excludedSpuIds);
            if (legacyPurge.changed) {
                refreshBatchReadiness(index);
                await writeIndex(index);
                await removeUnreferencedFiles(index, legacyPurge.cleanupFiles);
            }
        }
        /**
         * 重复内容复用历史批次时，仅补回该批次缺失的原始文件，不创建新批次。
         * 这样插件重试或用户改名重新导出都能修复下载证据，同时继续保持库存去重。
         */
        async function restoreMissingFiles(batch) {
            const pendingById = new Map(savedFiles.map((file, fileIndex) => [file.id, pendingFiles[fileIndex]]));
            let restoredFiles = 0;
            for (const fileRecord of batch.files || []) {
                const storedPath = path.join(filesDir, fileRecord.storedName);
                try {
                    await access(storedPath);
                } catch (error) {
                    if (!error || error.code !== "ENOENT") throw error;
                    const pending = pendingById.get(fileRecord.id);
                    if (!pending) continue;
                    const onDisk = await savePendingFile({ ...pending, storedPath });
                    // 缺失文件由同内容的重传补回时，采集时间可能变化，更新实际落盘的校验值。
                    fileRecord.contentSha256 = pending.sourcePath ? '' : transferHash(pending.payload);
                    // 新增的文件事实也必须同步：只更新 canonical 摘要会让
                    // fileSha256/fileBytes 停留在旧值，后续完整性校验误报损坏（第三次复核）。
                    applyFileFacts(fileRecord, onDisk, fileRecord.storedName);
                    restoredFiles += 1;
                }
            }
            return restoredFiles;
        }
        // 普通上传必须带真实来源店；插件采集在映射尚未返回时可凭实例/页面上下文暂存，
        // 但暂存包不参与跨店去重，待 attachSourceStore 回填后再进入正常合并链路。
        const owner=String(parsed.sourceStoreId||options.sourceStoreId||"");
        const pendingIdentity = options.source === "extension-ingest"
            && Boolean(parsed.pluginInstanceId || options.pluginInstanceId || parsed.pageStoreName || options.pageStoreName);
        if(parsed.products.length && !owner && !pendingIdentity)throw Object.assign(new Error("缺少来源店铺ID，请先连接本机连接器并重新导出完整包"),{status:409});
        const kept=[];let reusedBatch=null;
        for(const product of parsed.products) {
            const old=index.batches.filter(b=>b.products?.some(p=>p.spuId===product.spuId));
            if(old.some(b=>b.sourceStoreId&&b.sourceStoreId!==owner))throw Object.assign(new Error("SPU来源店冲突，已拒收以避免混店"),{status:409});
            // 来源店未映射时不做去重，避免两个待映射店铺因相同 SKU 被错误合并。
            const hash=owner ? skuFingerprint(product,owner) : "";
            // 业务去重会忽略时间字段，但来源原对象一旦变化就必须保留新采集，不能用旧资料冒充本次传输。
            const duplicate=hash&&old.find(b=>b.products.some(p=>skuFingerprint(p,b.sourceStoreId)===hash
                && transferHash(p.publicationData || null) === transferHash(product.publicationData || null)));
            if(duplicate)reusedBatch=duplicate;else kept.push(product);
        }
        // 整包复用必须由同一批次覆盖本次全部商品，不能只返回最后一件命中的批次。
        if(parsed.products.length&&!kept.length&&reusedBatch && parsed.products.every(product => reusedBatch.products.some(old => old.spuId === product.spuId
            && transferHash(old.publicationData || null) === transferHash(product.publicationData || null)))) {
            const restoredFiles = await restoreMissingFiles(reusedBatch);
            // 这条提前返回同样要给旧批次补齐文件事实：它是"整包复用"的主路径，
            // 漏掉它会出现"补了另一条复用路径、这条仍带空引用"的半修状态。
            const backfilled = await backfillFileFacts(reusedBatch);
            if (restoredFiles || backfilled.filled) await writeIndex(index);
            return {batch:reusedBatch,reused:true,warnings:["相同店铺SKU内容已存在，本次未新增文件或商品", ...backfilled.warnings],
                restoredFiles, backfilledFiles: backfilled.filled};
        }
        // 混合包保留完整单次证据和统计，库存归并不产生重复行；不删半个响应导致发布快照失真。
        const fingerprint = prepared?.fingerprint || makeBatchId(savedFiles.map((item) => item.id).sort());
        const existing = index.batches.find((batch) => batch.fingerprint === fingerprint);
        if (existing) {
            // 相同原文件可升级解析结果，但保留批次 ID 和来源，避免重新上传仍卡在旧解析规则。
            const sameProducts = (existing.products || []).map(item => String(item.spuId)).sort().join(",") === parsed.products.map(item => String(item.spuId)).sort().join(",");
            if (sameProducts) {
                existing.products = parsed.products;
                existing.counts = parsed.counts;
                existing.status = parsed.status;
                existing.readiness = parsed.readiness;
                existing.warnings = parsed.warnings;
                rebuildProducts(index);
                await writeIndex(index);
            }
            // 重复批次仍要补写缺失的原始文件；不能因为 fingerprint 命中就让下载链接空转。
            // 这里只按已有批次的 storedName 落盘，不改变批次已经持久化的商品范围。
            const restoredFiles = await restoreMissingFiles(existing);
            /**
             * **升级兼容：给旧批次的文件补齐新增的文件事实。**
             *
             * 上一版建出的批次没有 sourceRef/fileSha256/fileBytes。复用时如果不补，
             * 服务端登记账户工作只能读到空值/0，等于登记了一条缺证据却可执行的工作。
             * 文件还在磁盘时直接回读补齐；文件确实不在时明确隔离（置空引用并记警告），
             * **不**编造摘要。
             */
            const backfilled = await backfillFileFacts(existing);
            if (restoredFiles || backfilled.filled) await writeIndex(index);
            return { batch: existing, reused: true, warnings: [...parsed.warnings, ...backfilled.warnings],
                restoredFiles, backfilledFiles: backfilled.filled };
        }

        // 先完成重复批次判断再落原始文件，重复直推不会在 files 目录留下无人引用的孤立文件。
        for (const file of pendingFiles.sort((a, b) => a.storedPath.localeCompare(b.storedPath))) {
            const onDisk = await savePendingFile(file);
            /**
             * 用**实际落盘事实**覆盖写入前的估算。
             *
             * 之前 `bytes` 与 `contentSha256` 都取自紧凑 JSON，而文件是两空格缩进写的：
             * 合成包实测登记 516 字节、文件实际 913 字节，摘要也对不上。
             * 把估算值当文件事实，会让后续按字节/摘要做的完整性校验误报损坏。
             */
            // pendingFiles 的项是 {storedPath, payload}，没有 storedName；
            // 用 basename 反查记录，否则这里永远取不到记录、落盘事实也就写不进去。
            const record = fileRecordsById.get(path.basename(file.storedPath));
            applyFileFacts(record, onDisk, record?.storedName);
        }

        const batch = {
            id: randomUUID().slice(0, 8),
            fingerprint,
            createdAt: new Date().toISOString(),
            label: options.label || parsed.shopName || "未命名批次",
            shopName: parsed.shopName || options.shopName || "",
            sourceStoreId: parsed.sourceStoreId || options.sourceStoreId || "",
            sourceStoreName: parsed.sourceStoreName || options.sourceStoreName || parsed.shopName || options.shopName || "",
            pluginInstanceId: parsed.pluginInstanceId || options.pluginInstanceId || "",
            pageStoreName: parsed.pageStoreName || options.pageStoreName || "",
            pageUrl: parsed.pageUrl,
            status: parsed.status,
            readiness: parsed.readiness,
            coverage: parsed.coverage,
            completedCount: parsed.completedCount,
            expectedCount: parsed.expectedCount,
            logSaved: parsed.logSaved,
            logFailed: parsed.logFailed,
            productFailures: parsed.productFailures,
            datasetSummary: parsed.datasetSummary,
            structureCounts: parsed.structureCounts,
            warnings: parsed.warnings,
            counts: parsed.counts,
            files: savedFiles,
            products: parsed.products,
            seed: Boolean(options.seed),
            source: options.source || (options.seed ? "seed" : "upload")
        };
        index.batches.unshift(batch);
        // 重新采集并入库即视为“这件商品已按新资料覆盖”，解除红标；清除条件必须是重新采集，手工删除库存不解除。
        const incomingStoreId = batch.sourceStoreId || options.sourceStoreId || "";
        const incomingSpuIds = parsed.products.map((product) => String(product.spuId || "")).filter(Boolean);
        if (incomingStoreId && incomingSpuIds.length) {
            const blocked = readBlockedMap(index);
            let cleared = 0;
            for (const spuId of incomingSpuIds) {
                const key = blockedProductKey(incomingStoreId, spuId);
                if (!blocked[key]) continue;
                delete blocked[key];
                cleared += 1;
            }
            if (cleared) index.blockedProducts = blocked;
        }
        rebuildProducts(index);
        await writeIndex(index);
        return { batch, reused: false, warnings: parsed.warnings };
    }

    /**
     * 保存来源商品的历史失败提示；发送资格由目标任务决定，不再根据该提示禁传。
     * 只接受来源店 + SPU：服务器不判断商品内容缺什么，只记录“这件上传没过”这个事实；
     * 重复命中（目标店已存在同款）不算内容缺失，由调用方过滤，不能标红。
     */
    async function markProductBlocked({ storeId, spuId, reason } = {}) {
        const key = blockedProductKey(storeId, spuId);
        const [store, spu] = key.split("\u0000");
        if (!store || !spu) {
            const error = new Error("标记失败商品需要来源店和 SPU");
            error.status = 400;
            throw error;
        }
        return enqueueMutation(async () => {
            await ensure();
            const index = sql ? await readIndex() : JSON.parse(await readFile(indexPath, "utf8"));
            const blocked = readBlockedMap(index);
            const previous = blocked[key];
            blocked[key] = {
                storeId: store,
                spuId: spu,
                reason: String(reason || "").slice(0, 300),
                at: new Date().toISOString(),
                // 同一件商品被标记的次数用于排查反复失败，不参与是否标红的判断。
                count: Number(previous && previous.count ? previous.count : 0) + 1
            };
            index.blockedProducts = blocked;
            await writeIndex(index);
            return { blocked: true, key, ...blocked[key] };
        });
    }

    /**
     * 重新采集覆盖后解除红标：只按来源店 + SPU 解除，不影响同店其他商品。
     * 解除条件是“这份商品被重新采集入库”，因此由导入路径按 SPU 精确调用。
     */
    async function clearProductBlocked(storeId, spuIds) {
        const store = String(storeId || "").trim();
        const ids = [...new Set((Array.isArray(spuIds) ? spuIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
        if (!store || !ids.length) return { cleared: 0 };
        return enqueueMutation(async () => {
            await ensure();
            const index = sql ? await readIndex() : JSON.parse(await readFile(indexPath, "utf8"));
            const blocked = readBlockedMap(index);
            let cleared = 0;
            for (const spuId of ids) {
                const key = blockedProductKey(store, spuId);
                if (!blocked[key]) continue;
                delete blocked[key];
                cleared += 1;
            }
            if (!cleared) return { cleared: 0 };
            index.blockedProducts = blocked;
            await writeIndex(index);
            return { cleared };
        });
    }

    /**
     * 网页人工解除红标：按 SPU 反查它所属的来源店后清除标记。
     * 与 clearProductBlocked 的区别是调用方只有 SPU（商品库一行可能来自多个来源店），
     * 因此这里按行内记录的来源店逐个解除，避免漏掉或误清其他店的同名 SPU。
     *
     * scope 是调用方给的可见店铺集合：只解除落在这些店里的标记。
     * 少了这道校验，任何登录用户都能拿一串 SPU 解除别人店铺的红标，
     * 绕过"标红禁止再次上传"的保护把问题商品推进去。
     */
    async function unblockProducts(spuIds, scope = null) {
        const ids = [...new Set((Array.isArray(spuIds) ? spuIds : []).map((value) => String(value || "").trim()).filter(Boolean))];
        if (!ids.length) {
            const error = new Error("需要选择 1 个以上商品");
            error.status = 400;
            throw error;
        }
        return enqueueMutation(async () => {
            await ensure();
            const index = sql ? await readIndex() : JSON.parse(await readFile(indexPath, "utf8"));
            const blocked = readBlockedMap(index);
            // 先按当前商品表反查每个 SPU 的来源店；索引里找不到时退回扫描红标表自身的 storeId。
            const storeIdsBySpu = new Map();
            for (const product of index.products || []) {
                for (const spuId of [product.spuId, ...(product.spuIds || [])]) {
                    const key = String(spuId || "").trim();
                    if (!key) continue;
                    const current = storeIdsBySpu.get(key) || new Set();
                    (product.sourceStoreIds || []).forEach((storeId) => current.add(String(storeId)));
                    storeIdsBySpu.set(key, current);
                }
            }
            let cleared = 0;
            const missing = [];
            // 只允许操作落在可见范围内的店铺标记；范围外的一律当作"找不到"，不泄露它是否存在。
            const inScope = (storeId) => !scope || scope.has(String(storeId));
            for (const spuId of ids) {
                const storeIds = storeIdsBySpu.get(spuId);
                let hit = false;
                if (storeIds && storeIds.size) {
                    for (const storeId of storeIds) {
                        if (!inScope(storeId)) continue;
                        const key = blockedProductKey(storeId, spuId);
                        if (!blocked[key]) continue;
                        delete blocked[key];
                        cleared += 1;
                        hit = true;
                    }
                }
                if (!hit) {
                    // 商品表里查不到来源店时退回按红标表匹配，保证标记能被解除而不是卡住。
                    for (const key of Object.keys(blocked)) {
                        const [storeId, blockedSpu] = key.split("\u0000");
                        if (blockedSpu !== spuId) continue;
                        if (!inScope(storeId)) continue;
                        delete blocked[key];
                        cleared += 1;
                        hit = true;
                    }
                }
                if (!hit) missing.push(spuId);
            }
            if (!cleared) return { cleared: 0, missing };
            index.blockedProducts = blocked;
            await writeIndex(index);
            return { cleared, missing };
        });
    }

    async function listOverview() {
        const index = await readIndex();
        const products = Array.isArray(index.products) ? index.products : [];
        return {
            batchCount: index.batches.length,
            productCount: products.length,
            // readyCount 只表示当前库存资料完整，不等于已经能导入目标店铺。
            readyCount: products.filter((item) => item.ready).length,
            // 缺详情/缺图片按当前库存商品计，一张商品可同时计入两项。
            missingDetailCount: products.filter((item) => !item.completeness?.hasDetail && !item.completeness?.hasPrimaryDetail).length,
            sourceEmptyDetailCount: products.filter(item => item.completeness?.detailState === "source-empty").length,
            missingImageCount: products.filter((item) => !(item.completeness && item.completeness.hasImages)).length,
            incompleteCount: products.filter((item) => !item.ready).length,
            fileCount: index.batches.reduce((sum, batch) => sum + (batch.files || []).length, 0),
            // 保留该字段兼容旧客户端；新删除语义会物理清理记录，因此正常状态下始终为 0。
            excludedCount: (index.excludedSpuIds || []).length,
            // 已判定上传失败、禁止再传的商品数；解除条件是重新采集覆盖。
            blockedCount: products.filter((item) => item.blocked).length,
            batches: index.batches.map(summarizeBatch),
            products
        };
    }

    /**
     * 网页自动刷新只需要知道“库存有没有变”，不能每次都走 listOverview：
     * 那条路径要解析整个索引并重建商品视图，两秒级轮询会把磁盘和 CPU 吃满。
     * 这里只取索引文件的修改时间和大小；任何入库、删除和来源回填都会重写索引文件。
     */
    async function indexSignature() {
        if (sql) return sql.signature();
        const info = await stat(indexPath).catch(() => null);
        return info ? `${Math.round(info.mtimeMs)}:${info.size}` : "missing";
    }

    async function getBatch(id) {
        if (sql) return sql.getBatch(id);
        const index = await readIndex();
        return index.batches.find((batch) => batch.id === id) || null;
    }

    async function getProduct(spuId) {
        if (sql) return sql.getProduct(spuId);
        const index = await readIndex();
        // 合并行只对外暴露一个 SPU，另一个同货号 SPU 仍要能打开详情，否则旧链接会变成“没有这件商品”。
        const product = index.products.find((item) => item.spuId === String(spuId) || (item.spuIds || []).includes(String(spuId)));
        if (!product) return null;
        const related = index.batches.filter((batch) => (batch.products || []).some((item) => (product.spuIds || [product.spuId]).includes(String(item.spuId || ""))));
        return { product, batches: related.map(summarizeBatch) };
    }

    /**
     * 彻底删除指定商品：从当前库存和全部历史批次中移除，并清理原始文件里的商品正文。
     * 删除后同 SPU 再次上传会形成全新批次，避免旧身份、旧指纹或排除表继续阻断新内容。
     */
    /**
     * 删除商品。
     *
     * scope 是调用方的权限范围（能碰哪些店）；options.storeIds 是本次删除的作用范围（只删哪些店的）。
     * 两者必须分开：管理站在某个店铺分组里删除时，权限上能碰所有店，但这次只应删这一组的行——
     * 商品库按"来源店 + 货号"归并行记录，同一个 SPU 在别的店可能另有一行，
     * 不限定范围就会把别的店那份一起删掉（跨店误删）。
     * 未指定 storeIds 时退回用 scope 作为删除范围，普通用户"只删自己的"仍成立。
     */
    async function deleteProducts(spuIds, scope = null, options = {}) {
        return enqueueMutation(() => deleteProductsNow(spuIds, scope, options));
    }

    async function deleteProductsNow(spuIds, scope = null, options = {}) {
        const values = (Array.isArray(spuIds) ? spuIds : []).map((value) => String(value || "").trim());
        const invalidIds = values.filter((value) => !/^\d{4,20}$/.test(value));
        const ids = new Set(values.filter((value) => /^\d{4,20}$/.test(value)));
        if (invalidIds.length) {
            const error = new Error("SPU 必须是 4 至 20 位数字");
            error.status = 400;
            throw error;
        }
        if (!ids.size || ids.size > 5000) {
            const error = new Error("需要选择 1 至 5000 个商品");
            error.status = 400;
            throw error;
        }
        const index = await readIndex();
        /**
         * 删除是破坏性操作，必须先确认整批商品都落在调用方可见的店铺里。
         * 只校验"是否登录"不够：任何用户都能拿一串 SPU 删掉别人店铺的商品。
         * 这里采取整批拒绝而不是静默跳过——静默跳过会让运营以为删掉了，实际还在。
         */
        if (scope) {
            const ownerStores = new Map();
            for (const product of index.products || []) {
                for (const spuId of [product.spuId, ...(product.spuIds || [])]) {
                    const key = String(spuId || "").trim();
                    if (!key) continue;
                    const current = ownerStores.get(key) || new Set();
                    (product.sourceStoreIds || []).forEach((storeId) => current.add(String(storeId)));
                    ownerStores.set(key, current);
                }
            }
            const outside = [...ids].filter((spuId) => {
                const stores = ownerStores.get(spuId);
                // 无来源店记录的商品（历史孤儿数据）只允许管理员删除，普通用户不得触碰。
                if (!stores || !stores.size) return true;
                return ![...stores].some((storeId) => scope.has(storeId));
            });
            if (outside.length) {
                const error = new Error(`以下商品不属于你的店铺，不能删除：${outside.slice(0, 10).join("、")}${outside.length > 10 ? ` 等 ${outside.length} 件` : ""}`);
                error.status = 403;
                throw error;
            }
        }
        /**
         * 计算本次删除的店铺作用范围：
         * 显式传了 storeIds 就用它（再与权限范围求交，越权部分忽略）；
         * 没传则用权限范围，保持"普通用户删除自己店铺商品"的既有一致行为。
         *
         * 注意空数组的语义：storeIds: [] 表示"只删没有来源店的商品"（管理站的「无归属店铺」分组），
         * 而不是"不限定范围"。因此这里必须区分"传了空数组"与"没传"两种情况——
         * JS 里空数组是 truthy，只看 truthy 会把空数组误当"没传"。
         */
        const hasExplicitStores = Array.isArray(options.storeIds);
        const requestedStores = hasExplicitStores ? options.storeIds.map((value) => String(value || "").trim()).filter(Boolean) : [];
        let storeScope = null;
        if (hasExplicitStores) {
            if (!requestedStores.length) {
                // 空数组：只碰没有来源店的批次（批次里 sourceStoreId 为空的那些）。
                storeScope = new Set([""]);
            } else {
                storeScope = new Set(requestedStores.filter((storeId) => !scope || scope.has(storeId)));
                if (!storeScope.size) {
                    const error = new Error("所选商品不属于任何可删除的店铺");
                    error.status = 403;
                    throw error;
                }
            }
        } else if (scope) {
            storeScope = scope;
        }
        // 商品库按“来源店 + 货号”归并成一行，删除一行必须清除该店该货号下的全部 SPU；
        // 否则另一个同货号历史 SPU 仍会参与判重或重新出现。展开限定在 storeScope 内，不波及别的店。
        const existingIds = new Set((index.products || []).flatMap((product) => [product.spuId, ...(product.spuIds || [])]).map((value) => String(value || "")));
        const expandedIds = expandProductDeletionIds(index, ids, storeScope);
        const deletedIds = [...expandedIds].filter((id) => existingIds.has(id));
        const missingIds = [...ids].filter((id) => !existingIds.has(id));
        if (!deletedIds.length) {
            const error = new Error(missingIds.length === 1 ? `库存中没有 SPU ${missingIds[0]}` : "所选商品都不在当前库存中");
            error.status = 404;
            throw error;
        }
        // 历史版本遗留的排除记录也必须一起物理清理，不能只让本次选中的商品消失。
        const purgeIds = [...new Set([...(index.excludedSpuIds || []).map(String), ...deletedIds])];
        const purged = await purgeProductsFromIndex(index, purgeIds, storeScope);
        refreshBatchReadiness(index);
        await writeIndex(index);
        await removeUnreferencedFiles(index, purged.cleanupFiles);
        return {
            deletedCount: deletedIds.length,
            requestedCount: ids.size,
            deletedIds,
            missingIds,
            deletedFileCount: purged.deletedFileCount,
            deletedBatchCount: purged.deletedBatchCount,
            productCount: index.products.length
        };
    }

    /**
     * 统计删除某个店铺会波及多少数据，供确认弹窗展示影响范围。
     * 删除不可逆，必须在动手前把"会删掉什么"摆给管理员看，而不是删完才发现丢了多少。
     *
     * 商品数从 batches 现算，不读 index.products：
     * 后者是派生视图，磁盘上那份可能还是上次写入时的旧内容（listOverview 会另行重建），
     * 直接读会把"有商品"的店报成 0，让管理员以为删除没有影响。
     */
    async function storeDataImpact(storeId) {
        const id = String(storeId || "").trim();
        if (!id) return { storeId: "", productCount: 0, batchCount: 0, fileCount: 0, blockedCount: 0, sharedProductCount: 0 };
        await ensure();
        const index = sql ? await sql.read([id]) : JSON.parse(await readFile(indexPath, "utf8"));
        const batches = (index.batches || []).filter((batch) => String(batch.sourceStoreId || "") === id);
        const ownedSpus = new Set();
        for (const batch of batches) {
            for (const product of batch.products || []) {
                const spu = String(product.spuId || "").trim();
                if (spu) ownedSpus.add(spu);
            }
        }
        /**
         * 同时来自其他店的 SPU 不会随删除消失（其他店的批次仍在）。
         * 分开统计，让弹窗能说明"其中 N 件还来自其他店铺、会保留"，
         * 避免管理员按总数期待、结果发现商品还在而以为删除失败。
         */
        const otherSpus = new Set();
        for (const batch of index.batches || []) {
            if (String(batch.sourceStoreId || "") === id) continue;
            for (const product of batch.products || []) {
                const spu = String(product.spuId || "").trim();
                if (spu && ownedSpus.has(spu)) otherSpus.add(spu);
            }
        }
        const blocked = readBlockedMap(index);
        return {
            storeId: id,
            productCount: ownedSpus.size,
            sharedProductCount: sql ? await sql.sharedSpuCount(id) : otherSpus.size,
            batchCount: batches.length,
            fileCount: batches.reduce((sum, batch) => sum + (batch.files || []).length, 0),
            blockedCount: Object.keys(blocked).filter((key) => key.split("\u0000")[0] === id).length
        };
    }

    /**
     * 删除一个来源店铺的数据。
     *
     * keepProducts=true：保留商品（只清理红标），用于"先删店铺、数据以后再处理"。
     *   商品仍在库中，但来源店已不存在，普通用户按归属过滤看不到，只有管理员可见。
     * keepProducts=false：连同该店采集的批次、商品与原始文件一起物理删除。
     *
     * 两种模式都清掉该店的标红记录：标红按"来源店 + SPU"记录，店铺没了之后这条标记
     * 既不会被解除、也不会再影响任何上传，留着只会变成永远清不掉的垃圾。
     */
    async function deleteStoreData(storeId, { keepProducts = true } = {}) {
        const id = String(storeId || "").trim();
        if (!id) throw Object.assign(new Error("缺少店铺标识"), { status: 400 });
        return enqueueMutation(async () => {
            await ensure();
            const index = sql ? await readIndex() : JSON.parse(await readFile(indexPath, "utf8"));
            const blocked = readBlockedMap(index);
            const blockedKeys = Object.keys(blocked).filter((key) => key.split("\u0000")[0] === id);
            for (const key of blockedKeys) delete blocked[key];
            if (blockedKeys.length) index.blockedProducts = blocked;

            if (keepProducts) {
                // 只清红标；商品与批次原样保留。
                if (blockedKeys.length) await writeIndex(index);
                return { storeId: id, mode: "keep", deletedProductCount: 0, deletedBatchCount: 0, deletedFileCount: 0, clearedBlockedCount: blockedKeys.length };
            }

            /**
             * 彻底删除：摘掉该店的全部批次，再重建派生商品表。
             * 批次各自只属于一个来源店，因此这里不需要做"同货号是否来自别的店"的判断——
             * 如果同一个 SPU 也从别的店采集过，那个批次会留下，重建后商品行依旧存在，
             * 只是来源店少了一个。这正是我们要的语义：只清掉这个店的来源记录。
             */
            const cleanupFiles = new Set();
            let deletedProductCount = 0;
            let deletedBatchCount = 0;
            const nextBatches = [];
            for (const batch of index.batches || []) {
                if (String(batch.sourceStoreId || "") !== id) {
                    nextBatches.push(batch);
                    continue;
                }
                deletedProductCount += (batch.products || []).length;
                for (const file of batch.files || []) cleanupFiles.add(String(file.storedName || ""));
                deletedBatchCount += 1;
            }
            index.batches = nextBatches;
            delete index.excludedSpuIds;
            rebuildProducts(index);
            await writeIndex(index);
            await removeUnreferencedFiles(index, [...cleanupFiles]);
            return {
                storeId: id,
                mode: "purge",
                deletedProductCount,
                deletedBatchCount,
                deletedFileCount: cleanupFiles.size,
                clearedBlockedCount: blockedKeys.length
            };
        });
    }

    /**
     * 展开同一来源店内共享货号的全部 SPU。
     * 只沿已存在的历史关系扩展，不按单值货号猜测，也不会把未来重新创建的 SPU 带入本次删除。
     */
    /**
     * 展开同一来源店内共享货号的全部 SPU。
     *
     * storeScope 限定只在这些来源店范围内展开。这一点很关键：
     * 同一个 SPU 在不同店可能各有一行（商品库按"来源店 + 货号"归并），
     * 若不限范围，从 A 店分组删除会连带把 B 店的同名 SPU 一起清掉——
     * 那是另一个店仍在使用的数据，属于跨店误删。
     */
    function expandProductDeletionIds(index, requestedIds, storeScope = null) {
        const inScope = (storeId) => !storeScope || storeScope.has(String(storeId || "").trim());
        const groupMembers = new Map();
        const groupsOfSpu = new Map();
        for (const batch of index.batches || []) {
            if (!inScope(batch.sourceStoreId)) continue;
            const storeKey = String(batch.sourceStoreId || "").trim() || `batch\u0000${batch.id}`;
            for (const product of batch.products || []) {
                const spuId = String(product.spuId || "");
                for (const code of productArticleCodes(product)) {
                    const key = `${storeKey}\u0000${code}`;
                    if (!groupMembers.has(key)) groupMembers.set(key, new Set());
                    groupMembers.get(key).add(spuId);
                    if (!groupsOfSpu.has(spuId)) groupsOfSpu.set(spuId, []);
                    groupsOfSpu.get(spuId).push(key);
                }
            }
        }
        // 同货号关系可能连成 A-B-C，必须一路展开到没有新增 SPU 为止。
        const expandedIds = new Set();
        const pendingIds = [...requestedIds];
        while (pendingIds.length) {
            const spuId = pendingIds.pop();
            if (expandedIds.has(spuId)) continue;
            expandedIds.add(spuId);
            for (const key of groupsOfSpu.get(spuId) || []) {
                for (const member of groupMembers.get(key) || []) if (!expandedIds.has(member)) pendingIds.push(member);
            }
        }
        return expandedIds;
    }

    /**
     * 从索引和原始 JSON 中物理移除商品，不写删除墓碑。
     * 返回的 cleanupFiles 只有在索引成功落盘后才能删除，避免写入失败时仓库引用丢失。
     */
    /**
     * 从索引里物理删除指定商品。
     * storeScope 限定只清理这些来源店的批次；跨店同名 SPU 不在范围内时保持原样。
     */
    async function purgeProductsFromIndex(index, productIds, storeScope = null) {
        const requestedIds = new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean));
        if (!requestedIds.size) return { changed: false, cleanupFiles: [], deletedFileCount: 0, deletedBatchCount: 0 };
        const expandedIds = expandProductDeletionIds(index, requestedIds, storeScope);
        const cleanupFiles = new Set();
        let deletedBatchCount = 0;
        const nextBatches = [];

        for (const batch of index.batches || []) {
            const batchProducts = Array.isArray(batch.products) ? batch.products : [];
            // 范围外的批次完全不碰：它属于其他店铺，删除不应波及。
            const inScope = !storeScope || storeScope.has(String(batch.sourceStoreId || "").trim());
            const hasDeletedProduct = inScope && batchProducts.some((product) => expandedIds.has(String(product.spuId || "")));
            if (!hasDeletedProduct) {
                nextBatches.push(batch);
                continue;
            }

            const nextFiles = [];
            for (const file of batch.files || []) {
                const oldName = String(file.storedName || "");
                if (!oldName || path.basename(oldName) !== oldName) {
                    cleanupFiles.add(oldName);
                    continue;
                }
                let payload;
                try {
                    payload = JSON.parse(await readFile(path.join(filesDir, oldName), "utf8"));
                } catch {
                    // 无法解析的文件无法证明已不含被删商品，按彻底删除原则移除。
                    cleanupFiles.add(oldName);
                    continue;
                }
                const scrubbed = scrubDeletedProductIds(payload, expandedIds);
                const beforeText = JSON.stringify(payload);
                const afterText = JSON.stringify(scrubbed);
                if (beforeText === afterText) {
                    nextFiles.push(file);
                    continue;
                }
                const nextPayload = scrubbed && typeof scrubbed === "object" ? scrubbed : {};
                const hash = makeStablePayloadHash(nextPayload);
                const storedName = `${transferHash(nextPayload).slice(0, 16)}-${sanitizeName(file.originalName || "capture.json")}`;
                const onDisk = await writeCapturedFile(path.join(filesDir, storedName), nextPayload);
                cleanupFiles.add(oldName);
                /**
                 * 重写后的记录必须**整体来自新落盘事实**。
                 * 之前用 `...file` 展开旧记录再只改 storedName/canonical 摘要，
                 * sourceRef 与 fileSha256/fileBytes 仍是旧包的——剩余商品会引用
                 * 一个内容已经不再对应本批次的文件（第三次复核实测）。
                 */
                const nextRecord = {
                    ...file,
                    id: hash.slice(0, 16),
                    storedName,
                    kind: detectFileKind(file.originalName, nextPayload),
                    bytes: Buffer.byteLength(JSON.stringify(nextPayload)),
                    contentSha256: transferHash(nextPayload),
                    exportedAt: nextPayload.exportedAt || null,
                    purpose: nextPayload.purpose || ""
                };
                applyFileFacts(nextRecord, onDisk, storedName);
                nextFiles.push(nextRecord);
            }

            const remainingProducts = batchProducts.filter((product) => !expandedIds.has(String(product.spuId || "")));
            if (!remainingProducts.length) {
                for (const file of nextFiles) cleanupFiles.add(String(file.storedName || ""));
                deletedBatchCount += 1;
                continue;
            }
            batch.products = remainingProducts;
            batch.files = nextFiles;
            const counts = { ...(batch.counts || {}) };
            if (Number.isFinite(Number(counts.spu))) counts.spu = remainingProducts.length;
            if (Number.isFinite(Number(counts.products))) counts.products = remainingProducts.length;
            batch.counts = counts;
            // 原文件指纹已失效，重写为剩余文件指纹；同 SPU 再次上传不会被旧批次复用。
            batch.fingerprint = nextFiles.length
                ? makeBatchId(nextFiles.map((file) => file.id).sort())
                : makeBatchId(["purged-products", batch.id, ...remainingProducts.map((product) => product.spuId).sort()]);
            nextBatches.push(batch);
        }

        index.batches = nextBatches;
        delete index.excludedSpuIds;
        rebuildProducts(index);
        return {
            changed: cleanupFiles.size > 0 || deletedBatchCount > 0 || requestedIds.size > 0,
            cleanupFiles: [...cleanupFiles],
            deletedFileCount: cleanupFiles.size,
            deletedBatchCount
        };
    }

    /** 文件索引替换后直接清理；SQL 只登记持久化候选，提交后再复核整个仓库的引用。 */
    async function removeUnreferencedFiles(index, storedNames) {
        if (sql) return sql.queueFiles(storedNames.filter(name => name && path.basename(name) === name));
        const referenced = new Set((index.batches || []).flatMap((batch) => (batch.files || []).map((file) => String(file.storedName || ""))));
        for (const storedName of new Set(storedNames || [])) {
            const safe = path.basename(String(storedName || ""));
            if (!safe || safe !== String(storedName || "") || referenced.has(safe)) continue;
            await rm(path.join(filesDir, safe), { force: true });
        }
    }

    async function readStoredFile(storedName) {
        const safe = path.basename(storedName);
        const full = path.join(filesDir, safe);
        const text = await readFile(full, "utf8");
        return { name: safe, json: JSON.parse(text) };
    }

    /**
     * 工人补上紫鸟店铺后，只回填还没有来源店的批次。
     * 已有不同 sourceStoreId 的批次不能被后到的映射覆盖，避免 A 店资料改成 B 店。
     */
    async function attachSourceStore(input = {}) {
        const pluginInstanceId = String(input.pluginInstanceId || "").trim();
        const sourceStoreId = String(input.sourceStoreId || "").trim();
        const sourceStoreName = String(input.sourceStoreName || "").trim();
        const pageStoreName = String(input.pageStoreName || "").trim();
        if (!sourceStoreId) return { updated: 0 };
        if (sql && !await sql.hasUnmapped(input)) return { updated: 0 };
        const index = await readIndex();
        let updated = 0;
        for (const batch of index.batches || []) {
            if (String(batch.sourceStoreId || "").trim()) continue;
            const sameInstance = pluginInstanceId && String(batch.pluginInstanceId || "").trim() === pluginInstanceId;
            const samePageName = pageStoreName && String(batch.pageStoreName || batch.shopName || "").trim()
                && String(batch.pageStoreName || batch.shopName || "").trim().toLowerCase() === pageStoreName.toLowerCase();
            const batchInstance = String(batch.pluginInstanceId || "").trim();
            // 批次已有实例 ID 时只按实例回填，避免两家店页头短名相近时把 A 店写进 B 店资料。
            if (batchInstance ? !sameInstance : !samePageName) continue;
            batch.sourceStoreId = sourceStoreId;
            batch.sourceStoreName = sourceStoreName || batch.sourceStoreName || batch.shopName || pageStoreName;
            updated += 1;
        }
        if (updated) {
            rebuildProducts(index);
            await writeIndex(index);
        }
        return { updated };
    }

    /** 只在显式离线迁移中恢复旧资料；正常启动不会偷偷导入旧 JSON 覆盖新数据库。 */
    async function importLegacyIndex(index) {
        if (!sql) throw new Error("迁移要求启用 MySQL");
        const stores = [...new Set([...(index.batches || []).map(batch => String(batch.sourceStoreId || "")), ...Object.keys(index.blockedProducts || {}).map(key => key.split("\u0000")[0])])];
        return sql.runMutation(async () => {
            await hydratePublicationData(index);
            refreshBatchReadiness(index);
            rebuildProducts(index);
            await sql.importMeta(index);
            await writeIndex(index);
            return { batches: index.batches.length, products: index.products.length };
        }, stores);
    }
    /** 发送前从留存原包核对每件来源对象，防止索引错配、正文缺失或存储损坏；不校验平台字段模板。 */
    async function verifyBatchTransfer(batch, products, options = {}) {
        const inputs = [];
        let streamSource = null, legacyBytes = 0;
        for (const file of batch.files || []) {
            if (!file.storedName || path.basename(file.storedName) !== file.storedName) throw Object.assign(new Error("来源原文件引用不合法"), { status: 422 });
            if (file.fileSha256) {
                const facts = await readExistingFileFacts(file.storedName);
                if (!facts || facts.fileSha256 !== file.fileSha256 || facts.fileBytes !== Number(file.fileBytes)) throw Object.assign(Error('来源原始文件字节校验失败'), { status: 422 });
            }
            // 新账户链保存完整摘要命名的单一原包；核对字节后逐件重建，避免主进程JSON.parse整个64MiB。
            if (batch.files.length === 1 && file.fileSha256 && !file.contentSha256
                && file.storedName === `${file.fileSha256}-capture.json`) {
                const full = path.join(filesDir, file.storedName);
                const metadata = await readCaptureMetadata(full);
                if (metadata.source?.sourceStoreId !== batch.sourceStoreId) throw Object.assign(Error('原包与批次的来源店铺不一致'), { status: 422 });
                streamSource = { full, metadata };
                continue;
            }
            // 旧多文件格式保留原合并规则，但必须受内存工作集上限保护，超限要求重新采集到流式格式。
            legacyBytes += (await stat(path.join(filesDir, file.storedName))).size;
            if (legacyBytes > 8 * 1024 * 1024) throw Object.assign(Error('legacy_capture_workset_exceeded: 历史原包超过解析预算，请重新采集'), { status: 413 });
            let payload;
            try { payload = JSON.parse(await readFile(path.join(filesDir, file.storedName), "utf8")); }
            catch { throw Object.assign(new Error("来源原始文件缺失或无法读取，不能确认传输完整性"), { status: 422 }); }
            if (file.contentSha256 && transferHash(payload) !== file.contentSha256) throw Object.assign(new Error("来源原始文件校验失败，内容已发生变化"), { status: 422 });
            inputs.push({ originalName: file.originalName, payload });
        }
        if (!inputs.length && !streamSource) throw Object.assign(new Error("来源批次缺少原始采集文件，不能确认传输完整性"), { status: 422 });
        const parsed = streamSource ? { products: [] } : parseImportedFiles(inputs);
        if (parsed.sourceStoreId && String(parsed.sourceStoreId) !== String(batch.sourceStoreId)) throw Object.assign(new Error("原包与批次的来源店铺不一致"), { status: 422 });
        const captured = new Map(parsed.products.map(product => [String(product.spuId), product]));
        const verified = [], errors = [];
        for (const product of products) {
            try {
            let original = captured.get(String(product.spuId));
            if (streamSource) {
                const aggregate = createSingleProductCapture(streamSource.metadata, product.spuId);
                for await (const { value } of streamCaptureValues(streamSource.full, /^products\.\d+$/)) aggregate.seed(value);
                for await (const { value } of streamCaptureValues(streamSource.full, /^records\.\d+$/)) aggregate.record(value);
                original = aggregate.finish().products[0];
            }
            if (!original) throw Object.assign(new Error(`SPU ${product.spuId} 不在来源原包中`), { status: 422 });
            assertCapturedSource(original);
            // 旧解析器会重建属性列表或拒存不符合模板的原对象；历史快照不作为原始证据，直接从留存原包重建。
            // 这是恢复旧派生数据，不宣称旧插件当时已做过来源端摘要校验；不会改写历史任务或仓库记录。
            if (Number(product.publicationData?.schemaVersion || 0) < 2) {
                if (product.publicationData?.sourceProduct) assertCapturedSource(product);
                verified.push({ ...original, publicationData: { ...original.publicationData, restoredFromOriginal: true } });
                continue;
            }
            if (transferHash(assertCapturedSource(original)) !== transferHash(assertCapturedSource(product))) {
                throw Object.assign(new Error(`SPU ${product.spuId} 的下发资料与来源原包不一致，请重新采集`), { status: 422 });
            }
            verified.push(product);
            } catch (error) {
                // 批量清单可收集单件异常继续确认其余版本；正式创建任务仍沿用遇错停止的原子校验。
                if (!options.collectErrors || error.status !== 422) throw error;
                errors.push({ spuId: String(product.spuId), reason: error.message });
            }
        }
        return options.collectErrors ? { products: verified, errors } : verified;
    }
    const api = { ensure, importFiles, importPreparedCapture, deleteProducts, markProductBlocked, clearProductBlocked, unblockProducts, listOverview, indexSignature, getBatch, getProduct, readStoredFile, attachSourceStore, storeDataImpact, deleteStoreData, filesDir, importLegacyIndex, verifyBatchTransfer };
    if (sql) {
        // 预查询沿用业务层的输入归一化，非法请求仍由原入口返回明确校验错误。
        const lookupIds = ids => (Array.isArray(ids) ? ids : []).map(id => String(id || "").trim()).filter(Boolean);
        // 已知来源直接加该店锁；按 SPU 操作先用小型关联索引解析来源，再在锁内读当前资料。
        api.markProductBlocked = input => sql.runMutation(() => markProductBlocked(input), [String(input?.storeId || "").trim()]);
        api.clearProductBlocked = (id, ids) => sql.runMutation(() => clearProductBlocked(id, ids), [String(id || "").trim()]);
        api.deleteStoreData = (id, options) => sql.runMutation(() => deleteStoreData(id, options), [String(id || "").trim()]);
        api.unblockProducts = async (ids, scope = null) => {
            const stores = (await sql.storesForSpus(lookupIds(ids), true)).filter(id => !scope || scope.has(id));
            return sql.runMutation(() => unblockProducts(ids, scope), stores);
        };
        api.deleteProducts = async (ids, scope = null, options = {}) => {
            const explicit = Array.isArray(options.storeIds) ? new Set(options.storeIds.length ? options.storeIds.map(id => String(id).trim()) : [""]) : null;
            const stores = (await sql.storesForSpus(lookupIds(ids))).filter(id => (!scope || scope.has(id)) && (!explicit || explicit.has(id)));
            return sql.runMutation(() => deleteProducts(ids, scope, options), stores);
        };
        api.listOverviewPage = sql.page;
        api.inventoryVersions = sql.versions;
        api.transferRows = sql.transferRows;
        api.cleanupInventory = sql.cleanup;
        // 大多数心跳没有待映射批次，不应为无变化的登记占住入库锁。
        api.attachSourceStore = async input => !await sql.hasUnmapped(input) ? { updated: 0 }
            : sql.runMutation(() => attachSourceStore(input), ["", String(input.sourceStoreId || "").trim()]);
    }
    return api;
}

const PRODUCT_ID_SCALAR_KEYS = new Set(["productid", "spuid", "pageproductid"]);

function isProductIdArrayKey(key) {
    return /^(?:allowed|active|removed)?(?:page)?(?:product|spu)ids?(?:list|sample)?$/.test(key);
}

function isProductIdScalarKey(key) {
    return PRODUCT_ID_SCALAR_KEYS.has(key);
}

/**
 * 递归清除原始 JSON 中的目标商品。
 * 混合列表记录只删除命中商品的对象，其他商品及其列表项继续保留；
 * productId/spuId 所在对象一旦命中就整对象移除，避免留下标题、图片、SKU 等半截资料。
 */
function scrubDeletedProductIds(value, deletedIds, depth = 0) {
    if (depth > 30 || value === null || value === undefined) return value;
    if (typeof value === "string") {
        const text = value.trim();
        if (!text) return value;
        for (const id of deletedIds) {
            if (new RegExp(`(?:^|[^0-9])${id}(?:[^0-9]|$)`).test(text)) return undefined;
        }
        return value;
    }
    if (typeof value === "number") return deletedIds.has(String(value)) ? undefined : value;
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            if ((typeof item === "string" || typeof item === "number") && deletedIds.has(String(item).trim())) continue;
            if (item && typeof item === "object") {
                const directIds = directProductIds(item);
                if (directIds.some((id) => deletedIds.has(id))) continue;
            }
            const scrubbed = scrubDeletedProductIds(item, deletedIds, depth + 1);
            if (scrubbed !== undefined) result.push(scrubbed);
        }
        return result;
    }
    if (typeof value !== "object") return value;

    const result = {};
    for (const [key, item] of Object.entries(value)) {
        const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
        if (isProductIdScalarKey(normalizedKey) && deletedIds.has(String(item || "").trim())) return undefined;
        if (isProductIdArrayKey(normalizedKey)) {
            const items = Array.isArray(item) ? item : [item];
            const kept = items.filter((entry) => !deletedIds.has(String(entry || "").trim()));
            if (kept.length) result[key] = kept;
            continue;
        }
        const scrubbed = scrubDeletedProductIds(item, deletedIds, depth + 1);
        if (scrubbed !== undefined) result[key] = scrubbed;
    }
    return result;
}

/** 读取对象直属的商品 ID，仅用于判断数组项是否就是待删除商品，不递归猜归属。 */
function directProductIds(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    return Object.entries(value).flatMap(([key, item]) => {
        const normalizedKey = key.replace(/[_-]/g, "").toLowerCase();
        if (isProductIdScalarKey(normalizedKey)) return [String(item || "").trim()].filter(Boolean);
        if (isProductIdArrayKey(normalizedKey) && Array.isArray(item)) return item.map((entry) => String(entry || "").trim()).filter(Boolean);
        return [];
    });
}

function summarizeBatch(batch) {
    return {
        id: batch.id,
        createdAt: batch.createdAt,
        label: batch.label,
        shopName: batch.shopName,
        sourceStoreId: batch.sourceStoreId || "",
        sourceStoreName: batch.sourceStoreName || "",
        pluginInstanceId: batch.pluginInstanceId || "",
        pageStoreName: batch.pageStoreName || "",
        status: batch.status,
        readiness: batch.readiness,
        coverage: batch.coverage,
        counts: batch.counts,
        fileCount: (batch.files || []).length,
        warningCount: (batch.warnings || []).length,
        pageUrl: batch.pageUrl,
        seed: batch.seed
    };
}

function sanitizeName(name) {
    return String(name || "file.json").replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(-80);
}

/**
 * 完整包的导出时间每次都会变化，但并不代表商品数据发生变化。
 * 去重时只忽略顶层 exportedAt；响应正文、分类结果或商品元数据只要变化，仍会形成新批次。
 */
function makeStablePayloadHash(payload) {
    if (payload && payload.kind === "full-capture-packet" && !Array.isArray(payload)) {
        const stable = { ...payload };
        delete stable.exportedAt;
        return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
    }
    return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * 跨批次合并同一 SPU 的 SKU 行。按 skuId 去重，避免列表包和日志各写一遍后出现重复规格。
 */
function mergeStoredSkus(current = [], incoming = []) {
    const map = new Map();
    for (const sku of [...current, ...incoming]) {
        const skuId = String((sku && sku.skuId) || "").trim();
        if (!skuId) continue;
        const previous = map.get(skuId) || { skuId };
        map.set(skuId, {
            skuId,
            extCode: String(sku.extCode || previous.extCode || "").trim(),
            specs: Array.isArray(sku.specs) && sku.specs.length ? sku.specs : (previous.specs || []),
            price: sku.price ?? previous.price ?? null,
            currency: String(sku.currency || previous.currency || "").trim(),
            weight: sku.weight ?? previous.weight ?? null,
            netWeight: sku.netWeight ?? previous.netWeight ?? null,
            thumbUrl: String(sku.thumbUrl || previous.thumbUrl || "").trim()
        });
    }
    return [...map.values()];
}
