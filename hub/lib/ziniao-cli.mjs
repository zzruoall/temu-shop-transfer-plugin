import { spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";

const MAX_OUTPUT = 4 * 1024 * 1024;

export function parseCliJson(text) {
    const raw = String(text || "").trim();
    try { return JSON.parse(raw); } catch {}
    const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { return JSON.parse(lines[i]); } catch {}
    }
    throw new Error("ziniao_cli_invalid_json");
}

/**
 * 解开 ziniao-cli 常见的 {ok,data:{data:...}} 包装，方便读取 screenshot/exec 的真实字段。
 */
export function unwrapCliData(value) {
    let current = value;
    for (let i = 0; i < 6; i += 1) {
        if (!current || typeof current !== "object" || Array.isArray(current)) break;
        if ("filePath" in current || "result" in current || "url" in current || "running" in current) return current;
        if ("data" in current && current.data && typeof current.data === "object") {
            current = current.data;
            continue;
        }
        break;
    }
    return current;
}

export function runCli(args, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        // Windows 的 CLI 入口是 .cmd 文件，直接 spawn 可执行名会在部分 Node 版本下返回 ENOENT。
        const command = process.platform === "win32" ? "ziniao-cli.cmd" : "ziniao-cli";
        // .cmd 入口在 Windows 需要 shell 才能启动；本模块只传固定子命令，不把用户输入拼进命令字符串。
        const quotedArgs = process.platform === "win32"
            ? args.map((item) => `"${String(item).replace(/"/g, '\\"')}"`)
            : args;
        const child = spawn(command, quotedArgs, { windowsHide: true, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error("ziniao_cli_timeout"));
        }, timeoutMs);
        const append = (target, chunk) => {
            const next = target + chunk.toString();
            return next.length > MAX_OUTPUT ? next.slice(-MAX_OUTPUT) : next;
        };
        child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
        child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                const message = stderr.trim() || stdout.trim() || `ziniao_cli_exit_${code}`;
                reject(new Error(message.slice(0, 500)));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

function asText(value) {
    return String(value || "").trim();
}

/**
 * 紫鸟浏览器 Bridge。页面操作必须走 ziniao-cli，不能直接打 ZClaw HTTP。
 * 这里不提供文件选择器/本地图片上传：当前 CLI 工具列表没有对应能力。
 */
export function createZiniaoBridge(options = {}) {
    const execCli = typeof options.runCli === "function" ? options.runCli : runCli;

    async function call(args, timeoutMs) {
        const result = await execCli(args, timeoutMs);
        const raw = asText(result && result.stdout);
        if (!raw) return { ok: true, raw: result && result.stderr || "" };
        try {
            return unwrapCliData(parseCliJson(raw));
        } catch {
            return { ok: true, raw };
        }
    }

    async function listRunningStores() {
        const value = await call(["zclaw", "invoke", "extract_data", "--args", JSON.stringify({ mode: "running" })], 15000);
        const items = value && Array.isArray(value.items) ? value.items
            : value && value.data && Array.isArray(value.data.items) ? value.data.items
            : [];
        return items.map((item) => ({
            storeId: asText(item.storeId || item.id),
            storeName: asText(item.storeName || item.name)
        })).filter((item) => item.storeId);
    }

    async function ensureStoreOpen(storeId, url) {
        const id = asText(storeId);
        if (!id) throw new Error("store_id_required");
        const running = await listRunningStores();
        if (!running.some((item) => item.storeId === id)) {
            // 打开店铺可能要等内核；超时给到两分钟，失败后不得假装已经进入目标页。
            const args = ["store", "open", "--id", id];
            if (url) args.push("--url", url);
            await execCli(args, 120000);
        }
        if (url) await visit(id, url);
        return { storeId: id, running: true };
    }

    async function visit(storeId, url) {
        await execCli(["page", "visit", "--store-id", asText(storeId), "--url", asText(url), "--wait-until", "load", "--timeout", "25000"], 30000);
    }

    async function waitElement(storeId, selector, timeoutMs = 10000) {
        try {
            await execCli(["page", "wait-element", "--store-id", asText(storeId), "--selector", selector, "--timeout", String(timeoutMs)], timeoutMs + 3000);
            return true;
        } catch {
            return false;
        }
    }

    async function execScript(storeId, script) {
        const value = await call(["page", "exec", "--store-id", asText(storeId), "--script", script, "--timeout", "15000"], 18000);
        const raw = value && typeof value.result === "string" ? value.result : "";
        if (!raw) return { raw: value };
        try { return JSON.parse(raw); } catch { return { raw }; }
    }

    /**
     * 紫鸟截图命令会忽略 --path，文件落在系统临时目录。这里再拷到任务目录，作为未提交的证据。
     */
    async function screenshot(storeId, destPath) {
        const value = await call(["page", "screenshot", "--store-id", asText(storeId), "--timeout", "20000"], 25000);
        const source = asText(value && (value.filePath || value.path));
        if (!source) throw new Error("screenshot_missing");
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(source, destPath);
        return destPath;
    }

    return { listRunningStores, ensureStoreOpen, visit, waitElement, execScript, screenshot, call };
}
