(function installTemuLocalApp() {
    "use strict";

    // 10.x 使用独立事件通道；旧 9.x 仍在页面时，不能把它转发的响应再算进当前中转任务。
    const SOURCE = "temu-shop-transfer-v10";
    const IDLE_WINDOW_MS = 4000;
    const RUN_TIMEOUT_MS = 45000;
    const DETAIL_IDLE_WINDOW_MS = 3000;
    const DETAIL_TIMEOUT_MS = 30000;
    const PANEL_HOST_ID = "temu-local-dataset-panel";
    const PANEL_STATE_KEY = "temu-local-dataset-panel-state-v1";
    const LEGACY_PANEL_HOST_IDS = ["temu-local-capture-panel-host"];
    const PLUGIN_PRESENCE = "temu-local-capture";
    const PLUGIN_VERSION = chrome.runtime.getManifest().version;
    const STATUS_EVENT = "temu-shop-transfer-status";
    const STATUS_REQUEST_EVENT = "temu-shop-transfer-status-request";
    // 连接登记只需周期性续租；任务领取保持短周期，避免每轮心跳都串行等待四个网络请求。
    // 服务端在线窗口为 35 秒，登记间隔必须留出网络抖动余量，不能超过该窗口。
    const AGENT_REGISTER_INTERVAL_MS = 20_000;
    const AGENT_SYNC_INTERVAL_MS = 8_000;
    const AGENT_RETRY_BACKOFF_BASE_MS = 5_000;
    const AGENT_RETRY_BACKOFF_MAX_MS = 60_000;
    // 紫鸟商品表格没有稳定的 data 属性，SPU ID 会以“SPU ID：数字”文本出现在每个商品行内。
    // 只在表格行内读取该字段，避免把 /goods/list 等左侧导航路由误当成商品 ID。
    // 页面把 SPU 数字与下一个“SKC ID”直接连写，结尾不能要求单词边界；只禁止继续吞入更多数字。
    const SPU_TEXT_PATTERN = /\bSPU\s*ID\s*[：:#]?\s*([0-9]{4,20})(?![0-9])/i;
    // SKC ID 只在删除状态核验时使用：它是行内可见标识，能按当前页商品精准取回平台状态。
    // 页面常把前一个 SPU 数字与“SKC ID”直接连写，因此左边界只能排除字母，不能把数字当成边界。
    const SKC_TEXT_PATTERN = /(?:^|[^A-Za-z])SKC\s*ID\s*[：:#]?\s*([0-9]{6,20})(?![0-9])/i;
    // 选择性采集锁定范围的行标记；平台隐藏了真实复选框，插件必须提供自己的可见反馈。
    const LOCKED_ROW_ATTRIBUTE = "data-temu-selected-capture";
    const LOCKED_ROW_STYLE_ID = "temu-selected-capture-locked-style";
    const state = {
        ready: false,
        enabled: false,
        phase: "未启动",
        captured: 0,
        saved: 0,
        added: 0,
        duplicates: 0,
        failed: 0,
        productFailures: 0,
        total: 0,
        latest: "暂无",
        pageProductIds: new Set(),
        domProductIds: new Set(),
        listProductIds: new Set(),
        // 当前店铺已识别为“已删除”的 SPU；采集、补详情和入库白名单都必须排除它们。
        removedProductIds: new Set(),
        // 已完成实时状态核验的 SPU；只有同时确认“在店/已删除”后才允许进入详情队列。
        removalKnownProductIds: new Set(),
        // 当前页 SPU 对应的 SKC ID，只用于按商品精准核验店铺删除状态，不参与判重。
        rowSkcIds: new Map(),
        removedOnlyPage: false,
        pendingProductIds: new Set(),
        pendingVerifiedProductIds: new Set(),
        runEventIds: new Set(),
        capturedProductIds: new Set(),
        verifiedMatchedProductIds: new Set(),
        pageVisibleCount: 0,
        // 用户在 Temu 原生商品表格中勾选的 SPU，独立于当前分页 DOM，保证选择性采集不受刷新影响。
        selectedProductIds: new Set(),
        selectionMode: false,
        declaredProductCount: null,
        expectedSource: "暂无",
        pageScanReady: false,
        pageKey: getPageContextKey(),
        pendingWrites: 0,
        bufferOverflow: false,
        productEvents: 0,
        primaryProductEvents: 0,
        domDiagnostics: null,
        lastEventAt: 0,
        lastProductEventAt: 0,
        startedAt: 0,
        finished: false,
        runGeneration: 0,
        message: "",
        observer: null,
        scanTimer: null,
        completionTimer: null,
        timeoutTimer: null,
        drainDeadline: 0,
        autoExport: { phase: "idle", fileName: "", bytes: 0, productCount: 0, error: "" }
        ,detailMode: false
        ,detailQueue: null
        ,detailSpuId: ""
        ,detailEventCount: 0
        ,detailEvidence: false
        // 基础接口已捕获与资料是否齐全是两回事；分别展示能避免把“无详情文案”误报为采集失败。
        ,detailCaptured: false
        ,detailCompleteness: "partial"
        ,detailMissing: []
        ,detailIdleTimer: null
        ,detailTimeoutTimer: null
        ,detailSupplementStarted: false
        ,transferTasks: []
        // “停止接口创建”是逐店的落盘开关；面板只在展示层跟随它，真正拦截在扩展后台。
        ,directPaused: false
        // 接口诊断独立于普通采集开关；用户可在不开启采集的情况下，打开一个商品后只导出接口结构摘要。
        ,interfaceDiagnostics: { active: false, sessionId: "", sampleCount: 0, skippedCount: 0, droppedCount: 0, startedAt: "" }
    };
    let ingestSettings = { endpoint: "", token: "", autoPush: true };
    // 入库结果和采集完成度分开保存，避免“13/13 已采集”被误读成“仓库已有货”。
    let ingestState = { phase: "idle", detail: "" };
    let ingestQueue = { pendingCount: 0, currentPending: false, attempts: 0, maxAttempts: 5, nextAttemptAt: "", lastError: "", fingerprint: "", outcome: null };
    // currentPending 只表示当前 fingerprint 自己是否还在队列里；总 pendingCount 可能是别人的任务。
    let ingestFingerprint = "";
    // 首屏为 0，避免把页面脚本加载前发出的列表请求误判成过期响应。
    let pageContextStartedAt = 0;
    const pendingEvents = [];
    const pendingSkipEvents = [];
    let root;
    let panelHost;
    let legacyPanelObserver;
    let boundStore = { storeId: "", storeName: "" };
    let mappedStore = { storeId: "", storeName: "" };
    let pluginInstanceId = "";
    let agentState = { phase: "idle", detail: "识别店铺中", claimed: 0 };
    let lastOperationState = "";
    let agentSyncInFlight = null;
    let agentRegisterInFlight = null;
    let agentRegisteredAt = 0;
    let agentRegisteredPageStoreName = "";
    let agentSyncFailures = 0;
    let agentNextSyncAt = 0;
    // 停止/继续按钮的防重入标记：连点会让后台重复落盘，也让按钮文案与真实状态脱节。
    let directPauseBusy = false;

    /** 内容脚本只发送状态白名单；后台统一脱敏、限额与持久化，页面切换后仍能导出上一页操作。 */
    function logOperation(entry) {
        return chrome.runtime.sendMessage({ type: "recordOperation", entry }).catch(() => null);
    }

    async function send(type, payload = {}) {
        try { return await chrome.runtime.sendMessage({ type, ...payload }); }
        catch (error) {
            await logOperation({ action: type, status: "transport-failed", error: String(error?.message || error) });
            throw error;
        }
    }

    logOperation({ action: "page-attached", status: "succeeded", version: PLUGIN_VERSION });
    window.addEventListener("pagehide", () => { logOperation({ action: "page-leaving", status: "observed" }); });

    /**
     * 只有用户开启接口诊断时才让 MAIN world 解析 fetch 的请求体。普通采集不需要请求参数，
     * 这条开关能避免在大商品响应上额外读取 Request 流。
     */
    function setPageInterfaceDiagnosticEnabled(enabled) {
        // 属性让 MAIN world 即使晚于内容脚本注入，也能在安装钩子时读取当前诊断状态。
        document.documentElement?.setAttribute("data-temu-shop-transfer-interface-diagnostic", enabled === true ? "1" : "0");
        window.dispatchEvent(new CustomEvent("temu-shop-transfer-interface-diagnostic", { detail: { enabled: enabled === true } }));
    }

    /**
     * 商品编辑页会在 DOMContentLoaded 前就请求详情、图片和规格。诊断会话必须在 content script
     * document_start 阶段恢复，先让页面主世界开始记录，再由后续界面初始化处理面板渲染。
     */
    const interfaceDiagnosticsBootstrap = send("getInterfaceDiagnosticsState").then(result => {
        if (result && result.ok && result.diagnostics) {
            state.interfaceDiagnostics = result.diagnostics;
            setPageInterfaceDiagnosticEnabled(state.interfaceDiagnostics.active === true);
        }
        return state.interfaceDiagnostics;
    }).catch(() => state.interfaceDiagnostics);

    /**
     * 页面和后台必须用同一套指纹规则。消息通道失败时还没拿到后台回执，
     * 只能按本次 eventIds + 当前页 SPU 自己算出 fingerprint，刷新状态才找得到队列。
     */
    function currentIngestFingerprint(context) {
        if (typeof TemuIngestQueue === "undefined" || typeof TemuIngestQueue.fingerprintJob !== "function") return "";
        return String(TemuIngestQueue.fingerprintJob({
            eventIds: context && context.eventIds,
            allowedSpuIds: context && context.allowedSpuIds
        }) || "");
    }

    function rememberIngestFingerprint(context) {
        const fingerprint = currentIngestFingerprint(context);
        if (fingerprint) ingestFingerprint = fingerprint;
        return fingerprint;
    }

    /**
     * 页面只提供任务控制与统计；商品正文始终由后台写入扩展自身 IndexedDB，避免暴露给页面脚本。
     * “采集当前页”直接锁定当前已渲染的商品行，不能刷新页面，否则会丢失平台内存中的分页位置。
     * 默认折叠工具区只留采集按钮、进度和是否完成；入库结果、诊断数字和导出入口要点“展开”。
     */
    /**
     * 10.x 与旧采集插件会落在同一卖家页面。旧版曾占用相同 DOM id，
     * 因而必须用版本和来源标记确认宿主归属；否则新版会误以为自己已挂载。
     */
    function isCurrentPanelHost(node) {
        return Boolean(node
            && node.id === PANEL_HOST_ID
            && node.getAttribute("data-plugin-presence") === PLUGIN_PRESENCE
            && node.getAttribute("data-plugin-version") === PLUGIN_VERSION);
    }

    /**
     * 仅移除本项目历史版本留下的固定面板宿主，不扫描或改动卖家中心自己的浮层。
     * 这样页面刷新时旧扩展即便后注入，也不会再次遮挡新版中转面板。
     */
    function removeLegacyPanelHosts() {
        const sameIdHost = document.getElementById(PANEL_HOST_ID);
        if (sameIdHost && !isCurrentPanelHost(sameIdHost)) sameIdHost.remove();
        LEGACY_PANEL_HOST_IDS.forEach(id => document.getElementById(id)?.remove());
    }

    /**
     * 不同扩展的 content script 注入顺序不可控，监听后续插入的旧宿主，
     * 保证当前页最终只保留带 10.x 标记的面板，而非依赖某次固定加载顺序。
     */
    function keepCurrentPanelInCharge() {
        if (legacyPanelObserver || !document.documentElement) return;
        const panelSelector = `#${PANEL_HOST_ID},${LEGACY_PANEL_HOST_IDS.map(id => `#${id}`).join(",")}`;
        legacyPanelObserver = new MutationObserver(records => {
            // 商品列表高频重绘时不做全页查询；只有新增节点可能是历史面板宿主才执行清理。
            const legacyHostAdded = records.some(record => Array.from(record.addedNodes || []).some(node => node.nodeType === Node.ELEMENT_NODE
                && (node.id === PANEL_HOST_ID || LEGACY_PANEL_HOST_IDS.includes(node.id) || node.querySelector?.(panelSelector))));
            if (legacyHostAdded) removeLegacyPanelHosts();
        });
        legacyPanelObserver.observe(document.documentElement, { childList: true, subtree: true });
    }

    function createPanel() {
        removeLegacyPanelHosts();
        const existing = document.getElementById(PANEL_HOST_ID);
        if (isCurrentPanelHost(existing)) {
            panelHost = existing;
            return;
        }
        const host = document.createElement("div");
        host.id = PANEL_HOST_ID;
        host.setAttribute("data-plugin-presence", PLUGIN_PRESENCE);
        host.setAttribute("data-plugin-version", PLUGIN_VERSION);
        host.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;";
        root = host.attachShadow({ mode: "closed" });
        root.innerHTML = `
            <style>
                .panel{width:320px;background:#fff;border:1px solid #dbe3f0;border-radius:12px;box-shadow:0 8px 28px rgba(15,23,42,.2);font:12px/1.6 Arial,"Microsoft YaHei",sans-serif;color:#1f2937}
                .head{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 12px;background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;border-radius:11px 11px 0 0;font-size:13px;font-weight:700}
                .head-copy{display:flex;align-items:center;gap:8px;min-width:0}.head-stage{font-size:11px;font-weight:600;opacity:.9;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
                .core{padding:10px 12px 12px}.tools{display:none;padding:0 12px 12px;max-height:min(52vh,430px);overflow:auto;border-top:1px solid #eef2f7}
                .row{display:flex;justify-content:space-between;gap:10px}.value{font-weight:700;text-align:right;word-break:break-all;max-width:165px}.on{color:#2563eb}.done{color:#16a34a}.off{color:#dc2626}.warn{color:#d97706}.bad{color:#dc2626}
                .progress-block{margin:7px 0 8px}.progress-label{display:flex;justify-content:space-between;gap:10px;color:#475569}
                .progress{height:8px;background:#eef2ff;border-radius:999px;overflow:hidden}
                .progress-bar{display:block;height:100%;width:0;background:#4f46e5;border-radius:inherit}
                .progress.done .progress-bar{background:#16a34a}.progress.warn .progress-bar{background:#d97706}.progress.bad .progress-bar{background:#dc2626}
                .transfer-progress{margin:9px 0 2px;padding:9px 10px;background:#f8fafc;border:1px solid #dbe3f0;border-radius:9px}.transfer-progress[hidden]{display:none}
                .transfer-progress.paused{background:#fff7ed;border-color:#fed7aa}
                .transfer-pause{margin-top:8px}
                .transfer-progress-head{display:flex;justify-content:space-between;gap:8px;align-items:center}.transfer-progress-title{font-weight:700;color:#1e293b}.transfer-progress-percent{font-size:11px;color:#64748b}
                .stage-track{display:grid;grid-template-columns:repeat(5,1fr);gap:3px;margin-top:8px}.stage{position:relative;text-align:center;color:#94a3b8;font-size:10px;line-height:1.3}.stage::before{content:"";display:block;height:5px;margin-bottom:4px;background:#e2e8f0;border-radius:99px}.stage.active{color:#4f46e5;font-weight:700}.stage.active::before{background:#6366f1}.stage.done{color:#16a34a}.stage.done::before{background:#86efac}.stage.error{color:#dc2626;font-weight:700}.stage.error::before{background:#fca5a5}.transfer-progress-detail{margin-top:7px;color:#475569;white-space:pre-wrap;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
                .core-actions,.actions{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:9px}
                .btn{border:0;border-radius:7px;padding:7px 6px;cursor:pointer;font-size:12px}.primary{background:#4f46e5;color:#fff}.secondary{background:#eef2ff;color:#4338ca}.danger{background:#fff1f2;color:#be123c}.wide{grid-column:1 / -1}
                .tip{margin-top:8px;padding-top:7px;border-top:1px solid #eef2f7;color:#6b7280;font-size:11px}.message{min-height:18px;margin-top:6px;color:#475569}
                .message{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
                .toggle{border:0;background:transparent;color:#fff;cursor:pointer;font-size:12px;font-weight:700;padding:2px 0}
                .advanced{margin-top:12px}.advanced summary{cursor:pointer;color:#4338ca;padding:7px 0}.btn:focus-visible,.advanced summary:focus-visible{outline:2px solid #4338ca;outline-offset:2px}.btn[hidden]{display:none}
                .hidden{display:none}.collapsed .head{border-radius:11px}.panel:not(.collapsed) .tools{display:block}
                .panel:not(.collapsed) .head{border-radius:11px 11px 0 0}
                .head-actions{display:flex;align-items:center;gap:6px;flex:none}
                .mini{border:0;background:transparent;color:#fff;cursor:pointer;font-size:14px;font-weight:700;line-height:1;padding:2px 4px;border-radius:5px}
                .mini:hover{background:rgba(255,255,255,.18)}
                /* 小球态只保留边缘箭头，避免遮挡卖家中心内容；拖动由标题栏完成。 */
                .panel.compact{width:42px;background:transparent;border:0;box-shadow:none}.panel.compact .head{width:42px;height:42px;box-sizing:border-box;padding:0;justify-content:center;border-radius:21px}.panel.compact .head-copy,.panel.compact .mini{display:none}.panel.compact .head-actions{gap:0}.panel.compact .toggle{width:42px;height:42px;font-size:20px;line-height:42px;padding:0}.panel.compact .core,.panel.compact .tools{display:none}
                .head{cursor:move;user-select:none}.toggle{cursor:pointer}
                /* 缩小只收起操作工具，不隐藏运行状态；用户无需展开面板也能看到接口创建进展。 */
                .toggle:focus-visible,.btn:focus-visible{outline:2px solid #c7d2fe;outline-offset:2px}
            </style>
            <section class="panel collapsed">
                <header class="head"><span class="head-copy"><span>店铺中转</span><span class="head-stage">准备就绪</span></span><span class="head-actions"><button type="button" class="mini" title="收缩为小球" aria-label="收缩为小球">—</button><button type="button" class="toggle" aria-expanded="false" aria-controls="temu-tools" title="展开工具">展开</button></span></header>
                <div class="core">
                    <div class="row"><span>采集</span><span class="value capture-status off">未启动</span></div>
                    <div class="progress-block">
                        <div class="progress-label"><span>进度</span><span class="value coverage">—</span></div>
                        <div class="progress" role="progressbar" aria-label="采集进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="未开始"><span class="progress-bar"></span></div>
                    </div>
                    <div class="row ingest-row"><span>入库</span><span class="value ingest-status off">未配置</span></div>
                    <div class="row agent-row"><span>本店</span><span class="value agent-status off">识别店铺中</span></div>
                    <div class="row transfer-row"><span>待上传</span><span class="value transfer-status off">0 个</span></div>
                    <div class="transfer-progress" hidden aria-live="polite">
                        <div class="transfer-progress-head"><span class="transfer-progress-title">接口创建进度</span><span class="transfer-progress-percent"></span></div>
                        <div class="stage-track" role="list" aria-label="接口创建阶段">
                            <span class="stage" data-stage="duplicate_check">对比</span><span class="stage" data-stage="authorizing">预检</span><span class="stage" data-stage="submitting">提交</span><span class="stage" data-stage="verifying">回查</span><span class="stage" data-stage="created">已创建</span>
                        </div>
                        <div class="transfer-progress-detail"></div>
                        <button type="button" class="btn secondary wide transfer-retry" hidden>人工确认后重试</button>
                        <button type="button" class="btn secondary wide transfer-pause">停止接口创建</button>
                    </div>
                    <div class="row selection-row"><span>已选商品</span><span class="value selected-count">0 个</span></div>
                    <div class="core-actions">
                        <button type="button" class="btn primary start wide">采集当前页</button>
                        <button type="button" class="btn secondary start-selected wide" disabled>采集已选商品</button>
                        <button type="button" class="btn secondary stop hidden wide">停止本次采集</button>
                    </div>
                    <div class="message" role="status" aria-live="polite"></div>
                </div>
                <div class="tools" id="temu-tools">
                    <details class="advanced"><summary>采集统计详情</summary>
                    <div class="row"><span>完成判断</span><span class="value status off">未启动</span></div>
                    <div class="row"><span>页面商品</span><span class="value expected">0</span></div>
                    <div class="row"><span>统计依据</span><span class="value source">暂无</span></div>
                    <div class="row"><span>跳过已删除</span><span class="value removed">0</span></div>
                    <div class="row"><span>结果总数旁证</span><span class="value declared">—</span></div>
                    <div class="row"><span>已完成商品</span><span class="value completed">0</span></div>
                    <div class="row"><span>本页捕获</span><span class="value captured">0</span></div>
                    <div class="row"><span>本页保存</span><span class="value saved">0</span></div>
                    <div class="row"><span>本页新增</span><span class="value added">0</span></div>
                    <div class="row"><span>本页重复</span><span class="value duplicates">0</span></div>
                    <div class="row"><span>本页失败</span><span class="value failed">0</span></div>
                    <div class="row"><span>商品相关失败</span><span class="value productFailures">0</span></div>
                    <div class="row"><span>本地总记录</span><span class="value total">0</span></div>
                    <div class="row"><span>最近类型</span><span class="value latest">暂无</span></div>
                    <div class="row"><span>入库节点</span><span class="value ingest">未配置</span></div>
                    </details>
                    <div class="actions">
                        <button class="btn secondary wide logs">导出操作日志</button>
                        <button class="btn secondary wide push">上传采集包到网站</button>
                        <button class="btn primary wide transfer-next">接口任务自动创建</button>
                        <button class="btn secondary wide transfer-export">导出当前待上传商品资料</button>
                        <button class="btn secondary wide transfer-done">确认当前商品已上传</button>
                        <button class="btn secondary wide settings">连接设置与测试</button>
                    </div>
                    <details class="advanced"><summary>备用导出与高级诊断</summary>
                        <div class="actions">
                            <button class="btn secondary wide export">下载采集包</button>
                            <button class="btn secondary wide structure">导出页面结构</button>
                            <button class="btn secondary wide interface-diagnostic">开始接口诊断</button>
                        </div>
                        <div class="row"><span>接口诊断</span><span class="value interface-diagnostic-status off">未开启</span></div>
                    </details>
                    <div class="tip">状态自动刷新。采集包下载后由本地网站读取；目标任务须成功领取才会出现。无反应时导出操作日志。</div>
                    <div class="tip">接口创建任务由插件自动执行，不要点击上传按钮；保持商品列表页打开即可。</div>
                </div>
            </section>`;
        document.body.appendChild(host);
        panelHost = host;
        restorePanelPlacement(host);
        syncPanelVisibility();
        keepCurrentPanelInCharge();

        const head = root.querySelector(".head");
        let drag = null;
        head.addEventListener("pointerdown", event => {
            // 标题栏整体可拖动；标题栏上的按钮保留自身点击行为，不参与拖动。
            if (event.target.closest("button")) return;
            const rect = host.getBoundingClientRect();
            drag = { id: event.pointerId, dx: event.clientX - rect.left, dy: event.clientY - rect.top };
            head.setPointerCapture?.(event.pointerId);
            event.preventDefault();
        });
        head.addEventListener("pointermove", event => {
            if (!drag || drag.id !== event.pointerId) return;
            const x = Math.max(0, Math.min(window.innerWidth - host.offsetWidth, event.clientX - drag.dx));
            const y = Math.max(0, Math.min(window.innerHeight - host.offsetHeight, event.clientY - drag.dy));
            host.style.left = `${x}px`; host.style.top = `${y}px`; host.style.right = "auto"; host.style.bottom = "auto";
        });
        head.addEventListener("pointerup", event => {
            if (!drag || drag.id !== event.pointerId) return;
            drag = null;
            dockPanelToEdge();
        });

        root.addEventListener("click", event => {
            const button = event.target.closest?.("button");
            if (button) logOperation({ action: `click:${[...button.classList].filter(name => !["btn", "wide", "primary", "secondary"].includes(name)).join("-")}`,
                status: "clicked", pendingCount: currentStoreTransferTasks().length });
        }, true);

        root.querySelector(".toggle").addEventListener("click", event => {
            const panel = root.querySelector(".panel");
            // 小球态下的同一个按钮只负责还原面板，避免把“展开工具”和“收缩为小球”混成一步。
            if (panel.classList.contains("compact")) setPanelCompact(false);
            else setToolsExpanded(panel.classList.contains("collapsed"));
            event.currentTarget.focus();
        });
        root.querySelector(".mini").addEventListener("click", () => setPanelCompact(true));
        syncToolsToggle();
        root.querySelector(".start").addEventListener("click", startCapture);
        root.querySelector(".start-selected").addEventListener("click", startSelectedCapture);
        root.querySelector(".stop").addEventListener("click", stopCapture);
        root.querySelector(".structure").addEventListener("click", exportPageStructure);
        root.querySelector(".interface-diagnostic").addEventListener("click", toggleInterfaceDiagnostics);
        root.querySelector(".export").addEventListener("click", exportData);
        root.querySelector(".logs").addEventListener("click", exportLogs);
        root.querySelector(".push").addEventListener("click", pushToWarehouse);
        root.querySelector(".transfer-next").addEventListener("click", openNextTransferTask);
        root.querySelector(".transfer-export").addEventListener("click", exportCurrentTransferTask);
        root.querySelector(".transfer-done").addEventListener("click", confirmCurrentTransferTask);
        root.querySelector(".transfer-pause").addEventListener("click", toggleDirectCreatePaused);
        root.querySelector(".transfer-retry").addEventListener("click", retryUnknownDirectTask);
        root.querySelector(".settings").addEventListener("click", openSettings);
    }

    /** 页面和接口都使用同一套短字符串规范，避免数字/字符串差异造成匹配漏报。 */
    function normalizeProductId(value) {
        if (typeof value !== "string" && typeof value !== "number") return null;
        const normalized = String(value).trim();
        return normalized && normalized.length <= 128 && !/[\r\n]/.test(normalized) ? normalized : null;
    }

    /** 任务结束、切页或暂停时统一撤销静默与硬超时定时器，避免旧代际回调改写新状态。 */
    function clearCompletionTimers() {
        if (state.completionTimer) clearTimeout(state.completionTimer);
        if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
        state.completionTimer = null;
        state.timeoutTimer = null;
        state.drainDeadline = 0;
    }

    /** 只统计真实渲染的列表节点，隐藏模板和折叠弹窗不应成为当前页商品。 */
    function isVisible(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && element.getClientRects().length > 0;
    }

    /** 规范化行文本，兼容紫鸟页面把标签和值拆成多个 span 或使用不换行空格的情况。 */
    function normalizeRowText(value) {
        return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }

    /** 诊断文件只保留结构和截断文本；账号、令牌、Cookie 等字段即使出现在属性中也必须脱敏。 */
    function sanitizeDiagnosticText(value, limit = 600) {
        return String(value || "")
            .replace(/(?:token|cookie|authorization|password|passwd|secret|session|credential|api[-_]?key)\s*[:=]\s*[^\s"'<>]+/ig, "[REDACTED]")
            .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[EMAIL]")
            // 只在明确的电话标签后脱敏，避免把 11 位 SKC/SKU ID 误判为手机号。
            .replace(/((?:电话|手机(?:号)?|mobile|phone)\s*[:：=]?\s*)1[3-9]\d{9}/ig, "$1[PHONE]")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, limit);
    }

    function sanitizeDiagnosticAttribute(name, value) {
        const lowerName = String(name || "").toLowerCase();
        if (/^(value|src|srcset|style|on\w*)$/.test(lowerName) || /token|cookie|auth|password|secret|session/i.test(lowerName)) return "[REDACTED]";
        if (lowerName === "href") {
            try {
                const url = new URL(value, location.href);
                return `${url.pathname}${url.search ? "?[query]" : ""}`.slice(0, 300);
            } catch (_) {
                return sanitizeDiagnosticText(value, 300);
            }
        }
        return sanitizeDiagnosticText(value, 300);
    }

    /** 以有限深度输出节点树，保留 class/role/data 字段和文本关系，避免把整个页面或商品正文写入诊断包。 */
    function serializeDiagnosticNode(element, depth = 0) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE || depth > 4) return null;
        const attributes = {};
        Array.from(element.attributes || []).slice(0, 40).forEach(attribute => {
            const name = attribute.name.toLowerCase();
            if (name === "class" || name === "role" || name.startsWith("data-") || name.startsWith("aria-") || name === "href") {
                attributes[name] = sanitizeDiagnosticAttribute(name, attribute.value);
            }
        });
        const children = depth >= 4 ? [] : Array.from(element.children || []).slice(0, 30)
            .map(child => serializeDiagnosticNode(child, depth + 1)).filter(Boolean);
        const tag = element.tagName.toLowerCase();
        const safeMarkup = Object.entries(attributes)
            .map(([name, value]) => `${name}="${String(value).replace(/"/g, "&quot;")}"`)
            .join(" ");
        return {
            tag,
            attributes,
            text: sanitizeDiagnosticText(element.textContent, 500),
            // 不直接导出 outerHTML，避免未列入白名单的 src/value/style 等属性绕过脱敏。
            html: `<${tag}${safeMarkup ? ` ${safeMarkup}` : ""}>…</${tag}>`,
            children
        };
    }

    function collectActivePageLabels() {
        return Array.from(document.querySelectorAll("[role='tab'][aria-selected='true'], .ant-tabs-tab-active, [aria-current='page']"))
            .filter(isVisible).map(element => sanitizeDiagnosticText(element.textContent, 120)).filter(Boolean).slice(0, 20);
    }

    /** 收集实际候选表格、商品行、iframe 和可访问 Shadow DOM，供下一轮按事实修正规则。 */
    function collectPageStructure() {
        const roots = getProductScanRoots();
        const rowSelectors = [
            "table tbody > tr", "[role='table'] [role='row']", "[role='grid'] [role='row']",
            "[class*='table-row' i]", "[class*='tableRow' i]", "[data-row-key]"
        ];
        const tables = Array.from(document.querySelectorAll("table, [role='table'], [role='grid']")).filter(isVisible).slice(0, 30);
        const rows = new Set();
        roots.forEach(rootElement => rowSelectors.forEach(selector => rootElement.querySelectorAll(selector).forEach(row => rows.add(row))));
        const rowSamples = Array.from(rows).filter(isVisible).slice(0, 40).map(row => ({
            selectedAsProductRow: Boolean(readSpuIdFromRow(row)),
            spuMatch: readSpuIdFromRow(row),
            node: serializeDiagnosticNode(row, 0)
        }));
        const iframeSamples = Array.from(document.querySelectorAll("iframe")).slice(0, 30).map(frame => ({
            src: sanitizeDiagnosticAttribute("src", frame.getAttribute("src") || ""),
            sameOriginAccessible: Boolean(frame.contentDocument),
            title: sanitizeDiagnosticText(frame.getAttribute("title"), 120)
        }));
        const shadowHosts = [];
        Array.from(document.querySelectorAll("*")).slice(0, 5000).forEach(element => {
            if (element.shadowRoot && shadowHosts.length < 50) shadowHosts.push({ tag: element.tagName.toLowerCase(), attributes: serializeDiagnosticNode(element, 0)?.attributes || {} });
        });
        const diagnostics = {
            capturedAt: new Date().toISOString(),
            pageUrl: (() => {
                try {
                    const url = new URL(location.href);
                    return `${url.origin}${url.pathname}${url.search ? "?[query]" : ""}`;
                } catch (_) {
                    return location.origin + location.pathname;
                }
            })(),
            title: sanitizeDiagnosticText(document.title, 200),
            activePageLabels: collectActivePageLabels(),
            roots: roots.map(rootElement => ({ tag: rootElement.tagName.toLowerCase(), id: rootElement.id || "", className: sanitizeDiagnosticText(rootElement.className, 200) })),
            counts: {
                tables: tables.length,
                tbody: document.querySelectorAll("tbody").length,
                tr: document.querySelectorAll("tr").length,
                roleRows: document.querySelectorAll("[role='row']").length,
                visibleCandidateRows: rowSamples.length,
                selectedProductRows: rowSamples.filter(item => item.selectedAsProductRow).length,
                iframes: document.querySelectorAll("iframe").length,
                openShadowRoots: shadowHosts.length
            },
            tables: tables.slice(0, 10).map(table => ({
                node: serializeDiagnosticNode(table, 0),
                visibleRows: Array.from(table.querySelectorAll("tbody tr, [role='row']")).filter(isVisible).length
            })),
            rowSamples,
            iframes: iframeSamples,
            openShadowRoots: shadowHosts,
            scanScope: "仅扫描 document 主文档；iframe 内容与 shadowRoot 内部未递归扫描",
            domProductIds: Array.from(state.domProductIds).slice(0, 100),
            removedProductIds: Array.from(state.removedProductIds).slice(0, 100),
            declaredProductCount: state.declaredProductCount,
            expectedSource: state.expectedSource
        };
        state.domDiagnostics = diagnostics;
        return diagnostics;
    }

    async function exportPageStructure() {
        render("正在读取页面结构诊断…");
        const structure = collectPageStructure();
        const result = await send("openStructure", { structure });
        render(result && result.ok ? "页面结构诊断页已打开，请导出 JSON。" : "页面结构诊断打开失败。");
    }

    /** 从页签文案去掉动态数量，避免“全部 : 26”变成 27 时误重置本次采集。 */
    function stablePageLabel(text) {
        return normalizeRowText(text).replace(/[:：]?\s*[0-9]{1,6}\s*$/g, "").slice(0, 40);
    }

    /** 只保留能表达筛选/分页语义的查询键；广告和追踪参数不能进入页面集合键。 */
    function readStableFilterKey() {
        const helper = typeof TemuPageContext !== "undefined" ? TemuPageContext : null;
        if (helper && typeof helper.collectStableFilterParams === "function") {
            return helper.collectStableFilterParams(location.search, location.hash);
        }
        try {
            const params = new URLSearchParams(location.search);
            const kept = [];
            params.forEach((value, key) => {
                if (/^(?:filter|status|tab|type|page|sort|keyword|search|publish|sale|listed|draft)/i.test(key)) {
                    kept.push(`${key}=${String(value).slice(0, 40)}`);
                }
            });
            return kept.sort().join("&");
        } catch (_) {
            return "";
        }
    }

    /**
     * 列表控件指纹只记录分页和筛选控件文案，不记录当前可见 SPU。
     * 虚拟滚动会改可见商品，但不能改分页页码或筛选条件；后者才表示真正换了列表。
     */
    function readListControlFingerprint() {
        const roots = typeof getProductScanRoots === "function" ? getProductScanRoots() : [document.body || document.documentElement];
        const selectors = [
            ".ant-pagination .ant-pagination-item-active",
            ".ant-pagination .ant-pagination-simple-pager input",
            ".ant-pagination .ant-select-selection-item",
            ".ant-pagination-options-size-changer .ant-select-selection-item",
            "input[type='search']",
            "input[placeholder*='搜索' i]",
            "input[placeholder*='货号' i]",
            "input[placeholder*='SPU' i]",
            "[aria-label*='页' i]",
            "[class*='pagination' i] [aria-current='page']",
            ".ant-table-filter-trigger.active"
        ];
        const parts = [];
        roots.forEach(rootElement => {
            if (!rootElement || typeof rootElement.querySelectorAll !== "function") return;
            selectors.forEach(selector => {
                rootElement.querySelectorAll(selector).forEach(element => {
                    if (!isVisible(element)) return;
                    // 行内状态下拉、每行操作不能进入列表指纹，否则虚拟滚动会误重置。
                    if (element.closest("tbody, [role='row'], [role='rowgroup'], [class*='table-row' i]")) return;
                    const value = normalizeRowText(element.value || element.textContent).slice(0, 40);
                    if (value) parts.push(value);
                });
            });
        });
        return [...new Set(parts)].slice(0, 12).join("|");
    }

    /**
     * 页面集合键只使用稳定路由、页签语义和筛选参数。
     * 不能写入动态商品数量或当前可见 SPU，否则列表总数变化和虚拟滚动会把进行中的采集当成切页。
     */
    function getPageContextKey() {
        const activeLabels = Array.from(document.querySelectorAll("[role='tab'][aria-selected='true'], .ant-tabs-tab-active, [aria-current='page']"))
            .filter(isVisible)
            .map(element => stablePageLabel(element.textContent))
            .filter(Boolean)
            .join("|");
        const hashRoute = String(location.hash || "").split("?")[0].slice(0, 80);
        const helper = typeof TemuPageContext !== "undefined" ? TemuPageContext : null;
        const parts = {
            path: `${location.origin}${location.pathname}${hashRoute}`,
            labels: activeLabels,
            filter: readStableFilterKey(),
            list: readListControlFingerprint()
        };
        return helper && helper.composePageContextKey ? helper.composePageContextKey(parts) : [parts.path, parts.labels, parts.filter, parts.list].join("||");
    }

    /**
     * 只有确认换了路由、页签、查询或分页/筛选控件后才清空已见 SPU。
     * 表格重绘导致指纹暂时为空时，保留原集合，避免虚拟滚动把当前页商品拆成多次任务。
     */
    function syncPageContext() {
        const currentPageKey = getPageContextKey();
        const helper = typeof TemuPageContext !== "undefined" ? TemuPageContext : null;
        const genuine = helper && typeof helper.isGenuineListContextChange === "function"
            ? helper.isGenuineListContextChange(state.pageKey, currentPageKey)
            : Boolean(state.pageKey) && state.pageKey !== currentPageKey;
        if (genuine) {
            if (state.apiRunning) {
                // 列表切换后不能继续用旧SPU队列；保留已落库资料，要求用户在新列表重新启动。
                state.enabled = false;
                state.runGeneration += 1;
                send("clearDetailSupplement").catch(() => {});
                send("setCaptureEnabled", { enabled: false }).catch(() => {});
            }
            resetPageContext(true);
            if (state.enabled) beginRun();
            return true;
        }
        if (helper && typeof helper.parsePageContextKey === "function") {
            const previous = helper.parsePageContextKey(state.pageKey);
            const next = helper.parsePageContextKey(currentPageKey);
            // 表格或页签短暂卸载时指纹会变空；这时保留原键，等控件重新出现后再比较。
            if (previous.path === next.path && previous.filter === next.filter
                && ((!next.list && previous.list) || (!next.labels && previous.labels))) {
                return false;
            }
        }
        state.pageKey = currentPageKey;
        return false;
    }

    /** 只接受商品行中明确标注的 SPU ID；SKU/SKC 和导航路由不属于完成度基准。 */
    function readSpuIdFromRow(row) {
        if (!row || !isVisible(row)) return null;
        const text = normalizeRowText(row.textContent);
        const textMatch = text.match(SPU_TEXT_PATTERN);
        if (textMatch) return normalizeProductId(textMatch[1]);
        // 个别版本把 SPU 放在 data-field/data-column-key 中，仍限制在当前行并要求字段名含 spu。
        const fields = row.querySelectorAll("[data-field], [data-column-key], [data-col-key], [class*='spu' i]");
        for (const field of fields) {
            const fieldName = [field.getAttribute("data-field"), field.getAttribute("data-column-key"), field.getAttribute("data-col-key"), field.className]
                .filter(value => typeof value === "string").join(" ").replace(/[\s_-]/g, "").toLowerCase();
            if (!fieldName.includes("spu")) continue;
            const match = normalizeRowText(field.textContent).match(/([0-9]{4,20})(?![0-9])/);
            if (match) return normalizeProductId(match[1]);
        }
        return null;
    }

    /** 读取商品行里展示的 SKC ID，用于按当前页商品核验店铺删除状态；拿不到就返回空数组。 */
    function readSkcIdsFromRow(row) {
        if (!row || !isVisible(row)) return [];
        const ids = new Set();
        const text = normalizeRowText(row.textContent);
        const matched = text.match(new RegExp(SKC_TEXT_PATTERN.source, "gi")) || [];
        matched.forEach(segment => {
            const value = segment.match(SKC_TEXT_PATTERN);
            if (value) ids.add(value[1]);
        });
        return Array.from(ids);
    }

    /** 优先找真正的商品表格行；main 可能同时包含侧栏、通知和分页器，不能直接扫描所有链接。 */
    function getProductTableRows(roots) {
        const candidates = new Set();
        const selectors = [
            "table tbody > tr", "[role='table'] [role='row']", "[role='grid'] [role='row']",
            "[class*='table-row' i]", "[class*='tableRow' i]", "[data-row-key]"
        ];
        roots.forEach(rootElement => selectors.forEach(selector => {
            rootElement.querySelectorAll(selector).forEach(row => candidates.add(row));
        }));
        let visible = Array.from(candidates).filter(isVisible).filter(row => readSpuIdFromRow(row));
        // 无稳定行 class，或候选表格不是商品表格时，从 SPU 标签向上找最近的行容器。
        if (!visible.length) {
            roots.forEach(rootElement => rootElement.querySelectorAll("*").forEach(element => {
                if (!/\bSPU\s*ID\b/i.test(normalizeRowText(element.textContent)) || !isVisible(element)) return;
                const row = element.closest("tr, [role='row'], [class*='row' i], [data-row-key]") || element;
                candidates.add(row);
            }));
            visible = Array.from(candidates).filter(isVisible).filter(row => readSpuIdFromRow(row));
        }
        // 外层虚拟列表容器可能也命中 SPU 文本，只保留最内层的商品行，避免一个商品被重复计数。
        return visible.filter(row => !visible.some(other => other !== row && row.contains(other)));
    }

    /** 从真实商品行读取已勾选 SPU；表头全选框没有 SPU，不会误加入选择清单。 */
    function readSelectedProductIds() {
        const roots = getProductScanRoots();
        const ids = new Set(state.selectedProductIds);
        getProductTableRows(roots).forEach(row => {
            const checkbox = row.querySelector("input[type='checkbox']");
            const spuId = readSpuIdFromRow(row);
            if (!checkbox || !spuId) return;
            if (checkbox.checked) ids.add(spuId);
            else ids.delete(spuId);
        });
        state.selectedProductIds = ids;
        return ids;
    }

    /** 选择清单按标签页保存，刷新或分页重绘后仍能继续；两小时未使用自动失效。 */
    async function persistSelectedProductIds() {
        const ids = [...state.selectedProductIds];
        if (!ids.length) {
            await send("clearSelectedCaptureIntent").catch(() => {});
            return;
        }
        await send("saveSelectedCaptureIntent", { input: {
            spuIds: ids,
            pageUrl: location.href,
            pageStoreName: currentPageIdentity().storeName || ""
        } }).catch(() => {});
    }

    async function restoreSelectedProductIds() {
        const result = await send("getSelectedCaptureIntent").catch(() => null);
        const intent = result && result.intent;
        if (!intent || !Array.isArray(intent.spuIds)) return;
        if (intent.pageUrl && !String(intent.pageUrl).startsWith(`${location.origin}/goods/list`)) return;
        const page = currentPageIdentity();
        if (intent.pageStoreName && page.storeName && typeof TemuStoreIdentity !== "undefined"
            && typeof TemuStoreIdentity.namesCompatible === "function"
            && !TemuStoreIdentity.namesCompatible(intent.pageStoreName, page.storeName)) {
            await send("clearSelectedCaptureIntent").catch(() => {});
            return;
        }
        state.selectedProductIds = new Set(intent.spuIds.map(normalizeProductId).filter(Boolean));
        state.selectionMode = state.selectedProductIds.size > 0;
    }

    function handleNativeProductSelection(event) {
        const checkbox = event.target;
        if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== "checkbox") return;
        const row = checkbox.closest("tr, [role='row'], [data-row-key], [class*='table-row' i]");
        const spuId = readSpuIdFromRow(row);
        if (!spuId) return;
        if (checkbox.checked) state.selectedProductIds.add(spuId);
        else state.selectedProductIds.delete(spuId);
        persistSelectedProductIds();
        render();
    }

    /**
     * 卖家中心把真实复选框渲染成 opacity:0 的隐藏 input，可见勾选由旁边的图标 div 负责。
     * 因此仅回写 checked 属性用户看不到任何变化，必须再给商品行加一个插件自己的可见标记，
     * 让用户刷新后仍能确认哪些商品属于本次已锁定范围。标记只作用于行属性，不改平台 DOM 结构。
     */
    function ensureLockedRowStyle() {
        if (document.getElementById(LOCKED_ROW_STYLE_ID)) return;
        const style = document.createElement("style");
        style.id = LOCKED_ROW_STYLE_ID;
        // 平台会在运行期继续注入表格样式，标记必须 !important 才不会被后到的行背景覆盖掉。
        style.textContent = `[${LOCKED_ROW_ATTRIBUTE}="1"]{box-shadow:inset 3px 0 0 #1677ff !important;background:rgba(22,119,255,.06) !important;}`;
        (document.head || document.documentElement).appendChild(style);
    }

    /** 退出选择性采集后必须清掉残留标记，否则用户会以为旧勾选仍然生效。 */
    function clearLockedRowMarkers() {
        document.querySelectorAll(`[${LOCKED_ROW_ATTRIBUTE}="1"]`).forEach(row => row.removeAttribute(LOCKED_ROW_ATTRIBUTE));
    }

    /** 刷新或分页重绘后把已锁定的 SPU 映射回原生复选框，避免用户看到全未选中并在启动时误清空清单。 */
    function restoreVisibleProductCheckboxes(rows) {
        if (!state.selectionMode || !state.selectedProductIds.size) {
            clearLockedRowMarkers();
            return;
        }
        ensureLockedRowStyle();
        rows.forEach(row => {
            const checkbox = row.querySelector("input[type='checkbox']");
            const spuId = readSpuIdFromRow(row);
            const locked = Boolean(spuId && state.selectedProductIds.has(spuId));
            if (checkbox && locked) checkbox.checked = true;
            if (locked) row.setAttribute(LOCKED_ROW_ATTRIBUTE, "1");
            else row.removeAttribute(LOCKED_ROW_ATTRIBUTE);
        });
    }

    /** 优先限制在主内容/商品列表容器，行级过滤会进一步排除侧栏通知和导航。 */
    function getProductScanRoots() {
        const mainRoots = Array.from(document.querySelectorAll("main, [role='main'], [data-page-content], [data-testid*='product-list' i]"))
            .filter(isVisible);
        return mainRoots.length ? mainRoots : [document.body || document.documentElement];
    }

    /** 诊断候选行不复用完成度过滤结果，才能在“有表格但 SPU 识别失败”时保留真实线索。 */
    function getDiagnosticCandidateRows(roots) {
        const selectors = [
            "table tbody > tr", "[role='table'] [role='row']", "[role='grid'] [role='row']",
            "[class*='table-row' i]", "[class*='tableRow' i]", "[data-row-key]"
        ];
        const rows = new Set();
        roots.forEach(rootElement => selectors.forEach(selector => rootElement.querySelectorAll(selector).forEach(row => rows.add(row))));
        return Array.from(rows).filter(isVisible).slice(0, 40);
    }

    /** 每次轻量扫描都留下 DOM 命中事实，确保只导出日志时也能知道页面是否读到 SPU。 */
    function updateDomDiagnosticsSummary(roots, productRows) {
        const candidateRows = getDiagnosticCandidateRows(roots);
        const visibleTables = Array.from(document.querySelectorAll("table, [role='table'], [role='grid']")).filter(isVisible);
        state.domDiagnostics = {
            detailLevel: "summary",
            capturedAt: new Date().toISOString(),
            pageUrl: `${location.origin}${location.pathname}${location.search ? "?[query]" : ""}`,
            title: sanitizeDiagnosticText(document.title, 200),
            activePageLabels: collectActivePageLabels(),
            roots: roots.map(rootElement => ({
                tag: rootElement.tagName.toLowerCase(),
                id: rootElement.id || "",
                className: sanitizeDiagnosticText(rootElement.className, 160)
            })).slice(0, 20),
            counts: {
                tables: visibleTables.length,
                tbody: document.querySelectorAll("tbody").length,
                tr: document.querySelectorAll("tr").length,
                roleRows: document.querySelectorAll("[role='row']").length,
                visibleCandidateRows: candidateRows.length,
                selectedProductRows: productRows.length,
                iframes: document.querySelectorAll("iframe").length,
                // 轻量扫描不遍历全页面节点；开放 Shadow DOM 只在用户主动导出详细诊断时枚举。
                openShadowRoots: 0
            },
            rowSamples: candidateRows.slice(0, 20).map(row => ({
                selectedAsProductRow: Boolean(readSpuIdFromRow(row)),
                tag: row.tagName.toLowerCase(),
                className: sanitizeDiagnosticText(row.className, 160),
                spuMatch: readSpuIdFromRow(row),
                text: sanitizeDiagnosticText(row.textContent, 260)
            })),
            domProductIds: Array.from(state.domProductIds).slice(0, 100),
            declaredProductCount: state.declaredProductCount,
            expectedSource: state.expectedSource,
            scanScope: "document 主文档；未扫描 iframe/shadowRoot 内部",
            openShadowRootsScanned: false
        };
    }

    /** 卡片无 SPU 时只做可见数量估算；表格计数仅统计成功读取 SPU 的行，避免把分页/空状态算成商品。 */
    function countVisibleProductCards(roots, productRows = []) {
        if (productRows.length) return productRows.length;
        const selectors = [
            '[class*="product-card" i]', '[class*="productCard" i]', '[class*="goods-card" i]', '[class*="goodsCard" i]',
            '[data-testid*="product-card" i]', '[data-testid*="goods-card" i]'
        ];
        const cards = new Set();
        roots.forEach(rootElement => selectors.forEach(selector => rootElement.querySelectorAll(selector).forEach(element => cards.add(element))));
        const visibleCards = Array.from(cards).filter(isVisible);
        // 一个商品卡片通常同时包住图片、链接和标题，选择最外层可见卡片避免嵌套节点重复计数。
        let visible = visibleCards.filter(element => !visibleCards.some(parent => parent !== element && parent.contains(element))).length;
        return visible;
    }

    /** 读取当前激活商品页签的结果数量，排除顶部“全部消息 26”等通知数字。 */
    function readDeclaredProductCount(roots) {
        const parseTabCount = text => {
            const match = text.match(/^(?:全部|全部商品|All|在售中|未发布到站点|已下架\/已终止|已删除)\s*[:：]?\s*([0-9]{1,6})$/i);
            return match && Number.isInteger(Number(match[1])) ? Number(match[1]) : null;
        };
        const activeTabs = roots.flatMap(rootElement => Array.from(rootElement.querySelectorAll("[role='tab'][aria-selected='true'], .ant-tabs-tab-active, [aria-current='page']")))
            .filter(isVisible);
        const activeCounts = activeTabs.map(element => parseTabCount(normalizeRowText(element.textContent))).filter(value => value !== null);
        if (activeCounts.length) return Math.max(...activeCounts);
        let count = null;
        roots.forEach(rootElement => rootElement.querySelectorAll("[role='tab'], button, a, li, span, div").forEach(element => {
            if (!isVisible(element)) return;
            const match = normalizeRowText(element.textContent).match(/^(?:全部|全部商品|All)\s*[:：]?\s*([0-9]{1,6})$/i);
            if (match) count = Math.max(count || 0, Number(match[1]));
        }));
        return count;
    }

    /** 以商品表格 SPU 为主；当前页主列表接口可补齐虚拟滚动未挂载的行，其他任务接口不进入集合。 */
    function refreshExpectedProducts() {
        const previousKey = `${state.pageProductIds.size}:${state.expectedSource}`;
        if (state.selectionMode && state.selectedProductIds.size) {
            state.pageProductIds = new Set(state.selectedProductIds);
            state.expectedSource = "用户勾选的 SPU";
            applyRemovalToExpectedProducts();
            const currentKey = `${state.pageProductIds.size}:${state.expectedSource}`;
            if (previousKey !== currentKey) matchPendingProductIds();
            return;
        }
        const canMergePrimaryList = state.listProductIds.size > 0
            && (!state.domProductIds.size || state.listProductIds.size >= state.domProductIds.size);
        if (state.domProductIds.size && canMergePrimaryList) {
            state.pageProductIds = new Set([...state.domProductIds, ...state.listProductIds]);
            state.expectedSource = "页面表格 SPU + 当前页列表接口 SPU";
        } else if (state.domProductIds.size) {
            state.pageProductIds = new Set(state.domProductIds);
            state.expectedSource = "页面表格 SPU ID";
        } else if (state.listProductIds.size) {
            state.pageProductIds = new Set(state.listProductIds);
            state.expectedSource = "商品列表接口 SPU（页面未暴露 ID）";
        } else {
            state.pageProductIds = new Set();
            state.expectedSource = state.pageVisibleCount
                ? "页面可见商品数量（未找到 ID）"
                : (state.declaredProductCount ? "接口声明数量（未验证）" : "未找到商品标识");
        }
        applyRemovalToExpectedProducts();
        const currentKey = `${state.pageProductIds.size}:${state.expectedSource}`;
        if (state.pageProductIds.size) {
            state.capturedProductIds = new Set(Array.from(state.capturedProductIds).filter(productId => state.pageProductIds.has(productId)));
            state.verifiedMatchedProductIds = new Set(Array.from(state.verifiedMatchedProductIds).filter(productId => state.pageProductIds.has(productId)));
        }
        if (previousKey !== currentKey) matchPendingProductIds();
    }

    /**
     * 在 DOM 稳定后确定本页预期商品；接口列表中的 SPU 只用于补齐虚拟滚动未挂载的商品行。
     */
    function scanPageProducts() {
        if (state.detailMode) return;
        syncPageContext();
        const roots = getProductScanRoots();
        const rows = getProductTableRows(roots);
        // 采集任务恢复后不再用刷新后的未勾选 DOM 覆盖跨页选择；普通浏览状态才同步当前页勾选。
        if (!state.selectionMode) {
            readSelectedProductIds();
            // 非选择性采集下平台自身会显示勾选，插件的锁定标记必须清掉，避免误导。
            clearLockedRowMarkers();
        } else {
            restoreVisibleProductCheckboxes(rows);
        }
        const ids = new Set(rows.map(readSpuIdFromRow).filter(Boolean));
        // SKC 只在核验店铺删除状态时使用；虚拟滚动会移除旧行，因此映射按已见行累积，避免后滚动丢失。
        rows.forEach(row => {
            const spuId = readSpuIdFromRow(row);
            if (!spuId) return;
            const skcIds = readSkcIdsFromRow(row);
            if (skcIds.length) state.rowSkcIds.set(spuId, skcIds);
        });
        // 虚拟滚动会把离开视口的行从 DOM 移除，因此同一 URL 内累积已见 SPU，避免预期集合缩水。
        ids.forEach(productId => state.domProductIds.add(productId));
        state.pageVisibleCount = Math.max(state.pageVisibleCount, countVisibleProductCards(roots, rows));
        const declared = readDeclaredProductCount(roots);
        if (declared !== null) state.declaredProductCount = Math.max(state.declaredProductCount || 0, declared);
        state.pageScanReady = true;
        refreshExpectedProducts();
        updateDomDiagnosticsSummary(roots, rows);
        if (state.enabled) evaluateCompletion(false);
        if (state.enabled && state.phase === "未启动") state.phase = "正在采集";
        if (state.enabled) scheduleCompletionCheck();
        render();
    }

    /** 将高频 DOM 变更合并成一次扫描，避免商品列表逐行渲染时反复全量查询。 */
    function schedulePageScan() {
        if (state.scanTimer) clearTimeout(state.scanTimer);
        state.scanTimer = setTimeout(() => {
            state.scanTimer = null;
            scanPageProducts();
        }, 180);
    }

    /** 建立当前页面的商品观察器；观察器只负责发现页面集合变化，不直接判定采集完成。 */
    function startPageTracking() {
        scanPageProducts();
        if (state.observer || !document.documentElement) return;
        state.observer = new MutationObserver(schedulePageScan);
        state.observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "data-field", "data-column-key", "data-col-key", "data-row-key", "aria-selected", "aria-current", "value"]
        });
        // 搜索框和分页输入通常只改 value，不改子节点；必须额外监听，否则 DOM 筛选切页不会重置集合。
        document.addEventListener("input", schedulePageScan, true);
        document.addEventListener("change", event => { handleNativeProductSelection(event); schedulePageScan(); }, true);
    }

    /** 面板只允许出现在 Temu 卖家中心管理路由；登录页、营销页及其他站点不挂载可见 UI。 */
    function isManagementPage() {
        if (location.hostname !== "agentseller.temu.com") return false;
        const type = typeof TemuStoreIdentity !== "undefined" && typeof TemuStoreIdentity.readPageType === "function" ? TemuStoreIdentity.readPageType() : "other";
        return ["home", "goods-list", "goods-edit", "goods-create", "goods-draft"].includes(type);
    }
    function syncPanelVisibility() {
        if (panelHost) panelHost.hidden = !isManagementPage();
    }

    function currentDetailSpuId() {
        try {
            const url = new URL(location.href);
            const hashText = String(url.hash || "");
            const hashParams = new URLSearchParams(hashText.includes("?") ? hashText.slice(hashText.indexOf("?") + 1) : "");
            return normalizeProductId(url.searchParams.get("productId") || url.searchParams.get("spuId")
                || hashParams.get("productId") || hashParams.get("spuId"));
        } catch (_) {
            return null;
        }
    }

    /** 详情页等待自身接口静默后回报；必须已捕获 product/query 核心对象，字段缺失则作为资料不完整继续入库。 */
    function scheduleDetailSupplementCompletion() {
        if (!state.detailMode || !state.detailSpuId) return;
        if (state.detailIdleTimer) clearTimeout(state.detailIdleTimer);
        state.detailIdleTimer = setTimeout(async () => {
            state.detailIdleTimer = null;
            const queue = await send("getDetailSupplement").catch(() => null);
            const current = queue && queue.current;
            if (current && current.spuId === state.detailSpuId && current.detailCaptured) {
                state.detailEvidence = Boolean(current.detailCapture && current.detailCapture.detailText);
                state.detailCaptured = true;
                state.detailCompleteness = current.completeness === "complete" ? "complete" : "partial";
                state.detailMissing = Array.isArray(current.detailCapture && current.detailCapture.missing) ? current.detailCapture.missing : [];
                await send("advanceDetailSupplement", { input: { spuId: state.detailSpuId, status: "done" } }).catch(() => {});
                state.phase = state.detailCompleteness === "complete" ? "详情已保存" : "资料不完整";
                state.message = state.detailCompleteness === "complete"
                    ? `SPU ${state.detailSpuId} 完整资料已保存，准备下一个商品。`
                    : `SPU ${state.detailSpuId} 基础资料已保存，但缺少${state.detailMissing.join("、") || "部分字段"}。`;
                render();
                return;
            }
            if (Date.now() - state.startedAt < DETAIL_TIMEOUT_MS) {
                scheduleDetailSupplementCompletion();
                return;
            }
            await send("advanceDetailSupplement", { input: { spuId: state.detailSpuId, status: "failed", reason: "详情页未捕获 product/query 基础资料响应" } }).catch(() => {});
            state.phase = "详情补采失败";
            state.message = `SPU ${state.detailSpuId} 未捕获到基础资料接口响应，已记录失败并继续队列。`;
            render();
        }, DETAIL_IDLE_WINDOW_MS);
    }

    /** 详情队列导航后的页面入口；只采集当前 SPU，不重新按列表页 45 秒规则判定完成。 */
    async function initializeDetailSupplement(queue) {
        const spuId = currentDetailSpuId();
        if (!queue || !queue.active || !spuId || !queue.current || String(queue.current.spuId) !== String(spuId)) return false;
        state.detailMode = true;
        state.detailQueue = queue;
        state.detailSpuId = spuId;
        state.detailEventCount = 0;
        state.detailEvidence = Boolean(queue.current.detailEvidence);
        state.detailCaptured = Boolean(queue.current.detailCaptured);
        state.detailCompleteness = queue.current.completeness === "complete" ? "complete" : "partial";
        state.detailMissing = Array.isArray(queue.current.detailCapture && queue.current.detailCapture.missing) ? queue.current.detailCapture.missing : [];
        state.startedAt = Date.now();
        state.phase = "详情补采中";
        state.message = `正在读取 SPU ${spuId} 的商品详情…`;
        render();
        scheduleDetailSupplementCompletion();
        return true;
    }

    /**
     * 最后一件商品采完后后台会带着终态队列回到列表页。这里恢复其摘要，
     * 让操作者能区分“已完整”“资料不完整”和“下载/入库失败”，而不是回到未启动界面。
     */
    function restoreFinishedDetailSupplement(queue) {
        if (!queue || queue.active || !["done", "partial"].includes(String(queue.status || ""))) return false;
        state.detailQueue = queue;
        state.detailMode = false;
        state.detailSupplementStarted = true;
        state.finished = true;
        state.enabled = false;
        const total = Number(queue.total) || 0;
        const complete = Number(queue.complete) || 0;
        const partial = Number(queue.partial) || 0;
        const failed = Number(queue.failed) || 0;
        const finalization = queue.finalization && typeof queue.finalization === "object" ? queue.finalization : {};
        const download = finalization.download || {};
        const ingest = finalization.ingest || {};
        const notes = [];
        if (download.status === "done") notes.push("完整包已下载");
        else if (download.status === "requested") notes.push("已发起本批次完整包下载，请在浏览器下载列表确认");
        else if (download.status === "skipped") notes.push(`下载未完成：${download.reason || "已跳过"}`);
        else if (download.status === "error") notes.push(`下载失败：${download.error || "未知错误"}`);
        if (ingest.status === "done") notes.push(ingest.reused ? "仓库已存在相同批次" : "已提交到仓库");
        else if (ingest.status === "skipped") notes.push(`仓库未提交：${ingest.reason || "已跳过"}`);
        else if (ingest.status === "error") notes.push(`仓库提交失败：${ingest.error || "未知错误"}`);
        applyDetailFinalizationState(download, ingest);
        state.phase = queue.status === "done" ? "采集完成" : "部分完成";
        state.message = queue.status === "done"
            ? `当前页 ${complete}/${total} 个商品资料已采集；原商品可没有详情正文，不代表可直接发布。${notes.join("；") || "正在整理最终结果。"}`
            : `已处理 ${Number(queue.completed) || 0}/${total} 个商品：完整 ${complete}，资料不完整 ${partial}，失败 ${failed}。${notes.join("；") || "请在网站查看缺失字段。"}`;
        render();
        return true;
    }

    /** 接口详情收尾结果要写进入库状态，避免采集完成后面板仍显示“采集后自动/未入库”。 */
    function applyDetailFinalizationState(download, ingest) {
        if (download && (download.status === "done" || download.status === "requested")) {
            state.autoExport = {
                phase: download.status === "done" ? "done" : "exporting",
                fileName: String(download.fileName || ""),
                bytes: Number(download.bytes) || 0,
                productCount: Number(download.productCount) || 0,
                error: ""
            };
        } else if (download && download.status === "error") {
            state.autoExport = { phase: "error", fileName: "", bytes: 0, productCount: 0, error: String(download.error || "下载失败").slice(0, 160) };
        } else if (download && download.status === "skipped") {
            state.autoExport = { phase: "skipped", fileName: "", bytes: 0, productCount: 0, error: String(download.reason || "已跳过").slice(0, 160) };
        }
        if (ingest && ingest.status === "done") {
            setIngestState("done", ingest.batchId ? `已入库 ${ingest.batchId}` : "已入库");
            return;
        }
        if (ingest && ingest.status === "error") {
            setIngestState("error", ingestErrorText(ingest.error || ingest.reason));
            return;
        }
        if (ingest && ingest.status === "skipped") {
            setIngestState("blocked", ingest.reason || "已跳过");
            return;
        }
        if (ingest && ingest.status === "pending") {
            setIngestState("pushing", "正在推送");
        }
    }

    async function startDetailSupplement() {
        if (state.detailSupplementStarted || state.detailMode) return false;
        // 详情补采前先按当前页商品核验店铺删除状态，已删除商品不再补详情，也不会进入入库白名单。
        const verificationTargetIds = captureProductIds();
        const removal = await verifyRemovedProducts(verificationTargetIds);
        // 有目标商品但状态不完整时禁止继续：拿不到实时删除状态只能停止，不能把未知状态当成“仍在店铺”。
        if (verificationTargetIds.size && !removal.checked) {
            state.detailSupplementStarted = false;
            state.enabled = false;
            await send("setCaptureEnabled", { enabled: false }).catch(() => {});
            state.phase = "待人工确认";
            state.message = `未能核验当前页商品的店铺删除状态：${removal.reason || "未知原因"}。为避免误传，本轮已停止，未上传；请刷新页面后重试。`;
            render();
            return false;
        }
        // 删除状态核验结果并入详情补采提示，运营在面板上能直接看到本页跳过了几件已删除商品。
        const removalNote = removal.checked && removal.removed ? `；店铺已删除 ${removal.removed} 个，已跳过不上传` : "";
        const targetIds = captureProductIds();
        if (!targetIds.size) {
            finishCapture("采集完成", removal.removed
                ? "当前页商品均为店铺已删除，已跳过，不上传。"
                : "当前页没有可采集商品，未上传。");
            return false;
        }
        state.detailSupplementStarted = true;
        state.phase = "接口采集中";
        state.message = `${state.selectionMode ? "已锁定勾选" : "已统计当前页"} ${targetIds.size} 个商品${removalNote}，开始排队读取详情，不打开编辑页。`;
        // 列表和详情采用两阶段日志，数量只能在详情成功落库后推进。
        send("captureRun", { summary: makeRunSummary("列表采集完成，详情补采开始") }).catch(() => {});
        render();
        const result = await send("beginDetailSupplement", { input: {
            spuIds: Array.from(targetIds),
            eventIds: Array.from(state.runEventIds),
            listUrl: location.href
        } }).catch(error => ({ transportError: true, error: String(error && error.message || error) }));
        if (!result || result.transportError || result.ok === false || (result.active === false && !result.total)) {
            state.detailSupplementStarted = false;
            state.enabled = false;
            await send("setCaptureEnabled", { enabled: false }).catch(() => {});
            state.phase = "采集失败";
            state.message = `详情补采队列启动失败：${result && result.error || "未知错误"}`;
            render();
            return false;
        }
        state.detailQueue = result;
        clearCompletionTimers();
        await runApiDetailQueue(result);
        return true;
    }

    /** 主世界只返回当前请求ID对应的详情；页面消息不是凭证，后台仍须核验批次和商品。 */
    function queryApiDetail(queue) {
        return new Promise((resolve, reject) => {
            const requestId = crypto.randomUUID();
            const source = "temu-shop-transfer-api-v1";
            const onMessage = event => {
                const value = event.data;
                if (event.source !== window || event.origin !== location.origin || value?.source !== source || value.kind !== "result" || value.requestId !== requestId || value.runId !== queue.runId || value.spuId !== queue.current.spuId) return;
                cleanup();
                if (value.error) reject(new Error(value.error)); else resolve(value.payload);
            };
            const timer = setTimeout(() => { cleanup(); reject(new Error("页面详情查询无回执，请刷新后重新采集")); }, 20000);
            const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", onMessage); };
            window.addEventListener("message", onMessage);
            window.postMessage({ source, kind: "query", requestId, runId: queue.runId, spuId: queue.current.spuId }, location.origin);
        });
    }

    /** 单件查询、后台落库、推进队列严格串行；暂停或筛选切换后丢弃在途结果。 */
    async function runApiDetailQueue(queue) {
        if (state.apiRunning || queue?.mode !== "api") return;
        state.apiRunning = true;
        state.detailSupplementStarted = true;
        const generation = state.runGeneration;
        const pageKey = state.pageKey;
        try {
            while (queue.active && queue.current && state.enabled && generation === state.runGeneration) {
                state.detailQueue = queue;
                state.phase = "接口采集中";
                render(`已保存 ${queue.completed}/${queue.total} 个商品，正在读取 SPU ${queue.current.spuId}。`);
                try {
                    const payload = await queryApiDetail(queue);
                    syncPageContext();
                    if (!state.enabled || generation !== state.runGeneration || pageKey !== state.pageKey) break;
                    state.pendingWrites += 1;
                    let response;
                    try { response = await send("captureApiDetail", { input: { runId: queue.runId, spuId: queue.current.spuId, payload } }); }
                    finally { state.pendingWrites = Math.max(0, state.pendingWrites - 1); }
                    if (!state.enabled || generation !== state.runGeneration) break;
                    if (!response?.ok || !response.queue) throw new Error(response?.error || "详情保存失败");
                    state.captured += 1;
                    state.saved += 1;
                    if (response.result?.duplicate) state.duplicates += 1; else state.added += 1;
                    state.detailEventCount += 1;
                    if (response.result?.eventId) state.runEventIds.add(response.result.eventId);
                    queue = response.queue;
                    state.detailQueue = queue;
                } catch (error) {
                    if (!state.enabled || generation !== state.runGeneration) break;
                    state.failed += 1;
                    state.productFailures += 1;
                    const failed = await send("advanceDetailSupplement", { input: { runId: queue.runId, spuId: queue.current.spuId, status: "failed", reason: String(error?.message || error) } }).catch(() => null);
                    if (failed?.ok) queue = failed;
                    else queue = { ...queue, active: false, status: "partial" };
                    state.phase = "部分完成";
                    state.message = `接口批次已停止：${error?.message || error}。已保存的资料保留，可导出日志后重试。`;
                    break;
                }
                if (queue.active) await new Promise(resolve => setTimeout(resolve, 800));
            }
            if (generation === state.runGeneration && state.enabled) {
                state.detailQueue = queue;
                const failureMessage = state.phase === "部分完成" ? state.message : "";
                restoreFinishedDetailSupplement(queue);
                if (failureMessage) state.message = failureMessage;
                await send("captureRun", { summary: makeRunSummary("接口批量采集结束") }).catch(() => {});
                await refreshStats();
                render();
            }
        } finally { state.apiRunning = false; }
    }

    /** 当前采集目标优先使用用户勾选集合；未勾选时才回退到整页商品集合。 */
    function captureProductIds() {
        const targetIds = state.selectionMode && state.selectedProductIds.size ? state.selectedProductIds : state.pageProductIds;
        // 店铺已删除的商品不补详情、不进入库白名单；即使运营手动勾选过也不上传。
        if (!state.removedProductIds.size) return targetIds;
        return new Set(Array.from(targetIds).filter(productId => !state.removedProductIds.has(productId)));
    }

    /**
     * 把当前店铺已删除的商品移出本页目标集合，并记录“整页商品都已删除”的状态。
     * 删除状态取自商品行本身，不按历史货号判断，因此只影响本次页面集合，不会永久拉黑某个货号。
     */
    function applyRemovalToExpectedProducts() {
        if (state.removedProductIds.size) {
            state.pageProductIds = new Set(Array.from(state.pageProductIds).filter(productId => !state.removedProductIds.has(productId)));
        }
        const knownIds = new Set([...state.domProductIds, ...state.listProductIds]);
        const removedCount = Array.from(knownIds).filter(productId => state.removedProductIds.has(productId)).length;
        state.removedOnlyPage = knownIds.size > 0 && removedCount === knownIds.size;
        if (state.removedOnlyPage) state.expectedSource = "当前页商品均为店铺已删除（不上传）";
    }

    /**
     * 记录当前页商品行的店铺删除状态：已删除的 SPU 立即退出本页目标集合。
     * 同一响应里状态为“在店”的行会解除先前的删除标记，覆盖删除后又恢复的页面状态。
     */
    function applyRemovalStatuses(result) {
        if (!result || typeof result !== "object") return;
        const activeProductIds = Array.isArray(result.activeProductIds) ? result.activeProductIds : [];
        activeProductIds.forEach(value => {
            const productId = normalizeProductId(value);
            if (!productId) return;
            state.removalKnownProductIds.add(productId);
            state.removedProductIds.delete(productId);
        });
        const removedProductIds = Array.isArray(result.removedProductIds) ? result.removedProductIds : [];
        removedProductIds.forEach(value => {
            const productId = normalizeProductId(value);
            if (!productId) return;
            state.removalKnownProductIds.add(productId);
            state.removedProductIds.add(productId);
            state.listProductIds.delete(productId);
            state.pageProductIds.delete(productId);
        });
        if (activeProductIds.length || removedProductIds.length) applyRemovalToExpectedProducts();
    }

    /**
     * 按当前页商品自己的 SKC ID 向平台核验店铺删除状态。
     * 只读当前页商品，不按货号检索整店：同一货号删除后可能被重新建成新商品，货号历史无法区分两者，
     * 而 SKC/商品 ID 是平台对单个商品的实时标识。查询失败或页面未提供 SKC 时保持原有行为，
     * 不会因为拿不到状态就少传商品。
     */
    async function verifyRemovedProducts(targetIds) {
        const targetProductIds = Array.from(targetIds || []).map(normalizeProductId).filter(Boolean);
        const unresolvedProductIds = targetProductIds.filter(productId => !state.removalKnownProductIds.has(productId));
        if (!unresolvedProductIds.length) return { checked: true, removed: 0, active: 0 };
        const skcIds = [];
        const missingSkcProductIds = [];
        unresolvedProductIds.forEach(productId => {
            const values = state.rowSkcIds.get(productId);
            if (!Array.isArray(values) || !values.length) {
                missingSkcProductIds.push(productId);
                return;
            }
            values.forEach(value => { if (!skcIds.includes(value)) skcIds.push(value); });
        });
        if (missingSkcProductIds.length || !skcIds.length) {
            return { checked: false, removed: 0, active: 0, reason: "当前页有商品缺少可核验的 SKC ID" };
        }
        const requestId = crypto.randomUUID();
        const response = await new Promise(resolve => {
            const timer = setTimeout(() => { cleanup(); resolve({ error: "删除状态查询无回执" }); }, 20000);
            const onMessage = event => {
                const value = event.data;
                if (event.source !== window || event.origin !== location.origin) return;
                if (value?.source !== "temu-shop-transfer-api-v1" || value.kind !== "removal-result" || value.requestId !== requestId) return;
                cleanup();
                resolve(value);
            };
            const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", onMessage); };
            window.addEventListener("message", onMessage);
            window.postMessage({ source: "temu-shop-transfer-api-v1", kind: "removal", requestId, skcIds }, location.origin);
        });
        if (response && response.error) return { checked: false, removed: 0, active: 0, reason: String(response.error) };
        const items = Array.isArray(response?.payload?.items) ? response.payload.items : [];
        const validItems = items.filter(item => {
            const productId = normalizeProductId(item?.productId);
            const productSkcId = String(item?.productSkcId || "").trim();
            return productId && /^\d{6,20}$/.test(productSkcId) && (item?.removeStatus === 0 || item?.removeStatus === 1);
        });
        const returnedSkcIds = new Set(validItems.map(item => String(item.productSkcId).trim()));
        const missingSkcIds = skcIds.filter(skcId => !returnedSkcIds.has(skcId));
        if (missingSkcIds.length) {
            return { checked: false, removed: 0, active: 0, reason: "删除状态接口未返回当前页全部 SKC" };
        }
        const activeProductIds = validItems.filter(item => item.removeStatus === 0).map(item => item.productId);
        const removedProductIds = validItems.filter(item => item.removeStatus === 1).map(item => item.productId);
        const statusByProductId = new Map();
        activeProductIds.forEach(productId => statusByProductId.set(normalizeProductId(productId), "active"));
        removedProductIds.forEach(productId => statusByProductId.set(normalizeProductId(productId), "removed"));
        const missingStatusProductIds = unresolvedProductIds.filter(productId => !statusByProductId.has(productId));
        if (missingStatusProductIds.length) {
            return { checked: false, removed: 0, active: 0, reason: "删除状态接口未返回当前页全部商品" };
        }
        applyRemovalStatuses({ activeProductIds, removedProductIds });
        return { checked: true, removed: removedProductIds.length, active: activeProductIds.length };
    }

    /** 返回页面预期商品数；没有可靠 ID 时按可见行/接口声明返回估算值。 */
    function expectedProductCount() {
        if (state.detailQueue && (state.detailMode || state.apiRunning || state.finished)) return Number(state.detailQueue.total) || 0;
        if (!state.pageScanReady) return null;
        // 页面商品指当前页实际可匹配集合；接口总数可能是筛选结果总量，单独展示，不阻断当前页完成。
        if (captureProductIds().size) return captureProductIds().size;
        // 当前页识别出的商品全部是店铺已删除时，本页没有可上传目标，不再按可见行数要求采集。
        if (state.removedOnlyPage) return 0;
        if (state.pageVisibleCount) return state.pageVisibleCount;
        return state.declaredProductCount || 0;
    }

    /** 绿色完成只使用当前页主列表响应命中的 SPU，避免详情或旁路任务接口拼接出假覆盖。 */
    function matchedProductCount() {
        if (state.detailQueue && (state.detailMode || state.apiRunning || state.finished)) {
            return Math.min(expectedProductCount() || 0, (Number(state.detailQueue.completed) || 0) + (state.detailEvidence ? 1 : 0));
        }
        return captureProductIds().size ? state.verifiedMatchedProductIds.size : state.capturedProductIds.size;
    }

    /** 显示逐商品核验百分比或明确的“未核验”，不把接口自举数量伪装成页面覆盖率。 */
    function coverageText() {
        if (state.detailQueue && (state.detailMode || state.finished)) {
            const total = expectedProductCount() || 0;
            return total ? `${matchedProductCount()}/${total}（详情）` : "详情统计中";
        }
        const expected = expectedProductCount();
        if (expected === null) return "统计中";
        if (!expected) return "—";
        const completed = Math.min(matchedProductCount(), expected);
        const percent = Math.min(100, Math.round(completed / expected * 100));
        if (state.domProductIds.size) return `${completed}/${expected}（${percent}%）`;
        return `${completed}/${expected}（未核验）`;
    }

    /** 只把当前商品列表的主分页接口作为 SPU 集合来源，排除编辑任务/历史任务接口。 */
    function isPrimaryProductListUrl(requestUrl) {
        return /\/visage-agent-seller\/product\/skc\/pageQuery(?:$|[/?])/i.test(String(requestUrl || ""))
            || /\/visage-agent-seller\/product\/(?:spu|goods)\/pageQuery(?:$|[/?])/i.test(String(requestUrl || ""));
    }

    /** 将业务终态映射为颜色：绿色仅“采集完成”，蓝色表示进行中，黄色部分/停止，红色失败。 */
    function statusClass() {
        if (state.phase === "采集完成") return state.failed ? "warn" : "done";
        if (["商品列表已覆盖", "正在采集", "等待静默", "等待写入"].includes(state.phase)) return "on";
        if (["部分完成", "采集超时", "统计页面商品", "已暂停", "待人工确认"].includes(state.phase)) return "warn";
        if (["采集失败"].includes(state.phase)) return "bad";
        return state.enabled ? "on" : "off";
    }

    /** 折叠按钮只控制入库结果和诊断工具区，采集按钮、进度和是否完成始终留在主面板。 */
    function setToolsExpanded(expanded) {
        if (!root) return;
        root.querySelector(".panel").classList.toggle("collapsed", !expanded);
        syncToolsToggle();
    }

    /** 按钮文案必须跟随真实折叠状态，避免“展开”实际执行整体收缩这类误导操作。 */
    function syncToolsToggle() {
        if (!root) return;
        const panel = root.querySelector(".panel");
        const toggle = root.querySelector(".toggle");
        if (!panel || !toggle || panel.classList.contains("compact")) return;
        const expanded = !panel.classList.contains("collapsed");
        toggle.textContent = expanded ? "收起" : "展开";
        toggle.title = expanded ? "收起工具" : "展开工具";
        toggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    /**
     * 收缩为贴边小球，只保留一个指向展开方向的箭头。
     * 小球态与工具区折叠互相独立：还原时回到收缩前的工具区状态，运行进度始终留在主面板。
     */
    function setPanelCompact(compact) {
        if (!root) return;
        const panel = root.querySelector(".panel");
        const toggle = root.querySelector(".toggle");
        panel.classList.toggle("compact", compact);
        if (!compact) {
            syncToolsToggle();
            return;
        }
        // 先切换成小球再贴边，保证按 42px 的实际尺寸计算贴边位置和箭头方向。
        dockPanelToEdge();
        toggle.textContent = panelHost?.style.left === "0px" ? "›" : "‹";
        toggle.title = "展开面板";
        toggle.setAttribute("aria-expanded", "false");
    }

    /** 面板统一停靠到更近的左右边侧，避免长时间停留在工作区中间遮挡卖家列表。 */
    function dockPanelToEdge() {
        if (!panelHost) return;
        const rect = panelHost.getBoundingClientRect();
        const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? "left" : "right";
        panelHost.style.left = side === "left" ? "0px" : "auto";
        panelHost.style.right = side === "right" ? "0px" : "auto";
        panelHost.style.top = `${Math.max(8, Math.min(window.innerHeight - panelHost.offsetHeight - 8, rect.top))}px`;
        panelHost.style.bottom = "auto";
        savePanelPlacement(side);
    }

    /** 暂停实际会结束本次任务并通常触发重新采集，不能写成“暂停后可继续”。 */
    function syncCaptureButtons() {
        if (!root) return;
        const start = root.querySelector(".start");
        const selected = root.querySelector(".start-selected");
        const stop = root.querySelector(".stop");
        const running = Boolean(state.enabled && !state.finished);
        start.classList.toggle("hidden", running);
        stop.classList.toggle("hidden", !running);
        start.disabled = running;
        start.textContent = "采集当前页";
        if (selected) {
            selected.disabled = running || state.selectedProductIds.size === 0;
            selected.textContent = state.selectedProductIds.size ? `采集已选商品（${state.selectedProductIds.size}）` : "采集已选商品";
        }
        stop.textContent = "停止本次采集";
    }

    /** 仅保存面板位置与停靠侧，不保存商品或店铺数据；页面刷新后恢复用户工作区布局。 */
    function savePanelPlacement(side) {
        try { localStorage.setItem(PANEL_STATE_KEY, JSON.stringify({ side, top: panelHost?.style.top || "" })); } catch {}
    }
    function restorePanelPlacement(host) {
        try {
            const saved = JSON.parse(localStorage.getItem(PANEL_STATE_KEY) || "null");
            if (!saved) return;
            host.style.left = saved.side === "left" ? "0px" : "auto";
            host.style.right = saved.side === "right" ? "0px" : "auto";
            if (saved.top) host.style.top = saved.top;
            host.style.bottom = "auto";
        } catch {}
    }

    /** 接口诊断必须显式开启，且不会修改普通采集状态；诊断完成后同一按钮负责停止并打开导出页。 */
    function syncInterfaceDiagnosticControls() {
        if (!root) return;
        const button = root.querySelector(".interface-diagnostic");
        const status = root.querySelector(".interface-diagnostic-status");
        const diagnostic = state.interfaceDiagnostics || {};
        if (button) {
            button.textContent = diagnostic.active ? "停止并导出接口诊断" : "开始接口诊断";
            button.classList.toggle("danger", Boolean(diagnostic.active));
            button.classList.toggle("secondary", !diagnostic.active);
        }
        if (status) {
            const dropped = Number(diagnostic.droppedCount) || 0;
            status.textContent = diagnostic.active
                ? `记录中 ${Number(diagnostic.sampleCount) || 0}${dropped ? ` / 丢弃 ${dropped}` : ""} 条`
                : (diagnostic.sessionId ? `已导出 ${Number(diagnostic.sampleCount) || 0} 条` : "未开启");
            status.classList.remove("on", "off", "warn", "bad", "done");
            status.classList.add(diagnostic.active ? "on" : (diagnostic.sessionId ? "done" : "off"));
        }
    }

    function progressPercent() {
        const expected = expectedProductCount();
        if (expected === null || !expected) return 0;
        return Math.min(100, Math.round(Math.min(matchedProductCount(), expected) / expected * 100));
    }

    /** 把接口创建内部状态翻译成用户能判断的阶段；“预检中”里的重复对比单独显示，避免用户误以为已提交。 */
    function directProgressView(task) {
        if (!task?.directCreate) return null;
        const state = String(task.directState || "received");
        const reason = String(task.reason || "");
        const checking = state === "received" || (state === "authorizing" && /检索|重复|对比/.test(reason));
        const stage = checking ? "duplicate_check" : state === "authorizing" ? "authorizing" : state;
        const stages = ["duplicate_check", "authorizing", "submitting", "verifying", "created"];
        const labels = {
            duplicate_check: "重复对比中",
            authorizing: "资料预检中",
            submitting: "正在提交",
            verifying: "正在回查",
            created: "创建成功",
            unknown: "结果待核对",
            preflight_failed: "预检失败",
            duplicate_exists: "已存在，未重复创建"
        };
        const terminalError = state === "unknown" || state === "preflight_failed";
        const terminalDone = state === "created" || state === "duplicate_exists";
        const index = terminalError ? Math.max(0, stages.indexOf(state === "unknown" ? "verifying" : "authorizing")) : Math.max(0, stages.indexOf(stage));
        const percent = terminalDone ? 100 : Math.round(((index + 1) / stages.length) * 100);
        return { state, stage, stages, index, percent, label: labels[state] || labels[stage] || "任务处理中", reason, terminalError, terminalDone };
    }

    function captureStatusText() {
        if (state.detailMode && state.detailQueue) return `详情补采 ${matchedProductCount()}/${expectedProductCount() || 0}`;
        const expected = expectedProductCount();
        const completed = expected === null ? state.capturedProductIds.size : Math.min(matchedProductCount(), expected || 0);
        if (state.phase === "未启动") return "未启动";
        if (expected === null) return `${state.phase} 统计中`;
        if (state.phase === "商品列表已覆盖") return `列表已覆盖 ${completed}/${expected}，仍在补详情`;
        if (state.phase === "采集完成") return `已完成 ${completed}/${expected}`;
        if (["部分完成", "采集超时", "采集失败", "已暂停"].includes(state.phase)) return `${state.phase} ${completed}/${expected || 0}`;
        return `${state.phase} ${completed}/${expected || 0}`;
    }

    /**
     * 入库颜色独立于采集完成度。
     * 无令牌标黄并阻断自动入库；127.0.0.1 只警告，本机 Chrome 仍允许尝试推送。
     */
    function ingestStatusClass() {
        if (ingestState.phase === "done") return "done";
        if (ingestState.phase === "pushing") return "on";
        if (ingestState.phase === "error") return "bad";
        if (ingestState.phase === "retry") return "warn";
        if (ingestState.phase === "warn" || ingestState.phase === "need_setup") return "warn";
        if (ingestState.phase === "blocked") return "warn";
        const host = ingestHostText(ingestSettings.endpoint) || ingestSettings.endpoint;
        if (!ingestSettings.token || isLoopbackIngestHost(host)) return "warn";
        return "on";
    }

    /** 入库结果放在展开区。没有令牌会阻断自动入库；127.0.0.1 只标黄警告，不单独拦截本机推送。 */
    function ingestCoreText() {
        if (ingestState.phase === "pushing") return "正在推送";
        if (ingestState.phase === "done") return ingestState.detail || "已入库";
        if (ingestState.phase === "error") return ingestState.detail || "入库失败";
        if (ingestState.phase === "retry") return ingestState.detail || "等待重试";
        if (ingestState.phase === "blocked") return ingestState.detail || "未自动入库";
        if (ingestState.phase === "need_setup") return ingestState.detail || "待配置";
        const host = ingestHostText(ingestSettings.endpoint) || ingestSettings.endpoint;
        if (!host) return "未配置地址";
        if (!ingestSettings.token) return "待令牌";
        if (isLoopbackIngestHost(host)) return "本机地址，紫鸟可能连不上";
        if (ingestQueue.currentPending && ingestQueue.fingerprint === ingestFingerprint) {
            return ingestQueue.attempts
                ? `排队 ${ingestQueue.pendingCount}，已试 ${ingestQueue.attempts}/${ingestQueue.maxAttempts}`
                : `排队 ${ingestQueue.pendingCount}`;
        }
        return ingestSettings.autoPush === false ? "已关闭自动" : "采集后自动";
    }

    /** 判断入库地址是不是本机回环。紫鸟里这通常不是宿主机，但不能据此禁止本机浏览器推送。 */
    function isLoopbackIngestHost(host) {
        return /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(String(host || ""));
    }

    function setIngestState(phase, detail = "") {
        ingestState = { phase, detail: String(detail || "") };
    }

    /** 面板同时展示业务完成度和原有技术计数，便于区分“商品没匹配”与“接口没保存”。 */
    function render(message = null) {
        if (message !== null) state.message = message;
        if (!root) return;
        const status = root.querySelector(".status");
        status.textContent = state.phase;
        status.classList.remove("on", "off", "warn", "bad", "done");
        status.classList.add(statusClass());
        const captureStatus = root.querySelector(".capture-status");
        if (captureStatus) {
            captureStatus.textContent = captureStatusText();
            captureStatus.classList.remove("on", "off", "warn", "bad", "done");
            captureStatus.classList.add(statusClass());
        }
        const expected = expectedProductCount();
        root.querySelector(".expected").textContent = expected === null ? "统计中" : String(expected);
        root.querySelector(".source").textContent = state.expectedSource;
        const removed = root.querySelector(".removed");
        if (removed) removed.textContent = String(state.removedProductIds.size);
        root.querySelector(".declared").textContent = Number.isInteger(state.declaredProductCount) ? String(state.declaredProductCount) : "—";
        const completed = expected === null ? state.capturedProductIds.size : Math.min(matchedProductCount(), expected);
        root.querySelector(".completed").textContent = String(completed);
        root.querySelector(".coverage").textContent = coverageText();
        const selectedCount = root.querySelector(".selected-count");
        if (selectedCount) selectedCount.textContent = `${state.selectedProductIds.size} 个${state.selectionMode ? "（本次采集）" : ""}`;
        const progress = root.querySelector(".progress");
        const progressBar = root.querySelector(".progress-bar");
        if (progress && progressBar) {
            const percent = progressPercent();
            progressBar.style.width = `${percent}%`;
            progress.classList.remove("on", "off", "warn", "bad", "done");
            progress.classList.add(statusClass());
            progress.setAttribute("aria-valuenow", String(percent));
            progress.setAttribute("aria-valuetext", coverageText());
        }
        root.querySelector(".captured").textContent = String(state.captured);
        root.querySelector(".saved").textContent = String(state.saved);
        root.querySelector(".added").textContent = String(state.added);
        root.querySelector(".duplicates").textContent = String(state.duplicates);
        root.querySelector(".failed").textContent = String(state.failed);
        root.querySelector(".productFailures").textContent = String(state.productFailures);
        root.querySelector(".total").textContent = String(state.total);
        root.querySelector(".latest").textContent = state.latest;
        const ingest = root.querySelector(".ingest");
        if (ingest) ingest.textContent = ingestStatusText();
        const ingestStatus = root.querySelector(".ingest-status");
        if (ingestStatus) {
            ingestStatus.textContent = ingestCoreText();
            ingestStatus.classList.remove("on", "off", "warn", "bad", "done");
            ingestStatus.classList.add(ingestStatusClass());
        }
        const agentStatus = root.querySelector(".agent-status");
        if (agentStatus) {
            // CLI 与商品入库 HTTP 是两条通道，接收同步成功不能伪装成 HTTP 入库成功。
            const cliOnline = currentPageIdentity().storeId && Date.now() - Number(state.cliConnectedAt || 0) < 120000;
            agentStatus.textContent = cliOnline ? "CLI 已连接（任务同步）" : (agentState.detail || "识别店铺中");
            agentStatus.classList.remove("on", "off", "warn", "bad", "done");
            agentStatus.classList.add(cliOnline || agentState.phase === "verified" || agentState.phase === "claimed" ? "done" : (agentState.phase === "error" ? "bad" : (agentState.phase === "idle" ? "off" : "warn")));
        }
        const transferStatus = root.querySelector(".transfer-status");
        const storeTasks = currentStoreTransferTasks();
        const current = currentTransferTask();
        const directProgress = directProgressView(current);
        const directBatch = directBatchProgress(storeTasks);
        const directTasks = storeTasks.filter(task => task.directCreate);
        const directPaused = Boolean(state.directPaused);
        const headStage = root.querySelector(".head-stage");
        if (headStage) headStage.textContent = directPaused ? "已停止接口创建" : (directProgress ? directProgress.label : (storeTasks.length ? "有待处理任务" : "准备就绪"));
        if (transferStatus) {
            const count = storeTasks.length;
            const labels = {
                authorizing: "预检中",
                submitting: "提交中",
                verifying: "回查中",
                created: "已创建",
                unknown: "结果待核对",
                preflight_failed: "预检失败",
                duplicate_exists: "已存在"
            };
            transferStatus.textContent = directPaused
                ? `已停止 · 批次 ${directBatch.finished}/${directBatch.total}`
                : current?.directCreate
                ? `批次 ${directBatch.finished}/${directBatch.total} · ${directProgress?.stage === "duplicate_check" ? "重复对比中" : (labels[current.directState] || "自动处理中")}`
                : (count ? `${count} 个待处理` : "0 个");
            transferStatus.classList.remove("on", "off", "warn", "bad", "done");
            transferStatus.classList.add(directPaused ? "warn" : (directProgress?.terminalDone ? "done" : (directProgress?.terminalError ? "bad" : (count ? "warn" : "off"))));
        }
        const transferProgress = root.querySelector(".transfer-progress");
        if (transferProgress) {
            // 本店只要还有接口创建任务就必须露出这张卡片：否则操作者既看不到批次进度，也找不到停止/继续入口。
            transferProgress.hidden = !directProgress && !directPaused && !directTasks.length;
            transferProgress.classList.toggle("paused", directPaused);
            const percentNode = transferProgress.querySelector(".transfer-progress-percent");
            const detailNode = transferProgress.querySelector(".transfer-progress-detail");
            if (directProgress) {
                const percent = directBatch.total > 1 ? directBatch.percent : directProgress.percent;
                percentNode.textContent = directPaused
                    ? `已停止 · ${directBatch.total > 1 ? `批次 ${directBatch.finished}/${directBatch.total} · ` : ""}SPU ${current.spuId || "未知"}`
                    : `${percent}% · ${directBatch.total > 1 ? `批次 ${directBatch.finished}/${directBatch.total} · ` : ""}SPU ${current.spuId || "未知"}`;
                detailNode.textContent = directPaused
                    ? "接口创建已停止：插件不会继续上传，刷新页面也不会自动恢复。"
                    : (directProgress.reason || directProgress.label);
                transferProgress.querySelectorAll(".stage").forEach(node => {
                    const nodeStage = node.getAttribute("data-stage");
                    const nodeIndex = directProgress.stages.indexOf(nodeStage);
                    const errorStage = directProgress.state === "unknown" ? "verifying" : (directProgress.state === "preflight_failed" ? "authorizing" : directProgress.stage);
                    node.classList.remove("active", "done", "error");
                    if (directPaused) return;
                    if (directProgress.terminalError && nodeStage === errorStage) node.classList.add("error");
                    else if (directProgress.terminalDone || nodeIndex < directProgress.index) node.classList.add("done");
                    else if (nodeIndex === directProgress.index) node.classList.add("active");
                });
            } else if (directPaused) {
                percentNode.textContent = "已停止";
                detailNode.textContent = "接口创建已停止：插件不会继续上传，刷新页面也不会自动恢复。";
                transferProgress.querySelectorAll(".stage").forEach(node => node.classList.remove("active", "done", "error"));
            } else {
                // 有接口创建任务但当前没有进行中的阶段：只报批次完成度，不伪造阶段高亮。
                percentNode.textContent = `${directBatch.percent}% · 批次 ${directBatch.finished}/${directBatch.total}`;
                detailNode.textContent = "接口创建任务已在插件后台排队，保持商品列表页打开即可。";
                transferProgress.querySelectorAll(".stage").forEach(node => node.classList.remove("active", "done", "error"));
            }
        }
        const pauseButton = root.querySelector(".transfer-pause");
        if (pauseButton) {
            // 只有本店确实有接口创建任务（或已停止）时才露出按钮，避免普通采集店铺看到无关入口。
            pauseButton.hidden = !directPaused && !directTasks.length;
            pauseButton.disabled = directPauseBusy;
            pauseButton.textContent = directPaused ? "继续接口创建" : "停止接口创建";
            pauseButton.classList.toggle("primary", directPaused);
            pauseButton.classList.toggle("secondary", !directPaused);
        }
        const retryButton = root.querySelector(".transfer-retry");
        if (retryButton) {
            // 结果未知或平台拒绝后旧 attempt 已结束，只剩人工确认这一条出口；
            // 按钮长期不露出来会让“结果待核对”的任务永远占位，同店同货号再也发不出去。
            retryButton.hidden = !(current?.directCreate
                && ['unknown', 'preflight_failed', 'rejected'].includes(String(current.directState || '')));
        }
        const nextButton = root.querySelector(".transfer-next");
        const exportButton = root.querySelector(".transfer-export");
        const doneButton = root.querySelector(".transfer-done");
        // 接口创建任务由心跳自动执行，按钮只展示进度，避免用户误点打开表单。
        if (nextButton) {
            if (current?.directCreate) {
                nextButton.disabled = true;
                nextButton.textContent = directProgress?.terminalDone
                    ? (current.directState === "duplicate_exists" ? "已存在，未重复创建" : "接口已自动创建")
                    : (current.directState === "unknown" || current.directState === "preflight_failed"
                        ? "接口创建未完成"
                        : "正在自动创建，无需点击");
            } else {
                nextButton.disabled = false;
                nextButton.textContent = location.pathname === "/goods/edit"
                    ? "填入商品资料（不提交）"
                    : "打开待上传商品页";
            }
        }
        if (exportButton) exportButton.hidden = !storeTasks.length;
        if (doneButton) doneButton.hidden = !storeTasks.some(task => task.status === "upload_opened");
        syncCaptureButtons();
        syncInterfaceDiagnosticControls();
        root.querySelector(".message").textContent = state.message || "";
        publishPublicStatus();
        const operationState = { action: "panel-state", phase: state.phase, ingestPhase: ingestState.phase,
            agentPhase: agentState.phase, enabled: state.enabled, expectedCount: expected,
            completedCount: completed, pendingCount: storeTasks.length, pageUrl: location.origin + location.pathname };
        const signature = JSON.stringify(operationState);
        if (signature !== lastOperationState) {
            lastOperationState = signature;
            logOperation({ ...operationState, status: "changed" });
        }
        if (message !== null) logOperation({ action: "user-notice", status: "displayed", reason: message });
    }

    async function refreshStats() {
        const result = await send("getStats");
        if (result && result.ok) state.total = result.total || 0;
        render();
    }

    function ingestHostText(endpoint) {
        try {
            return new URL(endpoint).host;
        } catch (_) {
            return "";
        }
    }

    /** 展开区显示完整节点信息：地址、自动推送、待令牌或紫鸟回环警告。 */
    function ingestStatusText() {
        const host = ingestHostText(ingestSettings.endpoint) || ingestSettings.endpoint;
        if (!host) return "未配置";
        const mode = ingestSettings.autoPush === false ? "已关闭自动" : "采集后自动";
        if (!ingestSettings.token) return `${host} / ${mode} / 待令牌`;
        if (isLoopbackIngestHost(host)) return `${host} / ${mode} / 紫鸟请改局域网`;
        if (ingestQueue.currentPending && ingestQueue.fingerprint === ingestFingerprint) {
            return `${host} / ${mode} / 排队 ${ingestQueue.pendingCount}`;
        }
        return `${host} / ${mode}`;
    }

    /** 读取节点设置后刷新配置态；正在推送或已经入库的本次结果不能被设置页保存冲掉。 */
    async function refreshIngestSettings() {
        const result = await send("ensureIngestConnection").catch(() => null);
        if (result && result.ok && result.settings) ingestSettings = result.settings;
        // 设置页保存后要重算配置态；正在推送或已经入库的本次结果不能被设置刷新冲掉。
        if (ingestState.phase !== "pushing" && ingestState.phase !== "done" && ingestState.phase !== "retry") {
            if (!ingestSettings.endpoint) setIngestState("need_setup", "未配置地址");
            else if (!ingestSettings.token) setIngestState("need_setup", "待令牌");
            else if (isLoopbackIngestHost(ingestHostText(ingestSettings.endpoint))) setIngestState("warn", "本机地址，紫鸟可能连不上");
            else if (ingestState.phase !== "error" && ingestState.phase !== "blocked") {
                setIngestState("idle", ingestSettings.autoPush === false ? "已关闭自动" : "采集后自动");
            }
        }
        render();
    }


    /**
     * 紫鸟 CLI 读不到 closed Shadow DOM。只把不含令牌、不含商品正文的状态写到宿主属性和 CustomEvent，
     * 供工人 page exec 读取；禁止把上传令牌或完整采集包暴露给页面脚本。
     */
    function publicPluginStatus(identity) {
        const page = identity || currentPageIdentity();
        const expected = expectedProductCount();
        return {
            pluginPresence: PLUGIN_PRESENCE,
            pluginVersion: PLUGIN_VERSION,
            pluginInstanceId: pluginInstanceId || "",
            pageUrl: page.pageUrl || location.href,
            pageType: page.pageType || "",
            pageStoreName: page.pageStoreName || "",
            nameSource: page.source || "unresolved",
            nameConfidence: page.confidence || "none",
            // 公开字段只暴露当前页已核验的映射。10.0.x 残留手工绑定若店名对不上，不能写到宿主属性。
            mappedStoreId: mappedStore.storeId || page.storeId || "",
            mappedStoreName: mappedStore.storeName || (page.storeId ? page.storeName : "") || "",
            expectedCount: expected,
            // 店铺已删除、已从本批次排除的商品数；只写数量，不写货号或商品正文。
            removedCount: state.removedProductIds.size,
            completedCount: matchedProductCount(),
            capturePhase: state.phase,
            ingestPhase: ingestState.phase,
            pendingUploadCount: currentStoreTransferTasks(page).length,
            finished: Boolean(state.finished),
            lastError: String(ingestQueue.lastError || state.message || "").slice(0, 80)
        };
    }

    function publishPublicStatus(identity) {
        const status = publicPluginStatus(identity);
        const panel = panelHost || document.getElementById(PANEL_HOST_ID);
        if (panel) {
            panel.setAttribute("data-plugin-presence", status.pluginPresence);
            panel.setAttribute("data-plugin-version", status.pluginVersion);
            panel.setAttribute("data-plugin-instance-id", status.pluginInstanceId);
            panel.setAttribute("data-page-store-name", status.pageStoreName);
            panel.setAttribute("data-page-type", status.pageType);
            panel.setAttribute("data-name-source", status.nameSource);
            panel.setAttribute("data-mapped-store-id", status.mappedStoreId);
            panel.setAttribute("data-mapped-store-name", status.mappedStoreName);
            panel.setAttribute("data-expected-count", status.expectedCount == null ? "" : String(status.expectedCount));
            panel.setAttribute("data-removed-count", String(status.removedCount || 0));
            panel.setAttribute("data-completed-count", String(status.completedCount || 0));
            panel.setAttribute("data-capture-phase", status.capturePhase || "");
            panel.setAttribute("data-ingest-phase", status.ingestPhase || "");
            panel.setAttribute("data-pending-upload-count", String(status.pendingUploadCount || 0));
            panel.setAttribute("data-bound-store-id", status.mappedStoreId);
            panel.setAttribute("data-bound-store-name", status.mappedStoreName);
        }
        try {
            window.dispatchEvent(new CustomEvent(STATUS_EVENT, { detail: status }));
        } catch (_) {}
        return status;
    }

    /** 当前页面店名变化时丢弃旧映射；同一紫鸟窗口切店后绝不能继续代表上一家店领取任务。 */
    function currentPageIdentity() {
        const helper = typeof TemuStoreIdentity !== "undefined" ? TemuStoreIdentity : null;
        const page = helper && typeof helper.readPageIdentity === "function"
            ? helper.readPageIdentity()
            : { pageUrl: location.href, storeName: "", storeId: "", source: "unresolved" };
        const mappedMatchesPage = Boolean(mappedStore.storeId && mappedStore.storeName && page.storeName && helper && (
            helper.namesMatch(page.storeName, mappedStore.storeName)
            || (helper.namesCompatible && helper.namesCompatible(page.storeName, mappedStore.storeName))
        ));
        if (mappedStore.storeId && page.storeName && !mappedMatchesPage) {
            mappedStore = { storeId: "", storeName: "" };
        }
        const boundMatchesPage = Boolean(boundStore.storeName && page.storeName && helper && (
            helper.namesMatch(page.storeName, boundStore.storeName)
            || (helper.namesCompatible && helper.namesCompatible(page.storeName, boundStore.storeName))
        ));
        // 10.0.x 残留的手工绑定不能在店名对不上时继续冒充当前窗口，否则两家店会被写成同一个来源。
        return {
            storeId: (mappedMatchesPage ? mappedStore.storeId : "") || (boundMatchesPage ? boundStore.storeId : "") || "",
            storeName: (mappedMatchesPage ? mappedStore.storeName : "") || (boundMatchesPage ? boundStore.storeName : "") || page.storeName || "",
            pageUrl: page.pageUrl || location.href,
            pageStoreName: page.storeName || "",
            pageType: page.pageType || "",
            source: page.source || "unresolved",
            confidence: page.confidence || "none"
        };
    }

    /** 人工打开上传页和确认时复用与心跳相同的店名核验，不能仅相信页面脚本传入的 storeId。 */
    function currentPageIdentityMatched(identity = currentPageIdentity()) {
        const helper = typeof TemuStoreIdentity !== "undefined" ? TemuStoreIdentity : null;
        const expectedName = mappedStore.storeName || boundStore.storeName || "";
        if (!identity.storeId || !identity.pageStoreName || !expectedName || !helper) return false;
        return Boolean(helper.namesMatch(identity.pageStoreName, expectedName)
            || (helper.namesCompatible && helper.namesCompatible(identity.pageStoreName, expectedName))
            || (helper.nameFoundInText && helper.nameFoundInText(document.body && document.body.innerText || "", expectedName)));
    }

    /**
     * 插件进入页面后主动识别 Temu 店名并公开只读状态。紫鸟 storeId 由中转仓工人按店名映射补齐，
     * 没有映射时仍上报心跳，但不能领取发给具体店铺的任务。
     */
    /**
     * 目标店心跳的单飞锁与退避。页面脚本可能在定时器、刷新状态和接口回调中同时触发同步，
     * 这里保证同一页面不会并发领取任务；连续断网时退避也避免每 8 秒堆积一个超时请求。
     */
    async function syncStoreAgent() {
        if (agentSyncInFlight) return agentSyncInFlight;
        if (Date.now() < agentNextSyncAt) return null;
        agentSyncInFlight = syncStoreAgentNow().finally(() => { agentSyncInFlight = null; });
        return agentSyncInFlight;
    }

    async function syncStoreAgentNow() {
        const bound = await send("getBoundStore").catch(() => null);
        if (bound && bound.ok && bound.store) boundStore = bound.store;
        const identity = currentPageIdentity();
        // 新版始终通过云端API同步；CLI心跳只作诊断，不再抑制插件领取。
        state.cliConnectedAt = Number(bound?.cliConnectedAt || 0);
        const helper = typeof TemuStoreIdentity !== "undefined" ? TemuStoreIdentity : null;
        // 心跳核验只拿当前页对得上的店名。残留手工绑定如果属于另一家店，不能拿来当 expectedName。
        const boundMatchesPage = Boolean(boundStore.storeName && identity.pageStoreName && helper && (
            helper.namesMatch(identity.pageStoreName, boundStore.storeName)
            || (helper.namesCompatible && helper.namesCompatible(identity.pageStoreName, boundStore.storeName))
        ));
        const expectedName = mappedStore.storeName || (boundMatchesPage ? boundStore.storeName : "") || "";
        const nameMatched = Boolean(expectedName && helper && helper.namesMatch(identity.pageStoreName, expectedName));
        const nameCompatible = Boolean(expectedName && helper && helper.namesCompatible && helper.namesCompatible(identity.pageStoreName, expectedName));
        const textMatched = Boolean(expectedName && helper && helper.nameFoundInText && helper.nameFoundInText(document.body && document.body.innerText || "", expectedName));
        const identityMatched = Boolean((nameMatched || nameCompatible || textMatched) && identity.pageStoreName);
        const agentIdentity = {
            ...identity,
            identityMatched,
            expectedCount: expectedProductCount(),
            completedCount: matchedProductCount(),
            capturePhase: state.phase,
            ingestPhase: ingestState.phase,
            pendingUploadCount: currentStoreTransferTasks(identity).length,
            sourceTag: "plugin-heartbeat"
        };
        publishPublicStatus(agentIdentity);
        try {
            // 店名改变时必须立即重新登记；同一店铺只每分钟续租一次，减少一次完整网络往返。
            const pageStoreChanged = agentRegisteredPageStoreName !== String(identity.pageStoreName || "");
            let registered = null;
            if (!agentRegisteredAt || pageStoreChanged || Date.now() - agentRegisteredAt >= AGENT_REGISTER_INTERVAL_MS) {
                if (!agentRegisterInFlight) {
                    agentRegisterInFlight = send("registerStoreAgent", { identity: agentIdentity })
                        .finally(() => { agentRegisterInFlight = null; });
                }
                registered = await agentRegisterInFlight;
                agentRegisteredAt = Date.now();
                agentRegisteredPageStoreName = String(identity.pageStoreName || "");
            } else {
                registered = { ok: true, agent: { pluginInstanceId, storeId: mappedStore.storeId, storeName: mappedStore.storeName } };
            }
            if (!registered?.ok) throw new Error(registered?.error || "agent_register_failed");
            if (registered && registered.ok && registered.agent) {
                pluginInstanceId = String(registered.agent.pluginInstanceId || pluginInstanceId || "");
                if (registered.agent.storeId) {
                    mappedStore = {
                        storeId: String(registered.agent.storeId || ""),
                        storeName: String(registered.agent.storeName || expectedName || identity.pageStoreName || "")
                    };
                    agentIdentity.storeId = mappedStore.storeId;
                    agentIdentity.storeName = mappedStore.storeName;
                    const mappedName = mappedStore.storeName;
                    agentIdentity.identityMatched = Boolean(identity.pageStoreName && mappedName && helper && (
                        helper.namesMatch(identity.pageStoreName, mappedName)
                        || (helper.namesCompatible && helper.namesCompatible(identity.pageStoreName, mappedName))
                        || (helper.nameFoundInText && helper.nameFoundInText(document.body && document.body.innerText || "", mappedName))
                    ));
                }
            }
            if (!identity.pageStoreName) {
                agentState = { phase: "idle", detail: "未识别店铺", claimed: 0 };
                render();
                return;
            }
            if ((mappedStore.storeName || (boundMatchesPage ? boundStore.storeName : "")) && !agentIdentity.identityMatched) {
                agentState = { phase: "error", detail: "店铺身份不符", claimed: 0 };
                render();
                return;
            }
            if (!agentIdentity.storeId) {
                agentState = { phase: "idle", detail: identity.pageStoreName, claimed: 0 };
                render();
                return;
            }
            // 没有本地待办时无需访问状态核对接口；有待办才清理终态，减少一次串行请求。
            if (currentStoreTransferTasks(agentIdentity).length) {
                const reconciled = await send("reconcileTargetUploadTasks", { identity: agentIdentity }).catch(() => null);
                if (reconciled && reconciled.ok && Array.isArray(reconciled.tasks)) state.transferTasks = reconciled.tasks;
                if (reconciled && reconciled.ok && typeof reconciled.directPaused === "boolean") state.directPaused = reconciled.directPaused;
            }
            const claimed = await send("claimStoreJobs", { identity: agentIdentity });
            if (!claimed?.ok) throw new Error(claimed?.error || "task_claim_failed");
            const jobs = claimed && Array.isArray(claimed.claimed) ? claimed.claimed : [];
            if (claimed && claimed.ok && Array.isArray(claimed.tasks)) state.transferTasks = claimed.tasks;
            if (claimed && claimed.ok && typeof claimed.directPaused === "boolean") state.directPaused = claimed.directPaused;
            agentState = {
                phase: jobs.length ? "claimed" : "idle",
                detail: jobs.length ? ("已领 " + jobs.length) : identity.pageStoreName,
                claimed: jobs.length
            };
            if (claimed && Number(claimed.receivedCount) > 0) {
                agentState = { phase: "claimed", detail: `已接收，正在自动创建 ${currentStoreTransferTasks(agentIdentity).length} 个`, claimed: jobs.length };
                state.message = "接口创建任务已接收，插件正在自动创建，无需点击上传。";
            }
            const currentTask = currentTransferTask(agentIdentity);
            if (currentTask?.directCreate) {
                const labels = {
                    received: "重复对比中",
                    authorizing: "正在预检",
                    submitting: "正在提交",
                    verifying: "正在回查",
                    created: "接口已创建",
                    unknown: "结果待核对",
                    preflight_failed: "预检失败",
                    duplicate_exists: "已存在，未重复创建"
                };
                agentState = {
                    phase: currentTask.directState === "created" ? "verified" : (currentTask.directState === "preflight_failed" || currentTask.directState === "unknown" ? "error" : "claimed"),
                    detail: state.directPaused ? "已停止接口创建" : (labels[currentTask.directState] || `已接收，正在自动创建 ${currentStoreTransferTasks(agentIdentity).length} 个`),
                    claimed: jobs.length
                };
                if (state.directPaused) {
                    state.message = "接口创建已停止，插件不会继续上传；点“继续接口创建”才会恢复。";
                } else if (currentTask.reason) {
                    state.message = currentTask.reason;
                } else if (!currentTask.directState || currentTask.directState === "received") {
                    state.message = `已接收 SPU ${currentTask.spuId}，正在自动创建，无需点击。`;
                }
            }
        } catch (error) {
            // 区分连接阶段，避免用户把未领取任务误认为商品发布失败。
            const connectionErrors = {
                missing_ingest_token: "未连接：缺少令牌",
                ingest_unreachable: "插件无法访问仓库地址",
                ingest_probe_timeout: "仓库连接超时（10秒）",
                ingest_permission_denied: "未授权访问仓库地址",
                missing_mapped_store: "尚未绑定目标店铺",
                ingest_unauthorized: "仓库令牌无效"
            };
            agentState = { phase: "error", detail: connectionErrors[String(error?.message || "")] || "任务连接失败，请导出日志", claimed: 0 };
            // 连续断网时采用指数退避，避免每 8 秒重复等待一次网络超时；初始化流程仍保持可用。
            agentSyncFailures = Math.min(agentSyncFailures + 1, 4);
            const delay = Math.min(AGENT_RETRY_BACKOFF_MAX_MS,
                AGENT_RETRY_BACKOFF_BASE_MS * (2 ** Math.max(0, agentSyncFailures - 1)));
            agentNextSyncAt = Date.now() + delay;
            render();
            return false;
        }
        agentSyncFailures = 0;
        agentNextSyncAt = 0;
        render();
        return true;
    }

    /** 后台队列和页面入库行同步，失败后仍显示排队/重试，而不是立刻当成永久失败。 */
    function applyIngestQueue(queue) {
        if (!queue || typeof queue !== "object") return;
        ingestQueue = {
            pendingCount: Number(queue.pendingCount) || 0,
            currentPending: Boolean(queue.currentPending),
            attempts: Number(queue.attempts) || 0,
            maxAttempts: Number(queue.maxAttempts) || 5,
            nextAttemptAt: String(queue.nextAttemptAt || ""),
            lastError: String(queue.lastError || ""),
            fingerprint: String(queue.fingerprint || ""),
            outcome: queue.outcome && typeof queue.outcome === "object" ? queue.outcome : null
        };
        applyCurrentIngestOutcome();
    }

    /**
     * 面板只认当前采集任务的 fingerprint。别人还在排队，或当前任务已经成功/永久失败，
     * 都不能再被总队列摘要改回“采集后自动”。
     */
    function applyCurrentIngestOutcome() {
        const mine = ingestFingerprint && ingestQueue.fingerprint === ingestFingerprint;
        const outcome = mine ? ingestQueue.outcome : null;
        if (outcome && (outcome.reason === "empty_packet" || outcome.reason === "no_products" || outcome.error === "empty_packet" || outcome.error === "no_products")) {
            setIngestState("blocked", "本地无商品，未入库");
            return;
        }
        if (outcome && outcome.status === "done") {
            setIngestState("done", outcome.batchId ? `已入库 ${outcome.batchId}` : "已入库");
            return;
        }
        if (outcome && outcome.status === "error") {
            setIngestState("error", ingestErrorText(outcome.error || outcome.reason));
            return;
        }
        if (ingestState.phase === "done") return;
        if (mine && ingestQueue.currentPending) {
            const retryLabel = ingestQueue.attempts
                ? `排队 ${ingestQueue.pendingCount}，已试 ${ingestQueue.attempts}/${ingestQueue.maxAttempts}`
                : `排队 ${ingestQueue.pendingCount}`;
            setIngestState("retry", retryLabel);
            return;
        }
        // 正在推送时即使已有 fingerprint，只要队列里还没有本任务或终态，就不能冲成默认态。
        if (ingestState.phase === "pushing" && !(mine && (ingestQueue.currentPending || outcome))) return;
        if (ingestState.phase === "retry" || ingestState.phase === "pushing") {
            setIngestState("idle", ingestSettings.autoPush === false ? "已关闭自动" : "采集后自动");
        }
    }

    async function refreshIngestQueue() {
        const result = await send("getIngestQueue", { fingerprint: ingestFingerprint }).catch(() => null);
        if (result && result.ok && result.queue) applyIngestQueue(result.queue);
        render();
    }

    /** 把直推失败原因翻成操作说明，避免面板直接显示 missing_ingest_token 这类内部码。 */
    function ingestErrorText(error) {
        const code = String(error || "");
        if (code === "missing_ingest_token") return "还没有入库令牌。请先启动入库台，再打开节点设置并保存授权。";
        if (code === "ingest_permission_denied") return "还没有授权访问该入库地址，请打开节点设置并点击保存并授权。";
        if (code === "invalid_ingest_endpoint") return "入库地址不是合法的 http/https 地址。";
        if (code === "ingest_unauthorized") return "令牌不正确，请从仓库首页重新复制。";
        if (code === "ingest_unreachable") return "插件无法访问仓库地址，请检查网站、地址和代理连接。";
        if (code === "ingest_probe_timeout") return "仓库连接探测超过10秒，请检查网络和地址。";
        if (code === "ingest_endpoint_mismatch") return "入库地址路径不正确。请填写仓库首页给出的 /api/ingest 地址。";
        if (code === "empty_packet" || code === "no_products") return "本地没有可推送的商品记录，未创建批次。";
        if (/failed to fetch|networkerror|net::/i.test(code)) return "请求未取得HTTP响应，请检查仓库地址、权限及代理连接。";
        return code || "未知错误";
    }

    /** 页面路由或任务代际变化时清理旧商品集合，防止跨页响应污染当前页。 */
    function resetPageContext(resetTechnicalCounters) {
        clearCompletionTimers();
        state.pageKey = getPageContextKey();
        state.pageProductIds.clear();
        state.domProductIds.clear();
        state.listProductIds.clear();
        state.removedProductIds.clear();
        state.removalKnownProductIds.clear();
        state.rowSkcIds.clear();
        state.removedOnlyPage = false;
        state.pendingProductIds.clear();
        state.pendingVerifiedProductIds.clear();
        state.runEventIds.clear();
        state.capturedProductIds.clear();
        state.verifiedMatchedProductIds.clear();
        state.pageVisibleCount = 0;
        state.declaredProductCount = null;
        state.expectedSource = "暂无";
        state.pageScanReady = false;
        // 诊断必须与 pageContextKey 同生共死，筛选或分页切换后不能把上一页的 DOM 误写进新日志。
        state.domDiagnostics = null;
        state.productEvents = 0;
        state.primaryProductEvents = 0;
        state.lastEventAt = 0;
        state.lastProductEventAt = 0;
        state.finished = false;
        state.runGeneration += 1;
        pageContextStartedAt = Date.now();
        ingestFingerprint = "";
        ingestQueue = { pendingCount: ingestQueue.pendingCount, currentPending: false, attempts: 0, maxAttempts: ingestQueue.maxAttempts, nextAttemptAt: "", lastError: "", fingerprint: "", outcome: null };
        state.drainDeadline = 0;
        state.startedAt = state.enabled ? Date.now() : 0;
        if (resetTechnicalCounters) {
            state.captured = 0;
            state.saved = 0;
            state.added = 0;
            state.duplicates = 0;
            state.failed = 0;
            state.productFailures = 0;
            state.latest = "暂无";
        }
        state.phase = state.enabled ? "统计页面商品" : "未启动";
    }

    /**
     * 清空上一批次留在页面内存中的详情状态。
     * 普通采集不再刷新页面，因此必须在同页重新开始时主动解除旧队列终态，否则新批次会被旧状态拦住。
     */
    function resetDetailRuntimeForNewCapture() {
        if (state.detailIdleTimer) clearTimeout(state.detailIdleTimer);
        if (state.detailTimeoutTimer) clearTimeout(state.detailTimeoutTimer);
        state.detailMode = false;
        state.detailQueue = null;
        state.detailSpuId = "";
        state.detailEventCount = 0;
        state.detailEvidence = false;
        state.detailCaptured = false;
        state.detailCompleteness = "partial";
        state.detailMissing = [];
        state.detailIdleTimer = null;
        state.detailTimeoutTimer = null;
        state.detailSupplementStarted = false;
        state.apiRunning = false;
    }

    /**
     * 等待当前商品行完成一次稳定扫描。
     * 采集按钮不再刷新页面，点击瞬间列表可能仍在渲染，因此只等待当前 DOM，不读取历史页或接口旧集合。
     */
    async function waitForCurrentPageScan(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() <= deadline) {
            scanPageProducts();
            if (captureProductIds().size || state.removedOnlyPage) return true;
            await new Promise(resolve => setTimeout(resolve, 120));
        }
        return false;
    }

    /** 开启一次可追踪任务代际，并设置硬超时；同页重新采集时由当前 DOM 重建任务范围。 */
    function beginRun() {
        state.runGeneration += 1;
        state.startedAt = Date.now();
        state.finished = false;
        state.phase = state.pageScanReady ? "正在采集" : "统计页面商品";
        state.drainDeadline = 0;
        ingestFingerprint = "";
        setIngestState("idle", "");
        clearCompletionTimers();
        state.timeoutTimer = setTimeout(() => evaluateCompletion(true), RUN_TIMEOUT_MS);
        scheduleCompletionCheck();
        render("已启动，先统计当前页面商品，再等待接口响应…");
    }

    /** 将响应 ID 与页面预期集合求交集；verified 只代表当前页主列表响应。 */
    function matchProductIds(ids, verified = false) {
        const values = Array.isArray(ids) ? ids : [];
        const targets = captureProductIds();
        if (!state.pageScanReady) {
            values.forEach(value => {
                const productId = normalizeProductId(value);
                if (productId) state.pendingProductIds.add(productId);
                if (verified && productId) state.pendingVerifiedProductIds.add(productId);
            });
            return;
        }
        values.forEach(value => {
            const productId = normalizeProductId(value);
            if (!productId) return;
            // 有页面 ID 时严格匹配；只有数量兜底时仍显示已识别 ID，但完成状态会标黄说明不可完全核验。
            if (!targets.size || targets.has(productId)) {
                state.capturedProductIds.add(productId);
                if (verified && targets.has(productId)) state.verifiedMatchedProductIds.add(productId);
            }
        });
    }

    /** DOM 首次扫描完成后释放网络早到的 ID，确保匹配顺序符合“先统计、后匹配”。 */
    function matchPendingProductIds() {
        if (!state.pageScanReady || !state.pendingProductIds.size) return;
        const pending = Array.from(state.pendingProductIds);
        state.pendingProductIds.clear();
        const pendingVerified = new Set(state.pendingVerifiedProductIds);
        state.pendingVerifiedProductIds.clear();
        matchProductIds(pending, false);
        matchProductIds(Array.from(pendingVerified), true);
    }

    /** 运行日志只携带结构计数和少量 SPU 样本；完整候选行 HTML 由“页面结构诊断”单独保存。 */
    function makeDomDiagnosticsSummary() {
        if (!state.domDiagnostics || typeof state.domDiagnostics !== "object") return null;
        const diagnostics = state.domDiagnostics;
        const counts = diagnostics.counts && typeof diagnostics.counts === "object" ? diagnostics.counts : {};
        return {
            detailLevel: String(diagnostics.detailLevel || "summary"),
            capturedAt: String(diagnostics.capturedAt || "").slice(0, 40),
            activePageLabels: Array.isArray(diagnostics.activePageLabels) ? diagnostics.activePageLabels.slice(0, 20) : [],
            roots: Array.isArray(diagnostics.roots) ? diagnostics.roots.slice(0, 20) : [],
            counts: {
                tables: Number.isInteger(counts.tables) ? counts.tables : 0,
                tbody: Number.isInteger(counts.tbody) ? counts.tbody : 0,
                tr: Number.isInteger(counts.tr) ? counts.tr : 0,
                roleRows: Number.isInteger(counts.roleRows) ? counts.roleRows : 0,
                visibleCandidateRows: Number.isInteger(counts.visibleCandidateRows) ? counts.visibleCandidateRows : 0,
                selectedProductRows: Number.isInteger(counts.selectedProductRows) ? counts.selectedProductRows : 0,
                iframes: Number.isInteger(counts.iframes) ? counts.iframes : 0,
                openShadowRoots: Number.isInteger(counts.openShadowRoots) ? counts.openShadowRoots : 0
            },
            scanScope: String(diagnostics.scanScope || "document 主文档；未扫描 iframe/shadowRoot 内部").slice(0, 120),
            // 详细诊断中的 row.node 可能包含递归子树；运行日志只保留轻量字段，完整树只存在 pageDiagnostics。
            rowSamples: Array.isArray(diagnostics.rowSamples) ? diagnostics.rowSamples.slice(0, 20).map(row => ({
                selectedAsProductRow: Boolean(row && (row.selectedAsProductRow || row.spuMatch)),
                spuMatch: normalizeProductId(row && row.spuMatch),
                tag: row && row.node && row.node.tag ? String(row.node.tag).slice(0, 30) : String(row && row.tag || "").slice(0, 30),
                className: row && row.node && row.node.attributes ? String(row.node.attributes.class || "").slice(0, 160) : String(row && row.className || "").slice(0, 160),
                text: sanitizeDiagnosticText(row && row.node ? row.node.text : row && row.text, 260)
            })) : [],
            domProductIds: Array.from(state.domProductIds).slice(0, 20),
            declaredProductCount: state.declaredProductCount,
            expectedSource: state.expectedSource
        };
    }

    /** 生成统一的运行快照，完成、暂停、超时和用户提前导出都使用同一字段口径。 */
    function makeRunSummary(phase = state.phase) {
        const rawPageKey = String(state.pageKey || getPageContextKey());
        const parts = rawPageKey.split("||");
        const pathPart = parts[0] || `${location.origin}${location.pathname}`;
        const labelsPart = parts[1] || "";
        const filterPart = parts[2] || "";
        const listPart = parts[3] || "";
        const safePageKey = [
            pathPart,
            labelsPart,
            filterPart ? `filter:${filterPart}` : "",
            listPart ? `list:${listPart}` : ""
        ].filter(Boolean).join("|").slice(0, 500);
        return {
            phase,
            expectedCount: expectedProductCount(),
            completedCount: matchedProductCount(),
            pageProductIdsCount: state.pageProductIds.size,
            matchedProductIdsCount: state.verifiedMatchedProductIds.size,
            pageProductIdsSample: Array.from(state.pageProductIds).slice(0, 20),
            matchedProductIdsSample: Array.from(state.verifiedMatchedProductIds).slice(0, 20),
            captured: state.captured,
            saved: state.saved,
            failed: state.failed,
            productFailures: state.productFailures,
            durationMs: state.startedAt ? Math.max(0, Date.now() - state.startedAt) : null,
            expectedSource: state.expectedSource,
            declaredProductCount: state.declaredProductCount,
            pageVisibleCount: state.pageVisibleCount,
            domDiagnostics: makeDomDiagnosticsSummary(),
            productEvents: state.productEvents,
            primaryProductEvents: state.primaryProductEvents,
            pendingWrites: state.pendingWrites,
            bufferOverflow: state.bufferOverflow,
            finished: state.finished,
            pageContextKey: safePageKey,
            activePageLabels: state.domDiagnostics && Array.isArray(state.domDiagnostics.activePageLabels)
                ? state.domDiagnostics.activePageLabels
                : [],
            allowedSpuIds: Array.from(captureProductIds()),
            lastEventAt: state.lastEventAt || null,
            lastProductEventAt: state.lastProductEventAt || null,
            ingestQueue: {
                pendingCount: ingestQueue.pendingCount,
                attempts: ingestQueue.attempts,
                maxAttempts: ingestQueue.maxAttempts,
                nextAttemptAt: ingestQueue.nextAttemptAt
            },
            autoExport: { ...state.autoExport },
            detailSupplement: state.detailQueue ? {
                mode: state.detailQueue.mode === "api" ? "api" : (state.detailMode ? "detail" : "list"),
                runId: state.detailQueue.runId || "",
                spuId: state.detailSpuId || "",
                eventCount: state.detailEventCount,
                detailEvidence: state.detailEvidence,
                detailCaptured: state.detailCaptured,
                completeness: state.detailCompleteness,
                missing: state.detailMissing.slice(0, 8),
                total: Number(state.detailQueue.total) || 0,
                completed: Number(state.detailQueue.completed) || 0,
                complete: Number(state.detailQueue.complete) || 0,
                partial: Number(state.detailQueue.partial) || 0,
                failed: Number(state.detailQueue.failed) || 0,
                currentIndex: Number(state.detailQueue.currentIndex) || 0
            } : null
        };
    }

    /** 进入终态后关闭该页采集开关，并提升代际隔离迟到的网络回执。 */
    function finishCapture(phase, message) {
        if (state.finished) return;
        state.runGeneration += 1;
        state.finished = true;
        state.enabled = false;
        state.phase = phase;
        state.message = message;
        clearCompletionTimers();
        const summary = makeRunSummary(phase);
        send("setCaptureEnabled", { enabled: false }).catch(() => {});
        send("captureRun", { summary }).catch(() => {});
        render();
        pushAfterCapture(message, {
            saved: summary.saved,
            productEvents: summary.productEvents,
            pendingWrites: summary.pendingWrites,
            eventIds: Array.from(state.runEventIds),
            // 选择性采集锁定的是跨页 SPU 清单；终态上传不能退回刷新后的当前页集合。
            allowedSpuIds: Array.from(captureProductIds())
        });
    }

    /**
     * 采集终态后默认把本地完整包推进入库台。
     * 用户在设置里关闭自动推送时才跳过；空包不创建批次，避免把“没抓到”写成一次成功入库。
     * 终态确定后立刻把当前页 SPU 白名单交给后台排队执行，不依赖页面继续停留。
     */
    function pushAfterCapture(message, runContext) {
        // 终态可能来自 DOM 识别失败或空页面；本次没有商品响应时不能把 IndexedDB 里的旧包冒充本次结果上传。
        if (Number(runContext && runContext.saved) <= 0 || Number(runContext && runContext.productEvents) <= 0) {
            setIngestState("blocked", "本次无商品，未入库");
            render(`${message} 本次没有保存到商品响应，未自动入库；历史本地数据仍保留。`);
            return;
        }
        if (Number(runContext.pendingWrites) > 0) {
            setIngestState("blocked", "写入未完成，未入库");
            render(`${message} 结束时仍有响应未确认写入，未自动入库；展开后可手动推送。`);
            return;
        }
        const ingestContext = {
            saved: runContext.saved,
            productEvents: runContext.productEvents,
            eventIds: runContext.eventIds,
            allowedSpuIds: runContext.allowedSpuIds
        };
        ingestFingerprint = "";
        if (ingestSettings.autoPush === false) {
            setIngestState("blocked", "已关闭自动");
            render(`${message} 自动入库已关闭。展开后可点“立即推送到入库台”。`);
            return;
        }
        if (!ingestSettings.token) {
            setIngestState("need_setup", "待令牌");
            render(`${message} 还没有入库令牌，未自动入库。请展开后打开节点设置，保存授权或粘贴入库台首页的令牌。`);
            return;
        }
        if (isLoopbackIngestHost(ingestHostText(ingestSettings.endpoint))) {
            setIngestState("warn", "本机地址，紫鸟可能连不上");
        }
        // 先按与后台相同的规则记住本次指纹，避免消息失败后刷新入库状态找不到任务。
        rememberIngestFingerprint(ingestContext);
        setIngestState("pushing", "正在推送");
        render(`${message} 正在推送到入库台…`);
        // 立刻把当前页 SPU 白名单交给后台落盘执行；页面切走后由 service worker 继续。
        send("autoPushFullPacket", { context: ingestContext }).then(result => {
                ingestFingerprint = String(result && result.fingerprint || ingestFingerprint);
                if (result && result.queue) applyIngestQueue(result.queue);
                if (!result || !result.ok) {
                    const failedMine = Boolean(ingestFingerprint)
                        && String(result && result.fingerprint || "") === ingestFingerprint
                        && !(result.queue && result.queue.outcome && result.queue.outcome.status === "done");
                    if (failedMine && result.queue && result.queue.pendingCount > 0 && !(result.queue.outcome && result.queue.outcome.status === "error")) {
                        applyIngestQueue(result.queue);
                        render(`${message} 入库台暂不可达，已排队 ${result.queue.pendingCount} 个任务，后台会自动重试。`);
                    } else {
                        applyIngestQueue(result.queue || ingestQueue);
                        setIngestState("error", ingestErrorText((result.queue && result.queue.outcome && result.queue.outcome.error) || (result && result.error)));
                        render(`${message} 自动入库失败：${ingestErrorText((result.queue && result.queue.outcome && result.queue.outcome.error) || (result && result.error))} 展开后可改节点设置或手动推送。`);
                    }
                    return;
                }
                if (result.skipped) {
                    if (result.reason === "empty_packet") {
                        setIngestState("blocked", "本地无商品，未入库");
                        render(`${message} 本地没有可推送的商品记录，未创建批次。`);
                        return;
                    }
                    if (result.reason === "auto_push_disabled") {
                        setIngestState("blocked", "已关闭自动");
                        render(`${message} 自动入库已关闭。展开后可点“立即推送到入库台”。`);
                        return;
                    }
                    if (result.reason === "pending_writes") {
                        setIngestState("blocked", "写入未完成，未入库");
                        render(`${message} 仍有响应未写完，未自动入库；展开后可手动推送。`);
                        return;
                    }
                    if (result.reason === "no_products" || result.reason === "no_run_product_records") {
                        setIngestState("blocked", "未识别到商品");
                        render(`${message} 本次没有识别到可入库商品，未创建批次；请查看操作日志。`);
                        return;
                    }
                    if (result.reason === "no_current_page_spu") {
                        setIngestState("blocked", "当前页无 SPU");
                        render(`${message} 当前页没有确认的 SPU 白名单，未自动入库。`);
                        return;
                    }
                    if (result.reason === "no_pending_ingest") {
                        applyIngestQueue(result.queue || ingestQueue);
                        if (ingestQueue.pendingCount > 0) {
                            setIngestState("retry", `排队 ${ingestQueue.pendingCount}`);
                            render(`${message} 入库任务已排队，等待后台重试。`);
                            return;
                        }
                    }
                    if (result.reason === "queued") {
                        applyIngestQueue(result.queue || ingestQueue);
                        render(`${message} 入库任务已排队，后台会按顺序推送。`);
                        return;
                    }
                    if (result.reason === "already_done") {
                        applyIngestQueue(result.queue || ingestQueue);
                        render(`${message} 后台已完成入库。`);
                        return;
                    }
                    if (result.reason === "already_failed") {
                        applyIngestQueue(result.queue || ingestQueue);
                        render(`${message} 自动入库失败：${ingestErrorText((result.queue && result.queue.outcome && result.queue.outcome.error) || result.error)} 展开后可改节点设置或手动推送。`);
                        return;
                    }
                    setIngestState("blocked", result.reason || "已跳过");
                    render(`${message} 未自动入库：${result.reason || "已跳过"}。`);
                    return;
                }
                if (!result.reused && !result.batchId) {
                    setIngestState("error", "未获得批次回执");
                    render(`${message} 入库台没有返回批次，未记为已入库。展开后可手动推送。`);
                    return;
                }
                const reused = result.reused ? "仓库已有相同文件" : "已写入新批次";
                const readiness = result.batch && result.batch.readiness ? ` ${result.batch.readiness}` : "";
                setIngestState("done", result.batchId ? `已入库 ${result.batchId}` : "已入库");
                render(`${message} 已推送到入库台，${reused}${result.batchId ? ` ${result.batchId}` : ""}。${readiness}`);
        }).catch(() => {
            // 消息失败时页面可能已经记住 fingerprint；刷新状态只问这一次采集，不能改口说已经排队。
            setIngestState("blocked", "无法确认是否入队");
            render(`${message} 自动入库暂未确认。扩展消息通道失败，无法确认是否已入队；请展开后刷新状态或手动推送。`);
        });
    }

    /**
     * 只有页面统计完成、相关响应静默且写入队列清空后才给出终态；缺商品 ID 或覆盖不足时明确标记为部分完成。
     */
    function evaluateCompletion(forceTimeout = false) {
        if (!state.enabled || state.finished || !state.pageScanReady || state.detailMode || state.detailSupplementStarted) return;
        const now = Date.now();
        let writeDrainTimedOut = false;
        if (forceTimeout && state.pendingWrites > 0) {
            if (!state.drainDeadline) state.drainDeadline = now + 5000;
            if (now < state.drainDeadline) {
                state.phase = "等待写入";
                state.message = `仍有 ${state.pendingWrites} 条响应正在写入本地，等待落库后再结束。`;
                state.timeoutTimer = setTimeout(() => evaluateCompletion(true), Math.max(100, state.drainDeadline - now));
                render();
                return;
            }
            state.message = `写入等待已超时，仍有 ${state.pendingWrites} 条响应未确认落库。`;
            writeDrainTimedOut = true;
        }
        const expected = expectedProductCount();
        const hasProductResponse = state.productEvents > 0;
        const idle = hasProductResponse && now - state.lastProductEventAt >= IDLE_WINDOW_MS;
        if (!forceTimeout && (!idle || state.pendingWrites > 0)) {
            state.phase = hasProductResponse ? "等待静默" : "正在采集";
            scheduleCompletionCheck();
            render();
            return;
        }
        if (!expected) {
            // 当前页商品全部被平台标记为已删除时，本页没有可上传目标，明确说明跳过原因而不是报成识别失败。
            if (state.removedOnlyPage) {
                const deletedMessage = "当前页商品均为店铺已删除，已跳过，不上传。";
                if (!forceTimeout) {
                    state.phase = "等待静默";
                    state.message = `${deletedMessage}继续监听到超时后再结束。`;
                    render();
                    return;
                }
                finishCapture("采集完成", deletedMessage);
                return;
            }
            const message = hasProductResponse
                ? "已收到商品相关响应，但没有统计到可核对的当前页商品数量。"
                : "未统计到当前页商品，也没有捕获到商品相关接口响应。";
            if (!forceTimeout) {
                state.phase = "等待静默";
                state.message = `${message} 继续监听到超时后再结束。`;
                render();
                return;
            }
            finishCapture("采集失败", message);
            return;
        }
        if (!hasProductResponse && !forceTimeout) return;
        const targets = captureProductIds();
        const selectedRunReady = state.selectionMode && state.selectedProductIds.size > 0
            && state.primaryProductEvents > 0;
        const complete = !writeDrainTimedOut && targets.size > 0
            && (selectedRunReady || state.verifiedMatchedProductIds.size >= targets.size)
            && state.productFailures === 0
            && !state.bufferOverflow
            && state.primaryProductEvents > 0;
        if (complete && !forceTimeout) {
            // 列表主接口已覆盖页面 SPU 后，等待静默窗口再进入详情补采；即使页面不暴露 DOM，
            // 主列表接口的明确 productId 也足以组成详情队列，不能因此放弃补齐商品正文。
            if (now - state.lastProductEventAt >= IDLE_WINDOW_MS && state.pendingWrites === 0) {
                startDetailSupplement().catch(() => {});
                return;
            }
            state.phase = "商品列表已覆盖";
            state.message = state.selectionMode
                ? `已锁定 ${targets.size} 个勾选商品，等待接口静默后补采详情。`
                : `当前页 ${targets.size} 个商品均已匹配，等待接口静默后补采详情。`;
            if (state.completionTimer) clearTimeout(state.completionTimer);
            state.completionTimer = setTimeout(() => {
                state.completionTimer = null;
                evaluateCompletion(false);
            }, Math.max(100, IDLE_WINDOW_MS - (now - state.lastProductEventAt)));
            render();
        } else if (forceTimeout) {
            if (complete) {
                if (!state.detailSupplementStarted) {
                    startDetailSupplement().catch(() => {});
                    return;
                }
                const otherFailureNotice = state.failed > 0 ? `另有 ${state.failed} 条非商品接口失败，请导出日志查看。` : "";
                finishCapture(state.domProductIds.size > 0 ? "采集完成" : "部分完成", state.domProductIds.size > 0
                    ? `当前页 ${state.pageProductIds.size} 个商品均已匹配，采样窗口已结束。${otherFailureNotice}`
                    : `已识别 ${matchedProductCount()}/${expected} 个商品，但页面未提供可核验的页面 ID。${otherFailureNotice}`);
                return;
            }
            const timeoutMessage = writeDrainTimedOut
                ? `采集超时，仍有 ${state.pendingWrites} 条响应未确认落库；当前已匹配 ${matchedProductCount()}/${expected} 个商品。`
                : `采集已停止，已完成 ${matchedProductCount()}/${expected} 个商品，商品相关失败 ${state.productFailures} 条，请检查缺失商品或重新采集。`;
            finishCapture("采集超时", timeoutMessage);
        } else {
            state.phase = "等待静默";
            state.message = `接口已静默，当前已完成 ${matchedProductCount()}/${expected} 个商品；继续监听到超时，避免漏掉晚到响应。`;
            // 覆盖不足时不做百毫秒轮询；后续商品响应、DOM 变化或硬超时会再次触发判断。
            if (state.completionTimer) clearTimeout(state.completionTimer);
            state.completionTimer = null;
            render();
        }
    }

    /** 仅在最近商品响应尚未静默时设置一次定时器，静默缺口由后续响应或硬超时触发。 */
    function scheduleCompletionCheck() {
        if (state.completionTimer) clearTimeout(state.completionTimer);
        if (!state.enabled || state.finished || !state.pageScanReady || !state.productEvents) return;
        const elapsed = Date.now() - state.lastProductEventAt;
        if (elapsed >= IDLE_WINDOW_MS) return;
        const delay = Math.max(100, IDLE_WINDOW_MS - elapsed);
        state.completionTimer = setTimeout(() => {
            state.completionTimer = null;
            evaluateCompletion(false);
        }, delay);
    }

    async function startCapture() {
        if (state.interfaceDiagnostics && state.interfaceDiagnostics.active) {
            render("接口诊断正在记录。请先点击“停止并导出接口诊断”，再启动正常采集，避免同一大响应被重复处理。");
            setToolsExpanded(true);
            return;
        }
        let result;
        state.selectionMode = false;
        state.selectedProductIds.clear();
        send("clearSelectedCaptureIntent").catch(() => {});
        try {
            // 新采集显式丢弃旧终态，防止刷新后恢复上一批“完成”而跳过本次执行。
            await send("clearDetailSupplement");
            result = await send("setCaptureEnabled", { enabled: true });
        } catch (_) {
            result = null;
        }
        state.enabled = Boolean(result && result.ok && result.enabled);
        if (!state.enabled) {
            state.phase = "采集失败";
            render("无法启动采集，请确认扩展后台正常运行。");
            return;
        }
        // 采集范围必须从点击时的当前页重建，不能沿用平台切页后累积的上一页 SPU 集合。
        resetDetailRuntimeForNewCapture();
        resetPageContext(true);
        beginRun();
        if (!await waitForCurrentPageScan()) {
            finishCapture("采集超时", "当前页商品未在等待时间内完成识别，未上传；请确认列表已加载后重试。");
            return;
        }
        await startDetailSupplement();
    }

    /** 锁定当前勾选 SPU 后刷新页面以重新触发接口；队列恢复依赖 SPU 清单，不依赖刷新后的页码。 */
    async function startSelectedCapture() {
        readSelectedProductIds();
        if (!state.selectedProductIds.size) {
            render("请先在商品行左侧勾选至少一个商品，再开始选择性采集。");
            return;
        }
        state.selectionMode = true;
        await persistSelectedProductIds();
        try {
            await send("clearDetailSupplement");
            const result = await send("setCaptureEnabled", { enabled: true });
            state.enabled = Boolean(result && result.ok && result.enabled);
        } catch (_) { state.enabled = false; }
        if (!state.enabled) {
            state.phase = "采集失败";
            render("无法启动选择性采集，请确认扩展后台正常运行。");
            return;
        }
        beginRun();
        setTimeout(() => location.reload(), 300);
    }

    async function stopCapture() {
        state.runGeneration += 1;
        state.enabled = false;
        state.phase = "已暂停";
        clearCompletionTimers();
        if (state.detailMode || state.detailSupplementStarted) {
            // 清队列回执在后台排在在途落库之后，暂停也保留最后已保存的当前批次范围。
            const stopped = await send("clearDetailSupplement").catch(() => null);
            if (stopped?.queue?.total) state.detailQueue = { ...stopped.queue, active: false, status: "partial" };
        }
        // 暂停本身也是一次可分析的终态；即使用户没有打开日志页，也保留当时的完成度和待写入数量。
        await send("captureSnapshot", { summary: makeRunSummary("已暂停") }).catch(() => {});
        await send("setCaptureEnabled", { enabled: false });
        render("已停止本次采集。现有数据仍保留在本地；再次采集会重新读取当前页面，不会从断点继续。");
    }

    async function exportData() {
        render("正在打开导出页面…");
        const result = await send("openExport");
        render(result && result.ok ? "完整商品包导出页已打开，请选择导出方式。" : "导出失败，请重试。");
    }

    async function exportLogs() {
        render("正在打开操作日志导出页…");
        // 用户可能在45秒终态前导出；先写入瞬时快照，日志才能判断本次是完成、暂停还是仍在采样。
        await send("captureSnapshot", { summary: makeRunSummary("导出时状态") }).catch(() => {});
        const result = await send("openLogs");
        render(result && result.ok ? "操作日志导出页已打开，包含采集、连接与任务状态。" : "日志导出失败，请重试。");
    }

    /**
     * 诊断仅把接口路径、字段树、计数和有限商品 ID 样本交给后台，原始响应仍只走既有采集链路。
     * 页面刷新后后台 session 会恢复“记录中”状态，避免用户打开商品页触发导航时丢掉本次诊断。
     */
    async function toggleInterfaceDiagnostics() {
        const current = state.interfaceDiagnostics || {};
        if (!current.active) {
            if (state.enabled) {
                render("正常采集正在运行。请先停止本次采集，再开启接口诊断，避免页面大响应被重复处理。");
                return;
            }
            render("正在开启接口诊断；接下来打开一个商品或切换列表以触发接口…");
            const result = await send("startInterfaceDiagnostics").catch(() => null);
            if (!result || !result.ok || !result.diagnostics) {
                render("无法开启接口诊断，请确认扩展后台正常运行。");
                return;
            }
            state.interfaceDiagnostics = result.diagnostics;
            setPageInterfaceDiagnosticEnabled(true);
            render("接口诊断已开启。请执行一次要分析的页面操作，完成后再点击“停止并导出”。");
            return;
        }
        render("正在整理接口诊断并打开导出页…");
        setPageInterfaceDiagnosticEnabled(false);
        const result = await send("stopInterfaceDiagnostics").catch(() => null);
        if (!result || !result.ok || !result.diagnostics) {
            setPageInterfaceDiagnosticEnabled(true);
            render("接口诊断导出失败，请重试。");
            return;
        }
        state.interfaceDiagnostics = result.diagnostics;
        render("接口诊断已停止，已打开 JSON 导出页。文件不包含 Cookie、令牌、请求正文或完整响应。");
    }

    async function openSettings() {
        const result = await send("openSettings");
        render(result && result.ok ? "入库节点设置页已打开。" : "无法打开节点设置。");
    }

    /**
     * 停止/继续接口创建。
     * 停止标记由扩展后台落盘，刷新页面不会恢复；这里只负责把操作者的意图发过去并如实回显结果，
     * 不能在本地先改状态，否则后台拒绝时面板会显示成“已停止”而上传仍在继续。
     */
    async function toggleDirectCreatePaused() {
        if (directPauseBusy) return;
        const identity = currentPageIdentity();
        const nextPaused = !state.directPaused;
        directPauseBusy = true;
        render();
        try {
            const result = await send("setDirectCreatePaused", { identity, paused: nextPaused });
            if (!result?.ok) throw new Error(result?.error || "stop_direct_create_failed");
            state.directPaused = Boolean(result.paused);
            if (Array.isArray(result.tasks)) state.transferTasks = result.tasks;
            await logOperation({
                action: state.directPaused ? "stop-direct-create" : "resume-direct-create",
                status: "clicked",
                storeId: identity.storeId,
                reason: state.directPaused ? "操作者停止接口创建" : "操作者继续接口创建"
            });
            render(state.directPaused
                ? "已停止接口创建：插件不会继续上传，刷新页面也不会自动恢复。点“继续接口创建”才会恢复。"
                : "已恢复接口创建：插件会继续处理本店剩余商品。");
        } catch (error) {
            render(`停止接口创建失败：${String(error?.message || error)}。请导出操作日志排查。`);
        } finally {
            directPauseBusy = false;
            render();
        }
    }

    /** 目标店任务只从扩展后台读取，页面 DOM 与页面脚本不会接触完整商品资料。 */
    async function refreshTargetUploadTasks() {
        // 刷新页面后先恢复本地可信绑定，待办展示不依赖中转仓 HTTP 心跳成功。
        const binding = await send("getBoundStore").catch(() => null);
        if (binding?.ok && binding.store) boundStore = binding.store;
        if (binding?.ok) state.cliConnectedAt = Number(binding.cliConnectedAt || 0);
        const identity = currentPageIdentity();
        // 未能映射店铺时不展示任何共享存储里的待办，避免用户误在 A 店处理 B 店商品。
        const result = await send("getTargetUploadTasks", { storeId: identity.storeId || "" }).catch(() => null);
        if (result && result.ok) {
            state.transferTasks = Array.isArray(result.tasks) ? result.tasks : [];
            // 停止标记随任务摘要一起返回，刷新后不点任何按钮也能看到插件已停止。
            if (typeof result.directPaused === "boolean") state.directPaused = result.directPaused;
        }
        return state.transferTasks;
    }

    /** 扩展存储跨店共享时，只让当前已映射店铺看见自己被指派的任务；无映射时安全地返回空集。 */
    function currentStoreTransferTasks(identity = currentPageIdentity()) {
        const storeId = String(identity && identity.storeId || "").trim();
        if (!storeId) return [];
        return (state.transferTasks || []).filter(task => task && String(task.targetStoreId || "") === storeId);
    }

    function currentTransferTask(identity = currentPageIdentity()) {
        const tasks = currentStoreTransferTasks(identity);
        const activeDirect = tasks.find(task => task.directCreate && !['created', 'duplicate_exists', 'preflight_failed'].includes(String(task.directState || '')));
        if (activeDirect) return activeDirect;
        return tasks.find(task => task.status === "upload_opened")
            || tasks.find(task => task.status === "received")
            || null;
    }

    /** 批量接口任务的完成度独立于单商品阶段，避免面板把单件 80% 显示成整批 80%。 */
    function directBatchProgress(tasks) {
        const directTasks = (Array.isArray(tasks) ? tasks : []).filter(task => task.directCreate);
        const total = directTasks.length;
        const finished = directTasks.filter(task => ['created', 'duplicate_exists', 'preflight_failed'].includes(String(task.directState || ''))).length;
        const currentIndex = Math.max(0, directTasks.findIndex(task => !['created', 'duplicate_exists', 'preflight_failed'].includes(String(task.directState || ''))));
        return { total, finished, currentIndex, percent: total ? Math.round(finished / total * 100) : 0 };
    }

    /** 结果未知时只允许操作者确认后重试；后台会把该商品排到当前店铺队列末尾。 */
    async function retryUnknownDirectTask() {
        const task = currentTransferTask(currentPageIdentity());
        if (!task || !['unknown','preflight_failed','rejected'].includes(String(task.directState || ''))) return;
        const result = await send('retryDirectTask', { input: { identity: currentPageIdentity(), jobId: task.jobId, spuId: task.spuId } }).catch(error => ({ ok: false, error: String(error?.message || error) }));
        if (!result?.ok) return render(`人工重试失败：${result?.error || '请稍后再试'}`);
        await refreshTargetUploadTasks();
        render('已确认重试，商品已排到上传队列末尾。');
    }

    /**
     * 列表页请求打开目标任务，新建基本信息页则响应用户点击填入资料。
     * 类目、合规字段和最终提交仍由操作者核对，填写成功不代表发布成功。
     */
    async function openNextTransferTask() {
        const directTask = currentTransferTask(currentPageIdentity());
        if (directTask?.directCreate) {
            const labels = {
                received: "正在检索目标店商品",
                authorizing: "正在预检商品资料",
                submitting: "正在提交新增接口",
                verifying: "已提交，正在回查商品ID",
                created: "接口创建并回查成功，请到目标店商品列表核对",
                unknown: "提交结果待核对，禁止重复发送",
                preflight_failed: "接口预检失败",
                duplicate_exists: "目标店已存在，未重复创建"
            };
            render(directTask.reason || labels[directTask.directState] || "接口创建任务已接收，插件正在自动创建，无需点击。");
            return;
        }
        if (location.pathname === "/goods/edit") return fillCurrentTransferForm();
        const identity = currentPageIdentity();
        const task = currentTransferTask(identity);
        if (!task) {
            await logOperation({ action: "open-upload", status: "blocked", reason: "no_local_task", pendingCount: 0, storeId: identity.storeId });
            render("插件尚未收到商品任务。请在网站发送后查看连接状态；若仍为 0 个，请导出操作日志排查。检测到插件不代表任务已送达。");
            return;
        }
        const identityMatched = currentPageIdentityMatched(identity);
        if (!identity.storeId || !identity.pageStoreName || !identityMatched || String(task.targetStoreId || "") !== identity.storeId) {
            render("当前店铺尚未完成身份识别，不能打开上传任务。");
            return;
        }
        render(`正在为 SPU ${task.spuId} 打开新建商品页…`);
        const result = await send("reportTargetUploadTask", { payload: {
            jobId: task.jobId,
            spuId: task.spuId,
            status: "upload_opened",
            storeId: identity.storeId,
            pageUrl: identity.pageUrl,
            pageStoreName: identity.pageStoreName,
            identityMatched,
            reason: "操作者已在目标店打开新建商品页，等待手动填写和确认"
        } }).catch(() => null);
        if (!result || !result.ok) {
            render(`无法打开上传任务：${result && result.error ? result.error : "任务回传失败"}`);
            return;
        }
        state.transferTasks = Array.isArray(result.tasks) ? result.tasks : state.transferTasks;
        if (result.pending) {
            render("已请求网站核验任务，请稍后再点击打开；核验前不会进入商品页。");
            return;
        }
        const createUrl = `${location.origin}/goods/create/category`;
        location.assign(createUrl);
    }

    /** 仅用户点击才发送完整资料到新建表单；页面转换后仍由操作者检查并点击平台创建。 */
    async function fillCurrentTransferForm() {
        const identity = currentPageIdentity();
        const task = currentTransferTask(identity);
        if (!task || task.status !== "upload_opened") return render("任务尚未通过网站打开核验，请先在列表页打开待上传任务。");
        if (!confirm(`将 SPU ${task.spuId} 的资料填入当前空白新建表单？\n不会自动创建或发布。`)) return;
        const data = await send("getTargetFormProduct", { jobId: task.jobId, spuId: task.spuId, pageStoreName: identity.pageStoreName }).catch(() => null);
        if (!data?.ok) return render(data?.error || "无法读取待上传商品资料");
        const requestId = `fill-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const result = await new Promise(resolve => {
            const done = value => { clearTimeout(timer); window.removeEventListener("temu-fill-result", listener); resolve(value); };
            const listener = event => { try { const value = JSON.parse(event.detail); if (value.requestId === requestId) done(value); } catch {} };
            const timer = setTimeout(() => done({ok:false,error:"填写响应超时，请检查表单，不要重复点击创建"}), 10000);
            window.addEventListener("temu-fill-result", listener);
            window.dispatchEvent(new CustomEvent("temu-fill-product", { detail: JSON.stringify({requestId,product:data.product}) }));
        });
        await logOperation({action:"fill-target-form",status:result.ok?"succeeded":"failed",jobId:task.jobId,spuId:task.spuId,error:result.error});
        render(result.ok ? `已填入 ${result.skuCount} 个 SKU、${result.imageCount} 张轮播图。请核对必填项、资质和合规声明，再点击平台“创建”；尚未提交。` : `填写停止：${result.error}`);
    }

    /** 资料缺少时提供当前任务 JSON 作为人工核对附件；文件中不包含领取凭证。 */
    async function exportCurrentTransferTask() {
        const identity = currentPageIdentity();
        const task = currentTransferTask(identity);
        if (!task) {
            render("当前没有待上传的目标店商品。");
            return;
        }
        if (!identity.storeId || String(task.targetStoreId || "") !== identity.storeId) {
            render("当前店铺与待上传商品不匹配，不能导出资料。");
            return;
        }
        const result = await send("downloadTargetUploadTask", { input: { jobId: task.jobId, spuId: task.spuId, storeId: identity.storeId } }).catch(() => null);
        render(result && result.ok ? `已导出 SPU ${task.spuId} 的待上传资料 JSON。` : "导出待上传资料失败，请重试。");
    }

    /** 只有操作者完成目标店页面填写后点击确认，仓库才记为已上传；该按钮不执行发布动作。 */
    async function confirmCurrentTransferTask() {
        const identity = currentPageIdentity();
        const task = currentStoreTransferTasks(identity).find(item => item.status === "upload_opened");
        if (!task) {
            render("没有正在填写的上传任务。");
            return;
        }
        const identityMatched = currentPageIdentityMatched(identity);
        if (!identity.storeId || !identity.pageStoreName || !identityMatched || String(task.targetStoreId || "") !== identity.storeId) {
            render("当前店铺尚未完成身份识别，不能确认上传。");
            return;
        }
        if (!confirm(`确认 SPU ${task.spuId} 已由你在当前目标店完成上传吗？\n\n此操作只写入中转仓工作日志，不会点击发布。`)) return;
        const result = await send("reportTargetUploadTask", { payload: {
            jobId: task.jobId,
            spuId: task.spuId,
            status: "uploaded",
            storeId: identity.storeId,
            pageUrl: identity.pageUrl,
            pageStoreName: identity.pageStoreName,
            identityMatched,
            reason: "操作者已确认在目标店完成上传"
        } }).catch(() => null);
        if (!result || !result.ok) {
            render(`确认失败：${result && result.error ? result.error : "任务回传失败"}`);
            return;
        }
        state.transferTasks = Array.isArray(result.tasks) ? result.tasks : [];
        render(result.pending ? "已保存你的确认，等待 CLI 同步到网站；尚未回传成功。" : `SPU ${task.spuId} 已记录为“操作者确认上传”，未执行自动发布。`);
    }

    /** 手动推送仍会等待在途写入；成功或失败都写进入库状态行，不改采集完成度。 */
    async function pushToWarehouse() {
        if (state.apiRunning || state.detailQueue?.active) {
            render("详情仍在采集，请等待批次结束或先停止，再上传已保存的资料。");
            return;
        }
        setIngestState("pushing", "正在推送");
        render("正在把完整商品包推送到入库台…");
        // 手动按钮也要等待页面已经发出的保存回执，避免用户在最后一条响应落库前得到不完整快照。
        const writesDrained = await waitForPendingWrites(5000);
        if (!writesDrained) {
            setIngestState("blocked", "写入未完成，未入库");
            render("仍有响应正在写入本地，暂未推送；请稍后再试。");
            return;
        }
        // 当前批次优先，禁止点击上传时把扩展历史其他页面/店铺的所有记录一起发送。
        const eventIds = state.detailQueue?.eventIds || Array.from(state.runEventIds);
        // 手动推送沿用本次采集锁定的详情队列/选择集合，避免刷新后把当前页误当成上传范围。
        const allowedSpuIds = state.detailQueue?.spuIds || Array.from(captureProductIds());
        if (!eventIds.length || !allowedSpuIds.length) {
            setIngestState("blocked", "无当前批次");
            render("当前页没有可确认的采集批次，请先采集；历史资料可从导出页查看。");
            return;
        }
        const result = await send("pushFullPacket", { options: { eventIds, allowedSpuIds } });
        if (!result || !result.ok) {
            setIngestState("error", ingestErrorText(result && result.error) || "推送失败");
            render(result && result.error ? `推送失败：${ingestErrorText(result.error)}` : "推送失败，请先配置入库节点。");
            return;
        }
        if (result.skipped) {
            setIngestState("blocked", result.reason === "empty_packet" || result.reason === "no_products" ? "本地无商品，未入库" : (result.reason || "已跳过"));
            render(result.reason === "empty_packet" || result.reason === "no_products"
                ? "本地没有识别到可推送的商品记录。"
                : `未推送：${result.reason || "已跳过"}。`);
            return;
        }
        if (!result.reused && !result.batchId) {
            setIngestState("error", "未获得批次回执");
            render("入库台没有返回批次，未记为已入库。请稍后重试。");
            return;
        }
        const reused = result.reused ? "仓库已有相同文件。" : "已新建批次。";
        const readiness = result.batch && result.batch.readiness ? ` ${result.batch.readiness}` : "";
        setIngestState("done", result.batchId ? `已入库 ${result.batchId}` : "已入库");
        render(`已推送到入库台。${reused} 批次 ${result.batchId || ""}${readiness}`);
    }

    /** 导出与上传前等待已经发出的写入回执，避免最后一条响应尚未落库就生成商品包。 */
    async function waitForPendingWrites(timeoutMs = 5000) {
        const deadline = Date.now() + timeoutMs;
        while (state.pendingWrites > 0 && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return state.pendingWrites === 0;
    }

    function isStaleCaptureMessage(message) {
        const helper = typeof TemuPageContext !== "undefined" ? TemuPageContext : null;
        if (helper && typeof helper.isStaleRequest === "function") {
            return helper.isStaleRequest(message && message.requestStartedAt, pageContextStartedAt);
        }
        const started = Number(message && message.requestStartedAt) || 0;
        return Boolean(started && started < pageContextStartedAt);
    }

    async function processCapture(message) {
        if (!state.enabled) return;
        const generation = state.runGeneration;
        const stale = isStaleCaptureMessage(message);
        if (!stale) {
            state.captured += 1;
            state.lastEventAt = Date.now();
        }
        state.pendingWrites += 1;
        try {
            const result = await send("captureEvent", { event: message });
            // 切页前发出的响应可以写入历史库，但不能进入新任务的完成度、白名单和自动入库集合。
            if (stale || generation !== state.runGeneration || state.finished || !state.enabled) return;
            if (result && result.ok && result.saved) {
                state.saved += 1;
                // 自动入库只推送本次页面任务实际见过的响应；eventId 由后台内容哈希生成，可同时覆盖新增和本地重复记录。
                if (result.eventId) state.runEventIds.add(String(result.eventId));
                if (result.duplicate) state.duplicates += 1;
                else {
                    state.added += 1;
                    state.total += 1;
                }
                state.latest = result.category === "unknown" ? "未识别接口响应" : (result.category || "暂无");
                const productIds = Array.isArray(result.productIds) ? result.productIds : [];
                if (state.detailMode) {
                    // 详情页只记录当前 SPU 的相关响应；不把详情页单条响应混入列表完成度集合。
                    state.detailEventCount += 1;
                    state.detailEvidence = state.detailEvidence || Boolean(result.detailEvidence);
                    if (result.detailCapture) {
                        state.detailCaptured = state.detailCaptured || Boolean(result.detailCapture.captured);
                        state.detailCompleteness = result.detailCapture.completeness === "complete" ? "complete" : state.detailCompleteness;
                        state.detailMissing = Array.isArray(result.detailCapture.missing) ? result.detailCapture.missing : state.detailMissing;
                    }
                    state.lastProductEventAt = Date.now();
                    scheduleDetailSupplementCompletion();
                    return;
                }
                const primaryProductList = result.category === "product-list" && isPrimaryProductListUrl(message.requestUrl);
                if (primaryProductList) state.primaryProductEvents += 1;
                // 店铺删除状态只采信当前页主列表接口的行字段；其他商品接口同名字段的语义未经核验，不参与判断。
                if (primaryProductList) applyRemovalStatuses(result);
                if (primaryProductList) productIds.forEach(value => {
                    const productId = normalizeProductId(value);
                    if (productId && !state.removedProductIds.has(productId)) state.listProductIds.add(productId);
                });
                if (isPrimaryProductListUrl(message.requestUrl) && Number.isInteger(result.productCount) && result.productCount > 0) {
                    state.declaredProductCount = Math.max(state.declaredProductCount || 0, result.productCount);
                }
                if (result.productRelated || productIds.length) {
                    state.productEvents += 1;
                    state.lastProductEventAt = Date.now();
                }
                const helper = typeof TemuStoreIdentity !== "undefined" ? TemuStoreIdentity : null;
                if (helper && typeof helper.extractShopNameFromPayload === "function" && message && message.payload) {
                    helper.rememberCapturedShopName(helper.extractShopNameFromPayload(message.payload));
                }
                refreshExpectedProducts();
                // 绿色完成度只由当前页主列表 SPU 证明；详情/编辑任务响应仍保存，但不能把单个详情当成列表已覆盖。
                matchProductIds(productIds, primaryProductList);
                matchPendingProductIds();
            } else {
                state.failed += 1;
                // 只有当前页主列表保存失败会阻断列表覆盖；编辑任务等旁路商品接口失败留在“本页失败”中提示。
                if (result && result.productRelated && isPrimaryProductListUrl(message.requestUrl)) state.productFailures += 1;
            }
        } catch (_) {
            if (!stale && generation === state.runGeneration) state.failed += 1;
        } finally {
            // 待写入计数跨页面代际共享；旧页面的在途请求完成后也必须释放自己的槽位。
            state.pendingWrites = Math.max(0, state.pendingWrites - 1);
        }
        if (stale || generation !== state.runGeneration || state.finished || !state.enabled) return;
        scheduleCompletionCheck();
        evaluateCompletion(false);
        if (root) render();
    }

    /** 将页面端因大小或格式跳过的响应写入诊断日志，不把它计入商品保存失败。 */
    async function processCaptureSkip(message) {
        if (!state.enabled) return;
        await send("captureSkip", { event: message }).catch(() => {});
    }

    /**
     * 接口诊断不依赖采集是否开启，专门用于找“列表页可直接拿详情”的真实接口。
     * 后台会再次核验诊断会话与来源页面，并只保存字段结构，避免页面端意外扩大数据保存范围。
     */
    async function processInterfaceDiagnostic(message) {
        if (!state.interfaceDiagnostics || !state.interfaceDiagnostics.active) return;
        const type = message && message.kind === "network-skip" ? "captureInterfaceDiagnosticSkip" : "captureInterfaceDiagnostic";
        const result = await send(type, { event: message }).catch(() => null);
        if (!result || !result.ok || !result.diagnostics) return;
        state.interfaceDiagnostics = result.diagnostics;
        if (root) render();
    }

    // 页面桥只处理签名资料包；收到后台持久化回执后才刷新待上传数量，不打开或提交商品。
    window.addEventListener("temu-cli-delivery", async event => {
        try {
            const envelope = JSON.parse(String(event.detail || ""));
            const identity = currentPageIdentity();
            const result = await send("receiveCliTask", { envelope, pageStoreName: identity.pageStoreName });
            result.requestId = (() => { try { return JSON.parse(envelope.body).requestId; } catch { return ""; } })();
            if (result?.ok) {
                await refreshTargetUploadTasks();
                if (root) render();
            }
            window.dispatchEvent(new CustomEvent("temu-cli-delivery-result", { detail: JSON.stringify(result) }));
        } catch (error) {
            window.dispatchEvent(new CustomEvent("temu-cli-delivery-result", { detail: JSON.stringify({ ok: false, error: String(error.message || error) }) }));
        }
    });

    window.addEventListener("message", event => {
        if (event.source !== window || event.origin !== location.origin) return;
        const message = event.data;
        if (!message || message.source !== SOURCE) return;
        if (message.kind === "network-skip") {
            if (!state.ready) {
                if (pendingSkipEvents.length < 200) pendingSkipEvents.push(message);
                else state.bufferOverflow = true;
                return;
            }
            processCaptureSkip(message);
            processInterfaceDiagnostic(message);
            return;
        }
        if (message.kind !== "network-json") return;
        // 主世界主动查询由专用回执落库，禁止被动监听重复入账或抢先推进商品队列。
        if (state.apiRunning && /\/visage-agent-seller\/product\/query(?:$|[/?])/.test(String(message.requestUrl || ""))) return;
        if (!state.ready) {
            if (pendingEvents.length < 200) pendingEvents.push(message);
            else state.bufferOverflow = true;
            return;
        }
        processCapture(message);
        processInterfaceDiagnostic(message);
    });

    /**
     * 必须先完成一次 DOM 扫描再放行缓冲网络响应，保证“页面商品”是匹配基准，而不是被响应数量反向推导。
     */
    function initialize() {
        createPanel();
        // 卖家中心是 SPA，路由切换不会重新注入 content script，因此持续监听地址变化以同步显隐。
        let lastRoute = location.href;
        setInterval(() => { if (location.href !== lastRoute) { lastRoute = location.href; syncPanelVisibility(); } }, 500);
        render();
        chrome.runtime.onMessage.addListener((message) => {
            if (!message || message.type !== "directCreateProgress" || !message.task) return;
            const incoming = message.task;
            const tasks = Array.isArray(state.transferTasks) ? state.transferTasks : [];
            const index = tasks.findIndex((task) => String(task.jobId) === String(incoming.jobId || "") && String(task.spuId) === String(incoming.spuId || ""));
            if (index >= 0) state.transferTasks[index] = { ...tasks[index], ...incoming };
            else state.transferTasks = [...tasks, incoming];
            if (incoming.reason) state.message = incoming.reason;
            render();
        });
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area === "local" && changes.ingestSettingsV1) refreshIngestSettings();
            if (area === "local" && (changes.pendingIngestQueueV1 || changes.pendingIngestV1 || changes.lastIngestOutcomesV1)) refreshIngestQueue();
        });
        send("getCaptureEnabled").then(async result => {
            state.enabled = Boolean(result && result.ok && result.enabled);
            await restoreSelectedProductIds();
            // 等待 document_start 发起的恢复请求，不能等 DOM 就绪后再重新问一次，
            // 否则商品编辑页首批详情请求已经错过。
            await interfaceDiagnosticsBootstrap;
            let detailQueue = await send("getDetailSupplement").catch(() => null);
            // 刷新后无法证明旧筛选和店铺会话未变化，保留已采记录并停止，不盲目恢复旧SPU。
            if (detailQueue?.active && detailQueue.mode === "api") {
                detailQueue = await send("advanceDetailSupplement", { input: { runId: detailQueue.runId, spuId: detailQueue.current?.spuId, status: "failed", reason: "页面刷新中断批次，请在当前列表重新采集" } });
                state.enabled = false;
            }
            const inDetailSupplement = await initializeDetailSupplement(detailQueue);
            const completedDetailSupplement = !inDetailSupplement && restoreFinishedDetailSupplement(detailQueue);
            if (!inDetailSupplement && !completedDetailSupplement) startPageTracking();
            if (state.enabled && !inDetailSupplement && !completedDetailSupplement) beginRun();
            state.ready = true;
            const buffered = pendingEvents.splice(0, pendingEvents.length);
            // 首屏可能同时缓冲大量响应，顺序写入可避免 IndexedDB 事务争用和完成度事件乱序。
            for (const bufferedEvent of buffered) {
                await processCapture(bufferedEvent);
                await processInterfaceDiagnostic(bufferedEvent);
            }
            const bufferedSkipEvents = pendingSkipEvents.splice(0, pendingSkipEvents.length);
            for (const skippedEvent of bufferedSkipEvents) {
                await processCaptureSkip(skippedEvent);
                await processInterfaceDiagnostic(skippedEvent);
            }
            await refreshStats();
            await refreshIngestSettings();
            await refreshIngestQueue();
            await refreshTargetUploadTasks();
            const instance = await send("getPluginInstanceId").catch(() => null);
            if (instance && instance.ok && instance.pluginInstanceId) pluginInstanceId = instance.pluginInstanceId;
            await syncStoreAgent();
            window.addEventListener(STATUS_REQUEST_EVENT, () => { publishPublicStatus(); });
            setInterval(() => { syncStoreAgent().catch(() => {}); }, AGENT_SYNC_INTERVAL_MS);
        }).catch(() => {
            state.ready = true;
            state.phase = "采集失败";
            render("扩展后台暂不可用。");
        });
    }
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initialize, { once: true });
    } else {
        initialize();
    }
})();
