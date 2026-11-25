import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { PluginUpdates } from '../plugin/updates.mjs';

const installedVersion = '0.13.7';
const nextVersion = '0.13.8';
const installCommit = 'a'.repeat(40);
const sourceCommit = 'b'.repeat(40);
const cacheRoot = mkdtempSync(join(tmpdir(), 'industry-update-'));
after(() => rmSync(cacheRoot, { recursive: true, force: true }));

function fixture({ changedDigest = false, changedArchive = false, busy = false, oldRelease = false,
  ineligible = false, noHmr = false, failInstall = false } = {}) {
  const settings = new Map();
  const events = [];
  const store = {
    setting: key => settings.get(key),
    saveSetting: (key, value) => settings.set(key, value),
    list: () => busy ? [{ status: 'running' }] : [],
    runtimeLog: (event, details, level) => events.push({ event, details, level }),
  };
  const service = { store, active: new Map(), queuedSaves: { running: new Map(), submissions: new Map() } };
  const calls = [];
  let currentVersion = installedVersion;
  let sourceKind = ineligible ? 'manual' : 'git';
  const manager = {
    listBundles: async () => currentVersion ? [{ name: 'dsh-industry-research', installed: true,
      enabled: true, version: currentVersion, update: sourceKind === 'git' ? 'git' : undefined }] : [],
    removeBundle: async name => {
      calls.push({ operation: 'remove', name });
      if (noHmr) return { application: 'failed', error: { code: 'stop-profile' } };
      currentVersion = null;
      return { application: 'applied' };
    },
    installBundle: async (path, options) => {
      calls.push({ operation: 'install', path, options });
      if (failInstall && path.includes(nextVersion)) return { application: 'failed', error: { diagnostic: '目标安装失败' } };
      currentVersion = path.includes(nextVersion) ? nextVersion : installedVersion;
      sourceKind = 'local';
      return { application: noHmr ? 'restart-required' : 'applied' };
    },
  };
  const archive = Buffer.from('verified offline plugin archive fixture');
  const archiveName = `dsh-industry-research-${nextVersion}.tgz`;
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const archiveUrl = `https://github.com/zaki-zeyi/dsh-industry-research/releases/download/v${nextVersion}/${archiveName}`;
  const previous = Buffer.from('verified previous plugin archive fixture');
  const previousName = `dsh-industry-research-${installedVersion}.tgz`;
  const previousUrl = `https://github.com/zaki-zeyi/dsh-industry-research/releases/download/v${installedVersion}/${previousName}`;
  const manifest = JSON.stringify({ schema: 'dsh-industry-research/update/v1', name: 'dsh-industry-research',
    version: nextVersion, sourceCommit, installCommit, installTag: `plugin-install-v${nextVersion}`,
    archiveName, archiveSize: archive.length, archiveSha256 });
  const digest = createHash('sha256').update(manifest).digest('hex');
  const release = { tag_name: `v${oldRelease ? '0.13.6' : nextVersion}`, target_commitish: sourceCommit, immutable: !oldRelease,
    published_at: '2026-11-20T00:00:00Z',
    assets: oldRelease ? [] : [{ name: 'update-manifest.json', digest: `sha256:${changedDigest ? 'd'.repeat(64) : digest}`,
      browser_download_url: 'https://github.com/example/update-manifest.json' },
    { name: archiveName, size: archive.length, digest: `sha256:${archiveSha256}`, browser_download_url: archiveUrl }] };
  const requests = [];
  const request = async url => {
    requests.push(url);
    if (url.endsWith(`/releases/tags/v${installedVersion}`)) return new Response(JSON.stringify({
      tag_name: `v${installedVersion}`, assets: [{ name: previousName, size: previous.length,
        digest: `sha256:${createHash('sha256').update(previous).digest('hex')}`, browser_download_url: previousUrl }],
    }));
    if (url.includes('api.github.com')) return new Response(JSON.stringify(release));
    if (url === previousUrl) return new Response(previous);
    if (url === archiveUrl) return new Response(changedArchive ? Buffer.from('corrupt') : archive);
    return new Response(manifest);
  };
  return { service, manager, calls, request, requests, settings, events, archive, cacheDir: join(cacheRoot, randomUUID()) };
}

test('更新进度反映下载、等待健康检查和完成，并记录更新日志', async () => {
  const f = fixture();
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await updates.check();
  await updates.download();
  assert.deepEqual(updates.snapshot().progress.phases.map(item => item.status), ['complete', 'waiting', 'waiting']);
  assert.ok(f.events.some(item => item.event === 'update.check.started'));
  assert.ok(f.events.some(item => item.event === 'update.release.verified' && item.details.bytesTotal === f.archive.length));
  assert.ok(f.events.some(item => item.event === 'update.download.completed' && item.details.percent === 100));
  assert.equal(new Set(f.events.map(item => item.details.operationId)).size, 1);
  await updates.install();
  assert.deepEqual(updates.snapshot().progress.phases.map(item => item.status), ['complete', 'complete', 'complete']);
  updates.close();
});

test('下载失败标红并通过重试恢复', async () => {
  const f = fixture({ changedArchive: true });
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await updates.check();
  await assert.rejects(updates.download(), /大小不符|校验失败/);
  assert.equal(updates.snapshot().progress.phases[0].status, 'error');
  const good = fixture();
  updates.request = good.request;
  await updates.retry();
  assert.equal(updates.snapshot().progress.phases[0].status, 'complete');
  assert.ok(f.events.some(item => item.event === 'update.download.failed' && item.level === 'error'));
  assert.ok(f.events.some(item => item.event === 'update.download.failed' && item.details.code === 'INTEGRITY_FAILED'));
  assert.ok(f.events.some(item => item.event === 'update.retry.requested'));
  updates.close();
});

test('更新成功后的联网检查失败不把已完成的安装标为失败', async () => {
  const f = fixture();
  f.settings.set('plugin-update', { automatic: true, lastResult: 'updated', lastVersion: installedVersion });
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: async () => { throw new Error('fetch failed'); }, cacheDir: f.cacheDir });
  const state = await updates.check();
  assert.equal(state.state, 'check-failed');
  assert.equal(state.lastResult, 'updated');
  assert.equal(state.progress.percent, 100);
  assert.deepEqual(state.progress.phases.map(item => item.status), ['complete', 'complete', 'complete']);
  assert.ok(f.events.some(item => item.event === 'update.check.failed' &&
    item.details.phase === 'check' && item.details.code === 'NETWORK_FAILED'));
  updates.close();
});

test('正式发布完整包和旧版恢复包下载后，断网从本地路径更新', async () => {
  const { service, manager, calls, request, requests, settings, archive, cacheDir } = fixture();
  const updates = new PluginUpdates(service, manager, installedVersion, { request, cacheDir, now: () => Date.parse('2026-11-24T00:00:00Z') });
  assert.equal((await updates.check()).candidateVersion, nextVersion);
  const staged = await updates.download();
  assert.deepEqual(readFileSync(staged.path), archive);
  assert.equal(updates.snapshot().packageReady, true);
  assert.equal(requests.filter(url => url.endsWith('.tgz')).length, 2);
  updates.request = async () => { throw new Error('offline'); };
  await updates.install();
  assert.deepEqual(calls.map(call => call.operation), ['remove', 'install']);
  assert.match(calls[1].path, /\.tgz$/);
  assert.deepEqual(calls[1].options.expected, { name: 'dsh-industry-research', version: nextVersion });
  assert.equal(settings.get('plugin-update').pending.version, nextVersion);
  updates.close();
});

test('摘要异常与运行中的任务阻止更新', async () => {
  const invalid = fixture({ changedDigest: true });
  const failed = new PluginUpdates(invalid.service, invalid.manager, installedVersion, { request: invalid.request, cacheDir: invalid.cacheDir });
  assert.match((await failed.check()).error, /校验失败/);
  assert.equal(invalid.calls.length, 0);
  const busy = fixture({ busy: true });
  const updates = new PluginUpdates(busy.service, busy.manager, installedVersion, { request: busy.request, cacheDir: busy.cacheDir });
  await updates.check();
  await updates.download();
  await assert.rejects(updates.install(), /任务或写入/);
  assert.equal(busy.calls.length, 0);
  assert.equal(busy.service.updating, false);
});

test('安装失败后清理切换状态，重启根据实际加载版本核对结果', async () => {
  const failed = fixture({ failInstall: true });
  const updates = new PluginUpdates(failed.service, failed.manager, installedVersion, { request: failed.request, cacheDir: failed.cacheDir });
  await updates.check();
  await updates.download();
  updates.request = async () => { throw new Error('offline'); };
  await assert.rejects(updates.install(), /目标安装失败；旧版已从本地缓存恢复/);
  assert.deepEqual(failed.calls.map(call => call.operation), ['remove', 'install', 'install']);
  assert.equal(updates.snapshot().lastResult, 'failed');
  assert.equal(failed.settings.get('plugin-update').pending, null);
  assert.equal(failed.service.updating, false);

  const success = fixture();
  const initial = new PluginUpdates(success.service, success.manager, installedVersion, { request: success.request, cacheDir: success.cacheDir });
  await initial.check();
  await initial.download();
  await initial.install();
  const restarted = new PluginUpdates(success.service, success.manager, nextVersion, { request: success.request, cacheDir: success.cacheDir });
  await restarted.reconcile();
  assert.equal(restarted.snapshot().lastResult, 'updated');
  assert.equal(success.settings.get('plugin-update').pending, null);
  await restarted.refreshEligibility();
  assert.equal(restarted.snapshot().eligible, true);
  assert.equal(success.settings.get('plugin-update').installedArchive.version, nextVersion);
  initial.close(); restarted.close();
});

test('较旧正式版没有更新清单时显示当前已是新版', async () => {
  const old = fixture({ oldRelease: true });
  const updates = new PluginUpdates(old.service, old.manager, installedVersion, { request: old.request, cacheDir: old.cacheDir });
  const status = await updates.check();
  assert.equal(status.state, 'current');
  assert.equal(status.error, '');
  updates.close();
});

test('可变正式发布不能触发自动安装', async () => {
  const mutable = fixture();
  const request = async url => {
    const response = await mutable.request(url);
    if (!url.includes('api.github.com')) return response;
    return new Response(JSON.stringify({ ...await response.json(), immutable: false }));
  };
  const updates = new PluginUpdates(mutable.service, mutable.manager, installedVersion, { request, cacheDir: mutable.cacheDir });
  assert.match((await updates.check()).error, /不可变保护/);
  assert.equal(mutable.calls.length, 0);
  updates.close();
});

test('损坏的完整安装包不能进入已校验状态，重新检查可复用本机缓存', async () => {
  const broken = fixture({ changedArchive: true });
  const updates = new PluginUpdates(broken.service, broken.manager, installedVersion,
    { request: broken.request, cacheDir: broken.cacheDir });
  await updates.check();
  await assert.rejects(updates.download(), /大小不符|校验失败/);
  assert.equal(updates.snapshot().packageReady, false);
  assert.equal(broken.calls.length, 0);
  updates.close();

  const clean = fixture();
  const first = new PluginUpdates(clean.service, clean.manager, installedVersion,
    { request: clean.request, cacheDir: clean.cacheDir });
  await first.check();
  await first.download();
  first.close();
  const second = new PluginUpdates(clean.service, clean.manager, installedVersion,
    { request: clean.request, cacheDir: clean.cacheDir });
  await second.check();
  const staged = await second.download();
  assert.equal(staged.cached, true);
  assert.equal(clean.requests.filter(url => url.endsWith('.tgz')).length, 2);
  second.close();
});

test('同一时间的两个安装请求只调用一次宿主安装器', async () => {
  const f = fixture();
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await updates.check();
  await updates.download();
  await Promise.all([updates.install(), updates.install()]);
  assert.deepEqual(f.calls.map(call => call.operation), ['remove', 'install']);
  updates.close();
});

test('本地开发版只提示更新，不自动下载无法安装的包', async () => {
  const f = fixture({ ineligible: true });
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await updates.check();
  assert.equal(updates.snapshot().eligible, false);
  assert.equal(f.requests.filter(url => url.endsWith('.tgz')).length, 0);
  await assert.rejects(updates.install(), /安装来源不受自动更新支持/);
  assert.equal(f.requests.filter(url => url.endsWith('.tgz')).length, 0);
  updates.close();
});

test('无热重载宿主直接从本地包安装，旧插件运行到重启', async () => {
  const f = fixture({ noHmr: true });
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await updates.check();
  await updates.download();
  updates.request = async () => { throw new Error('offline'); };
  await updates.install();
  assert.deepEqual(f.calls.map(call => call.operation), ['remove', 'install']);
  assert.equal(updates.snapshot().state, 'restart-required');
  await updates.reconcile();
  assert.equal(f.settings.get('plugin-update').pending.version, nextVersion);
  const rebooted = new PluginUpdates(f.service, f.manager, nextVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await rebooted.reconcile();
  assert.equal(rebooted.snapshot().lastResult, 'updated');
  rebooted.close();
  updates.close();
});

test('下载后重启且断网，缓存仍能完成安装', async () => {
  const f = fixture();
  const first = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await first.check();
  await first.download();
  first.close();
  const offline = async () => { throw new Error('offline'); };
  const second = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: offline, cacheDir: f.cacheDir });
  assert.equal(second.snapshot().candidateVersion, nextVersion);
  await second.download();
  assert.equal(second.snapshot().packageReady, true);
  await second.install();
  assert.deepEqual(f.calls.map(call => call.operation), ['remove', 'install']);
  second.close();
});

test('新版加载期间等待宿主安装结束，避免提前确认成功', async () => {
  const f = fixture();
  f.settings.set('plugin-update', { automatic: false, pending: {
    version: nextVersion, previousVersion: installedVersion, requestId: randomUUID(),
    archive: { version: nextVersion }, previousArchive: { version: installedVersion },
  } });
  let finish;
  f.manager.waitForInstall = () => new Promise(resolve => { finish = resolve; });
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  const work = updates.reconcile();
  assert.ok(f.settings.get('plugin-update').pending);
  finish({ application: 'failed' });
  await work;
  assert.equal(updates.snapshot().lastResult, 'restored');
  updates.close();
});

test('缓存包在安装前被破坏时拒绝移除旧版', async () => {
  const f = fixture();
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await updates.check();
  const staged = await updates.download();
  writeFileSync(staged.path, 'corrupt');
  updates.request = async () => { throw new Error('offline'); };
  await assert.rejects(updates.install(), /offline/);
  assert.equal(f.calls.length, 0);
  updates.close();
});

test('宿主报告安装成功但实际版本不符时，从本地旧包恢复', async () => {
  const f = fixture();
  const originalInstall = f.manager.installBundle;
  f.manager.installBundle = async (path, options) => {
    if (path.includes(nextVersion)) {
      f.calls.push({ operation: 'install', path, options });
      return { application: 'applied', bundle: 'dsh-industry-research' };
    }
    return originalInstall(path, options);
  };
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await updates.check();
  await updates.download();
  updates.request = async () => { throw new Error('offline'); };
  await assert.rejects(updates.install(), /版本不一致；旧版已从本地缓存恢复/);
  assert.deepEqual(f.calls.map(call => call.operation), ['remove', 'install', 'install']);
  updates.close();
});

test('热重载卸载当前插件后，失败安装仍继续从本地恢复旧版', async () => {
  const f = fixture({ failInstall: true });
  const updates = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  const remove = f.manager.removeBundle;
  f.manager.removeBundle = async name => {
    const result = await remove(name);
    updates.close();
    return result;
  };
  await updates.check();
  await updates.download();
  updates.request = async () => { throw new Error('offline'); };
  await assert.rejects(updates.install(), /旧版已从本地缓存恢复/);
  assert.deepEqual(f.calls.map(call => call.operation), ['remove', 'install', 'install']);
  const restored = new PluginUpdates(f.service, f.manager, installedVersion,
    { request: f.request, cacheDir: f.cacheDir });
  await restored.reconcile();
  assert.equal(restored.snapshot().lastResult, 'restored');
  restored.close();
});
