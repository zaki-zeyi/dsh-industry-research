import { companyReceiptSchema } from './agent-delivery.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LibraryRefreshError, libraryReadError } from './library-errors.mjs';
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
  for (const c of delivery.companies ?? []) byName.set(c.name, { ...c, dimensions: [...new Set([...(byName.get(c.name)?.dimensions ?? []), ...c.dimensions])], updatedAt: c.updatedAt ?? new Date().toISOString(), taskId: task.id });
  store.saveSetting(key, { folderToken: delivery.libraryFolderToken, manifestUrl: delivery.manifestUrl ?? current.manifestUrl, companies: [...byName.values()] });
}
export function companyTaskInput(input) { const v = industryInputSchema.parse(input); return { direction: `更新全量信息库 · ${v.companies.length} 家公司`, sources: v.sources.join('、'), prompt: v.prompt ?? industryPrompt(v), industry: v }; }

// Read a known manifest document; never enumerate a user's Drive.
const timestamp = z.string().datetime({ offset: true });
const manifestCompanySchema = companyReceiptSchema.extend({ updatedAt: timestamp, taskId: z.string().uuid().optional() });
export function parseLibraryManifest(content) {
  let value;
  try {
    const text = String(content ?? '').trim();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('missing JSON');
    value = JSON.parse(text.slice(start, end + 1));
  } catch { throw new LibraryRefreshError('LIBRARY_INVALID_JSON', '公司索引不是有效 JSON，请在原会话修复索引；本地已同步记录保留'); }
  const parsed = z.object({ companies: z.array(manifestCompanySchema).max(1000) }).safeParse(value);
  if (!parsed.success) throw new LibraryRefreshError('LIBRARY_INVALID_SCHEMA', '公司索引字段格式不正确，请在原会话核对公司链接、维度和日期；本地已同步记录保留');
  const companies = parsed.data.companies;
  if (new Set(companies.map(c => c.name)).size !== companies.length || new Set(companies.map(c => c.url)).size !== companies.length) throw new LibraryRefreshError('LIBRARY_DUPLICATES', '公司索引存在重复公司或文档，请在原会话核对；本地已同步记录保留');
  return companies.map(c => ({ ...c, updatedAt: new Date(c.updatedAt).toISOString() }));
}
export async function refreshLibrary(store, root, app, run = promisify(execFile), { command } = {}) {
  const key = libraryKey(root, app), current = library(store, root, app);
  if (!current.manifestUrl) return current;
  const args = [...(app?.profile ? ['--profile', app.profile] : []), 'docs', '+fetch', '--doc', current.manifestUrl, '--doc-format', 'markdown', '--as', 'user'];
  const local = resolve(homedir(), '.local/bin/lark-cli');
  let stdout;
  try {
    ({ stdout } = await run(command ?? (existsSync(local) ? local : 'lark-cli'), args, { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }));
  } catch (e) { throw libraryReadError(e); }
  let response;
  try { response = JSON.parse(stdout); } catch { throw new LibraryRefreshError('LIBRARY_INVALID_RESPONSE', 'Lark CLI 返回格式异常，请检查 CLI 后重试；本地已同步记录保留'); }
  if (!response.ok) throw libraryReadError({ stdout });
  const remote = parseLibraryManifest(response.data?.document?.content);
  // A task may deliver another company while the remote fetch is in flight. Merge
  // against the latest local index and retain entries newer than this snapshot.
  const latest = library(store, root, app);
  if (latest.manifestUrl !== current.manifestUrl || latest.folderToken !== current.folderToken) throw new LibraryRefreshError('LIBRARY_CHANGED', '同步期间公司索引已改变，请刷新重试；本地记录保留', 409);
  const localByName = new Map(latest.companies.map(c => [c.name, c]));
  const companies = remote.map(c => {
    const local = localByName.get(c.name);
    if (local && Date.parse(local.updatedAt) > Date.parse(c.updatedAt)) return local;
    const related = local?.taskId ?? store.list?.().find(t => t.industry?.companies.includes(c.name) && libraryKey(t.feishuRoot, t.feishuApp) === key)?.id;
    return { ...c, taskId: related };
  });
  const known = new Set(companies.map(c => c.name));
  // Keep only entries delivered during this request, not remotely removed entries.
  for (const local of latest.companies) if (!known.has(local.name) && !current.companies.some(c => c.name === local.name && c.updatedAt === local.updatedAt)) companies.push(local);
  return store.saveSetting(key, { ...latest, companies, syncedAt: new Date().toISOString() });
}
