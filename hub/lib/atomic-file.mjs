import { rename } from 'node:fs/promises';

/** 目标文件始终保留到原子替换成功；Windows 短暂占用时等待，不能退回覆盖写制造半截 JSON。 */
export async function replaceFile(temp, target) {
    for (let attempt = 0; ; attempt++) {
        try { await rename(temp, target); return; }
        catch (error) {
            if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 8) throw error;
            await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
        }
    }
}
