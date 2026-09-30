/**
 * 账户资源边界聚合入口：把复核探针纳入正式链，避免"只测新库两次"式的自证。
 *
 * 这两组探针分别来自两轮独立复核，覆盖的正是**容易被测试自身掩盖**的接线错误：
 * 数据库 lane 拼写、CREATE TABLE IF NOT EXISTS 不升级旧表、并发与租期边界、
 * 以及 pick 契约变更后各调用方是否都记了账。
 *
 * 任一子脚本失败即整体失败；不允许把环境缺失当成通过。
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const scripts = [
    'output/reviews/account-resource-integration-independent-probes.mjs',
    'output/reviews/account-resource-followup-probes.mjs',
    // 任务 0–2 复核的独立反例：结算绕过、缺工作假结算、指定领取被忽略。
    'output/reviews/task012-independent-probes.mjs',
    // 第二次复核的独立反例：waiting 续接、源文件三契约、bulk 门控。
    'output/reviews/task012-second-review-probes.mjs',
    // 第三次复核的独立反例：文件生命周期三路径 + 阶段归一化门控。
    'output/reviews/task012-third-review-file-lifecycle.mjs',
    'output/reviews/task012-third-review-gates.mjs'
];
const results = [];
let failed = 0;
for (const relative of scripts) {
    const full = path.join(repoRoot, relative);
    const run = spawnSync(process.execPath, [full], { cwd: repoRoot, encoding: 'utf8' });
    const passed = run.status === 0;
    if (!passed) failed += 1;
    results.push({ script: relative, passed, exitCode: run.status,
        // 只保留失败原因片段：完整输出另有结果 JSON，不在这里重复打印正文。
        tail: passed ? '' : String(run.stdout || run.stderr || '').slice(-600) });
}
console.log(JSON.stringify({ passed: failed === 0, results, failedCount: failed, realPlatformCalls: 0 }, null, 1));
process.exit(failed === 0 ? 0 : 1);
