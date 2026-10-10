/** 商品资质属于来源店和原始 SPU 的静态采集资料，不参与目标店创建、红标或审核判定。 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertCapturedSource, transferHash } from './transfer-integrity.mjs';
const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
const array = value => Array.isArray(value) ? value : [];
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 32 * 1024 * 1024;

/** 原始包是唯一字节归档；投影和任务只保留引用，兼容旧包时也不能泄露嵌套正文。 */
export function qualificationReferences(value) {
    if (Array.isArray(value)) return value.map(qualificationReferences);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'dataBase64')
        .map(([key, child]) => [key, qualificationReferences(child)]));
    if (Array.isArray(result.files)) result.files = result.files.map(file => ({ ...file,
        archiveStatus: file.asset?.sha256 ? 'archived' : 'not_archived' }));
    if (Array.isArray(result.items) && result.schemaVersion === 1 && !result.archiveStatus) result.archiveStatus = 'not_archived';
    return result;
}

/** 校验客户端字节声明和规范编码，先限制编码长度，避免伪造 bytes 绕过内存上限。 */
function decodeAsset(asset) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)
        || Object.keys(asset).some(key => !['url', 'name', 'mimeType', 'sha256', 'bytes', 'dataBase64'].includes(key))
        || typeof asset.url !== 'string' || !qualificationFileUrl(asset.url) || qualificationFileUrl(asset.url) !== asset.url
        || typeof asset.name !== 'string' || !asset.name.trim()
        || typeof asset.mimeType !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(asset.mimeType)
        || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
        || !Number.isSafeInteger(asset.bytes) || asset.bytes <= 0 || asset.bytes > MAX_ASSET_BYTES
        || typeof asset.dataBase64 !== 'string' || asset.dataBase64.length !== 4 * Math.ceil(asset.bytes / 3)
        || /[^A-Za-z0-9+/=]/.test(asset.dataBase64)) throw new Error('资质附件结构、大小或 base64 编码无效');
    const data = Buffer.from(asset.dataBase64, 'base64');
    if (data.length !== asset.bytes || data.toString('base64') !== asset.dataBase64
        || createHash('sha256').update(data).digest('hex') !== asset.sha256) throw new Error('资质附件 bytes、hash 或 canonical base64 不一致');
    // MIME 是不可信采集字段；文件魔数独立核对，HTML 或脚本不能借 PDF 声明开放下载。
    const starts = value => data.subarray(0, value.length).equals(Buffer.from(value));
    const mime = starts([37, 80, 68, 70, 45]) ? 'application/pdf' : starts([137, 80, 78, 71, 13, 10, 26, 10]) ? 'image/png'
        : starts([255, 216, 255]) ? 'image/jpeg' : starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]) ? 'image/gif'
        : starts([82, 73, 70, 70]) && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : '';
    if (!mime || mime !== asset.mimeType) throw Error('资质附件 MIME 与实际文件签名不一致');
    return data;
}

/** 服务端独立验证不可信采集包，部署只需 hub 文件，不依赖浏览器插件源码或其安装状态。 */
function validateSnapshot(value, expectedSpu) {
    const validId = id => (typeof id === 'string' || typeof id === 'number' && Number.isSafeInteger(id)) && /^\d{6,20}$/.test(String(id));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
        || !validId(value.productId) || String(value.productId) !== expectedSpu || !text(value.mallId)
        || !Number.isFinite(Date.parse(value.capturedAt)) || !['complete', 'partial', 'failed'].includes(value.status)
        || !Array.isArray(value.items) || value.items.length > 200) throw new Error('资质快照归属或结构无效');
    // 入库防止键名规范化后互相覆盖，禁止原型字段、混合键名冲突和无限嵌套。
    const scan = (node, depth = 0) => {
        if (depth > 80) throw new Error('资质字段结构过深');
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) { node.forEach(item => scan(item, depth + 1)); return; }
        const names = new Set();
        for (const [key, child] of Object.entries(node)) {
            const name = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            if (['__proto__', 'constructor', 'prototype'].includes(key) || ['__proto__', 'constructor', 'prototype'].includes(name) || names.has(name)) throw new Error('资质字段结构冲突');
            names.add(name);
            scan(child, depth + 1);
        }
    };
    scan(value);
    // 除顶层 assets 外禁止夹带字节；8 MiB 仍约束元数据，而不是把合法附件算成元数据超限。
    const { assets, ...metadata } = value;
    const checkMetadata = node => {
        if (!node || typeof node !== 'object') return;
        if (Object.hasOwn(node, 'dataBase64')) throw new Error('资质字节只能存放在 assets');
        Object.values(node).forEach(checkMetadata);
    };
    checkMetadata(metadata);
    if (assets !== undefined && !Array.isArray(assets)) throw new Error('资质 assets 必须是数组');
    if (array(assets).length > 40) throw new Error('资质附件超过40件限制');
    const assetUrls = new Set();
    let totalBytes = 0;
    for (const asset of array(assets)) {
        totalBytes += asset?.bytes || 0;
        if (totalBytes > MAX_TOTAL_ASSET_BYTES) throw new Error('资质附件超过32MiB合计限制');
        decodeAsset(asset);
        if (assetUrls.has(asset.url)) throw new Error('资质附件引用重复');
        assetUrls.add(asset.url);
    }
    if (Buffer.byteLength(JSON.stringify({ ...metadata, ...(assets === undefined ? {} : { assets: assets.map(({ dataBase64, ...ref }) => ref) }) })) > 8 * 1024 * 1024) throw new Error('资质快照元数据超过大小限制');
    const seen = new Set();
    for (const item of value.items) {
        if (!Number.isSafeInteger(item?.certType) || item.certType <= 0 || seen.has(item.certType)
            || !['complete', 'failed'].includes(item.status) || Number(item.summary?.certType) !== item.certType
            || item.status === 'complete' && (!item.detail || Number(item.detail.certType) !== item.certType)
            || item.detail?.productId != null && (!validId(item.detail.productId) || String(item.detail.productId) !== expectedSpu)) throw new Error('资质条目归属或结构无效');
        seen.add(item.certType);
    }
    if (value.status === 'complete' && value.items.some(item => item.status !== 'complete')) throw new Error('资质快照完整状态与条目不一致');
    const references = new Set(value.items.flatMap(item => filesFromDetail(item.detail).map(file => file.url)).filter(Boolean));
    if ([...assetUrls].some(url => !references.has(url))) throw new Error('资质附件与已上传材料引用不对应');
    return value;
}

/** 展示摘要只保留文本；原始填写结构另存 content，来源 HTML 不能变成可执行网页内容。 */
function plain(value) {
    return text(value).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<[^>]*>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' }[entity]))
        .replace(/\s+/g, ' ').trim();
}

/** 来源引用只允许平台 HTTPS 地址；归档读取仅使用原始包，不代理主机或附带店铺凭证。 */
export function qualificationFileUrl(value) {
    try {
        const url = new URL(text(value));
        const allowed = ['kwcdn.com', 'temu.com', 'kuajingmaihuo.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
        return url.protocol === 'https:' && !url.username && !url.password && !url.port && allowed ? url.href : '';
    } catch { return ''; }
}

/** 只在实际已上传材料容器内提取文件；资质要求、示例图片和历史附件不能混成当前商品的文件。 */
function filesFromDetail(detail) {
    const files = [], seen = new Set();
    const visit = (value, role, language = '', depth = 0) => {
        if (depth > 40) throw new Error('资质附件结构过深，未截断保存');
        if (Array.isArray(value)) { value.forEach(item => visit(item, role, language, depth + 1)); return; }
        if (typeof value === 'string') {
            const url = qualificationFileUrl(value);
            if (url || /^https?:\/\//i.test(value)) add(url, '', role, language, value);
            return;
        }
        if (!value || typeof value !== 'object') return;
        const rawUrl = text(value.fileUrl || value.imageUrl || value.originalFileUrl || value.url);
        const ownUrl = qualificationFileUrl(rawUrl);
        if (rawUrl) add(ownUrl, text(value.fileName || value.name), role, text(value.language || value.lang || language), rawUrl);
        // 已上传内容可携带多语言嵌套文件，只读该容器，绝不递归商品/要求模板的其他分支。
        for (const [key, child] of Object.entries(value)) {
            if (['fileUrl', 'imageUrl', 'originalFileUrl', 'url', 'fileName', 'name'].includes(key) || /example|template|history/i.test(key)) continue;
            if (child && typeof child === 'object') visit(child, role, /^[a-z]{2}(?:-[A-Za-z]+)?$/.test(key) ? key : language, depth + 1);
        }
    };
    const add = (url, name, role, language, rawUrl = url) => {
        const key = JSON.stringify([role, language, rawUrl]);
        if (seen.has(key)) return;
        seen.add(key);
        // 非可信地址仍保留附件名称和不可打开事实，不能把已上传但无法读取的附件误报成“没有文件”。
        files.push({ role, name: name || '资质附件', url, language, ...(url ? {} : { reason: '附件地址不是已验证的平台 HTTPS 地址，未开放链接' }) });
    };
    for (const [key, role] of Object.entries({ productCertFiles: '资质文件', inspectReportFiles: '检测报告',
        multiLangProductCertFileMap: '资质文件', multiLangInspectReportMap: '检测报告', realPictures: '资质实拍图',
        energyLabelFiles: '能效标签', supplementaryMaterials: '补充材料', uploadedContents: '已上传材料', groupUploadedContents: '已上传材料' })) {
        visit(detail?.[key], role);
    }
    return files;
}

/** 独立资质响应必须同时匹配记录归属与正文 SPU，禁止复用通用递归图片/商品解析。 */
export function parseQualificationRecord(record) {
    if (record?.dataType !== 'product-qualifications') return null;
    const url = new URL(record.source?.requestUrl || '', 'https://invalid.invalid');
    if (url.origin !== 'https://agentseller.temu.com' || url.pathname !== '/mms/arbok/product_cert/query/list'
        || record.payload?.success !== true) throw new Error('资质采集来源无效');
    const spuId = text(record.source?.pageProductId || record.payload?.result?.productId);
    if (record.identity?.productIds?.length !== 1 || text(record.identity.productIds[0]) !== spuId) throw new Error('资质记录商品归属不一致');
    const snapshot = validateSnapshot(record.payload.result, spuId);
    const assets = new Map(array(snapshot.assets).map(({ dataBase64, ...ref }) => [ref.url, ref]));
    // 归档失败原因仅关联本次快照对应附件；正文已归档时不展示旧失败，不能影响其他商品或店铺。
    const archiveErrors = new Map(array(snapshot.archive?.errors).map(error => [text(error?.url), text(error?.reason).slice(0, 180)]));
    const items = snapshot.items.map(item => {
        const summary = item.summary, detail = item.detail || {};
        const sites = new Map();
        array(summary.allowSiteList).forEach(id => sites.set(text(id), { id: text(id), name: '' }));
        const effects = [...array(summary.siteCertSaleEffects), ...array(summary.stateCertSaleEffects)];
        effects.forEach(effect => array(effect.sites).forEach(site => {
            const id = text(site.siteId);
            if (id) sites.set(id, { id, name: plain(site.siteName) });
        }));
        const requirements = [detail.desc, detail.certNeedUpload?.instruction];
        for (const need of array(detail.certNeedUpload?.certNeedUploadItems)) {
            requirements.push(need.desc, need.uploadContentDesc, need.newUploadExample?.uploadRequire);
        }
        for (const effect of effects) {
            requirements.push(effect.noCheckItemsContent);
            for (const check of [...array(effect.showCheckItems), ...array(effect.requiredCheckItems), ...array(effect.strongCheckItems)]) {
                requirements.push(...array(check.vidList).map(value => value.vname || value.nameLang?.zh || value.nameLang?.['zh-Hans']));
            }
        }
        return { certType: item.certType, name: plain(summary.certName || detail.certName), displayName: plain(summary.showName || detail.showName),
            uploadStatus: summary.uploadStatus ?? null, auditStatus: summary.auditStatus ?? null, status: item.status, reason: text(item.reason),
            sites: [...sites.values()], requirements: [...new Set(requirements.map(plain).filter(Boolean))],
            saleEffects: [...new Set([summary.rejectReason, detail.rejectReason, ...effects.map(effect => effect.saleEffectShowText)].map(plain).filter(Boolean))],
            files: filesFromDetail(detail).map(file => ({ ...file, archiveStatus: assets.has(file.url) ? 'archived' : 'not_archived',
                ...(assets.has(file.url) ? { asset: { ...assets.get(file.url) } }
                    : archiveErrors.get(file.url) ? { reason: archiveErrors.get(file.url) } : {}) })), content: item.detail ? structuredClone(detail) : null };
    });
    return { spuId, qualifications: { schemaVersion: 1, spuId, mallId: text(snapshot.mallId), capturedAt: snapshot.capturedAt,
        status: snapshot.status, reason: text(snapshot.reason), archiveStatus: snapshot.assets === undefined || snapshot.archive?.status === 'metadata-only' ? 'not_archived'
            : snapshot.archive?.status === 'failed' || snapshot.archive?.status === 'partial'
                || items.some(item => item.files.some(file => file.archiveStatus !== 'archived')) ? 'partial' : 'complete', items }, sources: ['product-qualifications'] };
}

/** 只读取仍属于该商品和来源店的原包，不能用哈希猜测其他商品、示例图或已删除批次的文件。 */
export async function readQualificationAsset(store, { spuId, sha256, sourceStoreId, scope = null }) {
    const view = await store.getProduct(spuId, scope, sourceStoreId);
    if (!view || !array(view.product.sourceStoreIds).includes(sourceStoreId)) return null;
    const captures = array(view.product.qualificationCaptures).length ? view.product.qualificationCaptures
        : view.product.qualifications ? [{ ...view.product.qualifications, sourceStoreId }] : [];
    const referenced = captures.some(capture => String(capture.spuId) === spuId && capture.sourceStoreId === sourceStoreId
        && array(capture.items).some(item => array(item.files).some(file => file.asset?.sha256 === sha256)));
    if (!referenced) return null;
    for (const linked of array(view.batches)) {
        if (!array(view.product.batchIds).includes(linked.id)) continue;
        const batch = await store.getBatch(linked.id);
        if (!batch || batch.sourceStoreId !== sourceStoreId || !array(batch.products).some(product => String(product.spuId) === spuId)) continue;
        for (const file of array(batch.files)) {
            if (!file.storedName || /[/\\]/.test(file.storedName)) continue;
            let raw;
            try {
                if (store.filesDir) {
                    // 下载也核验原包证据，不能只检查攻击者可一并修改的附件摘要和索引关联。
                    const full = path.join(store.filesDir, file.storedName);
                    if ((await stat(full)).size > 64 * 1024 * 1024) throw Error('资质原包超过读取预算');
                    const bytes = await readFile(full);
                    if (file.fileSha256 && (bytes.length !== Number(file.fileBytes)
                        || createHash('sha256').update(bytes).digest('hex') !== file.fileSha256)) throw Error('资质原包字节校验失败');
                    raw = JSON.parse(bytes.toString('utf8'));
                    if (file.contentSha256 && transferHash(raw) !== file.contentSha256) throw Error('资质原包内容校验失败');
                } else raw = (await store.readStoredFile(file.storedName)).json;
            }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            if (raw.source?.sourceStoreId && raw.source.sourceStoreId !== sourceStoreId) continue;
            if (Array.isArray(raw.source?.allowedSpuIds) && !raw.source.allowedSpuIds.map(String).includes(spuId)) continue;
            for (const record of array(raw.records).concat(raw.record || (raw.dataType ? raw : []))) {
                if (record?.dataType !== 'product-qualifications' || String(record.payload?.result?.productId) !== spuId) continue;
                const parsed = parseQualificationRecord(record);
                if (!parsed.qualifications.items.some(item => item.files.some(file => file.asset?.sha256 === sha256))) continue;
                const asset = array(record.payload.result.assets).find(asset => asset.sha256 === sha256);
                if (asset) {
                    // 读取后复核关联，删除期间已取到的正文也不能继续作为有效归档投递。
                    const current = await store.getProduct(spuId, scope, sourceStoreId), active = await store.getBatch(batch.id);
                    if (!current?.product.batchIds?.includes(batch.id) || active?.sourceStoreId !== sourceStoreId
                        || !array(active?.products).some(product => String(product.spuId) === spuId)) return null;
                    return { ...qualificationReferences(asset), data: decodeAsset(asset) };
                }
            }
        }
    }
    return null;
}

/**
 * 归档包的 base64 会超过普通响应流式工作集；按现有入库总包上限重建并核验，不降低文件证据校验。
 * 普通商品仍用原仓库核验器，归档商品另外核对资质投影，避免索引正文与附件引用错配。
 */
export async function verifyQualificationBatchTransfer(store, batch, products, options = {}) {
    const archived = products.some(product => array(product.qualifications?.items)
        .some(item => array(item.files).some(file => file.asset?.sha256)));
    if (!archived) return store.verifyBatchTransfer(batch, products, options);
    // 延迟加载既有解析器以复用商品重建规则，避免资质模块初始化时与解析器形成循环依赖。
    const { parseImportedFiles } = await import('./parse-capture.mjs');
    const invalid = message => Object.assign(Error(message), { status: 422 });
    const inputs = [];
    let bytes = 0;
    for (const file of array(batch.files)) {
        if (!file.storedName || path.basename(file.storedName) !== file.storedName) throw invalid('来源原文件引用不合法');
        const full = path.join(store.filesDir, file.storedName);
        bytes += (await stat(full)).size;
        if (bytes > 64 * 1024 * 1024) throw Object.assign(Error('资质来源原包超过64MiB读取预算'), { status: 413 });
        const data = await readFile(full);
        if (data.length > 64 * 1024 * 1024 || file.fileSha256 && (data.length !== Number(file.fileBytes)
            || createHash('sha256').update(data).digest('hex') !== file.fileSha256)) throw invalid('来源原始文件字节校验失败');
        const payload = JSON.parse(data.toString('utf8'));
        if (file.contentSha256 && transferHash(payload) !== file.contentSha256) throw invalid('来源原始文件校验失败，内容已发生变化');
        if (payload.source?.sourceStoreId && String(payload.source.sourceStoreId) !== String(batch.sourceStoreId)) throw invalid('原包与批次的来源店铺不一致');
        inputs.push({ originalName: file.originalName, payload });
    }
    if (!inputs.length) throw invalid('来源批次缺少原始采集文件');
    const parsed = parseImportedFiles(inputs);
    if (parsed.sourceStoreId && parsed.sourceStoreId !== batch.sourceStoreId) throw invalid('原包与批次的来源店铺不一致');
    const captured = new Map(parsed.products.map(product => [String(product.spuId), product]));
    const verified = [], errors = [];
    for (const product of products) {
        try {
            const original = captured.get(String(product.spuId));
            if (!original) throw invalid(`SPU ${product.spuId} 不在来源原包中`);
            assertCapturedSource(original);
            if (Number(product.publicationData?.schemaVersion || 0) < 2) {
                if (product.publicationData?.sourceProduct) assertCapturedSource(product);
                verified.push({ ...original, publicationData: { ...original.publicationData, restoredFromOriginal: true } });
                continue;
            }
            if (transferHash(assertCapturedSource(original)) !== transferHash(assertCapturedSource(product))
                || transferHash(original.qualifications || null) !== transferHash(qualificationReferences(product.qualifications) || null)) {
                throw invalid(`SPU ${product.spuId} 的下发资料或资质引用与来源原包不一致，请重新采集`);
            }
            verified.push(product);
        } catch (error) {
            if (!options.collectErrors || error.status !== 422) throw error;
            errors.push({ spuId: String(product.spuId), reason: error.message });
        }
    }
    return options.collectErrors ? { products: verified, errors } : verified;
}

/** 相同资料重采可以复用；读取状态、附件或填写内容变化必须进入新批次，不能被 SKU 去重吞掉。 */
export function qualificationContentHash(value) {
    if (!value) return '';
    const { capturedAt, lastAttempt, ...content } = value;
    return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** 同来源同 SPU 成功快照整体替换；失败重采保留最近完整资料并另记失败，不能把历史成功变成空。 */
export function mergeQualificationCapture(current, incoming) {
    if (!current) return structuredClone(incoming);
    const incomingTime = Date.parse(incoming.capturedAt);
    const currentTime = Date.parse(current.capturedAt);
    if (incoming.status !== 'complete' && current.status === 'complete') {
        if (incomingTime < Date.parse(current.lastAttempt?.capturedAt || current.capturedAt)) return current;
        return { ...current, lastAttempt: { capturedAt: incoming.capturedAt, status: incoming.status, reason: incoming.reason || '本次未完整读取' } };
    }
    // 索引通常按新批次在前遍历；先遇到失败再遇到旧成功，也必须恢复成功资料并保留最新失败事实。
    if (incoming.status === 'complete' && current.status !== 'complete' && currentTime > incomingTime) {
        return { ...structuredClone(incoming), lastAttempt: { capturedAt: current.capturedAt, status: current.status, reason: current.reason || '本次未完整读取' } };
    }
    if (incomingTime < currentTime) return current;
    if (incoming.status === 'complete' && current.lastAttempt && Date.parse(current.lastAttempt.capturedAt) > incomingTime) {
        return { ...structuredClone(incoming), lastAttempt: current.lastAttempt };
    }
    return structuredClone(incoming);
}
