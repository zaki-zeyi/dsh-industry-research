import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { parseReport } from '../report.mjs';

export class CodexTerminalResearcher {
  transport = 'pty';
  constructor(terminals, { timeoutMs = 600000 } = {}) { this.terminals = terminals; this.timeoutMs = timeoutMs; }
  async run(task, { signal, terminal, checkpoint }) {
    const prior = task.terminalId ? this.terminals.get(task.terminalId) : null;
    if (prior && (task.runs?.length ?? 0) > 1) { this.terminals.stop(prior.id); prior.status = 'interrupted'; this.terminals.store.saveTerminal(prior); }
    const meta = this.terminals.create(task, { collectReport: true, resumeId: prior?.sessionId, resumeLast: Boolean(task.terminalId) });
    terminal(meta.id);
    const stop = () => this.terminals.stop(meta.id); signal.addEventListener('abort', stop, { once: true });
    const start = Date.now(); let previous = '', invalid;
    try {
      while (Date.now() - start < this.timeoutMs) {
        signal.throwIfAborted();
        if (existsSync(meta.reportPath)) {
          const text = readFileSync(meta.reportPath, 'utf8');
          if (text !== previous) {
            previous = text; checkpoint(text);
            let report; try { report = parseReport(text); } catch(e) { invalid = e; }
            if (report) { this.terminals.acceptReport(meta.id); return report; }
          }
        }
        const state = this.terminals.get(meta.id);
        if (state.agent === 'dsh' && state.lastTurnReason === 'error') throw new Error(state.lastTurnErrorCode === 'INVALID_CREDENTIAL' || state.lastTurnErrorCode === 'MISSING_CREDENTIAL' ? 'dsh tui 的模型凭据无效，请在 DSH 中检查模型配置或登录后重试；原会话已保留' : 'dsh tui 本轮 API 调用失败，请检查配置或查看终端详情后重试；原会话已保留');
        if (['exited', 'failed', 'interrupted'].includes(state.status)) throw invalid ?? new Error(state.error ?? '终端已退出，未生成有效报告。终端记录已保留。');
        await delay(300, null, { signal });
      }
      stop(); throw new Error('调研等待报告超时，终端记录已保留');
    } finally { signal.removeEventListener('abort', stop); }
  }
}
