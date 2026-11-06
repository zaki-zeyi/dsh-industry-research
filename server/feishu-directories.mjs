import { createHash } from 'node:crypto';
import { runLark } from './lark-cli.mjs';
import { folderCacheKey } from './feishu-folder.mjs';
import { listDriveFolder, importLibrary, library } from './industry.mjs';
import { analysisKey, analysisLibrary } from './analysis.mjs';
import { briefingKey, labelFor } from './briefings.mjs';
import { internalFolderKey } from './internal-materials.mjs';
import { recordTrace } from './connection-trace.mjs';
import { classifyFeishuError } from './feishu-monitor.mjs';

const failure = (code, message) => Object.assign(new Error(message), { code, status: 409 });
const tokenOf = file => file.shortcut_info?.target_token ?? file.token;
const typeOf = file => file.shortcut_info?.target_type ?? file.type;
const keyFor = (parent, name, app) => 'feishu-directory:' + createHash('sha256').update(JSON.stringify([
  // Child tokens identify the actual shared parent, independently of account,
  // application, display name, or the machine's old profile cache.
  parent || [app?.profile, app?.appId, app?.ownerOpenId], name,
])).digest('hex');

export function uniqueFolder(files, name, knownToken) {
  const matches = files.filter(f => typeOf(f) === 'folder' && f.name === name);
  const known = knownToken && matches.find(f => tokenOf(f) === knownToken);
  if (known) return known;
  if (matches.length > 1) throw failure('FOLDER_AMBIGUOUS', `飞书目录【${name}】存在多个同名文件夹，请先整理或指定唯一目录后重试；未新建或删除任何同名文件夹`);
  return matches[0];
}

// One resolver per runtime. Its queue also serializes different profiles that
// access the same shared root; the normal write lock still owns document writes.
export class FeishuDirectories {
  constructor(store, { command = 'lark-cli', run } = {}) {
    this.store = store; this.command = command; this.run = run; this.tail = Promise.resolve();
  }
  async json(app, args) {
    const selected = [...(app?.profile ? ['--profile', app.profile] : []), ...args];
    let response;
    try {
      const result = await runLark(this.command, selected, {
        timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true,
        env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
      }, this.run);
      response = JSON.parse(typeof result === 'string' ? result : result.stdout);
    } catch (cause) {
      throw Object.assign(failure(classifyFeishuError(cause), '飞书目录创建未确认，请检查 CLI 或网络后重试；不会盲目重复创建'), { cause, notStarted: cause.code === 'ENOENT' });
    }
    if (response.ok === false || response.code && Number(response.code) !== 0) throw Object.assign(failure('FOLDER_REQUEST_FAILED', '飞书目录操作被拒绝，请检查权限后重试'), { rejected: true });
    return response.data ?? response;
  }
  async list(app, parent) {
    const listing = await listDriveFolder(this.run, app, parent, { command: this.command });
    if (listing.truncated) throw failure('FOLDER_LIST_INCOMPLETE', '飞书目录未读取完整，无法确认同名目录是否存在；未创建文件夹');
    return listing.files;
  }
  async folder(app, parent, name, signal, provenToken) {
    const key = keyFor(parent, name, app), cached = this.store.setting(key);
    signal?.throwIfAborted();
    // Only this resolver's confirmed, parent-scoped records may bypass lookup.
    // Older profile-scoped tokens are not evidence of the selected parent.
    if (cached?.token) return cached.token;
    if (provenToken) { this.store.saveSetting(key, { token: provenToken }); return provenToken; }
    const files = await this.list(app, parent);
    const existing = uniqueFolder(files, name);
    signal?.throwIfAborted();
    if (existing) {
      const token = tokenOf(existing);
      if (!token) throw failure('FOLDER_INVALID_RESPONSE', '飞书已有目录缺少 ID，未新建文件夹');
      this.store.saveSetting(key, { token }); return token;
    }
    if (cached?.pending) throw failure('FOLDER_CREATE_UNCONFIRMED', `【${name}】上次创建结果尚未确认，请先在飞书核对；不会重复创建`);
    // Persist intent before a non-idempotent call. A timeout or a crashed host
    // must not turn the next retry into another create request.
    this.store.saveSetting(key, { pending: true });
    let created;
    try { created = await this.json(app, ['drive', '+create-folder', ...(parent ? ['--folder-token', parent] : []), '--name', name, '--as', 'user', '--json']); }
    catch (error) {
      // A spawn failure or explicit API rejection proves no create completed.
      // Network timeouts, malformed output and process crashes do not.
      if (error.notStarted || error.rejected) this.store.saveSetting(key, null);
      throw error;
    }
    const token = created.folder_token ?? created.token;
    if (!token || typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(token)) throw failure('FOLDER_CREATE_UNCONFIRMED', `【${name}】创建响应缺少有效 ID，请先在飞书核对；不会重复创建`);
    this.store.saveSetting(key, { token });
    signal?.throwIfAborted();
    return token;
  }
  async index(app, folderToken, name) {
    const matches = (await this.list(app, folderToken)).filter(f => ['doc', 'docx', 'wiki'].includes(typeOf(f)) && String(f.name).replace(/\.(docx?|md)$/i, '') === name);
    if (matches.length > 1) throw failure('FOLDER_INDEX_AMBIGUOUS', `【${name}】存在多个同名索引，请先核对；不会重复创建索引`);
    if (matches.length && !/^https:\/\//.test(matches[0].url ?? '')) throw failure('FOLDER_INVALID_RESPONSE', `已有【${name}】缺少文档链接，请先核对`);
    return matches[0]?.url ?? null;
  }
  prepare(task, signal) {
    const job = this.tail.then(async () => {
      const started = Date.now(), details = { taskId: task.id, appId: task.feishuApp?.appId, phase: 'directory_resolution' };
      recordTrace(this.store, 'feishu.directories.started', { ...details, status: 'started' });
      try {
        await this.resolve(task, signal);
        recordTrace(this.store, 'feishu.directories.finished', { ...details, status: 'completed', durationMs: Date.now() - started });
      } catch (error) {
        recordTrace(this.store, 'feishu.directories.failed', { ...details, status: 'failed', code: error.code ?? classifyFeishuError(error), durationMs: Date.now() - started }, 'error');
        throw error;
      }
    });
    this.tail = job.catch(() => {}); return job;
  }
  async resolve(task, signal) {
    const app = task.feishuApp, store = this.store;
    const root = task.feishuRoot;
    signal?.throwIfAborted();
    const legacyRoot = !root.folderToken && store.setting(folderCacheKey(root));
    if (legacyRoot?.owner && !store.setting(keyFor('', root.rootName, app))) store.saveSetting(keyFor('', root.rootName, app), { pending: true });
    root.folderToken ??= await this.folder(app, '', root.rootName, signal);
    delete root.creationUncertain;
    if (!root.folderUrl) store.saveSetting(folderCacheKey(root), { folderToken: root.folderToken });
    const get = (parent, name, provenToken) => this.folder(app, parent, name, signal, provenToken);
    const proven = (record, field, receiptField, accepts) => record?.[field] && (
      record.rootFolderToken === root.folderToken || (store.list?.() ?? []).some(old =>
        old.feishuRoot?.folderToken === root.folderToken && accepts(old) && old.publication?.[receiptField] === record[field])
    ) ? record[field] : undefined;
    if (task.industry || task.briefing || task.internal) {
      const current = library(store, root, app);
      const token = await get(root.folderToken, '全量信息库', proven(current, 'folderToken', 'libraryFolderToken', () => true));
      if (current.folderToken !== token || !current.manifestUrl) {
        await importLibrary(store, root, app, this.run, { command: this.command, rediscover: true, libraryFolderToken: token });
      }
      task.industryLibrary = library(store, root, app);
    }
    if (task.briefing) {
      const previous = store.setting(briefingKey(task));
      const folderToken = await get(root.folderToken, labelFor(task.briefing.kind), proven(previous, 'folderToken', 'reportFolderToken', old => old.briefing?.kind === task.briefing.kind));
      task.briefingLibrary = store.saveSetting(briefingKey(task), { rootFolderToken: root.folderToken, folderToken });
    }
    if (task.analysis) {
      const current = analysisLibrary(store, root, app);
      const folderToken = await get(root.folderToken, '友商分析', proven(current, 'folderToken', 'analysisFolderToken', old => Boolean(old.analysis)));
      const same = current.folderToken === folderToken;
      const manifestUrl = same && current.manifestUrl || await this.index(app, folderToken, '分析报告索引');
      task.analysisIndex = store.saveSetting(analysisKey(root, app), { ...(same ? current : { reports: [] }), rootFolderToken: root.folderToken, folderToken, manifestUrl });
    }
    if (task.internal) {
      const name = task.internal.directoryName ?? '内部资料', previous = store.setting(internalFolderKey(task));
      const oldMaterial = proven(previous, 'materialFolderToken', 'materialFolderToken', old => old.internal && (old.internal.directoryName ?? '内部资料') === name);
      const materialFolderToken = await get(root.folderToken, name, oldMaterial);
      const trustedChildren = oldMaterial === materialFolderToken;
      const sourceFolderToken = await get(materialFolderToken, '原始资料', trustedChildren && previous?.sourceFolderToken || undefined);
      const transcriptFolderToken = await get(materialFolderToken, '逐字稿', trustedChildren && previous?.transcriptFolderToken || undefined);
      const minutesFolderToken = await get(materialFolderToken, '会议纪要', trustedChildren && previous?.minutesFolderToken || undefined);
      task.internalFolders = store.saveSetting(internalFolderKey(task), { rootFolderToken: root.folderToken, materialFolderToken, sourceFolderToken, transcriptFolderToken, minutesFolderToken });
    }
    signal?.throwIfAborted();
  }
}
