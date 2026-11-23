import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './service-error.mjs';

const label = z.string().trim().min(1).max(120).regex(/^[^\x00-\x1f\x7f]+$/);
const source = z.url({ protocol: /^https?$/ }).max(2000);
const fact = z.object({
  company: label.optional(),
  dimension: label,
  key: z.string().trim().min(1).max(240),
  date: z.iso.date(),
  text: z.string().trim().min(1).max(1800).transform(value => value.replace(/\s+/g, ' ')),
  sources: z.array(source).min(1).max(12).transform(urls => [...new Set(urls)]),
  conflict: z.boolean().default(false),
}).strict();
export const savePayloadSchema = z.object({
  report: z.string().trim().min(1).max(250_000).optional(),
  facts: z.array(fact).max(500).default([]),
  minutes: z.object({ title: label, body: z.string().trim().min(1).max(250_000) }).strict().optional(),
  sourceTitle: label.optional(),
  insufficient: z.array(label).max(60).default([]),
  noUpdates: z.boolean().default(false),
  partial: z.boolean().default(false),
}).strict();

export const saveDigest = value => createHash('sha256').update(value).digest('hex');
export const companyResearch = task => task.industry ?? task.briefing ?? task.internal?.research;
export const companyResource = (folder, name) => 'company:' + folder + ':' + name.normalize('NFKC');

export function validateSavePayload(task, input) {
  const payload = savePayloadSchema.parse(input);
  const research = companyResearch(task);
  if (payload.noUpdates && (payload.partial || payload.facts.length)) throw new ServiceError(400, '有事实增量或资料缺口时不能标记为无更新');
  if (!task.industry && (!task.topic || task.topic.window) && !payload.report) throw new ServiceError(400, '缺少报告正文');
  if (task.industry && !payload.facts.length && !payload.noUpdates && !payload.partial) throw new ServiceError(400, '请提交公司事实或明确报告资料状态');
  if (task.briefing && !payload.facts.length && !payload.noUpdates && !payload.partial) throw new ServiceError(400, '日报或周报请提交公司事实或明确报告资料状态');
  if (task.topic && !task.topic.window && !payload.facts.length && !payload.noUpdates && !payload.partial) throw new ServiceError(400, '请提交专题事实或明确报告资料状态');
  if (task.internal && !payload.minutes) throw new ServiceError(400, '缺少会议纪要');
  if (task.analysis && payload.insufficient.some(name => !task.analysis.companies.includes(name))) throw new ServiceError(400, '资料不足的公司必须属于本次对比范围');
  for (const entry of payload.facts) {
    if (task.topic) {
      if (entry.company) throw new ServiceError(400, '专题事实按专题提交，请省略 company');
    } else if (!research?.companies.includes(entry.company) || !research.dimensions.includes(entry.dimension)) {
      throw new ServiceError(400, '公司事实超出本次调研的公司或维度范围');
    }
  }
  return payload;
}

export const normalizedFact = value => value.normalize('NFKC').toLowerCase()
  .replace(/\p{White_Space}/gu, '').replace(/[。；;]+$/u, '');
