import { classifyFeishuError } from './feishu-monitor.mjs';
import { listDriveFolder } from './industry.mjs';
import { runLark } from './lark-cli.mjs';
import { ServiceError } from './service-error.mjs';

export const escapeXml = value => String(value).replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[c]);
export const plainXml = value => value.replace(/<[^>]*>/g, '').replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, entity) => ({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'",
})[entity]);
export const jsonBlock = value => '<pre lang="json"><code>' + escapeXml(JSON.stringify(value)) + '</code></pre>';
export function documentToken(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port &&
      /(^|\.)(feishu\.cn|larksuite\.com)$/.test(parsed.hostname)) {
      return /^\/(?:docx|docs|wiki)\/([\w-]+)\/?$/.exec(parsed.pathname)?.[1];
    }
  } catch {}
}

export class QueuedSaveDocuments {
  constructor(command, run) { this.command = command; this.run = run; }
  async call(app, args, input, timeout = 20_000) {
    let response;
    try {
      const result = await runLark(this.command, [...(app?.profile ? ['--profile', app.profile] : []), ...args, '--as', 'user'],
        { input, timeout, maxBuffer: 12 * 1024 * 1024 }, this.run);
      response = JSON.parse(typeof result === 'string' ? result : result.stdout);
    } catch (cause) {
      const code = classifyFeishuError(cause);
      // CLI remote errors can be printed on stdout with a nonzero exit status.
      try { response = JSON.parse(cause.stdout); } catch {}
      if (!response) {
        const error = new ServiceError(503, '飞书操作暂未确认，平台将重新核对');
        error.definitelyRejected = cause.code === 'ENOENT' || code === 'CLI_NOT_FOUND';
        throw error;
      }
    }
    if (response?.ok === false || response?.code && Number(response.code) !== 0) {
      const code = classifyFeishuError({ message: JSON.stringify(response) });
      const error = new ServiceError(['PERMISSION_DENIED', 'AUTH_EXPIRED'].includes(code) ? 428 : 503,
        ['PERMISSION_DENIED', 'AUTH_EXPIRED'].includes(code) ? '请恢复原飞书账号的授权后重试保存' : '飞书暂未确认操作成功');
      const type = response.error?.type;
      error.definitelyRejected = ['validation', 'auth', 'permission'].includes(type) || error.status === 428;
      throw error;
    }
    return response?.data ?? response;
  }
  async files(app, parent) {
    const listing = await listDriveFolder(this.run, app, parent ?? '', { command: this.command });
    if (listing.truncated) throw new ServiceError(503, '飞书目录读取不完整，稍后重新核对保存结果');
    return listing.files;
  }
  async find(app, parent, title) {
    const matches = (await this.files(app, parent)).filter(file => ['docx', 'doc', 'wiki'].includes(file.shortcut_info?.target_type ?? file.type) &&
      String(file.name).replace(/\.(docx?|md)$/i, '') === title);
    if (matches.length > 1) throw new ServiceError(409, '该目录存在多个同名文档，请核对后重试保存');
    if (matches.length && !documentToken(matches[0].url)) throw new ServiceError(503, '飞书未返回有效文档链接');
    return matches[0]?.url;
  }
  async create(app, parent, title, content, format = 'xml') {
    const data = await this.call(app, ['docs', '+create', ...(parent ? ['--parent-token', parent] : ['--parent-position', 'my_library']),
      '--title', title, ...(content === undefined ? [] : ['--doc-format', format, '--content', '-'])], content);
    const url = data?.document?.url;
    if (!documentToken(url)) throw new ServiceError(503, '飞书创建结果缺少链接，平台将核对目录');
    return url;
  }
  async read(app, url, format = 'xml') {
    const data = await this.call(app, ['docs', '+fetch', '--doc', url, '--doc-format', format,
      ...(format === 'xml' ? ['--detail', 'with-ids'] : [])]);
    const doc = data?.document;
    if (typeof doc?.content !== 'string') throw new ServiceError(503, '飞书未返回可核对的文档内容');
    return { content: doc.content, revision: doc.revision_id,
      title: doc.title ?? plainXml(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/.exec(doc.content)?.[1] ?? ''), id: doc.document_id };
  }
  async update(app, url, revision, content, anchor, replace = false) {
    if (!Number.isSafeInteger(revision) || revision < 1) throw new ServiceError(503, '飞书未返回可用于更新的文档版本');
    const command = anchor ? (replace ? 'block_replace' : 'block_insert_after') : (replace ? 'overwrite' : 'append');
    await this.call(app, ['docs', '+update', '--doc', url, '--revision-id', String(revision), '--doc-format', 'xml',
      '--command', command, ...(anchor ? ['--block-id', anchor] : []), '--content', '-'], content);
  }
  async findFile(app, parent, title) {
    const matches = (await this.files(app, parent)).filter(file => file.type === 'file' && file.name === title);
    if (matches.length > 1) throw new ServiceError(409, '发现重复的资料上传记录，请核对后重试');
    return matches[0]?.url;
  }
  async upload(app, parent, title, path) {
    const data = await this.call(app, ['drive', '+upload', '--file', path, '--folder-token', parent, '--name', title, '--json'], undefined, 120_000);
    const url = data?.url ?? data?.file_url;
    if (typeof url === 'string' && /^https:\/\//.test(url)) return url;
    const uploaded = await this.findFile(app, parent, title);
    if (uploaded) return uploaded;
    throw new ServiceError(503, '上传结果缺少链接，平台将重新核对');
  }
  async rename(app, url, title, extension) {
    await this.call(app, ['drive', '+update-title', '--url', url, '--title', title,
      ...(extension ? ['--on-extension-mismatch', extension] : [])]);
  }
}
