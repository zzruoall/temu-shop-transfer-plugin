import { createAccountWorkRepository } from './account-work-repository.mjs';
import { parseImportedFiles, redactSensitive } from './parse-capture.mjs';
import { transferHash, TRANSFER_HASH_ALGORITHM } from './transfer-integrity.mjs';

const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const fail = (code, status = 409) => Object.assign(Error(code), { code, status });

/** 上传授权和结算只使用服务端已受理的请求；客户端路径、临时账户猜测不能成为执行证据。 */
export function createAccountIngest({ database, staging, store, stagingBudget = null }) {
    const repo = createAccountWorkRepository(database);
    /** 同一事务冻结owner和认领代次，避免两次查询之间换人导致混合快照。 */
    async function ownershipOn(conn, storeId) {
        let row;
        try {
            [[row]] = await conn.query("SELECT body FROM hub_map_entries WHERE domain='ownership' AND entry_key=? FOR SHARE", [storeId]);
        } catch (error) {
            /**
             * 归属**查询故障**必须是 503（可重试），不能让它冒成 500。
             *
             * 500 表示"服务端有 bug"，会让客户端放弃重试；而这里只是依赖不可用。
             * 同时也不能当成"未认领"（403）——那会把数据库抖动误判成归属问题，
             * 商品被静默留在待确认里。
             */
            throw fail('source_store_ownership_unavailable', 503);
        }
        const assignment = parse(row?.body);
        if (!assignment?.ownerId || !assignment.claimedAt) throw fail('source_store_ownership_unconfirmed', 403);
        return assignment;
    }
    /** 领取和最终提交均复查已受理请求及当前归属；失效轮次不能靠文件仍存在继续执行。 */
    async function validateWork(conn, work) {
        if (work.direction !== 'ingest') throw fail('account_publish_not_connected', 503);
        const [[row]] = await conn.query('SELECT * FROM hub_ingest_requests WHERE id=? FOR UPDATE', [work.request_id]);
        const receipt = parse(row?.receipt);
        if (!row || row.status !== 'queued' || !receipt?.accountContext
            || receipt.accountContext.runId !== work.run_id || work.execution_run_id !== work.run_id
            || row.owner_id !== work.actor_id || receipt.accountContext.accountId !== work.account_id) {
            throw fail('ingest_execution_revoked');
        }
        const assignment = await ownershipOn(conn, work.store_id);
        if (assignment.ownerId !== work.account_id || assignment.claimedAt !== work.ownership_generation) {
            throw fail('ingest_ownership_changed', 403);
        }
    }
    /** 请求受理和逐商品工作必须同事务；中途冲突不能留下半个批次继续执行。 */
    async function accept({ lease, upload, verified, received = null }) {
        if (!lease || !lease.requestId) throw fail('account_ingest_permit_required', 428);
        if (!verified) throw fail('account_ingest_integrity_required', 422);
        const payload = received ? null : redactSensitive(upload.payload);
        const products = received ? received.productIds.map(spuId => ({ spuId }))
            : parseImportedFiles([{ originalName: upload.originalName, payload }]).products;
        if (!products.length) throw fail('no_products', 422);
        const staged = received?.staged || await staging.stage({ body: payload, originalName: upload.originalName });
        return database.transaction('ingest', async conn => {
            // 与取消/运行器保持相同首锁，防止受理与清理锁序相反导致死锁。
            await conn.query("INSERT INTO hub_queue_locks(id) VALUES('account-admission') ON DUPLICATE KEY UPDATE id=VALUES(id)");
            const assignment = await ownershipOn(conn, lease.storeId);
            // 冻结接收许可对应的认领代次，同一账户释放再认领也不得沿用此前许可。
            if (lease.accountContext && (assignment.ownerId !== lease.accountContext.accountId
                || assignment.claimedAt !== lease.accountContext.ownershipGeneration)) throw fail('ingest_ownership_changed', 403);
            if (stagingBudget) await stagingBudget.admitSource(conn, assignment.ownerId, staged.sourceRef, staged.expectedBytes, lease.storageId || '');
            const [[request]] = await conn.query('SELECT * FROM hub_ingest_requests WHERE id=? FOR UPDATE', [lease.id]);
            if (!request || request.owner_id !== lease.owner || request.status !== 'processing') throw fail('ingest_execution_revoked');
            await repo.assertQueueCapacity(conn, assignment.ownerId, products.length);
            const accountContext = { accountId: assignment.ownerId, runId: lease.requestId,
                storeId: lease.storeId, ownershipGeneration: assignment.claimedAt, actorId: lease.owner };
            let firstWorkId = '';
            for (const product of products) {
                const work = await repo.enqueueInTransaction(conn, {
                    accountId: assignment.ownerId, storeId: lease.storeId, direction: 'ingest',
                    requestId: lease.id, spuId: String(product.spuId), runId: lease.requestId, executionRunId: lease.requestId,
                    actorId: lease.owner, ownershipGeneration: assignment.claimedAt, ...staged
                });
                firstWorkId ||= work.work_id;
            }
            const receipt = { ok: true, accepted: true, state: 'queued', requestId: lease.requestId,
                accountContext, sourceStoreName: received?.sourceStoreName || upload?.sourceStoreName || upload?.shopName || lease.storeId,
                total: products.length, transferIntegrity: { algorithm: TRANSFER_HASH_ALGORITHM,
                    receivedSha256: request.request_hash, verified: false },
                accountWork: { enabled: true, enqueued: products.length, workId: firstWorkId } };
            await conn.query("UPDATE hub_ingest_requests SET status='queued',receipt=?,updated_at=? WHERE id=?",
                [JSON.stringify(receipt), new Date().toISOString(), lease.id]);
            // 私有授权上下文只存服务端，不作为客户端可修改的执行许可下发。
            const { accountContext: _context, ...response } = receipt;
            return response;
        });
    }
    /** worker已逐响应解析当前SPU，父端只提交有界单件索引并共享保存完整原包。 */
    async function commit({ work, result: preparedResult, connection }) {
        const prepared = await staging.prepared(work, preparedResult);
        const [[request]] = await connection.query('SELECT receipt FROM hub_ingest_requests WHERE id=? FOR UPDATE', [work.request_id]);
        const receipt = parse(request.receipt);
        const result = await store.importPreparedCapture(prepared, {
            sourceStoreId: work.store_id, sourceStoreName: receipt.sourceStoreName,
            source: 'account-runtime', ingestMaxProducts: 1, transactionConnection: connection
        });
        const saved = result.batch.products.find(product => String(product.spuId) === work.item_spu);
        const incoming = prepared.parsed.products[0];
        if (!saved || transferHash(saved.publicationData || null) !== transferHash(incoming?.publicationData || null)) {
            throw fail('ingest_product_integrity_mismatch', 422);
        }
        // importPreparedCapture已流式回读核对原包字节；不在父进程再次解析整包，不检查平台字段模板。
        const [[counts]] = await connection.query("SELECT COUNT(*) AS total,SUM(status='done') AS done FROM hub_account_work WHERE request_id=?", [work.request_id]);
        receipt.completed = Number(counts.done);
        receipt.batchId = result.batch.id;
        receipt.state = receipt.completed === Number(counts.total) ? 'completed' : 'queued';
        receipt.transferIntegrity.verified = receipt.state === 'completed';
        await connection.query('UPDATE hub_ingest_requests SET status=?,receipt=?,updated_at=? WHERE id=?',
            [receipt.state, JSON.stringify(receipt), new Date().toISOString(), work.request_id]);
    }
    /** 失败请求退出活跃准入计数；原始资料和失败证据仍保留用于核对。 */
    async function failed({ connection, work, reason }) {
        await connection.query("UPDATE hub_ingest_requests SET status='failed',receipt=JSON_SET(COALESCE(receipt,JSON_OBJECT()),'$.state','failed','$.reason',?),updated_at=? WHERE id=? AND status='queued'",
            [String(reason), new Date().toISOString(), work.request_id]);
    }
    return { accept, validateWork, commit, failed };
}
