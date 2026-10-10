/** 验收已发布的重新认领逻辑，只写随机临时夹具；不认领真实店铺、不修改线上商品或账户。 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStoreOwnership } from '../lib/store-ownership.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'temu-reclaim-v59-smoke-'));
try {
    const ownership = createStoreOwnership(root);
    const tester = { id: 'temporary-test', username: '隔离测试', accountType: 'test' };
    const production = { id: 'temporary-production', username: '隔离正式', accountType: 'production' };
    const original = await ownership.claim('temporary-source', tester);
    await ownership.release('temporary-source', tester.id);
    const moved = await ownership.claim('temporary-source', production);
    assert.equal(moved.ownerId, production.id);
    assert.notEqual(moved.claimId, original.claimId);
    assert.equal((await ownership.listDataDomains())['temporary-source'], 'production');
    await assert.rejects(ownership.claim('temporary-source', tester), { status: 409 });
    await assert.rejects(ownership.snapshotDeliveryOwners(['temporary-source'], 'temporary-source', tester.id, 'test'), { status: 403 });
    assert.equal((await ownership.withWriteScope({ type: 'test' }, scope => scope)).size, 0);
    await ownership.release('temporary-source', production.id);
    await ownership.claim('temporary-source', tester);
    assert.equal((await ownership.listDataDomains())['temporary-source'], 'test');
    console.log(JSON.stringify({ reclaimReleaseSmoke: true, bidirectionalTransfer: true, currentOwnerExclusive: true,
        staleCategoryDenied: true, productionWrites: 0, realPlatformCalls: 0 }));
} finally {
    // 清理前核验完整路径，绝不把外部输入作为递归删除目标。
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('temu-reclaim-v59-smoke-'));
    await rm(root, { recursive: true, force: true });
}
