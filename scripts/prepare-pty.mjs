import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { existsSync, statSync, chmodSync, readdirSync, mkdirSync, copyFileSync } from 'node:fs';
export function preparePty(root, { platform = process.platform, arch = process.arch } = {}) {
  if (platform === 'darwin') {
    for (const relative of [`prebuilds/darwin-${arch}/spawn-helper`, 'build/Release/spawn-helper', 'build/Debug/spawn-helper']) {
      const path = resolve(root, relative); if (existsSync(path)) chmodSync(path, statSync(path).mode | 0o111);
    }
  }
  if (platform === 'win32') {
    if (!['x64', 'arm64'].includes(arch)) throw new Error(`不支持的 Windows PTY 架构：${arch}`);
    const versions = resolve(root, 'third_party/conpty');
    const version = readdirSync(versions).sort().at(-1);
    for (const file of ['conpty.dll', 'OpenConsole.exe']) {
      const source = resolve(versions, version, `win10-${arch}`, file);
      for (const relative of ['build/Release/conpty', `prebuilds/win32-${arch}/conpty`]) {
        const target = resolve(root, relative, file); mkdirSync(dirname(target), { recursive: true });
        if (!existsSync(target) || statSync(target).size !== statSync(source).size) copyFileSync(source, target);
      }
    }
  }
}
if (['darwin', 'win32'].includes(process.platform)) preparePty(dirname(createRequire(import.meta.url).resolve('node-pty/package.json')));
