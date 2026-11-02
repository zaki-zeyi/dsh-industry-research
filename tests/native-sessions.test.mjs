import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NativeSessions, NativeResearcher } from '../server/native-sessions.mjs';
import { TerminalManager } from '../server/terminal.mjs';
import { AgentPublisher } from '../server/agent-delivery.mjs';
import { createApp } from '../server/app.mjs';
import { fixture, until } from './helpers.mjs';

import { mockHost, report } from './fixtures/fake-native-host.mjs';
async function setup(options) {
  const f = fixture(), host = mockHost(options), terminals = new TerminalManager(f.store), sessions = new NativeSessions(f.store, host, { workRoot: resolve(f.dir, 'sessions'), pollMs: 15 });
  f.service.mode = 'native'; f.service.researcher = new NativeResearcher(sessions); f.service.publisher = new AgentPublisher(f.store, terminals); f.service.terminals = terminals; f.service.nativeSessions = sessions;
  sessions.onDelivery = (id, binding, receipt) => f.service.recordAgentDelivery(id, binding, receipt);
  return { ...f, host, sessions, terminals, async close() { await f.service.close(); sessions.close(); await terminals.close(); await f.close(); } };
}

test('PRD1488 宿主原生会话生成报告，无PTY或模型覆盖，完成后继续追问', async () => {
  const f = await setup();
  try {
    const task = f.service.create({ direction: '原生会话调研验收' }); await until(() => f.store.get(task.id).status === 'ready'); await until(() => !f.service.active.size);
    const t = f.store.get(task.id); assert.equal(t.nativeSession, true); assert.equal(t.terminalMode, false); assert.equal(t.ai.agent, 'dsh-native'); assert.equal(t.report.title, report.title); assert.equal(f.terminals.live.size, 0);
    assert.equal(t.publication.status, 'awaiting_authorization'); assert.equal(f.host.created, 1); assert.equal(f.host.permissions[0].name, 'danger-full-access');
    assert.ok(!Object.hasOwn(f.host.calls[0], 'model')); const id = t.nativeSessionId;
    await f.sessions.send(t.terminalId, '请解释报告的方法'); assert.equal(f.host.calls.at(-1).sessionId, id); assert.equal(f.host.created, 1); assert.equal(f.sessions.get(t.terminalId).activity, 'waiting_input');
  } finally { await f.close(); }
});
test('PRD1488 上传、二维码授权及授权后保存复用同一宿主会话和报告', async () => {
  const f = await setup(); const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const task = f.service.create({ direction: '原生飞书交付验收' }); await until(() => f.store.get(task.id).status === 'ready'); await until(() => !f.service.active.size);
    const before = f.store.get(task.id); f.service.publishToFeishu(task.id); await until(() => f.store.get(task.id).publication.status === 'awaiting_authorization');
    assert.equal((await fetch(`${base}/api/tasks/${task.id}/agent-qr`)).status, 200);
    await f.sessions.send(before.terminalId, '已授权，请继续保存现有报告'); await until(() => f.store.get(task.id).publication.status === 'published');
    const after = f.store.get(task.id); assert.deepEqual(after.report, before.report); assert.deepEqual(after.runs, before.runs); assert.equal(after.nativeSessionId, before.nativeSessionId); assert.equal(f.host.created, 1);
    assert.equal((await fetch(`${base}/api/tasks/${task.id}/terminal`, { method: 'POST' })).status, 409);
    const binding = await (await fetch(`${base}/api/tasks/${task.id}/session`)).json(); assert.equal(binding.sessionId, before.nativeSessionId);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); }
});
test('PRD1488 原生调用失败及时结束等待，重试复用宿主会话与新报告文件', async () => {
  const f = await setup({ failFirst: true });
  try {
    const task = f.service.create({ direction: '原生会话错误恢复' }); await until(() => f.store.get(task.id).status === 'failed'); await until(() => !f.service.active.size); const before = f.store.get(task.id), path = f.sessions.get(before.terminalId).reportPath;
    assert.ok(!before.error.includes('secret')); f.service.retry(task.id, 'research'); await until(() => f.store.get(task.id).status === 'ready');
    const after = f.store.get(task.id); assert.equal(after.nativeSessionId, before.nativeSessionId); assert.notEqual(f.sessions.get(after.terminalId).reportPath, path); assert.equal(after.runs.length, 2); assert.equal(f.host.created, 1);
  } finally { await f.close(); }
});
test('PRD1488 会话结束但无报告时显示失败，不无限等待或重复调研', async () => {
  const f = await setup({ noReport: true });
  try { const task = f.service.create({ direction: '原生会话无报告' }); await until(() => f.store.get(task.id).status === 'failed'); assert.match(f.store.get(task.id).error, /未生成完整报告/); assert.equal(f.host.calls.filter(x => x.kind === 'prompt').length, 1); }
  finally { await f.close(); }
});

test('PRD1488 历史终端任务重试继续走原适配器，原生模式不接管旧会话', async () => {
  const f = await setup(); let called = 0;
  try {
    const legacy = { async run(task) { called++; assert.equal(task.nativeSession, false); return report; } };
    const researcher = new NativeResearcher(f.sessions, { legacy });
    const value = await researcher.run({ nativeSession: false }, { signal: new AbortController().signal, terminal() {}, session() {}, checkpoint() {} });
    assert.deepEqual(value, report); assert.equal(called, 1); assert.equal(f.host.created, 0);
  } finally { await f.close(); }
});

test('PRD1488 刷新或重新加载插件不重复提交已完成报告，历史会话ID保留', async () => {
  const f = await setup();
  try {
    const task = f.service.create({ direction: '原生历史恢复验收' }); await until(() => f.store.get(task.id).status === 'ready'); await until(() => !f.service.active.size);
    const before = f.store.get(task.id), promptCount = f.host.calls.filter(x => x.kind === 'prompt').length;
    f.sessions.close(); const reloaded = new NativeSessions(f.store, f.host, { workRoot: resolve(f.dir, 'sessions') });
    try { assert.equal(reloaded.get(before.terminalId).sessionId, before.nativeSessionId); assert.equal(f.host.calls.filter(x => x.kind === 'prompt').length, promptCount); }
    finally { reloaded.close(); }
  } finally { await f.close(); }
});

test('PRD1488 停止调研只取消当前轮次，保留宿主会话供后续输入', async () => {
  const f = await setup();
  try {
    f.host.sessionController.prompt = async request => { f.host.calls.push({ kind: 'prompt', ...request }); f.host.emit(request.sessionId, 'turn/start'); return { accepted: true }; };
    const task = f.service.create({ direction: '原生会话停止验收' }); await until(() => f.store.get(task.id).nativeSessionId); const before = f.store.get(task.id);
    f.service.cancel(task.id); await until(() => f.store.get(task.id).status === 'interrupted');
    assert.equal(f.host.calls.filter(x => x.kind === 'cancel').length, 1); assert.equal(f.store.get(task.id).nativeSessionId, before.nativeSessionId);
    await f.sessions.send(before.terminalId, '请继续回答新的问题'); assert.equal(f.host.created, 1); assert.equal(f.host.calls.at(-1).sessionId, before.nativeSessionId);
  } finally { await f.close(); }
});

test('PRD1488 上传轮次错误且没有回执时及时失败，可原会话重试且不重新调研', async () => {
  const f = await setup();
  try {
    const normal = f.host.sessionController.prompt;
    f.host.sessionController.prompt = async request => { if (!request.content[0].text.includes('用户上传要求')) return normal(request); f.host.emit(request.sessionId, 'turn/start'); f.host.emit(request.sessionId, 'turn/end', { kind: 'error', error: { code: 'INVALID_CREDENTIAL' } }); return { accepted: true }; };
    const task = f.service.create({ direction: '原生上传错误回归' }); await until(() => !f.service.active.size && f.store.get(task.id).report);
    const before = f.store.get(task.id); await until(() => f.store.get(task.id).publication.status === 'failed');
    f.host.sessionController.prompt = normal; f.service.publishToFeishu(task.id); await until(() => f.store.get(task.id).publication.status === 'awaiting_authorization');
    const after = f.store.get(task.id); assert.equal(after.nativeSessionId, before.nativeSessionId); assert.deepEqual(after.runs, before.runs); assert.deepEqual(after.report, before.report);
  } finally { await f.close(); }
});

test('PRD1572 宿主默认其他模式时，新调研明确采用标准模式并保留完整权限', async () => {
  const f = await setup({ defaultPreset: 'cordis' });
  try {
    const task = f.service.create({ direction: '标准模式默认值验收' }); await until(() => f.store.get(task.id).status === 'ready');
    const t = f.store.get(task.id); assert.equal(f.host.calls.find(x => x.kind === 'create').agentPreset, 'standard');
    assert.equal(f.host.modes.get(t.nativeSessionId), 'standard'); assert.equal(f.sessions.get(t.terminalId).agentPreset, 'standard');
    assert.equal(f.host.permissions[0].name, 'danger-full-access'); assert.equal(f.host.defaultPreset, 'cordis');
  } finally { await f.close(); }
});

test('PRD1572 历史会话重试与追问不重置用户选择的模式', async () => {
  const f = await setup({ failFirst: true });
  try {
    const task = f.service.create({ direction: '历史模式保留验收' }); await until(() => f.store.get(task.id).status === 'failed'); await until(() => !f.service.active.size);
    const before = f.store.get(task.id); f.host.modes.set(before.nativeSessionId, 'cordis');
    f.service.retry(task.id, 'research'); await until(() => f.store.get(task.id).status === 'ready'); await until(() => !f.service.active.size);
    const after = f.store.get(task.id); await f.sessions.send(after.terminalId, '继续解释，不切换模式');
    assert.equal(after.nativeSessionId, before.nativeSessionId); assert.equal(f.host.modes.get(after.nativeSessionId), 'cordis');
    assert.equal(f.host.created, 1); assert.equal(f.host.permissions.length, 1);
  } finally { await f.close(); }
});

test('PRD1742 新任务自动上传一次、固定创建时目录，授权后复用同一报告和会话', async () => {
  const f = await setup();
  try {
    f.service.setFeishuSettings({ rootName: '公司调研' });
    const task = f.service.create({ direction: '自动上传与目录验收' });
    f.service.setFeishuSettings({ rootName: '下一批调研' });
    await until(() => !f.service.active.size && f.store.get(task.id).publication.status === 'awaiting_authorization');
    const before = f.store.get(task.id), meta = f.sessions.get(before.terminalId);
    assert.equal(before.autoUpload, true); assert.equal(before.feishuRoot.rootName, '公司调研'); assert.match(before.prompt, /公司调研/);
    const uploadCalls = () => f.host.calls.filter(x => x.kind === 'prompt' && x.content[0].text.includes('用户上传要求'));
    assert.equal(uploadCalls().length, 1);
    const uploadPath = /请读取 (.+)，按照/.exec(uploadCalls()[0].content[0].text)[1];
    const instruction = readFileSync(uploadPath, 'utf8');
    assert.match(instruction, /公司调研/); assert.ok(!instruction.includes('下一批调研')); assert.match(instruction, /--parent-token/); assert.match(instruction, /不存在才新建/); assert.match(instruction, /分页/); assert.match(instruction, /多个同名目录/); assert.match(instruction, /不重新调研/);
    f.service.publishToFeishu(task.id); f.service.publishToFeishu(task.id); assert.equal(uploadCalls().length, 1);
    await f.sessions.send(meta.id, '已授权，请继续保存现有报告');
    await until(() => f.store.get(task.id).publication.status === 'published');
    const after = f.store.get(task.id); assert.equal(after.nativeSessionId, before.nativeSessionId); assert.deepEqual(after.report, before.report); assert.equal(after.runs.length, 1);
    f.service.recover(); assert.equal(uploadCalls().length, 1);
  } finally { await f.close(); }
});

test('PRD1742 写完报告但轮次仍执行时不提前上传，结束后自动转交', async () => {
  const f = await setup();
  try {
    const normal = f.host.sessionController.prompt; let first;
    f.host.sessionController.prompt = async request => {
      if (first) return normal(request);
      first = request;
      f.host.emit(request.sessionId, 'turn/start');
      const path = /请读取 (.+)，按照/.exec(request.content[0].text)[1];
      writeFileSync(/完整报告 JSON 保存到 (.+)。本轮/.exec(readFileSync(path, 'utf8'))[1], JSON.stringify(report));
      return { accepted: true };
    };
    const task = f.service.create({ direction: '等待报告轮次结束验收' });
    await until(() => f.store.get(task.id).draft);
    assert.equal(f.store.get(task.id).report, null); assert.equal(f.host.calls.filter(x => x.kind === 'prompt').length, 0);
    f.host.emit(first.sessionId, 'turn/end', { kind: 'completed' });
    await until(() => f.store.get(task.id).publication.status === 'awaiting_authorization');
    assert.equal(f.host.calls.filter(x => x.kind === 'prompt').length, 1);
  } finally { await f.close(); }
});

test('PRD1742 报告归档后重启可补交自动上传，历史手动任务不被自动上传', async () => {
  const f = await setup();
  try {
    const task = f.service.create({ direction: '自动上传重启恢复验收' });
    await until(() => !f.service.active.size && f.store.get(task.id).publication.status === 'awaiting_authorization');
    const before = f.store.get(task.id), count = f.host.calls.length;
    before.publication = { target: 'feishu', owner: 'agent', status: 'not_requested' }; f.store.save(before);
    f.service.recover(); await until(() => !f.service.active.size && f.store.get(task.id).publication.status === 'awaiting_authorization');
    assert.equal(f.store.get(task.id).runs.length, 1); assert.ok(f.host.calls.length > count);
    const historical = f.store.get(task.id); delete historical.autoUpload; historical.publication = { target: 'feishu', owner: 'agent', status: 'not_requested' }; f.store.save(historical);
    const previous = f.host.calls.length; f.service.recover(); await new Promise(r => setTimeout(r, 30)); assert.equal(f.host.calls.length, previous);
  } finally { await f.close(); }
});
