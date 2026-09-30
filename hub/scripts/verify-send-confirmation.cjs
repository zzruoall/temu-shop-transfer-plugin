async (page) => {
    // 接口全部拦截，确认按钮只创建模拟任务，绝不把测试商品交给真实插件。
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
            if (pathname.endsWith("/bulk-dispatch") && request.method() === "POST") {
                posts.push(JSON.parse(request.postData()));
                return route.fulfill({ json: { batch: { id: `mock-${posts.length}` } } });
            }
            return route.abort();
        }
        if (pathname.endsWith("/me")) body = { user: { id: "test", username: "test", role: "admin" }, isAdmin: true, localMode: true };
        if (pathname.endsWith("/overview")) body = { productCount: 1, productTotal: 1, readyCount: 0, products: [{ spuId: "p1", title: "未知结构商品", ready: false, images: [], batchIds: ["b1"], publicationData: { sourceBatchId: "b1" } }], batches: [{ id: "b1", sourceStoreId: "source", sourceStoreName: "来源店 Source", counts: { spu: 1 } }] };
        if (pathname.endsWith("/agents")) body = { agents, total: 2, hasMore: false };
        if (pathname.endsWith("/stores")) body = { stores: [], total: 0, hasMore: false };
        if (pathname.endsWith("/direct-create-capability")) {
            if (failCapability) return route.fulfill({ status: 503, json: { error: "模拟服务暂不可用" } });
            body = { directCreate: true };
        }
        await route.fulfill({ json: body });
    });
    await page.goto("about:blank");
    await page.goto("http://127.0.0.1:8787/#/products");
    await page.locator("label:has(.product-checkbox)").click();
    await page.locator("#batch-target-trigger").click();
    await page.locator("label:has(#batch-target-select-all)").click();
    await page.locator('#batch-target-dialog button[value="apply"]').click();
    const begin = () => page.locator("#batch-direct-create").click();
    const confirm = () => page.locator('.confirm-dialog button[value="ok"]').click();
    await begin();
    await page.getByRole("dialog", { name: "确认批量上架" }).waitFor();
    check(!await page.locator("#batch-direct-create").isEnabled(), "确认期间提交按钮未锁定");
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.screenshot({ path: "output/send-confirm-desktop.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "output/send-confirm-mobile.png" });
    check(await page.locator(".confirm-dialog").evaluate(element => element.getBoundingClientRect().width <= innerWidth), "移动端弹窗溢出");
    await page.keyboard.press("Escape");
    await page.locator("#catalog-toast").filter({ hasText: "已取消发送" }).waitFor();
    check(posts.length === 0, "取消后创建了任务");
    await begin(); await confirm();
    await page.getByRole("dialog", { name: "确认发送到来源店铺" }).waitFor();
    check(await page.locator(".confirm-details").innerText().then(text => text.includes("来源店 Source")), "二次确认未列出来源店名");
    await page.locator('.confirm-dialog button[value="cancel"]').click();
    check(posts.length === 0, "拒绝同店发送后仍创建任务");
    failCapability = true;
    await begin(); await confirm(); await confirm();
    await page.locator("#catalog-toast").filter({ hasText: "模拟服务暂不可用" }).waitFor();
    check(await page.locator("#batch-direct-create").isEnabled(), "请求失败未解锁提交");
    failCapability = false;
    await begin(); await confirm(); await confirm();
    await page.locator("#catalog-toast").filter({ hasText: "发送清单已保存" }).waitFor();
    check(posts.length === 1 && posts[0].targets.length === 2, "两店应通过一次请求保存清单");
    check(posts[0].sameStoreConfirmed === true, "缺少同店明确确认字段");
    check(posts[0].groups[0].spuIds.join() === "p1", "错误发送商品范围");
    check(await page.evaluate(() => window.nativeConfirmCalls) === 0, "发送仍依赖原生confirm");
    check(errors.length === 0, errors.join("\n"));
    return { passed: true, nativeConfirmDisabled: true, cancelNoWrites: true, sameStoreConfirmation: true, failureRecovery: true, mockedJobs: posts.length, realWrites: 0 };
}
