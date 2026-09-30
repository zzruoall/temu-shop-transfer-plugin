/**
 * 步骤1：基线缺陷复现（修复前证据）。
 *
 * 目的不是证明"测试能跑"，而是用可断言的事实记录当前架构的四个缺口，
 * 作为后续实施与验收的对照基线。每项都输出可核对的数据，不写"看起来不对"这类结论。
 *
 * 本脚本只读代码与隔离库，不改业务代码、不连生产、不操作真实店铺。
 */
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTrace, createAccountFixture, createMockPlatform } from './account-process-harness.mjs';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const findings = [];
const record = (id, title, evidence, present) => {
    findings.push({ id, title, present, evidence });
    console.log(`${present ? '确认存在' : '未复现'} | ${id} ${title}`);
    console.log(`         ${evidence}`);
};

// 缺陷1：缺少账户专属子进程——业务执行路径里没有任何 fork。
// ziniao-cli.mjs 的 spawn 是命令行工具用法，不属于业务执行链，单独排除后判定。
{
    const files = (await readdir(path.join(rootDir, 'lib'))).filter(f => f.endsWith('.mjs'));
    const hits = [];
    for (const file of files) {
        const text = await readFile(path.join(rootDir, 'lib', file), 'utf8');
        if (/\bfork\s*\(/.test(text)) hits.push(file);
    }
    // 执行链模块单独核对：这些才是"账户专属进程"要替换的路径。
    const execChain = ['job-queue.mjs', 'bulk-dispatch.mjs', 'mysql-job-repository.mjs', 'account-scheduler.mjs', 'scheduling.mjs'];
    const execHits = [];
    for (const file of execChain) {
        const text = await readFile(path.join(rootDir, 'lib', file), 'utf8');
        if (/\bfork\s*\(|child_process/.test(text)) execHits.push(file);
    }
    record('D1', '执行链里没有账户专属子进程',
        `lib/ 下 ${files.length} 个模块中引用 fork 的：${hits.length ? hits.join(', ') : '无'}；执行链模块（${execChain.join('/')}）中：${execHits.length ? execHits.join(', ') : '全部无 fork'}`,
        execHits.length === 0);
}

// 缺陷2：旧入口账户遗漏——任务表不存账户，只能靠店铺反查，未认领即无归属。
{
    const text = await readFile(path.join(rootDir, 'lib', 'mysql-job-repository.mjs'), 'utf8');
    const hasAccountColumn = /account_id/.test(text);
    const scopeByStore = /source_store IN \(\?\) OR .*target_store IN \(\?\)/.test(text);
    record('D2', '任务表无账户列，归属靠店铺反查',
        `hub_jobs 含 account_id 列：${hasAccountColumn}；范围过滤仍按店铺：${scopeByStore}`,
        !hasAccountColumn && scopeByStore);
}

// 缺陷3：队列按店而非按账户——等待表主键是 store_id，排序按店铺先后。
{
    const text = await readFile(path.join(rootDir, 'lib', 'mysql-job-repository.mjs'), 'utf8');
    const waitPrimaryKeyStore = /CREATE TABLE IF NOT EXISTS hub_execution_wait \(store_id VARCHAR\(255\) PRIMARY KEY/.test(text);
    const orderByStore = /ORDER BY requested_at,store_id LIMIT \?/.test(text);
    record('D3', '等待队列按店铺先后，无账户维度',
        `等待表主键为 store_id：${waitPrimaryKeyStore}；排序按 requested_at,store_id：${orderByStore}`,
        waitPrimaryKeyStore && orderByStore);
}

// 缺陷4：内存降载分母错误——用整机内存当分母，而不是本服务的 cgroup 上限。
//
// 判定必须是**行为**而不是文本匹配：早先这里用 /cgroup|memory\.max/ 扫源码，
// 结果只要注释里提到 cgroup 就会被误判成"已修复"（源码里 os.totalmem() 仍在）。
// 现在实际构造控制器并注入一个"服务限额比例"，看重载是否真的按注入值降载。
{
    const { createSchedulingController } = await import('../lib/scheduling.mjs');
    const injected = createSchedulingController({ memoryRatioProvider: () => 0.95 });
    const result = injected.sample({ loopLagMs: 10 });
    injected.stop?.();
    // 注入 95% 服务内存 → 必须判为严重过载。旧实现忽略注入值、只认整机内存，这里会返回健康。
    const honorsServiceLimit = injected.usesServiceLimit === true && result.paused === true
        && result.reasonCode === 'server_overloaded';
    // 同时如实报告：源码里是否仍有整机内存作为兜底路径。
    const text = await readFile(path.join(rootDir, 'lib', 'scheduling.mjs'), 'utf8');
    const usesTotalMemFallback = /os\.totalmem\(\)/.test(text);
    record('D4', '降载分母用整机内存，而非服务 cgroup 上限',
        `按注入的服务限额降载：${honorsServiceLimit}；仍保留整机内存兜底：${usesTotalMemFallback}`,
        !honorsServiceLimit);
}

// 附加：验证"测试基座能否断言真实并发"——用轨迹模拟两个账户并行、各自 1 件。
{
    const trace = createTrace();
    const fixture = createAccountFixture();
    const platform = createMockPlatform(trace);
    const [a1, a2] = fixture.accounts;
    const store1 = a1.stores[0], store2 = a2.stores[0];
    // 模拟"两个账户各自的进程各执行一件商品"的理想形态。
    trace.process('fork', { accountId: a1.accountId, pid: 1001 });
    trace.process('fork', { accountId: a2.accountId, pid: 1002 });
    for (const [account, store, pid] of [[a1, store1, 1001], [a2, store2, 1002]]) {
        const workId = `w-${account.accountId}`;
        trace.work('start', { accountId: account.accountId, storeId: store.storeId, workId, pid, runId: `run-${account.accountId}` });
        await platform.create({ accountId: account.accountId, storeId: store.storeId, spuId: store.products[0].spuId,
            idempotencyKey: `${workId}/1`, runId: `run-${account.accountId}` });
        trace.work('settle', { accountId: account.accountId, workId });
        trace.process('exit', { accountId: account.accountId, pid });
    }
    const report = {
        maxChildrenObserved: trace.maxChildrenObserved(),
        maxAccountActiveObserved: trace.maxAccountActiveObserved(),
        duplicatePlatformCreates: trace.duplicatePlatformCreates(),
        crossAccountWrites: trace.crossAccountWrites(),
        oldRunStarts: trace.oldRunStarts(),
        serviceOrder: trace.serviceOrder()
    };
    assert.equal(report.maxChildrenObserved, 2, '基座应能观测到两个并发子进程');
    assert.equal(report.maxAccountActiveObserved, 1, '基座应能断言单账户只执行 1 件');
    assert.equal(report.duplicatePlatformCreates, 0, '基座应能断言无重复平台创建');
    console.log(`\n基座自检通过：报告可通过断言 ${JSON.stringify(report)}`);
    findings.push({ id: 'H1', title: '验收基座可断言进程数/账户唯一/提交次数/公平顺序', present: false,
        evidence: JSON.stringify(report) });
}

const confirmed = findings.filter(f => f.present).length;
console.log(JSON.stringify({
    step: 1,
    baselineDefects: findings.filter(f => ['D1', 'D2', 'D3', 'D4'].includes(f.id)),
    confirmedDefects: confirmed,
    harnessReady: true,
    realPlatformCalls: 0,
    productionChanged: false
}, null, 2));
// 基线脚本的职责是"记录缺口"，不是"要求缺口存在"：全部确认时退出码仍为 0，
// 由后续步骤的正式验收脚本负责断言缺口已被修复。
process.exit(0);
