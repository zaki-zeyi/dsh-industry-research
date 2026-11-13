import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { CodexResearcher } from '../server/providers/codex.mjs';
import { LocalPublisher } from '../server/providers/publisher.mjs';
import { conversationEntries } from '../src/conversation.mjs';
import { fixture, until } from './helpers.mjs';

function setup(config = {}) { const f = fixture(); f.service.mode = 'codex'; f.service.researcher = new CodexResearcher({ command: process.execPath, prefixArgs: [resolve('tests/fixtures/fake-codex.mjs')], workRoot: resolve(f.dir, 'cli'), ...config }); f.service.publisher = new LocalPublisher(f.store); return f; }
test('AC-CLI-01 Prompt 进入真实子进程 stdin；CLI 事件实时持久化；报告本地保存', async () => {
  const f = setup(); try {
    const t = f.service.create({ direction: '命令行集成验收' });
    await until(() => f.store.events(t.id).some(e => e.data?.item?.id === 'cmd-1'));
    assert.equal(f.store.get(t.id).status, 'running');
    await until(() => f.store.get(t.id).publication.status === 'published');
    const task = f.store.get(t.id); assert.equal(task.mode, 'codex'); assert.equal(task.runs[0].sessionId, 'codex-test-thread'); assert.equal(task.publication.target, 'local'); assert.match(task.publication.url, /\/local\/documents\//); assert.equal(task.report.title, 'Codex CLI 验收报告');
    const entries = conversationEntries(f.store.events(t.id)); const commands = entries.filter(e => e.item?.id === 'cmd-1'); assert.equal(commands.length, 1); assert.equal(commands[0].item.aggregated_output, 'CLI_STREAM_OK\n'); assert.equal(commands[0].item.exit_code, 0);
    assert.ok(entries.some(e => e.item?.text?.includes('已收到调研 Prompt')));
  } finally { await f.close(); }
});
test('AC-CLI-02 Codex 非零退出保留对话、命令输出和错误', async () => {
  const f = setup(); try { const t = f.service.create({ direction: 'CLI_FAIL 测试' }); await until(() => f.store.get(t.id).status === 'failed'); assert.match(f.store.get(t.id).error, /异常退出/); assert.ok(f.store.get(t.id).draft); assert.ok(f.store.events(t.id).some(e => e.data?.item?.aggregated_output?.includes('CLI_STREAM_OK'))); } finally { await f.close(); }
});
test('AC-CLI-03 取消 Codex 进程并保留已完成对话', async () => {
  const f = setup(); try { const t = f.service.create({ direction: 'CLI_CANCEL 测试' }); await until(() => f.store.events(t.id).some(e => e.data?.item?.id === 'cmd-1')); f.service.cancel(t.id); await until(() => !f.service.active.size); assert.equal(f.store.get(t.id).status, 'interrupted'); assert.ok(f.store.events(t.id).some(e => e.data?.item?.id === 'intro')); } finally { await f.close(); }
});
test('AC-CLI-04 CLI 不存在与运行超时均返回可重试错误', async () => {
  const missing = setup({ command: '/nonexistent-codex-command' }); try { const t = missing.service.create({ direction: '启动失败验收' }); await until(() => missing.store.get(t.id).status === 'failed'); assert.match(missing.store.get(t.id).error, /无法启动 Codex/); } finally { await missing.close(); }
  const slow = setup({ timeoutMs: 150 }); try { const t = slow.service.create({ direction: 'CLI_CANCEL 超时' }); await until(() => slow.store.get(t.id).status === 'failed'); assert.match(slow.store.get(t.id).error, /超时/); } finally { await slow.close(); }
});
test('AC-CLI-05 工具子进程占用输出管道时，CLI 主进程退出后仍正常完成', async () => {
  const f = setup(); try { const t = f.service.create({ direction: 'CLI_PIPE_HELD 测试' }); await until(() => f.store.get(t.id).publication.status === 'published', 3000); assert.equal(f.store.get(t.id).status, 'ready'); } finally { await f.close(); }
});
