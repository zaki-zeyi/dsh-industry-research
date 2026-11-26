import assert from 'node:assert/strict';
import { test } from 'node:test';
import { updateBusy, pauseForUpdate } from '../plugin/update-busy.mjs';
import { startRuntime } from '../server/runtime.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const service = () => ({ store: { list: () => [], saveJobs: () => [], terminalList: () => [] }, nativeSessions: {} });
test('忙碌检查覆盖持久化保存、在途请求和原生 Agent，不关闭正在执行的工作', () => {
  for (const mutate of [s => { s.store.saveJobs = () => [{}]; s.queuedSaves = { running: new Map(), submissions: new Map() }; }, s => { s.inFlightRequests = 1; },
    s => { s.store.list = () => [{ terminalId: 'current', status: 'ready' }]; s.store.terminalList = () => [{ id: 'current', activity: 'working' }]; }, s => { s.queuedSaves = { running: new Map([[1, {}]]), submissions: new Map() }; },
    s => { s.topicDigest = { active: Promise.resolve() }; }]) {
    const s = service(); mutate(s);
    assert.equal(updateBusy(s), true); assert.throws(() => pauseForUpdate(s), { code: 'WORKBENCH_BUSY' });
    assert.equal(s.updating, undefined);
  }
  const s = service(), resume = pauseForUpdate(s);
  assert.equal(s.updating, true); assert.equal(s.nativeSessions.paused, true);
  resume(); assert.equal(s.updating, false); assert.equal(s.nativeSessions.paused, false);
  s.store.terminalList = () => [{ id: 'old-turn', activity: 'working' }];
  assert.equal(updateBusy(s), false, '已被替换的历史终端不会永久阻塞更新');
});

test('候选服务健康确认前不执行恢复工作，确认后正常接收请求', async t => {
  const root = mkdtempSync(join(tmpdir(), 'industry-activation-gate-'));
  const runtime = await startRuntime({ dataDir: root, port: 0, env: { RESEARCH_MODE: 'demo' }, deferActivation: true });
  t.after(async () => { await runtime.close(); rmSync(root, { recursive: true, force: true }); });
  const health = await fetch(runtime.url + '/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ready, false);
  const blocked = await fetch(runtime.url + '/api/tasks', { headers: { Accept: 'text/html' } });
  assert.equal(blocked.status, 503);
  assert.equal(blocked.headers.get('retry-after'), '1');
  assert.equal((await blocked.json()).code, 'WORKBENCH_UPDATING', 'API 请求始终返回结构化错误');
  const document = await fetch(runtime.url + '/?view=settings', { headers: { Accept: 'text/html' } });
  assert.equal(document.status, 503);
  assert.equal(document.headers.get('cache-control'), 'no-store');
  assert.match(document.headers.get('content-type'), /text\/html/);
  assert.match(await document.text(), /工作台更新过渡页/);
  await runtime.activate();
  assert.equal((await fetch(runtime.url + '/api/tasks')).status, 200);
  assert.equal((await (await fetch(runtime.url + '/api/health')).json()).ready, true);
  assert.equal(runtime.service.activationPending, false);
});

test('任务已失败但旧 CLI 写操作仍未确认时继续阻止热切换', () => {
  const s = service();
  s.store.list = () => [{ id: 'failed-task', status: 'failed' }];
  s.store.terminalList = () => [{ id: 'old-terminal', taskId: 'failed-task', activity: 'idle' }];
  s.store.setting = () => 'cloud-write-operations:scope';
  let pending = true;
  s.cloudWrites = { locks: new Map(), completedOperations: (_task, key) => {
    assert.equal(key, 'cloud-write-operations:scope'); return pending ? [{ operationId: 'in-flight' }] : [];
  } };
  assert.equal(updateBusy(s), true);
  assert.throws(() => pauseForUpdate(s), { code: 'WORKBENCH_BUSY' });
  pending = false; assert.equal(updateBusy(s), false);
});
