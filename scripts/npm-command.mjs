import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export function npmCommand(args, { platform = process.platform, env = process.env, execPath = process.execPath, exists = existsSync } = {}) {
  if (platform !== 'win32') return { command: 'npm', args };
  const candidates = [env.npm_execpath, resolve(dirname(execPath), 'node_modules/npm/bin/npm-cli.js'), resolve(dirname(execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
  const cli = candidates.find(path => /\.[cm]?js$/i.test(path) && exists(path));
  if (!cli) throw new Error('找不到 npm-cli.js；请通过 npm run 执行此脚本，或安装完整 Node.js/npm');
  return { command: execPath, args: [cli, ...args] };
}
