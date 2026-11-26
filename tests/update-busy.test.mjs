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
    s => { s.store.list = () => [{ terminalId: 'current', status: 'ready' }]; s.store.terminalList = () => [{ id: 'current', activity: 'working' }]; }, s => { s.queuedSaves = { running: new Map([[1, {}]]), submissions: new Map() }; }]) {
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
  assert.equal((await fetch(runtime.url + '/api/health')).status, 200);
  assert.equal((await fetch(runtime.url + '/api/tasks')).status, 503);
  await runtime.activate();
  assert.equal((await fetch(runtime.url + '/api/tasks')).status, 200);
  assert.equal(runtime.service.activationPending, false);
});
