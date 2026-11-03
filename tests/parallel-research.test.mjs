import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {startRuntime} from '../server/runtime.mjs';
import {companyTaskInput,library} from '../server/industry.mjs';
import {mockHost} from './fixtures/fake-native-host.mjs';
import {until} from './helpers.mjs';
import {CloudWrites} from '../server/cloud-writes.mjs';

test('保存者取消但宿主未确认停止时，拒绝新写入；确认结束后可恢复',async()=>{
 const settings=new Map(),tasks=new Map(['a','b'].map(id=>[id,{id,terminalId:id,status:'running',feishuRoot:{rootName:'测试根目录'},feishuApp:{mode:'default'}}]));
 const metas=new Map(['a','b'].map(id=>[id,{deliveryRequestId:id,activity:'working'}]));
 const s={active:new Map(['a','b'].map(id=>[id,{controller:new AbortController()}])),require:id=>tasks.get(id),prepareCloudRoot(){},save(){},store:{setting:k=>settings.get(k),saveSetting:(k,v)=>settings.set(k,v),terminal:id=>metas.get(id)}};
 const writes=new CloudWrites(s);await writes.acquire('a','a');
 const waiting=writes.acquire('b','b');s.active.delete('a');writes.release('a');
 await assert.rejects(waiting,/尚未确认结束/);
 await assert.rejects(()=>new CloudWrites(s).acquire('b','b'),/尚未确认结束/);
 metas.get('a').activity='waiting_input';writes.release('a');
 assert.ok(await writes.acquire('b','b'));tasks.get('b').status='ready';writes.release('b');
});

test('PRD815 三会话并行检索，共用工作区；保存互斥并刷新索引，取消等待者不阻塞后续任务',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'parallel-research-')),host=mockHost();
 const f=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding:{requireBound:async()=>{},applicationSnapshot:()=>({mode:'default'}),close(){}}});
 const started=[],acquired=[],gates=new Map(),jobs=[];
 host.sessionController.prompt=async req=>{
   host.emit(req.sessionId,'turn/start');
   const task=f.service.store.list().find(t=>t.nativeSessionId===req.sessionId),meta=f.service.store.terminal(task.terminalId);
   started.push(task.id);
   const gate=new Promise(done=>gates.set(task.id,done));
   jobs.push((async()=>{
     try{
       const {stdout}=await promisify(execFile)(process.execPath,[meta.writeClientPath,meta.writeConfigPath]);
       acquired.push({id:task.id,snapshot:JSON.parse(stdout)});
       await gate;
       if(f.service.active.get(task.id)?.controller.signal.aborted)return;
       writeFileSync(meta.deliveryPath,JSON.stringify({requestId:meta.deliveryRequestId,status:'published',folderToken:'Root123',libraryFolderToken:'Library123',manifestUrl:'https://example.feishu.cn/docx/Manifest123',url:'https://example.feishu.cn/docx/Company123',companies:[{name:'后摩智能',url:'https://example.feishu.cn/docx/Company123',dimensions:task.industry.dimensions,added:1,conflicts:0}]}));
       host.emit(req.sessionId,'turn/end',{kind:'completed'});
     }catch(e){if(!f.service.closed&&f.service.require(task.id).status!=='interrupted'&&!f.service.active.get(task.id)?.controller.signal.aborted)throw e;}
   })());
   return {accepted:true};
 };
 try{
   const create=n=>f.service.createAuthorized(companyTaskInput({companies:['后摩智能'],dimensions:['维度'+n],sources:['测试信源'],requirements:''}));
   const tasks=await Promise.all([create(1),create(2),create(3)]);
   await until(()=>started.length===3&&acquired.length===1);
   assert.equal(f.service.active.size,3);
   assert.equal(new Set(host.calls.filter(c=>c.kind==='create').map(c=>c.cwd)).size,1);
   const first=acquired[0].id,waiting=tasks.filter(t=>t.id!==first);
   await until(()=>waiting.every(t=>f.service.require(t.id).stage==='waiting_save'));
   f.service.cancel(waiting[0].id);
   await until(()=>f.service.require(waiting[0].id).status==='interrupted');
   gates.get(first)();
   await until(()=>acquired.length===2);
   assert.equal(acquired[1].id,waiting[1].id);
   assert.equal(acquired[1].snapshot.industryLibrary.companies.length,1);
   assert.equal(acquired[1].snapshot.feishuRoot.folderToken,'Root123');
   gates.get(waiting[1].id)();
   await until(()=>f.service.require(waiting[1].id).status==='ready');
   const index=library(f.service.store,f.service.feishuSettings());
   assert.equal(index.companies.length,1);assert.equal(index.companies[0].dimensions.length,2);
   assert.equal(f.service.require(first).status,'ready');
   const bad=await fetch(f.url+'/api/tasks/'+first+'/write-lock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'00000000-0000-4000-8000-000000000000'})});assert.equal(bad.status,409);
 }finally{for(const done of gates.values())done();await f.close();await Promise.allSettled(jobs);rmSync(dir,{recursive:true,force:true});}
});
