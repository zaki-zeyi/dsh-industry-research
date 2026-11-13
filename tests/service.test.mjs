import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';
import { Store } from '../server/store.mjs';
import { ResearchService } from '../server/service.mjs';
import { DemoResearcher } from '../server/providers/demo.mjs';
import { DemoPublisher } from '../server/providers/publisher.mjs';
import { reportSchema } from '../server/report.mjs';

test('AC-01 创建后立即记录；报告含来源且自动发布', async () => {
  const f = fixture(); try {
    const t = f.service.create({ direction: 'CPU 算力研究' }); assert.equal(t.status, 'queued'); assert.equal(f.store.list().length, 1);
    assert.match(t.prompt, /全网/); assert.match(t.prompt, /CPU 算力研究/);
    await until(() => f.store.get(t.id).publication.status === 'published');
    const done = f.store.get(t.id); assert.equal(done.status, 'ready'); assert.equal(done.runs.length, 1); assert.ok(done.runs[0].sessionId); assert.equal(done.report.sources[0].id, 'S1'); assert.ok(f.store.document(done.publication.documentId));
  } finally { await f.close(); }
});
test('AC-02 并发重复创建请求只产生一个任务，冲突请求拒绝', async () => {
  const f = fixture(); try { const a = f.service.create({ direction: '重复提交' }, 'same-key'); const b = f.service.create({ direction: '重复提交' }, 'same-key'); assert.equal(a.id, b.id); assert.equal(f.store.list().length, 1); assert.throws(() => f.service.create({ direction: '不同内容' }, 'same-key'), /不同的任务/); } finally { await f.close(); }
});
test('AC-03 调研失败保留草稿与会话，重试增加执行记录', async () => {
  const f = fixture({ failResearch: true }); try {
    const t = f.service.create({ direction: '中断恢复研究' }); await until(() => f.store.get(t.id).status === 'failed');
    const failed = f.store.get(t.id); assert.ok(failed.draft.length > 30); const oldEvents = f.store.events(t.id); assert.ok(oldEvents.some(e => e.type === 'assistant'));
    await until(() => !f.service.active.size); f.service.retry(t.id, 'research'); await until(() => f.store.get(t.id).publication.status === 'published');
    const done = f.store.get(t.id); assert.equal(done.runs.length, 2); assert.equal(done.runs[0].status, 'failed'); assert.ok(f.store.events(t.id).length > oldEvents.length); assert.equal(done.report.version, 1);
  } finally { await f.close(); }
});
test('AC-04 发布失败仅重试发布，多次点击不重复建文档或执行 AI', async () => {
  const f = fixture({ failPublish: true }); try {
    const t = f.service.create({ direction: '文档发布研究' }); await until(() => f.store.get(t.id).publication.status === 'failed'); await until(() => !f.service.active.size);
    const failed = f.store.get(t.id); assert.equal(failed.status, 'ready'); assert.ok(failed.report); const docId = failed.publication.documentId;
    f.service.retry(t.id, 'publish'); assert.throws(() => f.service.retry(t.id, 'publish'), /正在执行/);
    await until(() => f.store.get(t.id).publication.status === 'published');
    const done = f.store.get(t.id); assert.equal(done.publication.documentId, docId); assert.equal(done.runs.length, 1); assert.equal(done.reports.length, 1); assert.equal(f.store.db.prepare('SELECT count(*) n FROM demo_documents').get().n, 1);
  } finally { await f.close(); }
});
test('AC-05 历史记录重新打开不触发模型，事件顺序不变', async () => {
  const f = fixture(); try { const t = f.service.create({ direction: '历史记录研究' }); await until(() => f.store.get(t.id).publication.status === 'published'); await until(() => !f.service.active.size); const events = f.store.events(t.id); for (let i = 0; i < 3; i++) f.service.require(t.id); assert.deepEqual(f.store.events(t.id), events); assert.equal(f.service.require(t.id).runs.length, 1); assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq)); } finally { await f.close(); }
});
test('AC-06 服务重启保留草稿，标记中断并允许恢复', async () => {
  const f = fixture(); let nextStore, nextService; try {
    const t = f.service.create({ direction: '重启恢复研究' }); await until(() => f.store.get(t.id).publication.status === 'published'); await f.service.close();
    const prior = f.store.get(t.id); prior.status = 'running'; prior.stage = 'research'; prior.draft = '服务中断前保存的草稿'; prior.report = null; prior.publication.status = 'pending'; f.store.save(prior); f.store.close();
    nextStore = new Store(f.path); nextService = new ResearchService(nextStore, new DemoResearcher({ delayMs: 5 }), new DemoPublisher(nextStore)); nextService.recover();
    const recovered = nextStore.get(t.id); assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.draft, '服务中断前保存的草稿'); assert.ok(nextStore.events(t.id).some(e => e.type === 'assistant'));
    nextService.retry(t.id, 'research'); await until(() => nextStore.get(t.id).publication.status === 'published'); assert.equal(nextStore.get(t.id).runs.length, 2);
  } finally { if (nextService) await nextService.close(); if (nextStore) nextStore.close(); else f.store.close(); const { rmSync } = await import('node:fs'); rmSync(f.dir, { recursive: true, force: true }); }
});
test('AC-07 非法参数和未知来源引用被拒绝', async () => {
  const f = fixture(); try { assert.throws(() => f.service.create({ direction: ' ' })); assert.throws(() => reportSchema.parse({ title: '报告', summary: '这是至少十个字的报告摘要', markdown: '这是一份足够长的报告正文，用于验证数据来源引用是否真实存在，引用不存在的来源编号。[S2]', sources: [{ id: 'S1', title: '来源', url: 'https://example.com', excerpt: '这是一段至少十个字的来源证据' }] })); assert.throws(() => f.service.require('missing'), /不存在/); } finally { await f.close(); }
});
test('AC-08 取消执行后保留已完成内容', async () => {
  const f = fixture({ researcher: new DemoResearcher({ delayMs: 100 }) }); try { const t = f.service.create({ direction: '取消任务研究' }); await until(() => f.store.get(t.id).draft); f.service.cancel(t.id); await until(() => !f.service.active.size); assert.equal(f.store.get(t.id).status, 'interrupted'); assert.ok(f.store.get(t.id).draft); assert.ok(f.store.events(t.id).some(e => e.type === 'assistant')); } finally { await f.close(); }
});
