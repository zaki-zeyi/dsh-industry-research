import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { Store } from '../server/store.mjs';
import { TerminalManager } from '../server/terminal.mjs';
import { AISettings } from '../server/ai-settings.mjs';
const dir = mkdtempSync(resolve(tmpdir(), 'research-dsh-smoke-'));
const store = new Store(resolve(dir, 'test.sqlite'));
const settings = new AISettings(dir, { dshAvailable: () => true }); settings.save({ agent: 'dsh' });
const manager = new TerminalManager(store, { workRoot: resolve(dir, 'terminal'), aiSettings: settings });
const task = { id: 'smoke', ai: settings.snapshot(), prompt: 'No request should be sent', runs: [] };
try {
  const meta = manager.create(task); manager.activate(meta.id);
  const start = Date.now();
  while (Date.now() - start < 20000) {
    const state = manager.get(meta.id); if (state.sessionId) { console.log('PASS: dsh tui 原生启动、工作台桥接会话ID、完整访问；未投递模型请求'); break; }
    if (['failed', 'exited'].includes(state.status)) throw new Error(state.error ?? 'DSH prematurely exited');
    await new Promise(r => setTimeout(r, 100));
  }
  if (!manager.get(meta.id).sessionId) { const frames = store.terminalFrames(meta.id).filter(x => x.type === 'output').map(x => x.data).join(''); console.log(frames.slice(-2500)); throw new Error('DSH bridge startup timeout'); }
} finally { await manager.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
