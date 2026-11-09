import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { larkLaunch } from './lark-launch.mjs';

// This file and the launcher are copied together. Resolve configuration relative
// to the script, while CLI input/output paths remain relative to the caller cwd.
const { command, args = [], managedFolders } = JSON.parse(readFileSync(new URL('./lark-agent-config.json', import.meta.url), 'utf8'));
const request = process.argv.slice(2);
const drive = request.indexOf('drive');
if (managedFolders && drive >= 0 && (request[drive+1] === '+create-folder' || request[drive+1] === 'files' && ['create_folder','create-folder'].includes(request[drive+2]))) {
  console.error(JSON.stringify({ok:false,error:{code:'PLATFORM_MANAGED_FOLDERS',message:'存储目录由平台在保存锁内统一解析，请使用保存锁返回的目录 ID，不得自行创建文件夹'}}));
  process.exit(1);
}
try {
  const launch = larkLaunch(command, [...args, ...process.argv.slice(2)]);
  const child = spawn(launch.command, launch.args, { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
  child.once('error', error => { console.error(JSON.stringify({ ok: false, error: { code: error.code === 'ENOENT' ? 'LARK_CLI_NOT_FOUND' : 'LARK_CLI_UNAVAILABLE', message: '飞书 CLI 无法启动，请回工作台检查飞书环境' } })); process.exitCode = 1; });
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
} catch {
  console.error(JSON.stringify({ ok: false, error: { code: 'LARK_CLI_NOT_FOUND', message: '未找到飞书 CLI，请回工作台安装或修复 CLI 后重试' } })); process.exitCode = 1;
}
