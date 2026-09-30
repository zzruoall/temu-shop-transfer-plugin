import mysql from "mysql2/promise";
import { randomBytes } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// 仅初始化新建的本地专用实例；固定非标准端口，绝不连接机器已有的 3306 服务。
if(!process.argv.includes("--confirm-new-local-instance"))throw new Error("仅用于新建回环33918实例");
const directory=path.resolve("../.local-mysql");
await mkdir(directory,{recursive:true});
const rootPassword=randomBytes(32).toString("hex");
const appPassword=randomBytes(32).toString("hex");
const rootConfig={host:"127.0.0.1",port:33918,user:"root",password:rootPassword};
const appConfig={host:"127.0.0.1",port:33918,user:"temu_local",password:appPassword,database:"temu_local"};
const connection=await mysql.createConnection({host:"127.0.0.1",port:33918,user:"root"});
try {
    // 确认新实例已启动后排他创建凭证，防止重复运行覆盖已经生效的随机密码。
    await writeFile(path.join(directory,"admin.json"),JSON.stringify(rootConfig),{flag:"wx",mode:0o600});
    await writeFile(path.join(directory,"app.json"),JSON.stringify(appConfig),{flag:"wx",mode:0o600});
    await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?",[rootPassword]);
    await connection.query("CREATE DATABASE temu_local CHARACTER SET utf8mb4 COLLATE utf8mb4_bin");
    await connection.query("CREATE USER 'temu_local'@'localhost' IDENTIFIED BY ?",[appPassword]);
    await connection.query("GRANT ALL PRIVILEGES ON temu_local.* TO 'temu_local'@'localhost'");
    console.log(JSON.stringify({created:true,config:path.join(directory,"app.json"),port:33918}));
} finally { await connection.end(); }
