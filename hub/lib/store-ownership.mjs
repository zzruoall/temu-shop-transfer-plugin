/**
 * 店铺归属表：storeId → 所属用户。
 *
 * 商品按来源店记录；个人管理权限和商品分类随重新认领转移。
 * 解除本身保留历史分类；无归属店重新认领时，历史商品整体归入新账户类型，不删除或复制原文件。
 *
 * 认领语义（按业务约定）：
 * - 一个店铺只能被一个用户认领，认领后独占，他人可见但不能再认领；
 * - 用户可自行解除认领，解除后店铺回到待认领状态（数据不删除，重新认领即恢复可见）；
 * - 管理员可改派（员工离职、店铺换人），改派即转移归属，数据随之转移。
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
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
            // 旧目录用认领时间作兼容代次；新认领用随机标识防止同账号解绑再认领复活旧授权。
            claimId: text(entry.claimId) || text(entry.claimedAt),
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

    // 分类使用保留的定长键，与归属共用事务；释放归属不释放分类，也不嵌套申请 SQL 连接。
    const domainKey = id => `$data-domain:${createHash('sha256').update(String(id)).digest('hex')}`;
    const migrationKey = '$account-types:v1';
    const accountType = user => user?.accountType === 'test' ? 'test' : 'production';
    function checkDomain(state, id, user, allowClassification = false) {
        const fixed = state.assignments[domainKey(id)];
        if (allowClassification && fixed?.accountType === 'unclassified') return;
        if (fixed && fixed.accountType !== accountType(user)) {
            throw Object.assign(Error('测试与正式账户不能互相认领或改派店铺'), { status: 409 });
        }
    }
    function saveDomain(state, id, type) {
        state.assignments[domainKey(id)] = { kind: 'data-domain', storeId: id, accountType: type };
    }
    /** 初始化只运行一次，指定的三个账户保留原角色和口令；解除归属本身不会改写历史分类。 */
    async function initializeAccountTypes(users, knownStores = async () => []) {
        // 库存目录读取发生在归属事务外；小连接池不能在持锁时嵌套读取库存。
        if ((await readState()).assignments[migrationKey]) return;
        const legacyStores = await knownStores();
        return withLock(async () => {
            const state = await readState();
            if (state.assignments[migrationKey]) return;
            await users.assignInitialTestUsers();
            const byId = new Map((await users.listUsers()).map(user => [user.id, user]));
            for (const [id, entry] of Object.entries(state.assignments)) {
                if (normalize(entry)) saveDomain(state, id, byId.has(entry.ownerId) ? accountType(byId.get(entry.ownerId)) : 'unclassified');
            }
            for (const id of legacyStores) {
                if (id && !state.assignments[domainKey(id)]) saveDomain(state, id, 'unclassified');
            }
            state.assignments[migrationKey] = { kind: 'migration', completedAt: new Date().toISOString() };
            await writeState(state);
        });
    }
    /** 未认领店保留上次分类；重新认领时与新归属同事务更新，商品及附件按来源店一起转移可见范围。 */
    async function listDataDomains() {
        const state = await readState();
        return Object.fromEntries(Object.values(state.assignments)
            .filter(entry => entry?.kind === 'data-domain')
            .map(entry => [entry.storeId, entry.accountType]));
    }

    /** 某用户拥有的店铺 ID 集合，只决定个人库和写入/目标店权限，不决定共享库的读取范围。 */
    async function ownedStoreIds(userId) {
        const assignments = await listAssignments();
        const owner = text(userId);
        return new Set(Object.entries(assignments).filter(([, item]) => item.ownerId === owner).map(([storeId]) => storeId));
    }

    async function findOwner(storeId) {
        const assignments = await listAssignments();
        return assignments[text(storeId)] || null;
    }
    /** 一次锁内核验目标权限并捕获归属代次，防止等待准入时店铺改派后仍向他人的店发送。 */
    async function snapshotDeliveryOwners(storeIds, targetStoreId, userId = null, requiredType = null) {
        return withLock(async () => {
            const state = await readState();
            // 分类授权和归属快照不可分开读取，否则跨类重新认领可使旧请求捕获新代次并继续发送。
            if (requiredType && storeIds.some(id => state.assignments[domainKey(id)]?.accountType !== requiredType)) {
                throw Object.assign(Error('store_not_claimed'), { status: 403 });
            }
            const target = normalize(state.assignments[targetStoreId]);
            if (userId && target?.ownerId !== userId) throw Object.assign(Error('目标店铺已不属于当前账户'), { status: 403 });
            return Object.fromEntries(storeIds.map(id => {
                const owner = normalize(state.assignments[id]);
                return [id, { ownerId: owner?.ownerId || '', claimId: owner?.claimId || '' }];
            }));
        });
    }

    /** 删除和解红在归属锁内取得当前写范围并完成库存操作；SQL 复用同一连接，避免转移后的旧请求继续改写。 */
    async function withWriteScope({ ownerId = null, type = null } = {}, fn) {
        return withLock(async connection => {
            const state = await readState();
            let scope = null;
            if (type) scope = new Set(Object.values(state.assignments)
                .filter(entry => entry?.kind === 'data-domain' && entry.accountType === type).map(entry => entry.storeId));
            if (ownerId) {
                const owned = Object.entries(state.assignments).filter(([, entry]) => normalize(entry)?.ownerId === ownerId).map(([id]) => id);
                scope = new Set(owned.filter(id => !scope || scope.has(id)));
            }
            return fn(scope, connection);
        });
    }
    /** 异常标记必须与归属改派互斥；SQL 下把同一连接交给库存写入，不嵌套申请连接。 */
    async function withStableOwners(expected, fn) {
        return withLock(async connection => {
            const state = await readState();
            for (const [storeId, snapshot] of Object.entries(expected)) {
                const current = normalize(state.assignments[storeId]);
                if ((current?.ownerId || '') !== (snapshot.ownerId || '') || (current?.claimId || '') !== (snapshot.claimId || '')) {
                    throw Object.assign(Error('failure_source_changed'), { status: 409 });
                }
            }
            return fn(connection);
        });
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
            if (id.startsWith('$')) throw Object.assign(Error('店铺标识使用了内部保留前缀'), { status: 400 });
            unique.set(id, { storeId: id, storeName: text(item?.storeName) });
        }
        if (!unique.size) throw Object.assign(new Error("缺少店铺标识"), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            const conflicts = [];
            for (const [storeId] of unique) {
                const existing = normalize(state.assignments[storeId]);
                const type = state.assignments[domainKey(storeId)]?.accountType;
                // 已有归属先核验分类，避免跨分类冲突提示泄露店主；已释放店允许历史商品随新账户归并。
                if (existing || !['test', 'production'].includes(type)) checkDomain(state, storeId, user);
                if (existing && existing.ownerId !== ownerId) {
                    conflicts.push(`${existing.storeName || storeId}（${existing.ownerName || "其他账号"}）`);
                    continue;
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
                    claimId: existing?.claimId || randomUUID(),
                    claimedBySelf: true
                };
                state.assignments[storeId] = entry;
                saveDomain(state, storeId, accountType(user));
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

    /** 管理员改派仅在同分类内转移；历史未分类数据可由管理员通过选定目标账户明确归类。 */
    async function reassign(storeId, user, storeName = "") {
        const id = text(storeId);
        const ownerId = text(user && user.id);
        if (!id || !ownerId) throw Object.assign(new Error("缺少店铺或用户标识"), { status: 400 });
        if (id.startsWith('$')) throw Object.assign(Error('店铺标识使用了内部保留前缀'), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            const previous = normalize(state.assignments[id]);
            checkDomain(state, id, user, true);
            const entry = {
                ownerId,
                ownerName: text(user.username),
                storeName: text(storeName) || previous?.storeName || "",
                claimedAt: new Date().toISOString(),
                claimId: randomUUID(),
                claimedBySelf: false
            };
            state.assignments[id] = entry;
            saveDomain(state, id, accountType(user));
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
        if (id.startsWith('$')) throw Object.assign(Error('店铺标识使用了内部保留前缀'), { status: 400 });
        return withLock(async () => {
            const state = await readState();
            // 恢复的旧店若没有分类证据，先进入管理员待归类范围，不能默认变为正式数据。
            if (!state.assignments[domainKey(id)]) saveDomain(state, id, 'unclassified');
            state.assignments[id] = {
                ownerId: owner,
                ownerName: text(ownerName),
                storeName: text(storeName),
                claimedAt: text(claimedAt) || new Date().toISOString(),
                claimId: randomUUID(),
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

    return { initializeAccountTypes, listDataDomains, listAssignments, ownedStoreIds, findOwner, snapshotDeliveryOwners, withWriteScope, withStableOwners, claim, claimMany, release, reassign, forceRelease, releaseByOwner, restoreAssignment, liveSignature };
}
