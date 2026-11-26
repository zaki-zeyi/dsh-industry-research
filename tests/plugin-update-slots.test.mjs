import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginUpdates } from '../plugin/updates.mjs';

const version = '0.13.8', next = '0.13.9';

function fixture(t, initial = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'industry-slot-update-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const settings = new Map([['plugin-update', initial]]);
  const service = { store: { setting: key => settings.get(key), saveSetting: (key, value) => settings.set(key, value), list: () => [] },
    active: new Map(), queuedSaves: { running: new Map(), submissions: new Map() } };
  const archive = Buffer.from('verified slot fixture');
  const name = `dsh-industry-research-${next}.tgz`;
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const archiveUrl = `https://github.com/zaki-zeyi/dsh-industry-research/releases/download/v${next}/${name}`;
  const manifest = JSON.stringify({ schema: 'dsh-industry-research/update/v1', name: 'dsh-industry-research',
    version: next, sourceCommit: 'b'.repeat(40), installCommit: 'a'.repeat(40), installTag: `plugin-install-v${next}`,
    archiveName: name, archiveSize: archive.length, archiveSha256: sha256 });
  const release = { tag_name: `v${next}`, target_commitish: 'b'.repeat(40), immutable: true,
    published_at: '2026-11-20T00:00:00Z', assets: [
      { name: 'update-manifest.json', digest: `sha256:${createHash('sha256').update(manifest).digest('hex')}`,
        browser_download_url: 'https://example.com/manifest' },
      { name, size: archive.length, digest: `sha256:${sha256}`, browser_download_url: archiveUrl },
    ] };
  const requests = [];
  const request = async url => {
    requests.push(url);
    return new Response(url === archiveUrl ? archive : url.includes('api.github.com') ? JSON.stringify(release) : manifest);
  };
  const scheduled = [];
  const slotUpdater = { activeVersion: version, state: { lastResult: null },
    async schedule(path, candidate) { scheduled.push({ path, candidate }); },
    async waitForActivation() {} };
  const updates = new PluginUpdates(service, () => { throw new Error('DSH manager must not be used'); }, version,
    { request, cacheDir, slotUpdater, now: () => Date.parse('2026-11-24T00:00:00Z') });
  t.after(() => updates.close());
  return { updates, requests, settings, scheduled, slotUpdater, service };
}

test('自动更新只下载新版包并安排槽位切换，不调用 DSH 安装器', async t => {
  const f = fixture(t);
  await f.updates.check();
  await f.updates.download();
  assert.equal(f.requests.filter(url => url.endsWith('.tgz')).length, 1);
  f.updates.request = async () => { throw new Error('offline'); };
  await f.updates.install();
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.scheduled[0].candidate.version, next);
  assert.equal(f.updates.snapshot().state, 'restart-required');
  assert.equal(f.settings.get('plugin-update').pending.version, next);
});

test('槽位启动失败后的版本隔离，后续检查不会反复自动切到坏版本', async t => {
  const f = fixture(t, { pending: { version: next, previousVersion: version } });
  f.slotUpdater.state.lastResult = { state: 'restored', version: next, error: 'health failed' };
  await f.updates.reconcile();
  assert.equal(f.updates.snapshot().lastResult, 'restored');
  assert.equal(f.settings.get('plugin-update').failedVersion, next);
  await f.updates.check();
  assert.equal(f.updates.snapshot().candidateVersion, null);
  assert.match(f.updates.snapshot().error, /等待下一正式版本/);
  assert.equal(f.requests.filter(url => url.endsWith('.tgz')).length, 0);
});

test('槽位状态损坏也能结算待确认更新，避免永远等待', async t => {
  const f = fixture(t, { pending: { version: next, previousVersion: version } });
  f.slotUpdater.state.lastResult = { state: 'restored', version: null, reason: 'state-corrupt' };
  await f.updates.reconcile();
  assert.equal(f.settings.get('plugin-update').pending, null);
  assert.equal(f.settings.get('plugin-update').failedVersion, next);
});

test('已确认的新版在后续启动失败，回退后同样隔离坏版本', async t => {
  const f = fixture(t, { lastResult: 'updated', lastVersion: next });
  f.slotUpdater.state.lastResult = { state: 'restored', version: next, error: 'health failed' };
  await f.updates.reconcile();
  assert.equal(f.settings.get('plugin-update').failedVersion, next);
  await f.updates.check();
  assert.equal(f.updates.snapshot().candidateVersion, null);
});

test('手动安装遇忙后持久化意图，即使自动更新关闭也在空闲后继续', async t => {
  const f = fixture(t);
  await f.updates.check(); await f.updates.download();
  let count = 0;
  f.slotUpdater.activate = async () => {
    count++;
    if (count === 1) throw Object.assign(new Error('busy'), { code: 'WORKBENCH_BUSY' });
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await f.updates.install();
  assert.equal(f.updates.snapshot().state, 'waiting-idle');
  assert.equal(f.settings.get('plugin-update').installRequested.version, next);
  t.mock.timers.tick(5000);
  t.mock.timers.reset();
  for (let attempt = 0; attempt < 100 && count < 2; attempt++) await new Promise(done => setTimeout(done, 10));
  assert.equal(count, 2);
});
