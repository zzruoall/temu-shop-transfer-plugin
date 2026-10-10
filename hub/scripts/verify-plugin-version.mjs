/** 主版本升级的能力门槛、页面检测和实际Agent登记回归，全部使用临时仓库与内存页面。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pluginVersionAtLeast } from '../lib/plugin-version.mjs';
import { PAGE_INSPECT_SCRIPT, hasRequiredPlugin } from '../lib/page-identity.mjs';
import { supportsScheduling } from '../lib/scheduling.mjs';
import { createJobQueue } from '../lib/job-queue.mjs';
import { createStore } from '../lib/store.mjs';

test('10/11按数字比较能力门槛，未知主版本及非法版本不放行', () => {
    for (const [version, expected] of [['10.10.55',false],['10.10.56',true],['10.10.78',true],['11.0.0',true],
        ['11.2.3',true],['12.0.0',false],['9.99.99',false],['10.10.56.extra',false],['11..0',false],['11.-1.0',false],['11.65536.0',false]]) {
        assert.equal(pluginVersionAtLeast(version, [10,10,56]), expected, version);
    }
    assert.equal(supportsScheduling({pluginVersion:'11.0.0',schedulingProtocol:1}),true);
    assert.equal(supportsScheduling({pluginVersion:'11.0.0'}),false,'版本不能冒充协议能力');
});

test('页面检测与服务端同门槛，11.0.0必须有正确插件在场标记', () => {
    for (const version of ['10.0.3','10.1.0','10.10.78','11.0.0','12.0.0','11..0']) {
        const result = JSON.parse(vm.runInNewContext(PAGE_INSPECT_SCRIPT, {
            document: { getElementById: () => ({getAttribute: name => name==='data-plugin-version'?version:name==='data-plugin-presence'?'temu-local-capture':''}),body:{innerText:''},title:'' },
            window:{dispatchEvent:()=>{}},Event:class{},location:{href:'https://agentseller.temu.com/goods/list'} }));
        assert.equal(result.pluginDetected,hasRequiredPlugin('temu-local-capture',version),version);
    }
    assert.equal(hasRequiredPlugin('legacy-panel','11.0.0'),false);
});

test('实际登记的11.0.0可收件，10.10.78兼容保留，旧不完整和未知主版本不可收件', async () => {
    const root = await mkdtemp(path.join(tmpdir(),'temu-plugin-version-'));
    try {
        const queue = createJobQueue(root,createStore(root));let id=111;
        for (const [version,expected] of [['11.0.0',true],['10.10.78',true],['10.10.55',false],['12.0.0',false],['10.0.3',false]]) {
            const mallId=String(id++);
            const agent=await queue.registerAgent({storeId:`temu:${mallId}`,mallId,pluginInstanceId:randomUUID(),pluginVersion:version,
                storeName:'临时店',pageStoreName:'临时店',pageUrl:'https://agentseller.temu.com/goods/list',pluginDetected:true,
                identityMatched:true,executionMode:'plugin-api',relayProtocol:1,relaySessionId:randomUUID()});
            assert.equal(agent.canReceiveUploads,expected,version);
        }
    }finally{assert.equal(path.dirname(root),path.resolve(tmpdir()));await rm(root,{recursive:true,force:true});}
});
