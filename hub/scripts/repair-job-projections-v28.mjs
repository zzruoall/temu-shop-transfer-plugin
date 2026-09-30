import { openMysqlDatabase } from '../lib/mysql-database.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';

/** 仅修正旧任务状态投影；默认预览数量，显式--apply才写入，绝不重新领取或发送任务。 */
const database = await openMysqlDatabase();
if (!database) throw Error('缺少受保护的数据库配置');
try {
    const [[counts]] = await database.query('maintenance', 'SELECT COUNT(*) AS jobs FROM hub_jobs');
    console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'preview', jobs: Number(counts.jobs) }));
    if (process.argv.includes('--apply')) {
        const queue = createJobQueue(process.env.ZINIAO_DATA_ROOT, {}, { database });
        let cursor = '', repaired = 0;
        for (;;) {
            const page = await queue.repairProjections(cursor);
            repaired += page.count; cursor = page.after;
            if (page.count < 50) break;
        }
        console.log(JSON.stringify({ repaired, dispatched: 0 }));
    }
} finally { await database.close(); }
