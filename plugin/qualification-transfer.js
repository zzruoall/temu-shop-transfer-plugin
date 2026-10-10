/** 资质决策只属于目标店插件；相同材料不覆盖审核中记录，店铺声明不能跨主体自动签署。 */
var TemuQualificationTransfer = (() => {
    'use strict';
    const arrays = value => Array.isArray(value) ? value : [];
    const fail = message => { throw Error(message); };
    const fields = ['productCertFiles', 'inspectReportFiles', 'supplementaryMaterials', 'multiLangProductCertFileMap',
        'multiLangInspectReportMap', 'uploadedContents', 'groupUploadedContents', 'selectedCheckItems', 'refPidList',
        'authCode', 'authCodes', 'model', 'brand'];
    /** 模板仅参与兼容核对，绝不当成填写内容；一致性不足时留下本店异常，不猜测必填值。 */
    function requestFor(source, target, productId, uploaded) {
        if (!source || source.status !== 'complete' || !source.content) fail('来源资质未完整采集，请重新采集');
        const body = source.content;
        const requirements = arrays(target.certNeedUpload?.certNeedUploadItems);
        if (!requirements.length) fail('目标资质模板未确认，未提交');
        if (/Small\s*Business|小微企业|企业声明|店铺主体/i.test(`${source.name || ''} ${source.displayName || ''}`)) fail('此资质属于店铺主体声明，需要在目标店人工确认');
        const types = requirements.map(item => Number(item.contentType));
        if (types.some(type => ![1, 2, 3, 5, 7, 9].includes(type)) || Number(body.fileUploadType) === 2
            || body.docPdfContentReq || body.productDangerousIngredients || body.energyLabel || target.needAgreement === true
            || target.needConfirm === true) fail('此资质包含尚未验证的生成、声明或特殊模板，需要人工处理');
        const sourceRequirements = arrays(body.certNeedUpload?.certNeedUploadItems);
        // 字段 ID 来自平台模板；只接受两端相同定义，不能把来源选项编号强套到另一模板。
        const templateShape = items => items.map(item => ({ contentType: item.contentType, templateId: item.templateId,
            useMultiTemplate: item.useMultiTemplate, templateConfigList: item.templateConfigList,
            needUploadSubItems: item.needUploadSubItems, certCheckItems: item.certCheckItems,
            supportMultiLanguage: item.supportMultiLanguage, needChooseCheckItems: item.needChooseCheckItems }));
        const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
        if (JSON.stringify(stable(templateShape(sourceRequirements))) !== JSON.stringify(stable(templateShape(requirements)))) fail('来源和目标资质模板不同，未套用来源字段');
        const sourceLanguages = arrays(body.needUploadLanguages), targetLanguages = arrays(target.needUploadLanguages);
        if (targetLanguages.some(language => !sourceLanguages.includes(language))) fail('目标店需要其他语言材料，来源未提供');
        const references = new Map(arrays(source.files).map(file => [file.url, file]));
        let materialCount = 0;
        const replace = (node, depth = 0) => {
            if (depth > 40) fail('资质内容嵌套过深');
            if (typeof node === 'string' && /^https?:\/\//i.test(node)) {
                const file = references.get(node), url = file?.asset && uploaded.get(file.asset.sha256);
                if (!url) fail('资质材料未归档或未上传到目标店');
                materialCount++; return url.split('?')[0];
            }
            if (!node || typeof node !== 'object') return node;
            if (Array.isArray(node)) return node.map(child => replace(child, depth + 1));
            return Object.fromEntries(Object.entries(node).filter(([key]) => !['originFileUrl', 'expirationStatus', 'endDateOfResponsibility', 'imageId', 'uploadTime'].includes(key))
                .map(([key, child]) => [key, replace(child, depth + 1)]));
        };
        const cert = { certType: source.certType, fileUploadType: 1 };
        for (const field of fields) if (body[field] !== undefined) cert[field === 'multiLangInspectReportMap' ? 'multiLangInspectReportFileMap' : field] = replace(body[field]);
        for (const type of types) {
            const field = { 1: 'productCertFiles', 2: 'inspectReportFiles', 7: 'supplementaryMaterials', 9: 'uploadedContents' }[type];
            if (field && !arrays(body[field]).length && !(type === 1 && body.multiLangProductCertFileMap)
                && !(type === 2 && body.multiLangInspectReportMap) && !(type === 9 && arrays(body.groupUploadedContents).length)
                && type !== 7) fail(`来源缺少目标要求的资质内容（类型 ${type}）`);
            if (type === 3 && !body.authCode && !arrays(body.authCodes).length) fail('来源缺少资质编号');
            if (type === 5 && !body.selectedCheckItems) fail('来源缺少资质适用选项');
        }
        if (!materialCount && !body.authCode && !arrays(body.authCodes).length && !arrays(body.uploadedContents).length && !arrays(body.groupUploadedContents).length) fail('来源没有可提交的资质材料或填写内容');
        return { productId: String(productId), ...(arrays(body.realPictures).length ? { realPictures: replace(body.realPictures) } : {}), productCatCertReqList: [cert] };
    }
    /** 审核中和通过的材料不重传；驳回或未知不能解释为缺失，避免覆盖正在审核的材料。 */
    function decision(summary) {
        const status = Number(summary?.uploadStatus);
        if ([2, 4].includes(status)) return 'existing';
        if (status === 1) return 'missing';
        if ([3, 5].includes(status)) return 'rejected';
        return 'unknown';
    }
    const api = { requestFor, decision };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return api;
})();
