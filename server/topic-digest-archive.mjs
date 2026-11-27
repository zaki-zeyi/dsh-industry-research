import { driveType, folderName } from './folder-identity.mjs';
import { documentToken } from './queued-save-documents.mjs';
import { ServiceError } from './service-error.mjs';
import { topicTotalTitle } from './topic-defaults.mjs';
import { TOPIC_DIGEST_FOLDER, topicFolderKey, topicScope } from './topics.mjs';

const isDocument = file => ['docx', 'doc', 'wiki'].includes(driveType(file));
const dateInTitle = /^汇总日报 · (\d{4}-\d{2}-\d{2})(?:\.docx?)?$/i;
const legacyTitles = new Set([topicTotalTitle(TOPIC_DIGEST_FOLDER), '总报',
  '专题总报 · ' + TOPIC_DIGEST_FOLDER, '专题调研 · ' + TOPIC_DIGEST_FOLDER, TOPIC_DIGEST_FOLDER]);

export function digestTitleDate(file) {
  if (!isDocument(file)) return;
  const date = dateInTitle.exec(folderName(file.name))?.[1];
  const time = Date.parse(date);
  if (Number.isFinite(time) && new Date(time).toISOString().startsWith(date + 'T')) return date;
}

export function digestFileDate(file) {
  if (documentToken(file.url)) return digestTitleDate(file);
}

// A legacy topic must have positive ownership or a recognizable topic layout.
// Arbitrary files do not establish ownership of the reserved digest archive.
export function ownsLegacyDigestTopic(store, root, app, token, files, tasks = store.list()) {
  const scope = topicScope(root, app);
  return Boolean(token && tasks.some(task => task.topic && task.feishuRoot && !task.remoteOnly && topicScope(task.feishuRoot, task.feishuApp) === scope &&
    [task.topicLibrary?.folderToken, task.publication?.topicFolderToken, store.setting(topicFolderKey(task))?.folderToken].includes(token))) ||
    files.some(file => (driveType(file) === 'folder' && folderName(file.name) === '日报') ||
      (isDocument(file) && legacyTitles.has(folderName(file.name).replace(/\.docx?$/i, ''))));
}

export function digestArchiveConflict(code, message) {
  return Object.assign(new ServiceError(409, message), { code });
}

export function assertDigestArchive(store, root, app, token, files) {
  if (ownsLegacyDigestTopic(store, root, app, token, files)) throw digestArchiveConflict('DIGEST_FOLDER_CONFLICT', '汇总目录属于已有同名专题，未写入或移动任何文件');
}

// Classify by title before link validation: an unusable same-day entry is
// evidence, not permission to create another copy.
export function uniqueDigestDocument(files, date) {
  const candidates = files.filter(file => digestTitleDate(file) === date);
  if (candidates.some(file => !documentToken(file.url))) throw digestArchiveConflict('DIGEST_DOCUMENT_LINK_INVALID', '当天的汇总文档缺少可核对的飞书链接，未重复创建');
  const urls = [...new Set(candidates.map(file => file.url))];
  if (urls.length > 1) throw digestArchiveConflict('DIGEST_DOCUMENT_CONFLICT', '飞书有多份同日汇总，请先核对存储目录');
  return urls[0];
}
