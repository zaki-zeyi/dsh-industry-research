import { createHash } from 'node:crypto';
import { libraryKey, listDriveFolder } from './industry.mjs';
import { LibraryRefreshError } from './library-errors.mjs';

const labels = { daily: '日报', weekly: '周报' };
const isDocument = file => ['docx', 'doc'].includes(file.type) && /^https:\/\//.test(file.url ?? '');
const idFor = url => 'cloud-' + createHash('sha256').update(url).digest('hex').slice(0, 24);
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
  const child = async (parent, name) => {
    const matches = (await list(parent)).filter(f => f.type === 'folder' && f.name === name);
    if (matches.length > 1) throw new LibraryRefreshError('LIBRARY_DUPLICATES', `飞书存在多个同名【${name}】目录，请核对后刷新；本地记录已保留`);
    return matches[0]?.token;
  };
  let folderToken;
  if (kind === 'internal') {
    const material = await child(root.folderToken, directoryName);
    if (material) folderToken = await child(material, '逐字稿');
  } else {
    folderToken = await child(root.folderToken, labels[kind]);
  }
  const files = folderToken ? await list(folderToken) : [];
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
