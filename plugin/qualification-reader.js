/** 商品资质只读采集器：复用当前商品页客户端，不生成认证信息，也不调用上传或审核接口。 */
var TemuQualificationReader = (() => {
    "use strict";
    const LIST_PATH = "/mms/arbok/product_cert/query/list";
    const DETAIL_PATH = "/mms/arbok/product_cert/query/detail";
    const MAX_BYTES = 8 * 1024 * 1024;
    const MAX_CERTS = 200;
    const MAX_PAGES = 20;
    const MAX_ASSET_BYTES = 10 * 1024 * 1024;
    const MAX_TOTAL_ASSET_BYTES = 32 * 1024 * 1024;
    const MAX_ASSETS = 40;
    const MATERIAL_KEYS = ["productCertFiles", "inspectReportFiles", "multiLangProductCertFileMap", "multiLangInspectReportMap",
        "realPictures", "energyLabelFiles", "supplementaryMaterials", "uploadedContents", "groupUploadedContents"];

    /** 下载仅访问平台 HTTPS 域；凭证、非标准端口及主机后缀伪装不能进入网络层。 */
    function assetUrl(value) {
        try {
            const url = new URL(String(value || "").trim());
            if (url.protocol !== "https:" || url.username || url.password || url.port
                || !["kwcdn.com", "temu.com", "kuajingmaihuo.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return "";
            url.hash = "";
            return url.href;
        } catch { return ""; }
    }

    /** 归档只保存不含查询签名的来源地址；下载仍在源页面使用原地址，不把签名或会话凭证带出页面。 */
    function publicAssetUrl(value) {
        const safe = assetUrl(value);
        if (!safe) return "";
        const url = new URL(safe);
        url.search = "";
        return url.href;
    }

    /** 与仓库的实际材料容器对齐；不扫描要求模板、示例或历史分支，最多留下一个超限哨兵。 */
    function filesFromDetails(items) {
        const files = [], seen = new Set();
        const add = (raw, name = "") => {
            const url = assetUrl(raw), key = publicAssetUrl(url) || String(raw).trim();
            if (!key || seen.has(key) || files.length > MAX_ASSETS) return;
            seen.add(key);
            files.push({ url, name: String(name || "资质附件").slice(0, 240) });
        };
        const visit = (value, depth = 0) => {
            if (files.length > MAX_ASSETS) return;
            if (depth > 40) throw new Error("资质附件结构过深，未截断保存");
            if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
            if (typeof value === "string") { if (/^https?:\/\//i.test(value.trim())) add(value); return; }
            if (!value || typeof value !== "object") return;
            const raw = value.fileUrl || value.imageUrl || value.originalFileUrl || value.url;
            if (raw) add(raw, value.fileName || value.name);
            for (const [key, child] of Object.entries(value)) {
                if (["fileUrl", "imageUrl", "originalFileUrl", "url", "fileName", "name"].includes(key) || /example|template|history/i.test(key)) continue;
                if (child && typeof child === "object") visit(child, depth + 1);
            }
        };
        for (const item of items) for (const key of MATERIAL_KEYS) visit(item.detail?.[key]);
        return files;
    }

    /** 旧元数据预算只豁免顶层附件正文；同名字段藏在其他位置仍计入 8MiB，不能绕过结构限制。 */
    function metadataBytes(value) {
        const metadata = { ...value };
        if (Array.isArray(value.assets)) metadata.assets = value.assets.map(asset => ({ ...asset, dataBase64: undefined }));
        return new TextEncoder().encode(JSON.stringify(metadata)).byteLength;
    }

    /** 下载完成才清理资料里的签名 URL 和认证字段；保留业务编号 authCode，不导出 Cookie 或令牌。 */
    function scrubMetadata(value) {
        if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) {
            try {
                const url = new URL(value.trim());
                url.search = ""; url.hash = ""; url.username = ""; url.password = "";
                return url.href;
            } catch { return "[无效附件地址]"; }
        }
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(scrubMetadata);
        const result = {};
        for (const [key, child] of Object.entries(value)) {
            result[key] = /token|cookie|authorization|password|passwd|secret|credential|session(?:id)?/i.test(key) ? "[REDACTED]" : scrubMetadata(child);
        }
        return result;
    }

    /** 只归档可由魔数确认的静态材料；HTML、SVG、未知二进制及声明与签名冲突均拒绝。 */
    function signatureMime(bytes) {
        const at = (offset, values) => values.every((byte, index) => bytes[offset + index] === byte);
        if (bytes.length >= 5 && at(0, [37, 80, 68, 70, 45])) return "application/pdf";
        if (bytes.length >= 8 && at(0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
        if (bytes.length >= 3 && at(0, [255, 216, 255])) return "image/jpeg";
        if (bytes.length >= 6 && (at(0, [71, 73, 70, 56, 55, 97]) || at(0, [71, 73, 70, 56, 57, 97]))) return "image/gif";
        if (bytes.length >= 12 && at(0, [82, 73, 70, 70]) && at(8, [87, 69, 66, 80])) return "image/webp";
        return "";
    }

    /** 字节逐块转码避免大附件展开参数溢栈；长度上限在流读取阶段已经执行。 */
    function encodeBase64(bytes) {
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
        return btoa(binary);
    }

    /** 同步快照校验供现有后台直接调用；按标准 SHA-256 校验正文，不改变落库调用的同步契约。 */
    function sha256(bytes) {
        const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
            0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
            0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
            0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
            0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
            0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
            0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
            0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
        const state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
        const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
        padded.set(bytes); padded[bytes.length] = 128;
        const view = new DataView(padded.buffer);
        view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
        view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
        const words = new Uint32Array(64), rotate = (value, bits) => (value >>> bits) | (value << (32 - bits));
        for (let offset = 0; offset < padded.length; offset += 64) {
            for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
            for (let i = 16; i < 64; i++) {
                const x = words[i - 15], y = words[i - 2];
                words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
            }
            let [a,b,c,d,e,f,g,h] = state;
            for (let i = 0; i < 64; i++) {
                const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
                const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
                h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
            }
            [a,b,c,d,e,f,g,h].forEach((word, index) => { state[index] += word; });
        }
        return Array.from(state, word => word.toString(16).padStart(8, "0")).join("");
    }

    /** 附件网络有独立可取消预算，超时不标记平台查询不明；实际流量（含失败文件）也计入累计预算。 */
    async function archiveAssets(snapshot, context, snapshotDeadline, materialFiles = null, limits = {}) {
        snapshot.assets = [];
        snapshot.archive = { status: "metadata-only", errors: [] };
        if (typeof context.fetch !== "function") return;
        const errors = snapshot.archive.errors;
        const maxAssets = limits.maxAssets || MAX_ASSETS;
        // 同一次页面回执中的证书和实拍图共用正文预算，避免两套附件叠加超过浏览器消息大小。
        const maxTotalBytes = Number.isSafeInteger(limits.maxTotalAssetBytes) && limits.maxTotalAssetBytes >= 0
            ? Math.min(MAX_TOTAL_ASSET_BYTES, limits.maxTotalAssetBytes) : MAX_TOTAL_ASSET_BYTES;
        const deadline = Math.min(snapshotDeadline, Date.now() + (limits.archiveMs || 15000));
        let totalRead = 0;
        const archiveFailure = reason => Object.assign(new Error(reason), { archiveReason: true });
        let files;
        try { files = materialFiles || filesFromDetails(snapshot.items); }
        catch { errors.push({ url: "", name: "", reason: "资质附件结构过深，无法完整归档" }); files = []; }
        for (const file of files.slice(0, maxAssets)) {
            const sourceUrl = publicAssetUrl(file.url);
            const report = reason => errors.push({ url: sourceUrl, name: file.name, reason });
            if (!file.url) { report("附件不是可信平台 HTTPS 地址"); continue; }
            if (context.signal?.aborted || Date.now() >= deadline || totalRead >= maxTotalBytes) {
                report(context.signal?.aborted ? "附件归档已取消" : totalRead >= maxTotalBytes
                    ? maxTotalBytes === MAX_TOTAL_ASSET_BYTES ? "附件累计超过 32MiB 限制" : "实拍图超过本次商品的剩余归档预算" : "附件归档超过时间预算");
                continue;
            }
            const controller = new AbortController();
            // 私有资质同时需要原始签名和来源登录态；仅允许当前已验证同源路径携带凭据，禁止认证请求自动跳转。
            const privateAsset = context.pageOrigin === "https://agentseller.temu.com"
                && new URL(file.url).origin === context.pageOrigin
                && new URL(file.url).pathname.startsWith("/product-cert-private-tag/");
            let stream, response, timer, abortListener;
            try {
                // 竞争包含身份检查、fetch 和流读取；即使底层挂起也能释放队列，并拒绝迟到的正文。
                const cancelled = new Promise((_, reject) => {
                    abortListener = () => { controller.abort(); reject(archiveFailure("附件归档已取消")); };
                    context.signal?.addEventListener("abort", abortListener, { once: true });
                    timer = setTimeout(() => { controller.abort(); reject(archiveFailure("附件读取超时，已取消")); }, Math.min(5000, deadline - Date.now()));
                });
                const download = async () => {
                    await context.assertCurrent();
                    if (controller.signal.aborted) throw archiveFailure("附件归档已取消");
                    response = await context.fetch(file.url, { method: "GET", credentials: privateAsset ? "same-origin" : "omit",
                        ...(privateAsset ? { mode: "same-origin" } : {}), redirect: privateAsset ? "error" : "follow",
                        referrerPolicy: "no-referrer", signal: controller.signal });
                    if (controller.signal.aborted) { void response.body?.cancel().catch(() => {}); throw archiveFailure("附件归档已取消"); }
                    if (response.type === "opaque" || response.type === "opaqueredirect") throw archiveFailure("附件响应不可读取或跳转不可验证");
                    if (!assetUrl(response.url) || privateAsset && new URL(response.url).origin !== context.pageOrigin) throw archiveFailure("附件响应或重定向地址不可信");
                    if (!response.ok) {
                        const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? `HTTP ${response.status}` : "HTTP 状态未知";
                        throw archiveFailure(`${privateAsset ? "私有附件" : "附件"}下载失败（${status}）${[401, 403].includes(response.status) ? "，请确认来源店铺登录和文件权限" : ""}`);
                    }
                    const length = response.headers.get("content-length");
                    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_ASSET_BYTES || Number(length) > maxTotalBytes - totalRead)) throw archiveFailure("附件声明大小超过限制或无效");
                    if (!response.body || typeof response.body.getReader !== "function") throw archiveFailure("附件响应不支持受限流读取");
                    stream = response.body.getReader();
                    const chunks = [];
                    let size = 0;
                    while (true) {
                        const part = await stream.read();
                        if (controller.signal.aborted) throw archiveFailure("附件归档已取消");
                        if (part.done) break;
                        size += part.value.byteLength; totalRead += part.value.byteLength;
                        if (size > MAX_ASSET_BYTES || totalRead > maxTotalBytes) throw archiveFailure(maxTotalBytes === MAX_TOTAL_ASSET_BYTES
                            ? "附件流超过单件 10MiB 或累计 32MiB 限制" : "实拍图流超过单件或本次商品剩余归档预算");
                        chunks.push(part.value);
                    }
                    const bytes = new Uint8Array(size);
                    let offset = 0;
                    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
                    const mimeType = signatureMime(bytes);
                    const declared = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
                    if (!mimeType || declared && declared !== "application/octet-stream" && declared !== mimeType) throw archiveFailure("附件 MIME 与文件签名不匹配或类型不支持");
                    await context.assertCurrent();
                    if (controller.signal.aborted) throw archiveFailure("附件归档已取消");
                    return { url: sourceUrl, name: file.name, mimeType, sha256: sha256(bytes), bytes: size, dataBase64: encodeBase64(bytes) };
                };
                snapshot.assets.push(await Promise.race([download(), cancelled]));
            } catch (error) {
                if (error?.stopBatch) {
                    report("附件读取期间来源上下文已失效");
                    snapshot.archive.status = snapshot.assets.length ? "partial" : "failed";
                    throw error;
                }
                // 网络异常可能带完整签名 URL；只输出固定原因，绝不导出请求头、Cookie 或异常原文。
                const reason = String(error?.message || "");
                report(error?.archiveReason ? reason : privateAsset ? "私有附件网络读取失败或发生跳转，请在来源店铺检查文件是否可打开" : "附件网络读取失败");
            } finally {
                clearTimeout(timer);
                context.signal?.removeEventListener("abort", abortListener);
                controller.abort();
                if (stream) { void stream.cancel().catch(() => {}); }
                else if (response?.body) { void response.body.cancel().catch(() => {}); }
            }
        }
        if (files.length > maxAssets) errors.push({ url: "", name: "", reason: `附件超过 ${maxAssets} 件，未完整归档` });
        if (snapshot.status !== "complete") errors.push({ url: "", name: "", reason: "资质元数据未完整读取，附件范围不完整" });
        snapshot.archive.status = errors.length ? (snapshot.assets.length ? "partial" : "failed") : "complete";
    }

    /** 平台合规接口混用下划线与驼峰；只规范键名，冲突、原型键或不安全数字必须明确拒绝。 */
    function normalizeKeys(value, depth = 0) {
        if (depth > 80) throw new Error("资质响应嵌套过深，未截断保存");
        if (!value || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(item => normalizeKeys(item, depth + 1));
        const result = {};
        for (const [key, item] of Object.entries(value)) {
            const name = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            if (["__proto__", "constructor", "prototype"].includes(key) || ["__proto__", "constructor", "prototype"].includes(name) || Object.hasOwn(result, name)) throw new Error("资质字段结构冲突，未保存");
            result[name] = normalizeKeys(item, depth + 1);
        }
        return result;
    }

    /** 商品数字 ID 超出精确范围时不能转成字符串冒充可信标识。 */
    function productId(value) {
        if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("资质商品 ID 超出安全数字范围");
        const id = String(value ?? "").trim();
        if (!/^\d{6,20}$/.test(id)) throw new Error("资质商品 ID 无效");
        return id;
    }

    function failure(message, stopBatch = false) {
        return Object.assign(new Error(message), { stopBatch });
    }

    /** 只接受已核对的响应结构；权限与验证码错误不得被解释为“没有资质”。 */
    function responseRoot(payload) {
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw failure("资质接口返回结构未知");
        const raw = normalizeKeys(payload);
        const code = raw.errorCode ?? raw.error_code;
        if (raw.success === false || (code && Number(code) !== 1000000)) {
            const message = String(raw.errorMessage || raw.errorMsg || raw.error_message || "资质接口返回业务失败").slice(0, 300);
            const fatal = [40001, 54001, 403, 429].includes(Number(code)) || /登录|权限|验证|限流|captcha|unauthor|forbidden|429|403/i.test(message);
            throw failure(message, fatal);
        }
        return raw.result || raw.res || raw;
    }

    /** 资质清单、详情和附件属于同一次 SPU 快照；只有真实材料可归档，示例材料不冒充已上传文件。 */
    async function readSnapshot(client, context) {
        const id = productId(context.spuId);
        const snapshot = { schemaVersion: 1, productId: id, mallId: String(context.mallId), capturedAt: new Date().toISOString(), status: "failed", reason: "", items: [] };
        const deadline = Date.now() + 60000;
        let stopBatch = false;
        let stopReason = "";
        const request = async (url, input) => {
            if (Date.now() >= deadline) throw failure("单件资质读取超过时间预算，未宣称完整", true);
            await context.assertCurrent();
            const root = responseRoot(await context.post(url, input, Math.min(15000, deadline - Date.now())));
            await context.assertCurrent();
            if (new TextEncoder().encode(JSON.stringify(root)).byteLength > MAX_BYTES) throw failure("单次资质响应超过大小限制，未截断保存");
            return root;
        };
        try {
            const summaries = new Map();
            let expectedTotal = null;
            let rowsRead = 0;
            let listComplete = false;
            for (let page = 1; page <= MAX_PAGES; page++) {
                const root = await request(LIST_PATH, { page, page_size: 10, product_ids: [id] });
                if (root.ifSemiManaged !== false) throw failure("资质经营模式或响应结构未验证，未使用其他店铺模式查询");
                if (!Array.isArray(root.productWithCertList) || !Number.isSafeInteger(root.total) || root.total < 0) throw failure("资质列表缺少明确分页信息");
                if (expectedTotal !== null && root.total !== expectedTotal) throw failure("资质分页总数发生变化，本次未完整读取");
                expectedTotal = root.total;
                for (const row of root.productWithCertList) {
                    if (productId(row?.productBaseInfo?.productId) !== id) throw failure("资质列表返回了其他商品，已拒绝关联", true);
                    if (!Array.isArray(row.productCertInfoList)) throw failure("资质列表条目缺失，未解释为空");
                    for (const summary of row.productCertInfoList) {
                        const certType = Number(summary?.certType);
                        if (!Number.isSafeInteger(certType) || certType <= 0) throw failure("资质类型标识无效");
                        if (summaries.has(certType) && JSON.stringify(summaries.get(certType)) !== JSON.stringify(summary)) throw failure("同一资质类型返回冲突记录");
                        summaries.set(certType, summary);
                        if (summaries.size > MAX_CERTS) throw failure("资质条目超过安全上限，未截断保存");
                    }
                }
                rowsRead += root.productWithCertList.length;
                if (rowsRead > expectedTotal) throw failure("资质分页重复或总数不一致");
                if (rowsRead === expectedTotal) { listComplete = true; break; }
                if (!root.productWithCertList.length) throw failure("资质分页提前结束，未完整读取");
            }
            if (!listComplete) throw failure("资质分页超过安全上限，未完整读取");
            // 仅上传侧需要区分“清单完整但某项详情失败”，以便其它资质继续；采集全量结构不增加此控制字段。
            if (context.certTypes != null) snapshot.selectionComplete = true;
            // 上传预检只读取本次实际补传的类型；采集未指定筛选时仍读取完整清单，不能把筛选结果冒充采集全量。
            const requestedTypes = context.certTypes == null ? null : new Set(context.certTypes);
            if (requestedTypes && [...requestedTypes].some(type => !Number.isSafeInteger(type) || type <= 0)) throw failure("资质详情筛选类型无效");
            snapshot.items = [...summaries].filter(([certType]) => !requestedTypes || requestedTypes.has(certType))
                .map(([certType, summary]) => ({ certType, summary, detail: null, status: "failed", reason: "尚未读取资质详情" }));
            for (const item of snapshot.items) {
                const certType = item.certType;
                // 仅目标补传预检可依据已核验清单跳过已有项；来源采集仍读取全文，不能丢失已提交材料。
                if (context.certTypes != null && context.skipExistingDetails === true && [2, 4].includes(Number(item.summary.uploadStatus))) {
                    item.status = "complete";
                    item.reason = "目标已有已提交资质，未读取模板或附件";
                    continue;
                }
                try {
                    const root = await request(DETAIL_PATH, { product_id: id, cert_type: certType });
                    const detail = root.productCertInfo;
                    if (root.goodsInfoNotFound === true || !detail || typeof detail !== "object" || Array.isArray(detail)) throw failure("资质详情不存在或结构未知");
                    if (Number(detail.certType) !== certType) throw failure("资质详情类型不匹配，未保存", true);
                    if (detail.productId != null && productId(detail.productId) !== id) throw failure("资质详情商品不匹配，未保存", true);
                    item.detail = detail;
                    item.status = "complete";
                } catch (error) {
                    item.reason = String(error?.message || error).slice(0, 300);
                    if (error.stopBatch) throw error;
                }
            }
            snapshot.status = snapshot.items.every(item => item.status === "complete") ? "complete" : "partial";
            snapshot.reason = snapshot.items.filter(item => item.status !== "complete").map(item => `${item.certType}：${item.reason}`).join("；").slice(0, 1000);
        } catch (error) {
            snapshot.status = snapshot.items.length ? "partial" : "failed";
            snapshot.reason = String(error?.message || error).slice(0, 1000);
            stopBatch = error.stopBatch === true;
            stopReason = snapshot.reason;
        }
        // 累计大小也必须检查；失败标记可入库，超大正文不得伪装成完整资料。
        if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_BYTES) {
            snapshot.items = [];
            snapshot.status = "failed";
            snapshot.reason = "单件资质资料超过采集包安全大小，未保存正文";
        }
        try { await archiveAssets(snapshot, context, deadline); }
        catch (error) {
            snapshot.status = snapshot.items.length ? "partial" : "failed";
            snapshot.reason = String(error?.message || "附件归档失败").slice(0, 1000);
            stopBatch = error?.stopBatch === true;
            stopReason = stopBatch ? snapshot.reason : "";
        }
        snapshot.items = scrubMetadata(snapshot.items);
        if (metadataBytes(snapshot) > MAX_BYTES) {
            snapshot.items = []; snapshot.assets = [];
            snapshot.status = "failed";
            snapshot.reason = "单件资质资料超过采集包安全大小，未保存正文";
            snapshot.archive = { status: "failed", errors: [{ url: "", name: "", reason: snapshot.reason }] };
        }
        return { snapshot, stopBatch, stopReason };
    }
    /** 页面回执与仓库使用同一结构边界；状态仅代表读取结果，不能作为目标店资质审核凭证。 */
    function validateSnapshot(value, expectedSpu) {
        normalizeKeys(value);
        if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1
            || productId(value.productId) !== String(expectedSpu) || !String(value.mallId || "").trim()
            || !Number.isFinite(Date.parse(value.capturedAt)) || !["complete", "partial", "failed"].includes(value.status)
            || !Array.isArray(value.items) || value.items.length > MAX_CERTS) throw new Error("资质快照归属或结构无效");
        const seen = new Set();
        for (const item of value.items) {
            if (!Number.isSafeInteger(item?.certType) || item.certType <= 0 || seen.has(item.certType)
                || !["complete", "failed"].includes(item.status) || Number(item.summary?.certType) !== item.certType
                || item.status === "complete" && (!item.detail || Number(item.detail.certType) !== item.certType)
                || item.detail?.productId != null && productId(item.detail.productId) !== String(expectedSpu)) throw new Error("资质条目归属或结构无效");
            seen.add(item.certType);
        }
        if (value.status === "complete" && value.items.some(item => item.status !== "complete")) throw new Error("资质快照完整状态与条目不一致");
        if (metadataBytes(value) > MAX_BYTES) throw new Error("资质快照超过大小限制");
        validateArchive(value, () => filesFromDetails(value.items));
        return value;
    }

    /** 证书和独立实拍图共用字节校验；引用清单由各自采集器明确提供，不能递归把示例图片算成材料。 */
    function validateArchive(value, readFiles, maxAssets = MAX_ASSETS) {
        // 旧快照仍可读取；新快照必须同时带归档状态和正文清单，不允许通过只声明字节数逃逸预算。
        if (value.assets !== undefined || value.archive !== undefined) {
            if (!Array.isArray(value.assets) || value.assets.length > maxAssets || !value.archive
                || !["metadata-only", "complete", "partial", "failed"].includes(value.archive.status)
                || !Array.isArray(value.archive.errors) || value.archive.errors.length > maxAssets + 2) throw new Error("附件归档结构无效");
            const files = value.archive.status === "metadata-only" ? [] : readFiles();
            const sources = new Set(files.map(file => publicAssetUrl(file.url)).filter(Boolean));
            const urls = new Set();
            let total = 0;
            for (const asset of value.assets) {
                if (!asset || !asset.url || publicAssetUrl(asset.url) !== asset.url || !sources.has(asset.url) || urls.has(asset.url)
                    || typeof asset.name !== "string" || asset.name.length > 240 || !/^[a-f0-9]{64}$/.test(asset.sha256 || "")
                    || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAX_ASSET_BYTES
                    || typeof asset.dataBase64 !== "string" || asset.dataBase64.length !== Math.ceil(asset.bytes / 3) * 4
                    || /[^A-Za-z0-9+/=]/.test(asset.dataBase64)) throw new Error("附件正文或归属无效");
                total += asset.bytes;
                if (total > MAX_TOTAL_ASSET_BYTES) throw new Error("附件累计超过 32MiB 限制");
                let binary;
                try { binary = atob(asset.dataBase64); } catch { throw new Error("附件 Base64 编码无效"); }
                const bytes = new Uint8Array(binary.length);
                for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
                if (bytes.length !== asset.bytes || encodeBase64(bytes) !== asset.dataBase64 || signatureMime(bytes) !== asset.mimeType || !asset.mimeType
                    || sha256(bytes) !== asset.sha256) throw new Error("附件 SHA-256 或 MIME 签名校验失败");
                urls.add(asset.url);
            }
            for (const error of value.archive.errors) {
                if (!error || typeof error.url !== "string" || error.url && publicAssetUrl(error.url) !== error.url
                    || typeof error.name !== "string" || error.name.length > 240 || typeof error.reason !== "string" || !error.reason || error.reason.length > 180) throw new Error("附件归档错误结构无效");
            }
            const status = value.archive.status, hasErrors = value.archive.errors.length > 0;
            if (status === "metadata-only" && (value.assets.length || hasErrors)
                || status === "complete" && (hasErrors || value.status !== "complete" || files.length > maxAssets || files.some(file => !file.url) || sources.size !== urls.size)
                || status === "partial" && (!hasErrors || !value.assets.length)
                || status === "failed" && (!hasErrors || value.assets.length)) throw new Error("附件归档状态与正文不一致");
        }
        return value;
    }
    const api = { readSnapshot, normalizeKeys, validateSnapshot, productId, LIST_PATH, DETAIL_PATH,
        archiveAssets, validateArchive, assetUrl, publicAssetUrl, scrubMetadata, metadataBytes };
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    return api;
})();
