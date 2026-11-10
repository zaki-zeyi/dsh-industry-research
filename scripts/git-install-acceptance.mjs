import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const option = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const pnpm = option('--pnpm-cli') ?? process.env.DSH_PNPM_CLI;
if (!pnpm) throw new Error('请用 --pnpm-cli 指定 DSH 实际使用的 pnpm.mjs 路径');
const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
if (revision.status !== 0) throw new Error('本地 Git 验收需要已提交的源码');
const source = option('--source') ?? 'https://github.com/zaki-zeyi/dsh-industry-research';
const directory = mkdtempSync(resolve(tmpdir(), 'dsh-research-git-install-'));
function run(command, args, extra = {}) { const result = spawnSync(command, args, { cwd: directory, stdio: 'inherit', ...extra }); if (result.error || result.status !== 0) throw result.error ?? new Error(`Git安装验收失败：${result.status}`); }
try {
  writeFileSync(resolve(directory, 'package.json'), JSON.stringify({ name: 'dsh-github-install-test', private: true, dependencies: {} }));
  // Match the desktop profile's linker policy; do not approve scripts or reuse its package store.
  writeFileSync(resolve(directory, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
  run(process.execPath, [pnpm, 'add', source, '--store-dir', resolve(directory, 'store')]);
  const installed = resolve(directory, 'node_modules/dsh-industry-research');
  const manifest = JSON.parse(readFileSync(resolve(installed, 'package.json')));
  assert.equal(manifest.name, 'dsh-industry-research');
  assert.equal(manifest.version, option('--expected-version') ?? JSON.parse(readFileSync(resolve(root, 'package.json'))).version, 'GitHub install must match the release version');
  assert.equal(readFileSync(resolve(installed, 'dist/index.html'), 'utf8').includes('/assets/index-'), true);
  run(process.execPath, [resolve(root, 'scripts/plugin-acceptance.mjs'), '--package-root', installed]);
  const desktop = option('--desktop-runtime');
  if (desktop) run(desktop, ['--expose-internals', resolve(root, 'scripts/plugin-acceptance.mjs'), '--package-root', installed], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  console.log('PASS: 冷缓存 Git 依赖安装、预构建页面与运行时验收通过；未添加 allowBuilds 或降低宿主策略');
} finally { rmSync(directory, { recursive: true, force: true }); }
