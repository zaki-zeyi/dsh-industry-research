import { createHash } from 'node:crypto';
import { libraryKey, listDriveFolder } from './industry.mjs';
import { LibraryRefreshError } from './library-errors.mjs';
import { matchingFolders, driveToken } from './folder-identity.mjs';

const labels = { daily: '日报', weekly: '周报' };
const isDocument = file => ['docx', 'doc'].includes(file.type) && /^https:\/\//.test(file.url ?? '');
const idFor = url => 'cloud-' + createHash('sha256').update(url).digest('hex').slice(0, 24);
async function readFolders(tokens, read) {
  const results = [];
  for (let i = 0; i < tokens.length; i += 4) results.push(...await Promise.all(tokens.slice(i, i + 4).map(read)));
  return results.flat();
}
const timestamp = file => {
  const n = Number(file.modified_time ?? file.created_time);
  return Number.isFinite(n) && n > 0 ? new Date(n > 1e12 ? n : n * 1000).toISOString() : null;
};
export function publicationCacheKey(root, app, kind, directoryName = '内部资料') {
  return `cloud-publications:${libraryKey(root, app)}:${root.folderToken ?? ''}:${kind}:${kind === 'internal' ? directoryName : ''}`;
}

// Read only metadata, on tab entry/manual refresh. Polling serves the cache.
// Never re-create tasks or send notifications for a document found in Drive.
export async function cloudPublications(service, kind, { refresh = false, run } = {}) {
  const root = service.feishuSettings(), app = service.binding?.applicationSnapshot?.();
  const directoryName = service.store.setting('internal-directory-name') ?? '内部资料';
  const key = publicationCacheKey(root, app, kind, directoryName);
  const cached = service.store.setting(key) ?? { items: [] };
  if (!refresh || !service.cloudOnly || !root.folderToken) return cached;
  const list = async token => {
    const result = await listDriveFolder(run, app, token, { command: service.binding?.command });
    if (result.truncated) throw new LibraryRefreshError('LIBRARY_TOO_LARGE', '飞书目录过大，本地记录已保留；请缩小目录后刷新');
    return result.files;
  };
  const children = async (parents, name) => [...new Set(await readFolders(parents, async parent => matchingFolders(await list(parent), name).map(driveToken)))];
  let folderTokens;
  if (kind === 'internal') {
    const materials = await children([root.folderToken], directoryName);
    folderTokens = await children(materials, '逐字稿');
  } else {
    folderTokens = await children([root.folderToken], labels[kind]);
  }
  const files = [...new Map((await readFolders(folderTokens, list)).map(file => [file.url ?? file.token, file])).values()];
  const items = files.filter(isDocument).map(file => {
    const title = String(file.name ?? '').trim() || (labels[kind] ?? '内部资料');
    const common = { id: idFor(file.url), remoteOnly: true, direction: title, status: 'ready', createdAt: timestamp(file), publication: { status: 'published', url: file.url } };
    return kind === 'internal'
      ? { ...common, internal: { directoryName, sourceType: 'url', source: file.url, sourceLabel: title }, publication: { ...common.publication, sourceTitle: title } }
      : { ...common, briefing: { kind, window: { display: '飞书历史报告 · 统计区间见文档' } } };
  });
  // Do not write a result fetched for an application/root that changed mid-request.
  if (publicationCacheKey(service.feishuSettings(), service.binding?.applicationSnapshot?.(), kind, service.store.setting('internal-directory-name') ?? '内部资料') !== key)
    throw new LibraryRefreshError('LIBRARY_CHANGED', '同步期间飞书应用或目录已变化，请重新刷新', 409);
  const result = { items, syncedAt: new Date().toISOString() };
  service.store.saveSetting(key, result);
  return result;
}

export function mergePublicationCards(local, remote) {
  const urls = new Set(local.map(t => t.publication?.url).filter(Boolean));
  return [...local, ...remote.filter(t => !urls.has(t.publication.url))];
}
