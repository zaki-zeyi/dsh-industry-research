import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
const i = process.argv.indexOf('--profile');
const profile = i < 0 ? 'industry-research' : process.argv[i + 1];
if (!/^[a-zA-Z0-9_-]+$/.test(profile ?? '')) throw new Error('profile 无效');
const rootIndex = process.argv.indexOf('--package-root');
const packageRoot = rootIndex >= 0 ? resolve(process.argv[rootIndex + 1]) : resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'profiles', profile, 'node_modules/dsh-industry-research');
const requireInstalled = createRequire(resolve(packageRoot, 'package.json'));
const manifest = requireInstalled('./package.json');
for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublish', 'publish']) assert.ok(!manifest.scripts?.[hook], `插件不应执行安装生命周期脚本：${hook}`);
assert.ok(manifest.dsh?.bundle?.patch); assert.ok(manifest.dsh?.client);
const { connectRuntime } = await import(pathToFileURL(resolve(packageRoot, 'plugin/index.mjs')));
const dataDir = mkdtempSync(resolve(tmpdir(), 'installed-dsh-research-'));
let runtime;
try {
  runtime = await connectRuntime({ dataDir, port: 0, mode: 'demo' });
  assert.equal(runtime.owned, true);
  const page = await fetch(runtime.url); assert.equal(page.status, 200); assert.match(await page.text(), /\/assets\/index-/);
  const config = await (await fetch(`${runtime.url}/api/config`)).json(); assert.equal(config.terminalPermissions.sandbox, 'danger-full-access');
  const borrowed = await connectRuntime({ dataDir, port: Number(new URL(runtime.url).port) });
  assert.equal(borrowed.owned, false); await borrowed.close();
  const denied = await fetch(`${runtime.url}/api/tasks`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(denied.status, 403);
  // Exercise the native dependency from the installed package, without starting a paid model call.
  const pty = requireInstalled('node-pty');
  assert.equal(typeof requireInstalled('@larksuiteoapi/node-sdk').registerApp, 'function', '发布包缺少官方应用注册 SDK');
  await new Promise((done, reject) => {
    let output = '';
    const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'C:/Windows/System32/cmd.exe') : process.execPath;
    const commandArgs = process.platform === 'win32' ? ['/d', '/c', 'echo PLUGIN_PTY_OK'] : [...(process.versions.electron ? ['--expose-internals'] : []), '-e', 'process.stdout.write("PLUGIN_PTY_OK"); setTimeout(() => process.exit(0), 500)'];
    const proc = pty.spawn(executable, commandArgs, { cols: 80, rows: 24, cwd: dataDir, env: process.env });
    const timer = setTimeout(() => { proc.kill(); reject(new Error('安装包 PTY 验收超时')); }, 5000);
    proc.onData(data => { output += data; });
    proc.onExit(() => { clearTimeout(timer); try { assert.match(output, /PLUGIN_PTY_OK/); done(); } catch (e) { reject(e); } });
  });
  console.log(`PASS: 已安装 dsh-industry-research ${manifest.version}；页面、服务复用、权限、来源限制、原生 PTY 均通过`);
} finally { await runtime?.close(); rmSync(dataDir, { recursive: true, force: true }); }
// node-pty may retain a Windows worker MessagePort after its child exits.
// All assertions, runtime shutdown and cleanup have completed at this point.
// Explicitly finish this command-line acceptance process; thrown failures above
// still exit non-zero and cannot reach this line.
process.exit(0);
