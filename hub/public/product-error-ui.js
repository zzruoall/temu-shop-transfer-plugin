/* 商品错误以真实原因作为主信息；历史缺失字段明确注明，不推测 SKU 或平台结果。 */
(function (scope) {
    'use strict';
    let opened = null;
    function statusMarkup(product, escape) {
        const marked = product.sendBlocked || product.blocked;
        if (!marked) return '<span class="ticket-status ready">来源已采集</span>';
        const reason = product.errorNotice ? product.errorNotice.summary || '具体原因待读取'
            : product.blockedReason || '历史标记未保存具体原因';
        return `<div class="product-error-status"><span class="ticket-status blocked">${product.errorNotice ? '资料异常，已停止分发' : '历史异常，已停止分发'}</span><p class="product-error-summary">${escape(reason)}</p><button type="button" class="product-error-details" data-product-error="${escape(String(product.spuId || ''))}">错误详情</button></div>`;
    }
    function close() { if (opened?.open) opened.close(); }
    async function open(product, trigger, readDetails) {
        close();
        const document = scope.document, dialog = document.createElement('dialog');
        dialog.className = 'product-error-dialog';
        dialog.setAttribute('aria-labelledby', 'product-error-title');
        const add = (parent, tag, text, className = '') => {
            const node = document.createElement(tag); node.textContent = text; node.className = className; parent.appendChild(node); return node;
        };
        const header = add(dialog, 'header', '');
        const title = add(header, 'h2', '商品错误详情'); title.id = 'product-error-title';
        const exit = add(header, 'button', '关闭', 'toolbar-button'); exit.type = 'button'; exit.addEventListener('click', () => dialog.close());
        const state = add(dialog, 'p', '读取错误详情中…', 'product-error-message'); state.setAttribute('role', 'status');
        const fields = add(dialog, 'dl', '', 'product-error-fields');
        const footer = add(dialog, 'footer', '');
        const copy = add(footer, 'button', '复制错误信息', 'toolbar-button'); copy.type = 'button'; copy.disabled = true;
        const controller = new AbortController();
        dialog.addEventListener('close', () => { controller.abort(); dialog.remove(); if (opened === dialog) opened = null; if (trigger?.isConnected) trigger.focus(); }, { once: true });
        document.body.appendChild(dialog); opened = dialog; dialog.showModal(); exit.focus();
        let data;
        try {
            // 禁传也可来自历史红标；只有新版通知带实例身份，旧原因必须直接展示而非查询空凭证。
            if (product.errorNotice) {
                data = await readDetails(product.errorNotice, controller.signal);
                if (!data?.sendBlocked || !data.notice) throw Error('商品已解除标记或来源已变化，请刷新列表');
            } else data = { notice: { reason: product.blockedReason || '历史标记未保存具体原因', at: product.blockedAt }, sendBlocked: Boolean(product.blocked || product.sendBlocked) };
            if (!dialog.isConnected || controller.signal.aborted) return;
            const notice = data.notice;
            const primaryCodes = [product.articleNo, ...(product.productExtCodes || [])].filter(Boolean);
            const codes = [...new Set(primaryCodes.length ? primaryCodes : (product.skuExtCodes || []).filter(Boolean))];
            const rows = [['商品名称', product.title || '未记录'], ['商品货号', codes.join('、') || '未记录'],
                ['具体错误 SKU', notice.skuCode || '未记录'], ['错误原因', notice.reason || '历史标记未保存具体原因'],
                ['错误码', notice.code || '未记录'], ['错误阶段', notice.stage || '未记录'],
                ['首次报告店铺', notice.targetStoreName || notice.targetStoreId || '未记录'], ['首次标记时间', notice.at || '未记录']];
            for (const [label, value] of rows) { add(fields, 'dt', label); add(fields, 'dd', String(value)); }
            const text = rows.map(([label, value]) => `${label}：${value}`).join('\n');
            state.textContent = notice.truncated ? '回传内容已截断，以下为实际保存的错误信息。' : data.sendBlocked ? '该商品已停止后续分发。' : '商品已解除标记，请刷新列表。';
            copy.disabled = false;
            copy.addEventListener('click', async () => {
                try { await scope.navigator.clipboard.writeText(text); state.textContent = '已复制错误信息'; }
                catch { state.textContent = '复制失败，请在详情中选择并复制文字'; }
            });
        } catch (error) {
            if (!controller.signal.aborted && dialog.isConnected) state.textContent = `无法读取错误详情：${error.message || '请稍后重试'}`;
        }
    }
    scope.TemuProductErrorUI = { statusMarkup, open, close };
})(globalThis);
