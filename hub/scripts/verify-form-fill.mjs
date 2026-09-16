/** 隔离检查新建填写边界，不调用真实平台接口。 */
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";
const code=fs.readFileSync(new URL("../../plugin/form-fill.js",import.meta.url),"utf8");
function run({existing=false,dirty=false,category=18813}={}) {
    let listener,result,writes=0;
    let values=dirty?{productName:"",outPackage:{urls:["existing"]}}:{};
    const store={productId:existing?1:null,catId:category,formApi:{getValues:()=>values,setValues:v=>{values=v;writes++},getState:()=>({dirty:false})},setProductSpecTableData() {}};
    const chunks=[[[],{67464:()=>{}}]];
    chunks.push=entry=>entry[2](id=>id===67464?{X9:({productInfo})=>{delete productInfo.productId},FC:()=>({productName:"test",productSkuMap:{sku:{}},noCostumeCarouselImgsI18n:{common:["image"]}})}:{eq:()=>[{}]});
    const context=vm.createContext({location:{origin:"https://agentseller.temu.com",pathname:"/goods/edit"},self:{chunkLoadingGlobal_temu_sca_goods:chunks},document:{querySelector:()=>({__reactFiberTest:{memoizedProps:{value:{form:store}}}})},window:{addEventListener:(_,fn)=>listener=fn,dispatchEvent:e=>result=JSON.parse(e.detail)},CustomEvent:class{constructor(_,v){this.detail=v.detail}}});
    vm.runInContext(code,context);
    listener({detail:JSON.stringify({requestId:"test",product:{productId:123,categories:{cat1:{catId:18813}},productSkcList:[]}})});
    return {result,writes};
}
assert.equal(run().result.filled,true);
assert.equal(run({existing:true}).writes,0);
assert.equal(run({dirty:true}).writes,0);
assert.equal(run({category:1}).writes,0);
assert.equal(run().result.published,false);
console.log("form-fill: empty form, category, existing product and no publication checks passed");
