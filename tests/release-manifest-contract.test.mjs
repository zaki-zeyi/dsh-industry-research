import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { installationManifest } from '../scripts/plugin-manifest.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
test('源码 Git 安装解析生产依赖，预构建清单将相同依赖全部内置', () => {
  const { bundledDependencies, ...rest } = installationManifest(manifest);
  assert.deepEqual(rest, manifest);
  assert.deepEqual([...bundledDependencies].sort(), Object.keys(manifest.dependencies).sort());
  assert.ok(manifest.dependencies.express);
  assert.throws(() => installationManifest({ ...manifest, bundledDependencies }), /跳过依赖安装/);
  assert.throws(() => installationManifest({ ...manifest, bundleDependencies: true }), /跳过依赖安装/);
  for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'prepublishOnly', 'publish']) {
    assert.ok(!manifest.scripts?.[hook], `unsafe lifecycle hook: ${hook}`);
  }
  for (const dependency of ['react', 'react-dom', '@xterm/xterm', 'vite']) {
    assert.ok(manifest.devDependencies[dependency], `${dependency} is already bundled in dist`);
    assert.equal(manifest.dependencies[dependency], undefined);
  }
  assert.ok(!manifest.files.includes('scripts'));
  for (const name of ['prepare-pty.mjs', 'terminal-turn-notify.mjs', 'repair-legacy-schedule-reference.mjs']) assert.ok(manifest.files.includes(`scripts/${name}`));
});
