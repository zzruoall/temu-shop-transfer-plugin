/** 资质决策只属于目标店插件；相同材料不覆盖审核中记录，店铺声明不能跨主体自动签署。 */
var TemuQualificationTransfer = (() => {
    'use strict';
    const arrays = value => Array.isArray(value) ? value : [];
    const fail = message => { throw Error(message); };
    const fields = ['productCertFiles', 'inspectReportFiles', 'supplementaryMaterials', 'multiLangProductCertFileMap',
        'multiLangInspectReportMap', 'uploadedContents', 'groupUploadedContents', 'selectedCheckItems', 'refPidList',
        'authCode', 'authCodes', 'model', 'brand'];
    /** 平台未启用的特殊分支可能返回空对象或空数组，不能把容器存在误当成已填写特殊内容。 */
    const hasContent = value => value !== null && value !== undefined && value !== '' && value !== false && value !== 0
        && (typeof value !== 'object' || Object.keys(value).length > 0);
    /** 判断来源是否实际填写此项；商品共用照片不能冒充每一种证书，已提交但材料丢失仍须报错。 */
    function sourceHasContent(source) {
        if (!source || source.status !== 'complete' || !source.content) return Boolean(source);
        const body = source.content;
        const filled = (value, depth = 0) => {
            if (depth > 40) fail('来源资质填写内容嵌套过深');
            if (typeof value === 'string') return value.trim().length > 0;
            if (!value || typeof value !== 'object') return hasContent(value);
            return Object.values(value).some(child => filled(child, depth + 1));
        };
        const ownFields = ['productCertFiles', 'inspectReportFiles', 'multiLangProductCertFileMap', 'multiLangInspectReportMap',
            'supplementaryMaterials', 'uploadedContents', 'groupUploadedContents', 'authCode', 'authCodes', 'selectedCheckItems',
            'docPdfContentReq', 'productDangerousIngredients', 'energyLabel', 'energyLabelFiles', 'eprelId'];
        if (ownFields.some(field => filled(body[field]))) return true;
        const requirements = arrays(body.certNeedUpload?.certNeedUploadItems);
        // 历史纯照片项目即便标注已提交，也不应被当成证书丢失报错；照片状态由独立实拍图阶段核对。
        if (requirements.some(item => Number(item.contentType) === 4) && requirements.every(item => Number(item.contentType) === 4
            || Number(item.contentType) === 5 && item.needChooseCheckItems === false)) return false;
        if ([2, 3, 4, 5].includes(Number(source.uploadStatus))) return true;
        // 商品实拍图已有独立入口，旧详情里的共用照片不能启动任何一项证书提交。
        return false;
    }
    /** 模板仅参与兼容核对，绝不当成填写内容；一致性不足时留下本店异常，不猜测必填值。 */
    function requestFor(source, target, productId, uploaded) {
        if (!source || source.status !== 'complete' || !source.content) fail('来源资质未完整采集，请重新采集');
        const body = source.content;
        const requirements = arrays(target.certNeedUpload?.certNeedUploadItems);
        if (!requirements.length) fail('目标资质模板未确认，未提交');
        const types = requirements.map(item => Number(item.contentType));
        const unsupported = [...new Set(types.filter(type => ![1, 2, 3, 4, 5, 7, 9].includes(type)))];
        if (unsupported.length) fail(`目标资质模板包含尚未支持的内容类型（${unsupported.join('、')}），未提交`);
        if (Number(body.fileUploadType) === 2) fail('此资质需要自动生成文档，尚未支持，未提交');
        if (['docPdfContentReq', 'productDangerousIngredients', 'energyLabel'].some(field => hasContent(body[field]))) {
            fail('来源包含尚未支持的生成文档、危险成分或能效填写内容，未提交');
        }
        // 证明文件的名称不能证明需要代签；只有接口明确要求声明或确认时才阻止自动搬运附件。
        if ([body, target].some(value => value.needAgreement === true || value.needConfirm === true)) fail('此资质需要声明或人工确认，未代为确认');
        const sourceRequirements = arrays(body.certNeedUpload?.certNeedUploadItems);
        // 顶层要求排列不是业务定义；仅排序完整条目，内部选项顺序及重复数量仍须完全一致。
        const templateShape = items => items.map(item => ({ contentType: item.contentType, templateId: item.templateId,
            useMultiTemplate: item.useMultiTemplate, templateConfigList: item.templateConfigList,
            needUploadSubItems: item.needUploadSubItems, certCheckItems: item.certCheckItems,
            supportMultiLanguage: item.supportMultiLanguage, needChooseCheckItems: item.needChooseCheckItems }));
        const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
        const templateKey = items => templateShape(items).map(item => JSON.stringify(stable(item))).sort();
        if (JSON.stringify(templateKey(sourceRequirements)) !== JSON.stringify(templateKey(requirements))) fail('来源和目标资质模板不同，未套用来源字段');
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
        // 必填证书和报告以实际归档链接为证据；空语言容器或仅有文件名不能被实拍图数量掩盖。
        const materialsByField = new Map();
        for (const field of fields) if (body[field] !== undefined) {
            const before = materialCount;
            cert[field === 'multiLangInspectReportMap' ? 'multiLangInspectReportFileMap' : field] = replace(body[field]);
            materialsByField.set(field, materialCount - before);
        }
        for (const requirement of requirements) {
            const type = Number(requirement.contentType);
            const fileFields = { 1: ['productCertFiles', 'multiLangProductCertFileMap'], 2: ['inspectReportFiles', 'multiLangInspectReportMap'] }[type];
            if (fileFields && !fileFields.some(field => materialsByField.get(field) > 0)
                || type === 9 && !arrays(body.uploadedContents).length && !arrays(body.groupUploadedContents).length) {
                fail(`来源缺少目标要求的${{ 1: '资质证书文件', 2: '检测报告文件', 9: '填写内容' }[type]}（类型 ${type}），未提交`);
            }
            if (type === 3 && !body.authCode && !arrays(body.authCodes).length) fail('来源缺少资质编号');
            // 类型5也会用于纯要求展示；平台明确不需要选择时不得伪造选择，未明确则仍保守核验。
            if (type === 5 && requirement.needChooseCheckItems !== false && !hasContent(body.selectedCheckItems)) fail('来源缺少资质适用选项');
        }
        // 实拍图不再混入证书正文；证书栏中的 PNG/JPEG 仍属于证书附件，路由由采集字段决定而不是 MIME。
        if (!materialCount && !body.authCode && !arrays(body.authCodes).length && !arrays(body.uploadedContents).length
            && !arrays(body.groupUploadedContents).length && !hasContent(body.selectedCheckItems)) fail('来源没有可提交的资质材料或填写内容');
        return { productId: String(productId), productCatCertReqList: [cert] };
    }
    /** 只上传请求真正引用的字段，详情里的共用照片、模板示例和无关文件不会产生目标附件。 */
    function requiredFiles(source) {
        const urls = new Set();
        const visit = (value, depth = 0) => {
            if (depth > 40) fail('资质内容嵌套过深');
            if (typeof value === 'string' && /^https?:\/\//i.test(value)) urls.add(value);
            else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
                if (!['originFileUrl', 'expirationStatus', 'endDateOfResponsibility', 'imageId', 'uploadTime'].includes(key)) visit(child, depth + 1);
            }
        };
        for (const field of fields) visit(source.content?.[field]);
        const references = new Map(arrays(source.files).map(file => [file.url, file]));
        return [...urls].map(url => references.get(url) || fail('资质材料引用未归档，请重新采集'));
    }
    /** 审核中和通过的材料不重传；驳回或未知不能解释为缺失，避免覆盖正在审核的材料。 */
    function decision(summary) {
        const status = Number(summary?.uploadStatus);
        if ([2, 4].includes(status)) return 'existing';
        if (status === 1) return 'missing';
        if ([3, 5].includes(status)) return 'rejected';
        return 'unknown';
    }
    const api = { requestFor, decision, sourceHasContent, requiredFiles };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    return api;
})();
