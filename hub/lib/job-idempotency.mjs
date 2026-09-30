import { createHash } from 'node:crypto';

/** 请求键限定到当前账户；同一键只能重放相同发送内容，不能借用其他账户的任务。 */
export function jobRequestIdentity(input, access) {
    if (!input.requestId) return null;
    if (!/^[a-zA-Z0-9:-]{16,180}$/.test(String(input.requestId))) throw Object.assign(Error('发送请求编号不合法'), { status: 400 });
    const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    return { id: 'req-' + digest([access?.principalId || access?.userId || 'operator', input.requestId]),
        hash: digest([input.sourceStoreId, input.targetStoreId, input.sourceBatchId, [...new Set(input.spuIds || [])].sort(),
            input.requireOnline === true, input.directCreate === true, input.complianceVersion, input.sameStoreConfirmed === true,
            input.expectedVersions ? (input.spuIds || []).map(id => [id, input.expectedVersions[id]]).sort(([a],[b]) => a.localeCompare(b)) : null]) };
}
