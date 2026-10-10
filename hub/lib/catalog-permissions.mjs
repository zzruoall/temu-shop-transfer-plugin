/** 删除入口按服务端写权限逐行投影；共享可读不代表可删除，未知来源默认不开放。 */
export function canDeleteCatalogProduct(product, writeScope) {
    const sources = Array.isArray(product?.sourceStoreIds) ? product.sourceStoreIds : [];
    return sources.length > 0 && sources.every(id => typeof id === 'string' && id.trim()
        && (writeScope === null || writeScope.has(id)));
}

/** 权限只属于本次响应，不写入采集包；删除接口仍会在实际请求时重新检查归属。 */
export function projectCatalogPermissions(overview, writeScope) {
    return { ...overview, products: (overview.products || []).map(product => ({ ...product,
        canDelete: canDeleteCatalogProduct(product, writeScope) })) };
}
