import { createHash } from 'node:crypto';

export class DemoPublisher {
  constructor(store, { failPublish = false } = {}) { this.store = store; this.failPublish = failPublish; this.kind = 'demo'; }
  async publish(task, persist, signal) {
    signal.throwIfAborted();
    const publication = { ...task.publication, documentId: task.publication.documentId ?? `demo-${task.id}-v${task.report.version}` };
    persist(publication);
    if (this.failPublish) { this.failPublish = false; throw new Error('验收注入：文档已创建，写入失败'); }
    this.store.putDocument(publication.documentId, task.report);
    return { ...publication, url: `/api/demo/documents/${publication.documentId}`, status: 'published', error: null };
  }
}

export class LocalPublisher {
  constructor(store) { this.store = store; this.kind = 'local'; }
  async publish(task, persist, signal) {
    signal.throwIfAborted();
    const p = { ...task.publication, target: 'local', documentId: task.publication.documentId ?? `local-${task.id}-v${task.report.version}` };
    persist(p); this.store.putDocument(p.documentId, task.report);
    return { ...p, url: `/api/local/documents/${p.documentId}`, status: 'published', error: null };
  }
}

export function toBlocks(report) {
  const content = `${report.markdown}\n\n## 数据来源\n${report.sources.map(s => `${s.id} · ${s.title}\n${s.url}\n证据：${s.excerpt}`).join('\n\n')}`;
  return content.split('\n').filter(s => s.trim()).flatMap(line => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const type = heading ? 2 + heading[1].length : 2;
    const key = heading ? `heading${heading[1].length}` : 'text';
    const text = heading ? heading[2] : line;
    return Array.from({ length: Math.ceil(text.length / 1800) }, (_, i) => {
      const part = text.slice(i * 1800, (i + 1) * 1800);
      return { block_type: type, [key]: { elements: [{ text_run: { content: part, ...(/^https?:\/\/\S+$/.test(part) ? { text_element_style: { link: { url: part } } } : {}) } }] } };
    });
  });
}

export class FeishuPublisher {
  constructor({ token, folderToken, fetchImpl = fetch, apiBase = 'https://open.feishu.cn/open-apis' }) { this.kind = 'feishu'; this.token = token; this.folderToken = folderToken; this.fetch = fetchImpl; this.apiBase = apiBase; }
  get configured() { return Boolean(this.token); }
  async request(path, body, signal) {
    const res = await this.fetch(`${this.apiBase}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
    let json; try { json = await res.json(); } catch { throw new Error('飞书响应无法解析，请核对发布结果后重试'); }
    if (!res.ok || json.code !== 0) throw new Error(`飞书调用失败（HTTP ${res.status} / ${json.code ?? 'unknown'}），请检查授权、目录权限或稍后重试`);
    return json.data;
  }
  async findCreated(title, signal) {
    // User tokens can create in My Space without an explicit folder. Resolve its
    // root only when reconciling an uncertain create, so retries stay safe.
    const folderToken = this.folderToken ?? (await this.request('/drive/explorer/v2/root_folder/meta', null, signal)).token;
    if (!folderToken) throw new Error('无法核对飞书文档库根目录，请检查用户授权，报告已保留');
    let page = '';
    do {
      const d = await this.request(`/drive/v1/files?folder_token=${encodeURIComponent(folderToken)}&page_size=200${page ? `&page_token=${encodeURIComponent(page)}` : ''}`, null, signal);
      const match = d.files?.find(f => f.name === title && f.type === 'docx');
      if (match) return match.token;
      page = d.has_more ? d.next_page_token : '';
    } while (page);
    return null;
  }
  async publish(task, persist, signal) {
    if (!this.configured) throw new Error('请配置 FEISHU_USER_ACCESS_TOKEN（飞书用户授权），报告已保留，可在配置后重试上传');
    let p = { ...task.publication, target: 'feishu' };
    if (p.documentId && /^(local|demo)-/.test(p.documentId)) throw new Error('本地报告不能作为飞书文档续写，请通过上传接口发布');
    const title = `${task.report.title} · ${task.id} · v${task.report.version}`;
    if (!p.documentId) {
      if (p.createIntent) {
        const id = await this.findCreated(title, signal);
        if (!id) throw new Error('飞书创建结果待核对：未找到已创建文档。为避免重复建文档，本次不会再次创建；请核对目标目录后处理');
        p.documentId = id; persist(p);
      } else {
        p.createIntent = true; persist(p); // Durable intent before any remote mutation.
        const d = await this.request('/docx/v1/documents', { title, ...(this.folderToken ? { folder_token: this.folderToken } : {}) }, signal);
        if (!d.document?.document_id) throw new Error('飞书缺少 document_id，创建结果待核对');
        p.documentId = d.document.document_id; persist(p);
      }
    }
    const blocks = toBlocks(task.report);
    for (let offset = p.writtenBlocks ?? 0; offset < blocks.length; offset += 30) {
      const clientToken = createHash('sha256').update(`${task.id}:${task.report.version}:${offset}`).digest('hex').slice(0, 32);
      await this.request(`/docx/v1/documents/${encodeURIComponent(p.documentId)}/blocks/${encodeURIComponent(p.documentId)}/children?document_revision_id=-1&client_token=${clientToken}`, { children: blocks.slice(offset, offset + 30), index: -1 }, signal);
      p.writtenBlocks = Math.min(offset + 30, blocks.length); persist(p);
    }
    return { ...p, status: 'published', url: `https://www.feishu.cn/docx/${encodeURIComponent(p.documentId)}`, error: null };
  }
}
