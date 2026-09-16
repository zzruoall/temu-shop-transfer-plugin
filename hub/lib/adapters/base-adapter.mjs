/**
 * 目标平台适配器约定。任务管理器只调度确认、重试和状态回写，
 * 页面选择器与平台专属流程必须放在具体适配器里，避免 Temu DOM 泄漏进通用仓库。
 */
export class PlatformAdapter {
    get id() {
        return "base";
    }

    get displayName() {
        return "未实现平台";
    }

    /**
     * 当前阶段允许的最大动作。probe 只打开页面并截图，绝不点击提交/发布。
     */
    get capability() {
        return {
            canOpenStore: false,
            canDetectCreatePage: false,
            canFillFields: false,
            canUploadLocalImages: false,
            canSubmitDraft: false,
            canPublish: false
        };
    }

    matchesStore() {
        return false;
    }

    async inspectCreatePage() {
        throw new Error("adapter_not_implemented");
    }
}

export function missingCapabilities(capability = {}) {
    const notes = [];
    if (!capability.canUploadLocalImages) notes.push("紫鸟 CLI 当前没有文件选择器，不能上传本地图片");
    if (!capability.canFillFields) notes.push("未验证稳定表单选择器，不能自动填写标题/SKU");
    if (!capability.canSubmitDraft) notes.push("不会点击保存草稿或提交审核");
    if (!capability.canPublish) notes.push("不会自动发布到站点");
    return notes;
}
