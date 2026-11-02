import { z } from 'zod';
export const applicationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('default') }).strict(),
  z.object({ mode: z.literal('custom'), appId: z.string().trim().regex(/^cli_[A-Za-z0-9]{5,100}$/, '请填写有效的飞书 App ID'), appSecret: z.string().trim().max(512).refine(v => !v || /^[\x21-\x7e]+$/.test(v), '请填写有效的 App Secret').optional() }).strict(),
]);
export function cliFor(application) {
  if (!application?.profile) return 'lark-cli';
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(application.profile)) throw new Error('飞书应用配置无效');
  return `lark-cli --profile ${application.profile}`;
}
