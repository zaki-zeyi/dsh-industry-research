import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { npmCommand } from './npm-command.mjs';
import { extractDesktopZip } from './desktop-archive.mjs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(root, 'artifacts/plugin-release.json'), 'utf8'));
assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'artifacts', manifest.filename))).digest('hex'), manifest.sha256, '发布包 SHA256 不匹配');
const temp = mkdtempSync(resolve(tmpdir(), 'research-release-'));
function run(command, args, env = process.env) {
  const invocation = command === 'npm' ? npmCommand(args) : { command, args };
  const result = spawnSync(invocation.command, invocation.args, { cwd: temp, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} 验收失败：${result.status}`);
}
try {
  // The temp installation is outside the repository, so missing dependencies cannot fall back to the development node_modules.
  run('npm', ['install', '--prefix', temp, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', resolve(root, 'artifacts', manifest.filename)]);
  const args = [resolve(root, 'scripts/plugin-acceptance.mjs'), '--package-root', resolve(temp, 'node_modules/dsh-industry-research')];
  run(process.execPath, args);
  const i = process.argv.indexOf('--desktop-runtime');
  if (i >= 0) run(resolve(process.argv[i + 1]), ['--expose-internals', ...args], { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(createHash('sha256').update(readFileSync(resolve(root, 'artifacts', manifest.zipFilename))).digest('hex'), manifest.zipSha256, '桌面 ZIP SHA256 不匹配');
  extractDesktopZip(resolve(root, 'artifacts', manifest.zipFilename), resolve(temp, 'desktop-zip'));
  const directoryArgs = [resolve(root, 'scripts/plugin-acceptance.mjs'), '--package-root', resolve(temp, 'desktop-zip', manifest.directory)];
  run(process.execPath, directoryArgs);
  if (i >= 0) run(resolve(process.argv[i + 1]), ['--expose-internals', ...directoryArgs], { ...process.env, ELECTRON_RUN_AS_NODE: '1' });
  console.log('PASS: 桌面 ZIP 校验、解压后独立目录的 Node / Electron 验收通过');
  console.log('PASS: 独立临时目录离线安装，无安装脚本；发布包验收完成');
} finally { rmSync(temp, { recursive: true, force: true }); }
