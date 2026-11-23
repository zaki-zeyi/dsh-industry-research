import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { larkLaunch } from './lark-launch.mjs';
import { isReadOnlyLarkRequest } from './lark-write-policy.mjs';

// This file and the launcher are copied together. Resolve configuration relative
// to the script, while CLI input/output paths remain relative to the caller cwd.
const { command, args = [], managedFolders, platformWrites, writeGuard } = JSON.parse(readFileSync(new URL('./lark-agent-config.json', import.meta.url), 'utf8'));
const request = process.argv.slice(2);
const drive = request.indexOf('drive');
if (managedFolders && drive >= 0 && (request[drive+1] === '+create-folder' || request[drive+1] === 'files' && ['create_folder','create-folder'].includes(request[drive+2]))) {
  console.error(JSON.stringify({ok:false,error:{code:'PLATFORM_MANAGED_FOLDERS',message:'存储目录由平台在保存锁内统一解析，请使用保存锁返回的目录 ID，不得自行创建文件夹'}}));
  process.exit(1);
}
// Only documented read verbs bypass admission. Unknown commands fail closed.
const readOnly = isReadOnlyLarkRequest(request);
if (platformWrites && !readOnly) {
  console.error('本轮飞书写入由工作台执行，请通过保存提交命令交付增量。');
  process.exit(1);
}
let leaseId;
async function guard(action, operationId) {
  const {url}=JSON.parse(readFileSync(writeGuard.endpointFile,'utf8'));
  const response=await fetch(url+'/api/tasks/'+writeGuard.taskId+'/write-operation',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:writeGuard.requestId,terminalId:writeGuard.terminalId,action,operationId,leaseId}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();if(!response.ok)throw new Error(value.error??'保存权限已失效');return value;
}
let operationId;
try {
  if(writeGuard&&!readOnly){
    if(writeGuard.leasePath)leaseId=JSON.parse(readFileSync(writeGuard.leasePath,'utf8')).leaseId;
    operationId=randomUUID();await guard('begin',operationId);
  }
  const launch = larkLaunch(command, [...args, ...process.argv.slice(2)]);
  const child = spawn(launch.command, launch.args, { stdio: 'inherit', windowsHide: true,
    env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' } });
  await new Promise(resolve=>{
    child.once('error', error => { console.error(JSON.stringify({ ok: false, error: { code: error.code === 'ENOENT' ? 'LARK_CLI_NOT_FOUND' : 'LARK_CLI_UNAVAILABLE', message: '飞书 CLI 无法启动，请回工作台检查飞书环境' } })); process.exitCode = 1; });
    child.once('close', (code, signal) => { process.exitCode = process.exitCode || code || (signal ? 1 : 0); resolve(); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  });
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: { code: 'LARK_WRITE_REJECTED', message: error.message } })); process.exitCode = 1;
} finally {
  // This receipt is written only after the child has exited (or was never
  // started). A lost HTTP finish response must not leave a permanent busy flag.
  // A killed wrapper without this proof remains blocked; elapsed time alone
  // cannot prove an already-started remote mutation has stopped.
  if(operationId&&writeGuard.operationDirectory){
    try{
      const target=resolve(writeGuard.operationDirectory,operationId+'.json'),temporary=target+'.tmp';
      writeFileSync(temporary,JSON.stringify({operationId,terminalId:writeGuard.terminalId,requestId:writeGuard.requestId}));renameSync(temporary,target);
    }catch{console.error('写入结束记录失败，请在工作台核对保存状态');}
  }
  if(operationId)try{await guard('finish',operationId);}catch{console.error('写入结束确认失败，请在工作台核对保存状态');process.exitCode=1;}
}
