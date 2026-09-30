import { randomBytes } from "node:crypto";
import { writeFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

// 仅由部署管理员执行；密码走 mysql 标准输入，不出现在进程命令行或输出中。
const [name, output] = process.argv.slice(2);
if (!/^temu_transfer_[a-z0-9_]{1,16}$/.test(name || "") || !output || !path.isAbsolute(output)) throw new Error("需要独立 temu_transfer_* 库名及绝对配置路径");
await access(output).then(()=>{throw new Error("配置已存在，禁止覆盖");},error=>{if(error.code!=="ENOENT")throw error;});
function mysql(sql){return new Promise((resolve,reject)=>{
    const child=spawn("mysql",["--batch","--skip-column-names"],{stdio:["pipe","pipe","pipe"]});
    let stdout="",stderr="";
    child.stdout.on("data",chunk=>stdout+=chunk);
    child.stderr.on("data",chunk=>stderr+=chunk);
    child.once("error",reject);
    child.once("exit",code=>code===0?resolve(stdout):reject(new Error(`MySQL 管理操作失败，退出码 ${code}；请检查数据库权限（未输出含密钥的 SQL）`)));
    child.stdin.end(sql);
});}
const existing=await mysql(`SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='${name}';`);
if(Number(existing.trim()))throw new Error("数据库已存在，禁止覆盖或重置");
const password=randomBytes(32).toString("hex");
await mysql(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER '${name}'@'localhost' IDENTIFIED BY '${password}';
GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${name}'@'localhost';`);
await writeFile(output,JSON.stringify({host:"127.0.0.1",port:3306,user:name,password,database:name},null,2),{flag:"wx",mode:0o600});
console.log(JSON.stringify({created:true,database:name,configPath:output,credentialsPrinted:false}));
