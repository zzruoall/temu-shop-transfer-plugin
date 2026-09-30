async (page) => {
    // 所有接口均由浏览器拦截，在线变化使用模拟 SSE；不写本地或正式库存，也不调用真实平台。
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const agent = (id) => ({ storeId:id,storeName:`Target ${id}`,online:true,pluginDetected:true,identityMatched:true,canReceiveUploads:true });
    let agents = [agent("A")];
    let agentReads = 0;
    let inventoryReads = 0;
    let failAgents = false;
    let releaseAgents = null;
    let delayedAgents = null;
    let shiftPage = false;
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        window.EventSource = class extends EventTarget {
            static CLOSED = 2;
            readyState = 1;
            constructor() { super(); window.mockEvents = this; }
            close() { this.readyState = 2; }
        };
    });
    await page.route("**/api/**", async route => {
        const request = route.request();
        if (request.method() !== "GET") throw new Error(`禁止真实写入: ${request.url()}`);
        const url = { pathname: request.url().split("?")[0] };
        let body = {};
        if (url.pathname.endsWith("/me")) body = {user:{id:"test",username:"test",role:"admin"},isAdmin:true,localMode:true};
        if (url.pathname.endsWith("/overview")) {
            inventoryReads++;
            // 同时覆盖不符合固定模板的商品：仍可选择目标店，且 SSE 不能破坏选择草稿。
            body = {productCount:1,productTotal:1,readyCount:0,products:[{spuId:"p1",title:"模拟商品",ready:false,images:[],skuIds:[],skcIds:[],batchIds:["b1"],publicationData:{sourceBatchId:"b1"}}],batches:[{id:"b1",sourceStoreId:"source",sourceStoreName:"Source"}]};
        }
        if (url.pathname.endsWith("/agents")) {
            agentReads++;
            if (delayedAgents) { const pending = delayedAgents; delayedAgents = null; await pending; }
            if (failAgents) return route.fulfill({status:503,json:{error:"模拟目录暂时不可用"}});
            const offset = Number(request.url().match(/[?&]offset=(\d+)/)?.[1] || 0);
            if (shiftPage && offset === 100) { agents = agents.slice(2); shiftPage = false; }
            body = {agents:agents.slice(offset,offset+100),total:agents.length,hasMore:offset+100<agents.length,directoryVersion:JSON.stringify(agents)};
        }
        if (url.pathname.endsWith("/stores")) body = {stores:[],total:0,hasMore:false};
        await route.fulfill({status:200,json:body});
    });
    await page.setViewportSize({width:1360,height:900});
    await page.goto("about:blank");
    await page.goto("http://127.0.0.1:8787/#/products");
    await page.locator(".product-checkbox").waitFor();
    const signal = async (version, inventory = "i1") => page.evaluate(({version,inventory}) => {
        window.mockEvents.dispatchEvent(new MessageEvent("live",{data:JSON.stringify({inventory,claims:"c1",agents:version,jobs:"j1",logs:"l1",directory:version})}));
    }, {version,inventory});
    await signal("a1");
    await page.waitForFunction(() => lastLive?.agents === "a1");
    await page.locator('label:has(.product-checkbox)').click();
    await page.locator("#batch-target-trigger").click();
    await page.locator('#batch-target-options label:has(input[value="A"])').click();
    await page.locator("#batch-target-search").fill("Target");
    await page.evaluate(() => { window.originalRow = document.querySelector("[data-product-row]"); window.originalCheckbox = document.querySelector('#batch-target-options input[value="A"]'); });
    agents = [agent("A"),agent("Temporary")];
    await signal("temporary");
    await page.waitForFunction(() => document.querySelectorAll("#batch-target-options .batch-target-option").length === 2);
    agents = [agent("A")];
    await signal("a1");
    await page.waitForFunction(() => document.querySelectorAll("#batch-target-options .batch-target-option").length === 1);
    const readsBefore = inventoryReads;
    agents = [agent("A"),agent("B"),agent("C")];
    await signal("a2", "i2");
    await page.waitForFunction(() => document.querySelectorAll("#batch-target-options .batch-target-option").length === 3);
    check(await page.locator('#batch-target-options input[value="A"]').isChecked(),"弹窗草稿丢失");
    check(await page.locator(".product-checkbox").isChecked(),"商品勾选丢失");
    check(await page.locator("#batch-target-search").inputValue() === "Target","搜索草稿丢失");
    check(await page.evaluate(() => document.querySelector("#batch-target-dialog").open && window.originalRow === document.querySelector("[data-product-row]") && window.originalCheckbox === document.querySelector('#batch-target-options input[value="A"]')),"弹窗或已有节点被重建");
    check(inventoryReads === readsBefore,"勾选期间意外重读商品");
    await page.screenshot({path:"output/target-live-desktop.png"});
    await page.locator('#batch-target-dialog button[value="apply"]').click();
    // 新店加入后，已完成的目标店选择仍保留；后台请求期间发生的新勾选也不能被旧快照覆盖。
    await page.locator("#batch-target-trigger").click();
    delayedAgents = new Promise(resolve => { releaseAgents = resolve; });
    agents.push(agent("D"));
    const reads = agentReads;
    await signal("a3");
    await page.waitForFunction(() => autoRefreshBusy);
    await page.locator('#batch-target-options label:has(input[value="B"])').click();
    releaseAgents();
    await page.waitForFunction(() => document.querySelectorAll("#batch-target-options .batch-target-option").length === 4);
    check(agentReads > reads,"没有读取变化目录");
    check(await page.locator('#batch-target-options input[value="B"]').isChecked(),"请求期间的新勾选丢失");
    check(await page.evaluate(() => [...document.querySelector("#batch-target-stores").selectedOptions].some(option=>option.value==="A")),"已提交目标被清空");
    // 已勾选目标移到第二页时继续读取，不能误判离线并清空选择。
    agents = [...Array.from({length:101},(_,n)=>agent(`N${n}`)),agent("A"),agent("B")];
    shiftPage = true;
    await signal("a4");
    await page.waitForFunction(() => document.querySelectorAll("#batch-target-options .batch-target-option").length === 101);
    check(await page.locator('#batch-target-options input[value="A"]').isChecked(),"分页后已选店铺丢失");
    failAgents = true;
    const failedResponse = page.waitForResponse(response => response.url().includes("/api/agents?") && response.status() === 503);
    await signal("a5");
    await failedResponse;
    await page.waitForFunction(() => !autoRefreshBusy);
    check(await page.locator('#batch-target-options input[value="A"]').count() === 1,"请求失败清空了旧店铺");
    failAgents = false;
    agents = [agent("B"),agent("C")];
    await signal("a6");
    await page.waitForFunction(() => document.querySelectorAll("#batch-target-options .batch-target-option").length === 2 && !document.querySelector('#batch-target-options input[value="A"]'));
    check(await page.evaluate(() => ![...document.querySelector("#batch-target-stores").selectedOptions].some(option=>option.value==="A")),"离线店仍被选作目标");
    check(await page.locator('#batch-target-options input[value="B"]').isChecked(),"其他在线店的草稿被清空");
    const stableReads = agentReads;
    await signal("a6");
    await page.waitForTimeout(1300);
    check(agentReads === stableReads,"未变化的版本重复查询目录");
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:"output/target-live-mobile.png"});
    await page.locator('#batch-target-dialog button[value="cancel"]').click();
    await page.locator('[data-transfer-spu="p1"]').click();
    await page.locator('#single-target-options label:has(input[value="B"])').click();
    agents.push(agent("D"));
    await signal("a7");
    await page.waitForFunction(() => document.querySelectorAll("#single-target-options .batch-target-option").length === 3);
    check(await page.locator('#single-target-options input[value="B"]').isChecked(),"单商品弹窗草稿丢失");
    check(await page.locator('#single-target-dialog').evaluate(dialog=>dialog.open),"单商品弹窗被关闭");
    check(errors.length === 0,errors.join("\n"));
    return {passed:true,selectedProductsPreserved:true,openDialogUpdates:true,singleDialogUpdates:true,draftsPreserved:true,lateSelectionPreserved:true,pagedSelectionPreserved:true,offlineRemoved:true,failureRetainsOldView:true,unchangedVersionNoRequest:true,realWrites:0};
}
