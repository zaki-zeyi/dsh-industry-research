import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { PluginUpdates } from '../plugin/updates.mjs';

const installedVersion = '0.13.7';
const nextVersion = '0.13.8';
const installCommit = 'a'.repeat(40);
const sourceCommit = 'b'.repeat(40);

function fixture({ changedDigest = false, busy = false, oldRelease = false } = {}) {
  const settings = new Map();
  const store = {
    setting: key => settings.get(key),
    saveSetting: (key, value) => settings.set(key, value),
    list: () => busy ? [{ status: 'running' }] : [],
  };
  const service = { store, active: new Map(), queuedSaves: { running: new Map(), submissions: new Map() } };
  const calls = [];
  const manager = {
    listBundles: async () => [{ name: 'dsh-industry-research', installed: true, version: installedVersion, update: 'git' }],
    updateBundle: async (...args) => { calls.push(args); return { application: 'restart-required' }; },
  };
  const manifest = JSON.stringify({ schema: 'dsh-industry-research/update/v1', name: 'dsh-industry-research',
    version: nextVersion, sourceCommit, installCommit, installTag: `plugin-install-v${nextVersion}`, archiveSha256: 'c'.repeat(64) });
  const digest = createHash('sha256').update(manifest).digest('hex');
  const release = { tag_name: `v${oldRelease ? '0.13.6' : nextVersion}`, target_commitish: sourceCommit, immutable: !oldRelease,
    published_at: '2026-11-20T00:00:00Z',
    assets: oldRelease ? [] : [{ name: 'update-manifest.json', digest: `sha256:${changedDigest ? 'd'.repeat(64) : digest}`,
      browser_download_url: 'https://github.com/example/update-manifest.json' }] };
  const request = async url => new Response(url.includes('api.github.com') ? JSON.stringify(release) : manifest);
  return { service, manager, calls, request, settings };
}

test('正式发布清单通过摘要校验后，以固定安装提交交给 DSH 更新', async () => {
  const { service, manager, calls, request, settings } = fixture();
  const updates = new PluginUpdates(service, manager, installedVersion, { request, now: () => Date.parse('2026-11-24T00:00:00Z') });
  assert.equal((await updates.check()).candidateVersion, nextVersion);
  await updates.install();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], nextVersion);
  assert.match(calls[0][2].spec, new RegExp(installCommit + '$'));
  assert.equal(settings.get('plugin-update').pending.version, nextVersion);
  updates.close();
});

test('摘要异常与运行中的任务阻止更新', async () => {
  const invalid = fixture({ changedDigest: true });
  const failed = new PluginUpdates(invalid.service, invalid.manager, installedVersion, { request: invalid.request });
  assert.match((await failed.check()).error, /校验失败/);
  assert.equal(invalid.calls.length, 0);
  const busy = fixture({ busy: true });
  const updates = new PluginUpdates(busy.service, busy.manager, installedVersion, { request: busy.request });
  await updates.check();
  await assert.rejects(updates.install(), /任务或写入/);
  assert.equal(busy.calls.length, 0);
  assert.equal(busy.service.updating, false);
});

test('安装失败后清理切换状态，重启根据实际加载版本核对结果', async () => {
  const failed = fixture();
  failed.manager.updateBundle = async () => ({ application: 'failed', error: { diagnostic: '目标安装失败' } });
  const updates = new PluginUpdates(failed.service, failed.manager, installedVersion, { request: failed.request });
  await updates.check();
  await assert.rejects(updates.install(), /目标安装失败/);
  assert.equal(updates.snapshot().lastResult, 'failed');
  assert.equal(failed.settings.get('plugin-update').pending, null);
  assert.equal(failed.service.updating, false);

  const success = fixture();
  const initial = new PluginUpdates(success.service, success.manager, installedVersion, { request: success.request });
  await initial.check();
  await initial.install();
  const restarted = new PluginUpdates(success.service, success.manager, nextVersion, { request: success.request });
  assert.equal(restarted.snapshot().lastResult, 'updated');
  assert.equal(success.settings.get('plugin-update').pending, null);
  initial.close(); restarted.close();
});

test('较旧正式版没有更新清单时显示当前已是新版', async () => {
  const old = fixture({ oldRelease: true });
  const updates = new PluginUpdates(old.service, old.manager, installedVersion, { request: old.request });
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
  const updates = new PluginUpdates(mutable.service, mutable.manager, installedVersion, { request });
  assert.match((await updates.check()).error, /不可变保护/);
  assert.equal(mutable.calls.length, 0);
  updates.close();
});
