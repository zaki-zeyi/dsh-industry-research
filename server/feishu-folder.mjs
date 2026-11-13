import { z } from 'zod';
import { createHash } from 'node:crypto';
export const folderTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
export function folderTokenFromUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname)) return null;
    const match = /^\/drive\/folder\/([A-Za-z0-9_-]{1,200})\/?$/.exec(url.pathname);
    return match?.[1] ?? null;
  } catch { return null; }
}
export const folderSettingsSchema = z.object({
  rootName: z.string().trim().min(1, '请输入根目录名字').max(100).refine(v => !/[\x00-\x1f\x7f]/.test(v), '目录名字不能包含控制字符').optional(),
  folderUrl: z.string().trim().max(2000).refine(v => !v || Boolean(folderTokenFromUrl(v)), '请填写飞书文件夹的 HTTPS 链接（/drive/folder/…）').optional(),
}).strict();
export function folderSettings(input) {
  const { rootName = '行研工作台', folderUrl } = folderSettingsSchema.parse(input);
  return folderUrl ? { rootName, folderUrl, folderToken: folderTokenFromUrl(folderUrl) } : { rootName };
}
export const folderCacheKey = root => `feishu-folder:${createHash('sha256').update([root.applicationProfile ?? '', root.applicationOwnerOpenId ?? '', root.rootName].join(':')).digest('hex')}`;
