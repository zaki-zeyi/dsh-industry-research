import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AISettings } from '../server/ai-settings.mjs';
import { dshLaunch } from '../server/dsh-launch.mjs';
import { TerminalManager } from '../server/terminal.mjs';
import { CodexTerminalResearcher } from '../server/providers/codex-terminal.mjs';
import { AgentPublisher } from '../server/agent-delivery.mjs';
import { createApp } from '../server/app.mjs';
import { fixture, until } from './helpers.mjs';

test('PRD1101 新配置仅选择Agent，无需密钥；旧配置迁移不影响历史快照', async () => {
  const f = fixture();
  try {
    const old = new AISettings(f.dir, { dshAvailable: () => true });
    old.save({ agent: 'dsh', apiKey: 'legacy-private-key', baseUrl: 'https://example.com/native-old' });
    const snapshot = old.snapshot(), revision = structuredClone(old.data.revisions[snapshot.configId]);
    // Even malformed historical credentials must not block native model selection.
    old.data.revisions[snapshot.configId].secret = old.encrypt('旧的错误密钥'); old.persist(); const badRevision = structuredClone(old.data.revisions[snapshot.configId]);
    const migrated = new AISettings(f.dir, { dshAvailable: () => false });
    assert.equal(migrated.get().configuration, 'native'); assert.equal(migrated.get().apiKeyConfigured, false);
    assert.notEqual(migrated.snapshot().configId, snapshot.configId); assert.deepEqual(migrated.data.revisions[snapshot.configId], badRevision); assert.equal(migrated.data.revisions[snapshot.configId].baseUrl, revision.baseUrl);
    assert.throws(() => migrated.resolve(snapshot.configId), /纯密钥/);
    assert.throws(() => migrated.save({ agent: 'dsh' }), /尚未安装/);
    const available = new AISettings(f.dir, { dshAvailable: () => true }); available.save({ agent: 'dsh' });
    assert.equal(available.resolve(available.snapshot().configId).apiKey, undefined); assert.equal(available.resolve(available.snapshot().configId).baseUrl, undefined);
    available.save({ agent: 'codex' }); assert.equal(available.get().apiKeyConfigured, false);
    const reload = new AISettings(f.dir); assert.deepEqual(reload.snapshot(), available.snapshot());
    assert.ok(!JSON.stringify(reload.snapshot()).includes('legacy-private-key'));
  } finally { await f.close(); }
});

test('PRD1101 工作台覆盖只包含桥接与权限，不覆盖原生模型、Provider或账号登录', async () => {
  const f = fixture();
  try {
    const launch = dshLaunch({ id: 'test', cwd: f.dir, sessionPath: 'session', completionPath: 'complete' }, { agent: 'dsh', configuration: 'native', apiKey: 'must-ignore', baseUrl: 'https://must-ignore.example' });
    const patch = JSON.parse(readFileSync(launch.args[launch.args.indexOf('--patch') + 1], 'utf8'));
    assert.deepEqual(patch.filter(x => x.id).map(x => x.id), ['permission']); assert.equal(patch.at(-1).insert[0].id, 'research-terminal-bridge');
    assert.equal(patch[0].config.presets['danger-full-access'].approval, 'never');
    const text = JSON.stringify(patch); for (const value of ['deepseek-flash', 'agent-default-model', 'defaultModel', 'llm-deepseek', 'must-ignore']) assert.ok(!text.includes(value));
    assert.deepEqual(launch.args.slice(0, 2), ['--profile', 'tui']);
  } finally { await f.close(); }
});

test('PRD1101 API仅接受Agent，原生DSH完成调研且不传入工作台旧密钥', async () => {
  const f = fixture(), settings = new AISettings(f.dir, { dshAvailable: () => true }); f.service.aiSettings = settings;
  const manager = new TerminalManager(f.store, { aiSettings: settings, dshCommand: process.execPath, dshPrefixArgs: [resolve('tests/fixtures/fake-dsh.mjs')], workRoot: resolve(f.dir, 'pty'), pollMs: 20 });
  f.service.mode = 'codex'; f.service.terminals = manager; f.service.researcher = new CodexTerminalResearcher(manager); f.service.publisher = new AgentPublisher(f.store, manager);
  const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); const base = `http://127.0.0.1:${server.address().port}`;
  const prior = process.env.RESEARCH_DSH_API_KEY; process.env.RESEARCH_DSH_API_KEY = 'stale-workbench-key';
  try {
    const put = body => fetch(`${base}/api/ai-settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await put({ agent: 'dsh', apiKey: 'unused-key' })).status, 400);
    assert.equal((await put({ agent: 'dsh' })).status, 200);
    const task = f.service.create({ direction: '原生默认模型验收' }); await until(() => f.store.get(task.id).terminalId); const id = f.store.get(task.id).terminalId; manager.activate(id);
    await until(() => f.store.get(task.id).status === 'ready'); await until(() => manager.get(id).activity === 'waiting_input');
    const env = JSON.parse(readFileSync(resolve(manager.get(id).cwd, 'dsh-env.json'), 'utf8')); assert.equal(env.hasWorkbenchApiKey, false);
    assert.ok(manager.live.has(id)); assert.equal(f.store.get(task.id).ai.configuration, 'native');
  } finally { if (prior === undefined) delete process.env.RESEARCH_DSH_API_KEY; else process.env.RESEARCH_DSH_API_KEY = prior; server.closeAllConnections(); await new Promise(r => server.close(r)); await f.service.close(); await manager.close(); await f.close(); }
});
