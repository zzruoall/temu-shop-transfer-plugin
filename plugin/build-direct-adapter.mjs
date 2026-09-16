/** 构建固定页面适配器；与连接器共用转换与核验源码，禁止运行时下载执行代码。 */
import {readFile, writeFile} from 'node:fs/promises';
const prepare=await readFile(new URL('../worker/direct-create-prepare.js',import.meta.url),'utf8');
const check=await readFile(new URL('../worker/direct-integrity.js',import.meta.url),'utf8');
await writeFile(new URL('./direct-adapter.js',import.meta.url),`/** 构建产物：页面固定商品转换与完整性检查，无云仓令牌。 */\nwindow.__temuDirectPrepare=${prepare};\nwindow.__temuDirectCheck=${check};\n`);
