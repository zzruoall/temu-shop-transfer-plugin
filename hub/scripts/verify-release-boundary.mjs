/** 精确比较整个发布树：仅清单中的文件可新增或改变，符号链接只比较目标而不越界遍历。 */
import { readdir, lstat, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const [previous, candidate, manifestFile] = process.argv.slice(2);
async function inventory(root, relative = '') {
    const entries = {};
    for (const name of await readdir(path.join(root, relative))) {
        const key = relative ? `${relative}/${name}` : name;
        const file = path.join(root, key), info = await lstat(file);
        if (info.isSymbolicLink()) entries[key] = `link:${await readlink(file)}`;
        else if (info.isDirectory()) Object.assign(entries, await inventory(root, key));
        else entries[key] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
    return entries;
}
const approved = JSON.parse(await readFile(manifestFile, 'utf8'));
const before = await inventory(previous), after = await inventory(candidate);
for (const [key, hash] of Object.entries(approved)) {
    assert.ok(!key.startsWith('/') && !key.split('/').includes('..'));
    assert.equal(after[key], hash, `候选文件摘要不匹配: ${key}`);
}
for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (!(key in approved)) assert.equal(after[key], before[key], `未经清单允许的变动: ${key}`);
}
console.log(JSON.stringify({ releaseBoundary: true, approvedFiles: Object.keys(approved).length, comparedFiles: Object.keys(after).length }));
