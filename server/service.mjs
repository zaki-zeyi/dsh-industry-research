import { RESEARCH_TIMEOUT_MS } from './cloud-research.mjs';
import { industryInputSchema, library, mergeCompanyDelivery } from './industry.mjs';
import { analysisInputSchema, analysisLibrary, mergeAnalysisDelivery, missingAnalysisSources } from './analysis.mjs';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { folderSettings, folderCacheKey } from './feishu-folder.mjs';
import { newId } from './store.mjs';
import { promptFor, reportSchema } from './report.mjs';
import { agentDeliverySchema, agentPublication } from './agent-delivery.mjs';

export const createSchema = z.object({ direction: z.string().trim().min(2, '调研方向至少填写两个字').max(200), sources: z.string().trim().min(1).max(2000).default('web'), prompt: z.string().trim().min(10).max(14000).optional(), industry: industryInputSchema.optional(), analysis: analysisInputSchema.optional() }).strict().refine(value => !(value.industry && value.analysis), '任务不能同时包含公司调研和友商分析配置');
const creationPermit = Symbol('feishu-bound');
export class ServiceError extends Error { constructor(status, message) { super(message); this.status = status; } }
export class ResearchService {
  constructor(store, researcher, publisher, { mode = 'demo' } = {}) {
    this.store = store; this.researcher = researcher; this.publisher = publisher; this.mode = mode; this.bus = new EventEmitter(); this.active = new Map(); this.queue = []; this.closed = false;
  }
  require(id) { const t = this.store.get(id); if (!t) throw new ServiceError(404, '调研任务不存在'); return t; }
  event(id, type, data) { const e = this.store.event(id, type, data); this.bus.emit(id, e); return e; }
  save(task) { this.store.save(task); this.event(task.id, 'state', { status: task.status, stage: task.stage, publication: task.publication.status }); }
  feishuSettings(application = this.binding?.applicationSnapshot?.()) {
    const settings = { ...(this.store.setting('feishu') ?? { rootName: '行研工作台' }), ...(application?.profile ? { applicationProfile: application.profile } : {}) };
    const cached = !settings.folderToken && this.store.setting(folderCacheKey(settings));
    return cached?.folderToken ? { ...settings, folderToken: cached.folderToken } : settings;
  }
  setFeishuSettings(input) { this.store.saveSetting('feishu', folderSettings(input)); return this.feishuSettings(); }
  prepareCloudRoot(task) {
    if (task.feishuRoot.folderToken) return;
    const current = this.feishuSettings(task.feishuApp ?? { mode: 'default' });
    if (current.rootName === task.feishuRoot.rootName && current.folderToken) { task.feishuRoot = { ...current }; return; }
    const key = folderCacheKey(task.feishuRoot), cached = this.store.setting(key);
    if (cached?.folderToken) { task.feishuRoot.folderToken = cached.folderToken; return; }
    if (cached?.owner && cached.owner !== task.id) throw new ServiceError(409, '目录创建结果尚待核对，请在“设置飞书根目录”提供已有文件夹链接后重试');
    task.feishuRoot.creationUncertain = Boolean(cached?.owner);
    if (!cached) this.store.saveSetting(key, { owner: task.id });
  }
  rememberCloudFolder(task, delivery) {
    if (!delivery.folderToken) return;
    if (task.feishuRoot.folderToken && delivery.folderToken !== task.feishuRoot.folderToken) throw new ServiceError(409, '交付目录与指定文件夹不一致，请在原会话核对');
    task.feishuRoot.folderToken = delivery.folderToken;
    delete task.feishuRoot.creationUncertain;
    if (!task.feishuRoot.folderUrl) this.store.saveSetting(folderCacheKey(task.feishuRoot), { folderToken: delivery.folderToken });
  }
  async createAuthorized(input, key) { if (this.cloudOnly) await this.binding.requireBound(); return this.create(input, key, creationPermit); }
  create(input, key, permit) {
    if (this.cloudOnly && permit !== creationPermit) throw new ServiceError(428, '请先绑定飞书再启动调研');
    const data = createSchema.parse(input); const serialized = JSON.stringify(data);
    if (key) { const prior = this.store.request(key); if (prior) { if (prior.input !== serialized) throw new ServiceError(409, '该请求标识已用于不同的任务'); return this.require(prior.task_id); } }
    const id = newId(); const now = new Date().toISOString(); const application = this.binding?.applicationSnapshot?.() ?? { mode: 'default' }; const root = this.feishuSettings(application);
    if (data.analysis && !this.cloudOnly) throw new ServiceError(409, '友商分析需要在 DSH 原生会话中运行，并将报告保存到飞书');
    const sourceLibrary = data.analysis ? library(this.store, root, application) : null;
    if (data.analysis) {
      const missing = missingAnalysisSources(sourceLibrary, data.analysis.companies);
      if (missing.length) throw new ServiceError(409, `以下公司尚无全量信息库报告：${missing.join('、')}，请先更新全量信息库`);
    }
    const task = { id, industry: data.industry, analysis: data.analysis, analysisSources: sourceLibrary, analysisIndex: data.analysis ? analysisLibrary(this.store, root, application) : undefined, feishuApp: application, cloudOnly: Boolean(this.cloudOnly), feishuRoot: root, autoUpload: this.researcher.transport === 'dsh-native' && this.publisher.kind === 'agent', ai: this.researcher.transport === 'dsh-native' ? { agent: 'dsh-native', configuration: 'host' } : this.aiSettings?.snapshot() ?? { agent: 'codex' }, direction: data.direction, sources: data.sources, prompt: data.prompt ?? promptFor(data.direction, data.sources, root.rootName, root.folderUrl), mode: this.mode, terminalMode: this.researcher.transport === 'pty', nativeSession: this.researcher.transport === 'dsh-native', status: 'queued', stage: 'queued', createdAt: now, updatedAt: now, runs: [], reports: [], report: null, draft: '', error: null, publication: { ...(this.publisher.kind === 'agent' ? { owner: 'agent' } : {}), target: this.publisher.kind === 'agent' ? 'feishu' : this.publisher.kind ?? (this.mode === 'demo' ? 'demo' : 'feishu'), status: 'pending', documentId: null, url: null, writtenBlocks: 0 } };
    this.store.transaction(() => { this.store.save(task); this.store.event(id, 'user', task.prompt); if (key) this.store.saveRequest(key, serialized, id); });
    this.enqueue(id, 'research'); return this.require(id);
  }
  enqueue(id, stage) { if (this.closed) return; this.queue.push({ id, stage }); queueMicrotask(() => this.drain()); }
  drain() {
    if (this.closed || this.active.size || !this.queue.length) return;
    const { id, stage } = this.queue.shift(); const controller = new AbortController();
    this.active.set(id, { controller, promise: null });
    const promise = this.execute(id, stage, controller.signal).finally(() => { this.active.delete(id); this.drain(); });
    this.active.get(id).promise = promise;
  }
  async execute(id, stage, signal) {
    const t = this.require(id);
    try {
      if (stage === 'research') {
        t.status = 'running'; t.stage = 'research'; t.error = null; t.mode = this.mode === 'native' && !t.nativeSession ? (t.mode ?? 'codex') : this.mode;
        const run = { id: newId(), ...(t.cloudOnly ? { feishuApp: t.feishuApp ?? { mode: 'default' } } : {}), startedAt: new Date().toISOString(), sessionId: null, status: 'running' }; t.runs.push(run); this.save(t);
        if (t.industry) { t.industryLibrary = library(this.store, t.feishuRoot, t.feishuApp); this.save(t); }
        if (t.analysis) {
          t.analysisSources = library(this.store, t.feishuRoot, t.feishuApp);
          const missing = missingAnalysisSources(t.analysisSources, t.analysis.companies);
          if (missing.length) throw new Error(`以下公司尚无全量信息库报告：${missing.join('、')}`);
          t.analysisIndex = analysisLibrary(this.store, t.feishuRoot, t.feishuApp);
          this.save(t);
        }
        if (t.cloudOnly) { await this.binding.requireBound(t.feishuApp ?? { mode: 'default' }); this.prepareCloudRoot(t); this.save(t); }
        const report = await this.researcher.run(t, {
          signal,
          emit: (type, data) => this.event(id, type, type === 'cli' ? { ...data, runId: run.id } : data),
          session: sessionId => { run.sessionId = sessionId; if (t.nativeSession) t.nativeSessionId = sessionId; this.save(t); },
          terminal: terminalId => { run.terminalId = terminalId; t.terminalId = terminalId; t.terminalMode = !t.nativeSession; this.save(t); },
          checkpoint: text => { t.draft = text; this.save(t); },
        });
        signal.throwIfAborted();
        if (t.cloudOnly) {
          const delivery = agentDeliverySchema.parse(report.cloudDelivery);
          if (delivery.status !== 'published') throw new Error('未收到有效飞书报告链接');
          this.rememberCloudFolder(t, delivery);
          if (t.analysis) {
            if (!delivery.report) throw new Error('友商分析未交付报告元信息');
            if (delivery.url !== delivery.report.url) throw new Error('友商分析回执中的报告链接不一致');
            t.analysisReport = mergeAnalysisDelivery(this.store, t, delivery);
          } else {
            mergeCompanyDelivery(this.store, t, delivery);
            if (t.industry && t.industry.companies.some(name => !delivery.companies?.some(c => c.name === name))) throw new Error('部分公司未交付，已保存完成的公司，请重试补齐');
          }
          t.publication = agentPublication(delivery); t.status = 'ready'; t.stage = 'done';
          run.status = 'completed'; run.endedAt = new Date().toISOString(); this.save(t);
          this.event(id, 'system', '报告已保存到飞书，可从首页报告卡片打开；原生会话可继续对话。'); return;
        }
        t.stage = 'report'; this.save(t);
        t.report = { ...reportSchema.parse(report), version: t.reports.length + 1, createdAt: new Date().toISOString() };
        t.reports.push(t.report); t.draft = t.report.markdown; t.status = 'ready'; run.status = 'completed'; run.endedAt = new Date().toISOString(); this.save(t);
      }
      signal.throwIfAborted();
      t.stage = 'publish'; t.publication.status = 'publishing'; t.publication.error = null; this.save(t);
      const publisher = this.publisher;
      t.publication = await publisher.publish(t, p => { t.publication = { ...p }; this.save(t); }, signal);
      signal.throwIfAborted(); t.stage = t.publication.owner === 'agent' && !['published', 'not_requested'].includes(t.publication.status) ? 'agent_delivery' : 'done'; this.save(t);
      if (t.autoUpload && t.publication.owner === 'agent' && t.publication.status === 'not_requested') {
        try { this.publishToFeishu(id, true); }
        catch (error) { const latest = this.require(id); latest.publication = { ...latest.publication, status: 'failed', error: error.message }; latest.stage = 'agent_delivery'; this.save(latest); }
        return;
      }
      this.event(id, 'system', t.publication.owner === 'agent' ? (t.publication.status === 'published' ? '终端 Agent 已回传飞书文档链接。' : '报告已生成并保留副本，可点击“上传飞书”交给终端 Agent 保存。') : t.publication.target === 'local' ? '报告已保存到本地文档。' : t.publication.target === 'feishu' ? '报告已成功保存到飞书。' : '报告已保存到本地演示文档。真实模式会返回飞书链接。');
    } catch (e) {
      const message = signal.aborted ? '执行已中断，已保留内容和记录' : (e.message ?? '任务执行失败');
      if (t.stage === 'publish') { t.publication.status = signal.aborted ? 'interrupted' : 'failed'; t.publication.error = message; }
      else { t.status = signal.aborted ? 'interrupted' : 'failed'; t.error = message; const run = t.runs.at(-1); if (run) { run.status = t.status; run.endedAt = new Date().toISOString(); } }
      if (t.cloudOnly) { const saved = this.require(id); if (saved.feishuRoot?.folderToken) t.feishuRoot = saved.feishuRoot; }
      this.save(t); this.event(id, 'error', message);
    }
  }
  retry(id, stage) {
    const t = this.require(id);
    if (t.nativeSession && !this.nativeSessions) throw new ServiceError(503, '请在宿主 DSH 插件中重试此原生会话');
    if (this.active.has(id) || this.queue.some(x => x.id === id)) throw new ServiceError(409, '任务正在执行，请勿重复重试');
    if (stage === 'publish') {
      if (this.publisher.kind === 'agent') throw new ServiceError(410, '飞书保存由终端 Agent 负责，请在原会话中继续保存或授权，不需要重新调研');
      if (!t.report || !['failed', 'interrupted'].includes(t.publication.status)) throw new ServiceError(409, '当前任务不需要重试保存');
      t.publication.status = 'pending';
    } else {
      if (!['failed', 'interrupted'].includes(t.status)) throw new ServiceError(409, '当前任务不需要重试调研');
      if (t.cloudOnly) {
        const chosen = this.binding?.applicationSnapshot?.() ?? { mode: 'default' }, previous = t.feishuApp ?? { mode: 'default' };
        if (chosen.profile !== previous.profile || chosen.mode !== previous.mode || chosen.appId !== previous.appId) {
          if (t.runs.at(-1) && !t.runs.at(-1).feishuApp) t.runs.at(-1).feishuApp = previous;
          t.feishuApp = chosen; t.feishuRoot = this.feishuSettings(chosen);
          this.event(id, 'system', '本次重试使用当前已选的飞书应用，历史执行配置保留。');
        }
      }
      const latest = this.aiSettings?.snapshot();
      if (latest && latest.agent === (t.ai?.agent ?? 'codex')) t.ai = latest;
      t.status = 'queued'; t.stage = 'queued'; t.error = null;
    }
    this.save(t); this.event(id, 'system', stage === 'publish' ? '仅重试保存报告，复用已生成内容。' : t.cloudOnly ? '恢复原会话核对飞书交付，保留任务记录。' : '重新执行调研，保留上次会话与草稿。'); this.enqueue(id, stage); return this.require(id);
  }
  publishToFeishu(id, automatic = false) {
    const t = this.require(id);
    if (t.cloudOnly) throw new ServiceError(409, '报告只存储在飞书，请在原生会话继续处理保存要求');
    if (!t.report) throw new ServiceError(409, '报告尚未生成，请等待调研完成');
    if (!this.terminals) throw new ServiceError(503, '当前服务未启用终端 Agent');
    if (!automatic && (this.active.has(id) || this.queue.some(x => x.id === id))) throw new ServiceError(409, '调研正在收尾，请稍后上传');
    if (t.publication.target === 'feishu' && t.publication.status === 'published') return t;
    const existing = t.terminalId ? this.store.terminal(t.terminalId) : null;
    const authorizationExpired = t.publication.status === 'awaiting_authorization' && t.publication.expiresAt && Date.parse(t.publication.expiresAt) <= Date.now();
    if (!authorizationExpired && t.publication.requestId && ['publishing', 'awaiting_authorization'].includes(t.publication.status) && existing && ['created', 'running'].includes(existing.status)) return t;
    const requestId = newId();
    const manager = t.nativeSession ? this.nativeSessions : this.terminals;
    if (!manager) throw new ServiceError(503, '此宿主原生会话需要在 DSH 插件中继续');
    const meta = manager.queueUpload(t, requestId);
    if (t.publication.target === 'local') t.localPublication = { ...t.publication };
    t.terminalId = meta.id; t.terminalMode = !t.nativeSession;
    t.publication = agentPublication({ status: 'publishing', requestId }); t.stage = 'agent_delivery';
    this.save(t); this.event(id, automatic ? 'system' : 'user', automatic ? '调研已完成，自动交给原会话 Agent 保存到飞书根目录，不重新调研。' : '上传飞书：仅保存当前报告，由终端 Agent 执行，不重新调研。');
    try { manager.dispatchPending(meta.id); } catch {
      this.recordAgentDelivery(id, meta.id, { status: 'failed', requestId, error: '无法发送上传指令，报告已保留，请恢复终端后重试上传。' });
      throw new ServiceError(503, '无法发送上传指令，请恢复终端后重试上传');
    }
    return this.require(id);
  }
  recordAgentDelivery(id, terminalId, input) {
    const t = this.require(id); if (t.terminalId !== terminalId || !t.report && !t.cloudOnly) return;
    const delivery = agentDeliverySchema.parse(input);
    if (t.cloudOnly) {
      const meta = this.store.terminal(terminalId); if (!meta || delivery.requestId !== meta.deliveryRequestId) return;
      try {
        this.rememberCloudFolder(t, delivery);
        if (t.analysis) {
          if (delivery.report) {
            if (delivery.url !== delivery.report.url) return;
            t.analysisReport = mergeAnalysisDelivery(this.store, t, delivery);
          } else if (delivery.status === 'published') return;
        } else {
          mergeCompanyDelivery(this.store, t, delivery);
        }
      } catch { return; }
      // A legacy 10-minute timeout may have rejected a valid receipt containing
      // source timestamps. Recover only a completed, matching delivery within
      // the new 30-minute limit, never a cancelled or genuinely overdue run.
      const run = t.runs.at(-1), elapsed = Date.parse(meta.lastTurnCompletedAt) - Date.parse(run?.startedAt);
      if (!t.analysis && t.status === 'failed' && /超时|超过 30 分钟/.test(t.error ?? '') && meta.activity === 'waiting_input' && meta.lastTurnReason === 'completed' && elapsed >= 0 && elapsed <= RESEARCH_TIMEOUT_MS && delivery.status === 'published' && delivery.folderToken && (!t.industry || t.industry.companies.every(name => delivery.companies?.some(c => c.name === name)))) {
        t.status = 'ready'; t.error = null; run.status = 'completed'; run.endedAt = meta.lastTurnCompletedAt;
        this.event(id, 'system', '已核对原会话有效交付，完成时间未超过 30 分钟，恢复完成状态；未重新调研。');
      }
      this.store.save(t); if (t.status !== 'ready') return;
    }
    if (t.publication.status === 'not_requested' || t.publication.requestId && delivery.requestId !== t.publication.requestId) return;
    const publication = agentPublication(delivery);
    if (JSON.stringify(t.publication) === JSON.stringify(publication)) return;
    t.publication = publication; t.stage = delivery.status === 'published' ? 'done' : 'agent_delivery';
    this.save(t);
    this.event(id, 'agent-delivery', publication);
  }
  agentTerminalExited(id, terminalId) {
    if (this.closed) return;
    const t = this.require(id);
    if (t.terminalId === terminalId && t.report && t.publication.owner === 'agent' && ['waiting_agent', 'publishing'].includes(t.publication.status)) {
      this.recordAgentDelivery(id, terminalId, { ...(t.publication.requestId ? { requestId: t.publication.requestId } : {}), status: 'failed', error: '终端已退出，飞书保存尚未完成；报告已保留，请恢复原会话后继续保存。' });
    }
  }
  cancel(id) {
    const t = this.require(id); const active = this.active.get(id);
    if (active) active.controller.abort();
    else { const index = this.queue.findIndex(x => x.id === id); if (index < 0) throw new ServiceError(409, '任务当前未在执行'); this.queue.splice(index, 1); t.status = 'interrupted'; t.stage = 'queued'; this.save(t); }
    return this.require(id);
  }
  recover() {
    for (const t of this.store.list()) {
      if (t.status === 'queued') this.enqueue(t.id, 'research');
      else if (t.status === 'running') { t.status = 'interrupted'; t.error = t.cloudOnly ? '服务重启导致调研中断，任务与会话已保留，请先核对飞书文档后重试' : '服务重启导致调研中断，已保留草稿与会话，请重试'; const run = t.runs.at(-1); if (run) run.status = 'interrupted'; this.save(t); this.event(t.id, 'system', t.error); }
      else if (t.report && t.publication.owner === 'agent' && t.publication.requestId && t.publication.status === 'publishing') { t.publication.status = 'failed'; t.publication.error = '服务重启导致上传中断，报告已保留，请点击重试上传，由 Agent 先核对已有文档。'; this.save(t); }
      else if (t.report && t.autoUpload && t.publication.status === 'not_requested') this.enqueue(t.id, 'publish');
      else if (t.report && ['publishing', 'pending'].includes(t.publication.status)) this.enqueue(t.id, 'publish');
    }
  }
  async close() { this.closed = true; const jobs = [...this.active.values()]; for (const j of jobs) j.controller.abort(); await Promise.allSettled(jobs.map(j => j.promise)); this.bus.removeAllListeners(); }
}
