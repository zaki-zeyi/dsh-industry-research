export class LibraryRefreshError extends Error {
  constructor(code, message, status = 502) { super(message); this.code = code; this.status = status; }
}
export function libraryReadError(error) {
  if (error instanceof LibraryRefreshError) return error;
  if (error?.code === 'ENOENT') return new LibraryRefreshError('LARK_CLI_UNAVAILABLE', '未找到 Lark CLI，请检查安装路径；本地已同步记录保留');
  if (error?.killed || error?.code === 'ETIMEDOUT') return new LibraryRefreshError('LIBRARY_TIMEOUT', '读取飞书索引超时，请稍后重试；本地已同步记录保留');
  // Only classify known auth/permission codes; never expose raw stdout/stderr (may contain credentials).
  const output = String(error?.stdout || error?.stderr || '');
  if (/9999166[138]|9999167[12]|ACCESS_TOKEN_INVALID|TOKEN_EXPIRED|UNAUTHENTICATED/.test(output)) return new LibraryRefreshError('FEISHU_AUTH_REQUIRED', '飞书授权失效，请重新绑定飞书；本地已同步记录保留');
  if (/missing_scope|does not cover the required scope|space:document:retrieve/i.test(output)) return new LibraryRefreshError('FEISHU_DRIVE_SCOPE_REQUIRED', '飞书授权缺少云盘目录读取权限，请重新绑定并完成授权；本地已同步记录保留');
  if (/3380003|Document page has been deleted|document\s+(?:page\s+)?(?:has been|was)\s+deleted|文档(?:页)?已(?:被)?删除/i.test(output)) return new LibraryRefreshError('LIBRARY_DOCUMENT_DELETED', '公司索引文档已被删除，正在尝试从飞书目录重新导入；本地已同步记录保留');
  if (/99991679|PERMISSION_DENIED|FORBIDDEN/.test(output)) return new LibraryRefreshError('FEISHU_DOCUMENT_DENIED', '无权读取公司索引，请检查文档访问权限；本地已同步记录保留');
  return new LibraryRefreshError('LIBRARY_READ_FAILED', '读取飞书索引失败，请检查 CLI 或网络后重试；本地已同步记录保留');
}
