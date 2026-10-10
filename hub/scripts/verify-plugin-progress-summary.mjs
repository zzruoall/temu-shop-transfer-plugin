/** 执行内容脚本的真实汇总、渲染与推送快照函数；所有消息只进内存夹具，不访问平台或修改浏览器存储。 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../../plugin/content-app.js", import.meta.url), "utf8");

/** 按内容脚本的顶层缩进提取原函数，缺失或重复立即报错，防止用测试中的替身实现掩盖回归。 */
function sourceFunction(name) {
    const declaration = new RegExp(`^    (?:async )?function ${name}\\(`, "gm");
    const matches = [...source.matchAll(declaration)];
    assert.equal(matches.length, 1, `真实函数 ${name} 必须唯一`);
    const start = matches[0].index;
    const tail = source.slice(start);
    const end = /^    }\r?$/m.exec(tail);
    assert.ok(end, `真实函数 ${name} 必须有顶层结束边界`);
    return tail.slice(0, end.index + end[0].length);
}

/** 只实现真实 render 使用的 DOM 操作，未知选择器直接失败，避免新渲染依赖被静默忽略。 */
class MinimalElement {
    constructor(attributes = {}) {
        this.textContent = "";
        this.hidden = false;
        this.disabled = false;
        this.style = {};
        this.attributes = new Map(Object.entries(attributes));
        this.children = new Map();
        this.stages = [];
        const classes = new Set();
        this.classList = {
            add: (...names) => names.forEach(name => classes.add(name)),
            remove: (...names) => names.forEach(name => classes.delete(name)),
            contains: name => classes.has(name),
            toggle: (name, force = !classes.has(name)) => {
                if (force) classes.add(name);
                else classes.delete(name);
                return force;
            }
        };
    }

    /** 已知节点预先注册，确保断言读到的就是本次真实渲染写入的节点。 */
    querySelector(selector) {
        assert.ok(this.children.has(selector), `未实现的 DOM 选择器：${selector}`);
        return this.children.get(selector);
    }

    /** 阶段轨道保持固定节点，不由期望结果生成高亮。 */
    querySelectorAll(selector) {
        assert.equal(selector, ".stage");
        return this.stages;
    }

    /** 阶段名称由固定模板属性提供，不依赖任务状态。 */
    getAttribute(name) {
        return this.attributes.get(name) ?? null;
    }

    /** 保留采集进度的可访问属性，验证接口进度变更不会覆盖另一条进度。 */
    setAttribute(name, value) {
        this.attributes.set(name, String(value));
    }
}

/** 商品数据保持合成值；status 故意沿用 received，覆盖失败仍滞留在旧接收状态的真实问题。 */
function directTask(spuId, directState, overrides = {}) {
    return { jobId: "fixture-job", spuId: String(spuId), targetStoreId: "temu:123",
        directCreate: true, directState, status: "received", ...overrides };
}

/** 隔离非目标采集功能；汇总、任务选择、单件阶段、render、同步与重试均加载真实源码。 */
function createHarness(tasks = []) {
    const root = new MinimalElement();
    const selectors = ["status", "capture-status", "expected", "source", "removed", "declared", "completed",
        "coverage", "selected-count", "progress", "progress-bar", "captured", "saved", "added", "duplicates",
        "failed", "productFailures", "total", "latest", "ingest", "ingest-status", "agent-status",
        "transfer-status", "head-stage", "transfer-progress", "transfer-pause", "transfer-retry",
        "transfer-cancel", "transfer-export", "transfer-errors", "message"];
    for (const selector of selectors) root.children.set(`.${selector}`, new MinimalElement());
    root.children.set('.error-dialog', null);
    const progress = root.querySelector(".transfer-progress");
    progress.children.set(".transfer-progress-percent", new MinimalElement());
    progress.children.set(".transfer-progress-detail", new MinimalElement());
    progress.stages = ["duplicate_check", "authorizing", "submitting", "qualifying", "created"]
        .map(stage => new MinimalElement({ "data-stage": stage }));
    const messages = [];
    const identity = { storeId: "temu:123", pageStoreName: "回归测试店", storeName: "回归测试店" };
    const replies = { receivedCount: 0, directPaused: false };
    let api;
    const ctx = vm.createContext({
        console, fixtureRoot: root, document: { body: { innerText: identity.pageStoreName } },
        location: { origin: "https://fixture.invalid", pathname: "/goods/list" },
        currentPageIdentity: () => ({ ...identity }), getPageContextKey: () => "fixture-page",
        expectedProductCount: () => 4, matchedProductCount: () => 2, statusClass: () => "off",
        captureStatusText: () => "未启动", coverageText: () => "2/4", progressPercent: () => 50,
        ingestStatusText: () => "未配置", ingestCoreText: () => "未配置", ingestStatusClass: () => "off",
        syncCaptureButtons: () => {}, syncInterfaceDiagnosticControls: () => {}, publishPublicStatus: () => {},
        TemuStoreIdentity: { namesMatch: (a, b) => a === b },
        chrome: { runtime: { sendMessage: async message => {
            messages.push(structuredClone(message));
            if (message.type === "recordOperation") return { ok: true };
            if (message.type === "getBoundStore") return { ok: true, store: { ...identity } };
            if (message.type === "reconcileTargetUploadTasks" || message.type === "getTargetUploadTasks") {
                return { ok: true, tasks: api.state.transferTasks, directPaused: replies.directPaused };
            }
            if (message.type === "retryDirectTask") return { ok: true };
            throw new Error(`夹具禁止的消息：${message.type}`);
        } } }
    });
    const stateStart = source.indexOf("    const state = {");
    const stateEnd = source.indexOf("    let ingestSettings", stateStart);
    assert.ok(stateStart >= 0 && stateEnd > stateStart, "必须加载真实 state 初始对象");
    const functions = ["logOperation", "send", "directTaskOutcome", "currentStoreTransferTasks", "currentTransferTask",
        "directBatchProgress", "directBatchSummary", "directProgressView", "render", "applyStoreAgentSnapshot",
        "refreshTargetUploadTasks", "retryUnknownDirectTask", "directErrorEntries", "directErrorsText", "closeForeignErrorDialog"].map(sourceFunction).join("\n");
    vm.runInContext(`${source.slice(stateStart, stateEnd)}
        let root = fixtureRoot, boundStore = {}, mappedStore = {}, pluginInstanceId = "";
        let agentState = { phase: "claimed", detail: "正在自动创建", claimed: 0 };
        let ingestState = { phase: "idle" }, lastOperationState = "";
        let targetViewEpoch = 0, directPauseBusy = false;
        let subscribedStoreId = '', lastStoreSequence = 0;
        let storeSnapshotEnabled = true;
        let sharedConnection = {phase:'connected',detail:'已连接'};
        const isWorkPage = () => true;
        ${functions}
        globalThis.api = { state, currentStoreTransferTasks, currentTransferTask, directBatchProgress,
            directBatchSummary, directProgressView, render, applyStoreAgentSnapshot, retryUnknownDirectTask, directErrorEntries, directErrorsText,
            pushSnapshot: () => applyStoreAgentSnapshot({storeId:'temu:123',mallId:'123',storeName:'回归测试店',
                executionMode:'plugin-api',identityMatched:true,sequence:lastStoreSequence+1,tasks:state.transferTasks,
                directPaused:state.directPaused,connection:{phase:'connected',detail:'已连接'}}),
            agent: () => agentState };
    `, ctx, { filename: "content-app-progress-fixture.js", timeout: 2000 });
    api = ctx.api;
    api.state.transferTasks = structuredClone(tasks);
    api.state.message = "接口创建任务已接收，插件正在自动创建，无需点击上传。";
    return { api, root, progress, identity, replies, messages,
        batch: () => structuredClone(api.directBatchProgress(api.currentStoreTransferTasks())),
        text: selector => root.querySelector(selector).textContent,
        detail: () => progress.querySelector(".transfer-progress-detail").textContent,
        percent: () => progress.querySelector(".transfer-progress-percent").textContent };
}

/** 同时检查计数、可见文案与着色；不能仅凭源码包含某段文字判定回归通过。 */
function assertSummary(harness, counts) {
    const batch = harness.batch();
    for (const [key, expected] of Object.entries(counts)) assert.equal(batch[key], expected, `统计 ${key}`);
    harness.api.render();
    assert.match(harness.detail(), new RegExp(`成功 ${batch.success}，未完成 ${batch.failed}，跳过 ${batch.skipped}，待核对 ${batch.unknown}`));
    assert.match(harness.percent(), new RegExp(`已处理 ${batch.finished}/${batch.total}`));
    assert.equal(harness.root.querySelector(".progress-bar").style.width, "50%", "不能改动采集进度");
    assert.equal(harness.root.querySelector(".progress").getAttribute("aria-valuetext"), "2/4");
}

/** 终态后各出口不得继续宣称后台排队或自动创建；用户操作回执不在此断言内。 */
function assertEnded(harness) {
    assert.equal(harness.text(".head-stage"), "本批已处理结束");
    assert.match(harness.text(".transfer-status"), /已结束/);
    for (const text of [harness.detail(), harness.text(".agent-status"), harness.text(".message")]) {
        assert.doesNotMatch(text, /正在自动创建|后台排队|自动处理中/);
    }
    assert.ok(harness.progress.stages.every(node => !node.classList.contains("active")), "终态不能留下正在进行的阶段");
}

let cases = 0;

// 四件全部被平台拒绝：必须 4/4，最后一件仍可人工重试，连接就绪不冒充商品创建成功。
{
    const h = createHarness([1, 2, 3, 4].map(id => directTask(id, "rejected", { reason: `第 ${id} 件缺少净含量` })));
    assertSummary(h, { total: 4, finished: 4, success: 0, failed: 4, skipped: 0, unknown: 0, percent: 100, complete: true });
    assert.equal(h.api.currentTransferTask().spuId, "4");
    assert.match(h.percent(), /^100%/);
    assert.equal(h.root.querySelector(".transfer-retry").hidden, false);
    assert.ok(h.root.querySelector(".transfer-status").classList.contains("bad"));
    assert.ok(h.progress.stages.find(node => node.getAttribute("data-stage") === "submitting").classList.contains("error"));
    assertEnded(h);
    h.replies.receivedCount = 4;
    h.api.pushSnapshot();
    assert.equal(h.api.agent().phase, "verified");
    assert.match(h.api.state.message, /成功 0，未完成 4，跳过 0，待核对 0/);
    assertEnded(h);
    await h.api.retryUnknownDirectTask();
    const retries = h.messages.filter(message => message.type === "retryDirectTask");
    assert.equal(retries.length, 1);
    assert.equal(retries[0].input.spuId, "4");
    assert.equal(retries[0].input.identity.storeId, "temu:123");
    assert.match(h.text(".message"), /已确认重试/);
    cases++;
}

// 第一件失败后，第二件等待或运行时必须占当前位，不能提前把失败重试入口挡在后续任务前。
for (const nextState of ["received", "", "duplicate_wait", "authorizing", "submitting", "verifying"]) {
    const h = createHarness([directTask(1, "rejected"), directTask(2, nextState)]);
    assertSummary(h, { total: 2, finished: 1, failed: 1, currentIndex: 1, percent: 50, complete: false });
    assert.equal(h.api.currentTransferTask().spuId, "2");
    assert.equal(h.root.querySelector(".transfer-retry").hidden, true);
    await h.api.retryUnknownDirectTask();
    assert.equal(h.messages.filter(message => message.type === "retryDirectTask").length, 0);
    if (nextState === "duplicate_wait") {
        assert.match(h.text(".transfer-status"), /等待重复检索/);
        h.api.pushSnapshot();
        assert.equal(h.api.agent().detail, "已连接");
        assert.match(h.text('.transfer-status'), /等待重复检索/);
    }
    cases++;
}

// 排在前面的等待项不能盖住后面的运行项；优先顺序必须与汇总当前索引一致。
{
    const h = createHarness([directTask(1, "unknown"), directTask(2, "received"), directTask(3, "submitting")]);
    assertSummary(h, { finished: 1, failed: 0, unknown: 1, currentIndex: 2, complete: false });
    assert.equal(h.api.currentTransferTask().spuId, "3");
    cases++;
}

// 单件三类需人工介入的终态都必须显示 1/1 和 100%，unknown 独立计数且没有成功/失败高亮。
for (const directState of ["preflight_failed", "rejected", "unknown"]) {
    const h = createHarness([directTask(1, directState)]);
    const unknown = directState === "unknown";
    assertSummary(h, { total: 1, finished: 1, success: 0, failed: unknown ? 0 : 1,
        skipped: 0, unknown: unknown ? 1 : 0, percent: 100, complete: true });
    const view = h.api.directProgressView(h.api.currentTransferTask());
    assert.equal(view.percent, 100);
    assert.equal(view.terminalDone, false);
    assert.equal(view.terminalError, !unknown);
    assert.equal(view.terminalUnknown, unknown);
    assert.equal(h.root.querySelector(".transfer-retry").hidden, false);
    assert.match(h.percent(), /^100%/);
    assertEnded(h);
    if (unknown) {
        assert.ok(h.root.querySelector(".transfer-status").classList.contains("warn"));
        assert.ok(h.progress.stages.every(node => !node.classList.contains("done") && !node.classList.contains("error")));
        h.api.pushSnapshot();
        assert.equal(h.api.agent().phase, "verified");
        assertEnded(h);
    }
    cases++;
}

// 成功、跳过、失败和未知同时存在；完成后选最后的人工待办而不是最后的成功商品。
{
    const h = createHarness([directTask(1, "created"), directTask(2, "preflight_failed"), directTask(3, "rejected"),
        directTask(4, "unknown"), directTask(5, "duplicate_exists"), directTask(6, "created")]);
    assertSummary(h, { total: 6, finished: 6, success: 2, failed: 2, skipped: 1, unknown: 1, percent: 100, complete: true });
    assert.equal(h.api.currentTransferTask().spuId, "4");
    assertEnded(h);
    h.api.state.transferTasks[3].directState = "created";
    h.api.render();
    assert.equal(h.api.currentTransferTask().spuId, "3");
    cases++;
}

// 全成功或全跳过仍保留可核对的最后商品；暂停旧标记不能让终态显示成仍在排队。
for (const directState of ["created", "duplicate_exists"]) {
    const h = createHarness([directTask(1, directState), directTask(2, directState)]);
    h.api.state.directPaused = true;
    assertSummary(h, { total: 2, finished: 2, success: directState === "created" ? 2 : 0,
        failed: 0, skipped: directState === "duplicate_exists" ? 2 : 0, unknown: 0, percent: 100, complete: true });
    assert.equal(h.api.currentTransferTask().spuId, "2");
    assert.equal(h.root.querySelector(".transfer-retry").hidden, true);
    assert.ok(h.root.querySelector(".transfer-status").classList.contains("done"));
    assertEnded(h);
    h.replies.receivedCount = 2;
    h.api.pushSnapshot();
    assert.equal(h.api.agent().phase, "verified");
    assertEnded(h);
    h.api.render("已导出待上传资料 JSON。");
    assert.equal(h.text(".message"), "已导出待上传资料 JSON。", "不能吞掉用户操作回执");
    cases++;
}

// 等待检索始终未完成；不认识的新状态也不能被擅自算成成功或失败。
for (const directState of ["duplicate_wait", "future_state"]) {
    const h = createHarness([directTask(1, directState)]);
    assertSummary(h, { total: 1, finished: 0, success: 0, failed: 0, skipped: 0, unknown: 0, percent: 0, complete: false });
    assert.equal(h.api.currentTransferTask().spuId, "1");
    assert.equal(h.root.querySelector(".transfer-retry").hidden, true);
    cases++;
}

// 其他店的运行、失败或未知项都不得进入本店统计、当前位与人工重试；未映射时不显示共享任务。
{
    const h = createHarness([directTask(10, "submitting", { targetStoreId: "temu:999" }), directTask(1, "rejected"),
        directTask(11, "unknown", { targetStoreId: "temu:999" })]);
    assertSummary(h, { total: 1, finished: 1, failed: 1, unknown: 0, complete: true });
    assert.equal(h.api.currentTransferTask().spuId, "1");
    assert.equal(h.api.currentTransferTask({ storeId: "temu:999" }).spuId, "10");
    await h.api.retryUnknownDirectTask();
    assert.equal(h.messages.find(message => message.type === "retryDirectTask").input.spuId, "1");
    h.identity.storeId = "";
    h.api.render();
    assert.equal(h.api.currentTransferTask(), null);
    assert.equal(h.batch().total, 0);
    assert.equal(h.batch().complete, false);
    assert.equal(h.progress.hidden, true);
    assert.equal(h.root.querySelector(".transfer-retry").hidden, true);
    assert.equal(h.root.querySelector(".transfer-cancel").hidden, true);
    cases++;
}

// 空任务和旧人工上传路径保持原有选择顺序；人工项不参与接口创建的分母。
{
    const h = createHarness();
    h.api.render();
    assert.equal(h.api.currentTransferTask(), null);
    assert.equal(h.batch().total, 0);
    assert.equal(h.progress.hidden, true);
    assert.equal(h.api.directBatchProgress(null).total, 0);
    h.api.state.transferTasks = [directTask(1, "received", { directCreate: false }),
        directTask(2, "", { directCreate: false, status: "upload_opened" })];
    h.api.render();
    assert.equal(h.api.currentTransferTask().spuId, "2");
    assert.equal(h.batch().total, 0);
    assert.equal(h.text(".transfer-status"), "2 个待处理");
    assert.equal(h.progress.hidden, true);
    cases++;
}

// 初始化的保护停止不得被渲染成用户暂停；有真实待办时主动暂停仍能继续。
{
    const h = createHarness();
    h.api.state.directPaused = true;
    h.api.render();
    assert.equal(h.progress.hidden, true);
    assert.equal(h.root.querySelector('.transfer-pause').hidden, true);
    assert.equal(h.text('.head-stage'), '准备就绪');
    assert.doesNotMatch(h.text('.transfer-status'), /停止|继续|0\/0/);
    h.api.state.transferTasks = [directTask(1, 'received')];
    h.api.render();
    assert.equal(h.root.querySelector('.transfer-pause').hidden, false);
    assert.equal(h.text('.transfer-pause'), '继续');
    cases++;
}

// 部分和全部失败均能查看所有商品；两级货号并存，未知与查重等待单独标识，其他店不进入清单。
{
    const h = createHarness([directTask(1, 'created'), directTask(2, 'rejected', {
        productCodes: ['P-2'], skuCodes: ['S-2a', 'S-2b'], reason: '净含量必填（错误码 2000135）'
    }), directTask(3, 'unknown', { reason: '网络超时，结果未知' }), directTask(4, 'duplicate_wait'),
    directTask(5, 'rejected', { targetStoreId: 'temu:999' })]);
    h.api.render();
    assert.equal(h.text('.transfer-errors'), '查看异常（3 件）');
    assert.equal(h.root.querySelector('.transfer-errors').hidden, false);
    const entries = structuredClone(h.api.directErrorEntries());
    assert.deepEqual(entries.map(entry => entry.spuId), ['2', '3', '4']);
    assert.deepEqual(entries[0].skuCodes, ['S-2a', 'S-2b']);
    assert.equal(entries[0].errorCode, '2000135');
    assert.equal(entries[1].label, '结果待核对');
    assert.equal(entries[2].label, '查重等待');
    const text = h.api.directErrorsText(entries);
    assert.match(text, /商品货号：P-2/);
    assert.match(text, /关联 SKU 货号：S-2a、S-2b/);
    assert.match(text, /未提供/);
    h.api.state.transferTasks.push(h.api.state.transferTasks[1]);
    assert.equal(h.api.directErrorEntries().length, 3);
    h.api.state.transferTasks = [];
    h.api.render();
    assert.equal(h.root.querySelector('.transfer-errors').hidden, true);
    cases++;
}

// 推送序号保护迟到快照；空队列连接成功和批次结束后的断网是独立连接状态。
{
    const h = createHarness();
    const snapshot = { storeId: 'temu:123', mallId: '123', storeName: '回归测试店', executionMode: 'plugin-api', identityMatched: true,
        sequence: 100, tasks: [], directPaused: false, connection: { phase: 'connected', detail: '已连接' } };
    h.api.applyStoreAgentSnapshot(snapshot);
    assert.equal(h.text('.agent-status'), '已连接'); assert.equal(h.batch().total, 0);
    h.api.applyStoreAgentSnapshot({ ...snapshot, sequence: 101, tasks: [directTask(1, 'created')] });
    h.api.applyStoreAgentSnapshot({ ...snapshot, sequence: 100, tasks: [directTask(2, 'rejected')] });
    assert.equal(h.api.state.transferTasks[0].spuId, '1');
    h.api.applyStoreAgentSnapshot({ ...snapshot, sequence: 102, tasks: h.api.state.transferTasks, connection: { phase: 'reconnecting', detail: '连接已断开，正在重连' } });
    assert.match(h.text('.agent-status'), /重连/); assert.equal(h.batch().success, 1);
    h.api.state.directPaused = true; h.api.state.message = '已暂停';
    h.api.applyStoreAgentSnapshot({ ...snapshot, sequence: 103 });
    assert.equal(h.api.state.message, '准备就绪'); assert.equal(h.api.state.directPaused, false);
    cases += 3;
}

// 独立资质任务失败不冒充商品上传失败；轨道准确高亮资质，弹窗保留类型和具体原因。
{
    const h = createHarness([directTask(1, 'qualification_failed', { actionType: 'qualification_upload', productId: '9876543210', productCodes: ['CERT-1'],
        qualificationItems: [{ certType: 1421, name: '检测报告', state: 'failed', reason: '目标要求英文报告' }], reason: '商品已确认，资质未完成' })]);
    assertSummary(h, { total: 1, success: 0, failed: 1, finished: 1 });
    assert.equal(h.progress.stages.find(node => node.getAttribute('data-stage') === 'qualifying').classList.contains('error'), true);
    assert.match(h.api.directErrorsText(h.api.directErrorEntries()), /检测报告.*目标要求英文报告/s);
    h.api.state.transferTasks[0].directState = 'qualification_unknown';
    assertSummary(h, { success: 0, failed: 0, unknown: 1, finished: 1 });
    cases += 2;
}

console.log(JSON.stringify({ passed: true, cases, realFunctions: 14, realRender: true, minimalDOM: true,
    rejectedBatch: "4/4 成功0 失败4", singleTerminal: "1/1 100%", unknownSeparate: true,
    duplicateWaitPending: true, storeIsolation: true, realPlatformRequests: 0 }, null, 2));
