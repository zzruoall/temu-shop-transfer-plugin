import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createStore } from '../lib/store.mjs';
import { createMysqlInventory } from '../lib/mysql-inventory.mjs';
import { initializeMysqlSchema, assertMysqlReady } from '../lib/mysql-schema.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { noticeSourceVersion, noticeStateKey } from '../lib/product-notice-state.mjs';
import { canonicalProductSnapshot } from '../lib/job-queue.mjs';
import { transferHash } from '../lib/transfer-integrity.mjs';

// 只使用临时目录；可选数据库严格固定为本机隔离端口，不读取生产配置。
const root = await mkdtemp(path.join(tmpdir(), 'temu-notice-state-'));
let database, admin, databaseName;
const sourceStoreId = 'temu:notice-source', spuId = '1234567890', peerId = '1234567891';

/** 合成真实编辑页响应，导入、去重和来源版本均经过正常解析链路。 */
function uploads(id = spuId, revision = 1, storeId = sourceStoreId, code = 'NOTICE-CODE') {
    const source = { productId: id, productName: `product-${id}`, extCode: code,
        revision, unknownData: { literal: null, n: revision }, productSkcList: [],
        goodsLayerDecorationVOList: [] };
    return [{ originalName: `${id}.json`, payload: { kind: 'full-capture-packet', schemaVersion: 5,
        source: { sourceStoreId: storeId }, products: [{ spuId: id }],
        records: [{ dataType: 'product-detail', identity: { productIds: [id] },
            source: { pageProductId: id, requestUrl: 'https://example.invalid/visage-agent-seller/product/query' },
            payload: { success: true, result: source } }] } }];
}

/** 每条发送只携带来源引用；接收目标不影响来源商品的首次标记去重。 */
function claimed(ref, targetStoreId = 'temu:target-1') {
    return { sourceStoreId: ref.sourceStoreId, spuId: ref.spuId, sourceNoticeRef: ref, targetStoreId };
}

try {
    if (process.argv.includes('--mysql')) {
        const mysql = (await import('mysql2/promise')).default;
        admin = await mysql.createConnection({ host: '127.0.0.1', port: 33917, user: 'root', connectTimeout: 1500 });
        databaseName = `temu_notice_test_${Date.now()}_${process.pid}`;
        assert.match(databaseName, /^temu_notice_test_\d+_\d+$/);
        await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
        const config = path.join(root, 'mysql.json');
        await writeFile(config, JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: databaseName }));
        database = await openMysqlDatabase(config);
        await initializeMysqlSchema(database);
        // 隔离库也登记真实资料目录，迁移必须按库内目录工作，不能依赖脚本当前目录。
        await database.query('maintenance', "INSERT INTO hub_schema(id,version,state,data_root) VALUES(1,1,'ready',?)", [root]);
    }
    const store = createStore(root, { database });
    const original = await store.importFiles(uploads());
    let [ref] = await store.noticeRefs(sourceStoreId, [spuId]);
    assert.match(ref.sourceInstanceId, /^[a-f0-9-]{36}$/);
    assert.equal(ref.sourceVersion, transferHash(canonicalProductSnapshot(original.batch.products[0])));
    assert.equal(ref.sourceVersion, noticeSourceVersion(original.batch.products[0]));
    assert.equal(ref.sourceVersion, noticeSourceVersion((await store.getBatch(original.batch.id)).products[0]));
    assert.equal(ref.noticeEpoch, 0);
    assert.deepEqual(ref.productCodes, ['NOTICE-CODE']);
    assert.equal(ref.sendBlocked, false);
    const result = await store.withNoticeDelivery([claimed(ref)], payload => ({ token: 19, ...payload }));
    assert.equal(result.token, 19);
    assert.equal(result.claimed.length, 1);
    assert.equal(result.skippedBlocked.length, 0);
    assert.equal(await store.withNoticeDelivery([{ spuId: 'legacy' }], payload => payload.claimed.length), 1);
    await assert.rejects(store.withNoticeDelivery([claimed(ref)], async () => {}), /同步/);
    await assert.rejects(store.withNoticeDelivery([claimed(ref)], () => Promise.resolve()), /Promise/);

    const error = { code: 'source_invalid', stage: 'prepare', skuCode: 'sku-1', targetStoreId: 'temu:target-1',
        targetStoreName: 'target one', reason: 'first error'.repeat(500) };
    const marks = await Promise.all(Array.from({ length: 12 }, (_, n) => store.recordErrorNotice(ref,
        { ...error, targetStoreId: `temu:target-${n}` })));
    assert.equal(marks.filter(item => item.status === 'marked').length, 1);
    assert.equal(marks.filter(item => item.status === 'already_marked').length, 11);
    const first = await store.errorDetails(ref);
    assert.equal(first.sendBlocked, true);
    assert.equal(first.notice.truncated, true);
    assert.equal(first.notice.reason.length, 4000);
    const signature = await store.indexSignature();
    assert.equal((await store.recordErrorNotice(ref, { reason: 'second error' })).status, 'already_marked');
    assert.equal(await store.indexSignature(), signature);
    assert.deepEqual(await store.errorDetails(ref), first);
    const row = (await store.listOverview()).products[0];
    assert.equal((await store.listOverview()).blockedCount, 1);
    assert.equal(row.sendBlocked, true);
    assert.equal(row.blocked, true, '旧 HTTP 红标筛选也必须命中新通知');
    assert.equal(row.errorNotice.sourceInstanceId, ref.sourceInstanceId);
    assert.equal(row.errorNotice.noticeEpoch, ref.noticeEpoch, '列表摘要必须提供精确解除所需的预期代次');
    assert.equal(row.errorNotice.summary.length, 160);
    assert.equal(Object.hasOwn(row.errorNotice, 'reason'), false);
    let delivery = await store.withNoticeDelivery([claimed(ref)], value => value);
    assert.equal(delivery.claimed.length, 0);
    assert.equal(delivery.skippedBlocked.length, 1);

    // 同内容重传、无关导入以及投影合并不得洗掉首次通知和 UUID。
    assert.equal((await store.importFiles(uploads())).reused, true);
    assert.deepEqual(await store.errorDetails(ref), first);
    await store.importFiles(uploads('1234567892', 1, sourceStoreId, 'OTHER-CODE'));
    await store.importFiles(uploads(peerId));
    const [peer] = await store.noticeRefs(sourceStoreId, [peerId]);
    assert.equal(peer.sendBlocked, true, '同行未报错的原子商品也必须被过滤');
    assert.equal((await store.noticeRefs(sourceStoreId, [spuId]))[0].sourceInstanceId, ref.sourceInstanceId);
    delivery = await store.withNoticeDelivery([claimed(peer)], value => value);
    assert.equal(delivery.skippedBlocked.length, 1);
    assert.equal((await store.errorDetails(peer)).notice, null);
    const groupSignature = await store.indexSignature();
    assert.equal((await store.recordErrorNotice(peer, { reason: 'peer error must not replace first' })).status, 'already_marked');
    assert.equal(await store.indexSignature(), groupSignature);
    assert.equal((await store.listOverview()).blockedCount, 1);
    assert.equal((await store.getProduct(peerId)).product.sendBlocked, true);
    assert.equal((await store.getProduct(peerId)).product.blocked, true);
    assert.deepEqual((await store.getProduct(peerId)).product.errorNotice, (await store.getProduct(spuId)).product.errorNotice);

    // 人工解除按实例白名单约束；解除后旧代次不能再次标记。
    await assert.rejects(store.unblockErrorProducts({ sourceStoreId, spuIds: [spuId] }), error => error.code === 'notice_instance_required');
    await assert.rejects(store.unblockErrorProducts({ sourceStoreId, spuIds: [spuId], sourceInstanceIds: [ref.sourceInstanceId] }), error => error.code === 'notice_epoch_required');
    assert.equal((await store.unblockErrorProducts({ sourceStoreId, spuIds: [spuId, peerId],
        sourceInstanceIds: [peer.sourceInstanceId, ref.sourceInstanceId], noticeEpochs: [ref.noticeEpoch, peer.noticeEpoch] })).advanced, 0, '实例不能交叉匹配不同 SPU');
    assert.equal((await store.unblockErrorProducts({ sourceStoreId, spuIds: [spuId], sourceInstanceIds: ['wrong'], noticeEpochs: [ref.noticeEpoch] })).advanced, 0);
    assert.equal((await store.unblockErrorProducts({ sourceStoreId, spuIds: [spuId], sourceInstanceIds: [ref.sourceInstanceId], noticeEpochs: [ref.noticeEpoch + 1] })).advanced, 0);
    assert.equal((await store.unblockErrorProducts({ sourceStoreId, spuIds: [spuId], sourceInstanceIds: [ref.sourceInstanceId], noticeEpochs: [ref.noticeEpoch] })).cleared, 1);
    assert.equal((await store.unblockErrorProducts({ sourceStoreId, spuIds: [spuId], sourceInstanceIds: [ref.sourceInstanceId], noticeEpochs: [ref.noticeEpoch] })).advanced, 0, '旧解除请求不能再次推进代次或解除新标记');
    assert.equal((await store.recordErrorNotice(ref, error)).status, 'stale_or_deleted');
    assert.equal((await store.recordErrorNotice(peer, error)).status, 'stale_or_deleted', '解除后同行旧 token 也不能重标');
    await assert.rejects(store.withNoticeDelivery([claimed(ref)], value => value), error => error.code === 'notice_ref_stale');
    const [unblocked] = await store.noticeRefs(sourceStoreId, [spuId]);
    assert.equal(unblocked.noticeEpoch, ref.noticeEpoch + 1);
    assert.equal(unblocked.sendBlocked, false);
    assert.equal((await store.recordErrorNotice(unblocked, error)).status, 'marked');

    // 实际原包内容改变才换版本，UUID 保留、代次递增，迟到通知作废。
    const [versionPeer] = await store.noticeRefs(sourceStoreId, [peerId]);
    const changed = await store.importFiles(uploads(spuId, 2));
    const [newVersion] = await store.noticeRefs(sourceStoreId, [spuId]);
    assert.equal(newVersion.sourceInstanceId, ref.sourceInstanceId);
    assert.equal(newVersion.noticeEpoch, unblocked.noticeEpoch + 1);
    assert.equal(newVersion.sourceVersion, noticeSourceVersion(changed.batch.products[0]));
    assert.notEqual(newVersion.sourceVersion, ref.sourceVersion);
    assert.equal(newVersion.sendBlocked, false);
    assert.equal((await store.recordErrorNotice(unblocked, error)).status, 'stale_or_deleted');
    assert.equal((await store.recordErrorNotice(versionPeer, error)).status, 'stale_or_deleted', '同组修正资料后旧 peer 通知不能重新禁传');

    // 当前旧红标也必须禁传，但不伪造新版通知；交接重新读取，防止已准备的旧引用漏过滤。
    await store.markProductBlocked({ storeId: sourceStoreId, spuId, reason: 'legacy red' });
    assert.equal((await store.noticeRefs(sourceStoreId, [spuId]))[0].sendBlocked, true);
    assert.equal((await store.noticeRefs(sourceStoreId, [peerId]))[0].sendBlocked, true, '同行成员不能绕过红标');
    const legacyView = (await store.listOverview()).products.find(p => p.spuIds.includes(spuId));
    assert.equal(legacyView.sendBlocked, true);
    assert.equal(legacyView.errorNotice, null, '历史红标不伪造新版通知');
    assert.equal((await store.withNoticeDelivery([claimed(newVersion)], p => p)).claimed.length, 0, '旧引用也在实际交接时过滤');
    assert.equal((await store.recordErrorNotice(newVersion, error)).status, 'already_marked', '已红标不新增第二份通知');
    // 人工解除恢复资格，删除及重新上传也不能继承旧红标。
    const [legacyPeer] = await store.noticeRefs(sourceStoreId, [peerId]);
    await store.markProductBlocked({ storeId: sourceStoreId, spuId: peerId, reason: '同行旧红标' });
    assert.equal((await store.unblockProducts([spuId], new Set([sourceStoreId]))).cleared, 2, '解除主 SPU 必须同时清掉同行旧红标');
    const [afterLegacyClear] = await store.noticeRefs(sourceStoreId, [spuId]);
    assert.equal(afterLegacyClear.sendBlocked, false);
    assert.equal(afterLegacyClear.noticeEpoch, newVersion.noticeEpoch + 1, '同行两个红标批量解除只推进一次');
    assert.equal((await store.recordErrorNotice(newVersion, error)).status, 'stale_or_deleted');
    assert.equal((await store.recordErrorNotice(legacyPeer, error)).status, 'stale_or_deleted');
    assert.equal((await store.unblockProducts([spuId], new Set([sourceStoreId]))).cleared, 0);
    assert.equal((await store.noticeRefs(sourceStoreId, [spuId]))[0].noticeEpoch, afterLegacyClear.noticeEpoch);
    assert.equal((await store.recordErrorNotice(afterLegacyClear, error)).status, 'marked', '新引用仍可保存新首因');
    assert.equal((await store.recordErrorNotice(newVersion, { reason: '旧通知不能抢占新首因' })).status, 'stale_or_deleted');
    await store.markProductBlocked({ storeId: sourceStoreId, spuId, reason: 'legacy red' });
    await store.deleteProducts([spuId], null, { storeIds: [sourceStoreId] });
    assert.deepEqual(await store.noticeRefs(sourceStoreId, [spuId, peerId]), []);
    assert.equal((await store.recordErrorNotice(newVersion, error)).status, 'stale_or_deleted');

    // 同一个 SPU 改货号只是换资料，不能同时生成新旧两行或让旧投影覆盖当前正文。
    const renameStore = 'temu:rename-source', renameId = '9234567890';
    const renameOriginal = await store.importFiles(uploads(renameId, 1, renameStore, 'OLD-CODE'));
    const [renameBefore] = await store.noticeRefs(renameStore, [renameId]);
    const renamed = await store.importFiles(uploads(renameId, 2, renameStore, 'NEW-CODE'));
    const renameRows = (await store.listOverview()).products.filter(product => product.sourceStoreIds.includes(renameStore));
    assert.equal(renameRows.length, 1, '一个来源 SPU 不能因历史货号留两行');
    assert.equal(renameRows[0].articleNo, renamed.batch.products[0].articleNo);
    assert.deepEqual(renameRows[0].productExtCodes, ['NEW-CODE']);
    const renamedDetail = await store.getProduct(renameId);
    assert.equal(renamedDetail.product.publicationData.sourceBatchId, renamed.batch.id);
    assert.equal(renamedDetail.product.publicationData.sourceProduct.extCode, 'NEW-CODE');
    assert.equal((await store.recordErrorNotice(renameBefore, error)).status, 'stale_or_deleted');
    if (database) {
        // 合成旧版已落库的过期来源批次，显式迁移必须真正修复而不是只添加状态表。
        await database.query('maintenance', "UPDATE hub_products SET body=JSON_SET(body,'$.publicationData.sourceBatchId',?) WHERE store_id=?", [renameOriginal.batch.id, renameStore]);
        await store.rebuildNoticeProjection(renameStore);
        const fixed = (await store.listOverview()).products.find(product => product.sourceStoreIds.includes(renameStore));
        assert.equal(fixed.publicationData.sourceBatchId, renamed.batch.id);
    }
    await store.deleteStoreData(renameStore, { keepProducts: false });
    assert.deepEqual(await store.errorDetails(newVersion), { notice: null, sendBlocked: false });
    const recreated = await store.importFiles(uploads(spuId, 2));
    [ref] = await store.noticeRefs(sourceStoreId, [spuId]);
    assert.notEqual(ref.sourceInstanceId, newVersion.sourceInstanceId);
    assert.equal(ref.sourceVersion, noticeSourceVersion(recreated.batch.products[0]));
    assert.equal(ref.sendBlocked, false);
    assert.equal((await store.listOverview()).products.find(product => product.spuId === spuId).blocked, undefined);
    assert.equal((await store.recordErrorNotice(newVersion, error)).status, 'stale_or_deleted');

    // 目标源码归属隔离：其他来源的实例和标记不会被本来源删除或解除。
    const otherStore = 'temu:other-source';
    await store.importFiles(uploads('9876543210', 1, otherStore));
    const [other] = await store.noticeRefs(otherStore, ['9876543210']);
    // 同步交接完成后才到达的标记不撤回已交付正文，但下一次交付必须被过滤。
    const handedOff = await store.withNoticeDelivery([claimed(other)], payload => payload.claimed);
    await store.recordErrorNotice(other, error);
    assert.equal(handedOff.length, 1);
    assert.equal((await store.withNoticeDelivery([claimed(other)], payload => payload)).skippedBlocked.length, 1);
    await store.deleteStoreData(sourceStoreId, { keepProducts: false });
    assert.equal((await store.errorDetails(other)).sendBlocked, true);

    // 同行不同 SPU 并发只能首标记一次，解除要精确核对预期代次并使同行旧凭证全部失效。
    const raceStore = 'temu:notice-group-race', raceIds = ['7777777770', '7777777771'];
    for (const id of raceIds) await store.importFiles(uploads(id, 1, raceStore, 'GROUP-RACE'));
    const raceRefs = await store.noticeRefs(raceStore, raceIds);
    const races = await Promise.all(raceRefs.map((raceRef, n) => store.recordErrorNotice(raceRef, { ...error, reason: `group-first-${n}` })));
    assert.equal(races.filter(item => item.status === 'marked').length, 1);
    assert.equal(races.filter(item => item.status === 'already_marked').length, 1);
    const winningSpu = (await store.getProduct(raceIds[0])).product.errorNotice.spuId;
    const winner = raceRefs.find(item => item.spuId === winningSpu);
    const unlock = { sourceStoreId: raceStore, spuIds: [winner.spuId], sourceInstanceIds: [winner.sourceInstanceId], noticeEpochs: [winner.noticeEpoch] };
    assert.equal((await store.unblockErrorProducts({ ...unlock, noticeEpochs: [winner.noticeEpoch + 1] })).advanced, 0);
    assert.equal((await store.unblockErrorProducts(unlock)).advanced, 2);
    for (const oldRef of raceRefs) assert.equal((await store.recordErrorNotice(oldRef, error)).status, 'stale_or_deleted');
    const currentRace = await store.noticeRefs(raceStore, raceIds);
    assert.equal(currentRace.every(item => item.noticeEpoch === 1 && !item.sendBlocked), true);
    await store.recordErrorNotice(currentRace[0], error);
    assert.equal((await store.unblockErrorProducts(unlock)).advanced, 0);
    assert.equal((await store.noticeRefs(raceStore, raceIds)).every(item => item.sendBlocked), true);
    await store.deleteStoreData(raceStore, { keepProducts: false });

    if (database) {
        // 复用已有事务，不允许再取连接；回滚必须同时撤销首次标记与解除代次。
        const inventory = createMysqlInventory(database);
        await store.unblockErrorProducts({ sourceStoreId: otherStore, spuIds: [other.spuId], sourceInstanceIds: [other.sourceInstanceId], noticeEpochs: [other.noticeEpoch] });
        const [active] = await store.noticeRefs(otherStore, [other.spuId]);
        await assert.rejects(database.transaction('control', async connection => {
            const connected = { ...database, transaction: () => { throw Error('禁止另取连接'); } };
            const sharing = createStore(root, { database: connected });
            assert.equal(await sharing.withNoticeDelivery([claimed(active)], value => value.claimed.length, connection), 1);
            assert.equal((await sharing.recordErrorNotice(active, error, connection)).status, 'marked');
            throw Error('rollback probe');
        }), /rollback probe/);
        assert.equal((await store.errorDetails(active)).sendBlocked, false);
        const before = await inventory.versions();
        await store.recordErrorNotice(active, error);
        const marked = await inventory.versions();
        assert.notEqual(marked.all, before.all);
        await store.recordErrorNotice(active, error);
        assert.equal((await inventory.versions()).all, marked.all);
        const backfillRef = (await store.noticeRefs(otherStore, [other.spuId]))[0];
        await inventory.backfillNoticeStates();
        assert.deepEqual((await store.noticeRefs(otherStore, [other.spuId]))[0], backfillRef);
        // 真正执行离线迁移脚本两遍，验证可重跑且不会洗掉已有通知、UUID 或代次。
        for (let run = 0; run < 2; run++) {
            const migrated = await promisify(execFile)(process.execPath,
                [fileURLToPath(new URL('./migrate-product-notice-state.mjs', import.meta.url)), '--confirm-offline'],
                { env: { ...process.env, ZINIAO_DATA_ROOT: root, TEMU_MYSQL_CONFIG: path.join(root, 'mysql.json') }, windowsHide: true, timeout: 10000 });
            assert.equal(JSON.parse(migrated.stdout).migrated, true);
            assert.deepEqual((await store.noticeRefs(otherStore, [other.spuId]))[0], backfillRef);
        }
        const page = await store.listOverviewPage(null, new URL('http://example.invalid/?productLimit=100'));
        assert.equal(page.products[0].sendBlocked, true);
        assert.equal(page.blockedCount, 1);
        const markedPage = await store.listOverviewPage(null, new URL('http://example.invalid/?blocked=blocked'));
        assert.equal(markedPage.productTotal, 1);
        assert.equal(markedPage.products[0].sendBlocked, true);
        const normalPage = await store.listOverviewPage(null, new URL('http://example.invalid/?blocked=normal'));
        assert.equal(normalPage.productTotal, 0);
        assert.equal(Object.hasOwn(page.products[0].errorNotice, 'reason'), false);
    } else {
        // 无 MySQL 进程时仍核验连接注入边界；这是接口测试，不冒充真实数据库并发测试。
        const queries = [];
        const current = (await store.noticeRefs(otherStore, [other.spuId]))[0];
        const mockRow = { id: noticeStateKey(current.sourceStoreId, current.spuId),
            store_id: current.sourceStoreId, spu_id: current.spuId, instance_id: current.sourceInstanceId,
            source_version: current.sourceVersion, notice_epoch: String(current.noticeEpoch),
            product_codes: JSON.stringify(current.productCodes), notice: null, peer_blocked: 0, projection_id: 'test-projection' };
        const connection = { query: async (statement, params) => {
            queries.push(statement);
            if (statement.startsWith('SELECT n.*') || statement.startsWith('SELECT * FROM hub_product_notice_states')) return [[{ ...mockRow }]];
            if (statement.startsWith('SELECT id FROM hub_product_notice_states')) return [[]];
            if (statement.startsWith('SELECT blocked FROM hub_products')) return [[{ blocked: 0 }]];
            if (statement.startsWith('UPDATE hub_product_notice_states SET notice=?')) mockRow.notice = params[0];
            if (statement.startsWith('UPDATE hub_product_notice_states SET notice=NULL')) {
                mockRow.notice = null;
            }
            if (statement.startsWith('UPDATE hub_product_notice_states SET notice_epoch=')) {
                mockRow.notice_epoch = String(Number(mockRow.notice_epoch) + 1);
            }
            return [{ affectedRows: 1 }];
        } };
        const noPool = { transaction: () => { throw Error('不能另取连接'); },
            query: () => { throw Error('不能离开注入连接'); } };
        const injected = createStore(root, { database: noPool });
        assert.equal(await injected.withNoticeDelivery([claimed(current)], payload => payload.claimed.length, connection), 1);
        assert.equal(queries.filter(statement => statement.startsWith('SELECT n.*')).length, 1);
        assert.equal((await injected.recordErrorNotice(current, error, connection)).status, 'marked');
        assert.equal((await injected.recordErrorNotice(current, error, connection)).status, 'already_marked');
        assert.equal((await injected.unblockErrorProducts({ sourceStoreId: otherStore, spuIds: [other.spuId],
            sourceInstanceIds: [current.sourceInstanceId], noticeEpochs: [current.noticeEpoch] }, connection)).cleared, 1);
        assert.equal((await injected.recordErrorNotice(current, error, connection)).status, 'stale_or_deleted');
        await assert.rejects(injected.withNoticeDelivery([claimed(current)], payload => payload, connection), error => error.code === 'notice_ref_stale');
        assert.equal(queries.some(statement => /hub_inventory_payloads|SELECT.*body.*hub_products/.test(statement)), false, '仅按投影主键读红标，不能解压商品正文');
        const startupQueries = [];
        await assertMysqlReady({ query: async (lane, statement) => {
            startupQueries.push(statement);
            return statement.includes('SELECT version,state,data_root')
                ? [[{ version: 1, state: 'ready', data_root: root }]] : [[]];
        } }, root);
        assert.ok(startupQueries.some(statement => statement.includes('hub_product_notice_states') && statement.includes('source_version')));
        assert.equal(startupQueries.some(statement => /CREATE|ALTER|INSERT|UPDATE/.test(statement)), false);
        const persisted = JSON.parse(await readFile(path.join(root, 'data', 'index.json'), 'utf8'));
        assert.equal(persisted.noticeStates[noticeStateKey(otherStore, other.spuId)].sourceInstanceId, other.sourceInstanceId);
        assert.equal(Object.keys(persisted.blockedProducts || {}).length, 0);
        const restarted = createStore(root);
        assert.deepEqual(await restarted.noticeRefs(otherStore, [other.spuId]), await store.noticeRefs(otherStore, [other.spuId]));
    }
    console.log(JSON.stringify({ ok: true, backend: database ? 'mysql-isolated-33917' : 'file',
        checked: ['first-CAS', 'same-row-block', 'duplicate-import', 'new-version', 'epoch-unblock',
            'delete-recreate', 'legacy-red-filtering', 'synchronous-handoff', 'source-isolation'] }));
} finally {
    if (database) await database.close();
    if (admin) {
        if (databaseName) await admin.query(`DROP DATABASE ${databaseName}`);
        await admin.end();
    }
    // 只删除本脚本 mkdtemp 创建的目录，不使用用户资料路径或外部配置。
    await rm(root, { recursive: true, force: true });
}
