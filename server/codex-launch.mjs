import { win32 } from 'node:path';
import { existsSync, statSync } from 'node:fs';

// ConPTY starts executables directly. Never pass npm's .cmd/.ps1 shim through a shell:
// prompts and paths must stay individual arguments, including spaces, &, and Unicode.
export function resolveCodexLaunch(command, args, { platform = process.platform, arch = process.arch, env = process.env, isFile = path => { try { return existsSync(path) && statSync(path).isFile(); } catch { return false; } } } = {}) {
  if (platform !== 'win32') return { command: command ?? 'codex', args };
  const requested = command ?? 'codex';
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path');
  const directories = (env[pathKey] ?? '').split(';').map(dir => dir.replace(/^"|"$/g, '')).filter(Boolean);
  const hasPath = /[\\/]/.test(requested) || win32.isAbsolute(requested);
  const candidates = hasPath ? [requested] : directories.flatMap(dir => /\.[a-z0-9]+$/i.test(requested) ? [win32.join(dir, requested)] : [win32.join(dir, `${requested}.exe`), win32.join(dir, `${requested}.cmd`), win32.join(dir, requested)]);
  if (!command && env.APPDATA) candidates.push(win32.join(env.APPDATA, 'npm/codex.cmd'));
  const executable = candidates.find(isFile);
  if (!executable) throw new Error(`找不到 ${requested}。请先安装并登录 Windows 原生 Codex CLI，或将插件 command 配置为 codex.exe 的绝对路径`);
  if (!/\.(cmd|bat|ps1)$/i.test(executable)) return { command: executable, args };
  if (!/^codex\.(cmd|bat|ps1)$/i.test(win32.basename(executable))) throw new Error('Windows 终端 command 需要可执行文件路径，不能直接使用批处理脚本');
  const triple = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[arch];
  if (!triple) throw new Error(`不支持的 Windows 架构：${arch}`);
  const npmRoot = win32.join(win32.dirname(executable), 'node_modules');
  const codexRoot = win32.join(npmRoot, '@openai/codex');
  const vendorRoots = [win32.join(codexRoot, `node_modules/@openai/codex-win32-${arch}/vendor`), win32.join(npmRoot, `@openai/codex-win32-${arch}/vendor`), win32.join(codexRoot, 'vendor')];
  const binary = vendorRoots.flatMap(root => ['bin', 'codex'].map(dir => win32.join(root, triple, dir, 'codex.exe'))).find(isFile);
  if (!binary) throw new Error('已找到 codex.cmd，但缺少匹配架构的 codex.exe；请重新安装 Codex，或将插件 command 配置为原生 codex.exe 的绝对路径');
  return { command: binary, args };
}
