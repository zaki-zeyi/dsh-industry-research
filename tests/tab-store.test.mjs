import test from 'node:test';
import assert from 'node:assert/strict';
import { createTabStore } from '../src/tab-store.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const card = (id, kind = 'daily') => ({ id, direction: kind + '-' + id, status: 'ready', briefing: { kind, window: { display: '区间' } }, publication: { status: 'published', url: 'https://example.feishu.cn/docx/' + id } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const ids = state => state.items.map(item => item.id);

test('页签先显示本地缓存，远端同步在后台完成时再替换', async () => {
  const store = createTabStore();
  const gate = deferred();
  const readers = {
    cached: async () => ({ items: [card('cached')], syncedAt: '2020-01-01T00:00:00.000Z' }),
    sync: () => gate.promise,
  };
  const opening = store.open('daily', readers);
  await tick();
  assert.deepEqual(ids(store.get('daily')), ['cached']);
  assert.equal(store.get('daily').status, 'ready');
  assert.ok(store.get('daily').syncing, '同步仍在进行，不阻塞缓存展示');
  gate.resolve({ items: [card('fresh')], syncedAt: new Date().toISOString() });
  await opening;
  assert.deepEqual(ids(store.get('daily')), ['fresh']);
  assert.equal(store.get('daily').syncError, '');
});

test('切换页签不会显示另一个页签的内容，未命中缓存时先占位', async () => {
  const store = createTabStore();
  const ready = { items: [card('d')], syncedAt: new Date().toISOString() };
  await store.open('daily', { cached: async () => ready, sync: async () => ready });
  const gate = deferred();
  const opening = store.open('weekly', { cached: () => gate.promise, sync: async () => ({}) });
  assert.deepEqual(ids(store.get('weekly')), []);
  assert.equal(store.get('weekly').status, 'loading');
  assert.deepEqual(ids(store.get('daily')), ['d']);
  gate.resolve({ items: [card('w', 'weekly')], syncedAt: new Date().toISOString() });
  await opening;
  assert.deepEqual(ids(store.get('weekly')), ['w']);
  assert.deepEqual(ids(store.get('daily')), ['d']);
});

test('迟到的缓存响应不会覆盖更新的同步结果', async () => {
  const store = createTabStore();
  const slow = deferred();
  const readers = { cached: () => slow.promise, sync: async () => ({ items: [card('fresh')], syncedAt: new Date().toISOString() }) };
  const opening = store.open('daily', readers);
  await store.refresh('daily', readers);
  assert.deepEqual(ids(store.get('daily')), ['fresh']);
  slow.resolve({ items: [card('stale')], syncedAt: '2020-01-01T00:00:00.000Z' });
  await opening;
  assert.deepEqual(ids(store.get('daily')), ['fresh']);
});

test('同一范围只会发起一次远端同步', async () => {
  const store = createTabStore();
  const gate = deferred();
  let calls = 0;
  const readers = { cached: async () => ({ items: [], syncedAt: null }), sync: () => { calls++; return gate.promise; } };
  const first = store.open('daily', readers), second = store.open('daily', readers), forced = store.refresh('daily', readers);
  await tick();
  assert.equal(calls, 1);
  gate.resolve({ items: [card('once')], syncedAt: new Date().toISOString() });
  await Promise.all([first, second, forced]);
  assert.deepEqual(ids(store.get('daily')), ['once']);
  assert.equal(calls, 1);
});

test('60 秒缓存内的再次进入复用结果，手动刷新强制同步', async () => {
  let at = Date.parse('2026-11-11T00:00:00.000Z');
  const store = createTabStore({ now: () => at });
  let syncedAt = new Date(at).toISOString(), calls = 0;
  const readers = { cached: async () => ({ items: [card('cache')], syncedAt }), sync: async () => { calls++; syncedAt = new Date(at).toISOString(); return { items: [card('sync')], syncedAt }; } };
  await store.open('daily', readers);
  assert.equal(calls, 0);
  at += 30_000;
  await store.open('daily', readers);
  assert.equal(calls, 0, '60 秒内不重复读取飞书');
  at += 31_000;
  await store.open('daily', readers);
  assert.equal(calls, 1, '超过 60 秒后重新同步');
  await store.refresh('daily', readers);
  assert.equal(calls, 2, '手动刷新不受缓存有效期限制');
});

test('同步失败保留当前缓存并给出错误与重试入口', async () => {
  const store = createTabStore();
  let fail = true;
  const readers = {
    cached: async () => ({ items: [card('cache')], syncedAt: '2020-01-01T00:00:00.000Z' }),
    sync: async () => { if (fail) return { items: [], syncedAt: null, syncError: '飞书连接暂时不可用，缓存已保留' }; return { items: [card('fresh')], syncedAt: new Date().toISOString() }; },
  };
  await store.open('daily', readers);
  assert.deepEqual(ids(store.get('daily')), ['cache']);
  assert.match(store.get('daily').syncError, /缓存已保留/);
  fail = false;
  await store.refresh('daily', readers);
  assert.deepEqual(ids(store.get('daily')), ['fresh']);
  assert.equal(store.get('daily').syncError, '');
});

test('同步抛错时不清空缓存，也不在退避期内自动重试', async () => {
  let at = Date.parse('2026-11-11T00:00:00.000Z');
  const store = createTabStore({ now: () => at });
  let calls = 0;
  const readers = { cached: async () => ({ items: [card('cache')], syncedAt: '2020-01-01T00:00:00.000Z' }), sync: async () => { calls++; throw new Error('network down'); } };
  await store.open('daily', readers);
  assert.deepEqual(ids(store.get('daily')), ['cache']);
  assert.equal(store.get('daily').syncError, 'network down');
  at += 3000;
  await store.open('daily', readers);
  assert.equal(calls, 1, '失败后短时间内不重复请求');
  at += 20_000;
  await store.open('daily', readers);
  assert.equal(calls, 2);
});
