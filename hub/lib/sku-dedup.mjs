/** 商品内容指纹忽略采集时间及传输诊断，店铺和平台SKU参与隔离；不按自定义货号猜测同款。 */
import {createHash} from 'node:crypto';
const ignored=new Set(['capturedAt','exportedAt','updatedAt','createdAt','timestamp','requestId','batchId','sourceBatchId','sources','completeness','ready','receivedAt']);
export function canonical(value) {
    if(Array.isArray(value))return value.map(canonical);
    if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().filter(k=>!ignored.has(k)).map(k=>[k,canonical(value[k])]));
    return value;
}
export function skuFingerprint(product,storeId) {
    if(!storeId||!product.spuId||!product.skuIds?.length)return '';
    const body={storeId,spuId:product.spuId,skuIds:[...product.skuIds].map(String).sort(),product:canonical(product)};
    return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}
