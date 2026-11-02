import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { newId } from './store.mjs';
import { executionPrompt, parseReport } from './report.mjs';
import { uploadPrompt } from './upload-prompt.mjs';
import { agentDeliverySchema } from './agent-delivery.mjs';
import { cloudPrompt, waitCloudDelivery, RESEARCH_TIMEOUT_MS } from './cloud-research.mjs';
import { ServiceError } from './service.mjs';

// The host owns model credentials, tools, message history and Agent lifetime.
export class NativeSessions {
  constructor(store, host, { workRoot, pollMs = 200 } = {}) {
    this.store = store; this.host = host; this.workRoot = workRoot; this.bySession = new Map(); this.closed = false;
    for (const meta of store.terminalList()) if (meta.agent === 'dsh-native') this.bySession.set(meta.sessionId, meta.id);
    this.disposeEvent = host.on('session/event', (session, event) => this.observeEvent(String(session.id), event));
    this.timer = setInterval(() => this.observeDeliveries(), pollMs); this.timer.unref();
  }
  get(id) { const meta = this.store.terminal(id); if (!meta || meta.agent !== 'dsh-native') throw new ServiceError(404, '宿主会话绑定不存在'); return meta; }
  async create(task) {
    const prior = task.terminalId ? this.store.terminal(task.terminalId) : null;
    const id = newId(), cwd = resolve(this.workRoot, task.id); mkdirSync(cwd, { recursive: true });
    const workspace = resolve(this.workRoot, 'workspace'); mkdirSync(workspace, { recursive: true });
    const created = prior?.agent === 'dsh-native' ? null : await this.host.sessionController.create({ cwd: workspace, agentPreset: 'standard' });
    const sessionId = created ? created.sessionId : prior.sessionId;
    const resolved = await this.host.sessionController.resolveAgent(sessionId);
    if (!resolved.agent) throw new ServiceError(503, '无法恢复宿主 DSH 会话，历史记录已保留');
    if (!prior || prior.agent !== 'dsh-native') this.host.permissionPresets.set(resolved.agent.session, 'danger-full-access');
    const meta = { id, taskId: task.id, agent: 'dsh-native', sessionId, agentPreset: created?.agentPreset ?? prior?.agentPreset, cwd, reportPath: resolve(cwd, `report-${id}.json`), promptPath: resolve(cwd, `prompt-${id}.txt`), status: 'running', activity: 'waiting_input', workflow: 'manual-upload', createdAt: new Date().toISOString() };
    if (task.cloudOnly) { meta.workflow = 'cloud-only'; meta.targetFolderToken = task.feishuRoot.folderToken; meta.reportPath = undefined; meta.deliveryRequestId = newId(); meta.deliveryPath = resolve(cwd, `delivery-${meta.deliveryRequestId}.json`); }
    writeFileSync(meta.promptPath, task.cloudOnly ? cloudPrompt(task, meta) : `${executionPrompt(task)}\n\n请将完整报告 JSON 保存到 ${meta.reportPath}。本轮只生成报告，完成后立即结束当前轮次并等待用户新要求，不重复调研。平台会在本轮结束后自动发送保存指令；收到该独立指令后再执行保存或授权。`);
    this.store.saveTerminal(meta); this.bySession.set(sessionId, id); return meta;
  }
  async send(id, text) {
    const meta = this.get(id); meta.activity = 'working'; meta.lastTurnReason = null; meta.lastTurnErrorCode = null; meta.lastTurnCompletedAt = null; meta.lastSubmittedAt = new Date().toISOString(); this.store.saveTerminal(meta);
    try {
      await this.host.sessionController.prompt({ sessionId: meta.sessionId, requestId: newId(), mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' }, new AbortController().signal);
    } catch (cause) { meta.activity = 'waiting_input'; this.store.saveTerminal(meta); throw Object.assign(new ServiceError(503, '宿主会话未接受指令，请检查 DSH 模型配置后重试'), { cause }); }
  }
  cancel(id) { this.host.sessionController.cancel({ sessionId: this.get(id).sessionId }); }
  observeEvent(sessionId, event) {
    const id = this.bySession.get(sessionId); if (!id || this.closed) return;
    const meta = this.get(id);
    if (event.type === 'turn/start') meta.activity = 'working';
    else if (event.type === 'turn/end') { meta.activity = 'waiting_input'; meta.lastTurnReason = event.data?.reason?.kind; meta.lastTurnCompletedAt = new Date().toISOString(); meta.lastTurnErrorCode = /^[A-Z0-9_]{1,64}$/.test(event.data?.reason?.error?.code ?? '') ? event.data.reason.error.code : undefined; }
    else return;
    this.store.saveTerminal(meta);
    if (event.type === 'turn/end' && meta.deliveryRequestId) {
      this.observeDeliveries(); const latest = this.get(id);
      if (!latest.delivery || latest.delivery.requestId !== latest.deliveryRequestId || latest.delivery.status === 'publishing') {
        this.onDelivery?.(meta.taskId, id, { requestId: latest.deliveryRequestId, status: 'failed', error: meta.workflow === 'cloud-only' ? '本轮飞书交付未完成，请在原生会话核对后重试；任务记录已保留。' : '本轮宿主会话已结束但未交付有效上传结果；报告已保留，请在原生会话核对后重试上传。' });
      }
    }
    this.onActivity?.(meta.taskId);
  }
  queueUpload(task, requestId) {
    const meta = this.get(task.terminalId);
    if (meta.activity !== 'waiting_input') throw new ServiceError(409, '宿主会话正在处理其他要求，请等待本轮结束后上传');
    const markdownName = `upload-report-${requestId}.md`;
    writeFileSync(resolve(meta.cwd, markdownName), `# ${task.report.title}\n\n${task.report.summary}\n\n${task.report.markdown}\n\n## 数据来源\n${task.report.sources.map(s => `${s.id} · ${s.title}\n${s.url}\n${s.excerpt}`).join('\n\n')}`);
    Object.assign(meta, { deliveryRequestId: requestId, deliveryPath: resolve(meta.cwd, `delivery-${requestId}.json`), qrPath: resolve(meta.cwd, `feishu-auth-${requestId}.png`), deliveryKey: null, delivery: null, pendingPromptPath: resolve(meta.cwd, `upload-prompt-${requestId}.txt`) });
    writeFileSync(meta.pendingPromptPath, uploadPrompt(task, meta, requestId, markdownName)); this.store.saveTerminal(meta); return meta;
  }
  dispatchPending(id) {
    const meta = this.get(id); if (!meta.pendingPromptPath) return;
    const path = meta.pendingPromptPath; meta.pendingPromptPath = null; this.store.saveTerminal(meta);
    void this.send(id, `请读取 ${path}，按照该文件中的用户上传要求执行。本次只上传已有报告，不重新调研。`).catch(() => this.onDelivery?.(meta.taskId, id, { requestId: meta.deliveryRequestId, status: 'failed', error: '宿主会话未接受上传指令，报告已保留，请重试。' }));
  }
  observeDeliveries() {
    for (const id of this.bySession.values()) {
      const meta = this.get(id); if (!meta.deliveryRequestId || !meta.deliveryPath) continue;
      let receipt; try { const text = readFileSync(meta.deliveryPath, 'utf8'); if (text.length > 524288) continue; receipt = agentDeliverySchema.parse(JSON.parse(text)); } catch { continue; }
      if (receipt.requestId !== meta.deliveryRequestId || JSON.stringify(receipt) === meta.deliveryKey) continue;
      meta.deliveryKey = JSON.stringify(receipt); meta.delivery = receipt; this.store.saveTerminal(meta); this.onDelivery?.(meta.taskId, id, receipt);
    }
  }
  close() { this.closed = true; clearInterval(this.timer); this.disposeEvent?.(); }
}

export class NativeResearcher {
  transport = 'dsh-native';
  constructor(sessions, { timeoutMs = RESEARCH_TIMEOUT_MS, legacy } = {}) { this.sessions = sessions; this.timeoutMs = timeoutMs; this.legacy = legacy; }
  async run(task, { signal, terminal, session, checkpoint }) {
    if (!task.nativeSession && this.legacy) return this.legacy.run(task, { signal, terminal, session, checkpoint });
    const meta = await this.sessions.create(task); terminal(meta.id); session(meta.sessionId);
    const cancel = () => { try { this.sessions.cancel(meta.id); } catch {} }; signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted(); await this.sessions.send(meta.id, `请读取 ${meta.promptPath}，按照该文件中的本次用户调研任务执行。`);
      if (task.cloudOnly) return await waitCloudDelivery(this.sessions, meta, { signal, timeoutMs: this.timeoutMs });
      const start = Date.now(); let previous, invalid, report;
      while (Date.now() - start < this.timeoutMs) {
        signal.throwIfAborted();
        if (existsSync(meta.reportPath)) {
          const text = readFileSync(meta.reportPath, 'utf8');
          if (text !== previous) { previous = text; checkpoint(text); try { report = parseReport(text); } catch (error) { invalid = error; } }
        }
        const state = this.sessions.get(meta.id);
        if (state.lastTurnReason === 'error') throw new Error('宿主 DSH 会话本轮执行失败，请在原生会话查看详情或修正模型配置后重试；会话和草稿已保留');
        if (report && state.activity === 'waiting_input') return report;
        if (state.lastTurnCompletedAt && state.lastTurnReason !== 'error') throw invalid ?? new Error('本轮会话已结束，但未生成完整报告；请查看原生会话或重试，历史记录已保留');
        await delay(150, null, { signal });
      }
      cancel(); throw new Error('等待宿主会话报告超时；会话与草稿已保留');
    } finally { signal.removeEventListener('abort', cancel); }
  }
}
