import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { UpdateSlots } from '../plugin/update-slots.mjs';

function fixture(t, version = '0.13.9') {
  const root = mkdtempSync(join(tmpdir(), 'industry-slots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, 'source', 'package');
  mkdirSync(join(packageRoot, 'plugin'), { recursive: true });
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-industry-research', version }));
  writeFileSync(join(packageRoot, 'plugin', 'payload.mjs'), 'export const ready = true;\n');
  writeFileSync(join(packageRoot, 'dist', 'index.html'), '<html></html>');
  const archivePath = join(root, 'update.tgz');
  const packed = spawnSync('tar', ['-czf', archivePath, 'package'], { cwd: join(root, 'source'), encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const bytes = readFileSync(archivePath);
  return { root, archivePath, candidate: { version, archive: { version, size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex') } } };
}

test('完整包进独立槽位，重启后健康确认；旧版仍保留', async t => {
  const { root, archivePath, candidate } = fixture(t);
  const before = new UpdateSlots(root, '0.13.8');
  await before.schedule(archivePath, candidate);
  assert.equal(before.activeVersion, '0.13.8');
  assert.equal(before.state.pending.target.version, '0.13.9');
  assert.equal(existsSync(before.pathFor(before.state.pending.target)), true);
  const after = new UpdateSlots(root, '0.13.8');
  const mounted = [];
  await after.boot(async slot => { mounted.push(slot.version); return { version: slot.version }; });
  assert.deepEqual(mounted, ['0.13.9']);
  assert.equal(after.activeVersion, '0.13.9');
  assert.equal(after.state.previous.kind, 'base');
  assert.equal(after.state.pending, null);
  assert.equal((await after.waitForActivation()).state, 'updated');
  assert.ok(after.state.lastResult.healthDurationMs >= 0);
});

test('新版启动失败直接回到旧槽位，不需安装也不需网络', async t => {
  const { root, archivePath, candidate } = fixture(t);
  await new UpdateSlots(root, '0.13.8').schedule(archivePath, candidate);
  const after = new UpdateSlots(root, '0.13.8');
  const attempts = [];
  await after.boot(async slot => {
    attempts.push(slot.version);
    if (slot.kind === 'slot') throw new Error('健康检查失败');
    return { version: slot.version };
  });
  assert.deepEqual(attempts, ['0.13.9', '0.13.8']);
  assert.equal(after.activeVersion, '0.13.8');
  assert.equal(after.state.lastResult.state, 'restored');
  assert.ok(after.state.lastResult.healthDurationMs >= 0);
  assert.ok(after.state.lastResult.rollbackDurationMs >= 0);
  assert.equal(existsSync(after.pathFor({ kind: 'slot', version: candidate.version, sha256: candidate.archive.sha256 })), true);
});

test('缓存包被篡改不能安排切换，当前槽位不变', async t => {
  const { root, archivePath, candidate } = fixture(t);
  writeFileSync(archivePath, 'corrupt');
  const slots = new UpdateSlots(root, '0.13.8');
  await assert.rejects(slots.schedule(archivePath, candidate), /校验失败/);
  assert.equal(slots.state.pending, null);
  assert.equal(slots.activeVersion, '0.13.8');
});

test('确认槽位状态写入失败时先释放候选服务再启动旧版', async t => {
  const { root, archivePath, candidate } = fixture(t);
  await new UpdateSlots(root, '0.13.8').schedule(archivePath, candidate);
  const slots = new UpdateSlots(root, '0.13.8');
  const save = slots.save.bind(slots);
  let failed = false;
  slots.save = state => {
    if (!failed) { failed = true; throw new Error('disk failure'); }
    return save(state);
  };
  const events = [];
  await slots.boot(async slot => {
    events.push(`mount ${slot.version}`);
    return { dispose: async () => events.push(`dispose ${slot.version}`) };
  });
  assert.deepEqual(events, ['mount 0.13.9', 'dispose 0.13.9', 'mount 0.13.8']);
  assert.equal(slots.state.lastResult.state, 'restored');
});

test('槽位状态文件损坏时内置版本仍可启动', async t => {
  const { root } = fixture(t);
  mkdirSync(join(root, 'updates'), { recursive: true });
  writeFileSync(join(root, 'updates', 'slots.json'), '{broken');
  const slots = new UpdateSlots(root, '0.13.8');
  assert.equal(slots.state.lastResult.reason, 'state-corrupt');
  const mounted = [];
  await slots.boot(async slot => { mounted.push(slot.version); return {}; });
  assert.deepEqual(mounted, ['0.13.8']);
});

test('同一宿主连续热切两次，先完全卸载旧实例且每次独立确认', async t => {
  const one = fixture(t), two = fixture(t, '0.13.10');
  const slots = new UpdateSlots(one.root, '0.13.8');
  let owner = null;
  const events = [];
  await slots.boot(async slot => {
    assert.equal(owner, null, '同一时刻只有一个数据目录所有者');
    owner = slot.version; events.push(`mount ${slot.version}`);
    return { quiesce() { events.push(`pause ${slot.version}`); },
      async dispose() { await new Promise(resolve => setTimeout(resolve, 5)); events.push(`dispose ${slot.version}`); owner = null; },
      confirm() { events.push(`confirm ${slot.version}`); } };
  });
  t.after(() => slots.close());
  const first = slots.waitForActivation();
  assert.equal((await slots.activate(one.archivePath, one.candidate)).state, 'updated');
  assert.notEqual(first, slots.waitForActivation());
  assert.equal((await slots.waitForActivation()).version, '0.13.9');
  assert.equal((await slots.activate(two.archivePath, two.candidate)).version, '0.13.10');
  assert.equal(slots.activeVersion, '0.13.10');
  assert.equal(slots.state.previous.version, '0.13.9');
  assert.equal(slots.state.pending, null);
  assert.deepEqual(events, ['mount 0.13.8', 'confirm 0.13.8', 'pause 0.13.8', 'dispose 0.13.8',
    'mount 0.13.9', 'confirm 0.13.9', 'pause 0.13.9', 'dispose 0.13.9', 'mount 0.13.10', 'confirm 0.13.10']);
});

test('热切健康失败从本地恢复旧实例，失败版本不成为 active', async t => {
  const f = fixture(t), slots = new UpdateSlots(f.root, '0.13.8');
  const events = [];
  await slots.boot(async slot => {
    events.push(`mount ${slot.version}`);
    if (slot.kind === 'slot') throw new Error('health failed');
    return { dispose() { events.push('dispose old'); } };
  });
  t.after(() => slots.close());
  const result = await slots.activate(f.archivePath, f.candidate, { operationId: 'operation' });
  assert.equal(result.state, 'restored');
  assert.equal(slots.activeVersion, '0.13.8');
  assert.equal(slots.state.lastResult.operationId, 'operation');
  assert.deepEqual(events, ['mount 0.13.8', 'dispose old', 'mount 0.13.9', 'mount 0.13.8']);
});

test('任务未空闲时不卸载、不留下待激活更新，稍后可重试', async t => {
  const f = fixture(t), slots = new UpdateSlots(f.root, '0.13.8');
  let busy = true, disposals = 0;
  await slots.boot(async () => ({ quiesce() { if (busy) throw Object.assign(new Error('busy'), { code: 'WORKBENCH_BUSY' }); }, dispose() { disposals++; } }));
  t.after(() => slots.close());
  await assert.rejects(slots.activate(f.archivePath, f.candidate), { code: 'WORKBENCH_BUSY' });
  assert.equal(disposals, 0); assert.equal(slots.state.pending, null);
  busy = false;
  assert.equal((await slots.activate(f.archivePath, f.candidate)).state, 'updated');
});

test('卸载失败时禁止启动新版，避免重复写入者', async t => {
  const f = fixture(t), slots = new UpdateSlots(f.root, '0.13.8');
  let mounts = 0;
  await slots.boot(async () => { mounts++; return { dispose() { throw new Error('close failed'); } }; });
  await assert.rejects(slots.activate(f.archivePath, f.candidate), /close failed/);
  assert.equal(mounts, 1);
  assert.equal(slots.activeVersion, '0.13.8');
});

test('DSH 手动安装的新版本优先于旧业务槽位', async t => {
  const f = fixture(t);
  const before = new UpdateSlots(f.root, '0.13.8');
  await before.schedule(f.archivePath, f.candidate);
  await before.boot(async () => ({}));
  const after = new UpdateSlots(f.root, '0.13.10');
  const mounted = [];
  await after.boot(async slot => { mounted.push(slot.version); return {}; });
  assert.deepEqual(mounted, ['0.13.10']);
  assert.equal(after.state.active.kind, 'base');
  assert.equal(after.state.pending, null);
});
