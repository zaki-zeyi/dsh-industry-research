import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { npmCommand } from './npm-command.mjs';
import { createDesktopZip } from './desktop-archive.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
function run(args) {
  const invocation = npmCommand(args);
  const r = spawnSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['inherit', 'pipe', 'inherit'] });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`npm ${args[0]} 失败`);
  return r.stdout;
}
process.stdout.write(run(['run', 'build']));
const stage = resolve(root, 'artifacts/package-stage');
rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { recursive: true });
try {
  for (const path of ['server', 'plugin', 'dist', 'scripts/prepare-pty.mjs', 'scripts/terminal-turn-notify.mjs']) cpSync(resolve(root, path), resolve(stage, path), { recursive: true });
  cpSync(resolve(root, 'docs'), resolve(stage, 'docs'), { recursive: true, filter: path => !path.includes('/screenshots') });
  cpSync(resolve(root, 'docs/plugin-install.md'), resolve(stage, 'README.md'));
  const source = JSON.parse(readFileSync(resolve(root, 'package.json')));
  const dependencies = Object.fromEntries(['express', 'ws', 'zod', 'node-pty', '@larksuiteoapi/node-sdk'].map(name => [name, source.dependencies[name]]));
  const manifest = { name: source.name, version: source.version, description: '行研工作台：适用于 DeepSeek Harness 桌面版和网页版的 公司全量信息库与宿主原生会话调研插件', type: 'module', main: source.main, engines: source.engines, exports: source.exports, dsh: source.dsh, dependencies, bundledDependencies: Object.keys(dependencies), files: ['plugin', 'server', 'dist', 'scripts', 'docs', 'README.md'] };
  writeFileSync(resolve(stage, 'package.json'), JSON.stringify(manifest, null, 2));
  // Copy the complete production dependency tree, including nested versions.
  function copyDependency(name, parentRoot, parentTarget = stage) {
    const req = createRequire(resolve(parentRoot, 'package.json'));
    let packageRoot;
    try { packageRoot = dirname(req.resolve(`${name}/package.json`)); } catch {
      packageRoot = dirname(req.resolve(name));
      while (!existsSync(resolve(packageRoot, 'package.json')) || JSON.parse(readFileSync(resolve(packageRoot, 'package.json'))).name !== name) {
        const parent = dirname(packageRoot); if (parent === packageRoot) throw new Error(`无法定位依赖 ${name}`); packageRoot = parent;
      }
    }
    const info = JSON.parse(readFileSync(resolve(packageRoot, 'package.json')));
    const globalTarget = resolve(stage, 'node_modules', name);
    let target = globalTarget;
    if (existsSync(resolve(target, 'package.json'))) {
      if (JSON.parse(readFileSync(resolve(target, 'package.json'))).version === info.version) return;
      target = resolve(parentTarget, 'node_modules', name);
      if (existsSync(resolve(target, 'package.json')) && JSON.parse(readFileSync(resolve(target, 'package.json'))).version === info.version) return;
    }
    cpSync(packageRoot, target, { recursive: true, filter: path => path !== resolve(packageRoot, 'node_modules') });
    for (const child of Object.keys(info.dependencies ?? {})) copyDependency(child, packageRoot, target);
  }
  for (const name of Object.keys(dependencies)) copyDependency(name, root);
  const result = JSON.parse(run(['pack', stage, '--json', '--pack-destination', resolve(root, 'artifacts')]));
  const packed = result[0];
  const archive = resolve(root, 'artifacts', packed.filename);
  const files = packed.files.map(file => file.path);
  for (const required of ['dist/index.html', 'plugin/index.mjs', 'node_modules/node-pty/lib/index.js', 'node_modules/express/index.js']) if (!files.includes(required)) throw new Error(`安装包缺少 ${required}`);
  for (const platform of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']) {
    const native = platform.startsWith('win32') ? 'conpty.node' : 'pty.node';
    if (!files.includes(`node_modules/node-pty/prebuilds/${platform}/${native}`)) throw new Error(`缺少 ${platform} 原生终端文件`);
  }
  if (files.some(path => path.length > 180)) throw new Error('依赖路径过深，可能超出 Windows 解压限制');
  if (files.some(path => /(^|\/)(\.env|research\.sqlite|\.runtime\.lock|ai-settings\.private\.json|\.ai-settings\.key)(\/|$)/.test(path) || path.startsWith('data/'))) throw new Error('安装包包含本机配置或业务数据');
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(`${archive}.sha256`, `${sha256}  ${packed.filename}\n`);
  const directory = `${manifest.name}-${manifest.version}`;
  const directoryPath = resolve(root, 'artifacts', directory);
  rmSync(directoryPath, { recursive: true, force: true }); mkdirSync(directoryPath, { recursive: true });
  cpSync(stage, directoryPath, { recursive: true });
  const zipFilename = `${directory}-desktop.zip`;
  createDesktopZip(directoryPath, resolve(root, 'artifacts', zipFilename));
  const zipSha256 = createHash('sha256').update(readFileSync(resolve(root, 'artifacts', zipFilename))).digest('hex');
  writeFileSync(resolve(root, 'artifacts', `${zipFilename}.sha256`), `${zipSha256}  ${zipFilename}\n`);
  writeFileSync(resolve(root, 'artifacts', 'desktop-install-path.txt'), `${directoryPath}\n`);
  writeFileSync(resolve(root, 'artifacts/plugin-release.json'), JSON.stringify({ name: manifest.name, version: manifest.version, filename: packed.filename, size: packed.size, sha256, bundled: packed.bundled, prdRevision: 797, prdSnapshot: 'docs/prd-lightweight-797.md', targets: ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'], directory, zipFilename, zipSha256 }, null, 2));
  console.log(`桌面弹窗填写：${directoryPath}\n桌面解压包：${zipFilename}\n安装包：${archive}\nSHA256：${sha256}`);
} finally { rmSync(stage, { recursive: true, force: true }); }
