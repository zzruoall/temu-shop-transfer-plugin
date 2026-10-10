/** 仅生成本机插件交付包；保留原签名、扩展 ID 和历史包，不触碰网站下载目录或线上服务器。 */
import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const version = '11.0.10';
const source = path.join(root, 'plugin');
const stage = path.join(root, `output/plugin-live-photos-${version}-20261010`);
const runtime = path.join(stage, 'plugin');
const baseline = path.join(root, 'temu-transfer-plugin-11.0.9.crx');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** 发布目录只包含运行所需源码及说明；拒绝链接和密钥，避免测试探针、构建器或私有文件混入安装包。 */
async function inventory(directory, prefix = '') {
    const files = {};
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = prefix + entry.name;
        assert.ok(!entry.isSymbolicLink(), `禁止链接:${name}`);
        if (name === 'tests' || name === 'build-direct-adapter.mjs') continue;
        if (entry.isDirectory()) Object.assign(files, await inventory(path.join(directory, entry.name), name + '/'));
        else {
            assert.ok(entry.isFile() && !/\.(pem|key|crx|zip)$/i.test(name) && !entry.name.startsWith('.'), `禁止打包:${name}`);
            files[name] = hash(await readFile(path.join(directory, entry.name)));
        }
    }
    return files;
}

/** 新版本只能创建不存在的交付路径；提前检查后仍使用排他写入，防止其他进程创建同名包时被覆盖。 */
async function requireAbsent(file) {
    await assert.rejects(access(file), { code: 'ENOENT' });
}

const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
assert.equal(manifest.version, version);
const oldManifest = JSON.parse(await readFile(path.join(root, 'output/plugin-live-photos-11.0.9-20261010/plugin/manifest.json'), 'utf8'));
for (const field of ['key', 'permissions', 'host_permissions', 'optional_host_permissions', 'minimum_chrome_version']) {
    assert.deepEqual(manifest[field], oldManifest[field], `不能改变权限或签名:${field}`);
}
await access(baseline);
await access(path.join(root, 'plugin.pem'));
await requireAbsent(stage);
for (const suffix of ['crx', 'zip']) await requireAbsent(path.join(root, `temu-transfer-plugin-${version}.${suffix}`));
const sourceFiles = await inventory(source);

// 所有新增模块必须入包，且静态入口引用必须存在；防止签名成功但安装后缺少采集器或执行器。
for (const name of ['attachment-ledger.js', 'live-photo-reader.js', 'live-photo-transfer.js', 'live-photo-executor.js',
    'live-photo-upload-page.js', 'live-photo-panel.js']) assert.ok(sourceFiles[name], `缺少模块:${name}`);
const required = [manifest.background.service_worker, manifest.action.default_popup,
    ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(script => script.js || [])];
for (const name of Object.keys(sourceFiles).filter(name => name.endsWith('.js'))) {
    const text = await readFile(path.join(source, name), 'utf8');
    for (const call of text.matchAll(/importScripts\(([^)]*)\)/g)) {
        required.push(...[...call[1].matchAll(/["']([^"']+)["']/g)].map(match => match[1]));
    }
    execFileSync(process.execPath, ['--check', path.join(source, name)], { windowsHide: true });
}
for (const name of required) assert.ok(sourceFiles[name], `缺少入口引用:${name}`);
await mkdir(runtime, { recursive: true });
for (const name of Object.keys(sourceFiles)) {
    await mkdir(path.dirname(path.join(runtime, name)), { recursive: true });
    await copyFile(path.join(source, name), path.join(runtime, name), constants.COPYFILE_EXCL);
}
assert.deepEqual(await inventory(runtime), sourceFiles, '暂存源码与开发源码不一致');
const packed = spawnSync('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    `--user-data-dir=${path.join(stage, 'chrome-profile')}`, `--pack-extension=${runtime}`,
    `--pack-extension-key=${path.join(root, 'plugin.pem')}`, '--no-first-run', '--no-default-browser-check', '--no-startup-window'
], { windowsHide: true, timeout: 30000 });
assert.ifError(packed.error);
assert.equal(packed.status, 0, 'Chrome 打包失败');
const crx = await readFile(path.join(stage, 'plugin.crx'));
assert.equal(crx.toString('ascii', 0, 4), 'Cr24');
assert.equal(crx.readUInt32LE(4), 3);
const verified = JSON.parse(execFileSync(process.execPath, [path.join(root, 'hub/scripts/verify-crx-package.mjs'),
    path.join(stage, 'plugin.crx'), baseline, runtime], { cwd: root, windowsHide: true, encoding: 'utf8' }));
assert.equal(verified.version, version);
assert.deepEqual(await inventory(source), sourceFiles, '打包期间源码发生变化');
const packages = {};
for (const suffix of ['crx', 'zip']) {
    const name = `temu-transfer-plugin-${version}.${suffix}`;
    const bytes = suffix === 'crx' ? crx : crx.subarray(12 + crx.readUInt32LE(8));
    await writeFile(path.join(stage, name), bytes, { flag: 'wx' });
    packages[name] = { sha256: hash(bytes), bytes: bytes.length };
}
await writeFile(path.join(stage, 'package-manifest.json'), JSON.stringify({ version, build: 'qualification-existing-and-legacy-photos-20261010',
    extensionId: verified.extensionId, sourceFiles, packages, excluded: ['tests/', 'build-direct-adapter.mjs'],
    requiresServerCapability: 'independent-live-photo-storage-and-assets-v1', serverDeployed: false,
    pluginPublished: false, githubPublished: false, realPlatformSubmissionVerified: false }, null, 2) + '\n', { flag: 'wx' });
for (const name of Object.keys(packages)) await copyFile(path.join(stage, name), path.join(root, name), constants.COPYFILE_EXCL);
console.log(JSON.stringify({ stage, version, ...verified, packages, serverDeployed: false, pluginPublished: false }, null, 2));
