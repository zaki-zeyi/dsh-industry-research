import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.mjs';
import { fixture, until } from './helpers.mjs';

async function withServer(fn) { const f = fixture(); const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); try { await fn(`http://127.0.0.1:${server.address().port}`, f); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); await f.close(); } }
test('AC-09 HTTP 创建、校验、历史分页、404 和跨站修改保护', async () => withServer(async base => {
  const post = (body, headers = {}) => fetch(`${base}/api/tasks`, { method: 'POST', headers: { 'Content-Type':'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ direction: ' ' })).status, 400);
  assert.equal((await post({ direction: '跨站请求' }, { Origin: 'https://evil.example' })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => { const r = httpRequest(`${base}/api/config`, { headers: { Host: 'untrusted.example' } }, response => { response.resume(); resolve(response.statusCode); }); r.on('error', reject); r.end(); });
  assert.equal(hostStatus, 403);
  const r = await post({ direction:'接口验收' }, { 'Idempotency-Key':'http-key' }); assert.equal(r.status, 202); const t = await r.json();
  assert.equal((await (await post({ direction:'接口验收' }, { 'Idempotency-Key':'http-key' })).json()).id, t.id);
  await post({ direction:'第二份调研' }); const page = await (await fetch(`${base}/api/tasks?limit=1`)).json(); assert.equal(page.items.length, 1); assert.ok(page.nextCursor);
  const second = await (await fetch(`${base}/api/tasks?limit=1&cursor=${page.nextCursor}`)).json(); assert.equal(second.items.length, 1); assert.notEqual(page.items[0].id, second.items[0].id);
  assert.equal((await fetch(`${base}/api/tasks/missing`)).status, 404); assert.equal((await fetch(`${base}/api/tasks?limit=-1`)).status, 400);
}));
test('AC-10 SSE 断线重连按游标补发，断线不取消后台任务', async () => withServer(async (base, f) => {
  const t = f.service.create({ direction: '事件订阅验收' });
  const firstEvent = f.store.events(t.id)[0]; const controller = new AbortController();
  const r = await fetch(`${base}/api/tasks/${t.id}/events`, { headers: { 'Last-Event-ID': String(firstEvent.seq) }, signal: controller.signal }); assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const reader = r.body.getReader(); const { value } = await reader.read(); const text = new TextDecoder().decode(value); assert.ok(!text.includes(`id: ${firstEvent.seq}\n`)); assert.match(text, /event: update/); controller.abort();
  await until(() => f.store.get(t.id).publication.status === 'published'); assert.equal(f.store.get(t.id).runs.length, 1);
}));
