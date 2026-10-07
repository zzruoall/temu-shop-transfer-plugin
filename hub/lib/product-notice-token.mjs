/** 异常通知凭证只证明来源与接收实例的授权，不记录投递任务，也不证明平台创建结果。 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function createProductNoticeTokens(root, { now = Date.now, ttlMs = 6 * 60 * 60 * 1000 } = {}) {
    const file = path.join(root, 'product-notice-signing-key');
    await mkdir(root, { recursive: true });
    let secret;
    try { secret = (await readFile(file, 'utf8')).trim(); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        secret = randomBytes(32).toString('hex');
        try { await writeFile(file, secret, { flag: 'wx', mode: 0o600 }); }
        catch (race) { if (race.code !== 'EEXIST') throw race; secret = (await readFile(file, 'utf8')).trim(); }
    }
    if (!/^[a-f0-9]{64}$/.test(secret)) throw Error('商品异常通知签名密钥损坏');
    const signature = data => createHmac('sha256', secret).update(`product-error-v2:${data}`).digest();
    return {
        issue(input) {
            const data = Buffer.from(JSON.stringify({ ...input, protocol: 2, expiresAt: now() + ttlMs })).toString('base64url');
            if (data.length > 6000) throw Error('商品异常通知授权过大');
            return `${data}.${signature(data).toString('base64url')}`;
        },
        verify(token) {
            const denied = () => Object.assign(Error('error_notice_authorization_invalid'), { status: 403 });
            if (typeof token !== 'string' || token.length > 6500 || !/^[\w-]+\.[\w-]+$/.test(token)) throw denied();
            const [data, mac] = token.split('.'), supplied = Buffer.from(mac, 'base64url'), expected = signature(data);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw denied();
            let input;
            try { input = JSON.parse(Buffer.from(data, 'base64url').toString('utf8')); } catch { throw denied(); }
            if (!input || input.protocol !== 2 || !Number.isFinite(input.expiresAt) || input.expiresAt <= now()
                || input.expiresAt > now() + ttlMs || !input.sourceInstanceId || !input.sourceVersion
                || !input.sourceStoreId || !input.spuId || !input.pluginInstanceId || !input.targetStoreId) throw denied();
            return input;
        }
    };
}

/** 内部字段错误码沿用原协议；平台数字码需额外核验提交阶段和已确认的错误原因。 */
export const PRODUCT_DATA_ERROR_CODES = new Set(['PRODUCT_FIELD_INVALID', 'PRODUCT_SKU_INVALID',
    'PRODUCT_IMAGE_INVALID', 'PRODUCT_DATA_INVALID']);

/** 服务端独立核对两类已核实的字段拒绝，不能仅信任插件自报的 product_data 分类。 */
function verifiedPlatformDataError(body) {
    if (body.errorStage !== '提交') return false;
    return (body.errorCode === '2000135' && /净含量[^\n]{0,80}必填/.test(body.reason))
        || (body.errorCode === '2000225' && /化妆品成分不存在/.test(body.reason));
}

export function parseProductErrorNotice(body) {
    const bad = () => Object.assign(Error('error_notice_body_invalid'), { status: 400 });
    const fields = new Set(['pluginInstanceId', 'noticeToken', 'eventId', 'errorScope', 'errorCode',
        'errorStage', 'reason', 'productCodes', 'offendingSkuCode', 'reasonTruncated']);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.has(key))) throw bad();
    const limits = { pluginInstanceId: 255, noticeToken: 6500, eventId: 80, errorCode: 80, errorStage: 80,
        reason: 2000, offendingSkuCode: 255 };
    for (const [key, max] of Object.entries(limits)) {
        if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > max)) throw bad();
    }
    if (!body.pluginInstanceId || !body.noticeToken || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.eventId || '')
        || !String(body.reason || '').trim() || !['product_data', 'shop_context', 'transport', 'unknown'].includes(body.errorScope)) throw bad();
    if (body.productCodes !== undefined && (!Array.isArray(body.productCodes) || body.productCodes.length > 32
        || body.productCodes.some(code => typeof code !== 'string' || code.length > 255))) throw bad();
    if (body.reasonTruncated !== undefined && typeof body.reasonTruncated !== 'boolean') throw bad();
    return { code: body.errorCode || '', stage: body.errorStage || '', reason: body.reason.trim().slice(0, 1000),
        skuCode: body.offendingSkuCode || '', truncated: Boolean(body.reasonTruncated || body.reason.length > 1000),
        mark: body.errorScope === 'product_data' && (PRODUCT_DATA_ERROR_CODES.has(body.errorCode) || verifiedPlatformDataError(body)) };
}
