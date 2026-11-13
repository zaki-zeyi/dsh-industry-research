import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { fixture } from './helpers.mjs';
import { FeishuBinding } from '../server/feishu-binding.mjs';

test('测试夹具销毁前导出脱敏埋点，不复制业务设置或原始CLI凭据', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'diagnostic-export-'));
  const previous = process.env.CI_ARTIFACT_DIR;
  process.env.CI_ARTIFACT_DIR = directory;
  const f = fixture();
  const binding = new FeishuBinding({ store: f.store, run: async () => { throw new Error('network failed SECRET_TOKEN'); } });
  try {
    f.store.saveSetting('private-business-data', { secret: 'PRIVATE_BUSINESS_VALUE' });
    await binding.status(); binding.close(); await f.close();
    const files = readdirSync(directory); assert.equal(files.length, 1);
    const text = readFileSync(resolve(directory, files[0]), 'utf8');
    assert.ok(JSON.parse(text).some(row => row.event === 'feishu.connection.failed'));
    assert.doesNotMatch(text, /SECRET_TOKEN|PRIVATE_BUSINESS_VALUE/);
  } finally {
    if (previous === undefined) delete process.env.CI_ARTIFACT_DIR; else process.env.CI_ARTIFACT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('CI日志封装保留失败退出码和输出，不把失败步骤报告为成功', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'diagnostic-exit-'));
  try {
    writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "console.error(\'EXPECTED_FAILURE\');process.exit(7)"' } }));
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/ci-check.mjs', import.meta.url)), 'test'], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 7);
    assert.match(readFileSync(resolve(directory, 'artifacts/diagnostics/test.log'), 'utf8'), /EXPECTED_FAILURE/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
