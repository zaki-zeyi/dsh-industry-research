import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { repairLegacyScheduleReference } from '../scripts/repair-legacy-schedule-reference.mjs';
import { inject } from '../plugin/index.mjs';
import { BriefingSchedules } from '../server/briefings.mjs';

const ownPatch = '- insert:\n    - id: dsh-industry-research\n      name: dsh-industry-research\n';
test('安装包仅声明行研组件，不占用宿主共享服务且无调度时可加载', () => {
  assert.equal(readFileSync(new URL('../plugin/cordis.patch.yml', import.meta.url), 'utf8').replaceAll('\r\n', '\n').trim(), ownPatch.trim());
  assert.ok(!inject.includes('schedule'));
});
test('旧包声明修复有备份、可重复执行，不更改宿主配置', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'ownership-repair-'));
  try {
    mkdirSync(resolve(root, 'plugin'));
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ name: 'dsh-industry-research', dsh: { bundle: { patch: './plugin/cordis.patch.yml' } } }));
    const legacy = ownPatch + "\n- insert:\n    - id: schedule\n      name: '@deepseek-ai/dsh-schedule'\n";
    const file = resolve(root, 'plugin/cordis.patch.yml'); writeFileSync(file, legacy);
    const result = repairLegacyScheduleReference(root);
    assert.equal(readFileSync(result.backup, 'utf8'), legacy);
    assert.equal(readFileSync(file, 'utf8'), ownPatch);
    assert.equal(repairLegacyScheduleReference(root).alreadyClean, true);
    writeFileSync(file, legacy + '\n- id: unrelated\n  disabled: true\n');
    assert.throws(() => repairLegacyScheduleReference(root), /其他配置/);
    assert.equal(readFileSync(file, 'utf8'), legacy + '\n- id: unrelated\n  disabled: true\n');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('按需借用宿主调度：可用性跟随宿主，缺失时明确提示而不自行注册', async () => {
  let scheduler;
  const b = new BriefingSchedules({ store: { setting: () => null } }, { get: name => name === 'schedule' ? scheduler : undefined });
  assert.equal(b.get().available, false);
  await assert.rejects(b.commitOne({}), /未启用官方 Schedule/);
  scheduler = { create() {}, delete() {} };
  assert.equal(b.schedule, scheduler);
  assert.equal(b.get().available, true);
  scheduler = undefined;
  assert.equal(b.get().available, false);
});
