/**
 * 店铺归属表：storeId → 所属用户。
 *
 * 归属是"数据跟着店铺"的唯一依据：商品、批次、任务与日志都按来源店记录，
 * 因此只需维护这一张表，改派店铺时数据自动跟随，不需要搬移任何文件。
 *
 * 认领语义（按业务约定）：
 * - 一个店铺只能被一个用户认领，认领后独占，他人可见但不能再认领；
 * - 用户可自行解除认领，解除后店铺回到待认领状态（数据不删除，重新认领即恢复可见）；
 * - 管理员可改派（员工离职、店铺换人），改派即转移归属，数据随之转移。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { createMysqlMap } from "./mysql-map.mjs";

function text(value) {
    return String(value ?? "").trim();
}

export function createStoreOwnership(rootDir, options = {}) {
    const sql = options.database ? createMysqlMap(options.database, "ownership", "assignments") : null;
    const filePath = path.join(rootDir, "store-ownership.json");
    let queue = Promise.resolve();

    function withLock(task) {
        if (sql) return sql.transaction(task);
        const run = queue.then(task);
        queue = run.catch(() => {});
        return run;
    }

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
        if (!state || typeof state !== "object") state = { version: 1, assignments: {} };
        if (!state.assignments || typeof state.assignments !== "object") state.assignments = {};
        return state;
    }

    function normalize(entry) {
        if (!entry || typeof entry !== "object") return null;
        const ownerId = text(entry.ownerId);
        if (!ownerId) return null;
        return {
            ownerId,
            ownerName: text(entry.ownerName),
            storeName: text(entry.storeName),
            claimedAt: text(entry.claimedAt),
            claimedBySelf: entry.claimedBySelf !== false
        };
    }

    async function listAssignments() {
        const state = await readState();
        const out = {};
        for (const [storeId, entry] of Object.entries(state.assignments)) {
            const normalized = normalize(entry);
            if (normalized) out[text(storeId)] = normalized;
        }
        return out;
    }

    /** 某用户拥有的店铺 ID 集合，是所有数据过滤的入口。 */
    async function ownedStoreIds(userId) {
        const assignments = await listAssignments();
        const owner = text(userId);
        return new Set(Object.entries(assignments).filter(([, item]) => item.ownerId === owner).map(([storeId]) => storeId));
    }

    async function findOwner(storeId) {
        const assignments = await listAssignments();
        return assignments[text(storeId)] || null;
    }

    /**
     * 批量认领按一次事务写入：先检查全部店铺是否均可认领，再统一落盘。
     * 这样多选时不会出现前几家成功、后几家因冲突失败而留下半批结果。
     */
    async function claimMany(requests, user) {
        const requested = Array.isArray(requests) ? requests : [];
        const ownerId = text(user?.id);
        const ownerName = text(user?.username);
        if (!ownerId) throw Object.assign(new Error("缺少认领账号标识"), { status: 400 });
        const unique = new Map();
        for (const item of requested) {
            const id = text(item?.storeId);
            if (!id || unique.has(id)) continue;
            unique.set(id, { storeId: id, storeName: text(item?.storeName) });
        }
        if (!unique.size) throw Object.assign(new Error("缺少店铺标识"), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            const conflicts = [];
            for (const [storeId] of unique) {
                const existing = normalize(state.assignments[storeId]);
                if (existing && existing.ownerId !== ownerId) {
                    conflicts.push(`${existing.storeName || storeId}（${existing.ownerName || "其他账号"}）`);
                }
            }
            if (conflicts.length) {
                throw Object.assign(new Error(`以下店铺已被其他账号认领：${conflicts.join("、")}`), { status: 409 });
            }
            const claimedAt = new Date().toISOString();
            const claims = [];
            for (const [storeId, request] of unique) {
                const existing = normalize(state.assignments[storeId]);
                const entry = {
                    ownerId,
                    ownerName,
                    storeName: request.storeName || existing?.storeName || "",
                    claimedAt,
                    claimedBySelf: true
                };
                state.assignments[storeId] = entry;
                claims.push({ storeId, ...entry });
            }
            await writeState(state);
            return claims;
        });
    }

    /** 单店认领复用批量事务，保证两条接口的独占与回执结构完全一致。 */
    async function claim(storeId, user, storeName = "") {
        const [claim] = await claimMany([{ storeId, storeName }], user);
        return claim;
    }

    /** 用户自行解除认领：只能解除自己的；数据保留，重新认领即恢复可见。 */
    async function release(storeId, userId) {
        const id = text(storeId);
        return withLock(async () => {
            const state = await readState();
            const existing = normalize(state.assignments[id]);
            if (!existing) throw Object.assign(new Error("该店铺尚未被认领"), { status: 404 });
            if (existing.ownerId !== text(userId)) {
                throw Object.assign(new Error("只能解除自己认领的店铺"), { status: 403 });
            }
            delete state.assignments[id];
            await writeState(state);
            return { storeId: id, released: true };
        });
    }

    /** 管理员改派：把店铺转给另一个账号，数据随归属一并转移。 */
    async function reassign(storeId, user, storeName = "") {
        const id = text(storeId);
        const ownerId = text(user && user.id);
        if (!id || !ownerId) throw Object.assign(new Error("缺少店铺或用户标识"), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            const previous = normalize(state.assignments[id]);
            const entry = {
                ownerId,
                ownerName: text(user.username),
                storeName: text(storeName) || previous?.storeName || "",
                claimedAt: new Date().toISOString(),
                claimedBySelf: false
            };
            state.assignments[id] = entry;
            await writeState(state);
            return { storeId: id, previousOwnerId: previous?.ownerId || "", ...entry };
        });
    }

    /**
     * 释放某个用户名下的全部店铺（删除账号时调用）。
     *
     * 不这么做会留下孤儿归属：账号没了，店铺仍显示"已被某人认领"，
     * ownerId 指向不存在的用户，谁都认领不了，只能靠管理员逐个强制解除。
     * 返回被释放的店铺清单，供删除确认与结果提示使用。
     */
    async function releaseByOwner(ownerId) {
        const owner = text(ownerId);
        if (!owner) return { released: [] };
        return withLock(async () => {
            const state = await readState();
            const released = [];
            for (const [storeId, entry] of Object.entries(state.assignments)) {
                const normalized = normalize(entry);
                if (!normalized || normalized.ownerId !== owner) continue;
                released.push({ storeId, storeName: normalized.storeName });
                delete state.assignments[storeId];
            }
            if (released.length) await writeState(state);
            return { released };
        });
    }

    /** 管理员强制解除：不校验归属人，用于店铺注销或数据清理。 */
    async function forceRelease(storeId) {
        const id = text(storeId);
        return withLock(async () => {
            const state = await readState();
            const previous = normalize(state.assignments[id]);
            if (!previous) throw Object.assign(new Error("该店铺尚未被认领"), { status: 404 });
            delete state.assignments[id];
            await writeState(state);
            return { storeId: id, released: true, previousOwnerId: previous.ownerId };
        });
    }

    /**
     * 按原样还原一条归属（恢复已删除店铺时用）。
     * 与 reassign 的区别：它保留原认领时间，并按原归属人写回；
     * 归属人账号可能已被删除，此时只写名字，商店回到"已认领但归属账号已不存在"的状态，
     * 由管理员决定改派给谁——不静默丢掉归属信息。
     */
    async function restoreAssignment({ storeId, ownerId, ownerName, storeName, claimedAt } = {}) {
        const id = text(storeId);
        const owner = text(ownerId);
        if (!id || !owner) throw Object.assign(new Error("还原归属需要店铺与归属人标识"), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            state.assignments[id] = {
                ownerId: owner,
                ownerName: text(ownerName),
                storeName: text(storeName),
                claimedAt: text(claimedAt) || new Date().toISOString(),
                claimedBySelf: false
            };
            await writeState(state);
            return { storeId: id, ...state.assignments[id] };
        });
    }

    /**
     * 认领页只需要判断归属是否变化，不能把账号原文通过轮询接口暴露给其他用户。
     * claimedAt 不参与页面展示，放入摘要会让同一店铺被重复认领时无意义重绘。
     */
    async function liveSignature() {
        const assignments = await listAssignments();
        const stablePayload = JSON.stringify(Object.entries(assignments)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([storeId, entry]) => [
                storeId,
                text(entry.ownerId),
                text(entry.storeName)
            ]));
        return createHash("sha256").update(stablePayload).digest("base64url");
    }

    return { listAssignments, ownedStoreIds, findOwner, claim, claimMany, release, reassign, forceRelease, releaseByOwner, restoreAssignment, liveSignature };
}
