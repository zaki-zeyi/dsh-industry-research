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
