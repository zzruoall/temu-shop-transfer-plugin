"use strict";
/** 独立IndexedDB保存不可变上传包，不更改采集数据库版本；本地落盘失败时绝不发起上传。 */
globalThis.TemuIngestOutbox = (() => {
    async function run(action, id, value) {
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('temu-ingest-outbox', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('packets', { keyPath: 'id' });
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction('packets', action === 'get' ? 'readonly' : 'readwrite');
                const store = tx.objectStore('packets');
                let result, failure;
                if (action === 'put') {
                    // 双重限额在同一事务内检查，不能因多个请求同时写入而突破本地预算。
                    const all = store.getAll();
                    all.onsuccess = () => {
                        const old = all.result.filter(row => row.id !== id && row.packet);
                        const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
                        if (old.length >= 10 || old.reduce((n, row) => n + row.bytes, bytes) > 128 * 1024 * 1024) {
                            failure = Error('ingest_local_capacity_full'); tx.abort(); return;
                        }
                        store.put({ ...value, id, bytes });
                    };
                } else if (action === 'complete') {
                    // 取消后迟到的成功仍更新独立摘要，不能永久显示成结果未知。
                    const receiptId = `receipt:${value.requestId}`, request = store.get(receiptId);
                    request.onsuccess = () => {
                        if (request.result) store.put({ ...request.result, status: 'completed_after_stop', batchId: value.batchId,
                            completedAt: new Date().toISOString() });
                        store.delete(id);
                    };
                } else if (action === 'retire') {
                    // 取消后大包退出自动上传队列，轻量幂等记录不占待上传包名额。
                    const request = store.get(id);
                    request.onsuccess = () => {
                        const value = request.result;
                        if (value?.requestId) store.put({ id: `receipt:${value.requestId}`, requestId: value.requestId,
                            transferIntegrity: value.transferIntegrity || null, fileName: value.fileName,
                            retiredAt: new Date().toISOString(), status: 'stopped_result_unconfirmed' });
                        store.delete(id);
                    };
                } else {
                    const request = action === 'get' ? store.get(id) : store.delete(id);
                    request.onsuccess = () => { result = request.result; };
                }
                tx.oncomplete = () => resolve(result);
                tx.onabort = tx.onerror = () => reject(failure || tx.error || Error('ingest_local_storage_failed'));
            });
        } finally { db.close(); }
    }
    return { get: id => run('get', id), put: (id, value) => run('put', id, value), retire: id => run('retire', id),
        complete: (id, value) => run('complete', id, value), remove: id => run('remove', id) };
})();
