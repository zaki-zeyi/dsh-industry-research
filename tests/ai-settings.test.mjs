import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AISettings, DEFAULT_BASE_URL } from '../server/ai-settings.mjs';
import { fixture, until } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { TerminalManager } from '../server/terminal.mjs';
import { CodexTerminalResearcher } from '../server/providers/codex-terminal.mjs';
import { AgentPublisher } from '../server/agent-delivery.mjs';

test('AI 配置加密持久化，GET 不回显，旧快照不受配置切换影响', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'ai-config-'));
  try {
    const settings = new AISettings(dir, { dshAvailable: () => true }); assert.equal(settings.get().baseUrl, DEFAULT_BASE_URL);
    settings.save({ agent: 'dsh', apiKey: 'private-key-first', baseUrl: DEFAULT_BASE_URL }); const saved = settings.snapshot();
    settings.save({ agent: 'codex', baseUrl: DEFAULT_BASE_URL });
    assert.equal(settings.resolve(saved.configId).apiKey, 'private-key-first');
    assert.ok(!JSON.stringify(settings.get()).includes('private-key-first')); assert.ok(!readFileSync(settings.path, 'utf8').includes('private-key-first'));
    const reloaded = new AISettings(dir, { dshAvailable: () => true }); assert.equal(reloaded.get().agent, 'codex'); assert.equal(reloaded.resolve(saved.configId).agent, 'dsh');
    assert.throws(() => settings.save({ agent: 'codex', apiKey: 'key', baseUrl: DEFAULT_BASE_URL }), /Responses/);
    settings.save({ agent: 'codex', apiKey: 'custom-key', baseUrl: 'https://example.com/v1' }); settings.save({ agent: 'codex', clearApiKey: true, baseUrl: DEFAULT_BASE_URL }); assert.equal(settings.get().apiKeyConfigured, false);
    assert.throws(() => settings.save({ agent: 'dsh', apiKey: 'key', baseUrl: 'https://user:secret@example.com' }), /不含凭据/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('AI 配置 API 校验、密钥掩码与任务绑定', async () => {
  const f = fixture(); f.service.aiSettings = new AISettings(f.dir, { dshAvailable: () => true });
  const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/ai-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: 'dsh' }) }); assert.equal(response.status, 200); const body = await response.text(); assert.ok(!body.includes('api-secret-value'));
    const task = f.service.create({ direction: 'AI配置绑定验收' }); assert.equal(task.ai.agent, 'dsh'); assert.ok(!JSON.stringify(task).includes('api-secret-value'));
    f.service.aiSettings.save({ agent: 'codex', baseUrl: DEFAULT_BASE_URL }); assert.equal(f.store.get(task.id).ai.agent, 'dsh');
    const denied = await fetch(`${base}/api/ai-settings`, { method: 'PUT', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(denied.status, 403);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); }
});
test('DSH PTY 自动提交一次任务、原生完成通知、上传复用终端且不重新调研', async () => {
  const f = fixture(), settings = new AISettings(f.dir, { dshAvailable: () => true }); settings.save({ agent: 'dsh', apiKey: 'fake-key', baseUrl: DEFAULT_BASE_URL });
  const manager = new TerminalManager(f.store, { aiSettings: settings, dshCommand: process.execPath, dshPrefixArgs: [resolve('tests/fixtures/fake-dsh.mjs')], workRoot: resolve(f.dir, 'pty'), pollMs: 20 });
  f.service.aiSettings = settings; f.service.mode = 'codex'; f.service.terminals = manager; f.service.researcher = new CodexTerminalResearcher(manager); f.service.publisher = new AgentPublisher(f.store, manager); manager.onDelivery = (id, terminalId, delivery) => f.service.recordAgentDelivery(id, terminalId, delivery);
  try {
    const task = f.service.create({ direction: 'DSH终端调研验收' }); await until(() => f.store.get(task.id).terminalId); const id = f.store.get(task.id).terminalId; manager.activate(id);
    await until(() => f.store.get(task.id).status === 'ready'); await until(() => manager.get(id).activity === 'waiting_input');
    const before = f.store.get(task.id); assert.equal(manager.get(id).agent, 'dsh'); assert.ok(manager.get(id).sessionId);
    settings.save({ agent: 'codex', baseUrl: DEFAULT_BASE_URL });
    f.service.publishToFeishu(task.id); await until(() => f.store.get(task.id).publication.status === 'published');
    const after = f.store.get(task.id); assert.equal(after.terminalId, id); assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.report, before.report);
    assert.equal(after.ai.agent, 'dsh'); assert.ok(manager.live.has(id));
  } finally { await f.service.close(); await manager.close(); await f.close(); }
});

test('DSH 凭据失败及时结束等待，修正配置后重试恢复原会话并使用新密钥', async () => {
  const f = fixture(), settings = new AISettings(f.dir, { dshAvailable: () => true });
  settings.save({ agent: 'dsh', apiKey: 'fake-rejected-key', baseUrl: DEFAULT_BASE_URL });
  const manager = new TerminalManager(f.store, { aiSettings: settings, dshCommand: process.execPath, dshPrefixArgs: [resolve('tests/fixtures/fake-dsh.mjs')], workRoot: resolve(f.dir, 'pty'), pollMs: 20 });
  f.service.aiSettings = settings; f.service.mode = 'codex'; f.service.terminals = manager; f.service.researcher = new CodexTerminalResearcher(manager); f.service.publisher = new AgentPublisher(f.store, manager);
  try {
    const task = f.service.create({ direction: '凭据失败恢复验收' });
    await until(() => f.store.get(task.id).terminalId); const first = f.store.get(task.id).terminalId; manager.activate(first);
    await until(() => f.store.get(task.id).status === 'failed');
    assert.match(f.store.get(task.id).error, /DSH 中检查模型配置/); assert.ok(manager.live.has(first));
    const sessionId = manager.get(first).sessionId; assert.ok(sessionId);
    settings.save({ agent: 'dsh', apiKey: 'fake-corrected-key', baseUrl: DEFAULT_BASE_URL });
    await until(() => !f.service.active.has(task.id)); f.service.retry(task.id, 'research');
    await until(() => f.store.get(task.id).terminalId !== first); const second = f.store.get(task.id).terminalId; manager.activate(second);
    await until(() => f.store.get(task.id).status === 'ready');
    assert.equal(manager.get(second).sessionId, sessionId); assert.equal(manager.get(second).aiConfigId, settings.snapshot().configId);
    assert.equal(f.store.get(task.id).runs.length, 2); assert.notEqual(manager.get(second).reportPath, manager.get(first).reportPath);
  } finally { await f.service.close(); await manager.close(); await f.close(); }
});
