/** 空来源名称投影使用精确目录键，隔离范围不因展示补全扩大。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { projectSourceStoreNames, sourceStoreDisplayName, sourceStoreDirectory } from '../lib/source-store-display.mjs';

test('空批次与SQL目录ID回退补同店名字，不改原对象或商品内容', () => {
    const id = 'temu:634418210693849';
    const overview = { products: [{ spuId: '8044560175' }], productCount: 1,
        batches: [{ id: 'old', sourceStoreId: id, sourceStoreName: '', shopName: '' }], sourceStores: [{ storeId: id, storeName: id }] };
    const before = structuredClone(overview);
    const result = projectSourceStoreNames(overview, { [id]: { storeName: 'Hair removal wax' } }, new Set([id]));
    assert.equal(result.batches[0].sourceStoreName, 'Hair removal wax');
    assert.equal(result.sourceStores[0].storeName, 'Hair removal wax');
    assert.equal(result.products, overview.products); assert.equal(result.productCount, 1); assert.deepEqual(overview, before);
});

test('显式店名不覆盖，缺失目录不按相似名字猜店，跨分类名称不可兜底', () => {
    const assignments = { 'temu:1': { storeName: '正式店' }, 'temu:2': { storeName: '测试店' } };
    assert.equal(sourceStoreDisplayName('temu:1', ['采集时名称'], assignments), '采集时名称');
    assert.equal(sourceStoreDisplayName('temu:3', [''], assignments), 'temu:3');
    assert.equal(sourceStoreDisplayName('temu:2', ['temu:2'], assignments, new Set(['temu:1'])), 'temu:2');
    assert.equal(sourceStoreDisplayName('temu:2', ['测试店'], assignments, new Set(['temu:1'])), 'temu:2');
    assert.equal(sourceStoreDisplayName('temu:1', [''], assignments, new Set()), 'temu:1');
});

test('目录解绑后批次仅有页面店名，商品行和来源筛选仍一致', () => {
    const result = projectSourceStoreNames({ batches: [{ sourceStoreId: 'temu:1', pageStoreName: '页头店名' }],
        sourceStores: [{ storeId: 'temu:1', storeName: 'temu:1' }] }, {}, new Set(['temu:1']));
    assert.equal(result.batches[0].sourceStoreName, '页头店名'); assert.equal(result.sourceStores[0].storeName, '页头店名');
});

test('全范围目录不被旧空名覆盖，当前页没有该店也保留名称和页面名称', () => {
    const directory = sourceStoreDirectory([{ sourceStoreId: 'temu:1', sourceStoreName: '较新名称' },
        { sourceStoreId: 'temu:1', sourceStoreName: '' }, { sourceStoreId: 'temu:2', pageStoreName: '页头名称' },
        { sourceStoreId: 'temu:2', sourceStoreName: 'temu:2' }]);
    const projected = projectSourceStoreNames({ batches: [{ sourceStoreId: 'temu:3' }], sourceStores: directory }, {}, new Set(['temu:1', 'temu:2', 'temu:3']));
    assert.deepEqual(projected.sourceStores, [{ storeId: 'temu:1', storeName: '较新名称' }, { storeId: 'temu:2', storeName: '页头名称' }]);
});
