/**
 * 步骤2/9 验收：模式就绪校验。
 *
 * 方案要求"迁移未完成时拒绝开启新模式"，且不允许静默降级：
 * - off 不读新表；
 * - shadow/on 在表缺失时抛错，不降级；
 * - on 在迁移完成后可正常开启。
 *
 * 只连隔离 MySQL（33917）。
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openIsolatedDatabase } from './account-process-harness.mjs';
import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { initializeMysqlSchema, assertAccountProcessMode } from '../lib/mysql-schema.mjs';
import { migrateAccountExecution } from '../lib/account-execution-schema.mjs';

const isolated = await openIsolatedDatabase({ prefix: 'temu_accproc_mode', label: '模式就绪' });
const root = await mkdtemp(path.join(tmpdir(), 'temu-accproc-mode-'));
await writeFile(path.join(root, 'mysql.json'), JSON.stringify({ host: '127.0.0.1', port: 33917, user: 'root', database: isolated.name }));
const database = await openMysqlDatabase(path.join(root, 'mysql.json'));
try {
    await initializeMysqlSchema(database);

    // 一、off 模式不依赖新表：迁移前也能启动。
    const off = await assertAccountProcessMode(database, 'off');
    assert.equal(off.mode, 'off', 'off 模式应直接返回');
    assert.equal(off.checked, false, 'off 模式不需要校验新表');

    // 二、迁移未完成时开启 shadow/on 必须被拒绝，且不能静默降级。
    for (const mode of ['shadow', 'on']) {
        let rejected = false, message = '';
        try { await assertAccountProcessMode(database, mode); }
        catch (error) { rejected = true; message = String(error.message); }
        assert.equal(rejected, true, `${mode} 模式在迁移未完成时必须被拒绝`);
        assert.match(message, /迁移|account_work|account_runtime/i, `拒绝原因应指向缺失的迁移，实际 ${message}`);
    }

    // 三、迁移完成后 on 模式可开启。
    await migrateAccountExecution(database);
    const on = await assertAccountProcessMode(database, 'on');
    assert.equal(on.mode, 'on', '迁移完成后 on 模式应可用');
    assert.equal(on.checked, true, 'on 模式应确认已校验新表');
    assert.equal(typeof on.supervisorEpoch, 'number', '应读取到监督器代次');

    // 四、非法模式值必须**明确报错**，不能静默降级。
    // 计划任务1 的要求：悄悄退回 off 会让运维以为新模式已开、实际仍在旧路径；
    // 悄悄规范化成 on 又会打开没准备好的执行链。两种都属于模式失真。
    let invalidRejected = false;
    try { await assertAccountProcessMode(database, 'yes-please'); }
    catch (error) { invalidRejected = error.code === 'account_mode_invalid'; }
    assert.equal(invalidRejected, true, '非法模式值必须抛 account_mode_invalid');
    // 大小写变体同样非法：不做"顺手规范化"，因为拼错的值应当被发现。
    let caseRejected = false;
    try { await assertAccountProcessMode(database, 'ON'); }
    catch (error) { caseRejected = error.code === 'account_mode_invalid'; }
    assert.equal(caseRejected, true, '大小写变体必须被判非法');

    console.log(JSON.stringify({
        passed: true,
        offWithoutMigration: true,
        shadowRejectedBeforeMigration: true,
        onRejectedBeforeMigration: true,
        onEnabledAfterMigration: true,
        invalidModeRejected: true,
        realPlatformCalls: 0
    }));
} finally {
    await database.close?.();
    await isolated.drop();
}
