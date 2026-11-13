import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';
import { AgentPublisher, agentDeliverySchema } from '../server/agent-delivery.mjs';
import { createApp } from '../server/app.mjs';
import { promptFor, executionPrompt } from '../server/report.mjs';

test('AC-AGENT-01 新版默认 Prompt 包含飞书根目录，执行分离调研与保存', () => {
  const prompt = promptFor('芯片研究', 'web');
  assert.match(prompt, /【全网】.*【芯片研究】/); assert.equal(prompt, '帮我在【全网】进行【芯片研究】的调研，整理成带数据来源的报告。报告上传到飞书云盘根目录【行研工作台】。');
  const execution = executionPrompt({ prompt }); assert.match(execution, /自动发送独立保存指令/); assert.ok(!execution.includes('平台会在报告通过校验后保存飞书'));
});

test('AC-AGENT-02 报告生成后未请求上传，没有终端时按钮不能代写飞书', async () => {
  const f = fixture(); f.service.publisher = new AgentPublisher(f.store);
  const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  try {
    const t = f.service.create({ direction: 'Agent 飞书交付验收' }); await until(() => !f.service.active.size && f.store.get(t.id).report);
    const before = f.store.get(t.id); assert.equal(before.publication.owner, 'agent'); assert.equal(before.publication.status, 'not_requested'); assert.ok(f.store.document(before.localPublication.documentId));
    const base = `http://127.0.0.1:${server.address().port}`;
    const r = await fetch(`${base}/api/tasks/${t.id}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 503); assert.match((await r.json()).error, /终端 Agent/); assert.deepEqual(f.store.get(t.id), before);
    assert.throws(() => f.service.retry(t.id, 'publish'), /终端 Agent/);
    const config = await (await fetch(`${base}/api/config`)).json(); assert.equal(config.publicationOwner, 'agent'); assert.ok(!('feishuConfigured' in config));
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); }
});

test('AC-AGENT-03 回执校验拒绝假成功和恶意链接，过期终端不能覆盖现有记录', async () => {
  for (const url of ['https://evil.example/docx/a', 'javascript:alert(1)', 'https://a.feishu.cn.evil.example/docx/a', 'https://user:secret@a.feishu.cn/docx/a', 'https://a.feishu.cn@evil.example/docx/a']) {
    assert.equal(agentDeliverySchema.safeParse({ status: 'published', url }).success, false);
  }
  assert.equal(agentDeliverySchema.safeParse({ status: 'published' }).success, false);
  assert.equal(agentDeliverySchema.safeParse({ status: 'awaiting_authorization', authorizationUrl: 'https://evil.example/auth' }).success, false);
  const f = fixture(); f.service.publisher = new AgentPublisher(f.store);
  try {
    const t = f.service.create({ direction: 'Agent 回执归属验收' }); await until(() => !f.service.active.size && f.store.get(t.id).report);
    const current = f.store.get(t.id); current.terminalId = 'current-terminal'; current.publication = { target: 'feishu', owner: 'agent', status: 'publishing', requestId: '12345678-1234-4234-8234-123456789abc' }; f.store.save(current);
    f.service.recordAgentDelivery(t.id, 'old-terminal', { status: 'published', url: 'https://a.feishu.cn/docx/a' }); assert.equal(f.store.get(t.id).publication.status, 'publishing');
    f.service.recordAgentDelivery(t.id, 'current-terminal', { requestId: '12345678-1234-4234-8234-123456789abc', status: 'failed', error: 'Agent 未获得授权，请在终端继续' });
    const done = f.store.get(t.id); assert.equal(done.publication.status, 'failed'); assert.deepEqual(done.report, current.report); assert.equal(done.runs.length, 1);
  } finally { await f.close(); }
});


test('授权到期时间支持 UTC 和时区偏移，避免丢弃已生成二维码的有效回执', () => {
  for (const expiresAt of ['2026-10-27T10:12:00Z', '2026-10-27T18:12:00+08:00', '2026-10-27T02:12:00-08:00']) {
    assert.equal(agentDeliverySchema.safeParse({ status: 'awaiting_authorization', authorizationUrl: 'https://accounts.feishu.cn/device?user_code=fixture', expiresAt }).success, true);
  }
  assert.equal(agentDeliverySchema.safeParse({ status: 'awaiting_authorization', authorizationUrl: 'https://accounts.feishu.cn/device?user_code=fixture', expiresAt: 'invalid' }).success, false);
});
