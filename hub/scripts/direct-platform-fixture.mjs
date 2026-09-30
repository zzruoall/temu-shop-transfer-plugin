import { readFile } from 'node:fs/promises';

/** 执行器单测默认包含真实平台互斥和轮次校验；是否启用由各场景显式提供的存储决定。 */
export async function directExecutorFixture({ executionRounds = true } = {}) {
    const background = await readFile(new URL('../../plugin/background.js', import.meta.url), 'utf8');
    const start = background.indexOf('let platformAdmissionQueue = Promise.resolve();');
    const end = background.indexOf('function selectedCaptureKey', start);
    if (start < 0 || end < 0) throw new Error('平台占用函数边界未找到');
    const executor = await readFile(new URL('../../plugin/direct-executor.js', import.meta.url), 'utf8');
    const integrity = await readFile(new URL('../../plugin/transfer-integrity.js', import.meta.url), 'utf8');
    const rounds = executionRounds ? await readFile(new URL('../../plugin/execution-round.js', import.meta.url), 'utf8') : '';
    return `chrome.storage ||= {}; chrome.storage.session ||= { get: async () => ({}) };\nconst DETAIL_QUEUE_PREFIX = 'detailSupplementTab:';\n${integrity}\n${background.slice(start, end)}\n${executor}\n${rounds}`;
}

/** 普通业务用例显式预置已握手状态；只模拟文档探测，不绕过真实轮次与暂停判断。 */
export async function seedExecutionRounds(context, stores = [{ storeId: 'temu:123', mallId: '123', tabId: 1 }]) {
    const chrome = context.chrome;
    chrome.runtime ||= { getManifest: () => ({ version: '10.10.60' }) };
    const identities = Object.fromEntries(stores.map(store => [store.storeId, { ...store,
        documentId: `fixture-document-${store.tabId}`, executionRunId: `fixture-execution-${store.tabId}`,
        executionRunProtocol: 1 }]));
    await chrome.storage.local.set(Object.fromEntries(Object.values(identities).map(identity => [
        `directPause:${identity.storeId}`, { ...identity, paused: false, pendingStop: false,
            enabledVersion: chrome.runtime.getManifest().version }
    ])));
    const executeScript = chrome.scripting.executeScript.bind(chrome.scripting);
    chrome.scripting.executeScript = async spec => {
        if (!spec.files && !spec.args && spec.target.documentIds) {
            const identity = Object.values(identities).find(entry => entry.tabId === spec.target.tabId);
            if (!identity || spec.target.documentIds[0] !== identity.documentId) throw Error('模拟文档已失效');
            return [{ documentId: identity.documentId, result: { visible: true } }];
        }
        return executeScript(spec);
    };
    const getTasks = context.getTargetUploadTasks;
    context.getTargetUploadTasks = async () => (await getTasks()).map(task => {
        const identity = identities[task.targetStoreId];
        if (!identity) throw Error('模拟任务缺少目标店轮次');
        return { ...task, executionRunId: task.executionRunId ?? identity.executionRunId };
    });
    // 这些用例只核对业务回执内容；持久化与断网重传由独立回执脚本覆盖。
    context.TemuDirectReceipts ||= { send: body => context.hubJson('/api/jobs/direct-progress', body) };
    context.executionIdentities = identities;
}
