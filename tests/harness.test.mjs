import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { HarnessResearcher } from '../server/providers/harness.mjs';
import { fixture, until } from './helpers.mjs';
test('AC-15 Harness stdio 协议握手、任务提交、通知解析和报告生成', async () => {
  const f=fixture(); try { f.service.researcher = new HarnessResearcher({ command:process.execPath,args:[resolve('tests/fixtures/fake-harness.mjs')],home:resolve(f.dir,'harness') }); const t=f.service.create({direction:'协议验收'}); await until(()=>f.store.get(t.id).publication.status==='published'); const done=f.store.get(t.id); assert.equal(done.report.title,'协议报告'); assert.match(done.runs[0].sessionId,/^research-/); assert.ok(f.store.events(t.id).some(e=>e.type==='assistant')); } finally { await f.close(); }
});
test('AC-16 Harness 启动失败时任务失败，记录仍可查询', async () => {
  const f=fixture(); try { f.service.researcher = new HarnessResearcher({command:'/nonexistent-harness-binary',home:resolve(f.dir,'harness')}); const t=f.service.create({direction:'启动失败验收'}); await until(()=>f.store.get(t.id).status==='failed'); assert.match(f.store.get(t.id).error,/无法启动/); assert.ok(f.store.events(t.id).length); } finally { await f.close(); }
});
