/** 仅将审核过的源码和签名安装包同步到既有 Git 仓库，不读取生产数据、凭据或私钥，也不自动推送。 */
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const repo = path.join(root, 'output/github-v46-publish');
const frozen = path.join(root, 'output/github-qualification-photo-11.0.10-source');
const version = '11.0.10';
const git = args => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(git(['status', '--porcelain']).trim(), '', '发布仓库有用户修改，不能覆盖');
assert.equal(git(['remote', 'get-url', 'origin']).trim(), 'https://github.com/zzruoall/temu-shop-transfer-plugin.git');
assert.equal(git(['rev-parse', 'HEAD']).trim(), git(['rev-parse', 'origin/main']).trim(), '请先核对远端并发提交');
assert.equal(JSON.parse(await readFile(path.join(root, 'plugin/manifest.json'))).version, version);
const files = new Map();

/** 白名单先于读取；目录链接、机器状态、原始采集包和调试日志都不得进入公开仓库。 */
async function take(file) {
    assert.ok(!path.isAbsolute(file) && !file.split('/').includes('..'));
    assert.ok(!/(?:^|\/)(?:users|credentials|plugin-tokens|ingest-auth|store-ownership|deleted-stores|mysql[^/]*)\.json/i.test(file));
    assert.ok(!/\.(?:pem|key|log|sql|sqlite3?)$/i.test(file));
    const bytes = await readFile(path.join(root, file));
    assert.ok(bytes.length < 8 * 1024 * 1024, `不是源码大小:${file}`);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|ghp_[A-Za-z0-9]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{40,}/.test(bytes.toString('utf8')), `疑似秘密，停止同步:${file}`);
    files.set(file, bytes);
}
async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        assert.ok(!entry.isSymbolicLink(), `禁止目录链接:${relative}/${entry.name}`);
        const file = relative + '/' + entry.name;
        if (entry.name.startsWith('.') || ['node_modules', 'data', 'output', 'test-artifacts', 'downloads', 'fixtures'].includes(entry.name)) continue;
        if (entry.isDirectory()) await walk(file);
        else if (entry.isFile() && /\.(?:js|mjs|cjs|json|html|css|md|sh|ps1|cmd|svg|png|ico)$/i.test(entry.name)) {
            if (relative.startsWith('hub/scripts') && (entry.name.startsWith('_') || entry.name === 'preview-stores.mjs')) continue;
            await take(file);
        }
    }
}
for (const file of ['hub/server.mjs', 'hub/cloud-auth.mjs', 'hub/login.mjs', 'hub/package.json', 'hub/package-lock.json', 'hub/favicon.svg', 'hub/MYSQL.md']) await take(file);
for (const directory of ['hub/lib', 'hub/workers', 'hub/public', 'hub/scripts', 'plugin', 'worker']) await walk(directory);
// 网站以真实 v60 为基线，只叠加本次修复；本地尚未发布的账户调度实验不能随同步混入正式源码。
const approved = new Set(['hub/server.mjs', 'hub/lib/job-queue.mjs', 'hub/lib/product-live-photos.mjs',
    'hub/scripts/verify-live-photo-storage.mjs', 'hub/scripts/verify-qualification-transfer.mjs',
    'hub/scripts/verify-qualification-real-pictures.mjs', 'hub/scripts/verify-qualification-plugin.mjs',
    'hub/scripts/package-live-photo-plugin.mjs', 'hub/scripts/sync-github-qualification-photo-fixes.mjs']);
const overrides = new Map([...files].filter(([file]) => approved.has(file)));
const ssh = ['-i', 'C:/Users/27117/.ssh/ylx-server-ed25519', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes',
    '-o', 'ConnectTimeout=15', '-o', 'HostKeyAlias=ruofei.com.cn', 'ylx@www.ruofei.com.cn'];
const remote = `import assert from'node:assert/strict';import{readdir,readFile,realpath}from'node:fs/promises';import{createHash}from'node:crypto';
const root='/home/ylx/apps/temu-transfer/current';assert.equal(await realpath(root),'/home/ylx/apps/temu-transfer/releases/v60');const files={};
async function take(file){const bytes=await readFile(root+'/'+file);files[file]={sha256:createHash('sha256').update(bytes).digest('hex'),body:bytes.toString('base64')};}
async function walk(dir){for(const entry of await readdir(root+'/'+dir,{withFileTypes:true})){assert.ok(!entry.isSymbolicLink());const file=dir+'/'+entry.name;
if(entry.name.startsWith('.')||['downloads','node_modules','data','fixtures','output','test-artifacts'].includes(entry.name))continue;
if(entry.isDirectory())await walk(file);else if(entry.isFile()&&/[.](js|mjs|cjs|json|html|css|md|sh|ps1|cmd|svg|png|ico)$/i.test(entry.name)){
if(dir.startsWith('hub/scripts')&&(entry.name.startsWith('_')||entry.name==='preview-stores.mjs'))continue;await take(file);}}}
for(const file of['hub/server.mjs','hub/cloud-auth.mjs','hub/login.mjs','hub/package.json','hub/package-lock.json','hub/favicon.svg'])await take(file);
for(const dir of['hub/lib','hub/workers','hub/public','hub/scripts'])await walk(dir);console.log(JSON.stringify(files));`;
const production = JSON.parse(execFileSync('ssh', [...ssh, 'sudo -n /home/ylx/apps/temu-transfer/runtime/bin/node --input-type=module -'],
    { input: remote, encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 64 * 1024 * 1024 }));
for (const file of files.keys()) if (file.startsWith('hub/')) files.delete(file);
for (const [file, entry] of Object.entries(production)) {
    assert.ok(file.startsWith('hub/') && !file.split('/').includes('..') && !/\.(pem|key|log|sql)$/i.test(file));
    const bytes = Buffer.from(entry.body, 'base64'); assert.equal(hash(bytes), entry.sha256);
    assert.ok(!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{30,}|ghp_[A-Za-z0-9]{30,}/.test(bytes.toString('utf8')), `疑似秘密:${file}`);
    files.set(file, bytes);
}
for (const [file, bytes] of overrides) files.set(file, bytes);
for (const suffix of ['crx', 'zip']) {
    const name = `temu-transfer-plugin-${version}.${suffix}`;
    const bytes = await readFile(path.join(root, name));
    files.set('hub/public/downloads/' + name, bytes);
}
// 构建产物与公开转换源必须一致，否则不能发布一个无法从仓库重现的插件。
assert.equal(await readFile(path.join(root, 'plugin/direct-adapter.js'), 'utf8'),
    `/** 构建产物：固定页面商品转换，无云仓令牌；来源保真由独立模块核验。 */\nwindow.__temuDirectPrepare=${await readFile(path.join(root, 'worker/direct-create-prepare.js'), 'utf8')};\n`);
const changed = [];
for (const [file, bytes] of files) {
    let old;
    try { old = await readFile(path.join(repo, file)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!old || !old.equals(bytes)) changed.push(file);
}
if (!process.argv.includes('--apply')) {
    console.log(JSON.stringify({ sourceFiles: files.size, changedFiles: changed.length, files: changed, productionWrites: 0, githubWrites: 0 }));
} else {
    await assert.rejects(access(frozen), { code: 'ENOENT' });
    // 先冻结全部白名单文件，后续同步只使用冻结字节；已存在源码通过行级补丁更新，不整文件覆盖。
    for (const [file, bytes] of files) {
        const source = path.join(frozen, file);
        await mkdir(path.dirname(source), { recursive: true }); await writeFile(source, bytes, { flag: 'wx' });
    }
    for (const file of changed) {
        const destination = path.join(repo, file), source = path.join(frozen, file), bytes = files.get(file);
        let old;
        try { old = await readFile(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!old) { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, bytes, { flag: 'wx' }); }
        else {
            const oldName = path.relative(root, destination).replaceAll('\\', '/'), newName = path.relative(root, source).replaceAll('\\', '/');
            const diff = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', 'diff', '--no-index', '--binary', '--', oldName, newName],
                { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
            assert.equal(diff.status, 1, diff.stderr);
            const patch = diff.stdout.split('\n').map(line => /^(diff --git |--- |\+\+\+ )/.test(line)
                ? line.replace('a/' + oldName, 'a/' + file).replace('b/' + newName, 'b/' + file) : line).join('\n');
            const applied = spawnSync('git', ['-c', 'core.autocrlf=false', 'apply', '--whitespace=nowarn', '-'],
                { cwd: repo, input: patch, encoding: 'utf8', windowsHide: true });
            assert.equal(applied.status, 0, applied.stderr);
        }
        assert.deepEqual(await readFile(destination), bytes, `仓库字节不一致:${file}`);
    }
    const manifest = Object.fromEntries([...files].map(([file, bytes]) => [file, hash(bytes)]).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(path.join(repo, 'docs/qualification-photo-11.0.10-sha256.json'), JSON.stringify({ plugin: version,
        websiteBase: 'v60', productionDeployedThisRequest: false, files: manifest }, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ sourceFiles: files.size, changedFiles: changed.length, repo, plugin: version, secretsCopied: 0, productionWrites: 0, githubPushed: false }));
}
