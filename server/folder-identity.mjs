export const driveToken = file => file.shortcut_info?.target_token ?? file.token;
export const driveType = file => String(file.shortcut_info?.target_type ?? file.type ?? '').toLowerCase();
export const folderName = value => String(value ?? '').normalize('NFC').trim();
export function matchingFolders(files, name) {
  const unique = new Map();
  for (const file of files) if (driveType(file) === 'folder' && folderName(file.name) === folderName(name)) {
    const token = driveToken(file);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(token)) throw Object.assign(new Error('已有飞书目录缺少有效 ID，禁止新建替代目录'), { status: 409, code: 'FOLDER_INVALID_RESPONSE' });
    unique.set(token, file);
  }
  return [...unique.values()];
}
// Reuse the known target; otherwise prefer the oldest existing directory.
// Token order breaks ties without depending on API pagination/list order.
export function preferredFolder(files, name, knownToken) {
  const matches = matchingFolders(files, name);
  const known = matches.find(file => driveToken(file) === knownToken);
  const created = file => Number(file.created_time) > 0 ? Number(file.created_time) : Infinity;
  return known ?? matches.sort((a, b) => (created(a) - created(b) || (driveToken(a) < driveToken(b) ? -1 : driveToken(a) > driveToken(b) ? 1 : 0)))[0];
}
