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

function guardedFixture(options){
 const f=fixture();
 for(const meta of f.metas.values())meta.writeGuard={leasePath:'required'};
 if(options)f.writes=new CloudWrites(f.service,options);
 const input=f.input;
 f.input=id=>({...input(id),get leaseId(){return [...f.writes.locks.values()].find(lock=>lock.owner===id&&lock.terminalId===f.tasks.get(id).terminalId)?.leaseId;}});
 return f;
}

for(const reason of ['执行失败','额度耗尽'])test(`${reason}且宿主结束事件丢失：撤销旧权限、自动交接排队者`,async()=>{
 const f=guardedFixture(),a=f.input('a'),b=f.input('b');await f.writes.acquire('a',a.requestId);
 const waiting=f.writes.acquire('b',b.requestId);
 f.tasks.get('a').status='failed';f.tasks.get('a').error=reason;
 f.writes.sweep();await waiting;
 assert.equal(f.metas.get(a.terminalId).activity,'working','无需伪造宿主结束事件');
 assert.equal([...f.writes.locks.values()][0].owner,'b');
 assert.throws(()=>f.writes.operation('a',{...a,action:'begin'}),/权限已失效/);
 await assert.rejects(f.writes.acquire('a',a.requestId),/轮次已失效/);
});

test('空闲锁超时自动释放；旧轮次不能重抢，新执行绑定需重新申请',async()=>{
 let now=0;const f=guardedFixture({now:()=>now,idleTimeoutMs:100}),a=f.input('a'),b=f.input('b');
 await f.writes.acquire('a',a.requestId);const waiting=f.writes.acquire('b',b.requestId);
 now=101;f.writes.sweep();await waiting;
 assert.throws(()=>f.writes.operation('a',{...a,action:'begin'}),/权限已失效/);
 await assert.rejects(f.writes.acquire('a',a.requestId),/轮次已失效/);
 const terminalId=randomUUID(),requestId=randomUUID();
 f.tasks.get('a').terminalId=terminalId;f.metas.set(terminalId,{id:terminalId,deliveryRequestId:requestId,activity:'working',writeGuard:{leasePath:'required'}});
 f.tasks.get('b').status='ready';f.writes.release('b');
 await f.writes.acquire('a',requestId);
 assert.doesNotThrow(()=>f.writes.operation('a',{...f.input('a'),action:'begin'}));
});

test('失败且过了超时时间仍不交出在途写入的锁；finish后自动交接',async()=>{
 let now=0;const f=guardedFixture({now:()=>now,idleTimeoutMs:100}),a=f.input('a'),b=f.input('b');
 await f.writes.acquire('a',a.requestId);const op=f.writes.operation('a',{...a,action:'begin'});
 let acquired=false;const waiting=f.writes.acquire('b',b.requestId).then(()=>{acquired=true;});
 f.tasks.get('a').status='failed';now=100000;f.writes.sweep();
 assert.equal(acquired,false);assert.equal([...f.writes.locks.values()][0].owner,'a');
 assert.throws(()=>f.writes.operation('a',{...a,action:'begin'}),/权限已失效/);
 await assert.rejects(new CloudWrites(f.service).acquire('b',b.requestId),/尚未结束/,'重启也不能丢掉在途记录');
 f.writes.operation('a',{...a,...op,action:'finish'});await waiting;assert.equal(acquired,true);
 f.writes.operation('a',{...a,...op,action:'finish'});
 assert.equal([...f.writes.locks.values()][0].owner,'b','迟到或重复finish不能释放新持有者');
});

test('正常的长写命令不算空闲，超过TTL后仍可继续同轮保存',async()=>{
 let now=0;const f=guardedFixture({now:()=>now,idleTimeoutMs:100}),a=f.input('a');
 await f.writes.acquire('a',a.requestId);const operation=f.writes.operation('a',{...a,action:'begin'});
 now=100000;f.writes.sweep();
 assert.equal([...f.writes.locks.values()][0].revoked,false);
 f.writes.operation('a',{...a,...operation,action:'finish'});
 assert.doesNotThrow(()=>f.writes.operation('a',{...a,action:'begin'}));
});

test('同绑定原生Retry必须重新获取新turn的锁；旧lease不能开始写入',async()=>{
 const f=guardedFixture(),t=f.tasks.get('a'),a=f.input('a'),meta=f.metas.get(a.terminalId);
 Object.assign(meta,{agent:'dsh-native',taskId:'a',sessionId:'session',turnSequence:1,lastTurnStartedAt:'2026-11-16T23:00:00Z',writeGuard:{leasePath:'required'}});
 const old=await f.writes.acquire('a',a.requestId);
 Object.assign(t,{nativeSession:true,status:'failed',runs:[{status:'failed',terminalId:a.terminalId,sessionId:'session',failedTurnSequence:1,endedAt:'2026-11-17T00:00:00Z'}]});
 f.service.active.delete('a');f.writes.release('a');
 Object.assign(meta,{turnSequence:2,lastTurnStartedAt:'2026-11-17T00:01:00Z'});
 assert.throws(()=>f.writes.operation('a',{...a,action:'begin',leaseId:old.leaseId}),/权限已失效/);
 const fresh=await f.writes.acquire('a',a.requestId);assert.notEqual(fresh.leaseId,old.leaseId);
 assert.throws(()=>f.writes.operation('a',{...a,action:'begin',leaseId:old.leaseId}),/权限已失效/);
 assert.doesNotThrow(()=>f.writes.operation('a',{...a,action:'begin',leaseId:fresh.leaseId}));
});

test('目录准备仍在执行时失败不交锁；准备退出后才释放',async()=>{
 const f=guardedFixture(),a=f.input('a'),b=f.input('b');let done;
 f.service.directories={prepare:()=>new Promise(resolve=>{done=resolve;})};
 const acquiring=f.writes.acquire('a',a.requestId);await until(()=>done);
 let acquired=false;const waiting=f.writes.acquire('b',b.requestId).then(()=>{acquired=true;});
 f.tasks.get('a').status='failed';f.writes.release('a');assert.equal(acquired,false);
 f.service.directories.prepare=async()=>{};done();
 await assert.rejects(acquiring,/轮次已失效/);await waiting;assert.equal(acquired,true);
});

test('重试切换应用/绑定：旧命令仍阻塞旧库，旧finish不能撤销新库的锁',async()=>{
 const f=guardedFixture(),t=f.tasks.get('a'),a=f.input('a'),b=f.input('b');
 await f.writes.acquire('a',a.requestId);const operation=f.writes.operation('a',{...a,action:'begin'});
 const oldKey=f.writes.operationKey(t),oldScope=[...f.writes.locks.keys()][0];
 t.status='failed';f.writes.release('a');
 const terminalId=randomUUID(),requestId=randomUUID();
 Object.assign(t,{terminalId,status:'running',feishuRoot:{rootName:'另一个资料库'}});
 f.metas.set(terminalId,{id:terminalId,deliveryRequestId:requestId,activity:'working',writeGuard:{leasePath:'required'}});
 await f.writes.acquire('a',requestId);
 assert.equal(f.writes.locks.get(oldScope).owner,'a');
 await assert.rejects(f.writes.acquire('b',b.requestId),/尚未结束/);
 f.writes.operation('a',{...a,...operation,action:'finish'});
 assert.equal(f.settings.get(oldKey).length,0);
 assert.equal(f.writes.locks.has(oldScope),false);
 assert.doesNotThrow(()=>f.writes.operation('a',{...f.input('a'),action:'begin'}));
 await f.writes.acquire('b',b.requestId);
});

test('真实写命令结束回报丢失：仅在子进程退出后的本地确认存在时回收，重启也能补偿',async()=>{
 const f=guardedFixture(),dir=mkdtempSync(resolve(tmpdir(),'write-completion-')),marker=resolve(dir,'started'),gate=resolve(dir,'finish');
 const a=f.input('a'),meta=f.metas.get(a.terminalId);
 const endpointFile=resolve(dir,'endpoint.json'),leasePath=resolve(dir,'lease.json');
 meta.writeGuard={...a,taskId:'a',endpointFile,leasePath,operationDirectory:dir};
 const server=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);
  if(input.action==='finish'){res.statusCode=503;res.end(JSON.stringify({error:'模拟结束回报丢失'}));return;}
  try{res.end(JSON.stringify(f.writes.operation('a',input)));}catch(e){res.statusCode=e.status??500;res.end(JSON.stringify({error:e.message}));}
 });await new Promise(done=>server.listen(0,'127.0.0.1',done));
 try{
  writeFileSync(endpointFile,JSON.stringify({url:`http://127.0.0.1:${server.address().port}`}));
  const command=resolve(dir,'cli.mjs');writeFileSync(command,`import {writeFileSync,existsSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');while(!existsSync(${JSON.stringify(gate)}))await new Promise(r=>setTimeout(r,10));`);
  const client={id:a.terminalId,cwd:dir,workflow:'cloud-only',writeGuard:meta.writeGuard};prepareLarkAgent(client,command);
  const lease=await f.writes.acquire('a',a.requestId);writeFileSync(leasePath,JSON.stringify({leaseId:lease.leaseId}));
  const running=assert.rejects(runLark(client.larkClientPath,['docs','+create']),e=>/结束确认失败/.test(e.stderr));
  await until(()=>existsSync(marker));f.tasks.get('a').status='failed';f.writes.sweep();
  await assert.rejects(f.writes.acquire('b',f.input('b').requestId),/尚未结束/);
  const operation=(f.settings.get(f.writes.operationKey(f.tasks.get('a'))))[0];
  assert.equal(existsSync(operation.completionPath),false,'子进程还活着，不得写结束确认');
  writeFileSync(gate,'done');await running;assert.equal(existsSync(operation.completionPath),true);
  // No in-memory ownership survives this simulated service restart.
  const restarted=new CloudWrites(f.service);await restarted.acquire('b',f.input('b').requestId);
  assert.equal(f.settings.get(restarted.operationKey(f.tasks.get('a'))).length,0);
  assert.equal(existsSync(operation.completionPath),false);
 }finally{writeFileSync(gate,'done');await new Promise(done=>server.close(done));rmSync(dir,{recursive:true,force:true});}
});

test('原生会话经真实HTTP/CLI：额度耗尽自动释放，旧启动器拒写，工作台重试重新申请后完成',async()=>{
 const {startRuntime}=await import('../server/runtime.mjs'),{mockHost}=await import('./fixtures/fake-native-host.mjs');
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const dir=mkdtempSync(resolve(tmpdir(),'native-lock-recovery-')),command=resolve(dir,'cli.mjs'),marker=resolve(dir,'writes');
 writeFileSync(command,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'write\\n');`);
 const host=mockHost(),f=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding:{command,requireBound:async()=>{},applicationSnapshot:()=>({mode:'default'}),close(){}}});
 f.service.setFeishuSettings({rootName:'验收目录',folderUrl:'https://tenant.feishu.cn/drive/folder/Root123'});
 let attempts=0,oldMeta;
 host.sessionController.prompt=async req=>{
  host.emit(req.sessionId,'turn/start');
  const task=f.service.store.list().find(t=>t.nativeSessionId===req.sessionId),meta=f.service.store.terminal(task.terminalId);
  await promisify(execFile)(process.execPath,[meta.writeClientPath,meta.writeConfigPath]);
  await runLark(meta.larkClientPath,['docs','+create']);
  if(++attempts===1){oldMeta=meta;writeFileSync(meta.deliveryPath,JSON.stringify({requestId:meta.deliveryRequestId,status:'failed',error:'额度耗尽'}));}
  else{writeFileSync(meta.deliveryPath,JSON.stringify({requestId:meta.deliveryRequestId,status:'published',folderToken:'Root123',url:'https://example.feishu.cn/docx/Retry123'}));host.emit(req.sessionId,'turn/end',{kind:'completed'});}
  return {accepted:true};
 };
 try{
  const task=await f.service.createAuthorized({direction:'保存异常回收验证'});
  await until(()=>f.service.require(task.id).status==='failed'&&!f.service.active.has(task.id));
  assert.equal(f.service.store.terminal(oldMeta.id).activity,'working');assert.equal(f.service.cloudWrites.locks.size,0);
  await assert.rejects(runLark(oldMeta.larkClientPath,['docs','+create']),e=>/权限已失效/.test(e.stderr));
  f.service.retry(task.id,'research');await until(()=>f.service.require(task.id).status==='ready');
  const done=f.service.require(task.id);assert.notEqual(done.terminalId,oldMeta.id);assert.equal(done.nativeSessionId,oldMeta.sessionId);
  assert.equal(readFileSync(marker,'utf8'),'write\nwrite\n');assert.equal(f.service.cloudWrites.locks.size,0);
 }finally{await f.close();rmSync(dir,{recursive:true,force:true});}
});
