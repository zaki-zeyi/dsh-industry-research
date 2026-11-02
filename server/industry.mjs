import { companyReceiptSchema } from './agent-delivery.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { DEFAULT_COMPANIES, DEFAULT_DIMENSIONS, DEFAULT_SOURCES } from './industry-defaults.mjs';
export { DEFAULT_COMPANIES, DEFAULT_DIMENSIONS, DEFAULT_SOURCES };
const label = z.string().trim().min(1).max(120).refine(v => !/[\x00-\x1f\x7f]/.test(v), '名称不能包含控制字符');
const choices = z.array(label).min(1).max(60).transform(v => [...new Set(v)]);
export const industryInputSchema = z.object({ companies: choices, dimensions: choices, sources: choices, requirements: z.string().trim().max(2000).default(''), prompt: z.string().trim().min(10).max(14000).optional() }).strict();
export const preferencesSchema = z.object({ dimensions: choices, sources: choices }).strict();
export function preferences(store) { return store.setting('industry-preferences') ?? { dimensions: DEFAULT_DIMENSIONS, sources: DEFAULT_SOURCES }; }
export function libraryKey(root, app) { return 'industry-library:' + createHash('sha256').update(JSON.stringify([app?.profile ?? 'default', app?.appId ?? '', root.folderUrl ?? root.rootName])).digest('hex'); }
export function library(store, root, app) { return store.setting(libraryKey(root, app)) ?? { companies: [], folderToken: null }; }
export function industryPrompt(input) {
  return `帮我对【${input.companies.join('、')}】在【${input.sources.join('、')}】进行【${input.dimensions.join('、')}】的调研${input.requirements ? `，并满足【${input.requirements}】` : ''}，自动去重增量保存到飞书云盘【全量信息库】中。并呈现本次更新摘要。`;
}
export function mergeCompanyDelivery(store, task, delivery) {
  if (!task.industry || !delivery.libraryFolderToken) return;
  const key = libraryKey(task.feishuRoot, task.feishuApp), current = library(store, task.feishuRoot, task.feishuApp);
  if (current.manifestUrl && delivery.manifestUrl && delivery.manifestUrl !== current.manifestUrl) throw new Error('必须复用已有公司索引文档');
  if (current.folderToken && delivery.libraryFolderToken !== current.folderToken) throw new Error('全量信息库目录与已有目录不一致');
  if (!delivery.libraryFolderToken) throw new Error('缺少全量信息库目录 ID');
  const names = new Set(); const urls = new Set();
  for (const c of delivery.companies ?? []) {
    if (!task.industry.companies.includes(c.name) || names.has(c.name) || urls.has(c.url)) throw new Error('公司交付包含未请求公司或重复文档');
    const previous = current.companies.find(v => v.name === c.name);
    if (previous && previous.url !== c.url) throw new Error('已收录公司必须更新原文档，禁止重复创建');
    if (current.companies.some(v => v.name !== c.name && v.url === c.url)) throw new Error('不同公司不能使用同一文档');
    names.add(c.name); urls.add(c.url);
  }
  const byName = new Map(current.companies.map(c => [c.name, c]));
  for (const c of delivery.companies ?? []) byName.set(c.name, { ...c, dimensions: [...new Set([...(byName.get(c.name)?.dimensions ?? []), ...c.dimensions])], updatedAt: new Date().toISOString(), taskId: task.id });
  store.saveSetting(key, { folderToken: delivery.libraryFolderToken, manifestUrl: delivery.manifestUrl ?? current.manifestUrl, companies: [...byName.values()] });
}
export function companyTaskInput(input) { const v = industryInputSchema.parse(input); return { direction: `更新全量信息库 · ${v.companies.length} 家公司`, sources: v.sources.join('、'), prompt: v.prompt ?? industryPrompt(v), industry: v }; }

// Read a known manifest document; never enumerate a user's Drive.
export async function refreshLibrary(store, root, app, run = promisify(execFile)) {
  const current = library(store, root, app);
  if (!current.manifestUrl) return current;
  const args = [...(app?.profile ? ['--profile', app.profile] : []), 'docs', '+fetch', '--doc', current.manifestUrl, '--doc-format', 'markdown', '--as', 'user'];
  const { stdout } = await run('lark-cli', args, { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
  const response = JSON.parse(stdout);
  if (!response.ok) throw new Error('无法读取飞书资料库索引，请检查授权后重试');
  const content = response.data?.document?.content ?? '';
  const start = content.indexOf('{'), end = content.lastIndexOf('}');
  const manifest = z.object({ companies: z.array(companyReceiptSchema.extend({ updatedAt: z.string().datetime(), taskId: z.string().uuid().optional() })).max(1000) }).parse(JSON.parse(content.slice(start, end + 1)));
  if (new Set(manifest.companies.map(c => c.name)).size !== manifest.companies.length || new Set(manifest.companies.map(c => c.url)).size !== manifest.companies.length) throw new Error('飞书索引存在重复公司或文档');
  const companies = manifest.companies.map(c => ({ ...c, taskId: current.companies.find(v => v.name === c.name)?.taskId }));
  return store.saveSetting(libraryKey(root, app), { ...current, companies });
}
