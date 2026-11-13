import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { createScopedSync } from '../server/sync-once.mjs';

const doc = (name, url) => ({ name, type: 'docx', url, modified_time: '1793934000' });
const listing = files => async (_command, args) => ({ stdout: JSON.stringify({ ok: true, data: { files: files[args[args.indexOf('--folder-token') + 1]] ?? [], has_more: false } }) });

function setup() {
  const f = fixture();
  f.service.cloudOnly = true;
  f.service.setFeishuSettings({ rootName: '行研工作台', folderUrl: 'https://example.feishu.cn/drive/folder/RootFixture' });
  f.service.binding = { applicationSnapshot: () => ({ mode: 'custom', appId: 'cli_fixture123', profile: 'fixture' }) };
  return f;
}
async function listen(f, run) {
  const server = createApp(f.service, { publicationRun: run }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, base: 'http://127.0.0.1:' + server.address().port, async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
const dailyFiles = { RootFixture: [{ type: 'folder', name: '日报', token: 'daily' }], daily: [doc('日报 · 历史报告', 'https://example.feishu.cn/docx/RemoteDaily')] };

test('新鲜缓存直接复用，force 才绕过缓存，并发刷新合并为一次读取', async () => {
  let loads = 0;
  const sync = createScopedSync({ now: () => Date.parse('2026-11-11T00:00:00.000Z') });
  const cached = async () => ({ syncedAt: '2026-11-10T23:59:30.000Z', items: ['cache'] });
  const load = async () => { loads++; return { syncedAt: '2026-11-11T00:00:00.000Z', items: ['fresh'] }; };
  assert.deepEqual(await sync.run('scope', {}, cached, load), { syncedAt: '2026-11-10T23:59:30.000Z', items: ['cache'] });
  assert.equal(loads, 0);
  assert.deepEqual(await sync.run('scope', { force: true }, cached, load), { syncedAt: '2026-11-11T00:00:00.000Z', items: ['fresh'] });
  assert.equal(loads, 1);
  loads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const slow = () => { loads++; return gate; };
  const running = [sync.run('other', { force: true }, cached, slow), sync.run('other', { force: true }, cached, slow), sync.run('other', { force: true }, cached, slow)];
  release({ syncedAt: '2026-11-11T00:00:00.000Z', items: ['shared'] });
  const results = await Promise.all(running);
  assert.equal(loads, 1);
  assert.deepEqual(results.map(value => value.items), [['shared'], ['shared'], ['shared']]);
});

test('失败的刷新不写缓存，下一次仍会真正读取', async () => {
  let attempts = 0;
  const sync = createScopedSync();
  const cached = async () => ({ syncedAt: null, items: [] });
  await assert.rejects(sync.run('scope', { force: true }, cached, async () => { attempts++; throw new Error('network timeout'); }));
  await sync.run('scope', { force: true }, cached, async () => { attempts++; return { syncedAt: new Date().toISOString(), items: ['ok'] }; });
  assert.equal(attempts, 2);
});

test('切换页签在 60 秒缓存内不重复读取飞书，手动刷新只同步一次', async () => {
  const f = setup();
  let calls = 0;
  const run = async (...args) => { calls++; return listing(dailyFiles)(...args); };
  const { base, close } = await listen(f, run);
  try {
    const url = base + '/api/briefings?kind=daily';
    const responses = await Promise.all([fetch(url + '&refresh=true'), fetch(url + '&refresh=true'), fetch(url + '&refresh=true')]);
    assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
    const first = await responses[0].json();
    assert.equal(first.items.length, 1);
    assert.ok(first.syncedAt, '同步成功必须记录上次同步时间');
    assert.equal(calls, 2, '同一范围的并发刷新只读取一次飞书目录');

    const again = await (await fetch(url + '&refresh=true')).json();
    assert.equal(again.syncedAt, first.syncedAt, '60 秒内复用缓存');
    assert.equal(calls, 2);

    const cached = await (await fetch(url)).json();
    assert.equal(cached.items.length, 1);
    assert.equal(cached.syncedAt, first.syncedAt);
    assert.equal(calls, 2, '读取缓存不访问飞书');

    const forced = await (await fetch(url + '&refresh=true&force=true')).json();
    assert.equal(forced.items.length, 1);
    assert.equal(calls, 4, '手动刷新强制读取，且只读取一次');
  } finally { await close(); await f.close(); }
});

test('同步失败时保留缓存卡片并返回错误，重试成功后清除', async () => {
  const f = setup();
  let fail = false, calls = 0;
  const run = async (...args) => { calls++; if (fail) throw new Error('network timeout'); return listing(dailyFiles)(...args); };
  const { base, close } = await listen(f, run);
  try {
    const url = base + '/api/briefings?kind=daily';
    const first = await (await fetch(url + '&refresh=true')).json();
    assert.equal(first.items.length, 1);
    fail = true;
    const broken = await (await fetch(url + '&refresh=true&force=true')).json();
    assert.equal(broken.items.length, 1, '同步失败仍返回上次缓存卡片');
    assert.match(broken.syncError, /网络连接异常/);
    assert.equal(broken.syncedAt, first.syncedAt, '失败不推进上次同步时间');
    fail = false;
    const recovered = await (await fetch(url + '&refresh=true&force=true')).json();
    assert.equal(recovered.syncError, undefined);
    assert.equal(recovered.items.length, 1);
    // 首次 2 次目录读取，失败重试读取 1 次后中止，恢复后再读取 2 次。
    assert.equal(calls, 5);
  } finally { await close(); await f.close(); }
});

test('内部资料缓存读取不重复扫描三层目录', async () => {
  const f = setup();
  let calls = 0;
  const files = { RootFixture: [{ type: 'folder', name: '内部资料', token: 'internal' }], internal: [{ type: 'folder', name: '逐字稿', token: 'transcript' }], transcript: [doc('云端访谈', 'https://example.feishu.cn/docx/Interview')] };
  const run = async (...args) => { calls++; return listing(files)(...args); };
  const { base, close } = await listen(f, run);
  try {
    const url = base + '/api/internal-materials';
    const synced = await (await fetch(url + '?refresh=true')).json();
    assert.equal(synced.items.length, 1);
    assert.equal(calls, 3, '内部资料首次同步读取根目录、资料目录和逐字稿目录');
    const cached = await (await fetch(url)).json();
    assert.equal(cached.items.length, 1);
    assert.equal(cached.syncedAt, synced.syncedAt);
    assert.equal(calls, 3);
    const reused = await (await fetch(url + '?refresh=true')).json();
    assert.equal(reused.syncedAt, synced.syncedAt);
    assert.equal(calls, 3, '60 秒内再次进入内部资料不重新扫描');
  } finally { await close(); await f.close(); }
});
