import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { executionPrompt, parseReport } from '../report.mjs';
import { newId } from '../store.mjs';

// Public Harness SDK stdio protocol. No shell interpolation or private runtime imports.
export class HarnessResearcher {
  constructor(config = {}) { this.config = config; }
  async run(task, { emit, session, checkpoint, signal }) {
    const c = this.config;
    const home = resolve(c.home ?? './data/harness');
    const cwd = resolve(home, 'workspaces', task.id); mkdirSync(cwd, { recursive: true });
    const child = spawn(c.command ?? 'dsh', c.args ?? ['--profile', 'sdk'], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      // Do not expose Feishu publishing credentials to the agent subprocess.
      env: Object.fromEntries(Object.entries({ ...process.env, DSH_HOME: home }).filter(([k]) => !/^(FEISHU_|WORKBENCH_)/.test(k))),
    });
    let next = 0, final = '', ended = false; const pending = new Map();
    const sessionId = `research-${newId()}`; session(sessionId);
    const rejectAll = e => { ended = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
    child.on('error', () => rejectAll(new Error('无法启动 Harness，请检查 HARNESS_COMMAND 和已安装的 SDK profile')));
    child.on('exit', code => rejectAll(new Error(`Harness 进程退出（${code}）`)));
    child.stderr.on('data', () => {}); // Credentials and runtime diagnostics must not leak into UI.
    child.stdin.on('error', () => rejectAll(new Error('Harness 输入流关闭')));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.id != null) { const p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(`Harness RPC ${m.error.code}: 请求失败`)) : p.resolve(m.result); return; }
      if (m.method !== 'session.event' || m.params?.sessionId !== sessionId) return;
      const e = m.params.event;
      emit('runtime', e); // Preserve the original durable journal alongside the readable transcript.
      if (e?.type === 'assistant/message') {
        const body = e.data?.message ?? e.data;
        const content = body?.content ?? body?.contentBlocks;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join('') : '';
        if (text) { final = text; checkpoint(text); emit('assistant', text); }
      } else if (e?.type === 'tool/call') emit('tool', `工具调用 · ${e.data?.name ?? e.data?.toolName ?? '执行中'}`);
    });
    const rpc = (method, params, timeout = 15000) => new Promise((resolve, reject) => {
      if (ended) return reject(new Error('Harness 连接已经关闭'));
      const id = ++next;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Harness ${method} 超时`)); }, timeout);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    const abort = () => { rejectAll(new Error('调研已取消')); child.kill('SIGTERM'); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      const init = await rpc('initialize', { cwd, provider: c.provider ?? 'deepseek-official', model: c.model ?? 'deepseek-v4-flash' });
      if (init?.serverInfo?.name !== 'deepseek-harness-sdk-runtime') throw new Error('连接的进程不是受支持的 Harness SDK runtime');
      await rpc('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: executionPrompt(task) }] });
      await rpc('session/wait', { sessionId }, c.timeoutMs ?? 600000);
      if (!final) throw new Error('Harness 未返回报告；请检查运行时版本、搜索工具和模型配置');
      return parseReport(final);
    } finally {
      signal.removeEventListener('abort', abort);
      try { if (!ended) await rpc('shutdown', undefined, 1000); } catch {}
      lines.close(); child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise(done => { const t = setTimeout(() => { child.kill('SIGKILL'); done(); }, 2000); child.once('exit', () => { clearTimeout(t); done(); }); });
      }
      rejectAll(new Error('Harness 已关闭'));
    }
  }
}
