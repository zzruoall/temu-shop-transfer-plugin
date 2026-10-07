/**
 * 收件箱存储适配器（方案步骤2的磁盘部分）。
 *
 * 为什么单独一层：收件箱需要**原子**地把"队列索引 + 分片正文"一起写下去。
 * 浏览器里这个原子性由 IndexedDB 事务提供；Node 里没有 IndexedDB，
 * 若测试继续用内存 Map，就会出现"磁盘收件箱"只在声明上成立的情况
 * （这正是复核对上一版的批评）。所以同一套接口提供三种后端：
 *
 * - 浏览器：`indexedDbInboxStore()` —— 真实事务；
 * - Node 验收：`fileInboxStore(dir)` —— **真实落盘**，重启后从文件重建；
 * - 单元测试：`memoryInboxStore()` —— 只用于不需要重启语义的场景。
 *
 * 三个桶：
 * - `meta`    ：每店一条记录（队列索引 + 批次元数据 + 分片小索引）；
 * - `bodies`  ：分片正文（大字节只进这里，队列变更不重写正文）；
 * - `control` ：状态机的持久状态（暂停/正在结束/在途件身份）。
 *
 * 约束：`atomic(buckets, run)` 的 `run` 内**只能**做本适配器的读写，
 * 不能 await 网络、定时器等非事务操作，否则 IndexedDB 事务会提前提交。
 */

const BUCKETS = ['meta', 'bodies', 'control'];

/** 实例级文档标记：用于区分"后台唤醒"（同 documentId 恢复）与"页面重载"（清理）。 */
export const INSTANCE_KEY = '__instance__';

/** 复用外层事务句柄：控制器和收件箱必须在同一事务内读写，禁止嵌套申请锁。 */
export function transactionInboxStore(handle) {
    return { inTransaction: true, atomic: async (_buckets, run) => run(handle),
        get: (bucket, key) => handle.get(bucket, key), list: bucket => handle.list(bucket) };
}

function missing(name) {
    return Object.assign(new Error(`缺少存储适配器：${name}`), { code: 'inbox_store_missing' });
}

/**
 * 内存适配器：只用于不需要重启语义的单元测试。
 * 串行化 `atomic`，与磁盘适配器保持相同顺序语义。
 */
export function memoryInboxStore() {
    const data = new Map(BUCKETS.map(bucket => [bucket, new Map()]));
    let tail = Promise.resolve();
    const clone = value => value === undefined ? undefined : structuredClone(value);

    async function atomic(_buckets, run) {
        const previous = tail;
        let release;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            // 事务副本只在成功后发布，测试适配器也必须支持异常回滚。
            const pending = structuredClone(data);
            const handle = {
                get: async (bucket, key) => clone(pending.get(bucket)?.get(key)),
                put: async (bucket, key, value) => { pending.get(bucket).set(key, clone(value)); },
                del: async (bucket, key) => { pending.get(bucket).delete(key); },
                keys: async bucket => [...(pending.get(bucket)?.keys() || [])],
                list: async bucket => [...(pending.get(bucket)?.values() || [])].map(clone)
            };
            const result = await run(handle);
            for (const [bucket, entries] of pending) data.set(bucket, entries);
            return result;
        } finally { release(); }
    }

    return {
        kind: 'memory',
        atomic,
        async get(bucket, key) { return clone(data.get(bucket)?.get(key)); },
        async list(bucket) { return [...(data.get(bucket)?.values() || [])]; },
        async close() {}
    };
}

/**
 * 文件适配器：**真实落盘**，Node 验收用它证明重启后能重建状态。
 *
 * 每个键一个文件，写入走"临时文件 + 原子改名"，避免半份记录。
 * 崩溃在多次写入之间的极端情况不做承诺（那是数据库级别的问题），
 * 但同一事务内的写入顺序与内容与内存/IndexedDB 一致。
 */
export function fileInboxStore(rootDir) {
    if (!rootDir) throw missing('fileInboxStore(rootDir)');
    let ioPromise = null;
    const io = () => (ioPromise ||= (async () => {
        const fs = await import('node:fs');
        for (const bucket of BUCKETS) fs.mkdirSync(`${rootDir}/${bucket}`, { recursive: true });
        return fs;
    })());

    const fileOf = (bucket, key) => {
        const encoded = Buffer.from(String(key), 'utf8').toString('base64url');
        return `${rootDir}/${bucket}/${encoded}.json`;
    };
    /** 值编码：JSON 无法直接表达 Uint8Array，正文按 base64 往返。 */
    const encode = value => JSON.stringify(value, (_key, entry) =>
        entry instanceof Uint8Array ? { __bytes: Buffer.from(entry).toString('base64') } : entry);
    const decode = text => JSON.parse(text, (_key, entry) =>
        entry && typeof entry === 'object' && typeof entry.__bytes === 'string'
            ? new Uint8Array(Buffer.from(entry.__bytes, 'base64')) : entry);

    let tail = Promise.resolve();
    async function withLock(run) {
        const previous = tail;
        let release;
        tail = new Promise(resolve => { release = resolve; });
        await previous;
        try { return await run(); } finally { release(); }
    }

    async function handleOf() {
        const fs = await io();
        const handle = {
            async get(bucket, key) {
                const file = fileOf(bucket, key);
                try { return decode(fs.readFileSync(file, 'utf8')); }
                catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
            },
            async put(bucket, key, value) {
                const file = fileOf(bucket, key), temp = `${file}.tmp`;
                fs.writeFileSync(temp, encode(value), 'utf8');
                fs.renameSync(temp, file);
            },
            async del(bucket, key) {
                try { fs.unlinkSync(fileOf(bucket, key)); }
                catch (error) { if (error.code !== 'ENOENT') throw error; }
            },
            async keys(bucket) {
                return fs.readdirSync(`${rootDir}/${bucket}`)
                    .filter(name => name.endsWith('.json'))
                    .map(name => Buffer.from(name.slice(0, -'.json'.length), 'base64url').toString('utf8'));
            },
            async list(bucket) {
                const values = [];
                for (const key of await handle.keys(bucket)) values.push(await handle.get(bucket, key));
                return values;
            }
        };
        return handle;
    }

    async function handle() { return handleOf(); }

    return {
        kind: 'file',
        root: rootDir,
        /**
         * 事务内使用的句柄：提供与外部相同的读写方法。
         * 事务里**不得**调用外部的 `get/list`（它们会再次取锁，自己等自己）。
         */
        atomic: (buckets, run) => withLock(async () => run(await handle())),
        async get(bucket, key) { return withLock(async () => (await handle()).get(bucket, key)); },
        async list(bucket) {
            return withLock(async () => {
                const instance = await handle();
                return instance.list(bucket);
            });
        },
        async close() {}
    };
}

/**
 * 浏览器 IndexedDB 适配器：真实事务，跨桶写入要么都成功要么都回滚。
 * 数据库名与方案一致（`temu-target-session-inbox`）。
 */
export function indexedDbInboxStore({ dbName = 'temu-target-session-inbox', idb = globalThis.indexedDB } = {}) {
    if (!idb) throw missing('indexedDB');
    const opened = new Promise((resolve, reject) => {
        const request = idb.open(dbName, 1);
        request.onupgradeneeded = () => {
            for (const bucket of BUCKETS) {
                if (!request.result.objectStoreNames.contains(bucket)) request.result.createObjectStore(bucket);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('inbox_idb_open_failed'));
    });

    const request = r => new Promise((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error || new Error('inbox_idb_request_failed'));
    });

    async function atomic(buckets, run) {
        const db = await opened;
        const names = Array.isArray(buckets) && buckets.length ? buckets : BUCKETS;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(names, 'readwrite');
            let settled = false, value;
            /** 事务提交才算成功：写入可能在 complete 前就"成功"返回。 */
            tx.oncomplete = () => { if (!settled) { settled = true; resolve(value); } };
            tx.onabort = () => { if (!settled) { settled = true; reject(tx.error || new Error('inbox_tx_aborted')); } };
            tx.onerror = () => { if (!settled) { settled = true; reject(tx.error || new Error('inbox_tx_failed')); } };
            const store = bucket => tx.objectStore(bucket);
            const handle = {
                get: (bucket, key) => request(store(bucket).get(key)),
                put: (bucket, key, entry) => request(store(bucket).put(entry, key)),
                del: (bucket, key) => request(store(bucket).delete(key)),
                keys: bucket => request(store(bucket).getAllKeys()),
                list: bucket => request(store(bucket).getAll())
            };
            // run 内部只允许本适配器的读写；出现其他 await 时事务可能已提交。
            Promise.resolve().then(() => run(handle)).then(result => { value = result; })
                .catch(error => { settled = true; try { tx.abort(); } catch { /* 已结束的事务无需再中止 */ } reject(error); });
        });
    }

    async function read(bucket, key) {
        const db = await opened;
        return request(db.transaction(bucket, 'readonly').objectStore(bucket).get(key));
    }

    return {
        kind: 'indexeddb',
        dbName,
        atomic,
        get: read,
        async list(bucket) {
            const db = await opened;
            return request(db.transaction(bucket, 'readonly').objectStore(bucket).getAll());
        },
        async close() { (await opened).close(); }
    };
}
