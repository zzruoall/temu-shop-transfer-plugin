/** 文件分支的真实归属锁验收：标记与改派互斥，同账号重新认领也不能复活旧授权。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStoreOwnership } from '../lib/store-ownership.mjs';

test('标记关键区与改派互斥，归属回到旧账号后旧认领代次仍失效', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-failure-owner-'));
    try {
        const ownership = createStoreOwnership(root);
        const alice = { id: 'alice', username: '隔离甲' }, bob = { id: 'bob', username: '隔离乙' };
        await ownership.claim('source', alice);
        const snapshot = await ownership.findOwner('source');
        let entered, proceed;
        const started = new Promise(resolve => { entered = resolve; });
        const gate = new Promise(resolve => { proceed = resolve; });
        const marking = ownership.withStableOwners({ source: snapshot }, async () => {
            entered(); await gate;
            assert.equal((await ownership.findOwner('source')).ownerId, alice.id);
        });
        await started;
        let changed = false;
        const reassigning = ownership.reassign('source', bob).then(() => { changed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(changed, false, '标记写入完成前归属不能改派');
        proceed(); await marking; await reassigning;
        await assert.rejects(ownership.withStableOwners({ source: snapshot }, () => assert.fail('旧授权进入写入')), { status: 409 });
        await ownership.reassign('source', alice);
        assert.notEqual((await ownership.findOwner('source')).claimId, snapshot.claimId);
        await assert.rejects(ownership.withStableOwners({ source: snapshot }, () => assert.fail('旧授权被复活')), { status: 409 });
        const current = await ownership.findOwner('source');
        await ownership.claim('source', alice);
        assert.equal((await ownership.findOwner('source')).claimId, current.claimId, '重复确认现有认领不废弃正在使用的授权');
    } finally {
        // 仅删除本测试创建的系统临时目录，不触及共享归属文件。
        assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep));
        await rm(root, { recursive: true, force: true });
    }
});

test('跨类归并与库存写关键区互斥，转移后重新核验分类而非复用旧范围', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'temu-reclaim-owner-'));
    try {
        const ownership = createStoreOwnership(root);
        const tester = { id: 'tester', username: '测试', accountType: 'test' };
        const production = { id: 'production', username: '正式', accountType: 'production' };
        await ownership.claim('source', tester);
        await ownership.claim('target', tester);
        const snapshot = await ownership.snapshotDeliveryOwners(['source', 'target'], 'target', tester.id, 'test');
        await ownership.release('source', tester.id);
        let enter, proceed;
        const started = new Promise(resolve => { enter = resolve; });
        const gate = new Promise(resolve => { proceed = resolve; });
        // 已准入写操作完成前，重新认领必须等待；反过来转移先完成则旧分类不再取得写范围。
        const writing = ownership.withWriteScope({ type: 'test' }, async scope => {
            assert.equal(scope.has('source'), true); enter(); await gate;
        });
        await started;
        let changed = false;
        const claiming = ownership.claim('source', production).then(() => { changed = true; });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(changed, false);
        proceed(); await writing; await claiming;
        assert.equal((await ownership.withWriteScope({ type: 'test' }, scope => scope)).has('source'), false);
        assert.equal((await ownership.withWriteScope({ type: 'production', ownerId: production.id }, scope => scope)).has('source'), true);
        await assert.rejects(ownership.snapshotDeliveryOwners(['source', 'target'], 'target', tester.id, 'test'), { status: 403 });
        await assert.rejects(ownership.withStableOwners(snapshot, () => assert.fail('旧授权被接受')), { status: 409 });
    } finally {
        // 清理只接受本测试生成的临时子目录，不读取或修改线上归属记录。
        assert.equal(path.dirname(root), path.resolve(tmpdir()));
        await rm(root, { recursive: true, force: true });
    }
});
