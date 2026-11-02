import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { executionPrompt, parseReport } from '../report.mjs';

export const codexReportSchema = {
  type: 'object', additionalProperties: false,
  required: ['title', 'summary', 'markdown', 'sources'],
  properties: {
    title: { type: 'string' }, summary: { type: 'string' }, markdown: { type: 'string' },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'url', 'excerpt'], properties: { id: { type: 'string' }, title: { type: 'string' }, url: { type: 'string' }, excerpt: { type: 'string' } } } },
  },
};

// One non-interactive CLI process per run. JSONL is the public CLI event contract.
export class CodexResearcher {
  constructor(config = {}) { this.config = config; }
  async run(task, { emit, session, checkpoint, signal }) {
    signal.throwIfAborted();
    const c = this.config;
    const cwd = resolve(c.workRoot ?? './data/codex', task.id);
    mkdirSync(cwd, { recursive: true });
    const schemaPath = resolve(cwd, 'report.schema.json');
    writeFileSync(schemaPath, JSON.stringify(codexReportSchema, null, 2));
    const args = [...(c.prefixArgs ?? []), 'exec', '--json', '--color', 'never', '--sandbox', 'read-only', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', 'web_search="live"', '--output-schema', schemaPath, ...(c.model ? ['--model', c.model] : []), '-'];
    const command = c.command ?? 'codex';
    emit('cli', { type: 'process.started', command: `${command} exec --json --sandbox read-only${c.model ? ` --model ${c.model}` : ''} --output-schema report.schema.json -`, cwd });
    // Retain CLI's existing login/config, but keep publishing credentials out of its environment.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(FEISHU_|WORKBENCH_|CODEX_THREAD_ID$)/.test(key)));
    const secrets = Object.entries(process.env).filter(([key, value]) => /(?:TOKEN|API_KEY|SECRET|PASSWORD)/i.test(key) && value?.length >= 8).map(([, value]) => value);
    const redact = value => { let text = value; for (const secret of secrets) text = text.replaceAll(secret, '[REDACTED]'); return text.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]'); };
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let lastMessage = '', cliError = '', turnCompleted = false, failure = null;
    const terminate = sig => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch {} };
    let escalation;
    const stop = error => { failure ??= error; terminate('SIGTERM'); escalation ??= setTimeout(() => terminate('SIGKILL'), 2000); };
    const onAbort = () => stop(new Error('Codex 调研已取消，已保留命令行会话'));
    const timer = setTimeout(() => stop(new Error('Codex 调研超时，已保留命令行会话')), c.timeoutMs ?? 600000);
    signal.addEventListener('abort', onAbort, { once: true });
    const lines = createInterface({ input: child.stdout });
    const stderr = createInterface({ input: child.stderr });
    lines.on('line', raw => {
      if (failure) return;
      try {
        const event = JSON.parse(redact(raw));
        emit('cli', event);
        if (event.type === 'thread.started' && event.thread_id) session(event.thread_id);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') { lastMessage = event.item.text ?? ''; if (lastMessage) checkpoint(lastMessage); }
        if (event.type === 'turn.completed') turnCompleted = true;
        if (event.type === 'turn.failed' || event.type === 'error') cliError = event.error?.message ?? event.message ?? 'Codex 执行失败';
      } catch (error) {
        // Non-JSON stdout is not an assistant response. Keep a bounded diagnostic.
        if (error instanceof SyntaxError) emit('cli', { type: 'process.output', text: redact(raw).slice(0, 8000) });
        else stop(error);
      }
    });
    stderr.on('line', raw => { if (!failure) { try { emit('cli', { type: 'process.stderr', text: redact(raw).slice(0, 8000) }); } catch(e) { stop(e); } } });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(new Error('Codex 标准输入写入失败')); });
    try {
      const result = await new Promise((resolve, reject) => {
        let drainTimer;
        const finish = (code, sig) => { clearTimeout(drainTimer); resolve({ code, signal: sig }); };
        child.once('error', () => reject(new Error('无法启动 Codex CLI，请检查 CODEX_COMMAND 和 codex login 状态')));
        child.once('close', finish);
        // Some MCP descendants retain stdout after the CLI itself exits. Drain buffered
        // final JSONL, then settle on the owned process exit rather than wait forever.
        child.once('exit', (code, sig) => { drainTimer = setTimeout(() => finish(code, sig), 200); });
        // Prompt stays in stdin rather than shell interpolation or the process argument list.
        child.stdin.end(executionPrompt(task));
        if (signal.aborted) onAbort();
      });
      if (failure) throw failure;
      emit('cli', { type: 'process.completed', exitCode: result.code, signal: result.signal });
      if (result.code !== 0) throw new Error(cliError || `Codex 命令行退出（${result.code ?? result.signal}），请查看右侧执行记录`);
      if (!turnCompleted || !lastMessage) throw new Error(cliError || 'Codex 未返回完整报告，请查看命令行会话');
      return parseReport(lastMessage);
    } finally {
      clearTimeout(timer); clearTimeout(escalation); signal.removeEventListener('abort', onAbort); lines.close(); stderr.close();
      terminate('SIGTERM'); child.stdout.destroy(); child.stderr.destroy();
    }
  }
}
