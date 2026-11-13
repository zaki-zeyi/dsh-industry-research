import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, win32 } from 'node:path';
import { resolveCodexLaunch } from '../server/codex-launch.mjs';
import { larkLaunch } from '../server/lark-launch.mjs';
import { preparePty } from '../scripts/prepare-pty.mjs';
import { createDesktopZip, extractDesktopZip } from '../scripts/desktop-archive.mjs';
import { npmCommand } from '../scripts/npm-command.mjs';

function fixture(t) { const dir = mkdtempSync(resolve(tmpdir(), 'research-platform-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function windows(files, options = {}) { return { platform: 'win32', arch: 'x64', env: { Path: 'C:\\工具 & 程序\\npm' }, isFile: path => files.includes(path), ...options }; }
test('Windows PATH 原生 exe 保持参数边界，空格/中文/& 不经过 shell', () => {
  const file = 'C:\\工具 & 程序\\npm\\codex.exe', args = ['--cd', 'C:\\我的报告 & 资料', '不要重新调研'];
  assert.deepEqual(resolveCodexLaunch(undefined, args, windows([file])), { command: file, args });
});
test('Windows npm cmd 自动定位匹配架构的官方原生 exe', () => {
  for (const arch of ['x64', 'arm64']) {
    const shim = 'C:\\工具 & 程序\\npm\\codex.cmd';
    const triple = arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc';
    const exe = `C:\\工具 & 程序\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-${arch}\\vendor\\${triple}\\bin\\codex.exe`;
    assert.equal(resolveCodexLaunch(undefined, ['--search'], windows([shim, exe], { arch })).command, exe);
  }
});
test('Windows 支持旧 vendor 布局；缺失 binary 拒绝静默执行 cmd', () => {
  const shim = 'C:\\工具 & 程序\\npm\\codex.cmd', exe = 'C:\\工具 & 程序\\npm\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe';
  assert.equal(resolveCodexLaunch(shim, [], windows([shim, exe])).command, exe);
  assert.throws(() => resolveCodexLaunch(shim, [], windows([shim])), /缺少匹配架构/);
  assert.throws(() => resolveCodexLaunch(undefined, [], windows([])), /找不到/);
});
test('macOS 和显式 Windows exe 保留原有启动方式', () => {
  const args = ['--no-alt-screen']; assert.deepEqual(resolveCodexLaunch('/opt/bin/codex', args, { platform: 'darwin' }), { command: '/opt/bin/codex', args });
  const exe = 'D:\\Codex工具\\codex.exe'; assert.equal(resolveCodexLaunch(exe, args, windows([exe])).command, exe);
});
test('Windows 飞书 CLI 即使不在 PATH 也能从用户目录找到原生 exe', () => {
  const home = 'C:\\Users\\测试用户', exe = win32.resolve(home, '.local/bin/lark-cli.exe');
  assert.deepEqual(larkLaunch('lark-cli', ['profile', 'list'], { platform: 'win32', env: { Path: 'C:\\Windows' }, home, isFile: path => path === exe, resolvePath: win32.resolve }), { command: exe, args: ['profile', 'list'] });
});
test('Windows 显式无扩展飞书 CLI 路径自动补全 exe', () => {
  const command = 'D:\\工具 & 程序\\lark-cli', exe = command + '.exe';
  assert.deepEqual(larkLaunch(command, ['doctor'], { platform: 'win32', env: {}, home: 'C:\\Users\\测试用户', isFile: path => path === exe, resolvePath: win32.resolve }), { command: exe, args: ['doctor'] });
});
test('Windows 飞书 CLI 缺失时明确拒绝启动', () => {
  assert.throws(() => larkLaunch('lark-cli', [], { platform: 'win32', env: {}, home: 'C:\\Users\\测试用户', isFile: () => false, resolvePath: win32.resolve }), /找不到 Lark CLI/);
});
test('Windows 无安装脚本时准备 x64/arm64 ConPTY DLL，重复执行安全', t => {
  const root = fixture(t);
  for (const arch of ['x64', 'arm64']) {
    const source = resolve(root, 'third_party/conpty/1.23', `win10-${arch}`); mkdirSync(source, { recursive: true });
    for (const file of ['conpty.dll', 'OpenConsole.exe']) writeFileSync(resolve(source, file), `${arch}-${file}`);
    preparePty(root, { platform: 'win32', arch }); preparePty(root, { platform: 'win32', arch });
    assert.equal(readFileSync(resolve(root, `prebuilds/win32-${arch}/conpty/conpty.dll`), 'utf8'), `${arch}-conpty.dll`);
    assert.ok(existsSync(resolve(root, 'build/Release/conpty/OpenConsole.exe')));
  }
});
test('Windows npm 命令使用 Node + npm-cli.js，避免 .cmd 与 shell', () => {
  const command = npmCommand(['pack', 'D:\\项目 & 包'], { platform: 'win32', env: { npm_execpath: 'C:\\npm\\npm-cli.js' }, execPath: 'C:\\node.exe', exists: () => true });
  assert.deepEqual(command, { command: 'C:\\node.exe', args: ['C:\\npm\\npm-cli.js', 'pack', 'D:\\项目 & 包'] });
});
test('桌面 ZIP 无外部命令依赖，支持含中文与空格的安装目录', t => {
  const root = fixture(t), source = resolve(root, '插件 & 空格'); mkdirSync(resolve(source, 'plugin'), { recursive: true });
  writeFileSync(resolve(source, 'package.json'), '{"name":"dsh-industry-research"}'); writeFileSync(resolve(source, 'plugin/入口.js'), '完整内容');
  const zip = resolve(root, 'desktop.zip'); createDesktopZip(source, zip); extractDesktopZip(zip, resolve(root, '解压目录'));
  assert.equal(readFileSync(resolve(root, '解压目录/插件 & 空格/plugin/入口.js'), 'utf8'), '完整内容');
});
