/** 来源名称只作展示补全：精确店铺 ID 是唯一关联键，名字不参与身份、归属或分类判断。 */
export function sourceStoreNameCandidate(storeId, names) {
    const id = String(storeId || '').trim();
    return names.map(value => String(value || '').trim()).find(value => value && value !== id) || '';
}

/** 调用方先裁剪权限范围；目录从全部可见批次取首个有效名称，旧空批次不能覆盖已有名称。 */
export function sourceStoreDirectory(batches) {
    const names = new Map();
    for (const batch of batches) {
        const id = String(batch.sourceStoreId || '').trim();
        if (!id) continue;
        const name = sourceStoreNameCandidate(id, [batch.sourceStoreName, batch.shopName, batch.pageStoreName]);
        if (!names.has(id) || (names.get(id) === id && name)) names.set(id, name || id);
    }
    return [...names].map(([storeId, storeName]) => ({ storeId, storeName }));
}

/** 有效采集名称优先；目录只能补本范围内同一 ID 的缺名，ID 占位不算有效店名。 */
export function sourceStoreDisplayName(storeId, names, assignments = {}, scope = null) {
    const id = String(storeId || '').trim();
    if (id && scope && !scope.has(id)) return id;
    const explicit = sourceStoreNameCandidate(id, names);
    if (explicit) return explicit;
    // 调用方已过滤商品，但仍独立限制目录兜底，防止混合来源摘要泄露另一分类的店名。
    if (!id || (scope && !scope.has(id))) return id;
    return String(Object.hasOwn(assignments, id) ? assignments[id]?.storeName || id : id).trim() || id;
}

/** 只投影已授权总览的空名称，不改变商品、数量、来源 ID、批次原文或签名内容。 */
export function projectSourceStoreNames(overview, assignments, scope) {
    const batches = (overview.batches || []).map(batch => ({ ...batch,
        sourceStoreName: sourceStoreDisplayName(batch.sourceStoreId, [batch.sourceStoreName, batch.shopName, batch.pageStoreName], assignments, scope)
    }));
    const batchNames = new Map();
    for (const batch of batches) {
        const name = sourceStoreNameCandidate(batch.sourceStoreId, [batch.sourceStoreName]);
        if (name && !batchNames.has(batch.sourceStoreId)) batchNames.set(batch.sourceStoreId, name);
    }
    return {
        ...overview,
        batches,
        ...(overview.sourceStores ? { sourceStores: overview.sourceStores.map(item => ({ ...item,
            storeName: sourceStoreDisplayName(item.storeId, [item.storeName, batchNames.get(item.storeId)], assignments, scope)
        })) } : {})
    };
}
