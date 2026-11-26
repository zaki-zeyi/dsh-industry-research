import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OfficialGitUpdates } from '../plugin/official-update.mjs';
import { PluginUpdates } from '../plugin/updates.mjs';
import { activeUpdate, claimUpdate } from '../plugin/update-operation.mjs';
import { repository, trustedGitSource } from '../plugin/update-release.mjs';

function fixture(t, options = {}) {
  const cacheDir = mkdtempSync(join(tmpdir(), 'official-update-'));
  t.after(() => rmSync(cacheDir, { recursive: true, force: true }));
  const settings = new Map(), logs = [], calls = [];
  const service = { active: new Set(), store: { list: () => options.busy ? [{ status: 'running' }] : [],
    setting: key => settings.get(key), saveSetting: (key, value) => settings.set(key, value), runtimeLog: (...args) => logs.push(args) } };
  let installed = { name: 'dsh-industry-research', installed: true, version: '1.0.0', update: 'git', source: `${repository}#${'a'.repeat(40)}` };
  if (options.source) installed.source = options.source;
  const manager = { listBundles: async () => [installed], updateBundle: async (...args) => {
    calls.push(args);
    if (options.wait) await options.wait;
    if (options.failure) return { result: { application: 'failed' }, restore: { application: 'applied' } };
    if (!options.mismatch) installed = { ...installed, version: '1.1.0', source: `${repository}#${'b'.repeat(40)}` };
    if (!options.unhealthy) activeUpdate(cacheDir).runningVersion = '1.1.0';
    return { result: { application: options.restart ? 'restart-required' : 'applied' } };
  } };
  const updater = new OfficialGitUpdates(service, () => manager, options.runtime ?? '1.0.0', { cacheDir });
  updater.candidate = { version: '1.1.0', installCommit: 'b'.repeat(40) };
  return { cacheDir, service, manager, updater, calls, logs };
}

test('官方 Git 更新调用固定提交；卸载后结果由新实例读取且日志只导入一次', async t => {
  const f = fixture(t);
  f.updater.start('1.1.0'); f.updater.disposed = true; await f.updater.work;
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2].spec, `${repository}#${'b'.repeat(40)}`);
  const next = new OfficialGitUpdates(f.service, () => f.manager, '1.1.0', { cacheDir: f.cacheDir });
  assert.equal((await next.snapshot()).operation.state, 'updated');
  const count = f.logs.length; await next.snapshot(); assert.equal(f.logs.length, count);
  assert.equal(activeUpdate(f.cacheDir), undefined);
});

test('运行中的任务阻止官方更新，不调用宿主，不中断任务', async t => {
  const f = fixture(t, { busy: true }); f.updater.start('1.1.0'); await f.updater.work;
  assert.equal(f.calls.length, 0); assert.match(f.updater.record().error, /任务或写入/); assert.notEqual(f.service.updating, true);
});

test('本地安装与官方更新互斥，重复点击不会发起第二次安装', async t => {
  let done; const f = fixture(t, { wait: new Promise(resolve => { done = resolve; }) });
  const lease = claimUpdate(f.cacheDir, 'local');
  assert.throws(() => f.updater.start('1.1.0'), /另一个更新/); lease.release();
  f.updater.start('1.1.0'); assert.throws(() => f.updater.start('1.1.0'), /另一个更新/);
  const local = new PluginUpdates(f.service, f.manager, '1.0.0', { cacheDir: f.cacheDir });
  await assert.rejects(local.install(), /另一个更新/); done(); await f.updater.work;
  assert.equal(f.calls.length, 1);
});

test('同名 npm 包、其他 Git 仓库、浮动分支和本地来源不能进入官方 Git 更新', async t => {
  for (const source of ['^1.0.0', 'https://github.com/PerryLink/dsh-industry-research.git#' + 'a'.repeat(40), `${repository}#release`, 'link:C:/plugin']) {
    const f = fixture(t, { source }); assert.equal((await f.updater.snapshot()).eligible, false);
    f.updater.start('1.1.0'); await f.updater.work; assert.equal(f.calls.length, 0);
  }
  assert.equal(trustedGitSource('git+ssh://git@github.com/zaki-zeyi/dsh-industry-research.git#' + 'a'.repeat(40)), true);
});

test('拒绝运行版本降级，允许把宿主基础包同步到已运行的槽位版本', async t => {
  const newer = fixture(t, { runtime: '1.2.0' }); assert.equal((await newer.updater.snapshot()).candidateVersion, null);
  newer.updater.start('1.1.0'); await newer.updater.work; assert.equal(newer.calls.length, 0);
  const same = fixture(t, { runtime: '1.1.0' }); assert.equal((await same.updater.snapshot()).candidateVersion, '1.1.0');
  same.updater.start('1.1.0'); await same.updater.work; assert.equal(same.updater.record().state, 'updated');
});

test('重启要求、版本不符、健康未确认、宿主恢复分别报告真实结果', async t => {
  for (const [options, state] of [[{ restart: true }, 'restart-required'], [{ mismatch: true }, 'failed'], [{ unhealthy: true }, 'failed'], [{ failure: true }, 'restored']]) {
    const f = fixture(t, options); f.updater.start('1.1.0'); await f.updater.work;
    assert.equal(f.updater.record().state, state); assert.equal(f.service.updating, false);
  }
});

test('断网检查保留原版本；未完成的持久化操作在重新启动后显示中断', async t => {
  const f = fixture(t); f.updater.request = async () => { throw new Error('network offline'); };
  const status = await f.updater.check(); assert.match(status.error, /offline/); assert.equal(status.candidateVersion, null); assert.equal(f.calls.length, 0);
  writeFileSync(f.updater.file, JSON.stringify({ id: 'crash', state: 'removing', version: '1.1.0' }));
  assert.equal((await f.updater.snapshot()).operation.state, 'interrupted');
});

test('无法持久化安装意图时释放互斥状态且不调用宿主', t => {
  const f = fixture(t); f.updater.file = f.cacheDir;
  assert.throws(() => f.updater.start('1.1.0'));
  assert.equal(activeUpdate(f.cacheDir), undefined); assert.equal(f.calls.length, 0);
});
