/** 构建固定页面转换器；来源保真由独立模块承担，不再生成创建后回查核验器。 */
import {readFile, writeFile} from 'node:fs/promises';
const prepare=await readFile(new URL('../worker/direct-create-prepare.js',import.meta.url),'utf8');
await writeFile(new URL('./direct-adapter.js',import.meta.url),`/** 构建产物：固定页面商品转换，无云仓令牌；来源保真由独立模块核验。 */\nwindow.__temuDirectPrepare=${prepare};\n`);
