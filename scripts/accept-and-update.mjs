import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { npmCommand } from './npm-command.mjs';
const args = process.argv.slice(2), at = args.indexOf('--profile'), profile = at >= 0 ? args[at + 1] : 'desktop';
if (!/^[a-zA-Z0-9_-]+$/.test(profile ?? '')) throw new Error('无效的 profile');
const cwd = fileURLToPath(new URL('..', import.meta.url));
function run(command, args) { const result = spawnSync(command, args, { cwd, stdio: 'inherit' }); if (result.error || result.status !== 0) throw result.error ?? new Error('验收或安装失败，后续步骤已停止'); }
const acceptance = npmCommand(['run', 'acceptance']); run(acceptance.command, acceptance.args);
if (args.includes('--host-smoke')) run(process.execPath, ['scripts/native-host-acceptance.mjs', '--browser']);
const install = npmCommand(['run', 'plugin:install', '--', '--profile', profile]); run(install.command, install.args);
console.log(`PASS: 验收完成并已更新 ${profile} 插件。`);
