/** 子目录API回归，不访问真实店铺、不提交创建请求。 */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const endpoint=require('../../plugin/ingest-endpoint.js');
for(const route of ['/api/ingest-info','/api/agents/register','/api/jobs/claim','/api/jobs/report','/api/jobs/direct-progress']) {
    assert.equal(endpoint.apiUrl('https://www.ruofei.com.cn/temu/api/ingest',route),'https://www.ruofei.com.cn/temu'+route);
    assert.equal(endpoint.apiUrl('http://127.0.0.1:18380/api/ingest',route),'http://127.0.0.1:18380'+route);
}
assert.throws(()=>endpoint.apiUrl('https://www.ruofei.com.cn/api/wrong','/api/jobs/claim'));
assert.throws(()=>endpoint.apiUrl('https://www.ruofei.com.cn/temu/api/ingest','https://other.example/api'));
console.log('子目录路径、本地兼容和非法地址检查通过');
