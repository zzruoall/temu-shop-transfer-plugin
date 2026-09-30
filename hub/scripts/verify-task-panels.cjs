async (page) => {
    // 所有业务接口均模拟，检查SSE更新不会改动表单草稿或重复插入任务行。
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    let sent = 0, finished = false;
    const failures = Array.from({ length: 21 }, (_, n) => ({ storeId: 'temu:123', sourceBatchId: 'batch', spuId: String(8000000000 + n), reason: '来源原包与下发资料不一致' }));
    const agent = { storeId: 'temu:123', storeName: '目标店', pageStoreName: '平台目标店', online: true, pluginDetected: true, identityMatched: true, canReceiveUploads: true, pluginVersion: '10.10.56' };
    const job = { id: 'job1', sourceStoreId: 'source', targetStoreId: 'temu:123', targetStoreName: '目标店', status: 'queued', counts: { total: 1 }, items: [{ spuId: '12345678', status: 'queued' }] };
    await page.unroute('**/api/**');
    await page.route('**/api/**', route => {
        const url = route.request().url().split('?')[0];
        if (url.endsWith('/events')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': fixture\n\n' });
        if (route.request().method() !== 'GET') return route.abort();
        let body = {};
        if (url.endsWith('/me')) body = { user: { id: 'test', username: 'test', role: 'admin' }, isAdmin: true, localMode: true };
        if (url.endsWith('/overview')) body = { products: [], batches: [], productCount: 0, productTotal: 0 };
        if (url.endsWith('/agents')) body = { agents: [agent], total: 1, hasMore: false, directoryVersion: 'stable' };
        if (url.endsWith('/stores')) body = { stores: [{ storeId: 'temu:123', name: '紫鸟备注' }], total: 1, hasMore: false };
        if (url.endsWith('/jobs')) body = { jobs: [job], total: 1, hasMore: false, counts: { total: 1, active: 1 }, runtimeStores: [{ storeId: 'temu:123', queued: 1, uploading: 0, failures: 0, activeCount: 1, current: job }] };
        if (url.endsWith('/bulk-dispatch')) body = { batches: [{ id: 'a'.repeat(64), status: finished ? 'completed_errors' : 'queued', createdAt: new Date().toISOString(), total: 1000000, sent, failed: finished ? 21 : 0, failureSamples: failures.slice(0, 20), targets: Array.from({ length: 200 }, () => ({ storeId: 'temu:123', storeName: '目标店', error: '' })) }], hasMore: false };
        if (url.endsWith('/failures')) {
            const offset = Number(route.request().url().match(/[?&]offset=(\d+)/)?.[1] || 0);
            body = { failures: failures.slice(offset, offset + 20), offset, hasMore: offset === 0 };
        }
        return route.fulfill({ json: body });
    });
    await page.goto('about:blank'); await page.goto('http://127.0.0.1:8787/#/jobs');
    await page.locator('#bulk-dispatch-body').filter({ hasText: '1000000' }).waitFor();
    await page.locator('[data-task-view-button="create"]').click();
    await page.locator('#job-product-search').fill('保留这个搜索草稿');
    sent = 50;
    await page.evaluate(async () => { await refreshTaskPanels(); await refreshTaskPanels(); });
    if (await page.locator('#job-product-search').inputValue() !== '保留这个搜索草稿') throw Error('状态更新清掉草稿');
    if (await page.locator('#job-records .job-record').count() !== 1) throw Error('状态更新重复插入记录');
    await page.locator('[data-task-view-button="status"]').click();
    if (!(await page.locator('#bulk-dispatch-body').innerText()).includes('50 / 1000000')) throw Error('分发状态未更新');
    // 部分失败不可展示成成功或提供整批重发入口；明细翻页不能改动主表页码。
    finished = true;
    await page.evaluate(async () => { await refreshTaskPanels(); });
    await page.locator('#bulk-dispatch-body summary').click();
    await page.locator('[data-failure-offset="20"]').click();
    await page.locator('#bulk-dispatch-body').filter({ hasText: '8000000020' }).waitFor();
    if (await page.locator('#bulk-dispatch-body [data-bulk-action]').count()) throw Error('已结束分发不应允许继续或停止');
    if (!(await page.locator('#bulk-dispatch-body').innerText()).includes('有失败')) throw Error('失败被误报成功');
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#bulk-dispatch-body').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/task-panels-desktop.png' });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('#bulk-dispatch-body').scrollIntoViewIfNeeded();
    await page.screenshot({ path: 'output/task-panels-mobile.png' });
    if (errors.length) throw Error(errors.join('\n'));
    return { passed: true, draftsPreserved: true, noDuplicateRows: true, realWrites: 0 };
}
