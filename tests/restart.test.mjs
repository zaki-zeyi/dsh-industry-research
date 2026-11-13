import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { until } from './helpers.mjs';

async function launch(dir) {
  const child=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,RESEARCH_MODE:'demo',PORT:'0',DATA_DIR:dir},stdio:['ignore','pipe','pipe']});child.stderr.resume();
  const base=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(new Error('服务启动超时')),5000);child.stdout.on('data',c=>{text+=c;const m=/http:\/\/127.0.0.1:\d+/.exec(text);if(m){clearTimeout(timer);resolve(m[0]);}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(new Error(`启动失败 ${code}`));});});
  return { child,base, async stop(signal='SIGTERM'){if(child.exitCode!==null||child.signalCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill(signal);await done;} };
}
test('AC-17 真实进程 SIGKILL 后重启：WAL 持久化草稿/会话，重试可完成',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'research-restart-'));let first,second;
  try {
    first=await launch(dir);const t=await (await fetch(`${first.base}/api/tasks`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({direction:'进程崩溃恢复验收'})})).json();
    await until(async()=>{const d=await (await fetch(`${first.base}/api/tasks/${t.id}`)).json();return d.task.draft&&d.task.status==='running';});
    await first.stop('SIGKILL');second=await launch(dir);
    const d=await (await fetch(`${second.base}/api/tasks/${t.id}`)).json();assert.equal(d.task.status,'interrupted');assert.ok(d.task.draft.length>30);assert.ok(d.events.some(e=>e.type==='assistant'));assert.equal(d.task.runs.length,1);
    const r=await fetch(`${second.base}/api/tasks/${t.id}/retry`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({stage:'research'})});assert.equal(r.status,202);
    await until(async()=>{const d=await (await fetch(`${second.base}/api/tasks/${t.id}`)).json();return d.task.publication.status==='published';});
    const done=await (await fetch(`${second.base}/api/tasks/${t.id}`)).json();assert.equal(done.task.runs.length,2);
  }finally{await first?.stop();await second?.stop();rmSync(dir,{recursive:true,force:true});}
});
