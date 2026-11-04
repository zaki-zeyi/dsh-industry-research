import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { analysisReportSchema } from './agent-delivery.mjs';
import { ANALYSIS_FOLDER_NAME, analysisDefaultPrompt, cleanAnalysisTitle } from './analysis-defaults.mjs';
import { library } from './industry.mjs';
import { LibraryRefreshError, libraryReadError } from './library-errors.mjs';

const label = z.string().trim().min(1).max(120).refine(v => !/[\x00-\x1f\x7f]/.test(v), '名称不能包含控制字符');
const uniqueChoices = z.array(label).max(60).transform(v => [...new Set(v)]).refine(v => v.length >= 1, '至少选择一项');

export const analysisInputSchema = z.object({
  companies: z.array(label).max(60).transform(v => [...new Set(v)]).refine(v => v.length >= 2, '至少选择两家公司'),
  dimensions: uniqueChoices,
  prompt: z.string().trim().min(10).max(14000).optional(),
}).strict();

export function analysisKey(root, app) {
  return 'industry-analysis:' + createHash('sha256').update(JSON.stringify([app?.profile ?? 'default', app?.appId ?? '', root.folderUrl ?? root.rootName])).digest('hex');
}

export function analysisLibrary(store, root, app) {
  const current = store.setting(analysisKey(root, app)) ?? { reports: [], folderToken: null, manifestUrl: null, syncedAt: null };
  return { ...current, reports: (current.reports ?? []).map(report => ({ ...report, title: cleanAnalysisTitle(report.title) })) };
}

export function analysisTaskInput(input) {
  const value = analysisInputSchema.parse(input);
  const names = value.companies.length <= 3
    ? value.companies.join(' × ')
    : `${value.companies.slice(0, 2).join(' × ')} 等 ${value.companies.length} 家`;
  return {
    direction: `友商分析 · ${names}`.slice(0, 200),
    sources: '全量信息库',
    prompt: value.prompt ?? analysisDefaultPrompt(value.companies, value.dimensions),
    analysis: value,
  };
}

export function missingAnalysisSources(sourceLibrary, companies) {
  const available = new Set((sourceLibrary?.companies ?? []).filter(c => c.url).map(c => c.name));
  return companies.filter(name => !available.has(name));
}

export function mergeAnalysisDelivery(store, task, delivery) {
  if (!task.analysis) return null;
  if (!delivery.analysisFolderToken) throw new Error('缺少友商分析目录 ID');
  if (!delivery.report) throw new Error('缺少友商分析报告链接');
  const report = delivery.report;
  const expectedCompanies = new Set(task.analysis.companies);
  const expectedDimensions = new Set(task.analysis.dimensions);
  if (report.companies.length !== expectedCompanies.size || report.companies.some(name => !expectedCompanies.has(name))) throw new Error('友商分析报告必须覆盖本次选择的全部公司');
  if (report.dimensions.length !== expectedDimensions.size || report.dimensions.some(name => !expectedDimensions.has(name))) throw new Error('友商分析报告必须覆盖本次选择的全部对比维度');
  if (report.insufficient.some(name => !expectedCompanies.has(name))) throw new Error('资料不足公司必须属于本次选择范围');

  const key = analysisKey(task.feishuRoot, task.feishuApp);
  const current = analysisLibrary(store, task.feishuRoot, task.feishuApp);
  const manifestUrl = delivery.analysisManifestUrl ?? current.manifestUrl;
  if (!manifestUrl) throw new Error('缺少友商分析报告索引链接');
  if (current.folderToken && current.folderToken !== delivery.analysisFolderToken) throw new Error('友商分析目录与已有目录不一致');
  if (current.manifestUrl && current.manifestUrl !== manifestUrl) throw new Error('必须复用已有友商分析报告索引');
  const previous = current.reports.find(item => item.taskId === task.id);
  if (previous && previous.url !== report.url) throw new Error('重试必须复用已有友商分析报告');
  if (current.reports.some(item => item.taskId !== task.id && item.url === report.url)) throw new Error('不同友商分析任务不能使用同一报告文档');

  const entry = { ...report, taskId: task.id };
  const reports = [entry, ...current.reports.filter(item => item.taskId !== task.id && item.url !== report.url)];
  store.saveSetting(key, {
    folderToken: delivery.analysisFolderToken,
    manifestUrl,
    reports,
    syncedAt: current.syncedAt ?? null,
  });
  return entry;
}

const manifestReportSchema = analysisReportSchema.extend({ taskId: z.string().uuid().optional() });

export function parseAnalysisManifest(content) {
  let value;
  try {
    const text = String(content ?? '').trim();
    const start = text.indexOf('{'), end = text.lastIndexOf('}');
    if (start < 0 || end < start) throw new Error('missing JSON');
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LibraryRefreshError('LIBRARY_INVALID_JSON', '友商分析报告索引不是有效 JSON，请在原会话修复索引；本地已同步记录保留');
  }
  const parsed = z.object({ reports: z.array(manifestReportSchema).max(1000) }).safeParse(value);
  if (!parsed.success) throw new LibraryRefreshError('LIBRARY_INVALID_SCHEMA', '友商分析报告索引字段格式不正确，请在原会话核对报告链接、公司、维度和日期；本地已同步记录保留');
  const reports = parsed.data.reports;
  if (new Set(reports.map(r => r.url)).size !== reports.length) throw new LibraryRefreshError('LIBRARY_DUPLICATES', '友商分析报告索引存在重复文档，请在原会话核对；本地已同步记录保留');
  return reports;
}

function analysisReadError(error) {
  if (error instanceof LibraryRefreshError) return error;
  const mapped = libraryReadError(error);
  mapped.message = mapped.message
    .replaceAll('公司索引', '友商分析报告索引')
    .replaceAll('读取飞书索引', '读取友商分析报告索引');
  return mapped;
}

export async function refreshAnalysisLibrary(store, root, app, run = promisify(execFile), { command } = {}) {
  const key = analysisKey(root, app), current = analysisLibrary(store, root, app);
  if (!current.manifestUrl) return current;
  const args = [...(app?.profile ? ['--profile', app.profile] : []), 'docs', '+fetch', '--doc', current.manifestUrl, '--doc-format', 'markdown', '--as', 'user'];
  const local = resolve(homedir(), '.local/bin/lark-cli');
  let stdout;
  try {
    ({ stdout } = await run(command ?? (existsSync(local) ? local : 'lark-cli'), args, { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }));
  } catch (error) {
    throw analysisReadError(error);
  }
  let response;
  try { response = JSON.parse(stdout); } catch { throw new LibraryRefreshError('LIBRARY_INVALID_RESPONSE', 'Lark CLI 返回格式异常，请检查 CLI 后重试；本地已同步记录保留'); }
  if (!response.ok) throw analysisReadError({ stdout });
  const remote = parseAnalysisManifest(response.data?.document?.content);
  const latest = analysisLibrary(store, root, app);
  if (latest.manifestUrl !== current.manifestUrl || latest.folderToken !== current.folderToken) throw new LibraryRefreshError('LIBRARY_CHANGED', '同步期间友商分析报告索引已改变，请刷新重试；本地记录保留', 409);

  const localByUrl = new Map(latest.reports.map(report => [report.url, report]));
  const tasks = store.list?.() ?? [];
  const reports = remote.map(report => {
    const localReport = localByUrl.get(report.url);
    if (localReport && Date.parse(localReport.updatedAt) > Date.parse(report.updatedAt)) return localReport;
    const taskId = localReport?.taskId ?? tasks.find(task => task.analysis && task.analysisReport?.url === report.url)?.id;
    return { ...report, ...(taskId ? { taskId } : {}) };
  });
  const remoteUrls = new Set(reports.map(report => report.url));
  for (const localReport of latest.reports) {
    if (!remoteUrls.has(localReport.url) && !current.reports.some(report => report.url === localReport.url && report.updatedAt === localReport.updatedAt)) reports.push(localReport);
  }
  return store.saveSetting(key, { ...latest, reports, syncedAt: new Date().toISOString() });
}

export { ANALYSIS_FOLDER_NAME };
