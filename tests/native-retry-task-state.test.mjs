import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRuntime } from '../server/runtime.mjs';
import { briefingTask } from '../server/briefings.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { until } from './helpers.mjs';

async function failedBriefing() {
  const dir = mkdtempSync(resolve(tmpdir(), 'native-retry-state-')), host = mockHost();
  const runtime = await startRuntime({ port: 0, dataDir: dir, env: { RESEARCH_MODE: 'native' }, host,
    binding: { requireBound: async () => ({ openId: 'ou_fixture', appId: 'cli_fixture' }),
      applicationSnapshot: () => ({ mode: 'default' }), close() {} } });
  host.sessionController.prompt = async request => {
    host.emit(request.sessionId, 'turn/start');
    host.emit(request.sessionId, 'turn/end', { kind: 'error', error: { code: 'MODEL_ERROR' } });
  };
  const task = await runtime.service.createAuthorized(briefingTask({ kind: 'daily', companies: ['后摩智能'], dimensions: ['融资'], sources: ['公司官网'] }));
  await until(() => runtime.service.require(task.id).status === 'failed' && !runtime.service.active.has(task.id));
  const meta = runtime.service.nativeSessions.get(runtime.service.require(task.id).terminalId);
  // Production directory-backed runtimes have no lock owner after failure. This
  // reconciles a finished receipt; it must not require a new remote-write lock.
  runtime.service.directories = {};
  const receipt = { requestId: meta.deliveryRequestId, status: 'published', folderToken: 'Root123', reportFolderToken: 'Daily123',
    url: 'https://example.feishu.cn/docx/NativeRetry123', noUpdates: true, partial: false };
  const write = value => writeFileSync(meta.deliveryPath, JSON.stringify(value));
  return { ...runtime, host, task, meta, receipt, write,
    async close() { await runtime.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('日报失败后原生 DSH 重试完成，同步任务/执行记录/列表详情并发出 state，回执重复不重复完成', async () => {
  const f = await failedBriefing();
  try {
    let notices = 0; f.service.notifications = { send: async () => { notices++; }, close: async () => {} };
    const events = []; f.service.bus.on(f.task.id, event => events.push(event));
    f.service.cloudWrites.locks.set('old-task-lock', { owner: f.task.id, waiters: [] });
    f.service.cloudWrites.locks.set('unrelated-lock', { owner: 'other-task', waiters: [] });
    f.host.emit(f.meta.sessionId, 'turn/start');
    const started = f.service.nativeSessions.get(f.meta.id);
    assert.equal(started.lastTurnCompletedAt, null);
    assert.equal(started.lastTurnReason, null);
    f.write(f.receipt); f.service.nativeSessions.observeDeliveries();
    assert.equal(f.service.require(f.task.id).status, 'failed', '写好回执但原生轮次未结束不能提前完成');
    f.host.emit(f.meta.sessionId, 'turn/end', { kind: 'completed' });
    const done = f.service.require(f.task.id);
    assert.equal(done.status, 'ready'); assert.equal(done.stage, 'done'); assert.equal(done.error, null);
    assert.equal(done.publication.status, 'published'); assert.equal(done.publication.url, f.receipt.url);
    assert.equal(done.runs.length, 2); assert.equal(done.runs[0].status, 'failed'); assert.equal(done.runs[1].status, 'completed');
    assert.equal(done.runs[1].sessionId, f.meta.sessionId); assert.equal(f.host.created, 1);
    assert.equal(f.service.cloudWrites.locks.has('old-task-lock'), false, '完成后仅释放该任务保留的旧锁');
    assert.equal(f.service.cloudWrites.locks.get('unrelated-lock').owner, 'other-task', '不得释放其它任务的保存锁');
    assert.ok(events.some(event => event.type === 'state' && event.data.status === 'ready' && event.data.stage === 'done'));
    const detail = await (await fetch(f.url + '/api/tasks/' + f.task.id)).json();
    assert.equal(detail.task.status, 'ready'); assert.equal(detail.task.stage, 'done');
    const list = await (await fetch(f.url + '/api/briefings?kind=daily')).json();
    assert.equal(list.items.find(item => item.id === f.task.id).status, 'ready');
    f.service.nativeSessions.observeDeliveries(f.meta.id);
    assert.equal(f.service.require(f.task.id).runs.length, 2); assert.equal(notices, 1);
  } finally { await f.close(); }
});

test('原生重试完成事件先于回执落盘，后续轮询仍同步完成', async () => {
  const f = await failedBriefing();
  try {
    f.host.emit(f.meta.sessionId, 'turn/start');
    f.host.emit(f.meta.sessionId, 'turn/end', { kind: 'completed' });
    assert.equal(f.service.require(f.task.id).status, 'failed');
    f.write(f.receipt); f.service.nativeSessions.observeDeliveries();
    assert.equal(f.service.require(f.task.id).status, 'ready');
    assert.equal(f.service.require(f.task.id).stage, 'done');
  } finally { await f.close(); }
});

test('工作台重试仍走新requestId，旧绑定回执不能完成新任务轮次', async () => {
  const f = await failedBriefing();
  try {
    delete f.service.directories;
    f.host.sessionController.prompt = async request => {
      f.host.emit(request.sessionId, 'turn/start');
      const current = f.service.require(f.task.id), meta = f.service.nativeSessions.get(current.terminalId);
      assert.notEqual(meta.id, f.meta.id); assert.notEqual(meta.deliveryRequestId, f.meta.deliveryRequestId);
      assert.equal(meta.sessionId, f.meta.sessionId);
      f.service.recordAgentDelivery(f.task.id, f.meta.id, f.receipt);
      assert.equal(f.service.require(f.task.id).status, 'running');
      writeFileSync(meta.deliveryPath, JSON.stringify({ ...f.receipt, requestId: meta.deliveryRequestId }));
      f.host.emit(request.sessionId, 'turn/end', { kind: 'completed' });
    };
    f.service.retry(f.task.id, 'research');
    await until(() => f.service.require(f.task.id).status === 'ready');
    const done = f.service.require(f.task.id);
    assert.equal(done.runs.length, 2); assert.equal(done.runs[0].status, 'failed');
    assert.equal(done.runs[1].status, 'completed'); assert.equal(f.host.created, 1);
    assert.equal(done.publication.requestId, f.service.nativeSessions.get(done.terminalId).deliveryRequestId);
  } finally { await f.close(); }
});

for (const boundary of ['no-new-turn', 'old-receipt', 'wrong-request', 'wrong-folder', 'missing-folder', 'invalid-briefing', 'cancelled', 'error-turn', 'overdue', 'missing-run', 'run-terminal-mismatch', 'invalid-start']) {
  test(`原生重试状态同步不误恢复：${boundary}`, async () => {
    const f = await failedBriefing();
    try {
      if (boundary === 'old-receipt') f.write(f.receipt);
      if (boundary !== 'no-new-turn') f.host.emit(f.meta.sessionId, 'turn/start');
      const receipt = { ...f.receipt };
      if (boundary === 'wrong-request') receipt.requestId = '11111111-1111-4111-8111-111111111111';
      if (boundary === 'wrong-folder') {
        const task = f.service.require(f.task.id); task.feishuRoot.folderToken = 'ExpectedRoot'; f.service.store.save(task);
      }
      if (boundary === 'missing-folder') delete receipt.folderToken;
      if (boundary === 'invalid-briefing') receipt.partial = true;
      if (boundary === 'cancelled') { const task = f.service.require(f.task.id); task.status = 'interrupted'; f.service.store.save(task); }
      if (boundary === 'overdue') {
        const task = f.service.require(f.task.id), meta = f.service.nativeSessions.get(f.meta.id);
        task.runs.at(-1).endedAt = new Date(Date.now() - 32 * 60000).toISOString(); f.service.store.save(task);
        meta.lastTurnStartedAt = new Date(Date.now() - 31 * 60000).toISOString(); f.service.store.saveTerminal(meta);
      }
      if (boundary === 'missing-run') { const task = f.service.require(f.task.id); task.runs = []; f.service.store.save(task); }
      if (boundary === 'run-terminal-mismatch') { const task = f.service.require(f.task.id); task.runs.at(-1).terminalId = 'old-binding'; f.service.store.save(task); }
      if (boundary === 'invalid-start') { const meta = f.service.nativeSessions.get(f.meta.id); meta.lastTurnStartedAt = 'invalid'; f.service.store.saveTerminal(meta); }
      f.write(receipt);
      f.host.emit(f.meta.sessionId, 'turn/end', { kind: boundary === 'error-turn' ? 'error' : 'completed' });
      f.service.nativeSessions.observeDeliveries();
      assert.equal(f.service.require(f.task.id).status, boundary === 'cancelled' ? 'interrupted' : 'failed');
      assert.equal(f.service.require(f.task.id).runs.length, boundary === 'missing-run' ? 0 : 1);
    } finally { await f.close(); }
  });
}
