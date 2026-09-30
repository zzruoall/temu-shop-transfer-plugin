/**
 * 店铺删除名单：被管理员删除的店铺记在这里，插件心跳不再重新登记它们。
 *
 * 为什么需要名单：插件每 8 秒心跳一次并登记店铺（registerAgent），
 * 删掉的店下一次心跳就会原地复活——管理员会以为删除没生效。
 * 因此删除是"记名单 + 清数据"，恢复也是显式动作。
 *
 * 名单里的记录同时充当"删除存档"：保留店名、删除时间、操作人、当时的归属，
 * 供已删除列表展示与恢复时还原归属关系。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createMysqlMap } from "./mysql-map.mjs";

function text(value) {
    return String(value ?? "").trim();
}

export function createDeletedStores(rootDir, options = {}) {
    const sql = options.database ? createMysqlMap(options.database, "deleted", "deleted") : null;
    const filePath = path.join(rootDir, "deleted-stores.json");
    let queue = Promise.resolve();

    function withLock(task) {
        if (sql) return sql.transaction(task);
        const run = queue.then(task);
        queue = run.catch(() => {});
        return run;
    }

    /** 与仓库其他状态文件一致：先写临时文件，再备份改名，中断时旧表仍可用。 */
    async function writeState(state) {
        if (sql) return sql.write(state);
        const temp = `${filePath}.tmp`;
        const backup = `${filePath}.bak`;
        await mkdir(rootDir, { recursive: true });
        await writeFile(temp, JSON.stringify(state, null, 2), "utf8");
        await rm(backup, { force: true });
        try { await rename(filePath, backup); } catch (error) { if (!error || error.code !== "ENOENT") throw error; }
        try {
            await rename(temp, filePath);
            await rm(backup, { force: true });
        } catch (error) {
            try { await rename(backup, filePath); } catch {}
            throw error;
        }
    }

    async function readState() {
        if (sql) return sql.read();
        await mkdir(rootDir, { recursive: true });
        let state = null;
        try {
            state = JSON.parse(await readFile(filePath, "utf8"));
        } catch {
            for (const candidate of [`${filePath}.tmp`, `${filePath}.bak`]) {
                try {
                    const parsed = JSON.parse(await readFile(candidate, "utf8"));
                    await writeFile(filePath, JSON.stringify(parsed, null, 2), "utf8");
                    state = parsed;
                    break;
                } catch {}
            }
        }
        if (!state || typeof state !== "object") state = { version: 1, deleted: {} };
        if (!state.deleted || typeof state.deleted !== "object") state.deleted = {};
        return state;
    }

    function normalize(entry) {
        if (!entry || typeof entry !== "object") return null;
        return {
            storeId: text(entry.storeId),
            storeName: text(entry.storeName),
            // 删除时选的模式：keep 表示商品保留在库中，purge 表示数据已一并清除。
            // 恢复时据此如实告知管理员商品是否还在，不谎称数据能找回。
            mode: text(entry.mode) === "keep" ? "keep" : "purge",
            previousOwnerId: text(entry.previousOwnerId),
            previousOwnerName: text(entry.previousOwnerName),
            deletedAt: text(entry.deletedAt),
            deletedBy: text(entry.deletedBy)
        };
    }

    async function list() {
        const state = await readState();
        return Object.values(state.deleted).map(normalize).filter(Boolean)
            .sort((left, right) => String(right.deletedAt).localeCompare(String(left.deletedAt)));
    }

    /** 是否在删除名单里；心跳登记前用它拦截。 */
    async function isDeleted(storeId) {
        const id = text(storeId);
        if (!id) return false;
        const state = await readState();
        return Boolean(state.deleted[id]);
    }

    /** 批量判断，避免逐个读盘（心跳可能一次问多个店）。 */
    async function deletedSet() {
        const state = await readState();
        return new Set(Object.keys(state.deleted));
    }

    async function find(storeId) {
        const id = text(storeId);
        if (!id) return null;
        const state = await readState();
        return normalize(state.deleted[id]);
    }

    async function markDeleted({ storeId, storeName, mode, previousOwnerId, previousOwnerName, deletedBy } = {}) {
        const id = text(storeId);
        if (!id) throw Object.assign(new Error("缺少店铺标识"), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            const entry = {
                storeId: id,
                storeName: text(storeName),
                mode: text(mode) === "keep" ? "keep" : "purge",
                previousOwnerId: text(previousOwnerId),
                previousOwnerName: text(previousOwnerName),
                deletedAt: new Date().toISOString(),
                deletedBy: text(deletedBy)
            };
            state.deleted[id] = entry;
            await writeState(state);
            return entry;
        });
    }

    /** 从名单移除；返回被移除的记录，调用方据此还原归属。 */
    async function unmark(storeId) {
        const id = text(storeId);
        if (!id) throw Object.assign(new Error("缺少店铺标识"), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            const previous = normalize(state.deleted[id]);
            if (!previous) throw Object.assign(new Error("该店铺不在已删除名单中"), { status: 404 });
            delete state.deleted[id];
            await writeState(state);
            return previous;
        });
    }

    return { list, isDeleted, deletedSet, find, markDeleted, unmark };
}
