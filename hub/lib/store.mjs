/**
 * 批次仓库：原始文件落盘，索引与商品名单分开保存。
 * 原始 JSON 始终可回看；商品表只保存核验后的标准字段。
 */
import { access, mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import {skuFingerprint} from "./sku-dedup.mjs";
import { createHash, randomUUID } from "node:crypto";
import { detectFileKind, getProductCompleteness, hasRealProductDetail, isProductReadyForTransfer, makeBatchId, parseImportedFiles, redactSensitive } from "./parse-capture.mjs";

export function createStore(rootDir) {
    const dataDir = path.join(rootDir, "data");
    const filesDir = path.join(dataDir, "files");
    const indexPath = path.join(dataDir, "index.json");
    let mutationQueue = Promise.resolve();

    async function ensure() {
        await mkdir(filesDir, { recursive: true });
        try {
            JSON.parse(await readFile(indexPath, "utf8"));
            return;
        } catch (error) {
            const missing = Boolean(error && error.code === "ENOENT");
            // 替换窗口崩溃时优先从已写完的临时/备份恢复。
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
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        await hydratePublicationData(index);
        refreshBatchReadiness(index);
        // 旧版本已把 products 当作持久缓存写入。每次读取均由不可变批次快照重建，
        // 使规则升级后无需等下一次导入，也不会把旧的 ready 结论继续暴露给网页或任务队列。
        // 读取路径不落盘，避免查询与正在进行的导入/删除争抢同一个索引文件。
        rebuildProducts(index);
        return index;
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
        // 索引是唯一目录，临时文件写完整后再替换；备份供进程在替换窗口崩溃后的 ensure() 恢复。
        const temp = `${indexPath}.tmp`;
        const backup = `${indexPath}.bak`;
        await writeFile(temp, JSON.stringify(index, null, 2), "utf8");
        await rm(backup, { force: true });
        try {
            await rename(indexPath, backup);
        } catch (error) {
            if (!error || error.code !== "ENOENT") throw error;
        }
        try {
            await rename(temp, indexPath);
            await rm(backup, { force: true });
        } catch (error) {
            // 当前进程内替换失败时尽量回滚；若回滚也失败，备份仍留在磁盘供下次启动恢复。
            try { await rename(backup, indexPath); } catch {}
            throw error;
        }
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
                const rowKey = codeKeys.find((key) => codeIndex.has(key)) || codeKeys[0] || `spu\u0000${spuId}`;
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
     * 网页上传和插件直推共用一个索引文件，所有导入必须串行提交，避免并发完成时后写者覆盖前写者。
     */
    async function importFiles(uploads, options = {}) {
        const run = mutationQueue.then(() => importFilesNow(uploads, options));
        mutationQueue = run.catch(() => {});
        return run;
    }

    async function importFilesNow(uploads, options = {}) {
        await ensure();
        const parsedFiles = [];
        const savedFiles = [];
        const pendingFiles = [];

        for (const upload of uploads) {
            const payload = redactSensitive(upload.payload);
            const bytes = Buffer.byteLength(JSON.stringify(payload));
            const hash = makeStablePayloadHash(payload);
            const kind = detectFileKind(upload.originalName, payload);
            const storedName = `${hash.slice(0, 16)}-${sanitizeName(upload.originalName)}`;
            const storedPath = path.join(filesDir, storedName);
            const fileRecord = {
                id: hash.slice(0, 16),
                originalName: upload.originalName,
                storedName,
                kind,
                bytes,
                exportedAt: payload.exportedAt || null,
                purpose: payload.purpose || ""
            };
            parsedFiles.push({ originalName: upload.originalName, payload, bytes });
            savedFiles.push(fileRecord);
            pendingFiles.push({ storedPath, payload });
        }

        const parsed = parseImportedFiles(parsedFiles);
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
                    await writeFile(storedPath, JSON.stringify(pending.payload, null, 2), "utf8");
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
            const duplicate=hash&&old.find(b=>b.products.some(p=>skuFingerprint(p,b.sourceStoreId)===hash));
            if(duplicate)reusedBatch=duplicate;else kept.push(product);
        }
        if(parsed.products.length&&!kept.length&&reusedBatch) {
            const restoredFiles = await restoreMissingFiles(reusedBatch);
            return {batch:reusedBatch,reused:true,warnings:["相同店铺SKU内容已存在，本次未新增文件或商品"],restoredFiles};
        }
        // 混合包保留完整单次证据和统计，库存归并不产生重复行；不删半个响应导致发布快照失真。
        const fingerprint = makeBatchId(savedFiles.map((item) => item.id).sort());
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
            return { batch: existing, reused: true, warnings: parsed.warnings, restoredFiles };
        }

        // 先完成重复批次判断再落原始文件，重复直推不会在 files 目录留下无人引用的孤立文件。
        for (const file of pendingFiles) {
            await writeFile(file.storedPath, JSON.stringify(file.payload, null, 2), "utf8");
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
        rebuildProducts(index);
        await writeIndex(index);
        return { batch, reused: false, warnings: parsed.warnings };
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
        const info = await stat(indexPath).catch(() => null);
        return info ? `${Math.round(info.mtimeMs)}:${info.size}` : "missing";
    }

    async function getBatch(id) {
        const index = await readIndex();
        return index.batches.find((batch) => batch.id === id) || null;
    }

    async function getProduct(spuId) {
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
    async function deleteProducts(spuIds) {
        const run = mutationQueue.then(() => deleteProductsNow(spuIds));
        mutationQueue = run.catch(() => {});
        return run;
    }

    async function deleteProductsNow(spuIds) {
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
        // 商品库按“来源店 + 货号”归并成一行，删除一行必须清除该货号下的全部 SPU；
        // 否则另一个同货号历史 SPU 仍会参与判重或重新出现。
        const existingIds = new Set((index.products || []).flatMap((product) => [product.spuId, ...(product.spuIds || [])]).map((value) => String(value || "")));
        const expandedIds = expandProductDeletionIds(index, ids);
        const deletedIds = [...expandedIds].filter((id) => existingIds.has(id));
        const missingIds = [...ids].filter((id) => !existingIds.has(id));
        if (!deletedIds.length) {
            const error = new Error(missingIds.length === 1 ? `库存中没有 SPU ${missingIds[0]}` : "所选商品都不在当前库存中");
            error.status = 404;
            throw error;
        }
        // 历史版本遗留的排除记录也必须一起物理清理，不能只让本次选中的商品消失。
        const purgeIds = [...new Set([...(index.excludedSpuIds || []).map(String), ...deletedIds])];
        const purged = await purgeProductsFromIndex(index, purgeIds);
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
     * 展开同一来源店内共享货号的全部 SPU。
     * 只沿已存在的历史关系扩展，不按单值货号猜测，也不会把未来重新创建的 SPU 带入本次删除。
     */
    function expandProductDeletionIds(index, requestedIds) {
        const groupMembers = new Map();
        const groupsOfSpu = new Map();
        for (const batch of index.batches || []) {
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
    async function purgeProductsFromIndex(index, productIds) {
        const requestedIds = new Set((productIds || []).map((value) => String(value || "").trim()).filter(Boolean));
        if (!requestedIds.size) return { changed: false, cleanupFiles: [], deletedFileCount: 0, deletedBatchCount: 0 };
        const expandedIds = expandProductDeletionIds(index, requestedIds);
        const cleanupFiles = new Set();
        let deletedBatchCount = 0;
        const nextBatches = [];

        for (const batch of index.batches || []) {
            const batchProducts = Array.isArray(batch.products) ? batch.products : [];
            const hasDeletedProduct = batchProducts.some((product) => expandedIds.has(String(product.spuId || "")));
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
                const storedName = `${hash.slice(0, 16)}-${sanitizeName(file.originalName || "capture.json")}`;
                await writeFile(path.join(filesDir, storedName), JSON.stringify(nextPayload, null, 2), "utf8");
                cleanupFiles.add(oldName);
                nextFiles.push({
                    ...file,
                    id: hash.slice(0, 16),
                    storedName,
                    kind: detectFileKind(file.originalName, nextPayload),
                    bytes: Buffer.byteLength(JSON.stringify(nextPayload)),
                    exportedAt: nextPayload.exportedAt || null,
                    purpose: nextPayload.purpose || ""
                });
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

    /** 索引完成替换后再删除失去引用的文件，避免写入失败时留下悬空批次记录。 */
    async function removeUnreferencedFiles(index, storedNames) {
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
        if (updated) await writeIndex(index);
        return { updated };
    }

    return { ensure, importFiles, deleteProducts, listOverview, indexSignature, getBatch, getProduct, readStoredFile, attachSourceStore, filesDir };
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
