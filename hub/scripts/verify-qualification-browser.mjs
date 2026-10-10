/** 浏览器仅渲染离线资质夹具并拦截全部网络；截图和窄屏边界验证不触及真实店铺或服务器。 */
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseQualificationRecord } from '../lib/product-qualifications.mjs';
import { qualificationRecord } from './qualification-fixture.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'E:/project/chajian/node_modules/playwright');
const [code,css]=await Promise.all([readFile(new URL('../public/product-detail.js',import.meta.url),'utf8'),readFile(new URL('../public/styles.css',import.meta.url),'utf8')]);
const output=fileURLToPath(new URL('../../output/playwright/',import.meta.url));
await mkdir(output,{recursive:true});
const capture={...parseQualificationRecord(qualificationRecord()).qualifications,sourceStoreId:'测试来源店'};
capture.items[0].content.model='MODEL-'+ 'LONG'.repeat(60);
// 第二项用于验证原生折叠彼此独立，不允许展开一项时自动关闭另一项。
capture.items.push({...structuredClone(capture.items[0]),certType:439,displayName:'美国化妆品小企业证明'});
const failed={...capture,spuId:'45962715609',status:'failed',items:[],reason:'资质读取被限流，请稍后重新采集'};
const browser=await chromium.launch({headless:true});
try{
    for(const width of [1440,390]){
        const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];
        await page.route('**/*',route=>route.abort());
        page.on('pageerror',error=>errors.push(error.message));
        await page.setContent('<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>商品资质离线验证</title></head><body><main id="fixture" style="max-width:1000px;margin:0 auto"></main></body></html>');
        await page.addStyleTag({content:css});await page.addScriptTag({content:code});
        await page.evaluate(captures=>{document.getElementById('fixture').innerHTML=window.ProductDetailView.render({qualificationCaptures:captures});},[capture,failed]);
        const sections=page.locator('details.detail-qualification');
        assert.equal(await sections.count(),2);
        assert.equal(await page.locator('details[open]').count(),0);
        assert.equal(await sections.first().locator('.qualification-body').isVisible(),false);
        await sections.first().locator('summary.qualification-summary').click();
        assert.equal(await sections.first().locator('.qualification-body').isVisible(),true);
        assert.equal(await sections.nth(1).locator('.qualification-body').isVisible(),false);
        await sections.nth(1).locator('summary.qualification-summary').focus();
        await page.keyboard.press('Enter');
        assert.equal(await page.locator('details.detail-qualification[open]').count(),2);
        await sections.first().getByText('已填写内容',{exact:true}).click();
        assert.equal(await page.locator('details[open]').count(),3);
        assert.equal(await page.locator('.detail-file-link').count(),8);
        assert.ok(await page.getByRole('heading',{name:'商品资质',exact:true}).isVisible());
        assert.deepEqual(errors,[]);
        const overflow=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth,
            outside:[...document.querySelectorAll('.qualification-scope,.detail-qualification,.detail-field,.qualification-content,.detail-file-link')]
                .filter(node=>{const box=node.getBoundingClientRect();return box.left<0||box.right>innerWidth+1;}).length}));
        assert.ok(overflow.scroll<=width+1,JSON.stringify(overflow));assert.equal(overflow.outside,0);
        await page.screenshot({path:path.join(output,`qualifications-${width}.png`),fullPage:true});
        await sections.first().locator('summary.qualification-summary').click();
        assert.equal(await sections.first().locator('.qualification-body').isVisible(),false);
        assert.equal(await sections.nth(1).locator('.qualification-body').isVisible(),true);
        await page.screenshot({path:path.join(output,`qualifications-collapsed-${width}.png`),fullPage:true});
        console.log(`资质浏览器验证通过：${width}px，默认收起、独立展开及键盘操作通过，无横向溢出或页面错误`);
        await page.close();
    }
}finally{await browser.close();}
