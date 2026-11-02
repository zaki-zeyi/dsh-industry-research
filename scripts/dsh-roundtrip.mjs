import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { TerminalManager } from '../server/terminal.mjs';
import { AISettings } from '../server/ai-settings.mjs';
const credentialFailure = process.argv.includes('--credential-failure');
const dir = mkdtempSync(resolve(tmpdir(), 'dsh-roundtrip-')), isolated = resolve(dir, 'dsh-home');
const original = resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'profiles/tui');
mkdirSync(resolve(isolated, 'profiles/tui'), { recursive: true });
cpSync(resolve(original, 'package.json'), resolve(isolated, 'profiles/tui/package.json'));
symlinkSync(resolve(original, 'node_modules'), resolve(isolated, 'profiles/tui/node_modules'), 'junction');
const store = new Store(resolve(dir, 'test.sqlite')); let requests = 0; const calls = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (!req.url.includes('/messages')) { res.writeHead(404); res.end(); return; }
  requests++; const payload = JSON.parse(body); calls.push({ tools: payload.tools?.length ?? 0, system: JSON.stringify(payload.system).slice(0, 100), last: JSON.stringify(payload.messages?.at(-1)).slice(0, 160) });
  if (credentialFailure) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Synthetic authentication failure' } })); return; }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [event, data] of [
    ['message_start', { type: 'message_start', message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'TUI bridge roundtrip complete.' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const settings = new AISettings(dir, { dshAvailable: () => true }); settings.save({ agent: 'dsh' });
// Simulate a user's existing DSH profile; the workbench must not override these values.
writeFileSync(resolve(isolated, 'cordis.patch.yml'), JSON.stringify([
  { id: 'agent-default-model', config: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  { id: 'tui', config: { defaultModel: { provider: 'deepseek-official', model: 'deepseek-flash' }, locale: process.argv.includes('--zh') ? 'zh' : 'en', providerOnboardingVersion: 1 } },
  { id: 'llm-deepseek-account', disabled: true },
  { id: 'llm-deepseek', config: { baseURL: `http://127.0.0.1:${server.address().port}`, apiKeyEnv: 'DSH_NATIVE_ACCEPTANCE_KEY' } },
]));
const priorNativeKey = process.env.DSH_NATIVE_ACCEPTANCE_KEY; process.env.DSH_NATIVE_ACCEPTANCE_KEY = 'sk-' + 'a'.repeat(32);
const manager = new TerminalManager(store, { aiSettings: settings, workRoot: resolve(dir, 'pty'), dshHome: isolated });
try {
  const meta = manager.create({ id: 'test', ai: settings.snapshot(), prompt: 'Only verify the local test transport.', direction: '本地验收', runs: [] }, { collectReport: true }); manager.activate(meta.id);
  const started = Date.now();
  while (Date.now() - started < 25000 && !manager.get(meta.id).lastTurnCompletedAt) await new Promise(r => setTimeout(r, 100));
  const state = manager.get(meta.id);
  if (!state.lastTurnCompletedAt) { console.log(store.terminalFrames(meta.id).filter(x => x.type === 'output').map(x => x.data).join('').slice(-2200)); throw new Error('DSH native completion timeout'); }
  if (!calls.some(call => call.tools > 0)) console.log(JSON.stringify({ requests, reason: state.lastTurnReason, errorCode: state.lastTurnErrorCode }));
  assert.equal(calls.filter(call => call.tools > 0).length, 1); assert.ok(state.lastCompletionKey.startsWith('1:')); assert.equal(state.activity, 'waiting_input'); assert.ok(manager.live.has(meta.id));
  if (credentialFailure) { assert.equal(state.lastTurnReason, 'error'); assert.match(state.lastTurnErrorCode, /^[A-Z0-9_]+$/); }
  console.log(credentialFailure ? 'PASS: 真实 dsh tui 的模拟401错误已回传，终端保持连接' : 'PASS: 真正 dsh tui → 本机模拟 Messages API → 原生 turn/end；一次提交，终端保持连接，未调用外部模型');
} finally { if (priorNativeKey === undefined) delete process.env.DSH_NATIVE_ACCEPTANCE_KEY; else process.env.DSH_NATIVE_ACCEPTANCE_KEY = priorNativeKey; await manager.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); rmSync(dir, { recursive: true, force: true }); }
