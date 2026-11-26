import { createHash } from 'node:crypto';
import { notificationContext } from './notification-context.mjs';
import { documentToken, escapeXml, plainXml } from './queued-save-documents.mjs';
import { driveType } from './folder-identity.mjs';
import { TOPIC_DIGEST_FOLDER, TOPIC_FOLDER, topicDeletionState, topicScheduleDate, topicScheduleRequestKey, topicScope } from './topics.mjs';

const titleFor = date => `${TOPIC_DIGEST_FOLDER} · ${date}`;
const delay = 15_000;
const dateInTitle = /^汇总日报 · (\d{4}-\d{2}-\d{2})(?:\.docx?)?$/;
export function digestFileDate(file) {
  if (!['docx', 'doc'].includes(file.type) || !documentToken(file.url)) return;
  const date = dateInTitle.exec(file.name ?? '')?.[1];
  const time = Date.parse(date);
  if (Number.isFinite(time) && new Date(time).toISOString().startsWith(date + 'T')) return date;
}

function summaryLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  const heading = /^(#{1,6})\s+/;
  const summary = /^(#{1,6})\s+(?:日报摘要|内容摘要|更新摘要|执行摘要|核心摘要|摘要)(?:[：:]\s*|\s*$)(.*)$/;
  const start = lines.findIndex(line => summary.test(line));
  const clean = line => line.replace(/<\/?(?:title|p|b|strong|em|br|a|span)(?:\s+[^>]*)?\s*\/?>/gi, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(?:[-+*]\s+|\d+[.)]\s+|>\s*)/, '').replace(/\*\*|__/g, '').trim();
  if (start >= 0) {
    const [, level, inline] = summary.exec(lines[start]);
    const text = [inline];
    for (const line of lines.slice(start + 1)) {
      const depth = heading.exec(line)?.[1].length;
      if (depth && depth <= level.length) break;
      if (!depth) text.push(line);
    }
    const excerpts = text.map(clean).filter(Boolean);
    if (excerpts.length) return excerpts;
  }
  // Older or customized reports may not have a dedicated section. Use their
  // opening prose as an attributed excerpt instead of inventing an abstract.
  return ['原日报未单列摘要，以下为正文摘录：', ...lines.filter(line => !heading.test(line))
    .map(clean).filter(line => line && !/^\||^[-=:]{3,}$/.test(line)).slice(0, 3)];
}

function notificationId(url, app, recipient) {
  const h = createHash('sha256').update(JSON.stringify([documentToken(url), app.appId, recipient])).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}

export class TopicDigest {
  constructor(service, documents, { now = Date.now } = {}) {
    this.service = service;
    this.store = service.store;
    this.documents = documents;
    this.now = now;
  }

  context() {
    const app = this.service.binding.applicationSnapshot(), root = this.service.feishuSettings();
    return { app, root, scope: topicScope(root, app) };
  }

  days(scope) { return this.store.setting('topic-digests:' + scope) ?? {}; }
  save(scope, date, patch) {
    const days = this.days(scope);
    this.store.saveSetting('topic-digests:' + scope, { ...days, [date]: { ...days[date], ...patch } });
  }

  expect(scope, date, triggeringId) {
    const day = this.days(scope)[date];
    if (day?.expected || day?.sent || day?.triggered?.includes(triggeringId)) return;
    this.save(scope, date, { triggered: [...(day?.triggered ?? []), triggeringId] });
  }

  roster(scope, date, day) {
    if (day.expected) return day.expected;
    // Include later slots, and retain any already triggered task (even a
    // failure). An untriggered schedule can still be added or stopped.
    const expected = Object.values(this.service.topicSchedules.all()).filter(plan => {
      if (plan.scope !== scope) return false;
      if (this.store.request(topicScheduleRequestKey(scope, plan.topicId, date))) return true;
      const slot = Date.parse(`${date}T${plan.time}:00+08:00`);
      return plan.enabled && (!plan.activatedAt || Date.parse(plan.activatedAt) <= slot);
    }).map(plan => plan.topicId);
    return [...new Set([...(day.triggered ?? []), ...expected])].sort();
  }

  latest(scope = this.context().scope) {
    const [date, state] = Object.entries(this.days(scope)).filter(([, day]) => day.url).sort(([a], [b]) => b.localeCompare(a))[0] ?? [];
    return state ? { date, url: state.url } : null;
  }

  remoteVisible(scope, digest) {
    if (!digest) return null;
    const local = this.days(scope)[digest.date];
    return local && local.url !== digest.url ? null : digest;
  }

  readyTasks(scope, date, expected) {
    const tasks = [];
    for (const id of expected) {
      const request = this.store.request(topicScheduleRequestKey(scope, id, date));
      const task = request && this.store.get(request.task_id);
      const scheduledFor = Date.parse(task?.scheduled?.scheduledFor);
      if (task?.scheduled?.kind !== 'topic' || task.topic?.topicId !== id || !task.topic.window ||
        !Number.isFinite(scheduledFor) || topicScheduleDate(new Date(scheduledFor)) !== date ||
        !task.feishuRoot || topicScope(task.feishuRoot, task.feishuApp) !== scope || task.status !== 'ready' ||
        task.publication?.status !== 'published' || !documentToken(task.publication.url) ||
        topicDeletionState(this.store, task.feishuRoot, task.feishuApp, id, task.topicLibrary?.folderToken, task.publication.url)) return null;
      tasks.push(task);
    }
    return tasks.length ? tasks : null;
  }

  start() {
    this.timer = setInterval(() => this.tick(), delay);
    this.timer.unref?.();
    this.tick();
  }

  tick() {
    const s = this.service;
    if (this.active || this.closed || s.closed || s.updating || s.binding.completing ||
      s.binding.configuring || s.binding.registration?.busy) return this.active;
    s.inFlightWrites = (s.inFlightWrites ?? 0) + 1;
    this.active = this.process().catch(() => this.store.runtimeLog('topic.digest.worker_failed', {}, 'error')).finally(() => {
      s.inFlightWrites--;
      this.active = null;
    });
    return this.active;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await this.active;
  }

  assertCurrent(scope) {
    if (this.closed || this.service.closed || this.service.updating || this.context().scope !== scope) {
      throw Object.assign(new Error('飞书账号或存储位置已变化，汇总暂停'), { code: 'DIGEST_SCOPE_CHANGED' });
    }
  }

  async process() {
    const context = this.context(), { scope, root } = context;
    if (!root.folderToken) return;
    for (const [date, day] of Object.entries(this.days(scope)).sort()) {
      if (day.sent || day.retryAt > this.now()) continue;
      this.assertCurrent(scope);
      const tasks = this.readyTasks(scope, date, this.roster(scope, date, day));
      if (!tasks) continue;
      let url = day.url;
      try {
        if (!url) {
          url = await this.publish(context, date, day, tasks);
          this.save(scope, date, { url, creating: undefined });
        }
        await this.notify(context, date, url, tasks[0]);
        this.save(scope, date, { url, sent: true, expected: undefined, triggered: undefined, attempt: undefined, retryAt: undefined });
      } catch (error) {
        const attempt = (day.attempt ?? 0) + 1;
        this.save(scope, date, { attempt, retryAt: this.now() + Math.min(delay * 2 ** Math.min(attempt - 1, 5), 300_000) });
        this.store.runtimeLog('topic.digest.retry', { phase: url ? 'notification' : 'publication',
          code: error.code ?? 'DIGEST_DELIVERY_FAILED', attempt }, 'warn');
      }
    }
  }

  verifyRoster(scope, date, tasks) {
    this.assertCurrent(scope);
    const expected = this.roster(scope, date, this.days(scope)[date]);
    const current = this.readyTasks(scope, date, expected);
    if (!current || current.length !== tasks.length || current.some((task, i) =>
      task.id !== tasks[i].id || task.publication.url !== tasks[i].publication.url)) {
      throw Object.assign(new Error('当天纳入的日报或交付结果已变化'), { code: 'DIGEST_ROSTER_CHANGED' });
    }
    return expected;
  }

  async requireSourceOwner({ app, scope }, tasks) {
    const bound = await this.service.binding.requireBound(app);
    this.assertCurrent(scope);
    if (!bound.openId || tasks.some(task => (task.notificationRecipient ?? task.feishuApp?.ownerOpenId) !== bound.openId ||
      task.notificationApp?.appId && task.notificationApp.appId !== bound.appId)) {
      throw Object.assign(new Error('飞书授权与原日报所有者不一致'), { code: 'DIGEST_BINDING_CHANGED' });
    }
  }

  async publish(context, date, day, tasks) {
    const { app, root, scope } = context, { directories } = this.service;
    await this.requireSourceOwner(context, tasks);
    const parent = await directories.folder(app, root.folderToken, TOPIC_FOLDER);
    this.assertCurrent(scope);
    const folder = await directories.folder(app, parent, TOPIC_DIGEST_FOLDER);
    this.assertCurrent(scope);
    const files = await this.documents.files(app, folder);
    if (files.some(file => driveType(file) === 'folder' || ['docx', 'doc', 'wiki'].includes(driveType(file)) && !digestFileDate(file))) {
      throw Object.assign(new Error('汇总目录与已有专题目录重名'), { code: 'DIGEST_FOLDER_CONFLICT' });
    }
    const matches = [...new Set(files.filter(file => digestFileDate(file) === date).map(file => file.url))];
    if (matches.length > 1) throw Object.assign(new Error('存在多份同日汇总'), { code: 'DIGEST_DOCUMENT_CONFLICT' });
    const title = titleFor(date);
    let [url] = matches;
    if (!url && day.creating) throw Object.assign(new Error('上次创建尚未确认，继续核对'), { code: 'DIGEST_CREATE_UNCONFIRMED' });
    const sections = [];
    for (const task of tasks) {
      this.assertCurrent(scope);
      const source = task.publication.url;
      const { content } = await this.documents.read(app, source, 'markdown');
      if (!content.trim()) throw new Error('专题日报正文未读回');
      const paragraphs = summaryLines(content).join('\n').slice(0, 3000).split('\n').filter(Boolean);
      sections.push({ title: task.topic.question, paragraphs, source });
    }
    if (!url) {
      const content = sections.map(({title, paragraphs, source}) => `<h2>${escapeXml(title)}</h2>` +
        paragraphs.map(line => `<p>${escapeXml(line)}</p>`).join('') +
        `<p><a href="${escapeXml(source)}">打开原日报</a></p>`).join('');
      await this.requireSourceOwner(context, tasks);
      const expected = this.verifyRoster(scope, date, tasks);
      this.save(scope, date, { expected, creating: true });
      try { url = await this.documents.create(app, folder, title, content); }
      catch (error) {
        if (error.definitelyRejected) this.save(scope, date, { expected: undefined, creating: undefined });
        throw error;
      }
    }
    this.assertCurrent(scope);
    const { content } = await this.documents.read(app, url);
    const canonical = value => value.replace(/\s+/g, ' ').trim();
    const body = plainXml(content).replace(/\s+/g, ' ');
    if (!sections.every(({title, paragraphs, source}) => content.includes(`href="${escapeXml(source)}"`) &&
      [title, ...paragraphs].every(line => body.includes(canonical(line))))) {
      throw Object.assign(new Error('汇总日报尚未核对到所有摘要和原文链接'), { code: 'DIGEST_READBACK_INCOMPLETE' });
    }
    await this.requireSourceOwner(context, tasks);
    const expected = this.verifyRoster(scope, date, tasks);
    this.save(scope, date, { expected });
    return url;
  }

  async notify({ app, scope }, date, url, task) {
    const recipient = task.notificationRecipient ?? task.feishuApp?.ownerOpenId;
    if (!recipient) throw Object.assign(new Error('缺少日报通知接收人'), { code: 'MISSING_RECIPIENT' });
    const id = notificationId(url, app, recipient);
    const { application } = await notificationContext(this.service, {
      id, notificationRecipient: recipient, notificationApp: task.notificationApp ?? task.feishuApp,
    });
    this.assertCurrent(scope);
    const response = await this.service.binding.json(['im', '+messages-send', '--as', 'bot', '--user-id', recipient,
      '--text', `${titleFor(date)}已完成\n${url}`, '--idempotency-key', id], application);
    if (response?.ok !== true) throw new Error('汇总日报通知尚未确认');
  }
}
