import { createHash } from 'node:crypto';
import { notificationContext } from './notification-context.mjs';
import { documentToken, escapeXml, plainXml } from './queued-save-documents.mjs';
import { driveToken, matchingFolders } from './folder-identity.mjs';
import { assertDigestArchive, uniqueDigestDocument } from './topic-digest-archive.mjs';
export { digestFileDate } from './topic-digest-archive.mjs';
import { ServiceError } from './service-error.mjs';
import { z } from 'zod';
import { TOPIC_DIGEST_FOLDER, TOPIC_FOLDER, topicDeletionState, topicScheduleDate, topicScheduleRequestKey, topicScope } from './topics.mjs';

const titleFor = date => `${TOPIC_DIGEST_FOLDER} · ${date}`;
const delay = 15_000;
const retryLimit = 3;
export const defaultDigestPrompt = '聚合所有日报的摘要生成汇总日报，发布飞书文档到【存储位置】，并发送到飞书消息。【汇总规则】每个章节一个专题题目和摘要，附带每个日报链接。';
const startIssues = {
  DIGEST_BINDING_CHANGED:'日报与当前飞书账号不匹配，请恢复生成日报时的飞书绑定。',
  FOLDER_LIST_INCOMPLETE:'飞书目录未读取完整，请检查连接后重试。',
  DIGEST_FOLDER_CONFLICT:'汇总目录与已有同名专题冲突，请先核对飞书目录。',
  DIGEST_DOCUMENT_CONFLICT:'汇总目录存在多份同日文档，请先核对飞书目录。',
  DIGEST_DOCUMENT_LINK_INVALID:'当天的汇总缺少可核对的飞书链接，请先核对飞书目录。',
};
function digestStartIssue(error) {
  if (Object.hasOwn(startIssues, error?.code)) return startIssues[error.code];
  return error instanceof ServiceError && error.status === 428
    ? '请检查飞书绑定和文档访问权限。' : '会话启动前的检查未通过，请稍后重试。';
}
const output = z.object({ report: z.string().trim().min(1).max(6000) }).strict();
const sourceList = tasks => tasks.map(task => ({ title: task.topic.question, url: task.publication.url }));
const canonical = value => value.replace(/\s+/g, ' ').trim();
const textHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const deliveryFor = task => ({ notificationRecipient:task.notificationRecipient ?? task.feishuApp?.ownerOpenId,
  notificationApp:task.notificationApp ?? task.feishuApp });

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
    this.starting = new Set();
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

  date() { return topicScheduleDate(new Date(this.now())); }

  prompt(scope) { return this.store.setting('topic-digest-prompt:' + scope)?.prompt ?? defaultDigestPrompt; }

  async setPrompt(scope, prompt) {
    const context = this.context();
    if (context.scope !== scope || !context.root.folderToken) throw new ServiceError(409, '飞书账号或存储位置已变化，请刷新专题列表后再试');
    await this.service.binding.requireBound(context.app);
    this.assertCurrent(scope);
    this.store.saveSetting('topic-digest-prompt:' + scope, { prompt });
    return { prompt };
  }

  retryable(scope, date = this.date()) {
    const day = this.days(scope)[date];
    const key = scope + ':' + date;
    if (!day || day.sent || day.retryRequested || this.starting.has(key) || this.publishing === key) return false;
    const task = day.taskId && this.store.get(day.taskId);
    return Boolean(day.retryAt || ['failed', 'interrupted'].includes(task?.status));
  }

  retryBatch(scope) {
    this.assertCurrent(scope);
    const date = this.date();
    if (!this.retryable(scope, date)) return null;
    const day = this.days(scope)[date];
    // Retain the user's request until every source is ready. This survives a
    // restart and never claims a second task or replaces a published digest.
    const ready = day.url || day.intent || this.readyTasks(scope, date, this.roster(scope, date, day));
    this.save(scope, date, { retryRequested:true, retryAt:undefined, modelRetryAt:undefined });
    void this.tick();
    return ready ? 'submitted' : 'waiting';
  }

  canCreate(scope, archived) {
    if (!this.service.nativeSessions || !this.service.queuedSaves || this.closed || this.service.closed || this.service.updating) return false;
    const date = this.date(), day = this.days(scope)[date] ?? {}, key = scope + ':' + date;
    const context = this.context();
    if (context.scope !== scope || !context.root.folderToken || archived?.date === date || day.url || day.sent || day.taskId || day.creating ||
        this.starting.has(key) || this.publishing === key) return false;
    return Boolean(this.readyTasks(scope, date, this.roster(scope, date, day)));
  }

  async startManual(scope) {
    const {scope:current} = this.context();
    if (scope !== current) throw new ServiceError(409, '飞书账号或存储位置已变化，请刷新专题列表后再试');
    const date = this.date(), day = this.days(scope)[date];
    if (day?.url || day?.sent) throw new ServiceError(409, '今天已有汇总日报，不能再次生成');
    if (day?.taskId) {
      const task = this.store.get(day.taskId);
      if (task?.topicDigest?.scope === scope && task.topicDigest.date === date) {
        const same = await this.service.binding.requireBound(task.feishuApp);
        this.assertCurrent(scope);
        if (!same.openId || same.openId !== task.notificationRecipient || task.notificationApp?.appId && same.appId !== task.notificationApp.appId) {
          throw new ServiceError(428, '请恢复本次汇总绑定的飞书账号后重试');
        }
        const latest = this.days(scope)[date];
        if (latest?.url || latest?.sent) throw new ServiceError(409, '今天已有汇总日报，不能再次生成');
        const existing = latest?.taskId === task.id && this.store.get(task.id);
        if (!existing || this.date() !== date) throw new ServiceError(409, '汇总任务或日期已变化，请刷新专题列表后再试');
        return { date, status:existing.status, task:existing, existing:true };
      }
    }
    return this.startSession(scope, undefined, null);
  }

  async generate(scope, prompt, remote) {
    if (prompt !== undefined) return this.startSession(scope, prompt, remote);
    return this.generateLegacy(scope);
  }

  async generateLegacy(scope) {
    const context = this.context();
    if (context.scope !== scope) throw new ServiceError(409, '飞书账号或存储位置已变化，请刷新专题列表后再试');
    if (!context.root.folderToken) throw new ServiceError(409, '请先确认飞书存储位置，再生成日报汇总');
    await this.service.binding.requireBound(context.app);
    if (this.context().scope !== scope) throw new ServiceError(409, '飞书账号或存储位置已变化，请刷新专题列表后再试');
    if (this.closed || this.service.closed || this.service.updating) throw new ServiceError(503, '工作台正在停止或更新，请稍后再试');

    const date = topicScheduleDate(new Date(this.now()));
    const day = this.days(scope)[date] ?? {};
    if (day.sent) {
      if (!day.manual) this.save(scope, date, { manual: true });
      return { date, status: 'sent' };
    }
    const expected = this.roster(scope, date, day);
    if (!expected.length) throw new ServiceError(409, '今天没有待汇总的专题日报');
    if (!this.readyTasks(scope, date, expected)) throw new ServiceError(409, '今天的专题日报尚未全部生成，请等日报补齐后再试');
    this.save(scope, date, { manual: true, retryAt: undefined });
    // The automatic worker owns all writes. A click wakes that same worker
    // and can retry delivery, but never schedules a second writer or sender.
    void this.tick();
    return { date, status: 'queued' };
  }

  async startSession(scope, prompt, remote, { date = this.date(), automatic = false } = {}) {
    const context = this.context(), key = scope + ':' + date;
    if (context.scope !== scope || !context.root.folderToken) throw new ServiceError(409, '飞书账号或存储位置已变化，请刷新专题列表后再试');
    if (!this.service.nativeSessions || !this.service.queuedSaves) throw new ServiceError(409, '请在宿主 DSH 中启动汇总会话');
    const day = this.days(scope)[date] ?? {};
    if (day.url || remote?.date === date) throw new ServiceError(409, '今天已有汇总日报，不能再次生成');
    if (this.starting.has(key) || this.publishing === key || day.creating) throw new ServiceError(409, '今天的汇总正在生成或核对，请稍后再试');
    const expected = this.roster(scope, date, day);
    if (!expected.length) throw new ServiceError(409, '今天没有待汇总的专题日报');
    const tasks = this.readyTasks(scope, date, expected);
    if (!tasks) throw new ServiceError(409, '今天的专题日报尚未全部生成，请等日报补齐后再试');
    this.starting.add(key);
    try {
      const digestOwner = await this.requireSourceOwner(context, tasks);
      const archived = await this.findArchived(context, date);
      if (archived) {
        this.save(scope, date, { url:archived, sent:true });
        if (!automatic) throw new ServiceError(409, '今天已有汇总日报，不能再次生成');
        return { date, status:'sent' };
      }
      const latest = this.days(scope)[date] ?? {};
      if (latest.url || latest.creating || this.publishing === key) throw new ServiceError(409, '今天已有汇总或正在核对，请刷新后再试');
      if (topicScope(this.service.feishuSettings(), context.app) !== scope || !automatic && this.date() !== date) throw new ServiceError(409, '汇总日期或存储位置已变化，请重新打开汇总');
      const live = this.readyTasks(scope, date, this.roster(scope, date, latest));
      if (!live || JSON.stringify(sourceList(live)) !== JSON.stringify(sourceList(tasks))) throw new ServiceError(409, '当天日报已变化，请重新打开汇总');
      const prior = latest.taskId && this.store.get(latest.taskId);
      let task;
      if (prior) {
        if (!['failed', 'interrupted'].includes(prior.status) || this.service.active.has(prior.id)) throw new ServiceError(409, '汇总会话正在处理，请稍后再试');
        // Reuse the existing task and its native session, but never replace a
        // draft already committed for publication by this same session.
        if (!prior.queuedSave) {
          prior.prompt = prompt;
          prior.topicDigest.sources = sourceList(tasks);
          this.store.save(prior);
        }
        task = this.service.retry(prior.id, 'research');
        this.save(scope, date, { modelRetries:0, modelRetryAt:undefined });
      } else {
        task = await this.service.createAuthorized({ direction: '专题日报汇总 · ' + date, prompt:prompt ?? this.prompt(scope) }, undefined,
          { digestOwner, topicDigest: { scope, date, automatic, sources:sourceList(tasks) } });
      }
      return { date, status:'queued', task };
    } catch (error) {
      const latest = this.days(scope)[date];
      if (this.context().scope === scope && !latest?.taskId && !latest?.url) {
        this.save(scope, date, { startIssue:digestStartIssue(error), retryAt:this.now() + delay });
        this.store.runtimeLog('topic.digest.retry', { phase:'session_start', code:error.code ?? 'DIGEST_SESSION_FAILED' }, 'warn');
      }
      throw error;
    } finally { this.starting.delete(key); }
  }

  async findArchived({app,root,scope}, date) {
    const directories = this.service.directories;
    const list = token => directories.list(app, token);
    const parents = matchingFolders(await list(root.folderToken), TOPIC_FOLDER).map(driveToken);
    const candidates = [];
    for (const parent of parents) {
      for (const folder of matchingFolders(await list(parent), TOPIC_DIGEST_FOLDER)) {
        const token = driveToken(folder), files = await list(token);
        assertDigestArchive(this.store, root, app, token, files);
        candidates.push(...files);
      }
    }
    this.assertCurrent(scope);
    return uniqueDigestDocument(candidates, date);
  }

  assertSources(task) {
    const {scope,date,sources} = task.topicDigest;
    const day = this.days(scope)[date] ?? {};
    const reports = this.readyTasks(scope, date, this.roster(scope, date, day));
    if (!reports || JSON.stringify(sourceList(reports)) !== JSON.stringify(sources)) {
      throw new ServiceError(409, '当天日报已变化，等待全部日报完成后再重试');
    }
  }

  claim(task) {
    const {scope,date} = task.topicDigest;
    this.assertCurrent(scope);
    const day = this.days(scope)[date];
    if ((!task.topicDigest.automatic && this.date() !== date) || day?.taskId || day?.url || day?.creating) throw new ServiceError(409, '当天已有汇总或日期已变化，请重新打开汇总');
    this.assertSources(task);
    this.save(scope, date, { taskId:task.id, modelRetries:0, manual:true, startIssue:undefined, retryAt:undefined, retryRequested:undefined });
  }

  async checkTaskOwner(task) {
    const bound = await this.service.binding.requireBound(task.feishuApp);
    this.assertTask(task);
    return Boolean(bound.openId && bound.openId === task.notificationRecipient &&
      (!task.notificationApp?.appId || bound.appId === task.notificationApp.appId));
  }

  assertTask(task) {
    const {scope,date} = task.topicDigest;
    this.assertCurrent(scope);
    const day = this.days(scope)[date];
    if (day?.taskId !== task.id || day.url) throw new ServiceError(409, '当前汇总已交付或会话不再有效');
  }

  validateSubmission(input) { return output.parse(input); }

  archivedTaskId(scope, digest) {
    const day = digest && this.days(scope)[digest.date];
    return day?.url === digest?.url && day?.taskId && this.store.get(day.taskId)?.publication.url === digest.url ? day.taskId : null;
  }

  manualStatus(scope) {
    const date = this.date(), day = this.days(scope)[date];
    if (this.starting.has(scope + ':' + date) && !day?.taskId && !day?.url) return {date,status:'preparing'};
    if (!day) return null;
    const task = day.taskId && this.store.get(day.taskId);
    if (!task && !day.url && !day.intent && day.startIssue && !day.retryRequested) {
      return {date,status:'start_failed',startIssue:day.startIssue};
    }
    const details = task ? {taskId:task.id,prompt:task.prompt} : {};
    if (day.sent) return {date, ...details, status:'sent'};
    const ready = day.url || day.intent || this.readyTasks(scope, date, this.roster(scope, date, day));
    const status = day.retryRequested ? (ready ? 'retrying' : 'waiting') :
      day.retryAt || day.modelRetryAt ? 'retrying' : task && task.status !== 'ready' ? task.status : ready ? 'queued' : 'waiting';
    return {date, ...details, status};
  }

  remoteVisible(scope, digest) {
    if (!digest) return null;
    const local = this.days(scope)[digest.date];
    return local?.creating && local.url !== digest.url ? null : digest;
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
    if (this.closed || this.service.closed || this.service.updating) throw new ServiceError(503, '工作台正在停止或更新，请稍后再试');
    if (this.context().scope !== scope) {
      throw Object.assign(new ServiceError(409, '飞书账号或存储位置已变化，汇总暂停'), { code: 'DIGEST_SCOPE_CHANGED' });
    }
  }

  async process() {
    const context = this.context(), { scope, root } = context;
    if (!root.folderToken) return;
    for (const [date, day] of Object.entries(this.days(scope)).sort()) {
      const key = scope + ':' + date;
      if (day.sent) {
        const task = day.taskId && this.store.get(day.taskId);
        if (day.url && task?.status === 'running') this.completeSession(task.id, day.url);
        continue;
      }
      if (day.retryAt > this.now() || this.starting.has(key)) continue;
      this.assertCurrent(scope);
      const snapshot = day.destination ?? day.intent?.destination;
      const tasks = snapshot && (day.url || day.intent) ? [] : this.readyTasks(scope, date, this.roster(scope, date, day));
      if (!tasks) continue;
      let task = day.taskId && this.store.get(day.taskId);
      if (day.retryRequested) {
        if (task && this.service.active.has(task.id)) continue;
        try {
          if (task && !day.url && ['failed', 'interrupted'].includes(task.status)) {
            await this.requireSourceOwner(context, [...tasks, task]);
            const current = this.store.get(task.id);
            if (['failed', 'interrupted'].includes(current.status)) {
              if (!current.queuedSave) {
                current.topicDigest.sources = sourceList(tasks);
                this.assertSources(current);
                this.store.save(current);
              }
              task = this.service.retry(current.id, 'research');
            } else task = current;
          }
          this.save(scope, date, { retryRequested:undefined, retryAt:undefined, modelRetries:0, modelRetryAt:undefined });
        } catch (error) {
          this.save(scope, date, { retryAt:this.now() + delay });
          this.store.runtimeLog('topic.digest.retry', { phase:'batch_retry', code:error.code ?? 'DIGEST_SESSION_FAILED' }, 'warn');
          continue;
        }
      }
      const destination = snapshot ?? deliveryFor(tasks[0]);
      let url = day.url;
      if (!task && !url && !day.creating && this.service.nativeSessions && this.service.queuedSaves) {
        try { await this.startSession(scope, undefined, null, { date, automatic:true }); }
        catch { /* startSession records preflight errors for the card and worker. */ }
        continue;
      }
      if (task && !url && !task.queuedSave) {
        if (task.status === 'failed') this.retrySession(scope, date, day, task, tasks);
        continue;
      }
      if (task?.status === 'interrupted') continue;
      this.publishing = key;
      try {
        if (!url && day.intent) {
          url = await this.reconcileCreated(context, date, day.intent);
          this.save(scope, date, { url, destination, creating:undefined, intent:undefined });
        }
        if (!url) {
          let synthesis;
          if (task) {
            await this.requireSourceOwner(context, [...tasks, task]);
            synthesis = output.parse(await this.service.queuedSaves.readDraft(task)).report;
            if (JSON.stringify(task.topicDigest.sources) !== JSON.stringify(sourceList(tasks))) {
              if (!day.creating) {
                delete task.queuedSave;
                task.status = 'failed';
                task.error = '汇总来源已变化，将用最新日报重试';
                task.publication.status = 'pending';
                this.service.save(task);
              }
              throw new ServiceError(409, '汇总来源已变化，请用最新日报重试');
            }
          }
          const published = await this.publish(context, date, day, tasks, synthesis);
          url = published.url;
          if (published.reused) {
            this.save(scope, date, { url, sent:true, creating:undefined, expected:undefined, triggered:undefined, attempt:undefined, retryAt:undefined });
            if (task) this.completeSession(task.id, url, true);
            continue;
          }
          this.save(scope, date, { url, destination, creating:undefined, intent:undefined });
        }
        if (task && task.status !== 'ready') this.completeSession(task.id, url);
        await this.notify(context, date, url, destination);
        this.save(scope, date, { url, sent:true, destination:undefined, expected:undefined, triggered:undefined, attempt:undefined, retryAt:undefined });
      } catch (error) {
        const attempt = (day.attempt ?? 0) + 1;
        this.save(scope, date, { attempt, retryAt: this.now() + Math.min(delay * 2 ** Math.min(attempt - 1, 5), 300_000) });
        this.store.runtimeLog('topic.digest.retry', { phase: url ? 'notification' : 'publication',
          code: error.code ?? 'DIGEST_DELIVERY_FAILED', attempt }, 'warn');
      } finally { this.publishing = null; }
    }
  }

  retrySession(scope, date, day, task, sources) {
    if (this.service.active.has(task.id) || (day.modelRetries ?? 0) >= retryLimit) return;
    if (!day.modelRetryAt) {
      this.save(scope, date, { modelRetryAt:this.now() + delay * 2 ** (day.modelRetries ?? 0) });
      return;
    }
    if (day.modelRetryAt > this.now()) return;
    task.topicDigest.sources = sourceList(sources);
    this.store.save(task);
    this.service.retry(task.id, 'research');
    this.save(scope, date, { modelRetries:(day.modelRetries ?? 0) + 1, modelRetryAt:undefined });
  }

  completeSession(id, url, reused = false) {
    const task = this.store.get(id);
    task.status = 'ready';
    task.stage = 'done';
    task.publication = { ...task.publication, status:'published', url };
    const run = task.runs.at(-1);
    if (run) { run.status = 'completed'; run.endedAt = new Date(this.now()).toISOString(); }
    this.service.save(task);
    this.service.event(id, 'system', (reused ? '已存在当天的汇总，未改写或重发：' : '专题日报汇总已保存到飞书：') + url);
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
      throw Object.assign(new ServiceError(428, '飞书授权与原日报所有者不一致'), { code: 'DIGEST_BINDING_CHANGED' });
    }
    return { openId: bound.openId, appId: bound.appId };
  }

  async publish(context, date, day, tasks, synthesis) {
    const { app, root, scope } = context, { directories } = this.service;
    await this.requireSourceOwner(context, tasks);
    const parent = await directories.folder(app, root.folderToken, TOPIC_FOLDER);
    this.assertCurrent(scope);
    const folder = await directories.folder(app, parent, TOPIC_DIGEST_FOLDER);
    this.assertCurrent(scope);
    const files = await this.documents.files(app, folder);
    assertDigestArchive(this.store, root, app, folder, files);
    const title = titleFor(date);
    let url = uniqueDigestDocument(files, date);
    if (url && synthesis && !day.creating) {
      await this.requireSourceOwner(context, tasks);
      return { url, reused:true };
    }
    const synthesisLines = synthesis ? synthesis.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : [];
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
      const paragraphsXml = lines => lines.map(line => `<p>${escapeXml(line)}</p>`).join('');
      const content = paragraphsXml(synthesisLines) +
        sections.map(({title, paragraphs, source}) => `<h2>${escapeXml(title)}</h2>` + paragraphsXml(paragraphs) +
          `<p><a href="${escapeXml(source)}">打开原日报</a></p>`).join('');
      await this.requireSourceOwner(context, tasks);
      const expected = this.verifyRoster(scope, date, tasks);
      const intent = { folder, destination:deliveryFor(tasks[0]), links:sections.map(section => section.source),
        hashes:[...synthesisLines, ...sections.flatMap(section => [section.title,...section.paragraphs])].map(textHash) };
      this.save(scope, date, { expected, creating:true, intent });
      try { url = await this.documents.create(app, folder, title, content); }
      catch (error) {
        if (error.definitelyRejected) this.save(scope, date, { expected:undefined, creating:undefined, intent:undefined });
        throw error;
      }
      intent.url = url;
      this.save(scope, date, { intent });
      return { url:await this.reconcileCreated(context, date, intent), reused:false };
    }
    this.assertCurrent(scope);
    const { content } = await this.documents.read(app, url);
    const body = plainXml(content).replace(/\s+/g, ' ');
    if (!synthesisLines.every(line => body.includes(canonical(line))) ||
      !sections.every(({title, paragraphs, source}) => content.includes(`href="${escapeXml(source)}"`) &&
        [title, ...paragraphs].every(line => body.includes(canonical(line))))) {
      throw Object.assign(new Error('汇总日报尚未核对到所有摘要和原文链接'), { code: 'DIGEST_READBACK_INCOMPLETE' });
    }
    await this.requireSourceOwner(context, tasks);
    const expected = this.verifyRoster(scope, date, tasks);
    this.save(scope, date, { expected });
    return { url, reused:false };
  }

  async reconcileCreated(context, date, intent) {
    const {app,scope} = context;
    await this.requireSourceOwner(context, [intent.destination]);
    let {url} = intent;
    if (!url) url = uniqueDigestDocument(await this.documents.files(app, intent.folder), date);
    if (!url) throw Object.assign(new Error('上次创建尚未确认，继续核对'), { code:'DIGEST_CREATE_UNCONFIRMED' });
    const {content} = await this.documents.read(app, url);
    const hashes = new Set([...content.matchAll(/<(h[1-6]|p)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)]
      .map(match => textHash(plainXml(match[2]))));
    if (!intent.hashes.every(hash => hashes.has(hash)) || !intent.links.every(link => content.includes(`href="${escapeXml(link)}"`))) {
      throw Object.assign(new Error('汇总日报尚未核对到所有摘要和原文链接'), { code:'DIGEST_READBACK_INCOMPLETE' });
    }
    this.assertCurrent(scope);
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
