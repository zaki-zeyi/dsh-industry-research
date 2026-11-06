import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './helpers.mjs';
import {bindingBlockers,requireIdleBinding} from '../server/binding-blockers.mjs';
import {createApp} from '../server/app.mjs';

test('绑定阻塞任务去重，明确区分排队、调研、上传待确认和收尾，只返回展示信息',async()=>{
 const f=fixture();try{
  const tasks=[{id:randomUUID(),direction:'日报任务',briefing:{kind:'daily'},status:'failed',publication:{status:'publishing'},nativeSession:true,nativeSessionId:'native-1'},
   {id:randomUUID(),direction:'内部资料任务',internal:{source:'private-source'},status:'queued',publication:{}},
   {id:randomUUID(),direction:'公司调研',status:'ready',publication:{status:'published'}}];
  for(const t of tasks)f.store.save({...t,createdAt:new Date().toISOString(),prompt:'secret-must-not-leak'});
  f.service.queue.push({id:tasks[1].id});f.service.active.set(tasks[2].id,{});
  const items=bindingBlockers(f.service);assert.equal(items.length,3);
  assert.equal(items.find(t=>t.id===tasks[0].id).reason,'upload_pending');assert.equal(items.find(t=>t.id===tasks[0].id).canOpenSession,true);
  assert.equal(items.find(t=>t.id===tasks[1].id).reason,'queued');assert.equal(items.find(t=>t.id===tasks[2].id).reason,'finishing');
  assert.ok(!JSON.stringify(items).includes('private-source'));assert.ok(!JSON.stringify(items).includes('secret-must-not-leak'));
  assert.throws(()=>requireIdleBinding(f.service),e=>e.code==='FEISHU_TASKS_BUSY'&&e.message==='有调研或上传正在执行，请完成/停止后再重新绑定');
  f.service.queue=[];f.service.active.clear();for(const t of tasks)f.store.save({...t,status:'interrupted',publication:{status:'failed'},createdAt:new Date().toISOString()});
  assert.doesNotThrow(()=>requireIdleBinding(f.service));
 }finally{f.service.queue=[];f.service.active.clear();await f.close();}
});

test('绑定、应用登记和更换应用返回同一任务入口，不发起认证或重复创建会话',async()=>{
 const f=fixture(),id=randomUUID();let calls=0;
 f.service.binding={registration:{start(){calls++;return{status:'idle'};}},configureApplication:async()=>{calls++;},start:async()=>{calls++;}};
 f.store.save({id,direction:'日报 · 待完成上传',createdAt:new Date().toISOString(),status:'failed',briefing:{kind:'daily'},publication:{status:'publishing'},nativeSession:true,nativeSessionId:'native-test'});
 const server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 try{
  for(const [path,method,body] of [['/api/feishu-registration','POST',{}],['/api/feishu-binding','POST',{rebind:true}],['/api/feishu-application','PUT',{}]]){
   const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,409);const value=await r.json();
   assert.equal(value.code,'FEISHU_TASKS_BUSY');assert.equal(value.blockers[0].id,id);assert.equal(value.blockers[0].title,'日报 · 待完成上传');
  }
  assert.equal(calls,0);assert.equal(f.store.list().length,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});
