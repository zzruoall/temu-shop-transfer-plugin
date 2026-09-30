/** 账户链新增回归串行执行，避免多个测试库连接池同时争用隔离MySQL。 */
import { spawn } from 'node:child_process';
const scripts = [
    'verify-account-process-identity.mjs', 'verify-capture-stream.mjs', 'verify-stream-ingest.mjs',
    'verify-plugin-account-ingest.mjs', 'verify-staging-budget.mjs', 'verify-account-recovery.mjs',
    'verify-account-runtime-safety.mjs', 'verify-account-ingest-safety.mjs', 'verify-account-history-safety.mjs',
    'verify-account-publish-bridge-no-db.mjs', 'verify-account-publish-bridge.mjs', 'verify-account-workflow.mjs'
];
for (const script of scripts) {
    console.log(`\n[account-completion] ${script}`);
    const exitCode = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [new URL(script, import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')], { stdio: 'inherit', windowsHide: true });
        child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
    });
    if (exitCode !== 0) process.exit(exitCode);
}
console.log('账户链新增回归全部通过；不代表真实平台压力或Linux容量验收。');
