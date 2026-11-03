import { z } from 'zod';
import { folderTokenSchema } from './feishu-folder.mjs';

const feishuUrl = (value, auth = false) => {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      /(^|\.)(feishu\.cn|larksuite\.com)$/.test(u.hostname) &&
      (auth ? /^(accounts|open)\./.test(u.hostname) : /^\/(docx|docs|wiki)\/[A-Za-z0-9_-]+\/?$/.test(u.pathname));
  } catch { return false; }
};
export const companyReceiptSchema = z.object({ name: z.string().trim().min(1).max(120), url: z.string().max(2000).refine(v => feishuUrl(v), '必须是飞书文档链接'), updatedAt: z.string().datetime({ offset: true }).transform(v => new Date(v).toISOString()).optional(), dimensions: z.array(z.string().min(1).max(120)).max(60), conflicts: z.number().int().min(0).max(100000).default(0), added: z.number().int().min(0).max(100000).default(0) }).strict();
const industryReceipt = { reportFolderToken: folderTokenSchema.optional(), noUpdates: z.boolean().optional(), partial: z.boolean().optional(), libraryFolderToken: folderTokenSchema.optional(), manifestUrl: z.string().max(2000).refine(v => feishuUrl(v)).optional(), companies: z.array(companyReceiptSchema).max(60).optional() };
export const agentDeliverySchema = z.discriminatedUnion('status', [
  z.object({ folderToken: folderTokenSchema.optional(), requestId: z.string().uuid().optional(), status: z.literal('publishing') }),
  z.object({ folderToken: folderTokenSchema.optional(), requestId: z.string().uuid().optional(), status: z.literal('published'), url: z.string().max(2000).refine(v => feishuUrl(v), '必须是飞书文档链接') }),
  z.object({ folderToken: folderTokenSchema.optional(), requestId: z.string().uuid().optional(), status: z.literal('awaiting_authorization'), authorizationUrl: z.string().max(4000).refine(v => feishuUrl(v, true), '必须是飞书官方授权链接'), expiresAt: z.string().datetime({ offset: true }).optional() }),
  z.object({ folderToken: folderTokenSchema.optional(), requestId: z.string().uuid().optional(), status: z.literal('failed'), error: z.string().min(1).max(500) }),
].map(schema => schema.extend(industryReceipt)));

export function agentPublication(delivery) {
  return { target: 'feishu', owner: 'agent', ...delivery, error: delivery.error ?? null };
}

// A local archive and a receipt reader only. All Feishu writes and authorization
// happen inside the user's interactive Agent, never in this publisher.
export class AgentPublisher {
  kind = 'agent';
  constructor(store, terminals) { this.store = store; this.terminals = terminals; }
  async publish(task, persist, signal) {
    signal.throwIfAborted();
    const id = `local-${task.id}-v${task.report.version}`;
    this.store.putDocument(id, task.report);
    task.localPublication = { target: 'local', status: 'published', documentId: id, url: `/api/local/documents/${id}` };
    const meta = task.terminalId ? this.terminals?.get(task.terminalId) : null;
    const p = agentPublication(meta?.workflow === 'manual-upload' || !meta ? { status: 'not_requested' } : meta?.delivery ?? { status: 'not_requested' });
    persist(p); return p;
  }
}
