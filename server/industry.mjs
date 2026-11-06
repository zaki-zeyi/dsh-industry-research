import { larkLaunch } from './lark-launch.mjs';
import { companyReceiptSchema } from './agent-delivery.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { LibraryRefreshError, libraryReadError } from './library-errors.mjs';
import { createHash } from 'node:crypto';
import { folderTokenFromUrl } from './feishu-folder.mjs';
import { DEFAULT_COMPANIES, DEFAULT_DIMENSIONS, DEFAULT_SOURCES } from './industry-defaults.mjs';
export { DEFAULT_COMPANIES, DEFAULT_DIMENSIONS, DEFAULT_SOURCES };
const label = z.string().trim().min(1).max(120).refine(v => !/[\x00-\x1f\x7f]/.test(v), '名称不能包含控制字符');
const choices = z.array(label).min(1).max(60).transform(v => [...new Set(v)]);
export const industryInputSchema = z.object({ companies: choices, dimensions: choices, sources: choices, requirements: z.string().trim().max(2000).default(''), prompt: z.string().trim().min(10).max(14000).optional() }).strict();
export const preferencesSchema = z.object({ dimensions: choices, sources: choices }).strict();
export function preferences(store) { return store.setting('industry-preferences') ?? { dimensions: DEFAULT_DIMENSIONS, sources: DEFAULT_SOURCES }; }
// Keep the logical namespace for existing scheduler/lock records. Company
// documents use the actual root token once known, independently of its label.
export function libraryNamespaceKey(root, app) { return 'industry-library:' + createHash('sha256').update(JSON.stringify([app?.profile ?? 'default', app?.appId ?? '', root.rootName ?? root.folderUrl ?? ''])).digest('hex'); }
const rootToken = root => root.folderToken ?? folderTokenFromUrl(root.folderUrl);
export function libraryKey(root, app) {
  const token=rootToken(root);
  return token ? 'industry-library-root:' + createHash('sha256').update(JSON.stringify([app?.profile ?? 'default',app?.appId ?? '',token])).digest('hex') : libraryNamespaceKey(root,app);
}
export function library(store, root, app) {
  const key=libraryKey(root,app), token=rootToken(root), exact=store.setting(key);
  if(exact)return exact;
  const legacy=token && store.setting(libraryNamespaceKey(root,app));
  if(legacy){
    // Old releases did not always stamp the root. Recover only when task
    // receipts prove a unique root for the cached document; never guess by name.
    const roots=new Set((store.list?.()??[]).filter(t=>libraryNamespaceKey(t.feishuRoot??{},t.feishuApp)===libraryNamespaceKey(root,app)
      && t.feishuRoot?.folderToken && (legacy.manifestUrl && (t.industryLibrary?.manifestUrl===legacy.manifestUrl || t.analysisSources?.manifestUrl===legacy.manifestUrl)
        || legacy.companies?.some(c=>c.url===t.publication?.url))).map(t=>t.feishuRoot.folderToken));
    const provenRoot=legacy.rootFolderToken ?? (roots.size===1?[...roots][0]:null);
    if(provenRoot===token)return store.saveSetting(key,{...legacy,rootFolderToken:token});
  }
  return {companies:[],folderToken:null};
}
export function industryPrompt(input) {
  return `帮我对【${input.companies.join('、')}】在【${input.sources.join('、')}】进行【${input.dimensions.join('、')}】的调研${input.requirements ? `，并满足【${input.requirements}】` : ''}，按维度就地合并到飞书云盘【全量信息库】对应公司文档，不新增“增量更新”章节。并呈现本次更新摘要。`;
}
export function mergeCompanyDelivery(store, task, delivery) {
  const research = task.industry ?? task.briefing ?? task.internal?.research;
  if (!research || !delivery.libraryFolderToken) return;
  const key = libraryKey(task.feishuRoot, task.feishuApp), current = library(store, task.feishuRoot, task.feishuApp);
  if (current.manifestUrl && delivery.manifestUrl && delivery.manifestUrl !== current.manifestUrl) throw new Error('必须复用已有公司索引文档');
  if (current.folderToken && delivery.libraryFolderToken !== current.folderToken) throw new Error('全量信息库目录与已有目录不一致');
  if (!delivery.libraryFolderToken) throw new Error('缺少全量信息库目录 ID');
  const names = new Set(); const urls = new Set();
  for (const c of delivery.companies ?? []) {
    if (!research.companies.includes(c.name) || names.has(c.name) || urls.has(c.url)) throw new Error('公司交付包含未请求公司或重复文档');
    const previous = current.companies.find(v => v.name === c.name);
    if (previous && previous.url !== c.url) throw new Error('已收录公司必须更新原文档，禁止重复创建');
    if (current.companies.some(v => v.name !== c.name && v.url === c.url)) throw new Error('不同公司不能使用同一文档');
    names.add(c.name); urls.add(c.url);
  }
  const byName = new Map(current.companies.map(c => [c.name, c]));
  for (const c of delivery.companies ?? []) byName.set(c.name, { ...c, dimensions: [...new Set([...(byName.get(c.name)?.dimensions ?? []), ...c.dimensions])], updatedAt: c.updatedAt ?? new Date().toISOString(), taskId: task.id });
  store.saveSetting(key, { rootFolderToken:rootToken(task.feishuRoot), folderToken: delivery.libraryFolderToken, manifestUrl: delivery.manifestUrl ?? current.manifestUrl, companies: [...byName.values()] });
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
const defaultExec = promisify(execFile);
const importPageSize = 200, importLimit = 1000;
const importExcludedNames = new Set(['公司索引', '分析报告索引', '友商分析', '日报', '周报', '内部资料']);
function cliArgs(app, args) { return [...(app?.profile ? ['--profile', app.profile] : []), ...args]; }
async function runLarkCli(run, app, args, { command, timeout = 20000 } = {}) {
  const local = resolve(homedir(), '.local/bin/lark-cli');
  const executable = command ?? (existsSync(local) ? local : 'lark-cli');
  const launch = run === defaultExec ? larkLaunch(executable, args) : { command: executable, args };
  try {
    const result = await run(launch.command, launch.args, { timeout, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
    return typeof result === 'string' ? result : result?.stdout ?? '';
  } catch (error) { throw libraryReadError(error); }
}
function parseLarkJson(stdout) {
  try { return JSON.parse(stdout); }
  catch { throw new LibraryRefreshError('LIBRARY_INVALID_RESPONSE', 'Lark CLI 返回格式异常，请检查 CLI 后重试；本地已同步记录保留'); }
}
function larkData(response) { return response?.data ?? response ?? {}; }
function throwLarkFailure(response, stdout) { if (response?.ok === false) throw libraryReadError({ stdout }); }
function cleanFileName(value) { return String(value ?? '').trim().replace(/\.(docx?|md)$/i, '').trim(); }
function fileToken(file) { return file?.shortcut_info?.target_token ?? file?.token; }
function fileType(file) { return String(file?.shortcut_info?.target_type ?? file?.type ?? '').toLowerCase(); }
function isFolder(file) { return fileType(file) === 'folder'; }
function isCompanyDocument(file) { return ['docx', 'doc', 'wiki'].includes(fileType(file)) && /^https:\/\//.test(String(file?.url ?? '')); }
function fileUpdatedAt(file) {
  const value = Number(file?.modified_time);
  if (!Number.isFinite(value) || value <= 0) return new Date().toISOString();
  return new Date(value > 1e12 ? value : value * 1000).toISOString();
}
export async function listDriveFolder(run = defaultExec, app, token, options = {}) {
  const files = []; let pageToken; let pages = 0;
  do {
    const args = cliArgs(app, ['drive', 'files', 'list', '--folder-token', token, '--as', 'user', '--json', '--page-size', String(importPageSize), ...(pageToken ? ['--page-token', pageToken] : [])]);
    const stdout = await runLarkCli(run, app, args, options);
    const response = parseLarkJson(stdout); throwLarkFailure(response, stdout);
    const data = larkData(response);
    if(!Array.isArray(data.files))throw new LibraryRefreshError('LIBRARY_INVALID_RESPONSE','飞书目录响应缺少文件列表，当前目录缓存已保留，请重试');
    files.push(...data.files);
    pageToken = data.has_more === false ? null : (data.next_page_token ?? data.page_token ?? null);
    if(data.has_more === true && !pageToken)throw new LibraryRefreshError('LIBRARY_INVALID_RESPONSE','飞书目录分页响应不完整，无法确认目录是否存在；未创建文件夹');
    pages++;
  } while (pageToken && pages < Math.ceil(importLimit / importPageSize));
  return { files: files.slice(0, importLimit), truncated: Boolean(pageToken) || files.length > importLimit };
}
async function fetchDocumentContent(run, app, docUrl, options = {}) {
  const stdout = await runLarkCli(run, app, cliArgs(app, ['docs', '+fetch', '--doc', docUrl, '--doc-format', 'markdown', '--as', 'user']), options);
  const response = parseLarkJson(stdout); throwLarkFailure(response, stdout);
  const content = larkData(response).document?.content;
  if (typeof content !== 'string') throw new LibraryRefreshError('LIBRARY_INVALID_RESPONSE', '公司索引内容为空或格式异常，请在原会话检查后重试；本地已同步记录保留');
  return content;
}
function companiesFromFiles(files) {
  const names = new Set(), urls = new Set(), companies = [];
  for (const file of files) {
    const name = cleanFileName(file?.name), url = String(file?.url ?? '');
    if (!name || importExcludedNames.has(name) || names.has(name) || urls.has(url) || !isCompanyDocument(file)) continue;
    names.add(name); urls.add(url);
    companies.push({ name, url, dimensions: [], added: 0, conflicts: 0, updatedAt: fileUpdatedAt(file) });
  }
  return companies;
}
function relatedTaskId(store, root, app, name, url) {
  const key = libraryKey(root, app);
  return store.list?.().find(task => task.industry?.companies?.includes(name) && libraryKey(task.feishuRoot, task.feishuApp) === key
    && (task.publication?.url===url || task.industryLibrary?.companies?.some(c=>c.name===name&&c.url===url)))?.id;
}
function mergeImportedCompanies(store, root, app, before, latest, imported) {
  const companies=imported.map(company=>{
    const previous=latest.find(c=>c.name===company.name && c.url===company.url);
    if(!previous)return {...company,taskId:relatedTaskId(store,root,app,company.name,company.url)};
    return {...previous,...company,taskId:previous.taskId??relatedTaskId(store,root,app,company.name,company.url),
      dimensions:[...new Set([...(previous.dimensions??[]),...(company.dimensions??[])])]};
  });
  // Preserve only deliveries made while this read was in flight. Pre-existing
  // entries absent from the complete remote snapshot are no longer displayed.
  const names=new Set(companies.map(c=>c.name));
  for(const c of latest)if(!names.has(c.name)&&!before.some(old=>JSON.stringify(old)===JSON.stringify(c)))companies.push(c);
  return companies;
}
async function discoverLibrary(run, app, root, { command, libraryFolderToken: selectedToken } = {}) {
  const rootListing = selectedToken ? {files:[],truncated:false} : await listDriveFolder(run, app, root.folderToken, { command });
  if (rootListing.truncated) throw new LibraryRefreshError('LIBRARY_TOO_LARGE', '目录读取未完成，已保留当前目录缓存，请缩小目录后重试');
  const matches = rootListing.files.filter(file => isFolder(file) && cleanFileName(file.name) === '全量信息库');
  if(matches.length > 1)throw new LibraryRefreshError('LIBRARY_FOLDER_AMBIGUOUS','根目录下存在多个【全量信息库】，请先核对唯一目录后再导入；本地记录保留',409);
  const libraryFolderToken = selectedToken ?? fileToken(matches[0]) ?? null;
  const listing = libraryFolderToken ? await listDriveFolder(run, app, libraryFolderToken, { command }) : { files: [], truncated: false };
  if (listing.truncated) throw new LibraryRefreshError('LIBRARY_TOO_LARGE', '公司目录读取未完成，已保留当前目录缓存，请缩小目录后重试');
  const indexes = listing.files.filter(file => isCompanyDocument(file) && cleanFileName(file.name) === '公司索引');
  if(indexes.length > 1)throw new LibraryRefreshError('LIBRARY_INDEX_AMBIGUOUS','信息库存在多个【公司索引】，请先核对；本地记录保留',409);
  const index = indexes[0];
  if (!index) return { imported: companiesFromFiles(listing.files), indexFound: false, manifestUrl: null, libraryFolderToken, listing };
  const manifestUrl = String(index.url);
  const imported = parseLibraryManifest(await fetchDocumentContent(run, app, manifestUrl, { command }));
  return { imported, indexFound: true, manifestUrl, libraryFolderToken, listing };
}
export async function importLibrary(store, root, app, run = defaultExec, { command, rediscover = false, libraryFolderToken: selectedToken } = {}) {
  if (!root?.folderToken) return { status: 'skipped', imported: 0, total: library(store, root, app).companies.length, libraryFolderFound: false, indexFound: false, message: '设置已保存。目录将在首次调研时创建，创建后请再次点击“保存设置并导入”。' };
  const key = libraryKey(root, app), current = library(store, root, app);
  // Once the company index is known, read it directly. Folder listing needs an
  // optional drive scope that many Feishu apps do not request; importing must
  // not fail just because that one-time discovery permission is absent.
  const canUseKnownIndex = !rediscover && Boolean(current.manifestUrl) && (current.rootFolderToken === root.folderToken || Boolean(store.setting(key)) && key.startsWith('industry-library-root:'));
  let imported, indexFound, manifestUrl, libraryFolderToken = current.folderToken, listing;
  if (canUseKnownIndex) {
    manifestUrl = current.manifestUrl;
    indexFound = true;
    try {
      imported = parseLibraryManifest(await fetchDocumentContent(run, app, manifestUrl, { command }));
    } catch (error) {
      // The cached index can be deleted or replaced in Feishu. Fall through to
      // folder discovery so the user does not have to clear local state.
      if (error?.code !== 'LIBRARY_DOCUMENT_DELETED') throw error;
    }
  }
  if (imported === undefined) {
    ({ imported, indexFound, manifestUrl, libraryFolderToken, listing } = await discoverLibrary(run, app, root, { command, libraryFolderToken: selectedToken }));
  }
  const syncedAt = new Date().toISOString();
  const latest=library(store,root,app);
  if(latest.manifestUrl!==current.manifestUrl||latest.folderToken!==current.folderToken)throw new LibraryRefreshError('LIBRARY_CHANGED','同步期间公司目录已变化，请刷新重试',409);
  const companies = mergeImportedCompanies(store, root, app, current.companies, latest.companies, imported);
  const saved = store.saveSetting(key, {
    ...current,
    folderToken: libraryFolderToken ?? null,
    manifestUrl: manifestUrl ?? null,
    ...(root.folderToken ? { rootFolderToken: root.folderToken } : {}),
    companies,
    syncedAt,
    ...(imported.length ? { importedAt: syncedAt } : {}),
  });
  if (!imported.length) return { status: 'empty', imported: 0, total: saved.companies.length, libraryFolderFound: Boolean(libraryFolderToken), indexFound, syncedAt, ...(listing ? { truncated: listing.truncated } : {}), message: '设置已保存，但飞书目录中没有找到可导入的公司。' };
  const source = indexFound ? '公司索引' : '公司文档';
  return { status: 'completed', imported: imported.length, total: saved.companies.length, libraryFolderFound: Boolean(libraryFolderToken), indexFound, syncedAt, ...(listing ? { truncated: listing.truncated } : {}), message: `已从${source}导入 ${imported.length} 家公司${saved.companies.length > imported.length ? `，当前共收录 ${saved.companies.length} 家` : ''}。` };
}
export async function refreshLibrary(store, root, app, run = defaultExec, { command } = {}) {
  const key = libraryKey(root, app), current = library(store, root, app);
  if (!current.manifestUrl) return rootToken(root) ? importLibrary(store,root,app,run,{command}) : current;
  const args = [...(app?.profile ? ['--profile', app.profile] : []), 'docs', '+fetch', '--doc', current.manifestUrl, '--doc-format', 'markdown', '--as', 'user'];
  const local = resolve(homedir(), '.local/bin/lark-cli');
  let stdout;
  try {
    const executable = command ?? (existsSync(local) ? local : 'lark-cli');
    const launch = run === defaultExec ? larkLaunch(executable, args) : { command: executable, args };
    ({ stdout } = await run(launch.command, launch.args, { timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } }));
  } catch (e) {
    const error = libraryReadError(e);
    if (error.code === 'LIBRARY_DOCUMENT_DELETED' && rootToken(root)) {
      await importLibrary(store, root, app, run, { command, rediscover: true });
      return library(store, root, app);
    }
    throw error;
  }
  let response;
  try { response = JSON.parse(stdout); } catch { throw new LibraryRefreshError('LIBRARY_INVALID_RESPONSE', 'Lark CLI 返回格式异常，请检查 CLI 后重试；本地已同步记录保留'); }
  if (!response.ok) {
    const error = libraryReadError({ stdout });
    if (error.code === 'LIBRARY_DOCUMENT_DELETED' && rootToken(root)) {
      await importLibrary(store, root, app, run, { command, rediscover: true });
      return library(store, root, app);
    }
    throw error;
  }
  const remote = parseLibraryManifest(response.data?.document?.content);
  // A task may deliver another company while the remote fetch is in flight. Merge
  // against the latest local index and retain entries newer than this snapshot.
  const latest = library(store, root, app);
  if (latest.manifestUrl !== current.manifestUrl || latest.folderToken !== current.folderToken) throw new LibraryRefreshError('LIBRARY_CHANGED', '同步期间公司索引已改变，请刷新重试；本地记录保留', 409);
  const localByName = new Map(latest.companies.map(c => [c.name, c]));
  const companies = remote.map(c => {
    const local = localByName.get(c.name);
    if (local?.url===c.url && Date.parse(local.updatedAt) > Date.parse(c.updatedAt)) return local;
    const related = (local?.url===c.url ? local.taskId : undefined) ?? relatedTaskId(store,root,app,c.name,c.url);
    return { ...c, taskId: related };
  });
  const known = new Set(companies.map(c => c.name));
  // Keep only entries delivered during this request, not remotely removed entries.
  for (const local of latest.companies) if (!known.has(local.name) && !current.companies.some(c => c.name === local.name && c.updatedAt === local.updatedAt)) companies.push(local);
  return store.saveSetting(key, { ...latest, companies, syncedAt: new Date().toISOString() });
}
