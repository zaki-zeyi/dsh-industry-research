import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { npmCommand } from './npm-command.mjs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const index = process.argv.indexOf('--profile');
const profile = index < 0 ? 'industry-research' : process.argv[index + 1];
if (!/^[a-zA-Z0-9_-]+$/.test(profile ?? '')) throw new Error('无效的 dsh profile 名称');
function run(command, args, capture = false) {
  const invocation = command === 'npm' ? npmCommand(args) : { command, args };
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8', stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit' });
  if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} 执行失败：${result.status}`);
  return result.stdout;
}
run('npm', ['run', 'plugin:pack']);
const packed = JSON.parse(readFileSync(resolve(root, 'artifacts/plugin-release.json'), 'utf8'));
const tarball = resolve(root, 'artifacts', packed.filename);
if (profile === 'desktop' && process.platform === 'win32') throw new Error(`Windows 请在桌面版“添加插件”中粘贴本地目录：${resolve(root, 'artifacts', packed.directory)}。不要使用全局 CLI 修改正在运行的桌面 profile`);
const cli = profile === 'desktop' && process.platform === 'darwin' ? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh' : 'dsh';
const profileExists = existsSync(resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'profiles', profile, 'package.json'));
if (!profileExists && profile === 'desktop') throw new Error('请先启动一次 DeepSeek Harness 桌面版，再完全退出后安装');
if (!profileExists) run(cli, ['--profile', profile, '--from-default-profile', 'web', '--help']);
run(cli, ['plugin', '--profile', profile, 'add', profile === 'desktop' ? resolve(root, 'artifacts', packed.directory) : tarball]);
// Replace the old package after the new package has been installed successfully.
const profileFile = resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'profiles', profile, 'package.json');
const installedProfile = JSON.parse(readFileSync(profileFile, 'utf8'));
if (installedProfile.dependencies?.['industry-research']) run(cli, ['plugin', '--profile', profile, 'remove', 'industry-research']);
if (profile === 'desktop') { console.log('安装完成。桌面版已更新到新插件目录；若宿主未自动重载，请重新打开 DeepSeek Harness。点击侧栏“行研工作台”，新任务使用宿主原生会话。'); process.exit(0); }
// Keep local paths and model selection outside the distributable package. Never copy credentials.
const localEnv = (existsSync(resolve(root, '.env')) ? readFileSync(resolve(root, '.env'), 'utf8') : '').match(/^CODEX_MODEL=(.*)$/m)?.[1]?.trim();
const patch = resolve(root, 'artifacts', `dsh-${profile}.yml`);
writeFileSync(patch, JSON.stringify([{ id: 'dsh-industry-research', config: { dataDir: resolve(root, 'data'), port: 3088, mode: 'codex', ...(localEnv ? { model: localEnv } : {}) } }], null, 2));
console.log(`\n安装完成。启动：dsh --profile ${profile} --patch ${JSON.stringify(patch)} --no-open --port 3090`);
