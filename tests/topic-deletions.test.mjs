import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {startRuntime} from '../server/runtime.mjs';
import {mockHost} from './fixtures/fake-native-host.mjs';
import {topicTask,topicScope,topicFolderKey,topicDeletionKey,topicCards} from '../server/topics.mjs';
import {cloudPublications} from '../server/cloud-publications.mjs';
import {FeishuDirectories} from '../server/feishu-directories.mjs';
const id='11111111-1111-4111-8111-111111111111';
const folder=(name,token)=>({name,token,type:'folder'}),doc=(name,token)=>({name,token,type:'docx',url:'https://example.feishu.cn/docx/'+token});
async function fixture(){
 const dir=mkdtempSync(resolve(tmpdir(),'topic-delete-')),host=mockHost(),calls=[];
 const files={Root:[folder('专题调研','Topics'),folder('全量信息库','Library')],Topics:[folder('测试专题','Topic'),folder('其他专题','Other')],Topic:[doc('总报','Total'),folder('日报','Daily')],Daily:[doc('专题日报 · 测试专题 · 2026-11-16','Day')],Other:[doc('总报','OtherTotal')]};
 const state={mode:'sync',stopFails:false,reading:null};
 const trash=()=>{files.Topics=files.Topics.filter(f=>f.token!=='Topic');};
 const application={mode:'custom',appId:'cli_testapp',profile:'isolated',ownerOpenId:'ou_test'};
 const binding={applicationSnapshot:()=>application,requireBound:async()=>({openId:'ou_test'}),close(){},async json(args,app){
  assert.deepEqual(app,application);calls.push(args);
  if(args.includes('+delete')){
   const token=args[args.indexOf('--file-token')+1],type=args[args.indexOf('--type')+1];assert.equal(token,type==='folder'?'Topic':'Legacy');assert.ok(args.includes('--yes'));assert.ok(args.includes('user'));
   if(state.mode==='reject')throw new Error('private token must not leak');
   if(state.mode==='pending')return {ok:true,data:{task_id:'delete-job',ready:false,timed_out:true}};
   if(state.mode==='unknown')return {ok:true,data:{}};
   if(type==='folder')trash();else files.Topics=files.Topics.filter(f=>f.token!==token);return {ok:true,data:{deleted:true}};
  }
  if(args.includes('+task_result')){assert.equal(args[args.indexOf('--task-id')+1],'delete-job');trash();return {ok:true,data:{ready:true,status:'success'}};}
  throw new Error('unexpected command');
 }};
 host.schedule={async create(){throw new Error('no new schedules during deletion');},async delete({id:record}){calls.push(['stop',record]);if(state.stopFails)throw new Error('host failure');return {deleted:true};}};
 const run=async(command,args)=>{
  assert.equal(args[0],'--profile');const parent=args[args.indexOf('--folder-token')+1];
  if(state.reading)await state.reading;
  return {stdout:JSON.stringify({ok:true,data:{files:files[parent]??[],has_more:false}})};
 };
 const runtime=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding,publicationRun:run});
 const s=runtime.service;s.setFeishuSettings({folderUrl:'https://example.feishu.cn/drive/folder/Root'});
 const root=s.feishuSettings(),scope=topicScope(root,application);
 const task={...topicTask({question:'测试专题',sources:['官网'],topicId:id}),id:'task-total',status:'ready',createdAt:'2026-11-16T01:00:00Z',feishuRoot:root,feishuApp:application,publication:{status:'published',url:'https://example.feishu.cn/docx/Total'},runs:[]};s.store.save(task);
 s.store.saveSetting(topicFolderKey(task),{folderToken:'Topic',topicsFolderToken:'Topics',dailyFolderToken:'Daily'});
 s.store.saveSetting('topic-schedules',{[scope+':'+id]:{topicId:id,scope,time:'10:10',enabled:true,sessionId:'session-plan',record:{id:'schedule-plan'},research:{question:'测试专题',sources:['官网']}}});
 const preview=()=>runtime.service.topicDeletions.preview(id,scope);
 const body=p=>({scope,confirmation:p.confirmation,confirmed:true});
 return {runtime,s,task,scope,files,calls,state,run,preview,body,async close(){state.reading=null;await runtime.close();rmSync(dir,{recursive:true,force:true});}};
}
test('PRD519 确认后仅回收目标专题目录，先停止日报，刷新与重启不复活，旧任务不能重建',async()=>{
 const f=await fixture();try{
  const plan=await f.preview();const stale=await cloudPublications(f.s,'topic');assert.equal(plan.totalCount,1);assert.equal(plan.dailyCount,1);assert.deepEqual(plan.targets.map(t=>t.token),['Topic']);assert.equal(f.calls.length,0);
  const url=f.runtime.url+'/api/topics/'+id;
  let r=await fetch(url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({...f.body(plan),confirmed:false})});assert.equal(r.status,400);assert.equal(f.calls.length,0);
  r=await fetch(url,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.body(plan))});assert.equal(r.status,200);assert.equal((await r.json()).status,'deleted');
  assert.deepEqual(f.calls.map(a=>a[0]),['stop','drive']);assert.equal(f.files.Topics.length,1);assert.equal(f.files.Topics[0].token,'Other');assert.equal(f.s.topicSchedules.get(id).enabled,false);
  for(const suffix of ['','?refresh=true&force=true']){const list=await(await fetch(f.runtime.url+'/api/topics'+suffix)).json();assert.equal(list.items.some(t=>t.topic.topicId===id),false);assert.equal(list.items.length,1);}
  assert.equal(f.s.store.setting(topicDeletionKey(f.task.feishuRoot,f.task.feishuApp,id)).status,'deleted');
  const remoteOnly={...f.s,store:{list:()=>[],setting:key=>f.s.store.setting(key)},feishuSettings:()=>f.s.feishuSettings(),binding:f.s.binding};
  const aliased=stale.items.filter(t=>t.topicFolderToken==='Topic').map(t=>({...t,topic:{...t.topic,topicId:'99999999-9999-4999-8999-999999999999'}}));assert.equal(topicCards(remoteOnly,aliased).length,0);
  assert.throws(()=>f.s.retry(f.task.id,'research'),/已删除/);await assert.rejects(f.s.topicSchedules.trigger(id),/已删除/);
  await assert.rejects(f.s.topicSchedules.save(id,{time:'11:00',research:{question:'测试专题',sources:['官网']}}),/已删除/);
  await assert.rejects(f.s.createAuthorized(topicTask({question:'测试专题',sources:['官网'],topicId:id})),/已删除/);
  f.s.recover();assert.equal(f.s.queue.length,0);
  const repeat=await f.s.topicDeletions.remove(id,f.body(plan));assert.equal(repeat.status,'deleted');assert.equal(f.calls.filter(a=>a.includes('+delete')).length,1);
 }finally{await f.close();}
});
test('PRD519 拒绝账号/目录切换、内容变化和运行中专题，不调用删除',async()=>{
 const f=await fixture();try{
  const plan=await f.preview();
  await assert.rejects(f.s.topicDeletions.remove(id,{...f.body(plan),scope:'other-scope'}),/变化/);
  f.s.active.set(f.task.id,{});await assert.rejects(f.s.topicDeletions.remove(id,f.body(plan)),/正在执行/);f.s.active.clear();
  f.s.store.saveTerminal({id:'working-terminal',taskId:f.task.id,activity:'working'});f.s.store.save({...f.task,terminalId:'working-terminal'});
  await assert.rejects(f.s.topicDeletions.remove(id,f.body(plan)),/正在执行/);f.s.store.save({...f.task,terminalId:null});
  f.files.Daily.push(doc('专题日报 · 测试专题 · 2026-11-15','DayOld'));
  await assert.rejects(f.s.topicDeletions.remove(id,f.body(plan)),/内容已变化/);assert.equal(f.calls.length,0);
  f.state.stopFails=true;await assert.rejects(f.s.topicDeletions.remove(id,f.body(await f.preview())),/停止专题日报失败/);
  assert.equal(f.calls.some(a=>a.includes('+delete')),false);assert.equal(f.s.topicSchedules.get(id).enabled,true);assert.equal(f.s.store.setting(topicDeletionKey(f.task.feishuRoot,f.task.feishuApp,id)),null);
 }finally{await f.close();}
});
test('PRD519 异步删除先保留卡片和任务ID，重启后续查，不重复删除',async()=>{
 const f=await fixture();try{
  f.state.mode='pending';const plan=await f.preview();const result=await f.s.topicDeletions.remove(id,f.body(plan));assert.equal(result.status,'pending');
  const key=topicDeletionKey(f.task.feishuRoot,f.task.feishuApp,id);assert.equal(f.s.store.setting(key).targets[0].taskId,'delete-job');assert.equal(f.s.topicSchedules.get(id).enabled,false);
  const list=await(await fetch(f.runtime.url+'/api/topics')).json();assert.equal(list.items.find(t=>t.topic.topicId===id).deletion.status,'pending');
  // Replace the service object to simulate resuming from only persisted state.
  const {TopicDeletions}=await import('../server/topic-deletions.mjs');f.s.topicDeletions=new TopicDeletions(f.s,{publicationRun:f.run});
  const resumed=await f.preview();assert.equal(resumed.status,'pending');assert.equal(resumed.confirmation,plan.confirmation);
  assert.equal((await f.s.topicDeletions.remove(id,f.body(resumed))).status,'deleted');assert.equal(f.calls.filter(a=>a.includes('+delete')).length,1);assert.equal(f.calls.filter(a=>a.includes('+task_result')).length,1);
 }finally{await f.close();}
});
test('PRD519 未确认或权限异常不伪装删除成功，保留专题和已停日报，可重试',async()=>{
 const f=await fixture();try{
  const plan=await f.preview();f.state.mode='reject';await assert.rejects(f.s.topicDeletions.remove(id,f.body(plan)),e=>e.status===503&&!e.message.includes('private'));
  assert.equal(f.s.store.setting(topicDeletionKey(f.task.feishuRoot,f.task.feishuApp,id)).status,'pending');assert.equal(f.s.topicSchedules.get(id).enabled,false);
  assert.equal((await(await fetch(f.runtime.url+'/api/topics')).json()).items.length,2);
  f.state.mode='unknown';await assert.rejects(f.s.topicDeletions.remove(id,f.body(plan)),/尚未确认/);
  f.state.mode='sync';assert.equal((await f.s.topicDeletions.remove(id,f.body(plan))).status,'deleted');
 }finally{await f.close();}
});
test('PRD519 删除后同名新专题不使用已回收目录缓存',async()=>{
 const f=await fixture();try{
  const resolver=new FeishuDirectories(f.s.store,{command:'mock-cli',run:async()=>{throw new Error('should use proven token');}});
  assert.equal(await resolver.folder(f.task.feishuApp,'Topics','测试专题',undefined,'Topic'),'Topic');
  const plan=await f.preview();await f.s.topicDeletions.remove(id,f.body(plan));
  let listed=false;const newResolver=new FeishuDirectories(f.s.store,{run:async(_c,args)=>{listed=true;assert.ok(args.includes('list'));return {stdout:JSON.stringify({ok:true,data:{files:[folder('测试专题','NewTopic')],has_more:false}})};}});
  assert.equal(await newResolver.folder(f.task.feishuApp,'Topics','测试专题'),'NewTopic');assert.equal(listed,true);
 }finally{await f.close();}
});

test('PRD519 旧版平铺专题只回收对应文档，不删除共享父目录及其他报告',async()=>{
 const f=await fixture();try{
  f.files.Topics=[doc('旧版专题','Legacy'),doc('其他历史专题','OtherLegacy')];
  const legacy={...f.task,topic:{...f.task.topic,workflowVersion:undefined},publication:{status:'published',url:'https://example.feishu.cn/docx/Legacy'}};f.s.store.save(legacy);
  const plan=await f.preview();assert.deepEqual(plan.targets.map(t=>[t.type,t.token]),[['docx','Legacy']]);
  assert.equal((await f.s.topicDeletions.remove(id,f.body(plan))).status,'deleted');
  assert.deepEqual(f.files.Topics.map(t=>t.token),['OtherLegacy']);assert.equal(f.files.Root[0].token,'Topics');
 }finally{await f.close();}
});

test('PRD519 缺删除授权时先提示补充，尚未停止日报或修改飞书文件',async()=>{
 const f=await fixture();try{
  f.s.binding.requireBound=async()=>({bound:true,deletionReady:false});
  await assert.rejects(f.preview(),e=>e.status===428&&e.code==='FEISHU_DELETE_SCOPE_REQUIRED');
  assert.equal(f.calls.length,0);assert.equal(f.s.topicSchedules.get(id).enabled,true);
 }finally{await f.close();}
});
