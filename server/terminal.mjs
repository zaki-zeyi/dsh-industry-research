import '../scripts/prepare-pty.mjs';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pty from 'node-pty';
import { dshLaunch } from './dsh-launch.mjs';
import { resolveCodexLaunch } from './codex-launch.mjs';
import { WebSocketServer, WebSocket } from 'ws';
import { newId } from './store.mjs';
import { ServiceError } from './service.mjs';
import { executionPrompt } from './report.mjs';
import { agentDeliverySchema } from './agent-delivery.mjs';
import { uploadPrompt } from './upload-prompt.mjs';
import { prepareLarkAgent } from './lark-agent-files.mjs';

// PRD default for workbench-owned processes; no global Codex config is modified.
export const TERMINAL_PERMISSIONS = Object.freeze({ sandbox: 'danger-full-access', approval: 'on-request' });

export class TerminalManager {
  get permissions() { return TERMINAL_PERMISSIONS; }
  constructor(store, config = {}) {
    this.store = store; this.config = config; this.live = new Map(); this.bus = new EventEmitter(); this.turnMonitors = new Map(); this.finishTimers = new Map(); this.dshScreens = new Set(); this.initialPrompts = new Map();
    for (const meta of store.terminalList()) if (meta.agent !== 'dsh-native' && ['created', 'running'].includes(meta.status)) { meta.status = 'interrupted'; store.saveTerminal(meta); }
  }
  get(id) { const meta = this.store.terminal(id); if (!meta) throw new ServiceError(404, '终端不存在'); return meta; }
  create(task, { resumeId, resumeLast = false, collectReport = false } = {}) {
    if (task.terminalId) { const old = this.store.terminal(task.terminalId); if (old && ['created', 'running'].includes(old.status)) return old; }
    const id = newId(), cwd = resolve(this.config.workRoot ?? './data/codex', task.id);
    mkdirSync(cwd, { recursive: true });
    const prior = !collectReport && task.terminalId ? this.store.terminal(task.terminalId) : null;
    const reportPath = resolve(cwd, `report-${id}.json`);
    const deliveryPath = prior?.deliveryPath ?? resolve(cwd, `delivery-${id}.json`);
    const qrPath = prior?.qrPath ?? resolve(cwd, `feishu-auth-${id}.png`);
    const prompt = collectReport ? `${executionPrompt(task)}

请将完整报告 JSON 保存到 ${reportPath}。本轮只生成报告，完成后立即简要告知并结束当前轮次，保持终端连接；收到平台另行发送的保存指令后再执行飞书保存或授权，不要重复调研。` : task.prompt;
    const promptPath = resolve(cwd, `prompt-${id}.txt`); writeFileSync(promptPath, prompt);
    const meta = { id, taskId: task.id, agent: prior?.agent ?? task.ai?.agent ?? 'codex', aiConfigId: prior?.aiConfigId ?? task.ai?.configId, sessionPath: resolve(cwd, `session-${id}.json`), cwd, reportPath, deliveryPath, qrPath, promptPath, permissions: { ...TERMINAL_PERMISSIONS }, reportReadyAt: !collectReport && task.report ? new Date().toISOString() : null, completionPath: resolve(cwd, `turn-${id}.json`), resumeId: resumeId ?? null, resumeLast, collectReport, workflow: 'manual-upload', deliveryRequestId: prior?.deliveryRequestId ?? null, status: 'created', activity: collectReport ? 'researching' : 'waiting_input', cols: 100, rows: 30, createdAt: new Date().toISOString() };
    this.store.saveTerminal(meta); return meta;
  }
  queueUpload(task, requestId) {
    let meta = task.terminalId ? this.store.terminal(task.terminalId) : null;
    if (meta && this.live.has(meta.id) && !['waiting_input', 'finishing'].includes(meta.activity)) throw new ServiceError(409, '终端正在处理其他要求，请等待本轮结束后再上传飞书');
    if (!meta || !['created', 'running'].includes(meta.status)) {
      const savedSession = meta?.sessionId ?? task.runs.at(-1)?.sessionId;
      const validId = meta?.agent === 'dsh' || task.ai?.agent === 'dsh' ? /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/ : /^[a-f0-9-]{36}$/;
      const resumeId = validId.test(savedSession ?? '') ? savedSession : undefined;
      meta = this.create(task, { resumeId, resumeLast: Boolean(meta) });
    }
    const markdownName = `upload-report-${requestId}.md`;
    const markdown = `# ${task.report.title}\n\n${task.report.summary}\n\n${task.report.markdown}\n\n## 数据来源\n${task.report.sources.map(s => `${s.id} · ${s.title}\n${s.url}\n${s.excerpt}`).join('\n\n')}`;
    writeFileSync(resolve(meta.cwd, markdownName), markdown);
    Object.assign(meta, { workflow: 'manual-upload', deliveryRequestId: requestId, deliveryPath: resolve(meta.cwd, `delivery-${requestId}.json`), qrPath: resolve(meta.cwd, `feishu-auth-${requestId}.png`), delivery: null, deliveryKey: null, finishedDeliveryKey: null, reportAcceptedAt: null });
    meta.pendingPromptPath = resolve(meta.cwd, `upload-prompt-${requestId}.txt`);
    prepareLarkAgent(meta, this.config.larkCommand);
    writeFileSync(meta.pendingPromptPath, uploadPrompt(task, meta, requestId, markdownName));
    this.store.saveTerminal(meta); return meta;
  }
  dispatchPending(id) {
    const meta = this.get(id);
    if (!meta.pendingPromptPath || !this.live.has(id) || meta.activity !== 'waiting_input') return;
    const prompt = `请读取 ${meta.pendingPromptPath}，按照该文件中的用户上传要求执行。`;
    meta.pendingPromptPath = null; meta.uploadPromptSentAt = new Date().toISOString(); this.store.saveTerminal(meta);
    // Bracketed paste keeps spaces and punctuation in the follow-up intact.
    this.input(id, `\x1b[200~${prompt}\x1b[201~${meta.agent === 'dsh' ? '' : '\r'}`);
    if (meta.agent === 'dsh') setTimeout(() => { if (this.live.has(id)) this.input(id, '\r'); }, 60);
  }
  observeDshReady(id) {
    const pending = this.initialPrompts.get(id); if (!this.dshScreens.has(id) || !this.live.has(id)) return;
    const meta = this.get(id); let state; try { state = JSON.parse(readFileSync(meta.sessionPath, 'utf8')); } catch { return; }
    if (!pending) { if (meta.sessionId !== state.sessionId) { meta.sessionId = state.sessionId; this.store.saveTerminal(meta); } return; }
    meta.activity = pending.pendingUpload ? 'working' : 'researching'; meta.sessionId = state.sessionId; if (pending.pendingUpload) { meta.pendingPromptPath = null; meta.uploadPromptSentAt = new Date().toISOString(); } this.store.saveTerminal(meta);
    this.initialPrompts.delete(id); this.live.get(id).write(`\x1b[200~${pending.text}\x1b[201~`);
    setTimeout(() => { if (this.live.has(id)) this.input(id, '\r'); }, 60);
  }
  frame(id, data) { const frame = this.store.terminalFrame(id, data); this.bus.emit(id, frame); return frame; }
  activity(id, activity, extra = {}) {
    const meta = this.get(id); const changed = meta.activity !== activity;
    Object.assign(meta, extra, { activity }); this.store.saveTerminal(meta);
    if (changed) this.frame(id, { type: 'activity', activity });
  }
  clearFinishTimer(id) { clearTimeout(this.finishTimers.get(id)); this.finishTimers.delete(id); }
  observeCompletion(id) {
    const meta = this.get(id); if (!meta.completionPath) return;
    let completed; try { completed = JSON.parse(readFileSync(meta.completionPath, 'utf8')); } catch { return; }
    if (completed.type !== 'turn-complete' || !Number.isFinite(Date.parse(completed.at)) || meta.lastCompletionKey === `${completed.turnId}:${completed.at}`) return;
    const extra = { lastCompletionKey: `${completed.turnId}:${completed.at}`, lastTurnCompletedAt: completed.at, lastTurnReason: completed.reason, lastTurnErrorCode: completed.errorCode, sessionId: completed.sessionId ?? meta.sessionId };
    // A late callback for the previous turn must not relabel a newer user request.
    if (meta.lastInputSubmittedAt && completed.at < meta.lastInputSubmittedAt) { Object.assign(meta, extra); this.store.saveTerminal(meta); return; }
    this.clearFinishTimer(id); this.activity(id, 'waiting_input', extra);
  }
  observeDelivery(id) {
    const meta = this.get(id); if (!meta.deliveryPath || meta.workflow === 'manual-upload' && !meta.deliveryRequestId) return;
    let delivery;
    try {
      const text = readFileSync(meta.deliveryPath, 'utf8'); if (text.length > 16000) return;
      delivery = agentDeliverySchema.parse(JSON.parse(text));
    } catch { return; } // Partial/invalid writes never become success or interrupt work.
    if (meta.deliveryRequestId && delivery.requestId !== meta.deliveryRequestId) return;
    const key = JSON.stringify(delivery); if (key === meta.deliveryKey) return;
    meta.delivery = delivery; meta.deliveryKey = key; this.store.saveTerminal(meta);
    this.onDelivery?.(meta.taskId, id, delivery);
    this.frame(id, { type: 'delivery', delivery });
    if (meta.reportReadyAt && delivery.status !== 'publishing') this.finishResearch(id);
  }
  acceptReport(id) {
    const meta = this.get(id); meta.reportReadyAt = new Date().toISOString(); this.store.saveTerminal(meta);
    if (!meta.deliveryRequestId || meta.delivery && meta.delivery.status !== 'publishing') this.finishResearch(id);
  }
  finishResearch(id) {
    const meta = this.get(id); if (meta.reportAcceptedAt && meta.finishedDeliveryKey === meta.deliveryKey) return;
    this.observeCompletion(id);
    const current = this.get(id); const acceptedAt = new Date().toISOString();
    if (current.activity === 'waiting_input' || !this.live.has(id)) { this.activity(id, 'waiting_input', { reportAcceptedAt: acceptedAt, finishedDeliveryKey: current.deliveryKey }); return; }
    this.activity(id, 'finishing', { reportAcceptedAt: acceptedAt, finishedDeliveryKey: current.deliveryKey });
    // Give the CLI a short chance to finish its final acknowledgement naturally.
    // If it continues working, send Escape once: cancel the turn, not the PTY.
    const timer = setTimeout(() => {
      this.finishTimers.delete(id);
      const state = this.get(id);
      if (!this.live.has(id) || state.activity !== 'finishing') return;
      if (state.agent === 'dsh') return;
      this.live.get(id).write('\x1b');
      this.activity(id, 'waiting_input', { completionInterruptedAt: new Date().toISOString() });
    }, this.config.settleMs ?? 2000);
    this.finishTimers.set(id, timer);
  }
  activate(id) {
    const meta = this.get(id); if (meta.agent === 'dsh-native') throw new ServiceError(409, '请打开宿主 DSH 原生会话'); if (meta.status !== 'created' || this.live.has(id)) return;
    const c = this.config;
    meta.permissions = { ...TERMINAL_PERMISSIONS, ...(meta.agent === 'dsh' ? { approval: 'never' } : {}) };
    // Initial prompt is read from the task's local file, avoiding large/private process arguments.
    const pendingUpload = meta.pendingPromptPath;
    const initial = `请读取 ${pendingUpload ?? meta.promptPath}，按照该文件中的${pendingUpload ? '用户上传要求' : '本次用户调研任务'}执行。`;
    const notify = [process.execPath, fileURLToPath(new URL('../scripts/terminal-turn-notify.mjs', import.meta.url)), meta.completionPath];
    const args = [...(c.prefixArgs ?? []), ...(meta.resumeId || meta.resumeLast ? ['resume', ...(meta.resumeId ? [meta.resumeId] : ['--last'])] : []), '--no-alt-screen', '--sandbox', meta.permissions.sandbox, '--ask-for-approval', meta.permissions.approval, '--search', '--cd', meta.cwd, '-c', `notify=${JSON.stringify(notify)}`, ...(c.model ? ['--model', c.model] : []), ...(pendingUpload || meta.collectReport || !(meta.resumeId || meta.resumeLast) ? [initial] : [])];
    try {
      const env = Object.fromEntries(Object.entries({ ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }).filter(([k]) => !/^(FEISHU_|WORKBENCH_|CODEX_THREAD_ID$)/.test(k)));
      const settings = c.aiSettings?.resolve(meta.aiConfigId) ?? {};
      let launch;
      if (meta.agent === 'dsh') {
        if (c.dshHome) env.DSH_HOME = c.dshHome;
        delete env.RESEARCH_DSH_API_KEY;
        if (settings.apiKey && settings.configuration !== 'native') env.RESEARCH_DSH_API_KEY = settings.apiKey;
        env.DSH_PERMISSION_MODE = 'danger-full-access';
        launch = dshLaunch(meta, settings, { command: c.dshCommand ?? 'dsh', env }); launch.args = [...(c.dshPrefixArgs ?? []), ...launch.args];
        meta.activity = pendingUpload || meta.collectReport ? 'starting' : 'waiting_input';
        if (pendingUpload || meta.collectReport) this.initialPrompts.set(id, { text: initial, pendingUpload: Boolean(pendingUpload) });
      } else {
        if (settings.apiKey) { env.RESEARCH_CODEX_API_KEY = settings.apiKey; args.push('-c', 'model_provider="industry-research"', '-c', 'model_providers.industry-research.name="Research API"', '-c', `model_providers.industry-research.base_url=${JSON.stringify(settings.baseUrl)}`, '-c', 'model_providers.industry-research.env_key="RESEARCH_CODEX_API_KEY"', '-c', 'model_providers.industry-research.wire_api="responses"', '-c', 'model_providers.industry-research.requires_openai_auth=false', '-c', 'model_providers.industry-research.supports_websockets=false'); }
        launch = resolveCodexLaunch(c.command, args, { env });
      }
      const terminalProcess = pty.spawn(launch.command, launch.args, { name: 'xterm-256color', cwd: meta.cwd, cols: meta.cols, rows: meta.rows, env });
      meta.status = 'running'; if (pendingUpload && meta.agent !== 'dsh') { meta.pendingPromptPath = null; meta.uploadPromptSentAt = new Date().toISOString(); meta.activity = 'working'; } this.store.saveTerminal(meta); this.live.set(id, terminalProcess); this.frame(id, { type: 'status', status: 'running', permissions: meta.permissions, activity: meta.activity });
      this.turnMonitors.set(id, setInterval(() => { this.observeDshReady(id); this.observeCompletion(id); this.observeDelivery(id); this.dispatchPending(id); }, c.pollMs ?? 200));
      terminalProcess.onData(data => { this.frame(id, { type: 'output', data }); if (meta.agent === 'dsh') { const text = data.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''); if (/(?:prompt|输入)\s*[›>]/.test(text)) this.dshScreens.add(id); this.observeDshReady(id); } });
      terminalProcess.onExit(({ exitCode, signal }) => { clearInterval(this.turnMonitors.get(id)); this.turnMonitors.delete(id); this.clearFinishTimer(id); this.live.delete(id); this.initialPrompts.delete(id); this.dshScreens.delete(id); const current = this.get(id); current.status = 'exited'; current.exitCode = exitCode; current.signal = signal; this.store.saveTerminal(current); this.onSessionExit?.(current.taskId, id); this.frame(id, { type: 'status', status: 'exited', exitCode, signal }); });
    } catch(e) { meta.status = 'failed'; meta.error = `无法启动终端：${e.message}`; this.store.saveTerminal(meta); this.onSessionExit?.(meta.taskId, id); this.frame(id, { type: 'status', status: 'failed', error: meta.error }); }
  }
  input(id, data) {
    const process = this.live.get(id); if (!process) throw new ServiceError(409, '终端进程未运行');
    // Device replies and focus reports are emitted by xterm too; they are not user requests.
    const deviceReply = /^(?:\x1b\[[?>=]?[\d;:]*[Rcnuy]|\x1b\[[IO])+$/u.test(data);
    if (data && !deviceReply) {
      const finishing = this.finishTimers.has(id); this.clearFinishTimer(id);
      const submitted = /[\r\n]/.test(data.replace(/\x1b\[200~[\s\S]*?\x1b\[201~/g, ''));
      if (submitted) this.activity(id, 'working', { lastInputSubmittedAt: new Date().toISOString() });
      else if (finishing) this.activity(id, 'waiting_input');
    }
    process.write(data);
  }
  resize(id, cols, rows) {
    if (!Number.isInteger(cols) || cols < 10 || cols > 400 || !Number.isInteger(rows) || rows < 3 || rows > 150) throw new ServiceError(400, '终端尺寸无效');
    const meta = this.get(id); if (meta.cols === cols && meta.rows === rows) return;
    this.live.get(id)?.resize(cols, rows); meta.cols = cols; meta.rows = rows; this.store.saveTerminal(meta); this.frame(id, { type: 'resize', cols, rows });
  }
  stop(id) { const process = this.live.get(id); if (process) { try { process.kill(); } catch {} } else { const meta = this.get(id); if (meta.status === 'created') { meta.status = 'exited'; this.store.saveTerminal(meta); this.frame(id, { type: 'status', status: 'exited' }); } } }
  async close() {
    const ids = [...this.live.keys()];
    await Promise.all(ids.map(id => new Promise(resolve => { const timer = setTimeout(() => { try { this.live.get(id)?.kill('SIGKILL'); } catch {} resolve(); }, 1500); const check = frame => { if (frame.type === 'status' && frame.status === 'exited') { clearTimeout(timer); this.bus.off(id, check); resolve(); } }; this.bus.on(id, check); try { this.stop(id); } catch { clearTimeout(timer); this.bus.off(id, check); resolve(); } })));
    this.bus.removeAllListeners();
    for (const timer of this.turnMonitors.values()) clearInterval(timer); this.turnMonitors.clear();
    for (const timer of this.finishTimers.values()) clearTimeout(timer); this.finishTimers.clear();
  }
}

export function attachTerminalWebSocket(server, manager) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32768 });
  server.on('upgrade', (req, socket, head) => {
    const host = req.headers.host, origin = req.headers.origin;
    const allowed = new Set([`http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host ?? '') || !allowed.has(origin)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const match = /^\/api\/terminals\/([a-f0-9-]+)\/ws$/.exec(req.url ?? '');
    try { if (!match) throw new Error(); manager.get(match[1]); } catch { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      const id = match[1]; let ready = false;
      const send = value => { if (ws.readyState === WebSocket.OPEN) { if (ws.bufferedAmount > 1024 * 1024) { ws.close(1013, '请重连以回放输出'); return; } ws.send(JSON.stringify(value)); } };
      const listener = frame => send({ type: 'frame', frame });
      manager.bus.on(id, listener);
      send({ type: 'snapshot', meta: manager.get(id), frames: manager.store.terminalFrames(id) });
      ws.on('message', raw => {
        try {
          const data = JSON.parse(raw.toString());
          if (data.type === 'ready') { ready = true; manager.activate(id); }
          else if (data.type === 'input' && ready && typeof data.data === 'string' && data.data.length <= 16384) manager.input(id, data.data);
          else if (data.type === 'resize' && ready) manager.resize(id, data.cols, data.rows);
        } catch(e) { send({ type: 'error', error: e.message }); }
      });
      ws.on('error', () => {});
      ws.on('close', () => manager.bus.off(id, listener));
    });
  });
  return { close() { for (const client of wss.clients) client.terminate(); wss.close(); } };
}
