import { createHash, randomUUID } from 'node:crypto';
import { canonicalProductSnapshot } from './job-queue.mjs';
import { transferHash } from './transfer-integrity.mjs';

// 来源实例独立于可重建的商品投影；DDL 只能在明确停服的迁移工具中执行。
export const PRODUCT_NOTICE_SCHEMA = [`CREATE TABLE IF NOT EXISTS hub_product_notice_states (
    id CHAR(64) PRIMARY KEY, store_id VARCHAR(255) NOT NULL, spu_id VARCHAR(255) NOT NULL,
    instance_id CHAR(36) NOT NULL, source_version CHAR(64) NOT NULL, notice_epoch BIGINT NOT NULL,
    product_codes JSON NOT NULL, notice JSON NULL, projection_id CHAR(64) NULL,
    INDEX(store_id,spu_id), INDEX(projection_id), UNIQUE KEY(instance_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`];

export const PRODUCT_NOTICE_REQUIRED_COLUMNS = Object.freeze({
    hub_product_notice_states: ['id', 'store_id', 'spu_id', 'instance_id', 'source_version',
        'notice_epoch', 'product_codes', 'notice', 'projection_id']
});

/** 数据库主键只定位来源原子商品，删除后重建主键相同但实例 UUID 必须不同。 */
export function noticeStateKey(sourceStoreId, spuId) {
    return createHash('sha256').update(JSON.stringify([String(sourceStoreId || '').trim(), String(spuId || '').trim()])).digest('hex');
}

/** 与发送协议共享规范快照；不得从合并后的列表摘要推导版本。 */
export function noticeSourceVersion(product) {
    return transferHash(canonicalProductSnapshot(product));
}

/** 货号只供展示，不参与授权或实例定位；商品货号优先，缺失时才取 SKU 货号。 */
export function noticeProductCodes(product) {
    const primary = [product.articleNo, ...(product.productExtCodes || [])];
    const values = primary.some(value => String(value || '').trim()) ? primary
        : [...(product.skuExtCodes || []), ...(product.skus || []).map(sku => sku.extCode)];
    return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))].sort();
}

/** 选择各 SPU 实际可发布的原始来源，与投影的完整发布资料优先规则保持一致。 */
export function noticeRawSources(batches) {
    const sources = new Map();
    for (const batch of batches || []) {
        const sourceStoreId = String(batch.sourceStoreId || '').trim();
        if (!sourceStoreId) continue;
        for (const product of batch.products || []) {
            const spuId = String(product.spuId || '').trim();
            if (!spuId) continue;
            const key = noticeStateKey(sourceStoreId, spuId), prior = sources.get(key);
            // 后续缺少完整资料的样本不能替换已经选中的完整原包。
            if (!prior || (!prior.product.publicationData?.sourceProduct && product.publicationData?.sourceProduct)) {
                sources.set(key, { sourceStoreId, spuId, product });
            }
        }
    }
    return sources;
}

/** 内容相同保留首次标记；资料换版同时作废新旧归并组的旧通知，不能让 peer 迟到重标。 */
export function refreshNoticeStates(states, batches) {
    const previousStates = Object.entries(states), changed = new Set(), replacements = [];
    for (const [key, source] of noticeRawSources(batches)) {
        const sourceVersion = noticeSourceVersion(source.product), previous = states[key];
        if (previous?.sourceVersion === sourceVersion) continue;
        states[key] = { sourceStoreId: source.sourceStoreId, spuId: source.spuId,
            sourceInstanceId: previous?.sourceInstanceId || randomUUID(), sourceVersion,
            noticeEpoch: previous ? previous.noticeEpoch + 1 : 0,
            productCodes: noticeProductCodes(source.product), notice: null };
        changed.add(key);
        if (previous) replacements.push(key);
    }
    if (!replacements.length) return [...changed];
    // 新旧货号和旧投影都连接同一 SPU；只推进相关成员，不扫描执行任务或清掉 peer 的既有错误事实。
    const groups = new Map(), memberships = new Map();
    for (const [key, state] of [...previousStates, ...Object.entries(states)]) {
        const names = (state.productCodes || []).map(code => JSON.stringify([state.sourceStoreId, 'code', code]));
        if (state.projectionId) names.push(JSON.stringify([state.sourceStoreId, 'projection', state.projectionId]));
        for (const name of names) {
            if (!groups.has(name)) groups.set(name, new Set());
            groups.get(name).add(key);
            if (!memberships.has(key)) memberships.set(key, new Set());
            memberships.get(key).add(name);
        }
    }
    const pending = [...replacements], visited = new Set(), walkedGroups = new Set();
    for (let i = 0; i < pending.length; i++) {
        const key = pending[i];
        if (visited.has(key)) continue;
        visited.add(key);
        if (!changed.has(key) && states[key]) { states[key].noticeEpoch++; changed.add(key); }
        for (const name of memberships.get(key) || []) {
            if (walkedGroups.has(name)) continue;
            walkedGroups.add(name); pending.push(...groups.get(name));
        }
    }
    return [...changed];
}

/** 引用只包含当前实例的小型身份字段，完整错误原因不会随领取正文或商品列表流出。 */
export function noticeRef(state) {
    if (!state) return null;
    const { sourceStoreId, spuId, sourceInstanceId, sourceVersion, noticeEpoch, productCodes } = state;
    return { sourceStoreId, spuId, sourceInstanceId, sourceVersion, noticeEpoch,
        sendBlocked: Boolean(state.notice), productCodes: [...productCodes] };
}

/** 代次也参与比较，防止人工解除后同一快照的迟到通知再次标记。 */
export function noticeRefMatches(state, ref) {
    return Boolean(state && ref && state.sourceStoreId === ref.sourceStoreId && state.spuId === ref.spuId
        && state.sourceInstanceId === ref.sourceInstanceId && state.sourceVersion === ref.sourceVersion
        && state.noticeEpoch === ref.noticeEpoch);
}

/** 解除必须逐项精确绑定 SPU、实例和预期代次，禁止同行 UUID 通配或旧页面重复解除。 */
export function noticeUnblockTargets({ spuIds, sourceInstanceIds, noticeEpochs }) {
    if (!Array.isArray(spuIds) || !spuIds.length || !Array.isArray(sourceInstanceIds)
        || sourceInstanceIds.length !== spuIds.length) {
        throw Object.assign(Error('解除商品通知必须逐项提供来源实例 ID'), { status: 400, code: 'notice_instance_required' });
    }
    if (!Array.isArray(noticeEpochs) || noticeEpochs.length !== spuIds.length
        || noticeEpochs.some(epoch => !Number.isSafeInteger(epoch) || epoch < 0)) {
        throw Object.assign(Error('解除商品通知必须逐项提供预期通知代次'), { status: 400, code: 'notice_epoch_required' });
    }
    const targets = new Map();
    for (let i = 0; i < spuIds.length; i++) {
        const spuId = String(spuIds[i] || ''), instanceId = String(sourceInstanceIds[i] || '');
        const noticeEpoch = noticeEpochs[i], previous = targets.get(spuId);
        if (!spuId || !instanceId || (previous && (previous.sourceInstanceId !== instanceId || previous.noticeEpoch !== noticeEpoch))) {
            throw Object.assign(Error('解除商品通知的 SPU 与实例对应关系无效'), { status: 400, code: 'notice_instance_required' });
        }
        targets.set(spuId, { sourceInstanceId: instanceId, noticeEpoch });
    }
    return targets;
}

/** 错误分类由协议入口承担；存储层只保留有界文本，避免插件任意正文撑大元数据。 */
export function boundedErrorNotice(error = {}) {
    const limits = { code: 100, stage: 100, skuCode: 255, targetStoreId: 255, targetStoreName: 255, reason: 4000 };
    const notice = { at: new Date().toISOString(), truncated: Boolean(error.truncated) };
    for (const [field, limit] of Object.entries(limits)) {
        const value = String(error[field] || '');
        notice[field] = value.slice(0, limit);
        if (value.length > limit) notice.truncated = true;
    }
    return notice;
}

/** 列表只给摘要，完整原因必须通过受权限约束的详情接口查询。 */
export function noticeSummary(state) {
    if (!state?.notice) return null;
    const { code, stage, skuCode, targetStoreId, targetStoreName, at, truncated, reason } = state.notice;
    return { sourceStoreId: state.sourceStoreId, spuId: state.spuId, sourceInstanceId: state.sourceInstanceId, noticeEpoch: state.noticeEpoch,
        summary: reason.slice(0, 160), code, stage, skuCode, targetStoreId, targetStoreName, at, truncated };
}

/** 当前行只要有历史红标或新版异常就停止分发；历史原因不伪造为新版通知事实。 */
export function applyNoticeViews(products, states) {
    for (const product of products) {
        // 页面增量状态只可应用于同一组真实来源实例；标红和解除不换身份，重导及归并变化会换身份。
        const identities = (product.sourceStoreIds || []).flatMap(storeId => (product.spuIds || [product.spuId])
            .map(spuId => {
                const state = states[noticeStateKey(storeId, spuId)];
                return [String(storeId), String(spuId), state?.sourceInstanceId || '', state?.sourceVersion || ''];
            })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
        product.sourceIdentity = identities.some(item => item[2])
            ? createHash('sha256').update(JSON.stringify([identities, [...(product.batchIds || [])].sort()])).digest('hex') : '';
        // 投影主键用于有界索引查询；仅是定位键，接口仍须核对账户范围与来源实例。
        product.productKey = createHash('sha256').update(JSON.stringify([product.sourceStoreIds || [],
            product.spuIds || [product.spuId], product.sourceStoreIds?.[0] ? null : product.batchIds])).digest('hex');
        const marked = (product.sourceStoreIds || []).flatMap(storeId => (product.spuIds || [product.spuId])
            .map(spuId => states[noticeStateKey(storeId, spuId)]).filter(state => state?.notice));
        marked.sort((a, b) => a.notice.at.localeCompare(b.notice.at) || a.sourceInstanceId.localeCompare(b.sourceInstanceId));
        product.sendBlocked = Boolean(product.blocked) || marked.length > 0;
        product.errorNotice = noticeSummary(marked[0]);
    }
    return products;
}

/** 状态读取不暴露正文或新实例；删除、权限丢失及来源换版统一让旧选择失效。 */
export function productStatusResponse(requested, products) {
    const current = new Map(products.map(product => [String(product.spuId), product]));
    const result = { products: [], staleIds: [] };
    for (const ref of requested) {
        const product = current.get(ref.spuId);
        if (!product || !product.sourceIdentity || product.sourceIdentity !== ref.sourceIdentity || product.productKey !== ref.productKey) {
            result.staleIds.push(ref.spuId);
            continue;
        }
        result.products.push({ spuId: ref.spuId, sourceIdentity: product.sourceIdentity,
            blocked: Boolean(product.blocked || product.sendBlocked), sendBlocked: Boolean(product.sendBlocked),
            blockedReason: String(product.blockedReason || '').slice(0, 4000), blockedAt: product.blockedAt || null,
            errorNotice: product.errorNotice || null });
    }
    return result;
}

/** 统一页面红色状态；仅覆盖返回视图，实际发送须从来源锁内的当前资格复核。 */
export function noticeDisplayProduct(product) {
    return product.sendBlocked ? { ...product, blocked: true } : product;
}

/** 交付只允许当前引用；过期引用明确拒绝，禁传项单独返回供调用方说明跳过原因。 */
export function filterNoticeDelivery(claimed, refs) {
    const current = new Map(refs.map(ref => [noticeStateKey(ref.sourceStoreId, ref.spuId), ref]));
    const allowed = [], skippedBlocked = [];
    for (const item of claimed) {
        const ref = item.sourceNoticeRef;
        // 仅保留旧内部调用的兼容性；新版协议入口必须强制携带引用。
        if (!ref) { allowed.push(item); continue; }
        const state = current.get(noticeStateKey(item.sourceStoreId, item.spuId));
        if (!noticeRefMatches(state, ref) || ref.sourceStoreId !== item.sourceStoreId || ref.spuId !== String(item.spuId)) {
            throw Object.assign(Error('来源商品已换版、解除或删除，请重新发送'), { status: 409, code: 'notice_ref_stale' });
        }
        (state.sendBlocked ? skippedBlocked : allowed).push(item);
    }
    return { claimed: allowed, skippedBlocked };
}

/** 持锁回调必须同步交接，拒绝异步函数和 Promise，不能等接收页面连接。 */
export function deliverNoticeNow(deliver, payload) {
    if (typeof deliver !== 'function' || deliver.constructor?.name === 'AsyncFunction') {
        throw new TypeError('商品交付回调必须是同步函数');
    }
    const result = deliver(payload);
    if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw new TypeError('商品交付回调不能返回 Promise');
    }
    return result;
}
