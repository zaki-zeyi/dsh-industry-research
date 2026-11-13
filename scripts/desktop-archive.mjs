import { zipSync, unzipSync } from 'fflate';
import { readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, join, basename, dirname, posix } from 'node:path';

export function createDesktopZip(directory, output) {
  const entries = {}, rootName = basename(directory);
  function visit(folder, relative = rootName) {
    for (const name of readdirSync(folder)) {
      const file = join(folder, name), entry = posix.join(relative, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`安装目录不允许符号链接：${entry}`);
      if (stat.isDirectory()) visit(file, entry);
      else entries[entry] = [new Uint8Array(readFileSync(file)), { attrs: ((stat.mode & 0xffff) << 16) >>> 0, os: 3 }];
    }
  }
  visit(directory); writeFileSync(output, zipSync(entries, { level: 6 }));
}
export function extractDesktopZip(archive, destination) {
  const entries = unzipSync(new Uint8Array(readFileSync(archive)));
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.startsWith('/') || name.includes('\\') || name.includes(':') || name.split('/').includes('..')) throw new Error(`ZIP 包含不安全路径：${name}`);
    const target = resolve(destination, name);
    if (name.endsWith('/')) mkdirSync(target, { recursive: true });
    else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
  }
  // ZIP extraction tools on Windows need no POSIX bits; macOS native helpers do.
  if (process.platform !== 'win32') for (const name of Object.keys(entries)) if (name.endsWith('/spawn-helper')) chmodSync(resolve(destination, name), 0o755);
}
