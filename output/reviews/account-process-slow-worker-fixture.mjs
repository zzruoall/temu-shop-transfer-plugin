/** 慢任务夹具仅模拟IPC耗时，用于确认忙碌子进程不会被空闲回收；不连接数据库或真实店铺。 */
const delayMs = Number(process.env.FIXTURE_DELAY_MS || 1500);
process.send({ protocol: 1, accountId: process.env.WORKER_ACCOUNT_ID || '', supervisorEpoch: Number(process.env.WORKER_SUPERVISOR_EPOCH || 0), type: 'ready' });
process.on('message', async message => {
    if (message?.protocol !== 1) return;
    if (message.operation === 'yield') { process.send({ type: 'yielding', workId: message.workId || '' }); process.exit(0); }
    if (message.operation !== 'start') return;
    process.send({ type: 'started', workId: message.workId || '' });
    await new Promise(resolve => setTimeout(resolve, delayMs));
    process.send({ type: 'prepared', workId: message.workId || '', result: { sourceRead: true } });
});
