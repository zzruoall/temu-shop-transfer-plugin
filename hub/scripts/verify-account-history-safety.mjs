/** 历史迁移反例：当前认领只能帮助核对，绝不能成为重放旧任务的授权。 */
import assert from 'node:assert/strict';
import { isolateUnownedHistory, classifyLegacyAccountWork } from '../lib/account-execution-schema.mjs';

const writes = [];
const database = { query: async (_lane, sql, params) => {
    if (sql.includes('FROM hub_jobs')) return [[{ id: 'old-publish', source_store: 'source', target_store: 'target',
        status: 'queued', record_group: 'active', body: { status: 'queued', attemptId: 'keep-me' }, summary: { status: 'queued' } }]];
    if (sql.includes('information_schema')) return [[{ n: 1 }]];
    writes.push({ sql, params });
    return [{ affectedRows: 1 }];
} };
await isolateUnownedHistory(database, { source: { ownerId: 'source-owner' }, target: { ownerId: 'target-owner' } });
assert.ok(writes.some(item => item.sql.includes("status='needs_confirmation'")), '有当前认领也必须隔离旧queued');
assert.ok(!writes.some(item => item.params?.includes('source-owner')), '上架不能归给来源账户');
const update = writes.find(item => item.sql.includes("status='needs_confirmation'"));
const body = update.params.map(value => { try { return JSON.parse(value); } catch { return null; } }).find(value => value?.attemptId);
assert.equal(body.attemptId, 'keep-me');
assert.equal(body.status, 'needs_confirmation');
writes.length = 0;
await classifyLegacyAccountWork(database);
const classification = writes.find(item => item.sql.includes('UPDATE hub_account_work')).sql;
for (const column of ['run_id', 'execution_run_id', 'actor_id', 'ownership_generation', 'source_ref', 'source_hash', 'expected_bytes']) {
    assert.ok(classification.includes(column), `缺少${column}也必须隔离`);
}
assert.ok(classification.includes("status IN ('queued','waiting')"), '未知和终态证据不得改写');
console.log('历史隔离安全边界通过');
