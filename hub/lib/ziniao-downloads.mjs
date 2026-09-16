import path from "node:path";
import { runCli, parseCliJson } from "./ziniao-cli.mjs";

/** 只读查询已打开店铺的真实下载目录；不导航页面，也不接受网页传来的任意磁盘路径。 */
export function createDownloadDirectoryDiscovery(execCli = runCli) {
    async function extract(args) {
        const value = parseCliJson((await execCli(["page", "extract", ...args], 15000)).stdout);
        if (value.ok !== true) throw new Error("ziniao_download_directory_query_failed");
        return value.data;
    }
    return async function discover() {
        const running = await extract(["--mode", "running"]);
        if (!Array.isArray(running?.items)) throw new Error("ziniao_running_stores_missing");
        const directories = [];
        const errors = [];
        for (const store of running.items) {
            const id = String(store.storeId || "");
            // CLI 在 Windows 经命令解释器启动，只允许数字身份进入命令参数。
            if (!/^\d+$/.test(id)) continue;
            try {
                const detail = await extract(["--mode", "store", "--store-id", id]);
                const folder = String(detail?.downloadFolderPath || "");
                if (String(detail?.storeId) !== id || detail?.running !== true || !path.isAbsolute(folder)
                    || /^[\\/]{2}/.test(folder) || folder.includes("\0")) {
                    throw new Error("ziniao_download_directory_invalid");
                }
                directories.push(path.join(folder, "temu-local-dataset"));
            } catch {
                errors.push(`店铺 ${id} 下载目录暂不可读取`);
            }
        }
        return { directories, error: errors.join("；") };
    };
}
