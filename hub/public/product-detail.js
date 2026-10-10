/** 商品详情仅展示已有资料；固定模块顺序，不按类目推断缺失字段或展示未设计的原始字段。 */
window.ProductDetailView = (() => {
    const array = value => Array.isArray(value) ? value : [];
    const text = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
    const first = (...values) => values.find(value => Array.isArray(value) ? value.length > 0 : value && typeof value === 'object' ? Object.keys(value).length > 0 : text(value) !== '') ?? '';
    const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    const unique = values => [...new Set(values.filter(Boolean))];
    // 与采集器已识别的正文键兼容；新增未知模块不会因递归扫描原始对象而意外进入详情页。
    const bodyKeys = new Set(['text', 'content', 'html', 'htmlcontent', 'body', 'children', 'contentlist', 'description', 'descriptionhtml', 'deschtml', 'desc', 'productdesc', 'goodsdesc', 'detaildesc', 'productdetail', 'goodsdetail', 'productdescription', 'goodsdescription', 'detaildescription', 'detailhtml', 'goodsdetailhtml', 'productdetailhtml', 'richtext', 'richtextcontent', 'longdesc', 'detailinfo', 'detaildata', 'detailcontent', 'detailcontents', 'descriptioncontent', 'descriptioncontents', 'descriptiontext', 'descriptionlist', 'descriptioni18n', 'detailtext', 'contenttext', 'contenthtml', 'decoration', 'decorationi18n', 'goodslayerdecorationvolist', 'goodslayerdecorationcustomizei18nvolist']);
    const languageName = value => ({ en: '英语', 'en-GB': '英语（英国）', 'en-US': '英语（美国）', zh: '中文', 'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', de: '德语', fr: '法语', es: '西班牙语', it: '意大利语', ja: '日语', ko: '韩语', pt: '葡萄牙语' }[value] || text(value));

    /** 来自采集包的地址不可信，仅允许 HTTPS，禁止脚本协议、内嵌数据和携带账号密码的链接。 */
    function safeUrl(value) {
        try {
            const url = new URL(text(value));
            return url.protocol === 'https:' && !url.username && !url.password ? url.href : '';
        } catch { return ''; }
    }

    /** 不递归扫描整个商品，避免把 SKU 图、包装图或视频海报误当成轮播图。 */
    function mediaUrls(value) {
        const rows = Array.isArray(value) ? value : [value];
        return unique(rows.map(item => safeUrl(typeof item === 'string' ? item : first(item?.signedImageUrl, item?.imageUrl, item?.imgUrl, item?.url, item?.videoUrl, item?.fileUrl))));
    }

    function images(value, label, large = false) {
        const urls = mediaUrls(value);
        if (!urls.length) return '';
        return `<div class="detail-images${large ? ' detail-images-body' : ''}">${urls.map((url, index) => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer" aria-label="查看${escape(label)} ${index + 1}"><img src="${escape(url)}" alt="${escape(label)} ${index + 1}" loading="lazy" referrerpolicy="no-referrer"></a>`).join('')}</div>`;
    }

    function videos(value) {
        return mediaUrls(value).map(url => `<video controls preload="none" src="${escape(url)}" aria-label="商品视频"></video>`).join('');
    }

    function row(label, content) {
        return content ? `<div class="detail-field"><div class="detail-label">${escape(label)}</div><div class="detail-value">${content}</div></div>` : '';
    }

    function valueRow(label, value) { return row(label, text(value) ? `<p>${escape(value)}</p>` : ''); }
    function section(title, content) { return content ? `<section class="detail-section" aria-label="${escape(title)}"><h2>${escape(title)}</h2>${content}</section>` : ''; }
    /** 图文及实拍图采用原生折叠，默认不展开；内容保留，键盘可独立展开每个模块。 */
    function collapsedSection(title, content) {
        return content ? `<details class="detail-section detail-collapsible"><summary><h2>${escape(title)}</h2></summary><div class="qualification-body">${content}</div></details>` : '';
    }

    /** 实拍图只展示专用归档，不使用商品主图或证书图片补位；下载仍由服务端核验来源权限。 */
    function livePhotos(product) {
        const captures = array(product.livePhotoCaptures).length ? product.livePhotoCaptures : product.livePhotos ? [product.livePhotos] : [];
        return captures.map(capture => {
            const sourceStoreId = text(capture.sourceStoreId || product.sourceStoreIds?.[0]);
            const productId = text(capture.productId);
            const skus = new Map(array(capture.skus).map(sku => [text(sku.skuId), text(sku.skuExtCode)]));
            const status = capture.status === 'complete' ? '读取完成' : capture.status === 'partial' ? '部分读取' : '读取失败';
            const archived = capture.archive?.status === 'complete' ? '原图已归档' : '原图未完整归档';
            const groups = array(capture.groups).map(group => {
                const photos = array(group.images).map(image => {
                    const asset = array(capture.assets).find(asset => asset.url === image.url);
                    const label = `${text(image.typeLabel) || `视角 ${image.positionType}`} · ${image.skuId === '0' ? '共用' : skus.get(image.skuId) || image.skuId}`;
                    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^\d{6,20}$/.test(productId) || !sourceStoreId) return `<p>${escape(label)} · 未归档</p>`;
                    const params = new URLSearchParams({ sourceStoreId });
                    // 保留当前个人/共享库读取约束，链接只能指向本站已认证的归档接口。
                    if (typeof location !== 'undefined') {
                        const query = location.hash.split('?')[1] || '';
                        const library = new URLSearchParams(query).get('library');
                        if (library) params.set('library', library);
                        const accountType = new URLSearchParams(query).get('accountType') || new URLSearchParams(location.search || '').get('accountType');
                        if (['production', 'test', 'unclassified'].includes(accountType)) params.set('accountType', accountType);
                    }
                    const href = `./api/live-photo-assets/${productId}/${asset.sha256}?${params}`;
                    return `<div class="detail-live-photo"><a href="${escape(href)}" target="_blank" rel="noopener noreferrer"><img src="${escape(href)}" alt="${escape(label)}" loading="lazy"><span>${escape(label)} · ${escape(asset.name || image.name || '实拍图')} · 已归档</span></a></div>`;
                }).join('');
                return photos ? `<details class="detail-qualification"><summary class="qualification-summary"><h4>${escape(group.label || `位置 ${group.position}`)}</h4></summary><div class="qualification-body">${photos}</div></details>` : '';
            }).join('');
            const reason = capture.lastAttempt?.reason || capture.reason;
            return `<div class="qualification-scope"><h3>来源店 ${escape(sourceStoreId)} · SPU ${escape(productId)}</h3><p class="qualification-meta">${status} · ${archived}</p>${reason ? `<p class="qualification-warning">${escape(reason)}</p>` : ''}${groups || '<p>本次未返回商品实拍图</p>'}</div>`;
        }).join('');
    }

    /** 动态表只显示至少一行有值的列；空数据用短横线，不把 0 当作缺失。 */
    function table(rows, columns, label) {
        const active = columns.filter(column => rows.some(item => column.read(item) !== ''));
        if (!rows.length || !active.length) return '';
        return `<div class="detail-table-scroll" tabindex="0" role="region" aria-label="${escape(label)}"><table class="detail-table"><thead><tr>${active.map(column => `<th scope="col">${escape(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(item => `<tr>${active.map(column => `<td>${column.read(item) || '<span class="detail-missing">—</span>'}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    }

    /** 属性名称和值来自各商品自己的列表，保留多选值与单位，不使用固定类目模板。 */
    function attributes(product, source, hasSource) {
        const rows = hasSource ? [...array(source.productPropertyList), ...array(source.productProperties)] : array(product.attributes);
        const seen = new Set();
        return rows.map(item => {
            const name = text(first(item?.propName, item?.propertyName, item?.name));
            const raw = first(item?.propValue, item?.propertyValue, item?.value, item?.numberInputValue);
            const value = Array.isArray(raw) ? raw.map(text).filter(Boolean).join(' / ') : text(raw);
            const extra = text(item?.valueExtendInfo);
            const unit = text(first(item?.valueUnit, item?.unit));
            const key = JSON.stringify([name, value, unit, extra]);
            if (!name || (!value && !extra) || seen.has(key)) return '';
            seen.add(key);
            return valueRow(name, `${value}${extra && extra !== value ? ` / ${extra}` : ''}${unit ? ` ${unit}` : ''}`.replace(/^ \/ /, ''));
        }).join('');
    }

    /** SKU 以明确 ID 合并来源详情和展示摘要，不能按数组位置拼接，以免不同规格错配。 */
    function skuRows(product, source, hasSource) {
        const rows = new Map();
        for (const skc of array(source.productSkcList)) {
            const skus = [...array(skc?.productSkuList), ...Object.values(skc?.productSkuMap || {})];
            for (const sku of skus) {
                if (!sku || typeof sku !== 'object') continue;
                const id = text(first(sku.productSkuId, sku.skuId));
                const key = id || sku;
                if (rows.has(key)) rows.get(key).raw = mergeMissing(rows.get(key).raw, sku);
                else rows.set(key, { raw: sku, skc, summary: {}, id });
            }
        }
        for (const sku of hasSource ? [] : array(product.skus)) {
            if (!sku || typeof sku !== 'object') continue;
            const id = text(sku.skuId);
            const key = id || sku;
            if (rows.has(key)) rows.get(key).summary = sku;
            else rows.set(key, { raw: {}, skc: {}, summary: sku, id });
        }
        for (const id of hasSource ? [] : array(product.skuIds).map(text).filter(Boolean)) if (!rows.has(id)) rows.set(id, { raw: {}, skc: {}, summary: {}, id });
        return [...rows.values()].map(item => {
            const specs = [...array(item.skc.productSkcSpecList), ...(item.raw.productSkuSpecList !== undefined ? array(item.raw.productSkuSpecList) : array(item.summary.specs))];
            item.specs = specs.map(spec => ({ name: text(first(spec?.parentSpecName, spec?.name)), value: text(first(spec?.specName, spec?.value)) })).filter(spec => spec.value);
            return item;
        });
    }

    /** 同来源同 ID 的 SKU 列表优先，Map 只补缺少的字段；显式空值不能被覆盖或用历史摘要恢复。 */
    function mergeMissing(current, supplement, depth = 0) {
        const result = { ...current };
        for (const [key, value] of Object.entries(supplement)) {
            if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
            if (!Object.hasOwn(result, key)) result[key] = value;
            else if (depth < 5 && result[key] && value && typeof result[key] === 'object' && typeof value === 'object' && !Array.isArray(result[key]) && !Array.isArray(value)) result[key] = mergeMissing(result[key], value, depth + 1);
        }
        return result;
    }

    function specColumns(rows) {
        const names = unique(rows.flatMap(item => item.specs.map(spec => spec.name || '规格')));
        return names.map(name => ({ label: name, read: item => escape(unique(item.specs.filter(spec => (spec.name || '规格') === name).map(spec => spec.value)).join(' / ')) }));
    }

    /** 平台存储价为分、重量为毫克、尺寸为毫米；优先展示明确录入值和单位，未知代码不猜测含义。 */
    function measure(value, scale, unit) {
        if (value == null || text(value) === '' || !Number.isFinite(Number(value))) return '';
        return `${Number((Number(value) / scale).toFixed(4))} ${unit}`;
    }
    function weight(value, fallback) {
        if (text(value?.inputValue) && text(value?.inputUnit) && !/^\d+$/.test(text(value.inputUnit))) return `${text(value.inputValue)} ${text(value.inputUnit)}`;
        return measure(first(value?.value, fallback), 1000, 'g');
    }
    function dimensions(item) {
        const volume = item.raw.productSkuWhExtAttr?.productSkuVolume;
        if (!volume) return '';
        return [['长', volume.len], ['宽', volume.width], ['高', volume.height]].map(([label, value]) => {
            const formatted = measure(value, 10, 'cm');
            return formatted ? `${label} ${formatted}` : '';
        }).filter(Boolean).join(' / ');
    }
    function sensitive(item) {
        const attr = item.raw.productSkuWhExtAttr?.productSkuSensitiveAttr;
        return text(first(attr?.sensitiveName, attr?.isSensitive === 1 ? '是' : attr?.isSensitive === 0 ? '否' : ''));
    }
    function price(item) {
        const value = first(item.raw.supplierPrice, item.summary.price);
        if (text(value) === '' || !Number.isFinite(Number(value))) return '';
        return `${text(first(item.raw.currencyType, item.summary.currency))} ${(Number(value) / 100).toFixed(2)}`.trim();
    }

    /** 成分按商品级或各 SKU 的配方分别呈现，不把某个 SKU 的配方强行套到所有规格。 */
    function cosmetics(source, rows) {
        const render = (groups, label) => array(groups).map(group => {
            const names = array(group?.propertyInfoList).map(item => text(first(item?.valueName, item?.langPromptMap?.en, item?.name))).filter(Boolean);
            if (!names.length) return '';
            return row(label || '商品', `${valueRow('产品名称', group.cosmeticEnName)}<p>${names.map(escape).join(' / ')}</p>`);
        }).join('');
        const productInfo = first(source.productNonAuditExtAttr?.cosmeticInfoVO, source.productNonAuditExtAttr?.cosmeticInfo, source.cosmeticInfoVO);
        return render(productInfo ? [productInfo] : [], '') + rows.map(item => render(item.raw.productSkuNonAuditExtAttr?.cosmeticInfo, unique(item.specs.map(spec => spec.value)).join(' / ') || item.id)).join('');
    }

    /** 详情正文只读取支持的图文容器；HTML 在惰性文档中转为文本和安全图片，绝不直接插入来源 HTML。 */
    function description(value, depth = 0) {
        if (depth > 8 || value == null) return '';
        if (typeof value === 'string') {
            if (!value.trim()) return '';
            if (!value.includes('<')) return safeUrl(value) && /\.(png|jpe?g|webp|gif|avif)([?#]|$)/i.test(value) ? images(value, '详情图', true) : `<p>${escape(value)}</p>`;
            if (typeof DOMParser === 'undefined') return `<p>${escape(value)}</p>`;
            const doc = new DOMParser().parseFromString(value, 'text/html');
            doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach(node => node.remove());
            const body = text(doc.body.textContent);
            const urls = [...doc.querySelectorAll('img')].map(img => first(img.getAttribute('src'), img.getAttribute('data-src')));
            return `${body ? `<p>${escape(body)}</p>` : ''}${images(urls, '详情图', true)}`;
        }
        if (Array.isArray(value)) return value.map(item => description(item, depth + 1)).join('');
        if (typeof value !== 'object') return '';
        // 未设计的组件不输出 JSON；只有明确的正文、图片、子内容字段进入展示。
        return Object.entries(value).filter(([key]) => bodyKeys.has(key.replace(/[_\s-]/g, '').toLowerCase())).map(([, item]) => description(item, depth + 1)).join('')
            + images(first(value.imageUrl, value.imgUrl, value.picUrl, value.imageUrls, value.images, value.src), '详情图', true);
    }

    /** 资质附件来源独立于商品图片，只开放平台 HTTPS 链接，不把签名地址发给第三方预览服务。 */
    function qualificationFile(value) {
        const url = safeUrl(value);
        if (!url) return '';
        const host = new URL(url).hostname;
        return ['kwcdn.com', 'temu.com', 'kuajingmaihuo.com'].some(domain => host === domain || host.endsWith(`.${domain}`)) ? url : '';
    }

    /** 资质按原始 SPU 分组；读取状态与平台上传/审核状态分开，不能以来源店资料代替目标店审核。 */
    function qualifications(product) {
        const captures = array(product.qualificationCaptures);
        const captureName = status => ({ complete: '读取完成', partial: '部分读取', failed: '读取失败' }[status] || '未读取');
        const timestamp = value => text(value).replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
        const codeName = value => value === null || value === undefined ? '未提供' : `平台状态码 ${text(value)}`;
        return captures.map(capture => {
            const scope = `来源店 ${text(capture.sourceStoreId) || '尚未映射'} · SPU ${text(capture.spuId)}`;
            const latest = capture.lastAttempt ? `<p class="qualification-warning">最近读取：${escape(captureName(capture.lastAttempt.status))} · ${escape(timestamp(capture.lastAttempt.capturedAt))}${capture.lastAttempt.reason ? ` · ${escape(capture.lastAttempt.reason)}` : ''}</p>` : '';
            // 资料读取完成不等于附件可搬运；旧临时链接必须明确提示重新采集。
            const archiveLabel = { complete: '附件已归档', partial: '附件部分归档', failed: '附件归档失败', not_archived: '附件未归档，请重新采集' }[capture.archiveStatus] || '附件未归档，请重新采集';
            const status = `<p class="qualification-meta">${escape(captureName(capture.status))} · ${escape(timestamp(capture.capturedAt))} · ${escape(archiveLabel)}</p>`;
            const reason = capture.reason ? `<p class="qualification-warning">${escape(capture.reason)}</p>` : '';
            const empty = !array(capture.items).length ? `<p>${capture.status === 'complete' ? '本次查询无商品资质记录' : '未取得完整资质资料'}</p>` : '';
            const items = array(capture.items).map(item => {
                const countries = array(item.sites).map(site => text(site.name) || `站点 ${text(site.id)}`).join(' / ');
                const requirements = array(item.requirements).map(value => `<p>${escape(value)}</p>`).join('');
                const effects = array(item.saleEffects).map(value => `<p>${escape(value)}</p>`).join('');
                const files = array(item.files).map(file => {
                    const url = qualificationFile(file.url);
                    const label = [text(file.role), text(file.name), text(file.language), file.asset?.sha256 ? '已归档' : '未归档'].filter(Boolean).join(' · ');
                    return url ? `<a class="detail-file-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">${escape(label || '资质附件')}</a>${!file.asset?.sha256 && file.reason ? `<p class="qualification-warning">${escape(file.reason)}</p>` : ''}`
                        : `<p>${escape(label || '资质附件')} · ${escape(file.reason || '附件地址未验证，未开放链接')}</p>`;
                }).join('');
                // 仅展示明确的商品资质填写字段，操作者、联系方式和模板配置不进入用户内容面板。
                const fields = { authCode: '资质编号', authCodes: '资质编号', model: '型号', brand: '品牌', eprelId: 'EPREL 编号',
                    selectedCheckItems: '已选择检测项', productDangerousIngredients: '危险成分信息', docPdfContentReq: '资质文档填写内容',
                    uploadedContents: '已上传内容', groupUploadedContents: '分组上传内容' };
                const entered = Object.entries(fields).map(([key, label]) => {
                    const value = item.content?.[key];
                    if (value === null || value === undefined || value === '' || typeof value === 'object' && !Object.keys(value).length) return '';
                    return row(label, typeof value === 'object' ? `<pre class="qualification-content">${escape(JSON.stringify(value, null, 2))}</pre>` : `<p>${escape(value)}</p>`);
                }).join('');
                // 每项资质独立默认收起；缺失提示保留在标题旁，长要求与填写内容只在用户展开后展示。
                const warning = item.status !== 'complete' ? '读取不完整' : array(item.files).some(file => !file.asset?.sha256) ? '附件未完整' : '';
                return `<details class="detail-qualification"><summary class="qualification-summary"><h4>${escape(item.displayName || item.name || `资质 ${item.certType}`)}</h4>${warning ? `<span class="qualification-summary-warning">${escape(warning)}</span>` : ''}</summary><div class="qualification-body">${item.name && item.displayName ? `<p class="qualification-meta">${escape(item.name)}</p>` : ''}
                    ${valueRow('上传状态', Number(item.uploadStatus) === 1 ? '待上传' : codeName(item.uploadStatus))}${valueRow('审核状态', codeName(item.auditStatus))}
                    ${valueRow('适用国家或地区', countries)}${row('合规要求', requirements)}${row('销售影响', effects)}
                    ${row('资质文件', files || (item.status === 'complete' ? '<p>未返回已上传附件</p>' : ''))}
                    ${item.status !== 'complete' ? `<p class="qualification-warning">${escape(item.reason || '资质详情未完整读取')}</p>` : ''}
                    ${entered ? `<details class="qualification-entered"><summary>已填写内容</summary>${entered}</details>` : ''}</div></details>`;
            }).join('');
            return `<div class="qualification-scope"><h3>${escape(scope)}</h3>${status}${latest}${reason}${empty}${items}</div>`;
        }).join('');
    }

    /** 参考图的纵向顺序固定，新增资质放在资料尾部，不改变已有商品属性、规格和 SKU 的排列。 */
    function render(product = {}) {
        const candidate = product.publicationData?.sourceProduct;
        const hasSource = Boolean(candidate && typeof candidate === 'object' && !Array.isArray(candidate));
        const source = hasSource ? candidate : {};
        const rows = skuRows(product, source, hasSource);
        const specs = specColumns(rows);
        const localized = [...array(source.carouselImageI18nVOList), ...Object.entries(source.carouselImgsI18n || {}).map(([language, urls]) => ({ language, images: urls }))];
        const languages = unique([...array(source.imageLanguageList), ...array(source.productLocalExtAttr?.materialMultiLanguages), ...localized.map(group => group?.language)].map(item => text(typeof item === 'object' ? item?.language : item)).filter(Boolean));
        const localizedImages = localized.map(group => row(languageName(group?.language), images(first(group?.imageUrls, group?.carouselImageUrls, group?.images, group?.imageUrl), '商品轮播图'))).join('');
        const baseImages = hasSource ? source.carouselImageUrls : product.images;
        const material = valueRow('素材语言', languages.map(languageName).join(' / '))
            + row('商品轮播图', images(baseImages, '商品轮播图') + localizedImages)
            + row('商品素材图', images(first(source.materialImgUrl, source.materialImageUrl), '商品素材图'))
            + row('主图视频', videos(first(source.carouseVideoVOList, source.carouselVideoVOList)));
        const english = array(source.productI18nList).find(item => item?.language === 'en')?.productName || source.productNameEn;
        const origin = source.productWhExtAttr?.productOrigin || {};
        const originText = [first(origin.countryName, origin.countryShortName), origin.region2Name, origin.regionName].map(text).filter(Boolean).join(' / ');
        const manufacture = source.productSaleExtAttr?.manufacturingLocation;
        const manufactureText = Array.isArray(manufacture) ? manufacture.map(item => text(first(item?.countryName, item?.countryShortName, item))).filter(Boolean).join(' / ') : text(first(manufacture?.countryName, manufacture?.countryShortName, manufacture));
        const basic = valueRow('商品名称', hasSource ? source.productName : product.title) + valueRow('英文名称', english)
            + valueRow('商品产地', originText) + valueRow('制造地点', manufactureText);
        const specGroups = new Map();
        for (const item of rows) for (const spec of item.specs) {
            const name = spec.name || '规格';
            if (!specGroups.has(name)) specGroups.set(name, []);
            specGroups.get(name).push(spec.value);
        }
        const specification = [...specGroups].map(([name, values]) => valueRow(name, unique(values).join(' / '))).join('');
        const packageInfo = source.productWhExtAttr?.productOuterPackage || {};
        const packaging = row('外包装图片', images(source.outerPackageImages, '外包装图片')) + valueRow('包装形状', packageInfo.packageShapeName) + valueRow('包装类型', packageInfo.packageTypeName);
        const logistics = table(rows, [...specs,
            { label: 'SKU', read: item => escape(item.id) },
            { label: '敏感属性', read: item => escape(sensitive(item)) },
            { label: '体积尺寸', read: item => escape(dimensions(item)) },
            { label: '重量', read: item => escape(weight(item.raw.productSkuWhExtAttr?.productSkuWeight, item.summary.weight)) },
            { label: '净重', read: item => escape(weight(item.raw.productSkuWhExtAttr?.productSkuNetWeight, item.summary.netWeight)) }
        ].filter(column => column.label === 'SKU' || specs.includes(column) || rows.some(item => column.read(item))), '敏感属性与体积重量');
        const hasLogistics = rows.some(item => dimensions(item) || weight(item.raw.productSkuWhExtAttr?.productSkuWeight, item.summary.weight) || weight(item.raw.productSkuWhExtAttr?.productSkuNetWeight, item.summary.netWeight) || sensitive(item));
        const skuInfo = table(rows, [...specs,
            { label: 'SKU', read: item => escape(item.id) },
            { label: '申报价格', read: item => escape(price(item)) },
            { label: '预览图', read: item => images(first(item.raw.thumbUrl, item.summary.thumbUrl), 'SKU 预览图') },
            { label: 'SKU 分类', read: item => escape(item.raw.productSkuMultiPack?.skuClassificationName) },
            { label: '商品编码', read: item => escape(first(item.raw.productSkuWhExtAttr?.productSkuBarCodes?.[0]?.code, item.summary.barCode)) },
            { label: 'SKU 货号', read: item => escape(first(item.raw.extCode, item.summary.extCode)) },
            { label: '单品数量', read: item => escape(text(item.raw.productSkuMultiPack?.numberOfPieces)) }
        ], 'SKU 信息');
        const codes = hasSource ? unique(array(source.productSkcList).map(skc => text(skc?.extCode))) : unique([...array(product.productExtCodes), text(product.articleNo)].map(text));
        const guides = [...array(source.productGuideFileI18nList), ...array(source.productGuideFileNewVOList)];
        const guideLinks = guides.map(file => {
            const url = safeUrl(first(file?.fileUrl, file?.url));
            return url ? `<a class="detail-file-link" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(first(file.fileName, file.name, '说明书'))}</a>` : '';
        }).join('');
        const body = hasSource ? [source.goodsLayerDecorationVOList, source.goodsLayerDecorationCustomizeI18nVOList, source.decoration] : product.detail;
        return `<div class="product-detail">${section('商品素材', material)}${section('基本信息', basic)}${section('商品属性', attributes(product, source, hasSource))}${section('商品规格', specification)}${section('尺码表', images(source.sizeChartImages, '尺码表'))}${section('商品包装信息', packaging)}${section('敏感属性与体积重量', hasLogistics ? logistics : '')}${section('SKU 信息', skuInfo)}${section('货号', valueRow('货号', codes.join(' / ')))}${section('化妆品成分', cosmetics(source, rows))}${section('详情视频', row('详情视频', videos(source.detailVideoVOList)))}${section('电子说明书', row('说明书文件', guideLinks))}${collapsedSection('详情图文', description(body))}${section('商品资质', qualifications(product))}${collapsedSection('商品实拍图', livePhotos(product))}</div>`;
    }
    return { render };
})();
