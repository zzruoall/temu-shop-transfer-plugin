/**
 * 只为收包与传输计算即时名额，不建立平台执行槽或账户进程。
 * 数据库服务必须有新鲜预算；离线文件调试无cgroup时只开放一个保守名额。
 */
export function relayResourceCapacity({ budget, sampledAt, sample = {}, active = 0, max = 2, database = false, now = Date.now() }) {
    if (!budget || now - sampledAt > 15000 || now < sampledAt) return database ? 0 : 1;
    if (!database && sample.ok !== true) return 1;
    if (!budget.canAcceptNewStaging || !budget.canAuthorizeBusiness) return 0;
    const free = Number(sample.memoryMaxBytes) * 0.70 - Number(sample.memoryCurrentBytes) - 64 * 1024 * 1024;
    if (!Number.isFinite(free)) return database ? 0 : 1;
    // 现有请求已计入memory.current，只为新请求预留64MiB工作集，不能双重扣除现有占用。
    return Math.max(0, Math.min(max, active + Math.floor(Math.max(0, free) / (64 * 1024 * 1024))));
}
