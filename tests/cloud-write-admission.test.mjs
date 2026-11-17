import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {CloudWrites} from '../server/cloud-writes.mjs';
import {prepareLarkAgent} from '../server/lark-agent-files.mjs';
import {runLark} from '../server/lark-cli.mjs';
import {isReadOnlyLarkRequest} from '../server/lark-write-policy.mjs';
import {until} from './helpers.mjs';

function fixture(){
 const settings=new Map(),tasks=new Map(),metas=new Map();
 for(const id of ['a','b']){const terminalId=randomUUID(),requestId=randomUUID();tasks.set(id,{id,terminalId,status:'running',feishuRoot:{rootName:'测试根目录'},feishuApp:{mode:'default'}});metas.set(terminalId,{id:terminalId,taskId:id,deliveryRequestId:requestId,activity:'working'});}
 const service={active:new Map(['a','b'].map(id=>[id,{controller:new AbortController()}])),require:id=>tasks.get(id),prepareCloudRoot(){},save(){},store:{setting:k=>settings.get(k),saveSetting:(k,v)=>settings.set(k,v),terminal:id=>metas.get(id)}};
 return {service,tasks,metas,settings,writes:new CloudWrites(service),input(id){const terminalId=tasks.get(id).terminalId;return{terminalId,requestId:metas.get(terminalId).deliveryRequestId};}};
}

test('写入准入绑定轮次；在途命令阻止交接和重启后抢锁，完成后自动恢复',async()=>{
 const f=fixture(),a=f.input('a'),b=f.input('b');await f.writes.acquire('a',a.requestId);
 const operation=f.writes.operation('a',{...a,action:'begin'});
 assert.throws(()=>f.writes.operation('a',{...a,action:'begin'}),/正在执行/);
 assert.throws(()=>f.writes.operation('b',{...b,action:'begin'}),/权限已失效/);
 f.service.active.delete('a');f.metas.get(a.terminalId).activity='waiting_input';f.tasks.get('a').status='failed';f.writes.release('a');
 await assert.rejects(f.writes.acquire('b',b.requestId),/尚未结束/);
 await assert.rejects(new CloudWrites(f.service).acquire('b',b.requestId),/尚未结束/);
 assert.throws(()=>f.writes.operation('b',{...b,...operation,action:'finish'}),/不属于/);
 f.writes.operation('a',{...a,...operation,action:'finish'});
 await f.writes.acquire('b',b.requestId);
 assert.throws(()=>f.writes.operation('a',{...a,action:'begin'}),/权限已失效/);
});

test('只读策略不把未知命令或内容参数中的 get 误认为只读',()=>{
 for(const args of [['docs','+fetch','url'],['--profile','selected','drive','+list'],['skills','read','lark-doc'],['auth','status']])assert.equal(isReadOnlyLarkRequest(args),true);
 for(const args of [['docs','+create','--title','get'],['docs','+create','--content','--help'],['api','POST','--body','get'],['docs','+unknown','get'],['drive','files','delete'],['auth','login']])assert.equal(isReadOnlyLarkRequest(args),false);
});

test('正常在途保存时其他任务排队，完成确认后交接而不报错',async()=>{
 const f=fixture(),a=f.input('a'),b=f.input('b');await f.writes.acquire('a',a.requestId);
 const operation=f.writes.operation('a',{...a,action:'begin'});
 let acquired=false;const waiting=f.writes.acquire('b',b.requestId).then(()=>{acquired=true;});
 assert.equal(f.tasks.get('b').stage,'waiting_save');assert.equal(acquired,false);
 f.tasks.get('a').status='ready';f.writes.release('a');assert.equal(acquired,false);
 f.writes.operation('a',{...a,...operation,action:'finish'});await waiting;assert.equal(acquired,true);
});

test('原生Retry可在失败后的新turn重新申请锁；旧turn、取消任务不能恢复写权限',async()=>{
 const f=fixture(),t=f.tasks.get('a'),a=f.input('a'),meta=f.metas.get(a.terminalId);
 await f.writes.acquire('a',a.requestId);
 t.nativeSession=true;t.status='failed';t.runs=[{status:'failed',terminalId:a.terminalId,sessionId:'session',failedTurnSequence:1,endedAt:'2026-11-17T00:00:00Z'}];
 Object.assign(meta,{agent:'dsh-native',taskId:'a',sessionId:'session',turnSequence:1,lastTurnStartedAt:'2026-11-16T23:00:00Z'});f.service.active.delete('a');f.writes.release('a');
 await assert.rejects(f.writes.acquire('a',a.requestId),/已失效/);
 Object.assign(meta,{turnSequence:2,lastTurnStartedAt:'2026-11-17T00:01:00Z'});
 await f.writes.acquire('a',a.requestId);const op=f.writes.operation('a',{...a,action:'begin'});f.writes.operation('a',{...a,...op,action:'finish'});
 assert.ok([...f.settings.entries()].filter(([key])=>key.startsWith('cloud-write-pending:')).every(([,value])=>value===null),'原生重试的连续保存步骤之间不应被误判为旧会话待结束');
 t.status='interrupted';assert.throws(()=>f.writes.operation('a',{...a,action:'begin'}),/权限已失效/);
});

test('真实CLI子进程写入前校验权限、保留stdin，失败轮次不能执行；重试配置独立',async()=>{
 const f=fixture(),dir=mkdtempSync(resolve(tmpdir(),'write-admission-')),marker=resolve(dir,'executed');
 const server=createServer(async(req,res)=>{try{let body='';for await(const chunk of req)body+=chunk;res.setHeader('Content-Type','application/json');res.end(JSON.stringify(f.writes.operation('a',JSON.parse(body))));}catch(e){res.statusCode=e.status??500;res.end(JSON.stringify({error:e.message}));}});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  const endpointFile=resolve(dir,'endpoint.json');writeFileSync(endpointFile,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`}));
  const command=resolve(dir,'cli.mjs');writeFileSync(command,`import {writeFileSync} from 'node:fs';let input='';for await(const chunk of process.stdin)input+=chunk;writeFileSync(${JSON.stringify(marker)},input);await new Promise(r=>setTimeout(r,180));process.stdout.write(input);`);
  const a=f.input('a'),meta={id:a.terminalId,cwd:dir,workflow:'cloud-only',writeGuard:{...a,taskId:'a',endpointFile}};prepareLarkAgent(meta,command);
  await assert.rejects(runLark(meta.larkClientPath,['docs','+create'],{input:'正文'}),e=>/权限已失效/.test(e.stderr));assert.equal(existsSync(marker),false);
  await f.writes.acquire('a',a.requestId);
  const running=runLark(meta.larkClientPath,['docs','+create'],{input:'正文'});
  await until(()=>existsSync(marker));assert.equal(readFileSync(marker,'utf8'),'正文');
  f.service.active.delete('a');f.tasks.get('a').status='failed';f.metas.get(a.terminalId).activity='waiting_input';f.writes.release('a');
  await assert.rejects(f.writes.acquire('b',f.input('b').requestId),/尚未结束/);
  assert.equal((await running).stdout,'正文');await f.writes.acquire('b',f.input('b').requestId);
  const newer={...meta,id:randomUUID(),writeGuard:{...meta.writeGuard,requestId:randomUUID()}};prepareLarkAgent(newer,command);
  assert.notEqual(newer.larkClientPath,meta.larkClientPath);assert.equal(JSON.parse(readFileSync(resolve(meta.larkClientPath,'..','lark-agent-config.json'),'utf8')).writeGuard.requestId,a.requestId);
 }finally{await new Promise(done=>server.close(done));rmSync(dir,{recursive:true,force:true});}
});
