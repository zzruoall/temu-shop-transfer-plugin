/** 复用当前目标页的复制转换器填写空白新建表单；绝不调用 submit/add，也不替用户同意合规声明。 */
(() => {
    function fill(source) {
        if (location.origin !== "https://agentseller.temu.com" || location.pathname !== "/goods/edit") throw Error("请先进入目标店的新建商品基本信息页");
        const element = document.querySelector("textarea");
        let fiber = element?.[Object.keys(element).find(key => key.startsWith("__reactFiber"))];
        let store;
        for (let depth = 0; fiber && depth < 100; depth++, fiber = fiber.return) {
            if (fiber.memoizedProps?.value?.form?.formApi) { store = fiber.memoizedProps.value.form; break; }
        }
        if (!store || store.productId || store.isEditProduct) throw Error("不能覆盖已有商品，请使用新建页面");
        const before = store.formApi.getValues();
        if (String(before.productName || "").trim() || String(before.productEnName || "").trim()
            || before.noCostumeCarouselImgsI18n?.common?.length || before.outPackage?.urls?.length
            || Object.values(before.productProperties || {}).some(value => Array.isArray(value) && value.length)
            || store.formApi.getState?.().dirty) throw Error("当前表单已有内容或编辑记录，已停止以避免覆盖");
        const ids = Object.entries(source.categories || {}).filter(([key]) => /^cat\d+$/.test(key)).sort(([a],[b]) => Number(a.slice(3))-Number(b.slice(3))).map(([,v]) => Number(v?.catId)).filter(Boolean);
        if (!ids.length || Number(store.catId) !== ids.at(-1)) throw Error("当前类目与来源商品不一致，请先选择来源商品的完整类目");
        // 模块编号来自当前页面实测；网站改版时缺失就停止，不猜测其他模块或提交接口。
        const chunks = self.chunkLoadingGlobal_temu_sca_goods;
        if (!chunks?.some(chunk => chunk[1]?.[67464])) throw Error("页面转换器已变化，需要重新适配");
        let requireModule;
        chunks.push([[`temu-form-${Date.now()}`], {}, runtime => { requireModule = runtime; }]);
        const converter = requireModule(67464);
        const tables = requireModule(73508);
        if (typeof converter.X9 !== "function" || typeof converter.FC !== "function") throw Error("页面复制转换器不可用");
        if (typeof tables.eq !== "function" || typeof store.setProductSpecTableData !== "function") throw Error("页面 SKU 表格转换器不可用");
        const product = JSON.parse(JSON.stringify(source));
        converter.X9({ productInfo: product, matchSupportPersonalization: false, isSupportPersonalizationCat: false });
        if (product.productId || product.productSkcList?.some(skc => skc.productSkcId || skc.productSkuList?.some(sku => sku.productSkuId))) throw Error("来源商品标识未清理，已停止填写");
        // 配送模板、品牌资质等仍需目标店校验；不导入来源店运费模板，避免串用店铺资产。
        if (product.productSaleExtAttr) delete product.productSaleExtAttr.productShipment;
        const values = converter.FC(product, store, {}, store.formApi.getValues().materialMultiLanguages, {});
        const skuCount = Object.keys(values.productSkuMap || {}).length;
        if (!values.productName || !skuCount) throw Error("商品转换后名称或 SKU 缺失，已停止填写");
        delete values.freightTemplateId;
        // SKU 表格是独立页面状态，必须按平台复制流程先初始化，否则名称图片已写入但 SKU 行仍为空。
        const rows = tables.eq(values, store.rootSpecEnumList, store.sizeOrderConfig);
        store.setProductSpecTableData(rows);
        store.formApi.setValues(values, false);
        const after = store.formApi.getValues();
        if (after.productName !== values.productName || Object.keys(after.productSkuMap || {}).length !== skuCount) throw Error("表单未完整确认写入，请检查页面并导出日志");
        return { filled: true, skuCount: Object.keys(after.productSkuMap || {}).length, imageCount: after.noCostumeCarouselImgsI18n?.common?.length || 0, submitted: false, published: false };
    }
    window.addEventListener("temu-fill-product", event => {
        let requestId = "";
        try {
            const data = JSON.parse(String(event.detail || ""));
            requestId = data.requestId;
            const result = fill(data.product);
            window.dispatchEvent(new CustomEvent("temu-fill-result", { detail: JSON.stringify({ requestId, ok: true, ...result }) }));
        } catch (error) {
            window.dispatchEvent(new CustomEvent("temu-fill-result", { detail: JSON.stringify({ requestId, ok: false, error: String(error.message || error) }) }));
        }
    });
})();
