import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createPublicKey, verify } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import path from "node:path";

/** 只读取公钥校验 CRX3 签名，并逐文件比对当前插件源码；不读取或输出签名私钥。 */
function fields(buffer) {
    let position = 0;
    const result = [];
    function number() {
        let value = 0, shift = 0, byte;
        do { byte = buffer[position++]; value += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
        return value;
    }
    while (position < buffer.length) {
        const tag = number();
        assert.equal(tag & 7, 2);
        const size = number();
        result.push([tag >> 3, buffer.subarray(position, position + size)]);
        position += size;
    }
    return result;
}
function readCrx(buffer) {
    assert.equal(buffer.toString("ascii", 0, 4), "Cr24");
    assert.equal(buffer.readUInt32LE(4), 3);
    const size = buffer.readUInt32LE(8);
    const header = fields(buffer.subarray(12, 12 + size));
    const signed = header.find(([key]) => key === 10000)[1];
    const proof = fields(header.find(([key]) => key === 2)[1]);
    const zip = buffer.subarray(12 + size);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(signed.length);
    const payload = Buffer.concat([Buffer.from("CRX3 SignedData\0"), length, signed, zip]);
    assert.ok(verify("sha256", payload, createPublicKey({ key: proof.find(([key]) => key === 1)[1], type: "spki", format: "der" }), proof.find(([key]) => key === 2)[1]));
    const id = fields(signed).find(([key]) => key === 1)[1].toString("hex").replace(/./g, c => String.fromCharCode(97 + parseInt(c, 16)));
    return { id, zip };
}
const idOnly = process.argv.includes("--id-only");
const args = process.argv.slice(2).filter(value => !value.startsWith("--"));
const file = args[0];
const sourceRoot = path.resolve("plugin");
const packet = readCrx(await readFile(file));
if (idOnly) {
    console.log(JSON.stringify({ extensionId: packet.id }));
    process.exit(0);
}
if (args[1]) assert.equal(packet.id, readCrx(await readFile(args[1])).id, "扩展ID必须保持一致");
let end = packet.zip.length - 22;
while (end >= 0 && packet.zip.readUInt32LE(end) !== 0x06054b50) end--;
assert.ok(end >= 0);
let offset = packet.zip.readUInt32LE(end + 16);
const count = packet.zip.readUInt16LE(end + 10);
const names = [];
for (let i = 0; i < count; i++) {
    const z = packet.zip;
    assert.equal(z.readUInt32LE(offset), 0x02014b50);
    const method = z.readUInt16LE(offset + 10), size = z.readUInt32LE(offset + 20), local = z.readUInt32LE(offset + 42);
    const nameLength = z.readUInt16LE(offset + 28), extra = z.readUInt16LE(offset + 30), comment = z.readUInt16LE(offset + 32);
    const name = z.toString("utf8", offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extra + comment;
    if (name.endsWith("/")) continue;
    assert.ok(!name.split("/").includes("..") && !path.isAbsolute(name));
    const start = local + 30 + z.readUInt16LE(local + 26) + z.readUInt16LE(local + 28);
    const compressed = z.subarray(start, start + size);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    assert.deepEqual(content, await readFile(path.join(sourceRoot, name)), `文件不同: ${name}`);
    names.push(name);
}
async function sourceFiles(directory) {
    let files = [];
    for (const item of await readdir(directory, { withFileTypes: true })) files = files.concat(item.isDirectory() ? await sourceFiles(path.join(directory, item.name)) : [path.join(directory, item.name)]);
    return files;
}
assert.equal(names.length, (await sourceFiles(sourceRoot)).length);
assert.ok(names.includes("operation-log.js"));
console.log(JSON.stringify({ signatureValid: true, sourceFilesMatch: names.length, extensionId: packet.id, version: JSON.parse(await readFile(path.join(sourceRoot, "manifest.json"))).version }));
