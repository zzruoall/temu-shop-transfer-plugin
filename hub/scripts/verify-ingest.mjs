/**
 * 离线校验直推协议：完整包能被网站识别，令牌比较抗时序，令牌文件可落盘。
 * 不启动 HTTP 服务，也不写入正式 data/。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isValidIngestToken, loadIngestAuth } from "../lib/ingest-auth.mjs";
import { detectFileKind, parseImportedFiles } from "../lib/parse-capture.mjs";
import { createStore } from "../lib/store.mjs";
import { createJobQueue } from "../lib/job-queue.mjs";

if (!isValidIngestToken("abc", "abc") || isValidIngestToken("abc", "abd")) {
    throw new Error("token compare failed");
}

const tempRoot = await mkdtemp(path.join(tmpdir(), "ziniao-ingest-"));
try {
    const auth = await loadIngestAuth(tempRoot, {
        ZINIAO_BIND: "127.0.0.1",
        ZINIAO_PORT: "17380",
        ZINIAO_INGEST_TOKEN: ""
    });
    if (!auth.token || !auth.endpoints[0].endsWith("/api/ingest")) {
        throw new Error("ingest auth did not produce endpoint");
    }
    // 通用 verify 用内联完整包核对入库/删除/重放；14 件实测包改由 live 脚本在有下载文件时跑。
    const packet = {
        schemaVersion: 4,
        kind: "full-capture-packet",
        exportMode: "full-capture",
        products: [{ spuId: "7744886733", goodsId: "9001" }],
        records: [{
            identity: { productIds: ["7744886733"], goodsIds: ["9001"] },
            payload: {
                result: {
                    pageItems: [{
                        productId: 7744886733,
                        goodsId: 9001,
                        productName: "HTTP verify",
                        productSkuSummaries: [{ productSkuId: 79322547323 }]
                    }]
                }
            }
        }]
    };
    if (detectFileKind("temu-full-capture-verify.json", packet) !== "full-packet") {
        throw new Error("packet kind mismatch");
    }
    const parsed = parseImportedFiles([{ originalName: "temu-full-capture-verify.json", payload: packet }]);
    if (!parsed.counts || parsed.counts.spu < 1) {
        throw new Error("parsed packet missing SPU");
    }
    // 同一批响应重新导出时只有 exportedAt 改变，仓库必须复用原批次，不能制造重复库存批次。
    const storeRoot = path.join(tempRoot, "store");
    const store = createStore(storeRoot);

    // 编辑页 product/query 可能没有 goodsId 或 SKC；入库重建后必须保持与批次相同的可发送判断。
    const noGoodsPacket = {
        schemaVersion: 4,
        kind: "full-capture-packet",
        source: { platform: "temu", pageUrl: "https://agentseller.temu.com/goods/edit?productId=4764369705" },
        records: [{
            dataType: "product-detail",
            identity: { productIds: ["4764369705"] },
            source: { pageProductId: "4764369705", requestUrl: "https://agentseller.temu.com/visage-agent-seller/product/query" },
            payload: { result: {
                productId: "4764369705",
                productName: "无 goodsId 的完整商品",
                productSkuMap: { red: { productSkuId: "92333181434", skuImageUrl: "https://img.example.com/sku.jpg" } },
                carouselImgsI18n: { zh: [{ url: "https://img.example.com/main.jpg" }] },
                decoration: [{ content: "<p>可交付的图文详情</p>" }]
            } }
        }]
    };
    const noGoodsImport = await store.importFiles([{ originalName: "product-query-no-goods.json", payload: noGoodsPacket }], {
        source: "verify",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    const noGoodsOverview = await store.listOverview();
    const noGoodsProduct = noGoodsOverview.products.find((product) => product.spuId === "4764369705");
    if (!noGoodsProduct || !noGoodsProduct.ready || noGoodsProduct.completeness.hasGoods || noGoodsProduct.completeness.hasSkc) {
        throw new Error("完整 product/query 在库存阶段被 goodsId 或 SKC 错误拦截");
    }
    // 模拟 10.4.0 之前遗留的 products 缓存；重新打开仓库也必须以批次原始字段重新得出 ready。
    const storedIndexPath = path.join(storeRoot, "data", "index.json");
    const staleIndex = JSON.parse(await readFile(storedIndexPath, "utf8"));
    staleIndex.batches = staleIndex.batches.map((batch) => ({
        ...batch,
        status: batch.id === noGoodsImport.batch.id ? "packet-incomplete" : batch.status,
        readiness: batch.id === noGoodsImport.batch.id ? "完整包未齐，不可导入" : batch.readiness,
        counts: batch.id === noGoodsImport.batch.id ? { ...batch.counts, ready: 0 } : batch.counts,
        products: (batch.products || []).map((product) => product.spuId === "4764369705"
            ? { ...product, ready: false, completeness: { ...product.completeness, hasGoods: false, hasSkc: false } }
            : product)
    }));
    staleIndex.products = staleIndex.products.map((product) => product.spuId === "4764369705"
        ? { ...product, ready: false, completeness: { ...product.completeness, hasGoods: false, hasSkc: false } }
        : product);
    await writeFile(storedIndexPath, JSON.stringify(staleIndex), "utf8");
    const reopenedOverview = await createStore(storeRoot).listOverview();
    if (!reopenedOverview.products.find((product) => product.spuId === "4764369705")?.ready) {
        throw new Error("旧库存索引未按新规则重新计算可发送状态");
    }
    // 直接检查任意包含该 SPU 的来源批次，确保任务队列读取的快照也已迁移。
    const migratedBatchId = (JSON.parse(await readFile(storedIndexPath, "utf8"))).batches
        .find((batch) => (batch.products || []).some((product) => product.spuId === "4764369705"))?.id;
    if (!migratedBatchId) throw new Error("旧批次迁移测试未找到商品");
    const migratedBatchCheck = await createStore(storeRoot).getBatch(migratedBatchId);
    if (!migratedBatchCheck.products.find((product) => product.spuId === "4764369705")?.ready
        || migratedBatchCheck.status !== "ready-for-map" || migratedBatchCheck.counts.ready !== 1) {
        throw new Error("旧批次商品 ready 未迁移，任务队列仍会阻断");
    }
    const migratedJob = await createJobQueue(path.join(tempRoot, "migration-jobs"), createStore(storeRoot)).createJob({
        sourceStoreId: "source-verify",
        targetStoreId: "target-verify",
        sourceBatchId: migratedBatchId,
        spuIds: ["4764369705"]
    });
    if (migratedJob.status !== "queued" || migratedJob.items[0]?.status !== "queued") {
        throw new Error("旧批次迁移后，任务队列仍把完整商品拦截为未就绪");
    }

    const first = await store.importFiles([{ originalName: "first.json", payload: packet }], {
        source: "verify",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    const secondPacket = { ...packet, exportedAt: "2099-01-01T00:00:00.000Z" };
    const second = await store.importFiles([{ originalName: "second.json", payload: secondPacket }], {
        source: "verify",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    if (!second.reused || second.batch.id !== first.batch.id) {
        throw new Error("same capture records created duplicate batch");
    }
    // 删除必须同时清除库存、历史批次和包含该商品的原始文件；再次上传同 SPU 必须作为新批次接收。
    const targetSpu = String(packet.products && packet.products[0] && packet.products[0].spuId || parsed.products[0].spuId);
    const deleted = await store.deleteProducts([targetSpu]);
    const overview = await store.listOverview();
    if (deleted.deletedCount !== 1 || overview.products.some((product) => product.spuId === targetSpu)) {
        throw new Error("product delete did not remove inventory index");
    }
    if (overview.excludedCount !== 0) {
        throw new Error("product delete left a legacy exclusion tombstone");
    }
    if (await store.getBatch(first.batch.id)) {
        throw new Error("product delete kept the historical batch");
    }
    await readFile(path.join(store.filesDir, first.batch.files[0].storedName), "utf8").then(
        () => { throw new Error("product delete kept the original capture file"); },
        (error) => { if (error.code !== "ENOENT") throw error; }
    );
    const replayAfterDelete = await store.importFiles([{ originalName: "replay-after-delete.json", payload: packet }], {
        source: "extension-ingest",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    const afterReplay = await store.listOverview();
    if (replayAfterDelete.reused || !afterReplay.products.some((product) => product.spuId === targetSpu)) {
        throw new Error("同 SPU 删除后再次上传没有按新批次接收");
    }
    await store.deleteProducts(["not-a-spu"]).then(
        () => { throw new Error("invalid SPU was accepted"); },
        (error) => { if (error.status !== 400) throw error; }
    );
    await store.deleteProducts(["9999999999"]).then(
        () => { throw new Error("missing SPU was treated as success"); },
        (error) => { if (error.status !== 404) throw error; }
    );

    /**
     * 平台会给同款商品重复分配 SPU：同一个货号在店内出现两条商品行。
     * 商品库必须按“来源店 + 货号”合并成一行，否则同货号留下两条记录，
     * 第二条上传到目标店时必然被按货号判为已存在。
     */
    const sharedCodePacket = {
        schemaVersion: 4,
        kind: "full-capture-packet",
        exportMode: "full-capture",
        exportedAt: "2099-05-01T00:00:00.000Z",
        source: { platform: "temu", shopName: "来源验证店", sourceStoreId: "source-verify" },
        products: [{ spuId: "7311111111", goodsId: "9101" }, { spuId: "7322222222", goodsId: "9102" }],
        records: [{
            identity: { productIds: ["7311111111", "7322222222"], goodsIds: ["9101", "9102"] },
            payload: {
                result: {
                    pageItems: [
                        { productId: 7311111111, goodsId: 9101, productName: "同货号商品 A", productSkuSummaries: [{ productSkuId: 731111111, extCode: "UAA85" }] },
                        { productId: 7322222222, goodsId: 9102, productName: "同货号商品 B", productSkuSummaries: [{ productSkuId: 732222222, extCode: "UAA85" }] }
                    ]
                }
            }
        }]
    };
    await store.importFiles([{ originalName: "shared-code.json", payload: sharedCodePacket }], {
        source: "verify",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    const sharedOverview = await store.listOverview();
    const sharedCodeSpus = ["7311111111", "7322222222"];
    const mergedRows = sharedOverview.products.filter((product) => [product.spuId, ...(product.spuIds || [])].some((id) => sharedCodeSpus.includes(id)));
    if (mergedRows.length !== 1) throw new Error(`同货号商品没有合并成一行，当前 ${mergedRows.length} 行`);
    if ((mergedRows[0].spuIds || []).length !== 2) throw new Error("同货号商品没有保留全部 SPU");
    // 删除合并行必须把该货号下的全部 SPU 一起物理删除，不能只留一个排除标记。
    const mergedDeletion = await store.deleteProducts([mergedRows[0].spuId]);
    const afterMergedDeletion = await store.listOverview();
    if (mergedDeletion.deletedCount !== 2) throw new Error("删除合并行没有删除同货号的全部 SPU");
    if (afterMergedDeletion.products.some((product) => [product.spuId, ...(product.spuIds || [])].some((id) => sharedCodeSpus.includes(id)))) {
        throw new Error("删除合并行后同货号商品又被另一个 SPU 带回库存");
    }
    const sharedReplay = await store.importFiles([{ originalName: "shared-code-replay.json", payload: sharedCodePacket }], {
        source: "extension-ingest",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    const afterSharedReplay = await store.listOverview();
    if (sharedReplay.reused || !afterSharedReplay.products.some((product) => [product.spuId, ...(product.spuIds || [])].some((id) => sharedCodeSpus.includes(id)))) {
        throw new Error("删除同货号商品后再次上传仍被旧批次阻断");
    }

    /**
     * 混合包中删除一个商品时，同批次其他商品必须保留，且原始记录中的已删商品正文要同步清除。
     */
    const mixedPacket = {
        schemaVersion: 5,
        kind: "full-capture-packet",
        exportMode: "full-capture",
        exportedAt: "2099-06-01T00:00:00.000Z",
        source: { platform: "temu", sourceStoreId: "source-verify" },
        products: [{ spuId: "7411111111" }, { spuId: "7422222222" }],
        records: [{
            identity: { productIds: ["7411111111", "7422222222"] },
            payload: {
                diagnosticText: "诊断文本 SPU ID：7411111111",
                result: {
                    pageItems: [
                        { productId: 7411111111, productName: "待删除商品", productSkuSummaries: [{ productSkuId: 741111111, extCode: "MIX-A" }] },
                        { productId: 7422222222, productName: "保留商品", productSkuSummaries: [{ productSkuId: 742222222, extCode: "MIX-B" }] }
                    ]
                }
            }
        }]
    };
    const mixedImport = await store.importFiles([{ originalName: "mixed-products.json", payload: mixedPacket }], {
        source: "verify",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    await store.deleteProducts(["7411111111"]);
    const mixedOverview = await store.listOverview();
    if (!mixedOverview.products.some((product) => [product.spuId, ...(product.spuIds || [])].includes("7422222222"))) {
        throw new Error("删除混合包中的商品时误删了同批次其他商品");
    }
    if (mixedOverview.products.some((product) => [product.spuId, ...(product.spuIds || [])].includes("7411111111"))) {
        throw new Error("混合包中的目标商品没有彻底删除");
    }
    const mixedBatch = await store.getBatch(mixedImport.batch.id);
    const mixedFile = await readFile(path.join(store.filesDir, mixedBatch.files[0].storedName), "utf8");
    if (mixedFile.includes("7411111111") || !mixedFile.includes("7422222222")) {
        throw new Error("混合包原始文件没有按商品精确清理");
    }
    /**
     * 合并行对外只暴露一个 SPU，上传任务按 (来源批次, SPU) 取快照。
     * 两者必须来自同一次采集，否则插件拿不到来源资料，会直接报“缺少来源完整资料”。
     */
    for (const product of (await store.listOverview()).products) {
        const sourceBatchId = product.publicationData && product.publicationData.sourceBatchId;
        if (!sourceBatchId) continue;
        const sourceBatch = await store.getBatch(sourceBatchId);
        if (!(sourceBatch.products || []).some((item) => String(item.spuId) === String(product.spuId))) {
            throw new Error(`SPU ${product.spuId} 的发布资料来源批次 ${sourceBatchId} 里没有这件商品`);
        }
    }

    /**
     * 采集时工人可能还没映射紫鸟店铺。后到的 storeId 只能回填空来源批次，
     * 已有不同 sourceStoreId 的批次必须保持原店，避免 A 店资料改成 B 店。
     */
    const pendingPacket = {
        ...packet,
        exportedAt: "2099-02-01T00:00:00.000Z",
        products: [{ spuId: "6111111111", goodsId: "9009" }],
        source: {
            pluginInstanceId: "plugin-instance-backfill",
            pageStoreName: "Hair removal wax",
            shopName: "Hair removal wax"
        },
        records: [{
            identity: { productIds: ["6111111111"], goodsIds: ["9009"] },
            payload: {
                result: {
                    pageItems: [{
                        productId: 6111111111,
                        goodsId: 9009,
                        productName: "Backfill verify",
                        productSkuSummaries: [{ productSkuId: 1 }]
                    }]
                }
            }
        }]
    };
    const pending = await store.importFiles([{ originalName: "pending-source.json", payload: pendingPacket }], {
        source: "extension-ingest",
        pluginInstanceId: "plugin-instance-backfill",
        pageStoreName: "Hair removal wax"
    });
    if (pending.batch.sourceStoreId) throw new Error("pending capture should not invent a Ziniao storeId");
    const filled = await store.attachSourceStore({
        pluginInstanceId: "plugin-instance-backfill",
        sourceStoreId: "27751811499835",
        sourceStoreName: "Hair removal wax-全托-若欧",
        pageStoreName: "Hair removal wax"
    });
    const filledBatch = await store.getBatch(pending.batch.id);
    if (filled.updated < 1 || filledBatch.sourceStoreId !== "27751811499835") {
        throw new Error("delayed worker mapping did not backfill empty sourceStoreId");
    }
    const skipped = await store.attachSourceStore({
        pluginInstanceId: "plugin-instance-backfill",
        sourceStoreId: "27565374641388",
        sourceStoreName: "City Beauty King-HAOSHI",
        pageStoreName: "Hair removal wax"
    });
    const unchanged = await store.getBatch(pending.batch.id);
    if (skipped.updated !== 0 || unchanged.sourceStoreId !== "27751811499835") {
        throw new Error("existing sourceStoreId was overwritten by a later mapping");
    }

    const otherPendingPacket = {
        ...packet,
        exportedAt: "2099-03-01T00:00:00.000Z",
        products: [{ spuId: "6222222222", goodsId: "9010" }],
        source: {
            pluginInstanceId: "plugin-instance-other",
            pageStoreName: "Hair removal wax",
            shopName: "Hair removal wax"
        },
        records: [{
            identity: { productIds: ["6222222222"], goodsIds: ["9010"] },
            payload: {
                result: {
                    pageItems: [{
                        productId: 6222222222,
                        goodsId: 9010,
                        productName: "Other instance",
                        productSkuSummaries: [{ productSkuId: 2 }]
                    }]
                }
            }
        }]
    };
    const otherPending = await store.importFiles([{ originalName: "other-instance.json", payload: otherPendingPacket }], {
        source: "extension-ingest",
        pluginInstanceId: "plugin-instance-other",
        pageStoreName: "Hair removal wax"
    });
    const skippedOther = await store.attachSourceStore({
        pluginInstanceId: "plugin-instance-backfill",
        sourceStoreId: "27751811499835",
        sourceStoreName: "Hair removal wax-全托-若欧",
        pageStoreName: "Hair removal wax"
    });
    const otherBatch = await store.getBatch(otherPending.batch.id);
    if (skippedOther.updated !== 0 || otherBatch.sourceStoreId) {
        throw new Error("same page name backfilled a different plugin instance");
    }

    // 旧索引中的 excludedSpuIds 必须在下一次导入时物理迁移，而不是继续影响新内容。
    const legacyRoot = path.join(tempRoot, "legacy-exclusions");
    const legacyStore = createStore(legacyRoot);
    await legacyStore.importFiles([{ originalName: "legacy.json", payload: packet }], {
        source: "verify",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    const legacyIndexPath = path.join(legacyRoot, "data", "index.json");
    const legacyIndex = JSON.parse(await readFile(legacyIndexPath, "utf8"));
    legacyIndex.excludedSpuIds = [targetSpu];
    await writeFile(legacyIndexPath, JSON.stringify(legacyIndex, null, 2), "utf8");
    if ((await legacyStore.listOverview()).productCount !== 0) {
        throw new Error("旧排除索引测试准备失败");
    }
    await legacyStore.importFiles([{ originalName: "legacy-replay.json", payload: packet }], {
        source: "verify",
        sourceStoreId: "source-verify",
        sourceStoreName: "来源验证店"
    });
    const migratedLegacyOverview = await legacyStore.listOverview();
    const migratedLegacyIndex = JSON.parse(await readFile(legacyIndexPath, "utf8"));
    if (migratedLegacyOverview.productCount !== 1 || migratedLegacyOverview.excludedCount !== 0 || Object.hasOwn(migratedLegacyIndex, "excludedSpuIds")) {
        throw new Error("旧 excludedSpuIds 没有在下一次导入时物理清理");
    }

    const missingRoot = path.join(tempRoot, "missing-index");
    const missingStore = createStore(missingRoot);
    await missingStore.ensure();
    await readFile(path.join(missingRoot, "data", "index.json"), "utf8");

    const corruptRoot = path.join(tempRoot, "corrupt-index");
    await mkdir(path.join(corruptRoot, "data", "files"), { recursive: true });
    await writeFile(path.join(corruptRoot, "data", "index.json"), "{not-json", "utf8");
    const corruptStore = createStore(corruptRoot);
    await corruptStore.ensure().then(
        () => { throw new Error("corrupt index was rebuilt as empty warehouse"); },
        (error) => { if (error.code !== "index_corrupt") throw error; }
    );
    const corruptText = await readFile(path.join(corruptRoot, "data", "index.json"), "utf8");
    if (corruptText !== "{not-json") {
        throw new Error("corrupt index was overwritten");
    }
    await writeFile(path.join(tempRoot, "ok.json"), JSON.stringify({ token: auth.token, spu: parsed.counts.spu }), "utf8");
    console.log("ingest verify ok", parsed.counts.spu, parsed.readiness);
} finally {
    await rm(tempRoot, { recursive: true, force: true });
}
