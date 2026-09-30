import { JOB_SCHEMA } from '../lib/mysql-job-repository.mjs';
import { INGEST_PROTOCOL_SCHEMA } from '../lib/ingest-protocol.mjs';
// 部署账号执行增量DDL，不向应用账号授予建表权限。
console.log(JOB_SCHEMA.find(sql => sql.includes('hub_execution_wait')) + ';\n' + INGEST_PROTOCOL_SCHEMA + ';');
