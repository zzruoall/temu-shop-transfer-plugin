async (page) => {
    // 接口全部拦截，只模拟当前传输；开窗和取消不写任务，绝不交给真实插件。
    const posts = [], errors = [];
    let failCapability = false;
    const check = (value, message) => { if (!value) throw new Error(message); };
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        window.nativeConfirmCalls = 0;
        window.confirm = () => { window.nativeConfirmCalls++; return false; };
        window.EventSource = class { addEventListener() {} close() {} };
    });
    const agents = ["source", "target"].map(storeId => ({ storeId, storeName: storeId === "source" ? "来源店 Source" : "目标店 Target", online: true, pluginDetected: true, identityMatched: true, canReceiveUploads: true }));
    await page.unroute("**/api/**");
    await page.route("**/api/**", async route => {
        const request = route.request(), pathname = request.url().split("?")[0];
        let body = {};
        if (request.method() !== "GET") {
            if (pathname.endsWith("/relay/send") && request.method() === "POST") {
                posts.push(JSON.parse(request.postData()));
                return route.fulfill({ json: { sent: posts.at(-1).spuIds.length } });
            }
            return route.abort();
        }
        if (pathname.endsWith("/me")) body = { user: { id: "test", username: "test", role: "admin" }, isAdmin: true, localMode: true };
        if (pathname.endsWith("/overview")) body = { productCount: 1, productTotal: 1, readyCount: 0, products: [{ spuId: "p1", title: "未知结构商品", ready: false, images: [], batchIds: ["b1"], publicationData: { sourceBatchId: "b1" } }], batches: [{ id: "b1", sourceStoreId: "source", sourceStoreName: "来源店 Source", counts: { spu: 1 } }] };
        if (pathname.endsWith("/agents")) body = { agents, total: 2, hasMore: false };
        if (pathname.endsWith("/stores")) body = { stores: [], total: 0, hasMore: false };
        if (pathname.endsWith("/direct-create-capability")) {
            if (failCapability) return route.fulfill({ status: 503, json: { error: "模拟服务暂不可用" } });
            body = { directCreate: true, actionTypes: ['product_create', 'qualification_upload'], minimumPluginVersion: '11.0.4' };
        }
        await route.fulfill({ json: body });
    });
    await page.goto("about:blank");
    await page.goto("http://127.0.0.1:8787/#/products");
    await page.locator("label:has(.product-checkbox)").click();
    await page.locator("#batch-target-trigger").click();
    await page.locator("label:has(#batch-target-select-all)").click();
    await page.locator('#batch-target-dialog button[value="apply"]').click();
    // 预选店只带入草稿；每次仍需点击底部命令才发送。
    const begin = async () => {
        await page.locator("#batch-direct-create").click();
    };
    const confirm = () => page.locator('#single-target-dialog button[value="product_create"]').click();
    const confirmSource = () => page.locator('.confirm-dialog button[value="ok"]').click();
    await begin();
    await page.locator("#single-target-dialog").waitFor();
    check(posts.length === 0 && await page.locator('dialog[open]').count() === 1, "确认前产生了任务或嵌套弹窗");
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.screenshot({ path: "output/playwright/send-confirm-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "output/playwright/send-confirm-mobile.png" });
    check(await page.locator("#single-target-dialog").evaluate(element => element.getBoundingClientRect().width <= innerWidth), "移动端弹窗溢出");
    await page.keyboard.press("Escape");
    check(!await page.locator('#single-target-dialog').evaluate(element => element.open), "Escape未关闭任务弹窗");
    check(posts.length === 0, "取消后创建了任务");
    await begin(); await confirm();
    await page.getByRole("dialog", { name: "确认发送到来源店铺" }).waitFor();
    check(await page.locator(".confirm-details").innerText().then(text => text.includes("来源店 Source")), "二次确认未列出来源店名");
    await page.locator('.confirm-dialog button[value="cancel"]').click();
    check(posts.length === 0, "拒绝同店发送后仍创建任务");
    failCapability = true;
    await begin(); await confirm(); await confirmSource();
    await page.locator("#catalog-toast").filter({ hasText: "模拟服务暂不可用" }).waitFor();
    check(await page.locator("#batch-direct-create").isEnabled(), "请求失败未解锁提交");
    failCapability = false;
    await begin(); await confirm(); await confirmSource();
    await page.locator("#catalog-toast").filter({ hasText: "实际发出 2 份" }).waitFor();
    check(posts.length === 2 && new Set(posts.map(body => body.targetStoreId)).size === 2, "两店应分别执行当前传输");
    check(posts.every(body => body.sameStoreConfirmed === true && body.actionType === 'product_create'), "缺少同店确认或任务类型字段");
    check(posts.every(body => body.spuIds.join() === "p1"), "错误发送商品范围");
    check(await page.evaluate(() => window.nativeConfirmCalls) === 0, "发送仍依赖原生confirm");
    check(errors.length === 0, errors.join("\n"));
    return { passed: true, nativeConfirmDisabled: true, cancelNoWrites: true, sameStoreConfirmation: true, failureRecovery: true, mockedTransfers: posts.length, realWrites: 0 };
}
