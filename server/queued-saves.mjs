import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { analysisLibrary, parseAnalysisManifest } from './analysis.mjs';
import { agentDeliverySchema } from './agent-delivery.mjs';
import { briefingKey } from './briefings.mjs';
import { assertDocumentAvailable, documentDeletionState, documentRemoved } from './document-deletion-state.mjs';
import { library, libraryNamespaceKey, mergeCompanyDelivery, parseLibraryManifest } from './industry.mjs';
import { internalFolderKey } from './internal-materials.mjs';
import { assertTopicAvailable, legacyTopicFolderKey, topicDailyDocumentKey, topicDailyPeriod, topicDocumentKey, topicFolderKey } from './topics.mjs';
import { topicTotalTitle } from './topic-defaults.mjs';
import { documentToken, jsonBlock, plainXml } from './queued-save-documents.mjs';
import { mergeQueuedFacts } from './queued-save-merge.mjs';
import { companyResource, saveDigest, validateSavePayload } from './queued-save-payload.mjs';
import { ServiceError } from './service-error.mjs';

const jobRef = ref => 'save-resource:' + ref;
const stamp = () => new Date().toISOString();
const nextStatus = note => new ServiceError(503, note);
const conflict = note => new ServiceError(409, note);
const isIndex = job => job.role === 'companyIndex' || job.role === 'analysisIndex';
const prerequisites = (job, jobs) => isIndex(job) ? jobs.filter(candidate => !isIndex(candidate))
  : job.depends ? jobs.filter(candidate => candidate.id === job.depends) : [];
const draftBlocks = payload => Buffer.from(JSON.stringify(payload)).toString('base64').match(/.{1,4000}/g)
  .map(chunk => '<p>' + chunk + '</p>').join('');

export class QueuedSaves {
  constructor(service, documents, { retryMs = 1000 } = {}) {
    this.service = service;
    this.store = service.store;
    this.documents = documents;
    this.retryMs = retryMs;
    this.running = new Map();
    this.submissions = new Map();
    this.drafts = new Map();
    this.store.initSaveJobs();
  }

  start() {
    this.timer = setInterval(() => this.pump(), this.retryMs);
    this.timer.unref();
    this.wake();
  }

  wake() {
    if (this.scheduled || this.closed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  assertTask(task) {
    assertDocumentAvailable(this.service, task);
    assertTopicAvailable(this.service, task.topic, task.feishuRoot, task.feishuApp);
  }

  assertSubmission(id, requestId, terminalId) {
    const task = this.service.require(id);
    const meta = this.store.terminal(terminalId);
    const active = this.service.cloudWrites.writer(task);
    this.assertTask(task);
    if (this.closed || !meta?.queuedSavePath || task.terminalId !== terminalId || meta.deliveryRequestId !== requestId ||
      !active || active.controller.signal.aborted || meta.activity !== 'working') {
      throw conflict('当前会话已结束或已取消，无法接受新的保存提交');
    }
    return { task, signal: active.controller.signal };
  }

  async submit(id, { requestId, terminalId, input }) {
    const task = this.service.require(id);
    const payload = validateSavePayload(task, input);
    const digest = saveDigest(JSON.stringify(payload));
    if (task.queuedSave?.requestId === requestId && task.terminalId === terminalId) {
      if (task.queuedSave.digest !== digest) throw conflict('本轮已提交另一份增量');
      return { accepted: true };
    }
    const { signal } = this.assertSubmission(id, requestId, terminalId);
    const prior = this.submissions.get(id);
    if (prior) {
      if (prior.digest !== digest || prior.requestId !== requestId) throw conflict('本轮正在提交另一份增量');
      return prior.promise;
    }
    const promise = this.accept(task, payload, { requestId, terminalId, digest, signal });
    this.submissions.set(id, { requestId, digest, promise });
    try { return await promise; }
    finally { this.submissions.delete(id); }
  }

  async accept(task, payload, { requestId, terminalId, digest, signal }) {
    const bound = await this.service.binding.requireBound(task.feishuApp);
    if (task.feishuApp.ownerOpenId && bound.openId !== task.feishuApp.ownerOpenId) throw conflict('飞书账号与本次调研的绑定不一致');
    await this.service.directories.prepare(task, signal);
    this.assertSubmission(task.id, requestId, terminalId);
    const jobs = this.plan(task, payload);
    await Promise.all(jobs.filter(job => job.url && /\/(?:wiki|docs)\//.test(job.url)).map(async job => {
      const doc = await this.documents.read(task.feishuApp, job.url);
      job.documentId = doc.id;
    }));
    const stageKey = 'save-stage:' + requestId;
    const stage = this.store.setting(stageKey);
    const title = '行研保存草稿 ' + requestId;
    let url = stage?.url;
    if (stage && stage.digest !== digest) throw conflict('草稿已提交，请使用相同的内容重试');
    if (!url && stage) {
      url = await this.documents.find(task.feishuApp, '', title);
      if (!url) throw nextStatus('草稿创建结果尚未确认，请使用同一份增量重试提交');
    }
    if (!url) {
      this.store.saveSetting(stageKey, { digest });
      try { url = await this.documents.create(task.feishuApp, '', title, draftBlocks(payload)); }
      catch (error) {
        if (error.definitelyRejected) this.store.deleteSetting(stageKey);
        throw error;
      }
    }
    this.store.saveSetting(stageKey, { url, digest });
    const draft = await this.documents.read(task.feishuApp, url);
    if (saveDigest(JSON.stringify(this.parseDraft(draft))) !== digest) throw nextStatus('飞书草稿内容尚未完整读回，请重试提交');
    const latest = this.assertSubmission(task.id, requestId, terminalId).task;
    latest.feishuRoot = task.feishuRoot;
    latest.industryLibrary = task.industryLibrary ?? latest.industryLibrary;
    latest.queuedSave = { requestId, digest, url, ownerOpenId: bound.openId,
      noUpdates: payload.noUpdates, partial: payload.partial, sourceTitle: payload.sourceTitle };
    if (latest.status === 'failed') {
      const meta = this.store.terminal(terminalId);
      latest.runs.push({ id: randomUUID(), terminalId, sessionId: meta.sessionId, startedAt: meta.lastTurnStartedAt,
        feishuApp: latest.feishuApp, status: 'running' });
    }
    latest.status = 'running';
    latest.error = null;
    latest.stage = 'waiting_save';
    latest.publication = { ...latest.publication, owner: 'platform', status: 'publishing', requestId };
    const run = latest.runs.at(-1);
    if (run) run.researchEndedAt = stamp();
    this.store.transaction(() => {
      for (const job of jobs) this.store.putSaveJob(job);
      this.store.save(latest);
      this.store.deleteSetting(stageKey);
    });
    this.service.event(latest.id, 'state', { status: latest.status, stage: latest.stage, publication: latest.publication.status });
    if (!jobs.length) this.finish(latest.id);
    this.wake();
    return { accepted: true };
  }

  plan(task, payload) {
    const store = this.store;
    const jobs = [];
    const add = (role, fields) => {
      const job = { id: randomUUID(), taskId: task.id, status: 'pending', role, ...fields };
      jobs.push(job);
      return job;
    };
    const current = library(store, task.feishuRoot, task.feishuApp);
    for (const name of new Set(payload.facts.map(fact => fact.company).filter(Boolean))) {
      const company = add('company', { name, title: name, parent: current.folderToken, unique: true,
        ref: companyResource(current.folderToken, name), url: current.companies.find(entry => entry.name === name)?.url });
      add('companyIndex', { parent: current.folderToken, title: '公司索引', unique: true,
        ref: 'company-index:' + current.folderToken, url: current.manifestUrl, depends: company.id });
    }
    if (task.industry) return jobs;
    let parent = task.feishuRoot.folderToken, title = task.direction, url = task.publication?.url;
    let primaryRef, primaryUnique = false, dependency;
    if (task.briefing) parent = store.setting(briefingKey(task))?.folderToken;
    if (task.analysis) parent = analysisLibrary(store, task.feishuRoot, task.feishuApp).folderToken;
    if (task.internal) {
      const folders = store.setting(internalFolderKey(task));
      parent = folders?.transcriptFolderToken;
      if (task.internal.uploadEligible && !task.publication?.sourceMaterialUrl) {
        dependency = add('source', { parent: folders?.sourceFolderToken, title: basename(task.internal.source) }).id;
      }
    }
    if (task.topic) {
      const modern = task.topic.workflowVersion === 468;
      const folders = store.setting(modern ? topicFolderKey(task) : legacyTopicFolderKey(task));
      const daily = modern && task.topic.window;
      const totalKey = topicDocumentKey(task);
      const total = {
        parent: folders?.folderToken, title: modern ? topicTotalTitle(task.topic.question) : task.direction,
        ref: 'topic-total:' + (modern ? folders?.folderToken : totalKey), url: store.setting(totalKey)?.url,
        unique: modern,
      };
      if (!daily || task.topic.totalMergeRequired) add('topicTotal', total);
      if (!daily) return jobs;
      parent = folders?.dailyFolderToken;
      primaryRef = 'topic-daily:' + parent + ':' + topicDailyPeriod(task.topic.window);
      primaryUnique = true;
      url = store.setting(topicDailyDocumentKey(task))?.url ?? url;
    }
    const primary = add('report', { title, parent, url, ref: primaryRef, unique: primaryUnique, depends: dependency });
    if (task.internal) {
      const folders = store.setting(internalFolderKey(task));
      add('minutes', { parent: folders?.minutesFolderToken, title: '会议纪要 · ' + payload.minutes.title,
        url: task.publication?.minutesUrl, depends: primary.id });
    }
    if (task.analysis) {
      const current = analysisLibrary(store, task.feishuRoot, task.feishuApp);
      add('analysisIndex', { parent, title: '分析报告索引', unique: true, ref: 'analysis-index:' + parent,
        url: current.manifestUrl, depends: primary.id });
    }
    return jobs;
  }

  parseDraft(doc) {
    const encoded = [...doc.content.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/gi)]
      .map(match => plainXml(match[1]).replace(/\s+/g, '')).join('');
    try { return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); }
    catch { throw nextStatus('飞书草稿尚未完整读回'); }
  }

  async readDraft(task) {
    const { url, digest } = task.queuedSave;
    const prior = this.drafts.get(url);
    if (prior) return prior;
    const promise = (async () => {
      const payload = this.parseDraft(await this.documents.read(task.feishuApp, url));
      if (saveDigest(JSON.stringify(payload)) !== digest) throw conflict('保存草稿已被修改，请恢复原版本后重试');
      return payload;
    })();
    this.drafts.set(url, promise);
    try { return await promise; }
    finally { this.drafts.delete(url); }
  }

  resolvedUrl(job) {
    if (job.url || !job.ref) return job.url;
    const url = this.store.setting(jobRef(job.ref))?.url;
    if (!url || job.role !== 'company') return url;
    const task = this.service.require(job.taskId);
    return documentRemoved(this.store, task.feishuRoot, task.feishuApp, url) ? undefined : url;
  }

  keys(job) {
    const token = job.documentId ?? documentToken(this.resolvedUrl(job));
    return [job.ref, token && 'doc:' + token].filter(Boolean);
  }

  pump() {
    if (this.closed || this.service.updating) return;
    const byTask = new Map();
    const reserved = new Set([...this.running.values()].flatMap(run => this.keys(run.job)));
    for (const job of this.store.saveJobs()) {
      if (this.running.has(job.id)) continue;
      const task = this.store.get(job.taskId);
      if (!task?.queuedSave || task.status !== 'running') continue;
      if (job.depends || isIndex(job)) {
        if (!byTask.has(task.id)) byTask.set(task.id, this.store.saveJobs(task.id));
        if (!prerequisites(job, byTask.get(task.id)).every(dependency => dependency.status === 'done')) continue;
      }
      const keys = this.keys(job);
      const busy = keys.some(key => reserved.has(key));
      for (const key of keys) reserved.add(key);
      if (busy || (job.nextAt ?? 0) > Date.now()) continue;
      const promise = this.run(job, task).catch(() => {
        this.store.runtimeLog('cloud.save.worker_failed', { taskId: task.id }, 'error');
      }).finally(() => {
        this.running.delete(job.id);
        this.wake();
      });
      this.running.set(job.id, { job, promise });
    }
  }

  check(job, task, url = this.resolvedUrl(job)) {
    if (this.closed) throw nextStatus('保存将在工作台重启后继续');
    this.assertTask(task);
    if (url && documentDeletionState(this.store, task.feishuRoot, task.feishuApp, url)) {
      throw conflict('目标文档已删除或正在删除，请核对后重试');
    }
    const legacy = libraryNamespaceKey(task.feishuRoot, task.feishuApp);
    const pending = this.store.setting('cloud-write-pending:' + legacy);
    if (this.service.cloudWrites.completedOperations(task, 'cloud-write-operations:' + legacy).length ||
      pending && this.store.terminal(pending.terminalId)?.activity === 'working') {
      throw nextStatus('旧版本保存尚待核对，确认结束后平台会继续保存');
    }
  }

  async run(job, task) {
    try {
      this.check(job, task);
      job.status = 'running';
      this.store.putSaveJob(job);
      if (task.stage !== 'saving') {
        task.stage = 'saving';
        this.service.save(task);
      }
      const bound = await this.service.binding.requireBound(task.feishuApp);
      if (task.queuedSave.ownerOpenId && bound.openId !== task.queuedSave.ownerOpenId) throw new ServiceError(428, '请恢复提交时的飞书账号后继续保存');
      const payload = await this.readDraft(task);
      const dependency = job.depends && this.store.saveJobs(task.id).find(candidate => candidate.id === job.depends);
      const result = await this.write(job, task, payload, dependency?.result);
      this.store.transaction(() => {
        job.result = result;
        job.status = 'done';
        delete job.error;
        this.store.putSaveJob(job);
        this.recordProgress(task.id, job);
      });
    } catch (error) {
      const permanent = [400, 409, 428].includes(error.status) || /^LIBRARY_INVALID|^LIBRARY_DUPLICATES/.test(error.code ?? '');
      job.attempt = (job.attempt ?? 0) + 1;
      job.nextAt = Date.now() + Math.min(60_000, this.retryMs * 2 ** Math.min(6, job.attempt - 1));
      job.status = permanent ? 'failed' : 'pending';
      job.error = error instanceof ServiceError ? error.message : '飞书保存暂未完成，平台将重新核对';
      this.store.putSaveJob(job);
    }
    this.finish(task.id);
  }

  async ensure(job, task, content, format = 'xml', reuse = true) {
    const { parent, title } = job;
    if (!parent) throw conflict('目标目录缺失，请核对飞书文件夹后重试');
    const app = task.feishuApp;
    let url = this.resolvedUrl(job);
    if (url) return url;
    const createTitle = job.unique ? title : '行研保存 ' + job.id;
    if (job.creating || job.unique && reuse) {
      url = await this.documents.find(app, parent, createTitle);
      if (!url && job.creating) throw nextStatus('创建请求结果尚未确认，平台将继续核对目录');
    }
    if (!url) {
      this.check(job, task);
      job.creating = true;
      this.store.putSaveJob(job);
      try { url = await this.documents.create(app, parent, createTitle, content, format); }
      catch (error) {
        if (error.definitelyRejected) { job.creating = false; this.store.putSaveJob(job); }
        throw error;
      }
    }
    job.url = url;
    if (job.ref) this.store.saveSetting(jobRef(job.ref), { url });
    this.store.putSaveJob(job);
    return url;
  }

  async write(job, task, payload, dependency) {
    const app = task.feishuApp;
    if (job.role === 'company' || job.role === 'topicTotal') {
      const facts = payload.facts.filter(fact => job.role === 'company' ? fact.company === job.name : !fact.company);
      const initial = job.role === 'topicTotal' && !facts.length ? '<p>' + (payload.partial ? '本次资料不足，仍待核对。' : '本期暂无已核验更新。') + '</p>' : undefined;
      const url = await this.ensure(job, task, initial);
      this.check(job, task, url);
      const result = await mergeQueuedFacts({ documents: this.documents, store: this.store, task, url, facts,
        check: () => this.check(job, task, url) });
      if (job.role === 'topicTotal') return { url };
      return { name: job.name, url, ...result, updatedAt: job.updatedAt ?? stamp() };
    }
    if (job.role === 'companyIndex' || job.role === 'analysisIndex') return this.writeIndex(job, task, payload, dependency);
    if (job.role === 'source') return this.writeSource(job, task);
    const previous = job.url && !job.creating;
    let content = job.role === 'minutes' ? payload.minutes.body : payload.report;
    const source = dependency?.url ?? task.publication.sourceMaterialUrl ?? (task.internal?.sourceType === 'url' ? task.internal.source : null);
    if (task.internal && job.role === 'report' && source) content += '\n\n原始资料：' + source;
    if (job.role === 'minutes') content += '\n\n逐字稿：' + dependency.url + (task.publication.sourceMaterialUrl ? '\n\n原始资料：' + task.publication.sourceMaterialUrl : '');
    const url = await this.ensure(job, task, content, 'markdown');
    this.check(job, task, url);
    const doc = await this.documents.read(app, url, 'markdown');
    if (!doc.content.trim()) throw nextStatus('报告正文尚未完整读回');
    if (!job.unique && !previous && doc.title !== job.title) await this.documents.rename(app, url, job.title);
    return { url };
  }

  async writeSource(job, task) {
    if (!job.parent) throw conflict('原始资料目录缺失，请核对飞书文件夹后重试');
    const app = task.feishuApp;
    const title = '行研原始资料 ' + job.id;
    let url = job.url;
    if (!url && job.creating) {
      url = await this.documents.findFile(app, job.parent, title);
      if (!url) throw nextStatus('文件上传结果尚未确认，平台将继续核对目录');
    }
    if (!url) {
      this.check(job, task);
      job.creating = true;
      this.store.putSaveJob(job);
      try { url = await this.documents.upload(app, job.parent, title, task.internal.source); }
      catch (error) {
        if (error.definitelyRejected) { job.creating = false; this.store.putSaveJob(job); }
        throw error;
      }
    }
    job.url = url;
    this.store.putSaveJob(job);
    this.check(job, task, url);
    await this.documents.rename(app, url, job.title, 'allow');
    return { url };
  }

  async writeIndex(job, task, payload, dependency) {
    const app = task.feishuApp, company = job.role === 'companyIndex';
    const field = company ? 'companies' : 'reports';
    const parse = company ? parseLibraryManifest : parseAnalysisManifest;
    const entry = company ? { ...dependency, taskId: task.id } : {
      title: task.direction, url: dependency.url, companies: task.analysis.companies, dimensions: task.analysis.dimensions,
      insufficient: payload.insufficient, taskId: task.id, updatedAt: job.updatedAt ?? stamp(),
    };
    job.updatedAt = entry.updatedAt;
    this.store.putSaveJob(job);
    const url = await this.ensure(job, task, jsonBlock({ [field]: [] }));
    this.check(job, task, url);
    const doc = await this.documents.read(app, url);
    const content = doc.content.replace(/<title(?:\s[^>]*)?>[\s\S]*?<\/title>/i, '').trim();
    const current = (!plainXml(content).trim() && job.previousIndex ? job.previousIndex : parse(plainXml(content)))
      .filter(item => !documentRemoved(this.store, task.feishuRoot, task.feishuApp, item.url));
    const matches = value => company ? value.name === entry.name : value.url === entry.url;
    const old = current.find(matches);
    if (company && old && old.url !== entry.url) throw conflict('索引中的公司链接已变更，请核对后重试');
    if (company && old) entry.dimensions = [...new Set([...old.dimensions, ...entry.dimensions])];
    const same = candidate => candidate && matches(candidate) && candidate.url === entry.url &&
      candidate.updatedAt === entry.updatedAt && JSON.stringify(candidate.dimensions) === JSON.stringify(entry.dimensions);
    if (!same(old)) {
      this.check(job, task, url);
      const anchor = /^<pre\s+[^>]*\b(?:id|block-id)="([\w-]+)"[^>]*>(?:(?!<\/pre>)[\s\S])*<\/pre>$/i.exec(content)?.[1];
      if (!anchor && !job.previousIndex) {
        job.previousIndex = current;
        this.store.putSaveJob(job);
      }
      await this.documents.update(app, url, doc.revision, jsonBlock({ [field]: [...current.filter(value => !matches(value)), entry] }), anchor, true);
      if (!parse((await this.documents.read(app, url, 'markdown')).content).some(same)) throw nextStatus('索引尚未读回本次变更');
    }
    delete job.previousIndex;
    return { url, entry };
  }

  recordProgress(taskId, job) {
    const task = this.service.require(taskId);
    if (job.role === 'report') task.publication.url = job.result.url;
    if (job.role === 'minutes') task.publication.minutesUrl = job.result.url;
    if (job.role === 'source') task.publication.sourceMaterialUrl = job.result.url;
    if (job.role === 'topicTotal') {
      const key = topicDocumentKey(task);
      this.store.saveSetting(key, { ...this.store.setting(key), url: job.result.url });
      if (!task.topic.window || task.topic.workflowVersion !== 468) task.publication.url = job.result.url;
      else task.publication.topicTotalUrl = job.result.url;
    }
    if (job.role === 'companyIndex') {
      const { taskId: sourceTaskId, ...entry } = job.result.entry;
      mergeCompanyDelivery(this.store, task, { libraryFolderToken: job.parent, manifestUrl: job.result.url, companies: [entry] });
    }
    if (task.topic && job.role === 'report') this.store.saveSetting(topicDailyDocumentKey(task), { url: job.result.url });
    this.store.save(task);
  }

  finish(id) {
    const task = this.service.require(id);
    if (task.status !== 'running') return;
    const jobs = this.store.saveJobs(id);
    const failed = jobs.find(job => job.status === 'failed');
    const reachable = job => job.status !== 'failed' && prerequisites(job, jobs).every(reachable);
    const canProgress = jobs.some(job => ['running', 'pending'].includes(job.status) && reachable(job));
    if (canProgress) {
      task.stage = jobs.some(job => job.status === 'running') ? 'saving' : 'waiting_save';
      this.service.save(task);
      return;
    }
    if (failed) { this.fail(task, failed.error); return; }
    try { this.finishDelivery(task, jobs); }
    catch (error) { this.fail(task, error instanceof ServiceError ? error.message : '交付元信息需核对，已经写入的文档已保留'); }
  }

  finishDelivery(task, jobs) {
    const store = this.store, save = task.queuedSave;
    const companies = jobs.filter(job => job.role === 'company' && job.result).map(job => job.result);
    const index = jobs.find(job => job.role === 'companyIndex')?.result;
    const details = { folderToken: task.feishuRoot.folderToken, url: task.publication.url ?? companies[0]?.url,
      noUpdates: save.noUpdates, partial: save.partial, requestId: save.requestId,
      ...(index ? { libraryFolderToken: library(store, task.feishuRoot, task.feishuApp).folderToken, manifestUrl: index.url, companies } : {}),
    };
    if (task.briefing) details.reportFolderToken = store.setting(briefingKey(task))?.folderToken;
    if (task.topic) {
      const modern = task.topic.workflowVersion === 468;
      const folders = store.setting(modern ? topicFolderKey(task) : legacyTopicFolderKey(task));
      Object.assign(details, { reportFolderToken: modern && task.topic.window ? folders.dailyFolderToken : folders.folderToken,
        topicFolderToken: modern ? folders.folderToken : undefined, topicRootFolderToken: folders.topicsFolderToken,
        topicDailyFolderToken: folders.dailyFolderToken, topicTotalUrl: task.publication.topicTotalUrl });
    }
    if (task.internal) {
      const folders = store.setting(internalFolderKey(task));
      Object.assign(details, { reportFolderToken: folders.transcriptFolderToken, materialFolderToken: folders.materialFolderToken,
        minutesFolderToken: folders.minutesFolderToken, sourceFolderToken: folders.sourceFolderToken, companies,
        sourceMaterialUrl: task.publication.sourceMaterialUrl ?? (task.internal.sourceType === 'url' ? task.internal.source : undefined),
        minutesUrl: task.publication.minutesUrl, sourceTitle: save.sourceTitle ?? task.internal.sourceLabel });
    }
    if (task.analysis) {
      const result = jobs.find(job => job.role === 'analysisIndex').result;
      const { taskId, ...report } = result.entry;
      Object.assign(details, { analysisFolderToken: analysisLibrary(store, task.feishuRoot, task.feishuApp).folderToken,
        analysisManifestUrl: result.url, report });
    }
    // A company-only run can legitimately have no verified change and no document.
    const delivery = details.url ? agentDeliverySchema.parse({ ...details, status: 'published' }) : { ...details, status: 'published' };
    store.transaction(() => this.service.completeQueuedSave(task, delivery));
    if (task.briefing || task.topic?.window) void this.service.notifications?.send(task.id).catch(() => {});
    if (task.internal) void this.service.internalNotifications?.send(task.id).catch(() => {});
  }

  fail(task, message) {
    task.status = 'failed';
    task.stage = 'waiting_save';
    task.error = message;
    task.publication = { ...task.publication, status: 'failed', error: message };
    this.service.save(task);
  }

  recover(task) {
    if (!task.queuedSave) return false;
    if (task.status === 'running') this.finish(task.id);
    return true;
  }

  retry(task) {
    if (!['failed', 'interrupted'].includes(task.status)) throw conflict('当前任务不需要重试保存');
    this.assertTask(task);
    this.store.transaction(() => {
      for (const job of this.store.saveJobs(task.id).filter(job => job.status === 'failed')) {
        this.store.putSaveJob({ ...job, status: 'pending', nextAt: 0 });
      }
      task.status = 'running';
      task.stage = 'waiting_save';
      task.error = null;
      task.publication = { ...task.publication, status: 'publishing', error: null };
      this.store.save(task);
    });
    this.finish(task.id);
    this.wake();
    return this.service.require(task.id);
  }

  cancel(task) {
    if (task.status !== 'running') throw conflict('任务当前未在执行');
    if ([...this.running.values()].some(run => run.job.taskId === task.id)) throw conflict('飞书写入正在确认，请稍后取消待保存项目');
    task.status = 'interrupted';
    task.stage = 'waiting_save';
    task.publication = { ...task.publication, status: 'interrupted' };
    this.service.save(task);
    return task;
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.running.values(), ...this.submissions.values()].map(run => run.promise));
  }
}
