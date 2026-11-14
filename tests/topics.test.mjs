import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { topicTask, topicPrompt, rememberTopic, topicScope, topicDocumentKey, topicFolderKey } from '../server/topics.mjs';
import { TopicSchedules } from '../server/topic-schedules.mjs';
import { cloudPrompt } from '../server/cloud-research.mjs';
import { startRuntime } from '../server/runtime.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { createSchema } from '../server/service.mjs';
const id='11111111-1111-4111-8111-111111111111',input={question:'中国推理芯片的市场机会有哪些？',sources:['公司官网'],requirements:'给出来源'};
test('FR05 配置校验、可编辑 Prompt、日报完整自然日及互斥任务类型',()=>{
 assert.throws(()=>topicTask({...input,question:''}));assert.throws(()=>topicTask({...input,sources:[]}));
 const t=topicTask({...input,topicId:id,prompt:'自定义任务，请特别关注产品性能'},new Date('2026-11-15T01:00:00Z'));
 assert.equal(t.topic.window.start,'2026-11-13T16:00:00.000Z');assert.equal(t.topic.topicId,id);assert.equal(t.prompt,'自定义任务，请特别关注产品性能');
 assert.match(topicPrompt(input),/专题调研库/);assert.match(topicPrompt(input),/调研依据/);
 assert.throws(()=>createSchema.parse({...t,industry:{companies:['A'],dimensions:['产品'],sources:['官网']}}));
 const p=cloudPrompt({...t,feishuApp:{},publication:{}},{deliveryPath:'/tmp/receipt',deliveryRequestId:id,writeClientPath:'/tmp/lock',writeConfigPath:'/tmp/config'});
 assert.match(p,/保存锁/);assert.match(p,/资料不足/);assert.match(p,/同一专题一个文档/);assert.match(p,/不存本地正文/);
});
test('FR05 专题交付保护目录和已有文档，保留部分成果',()=>{
 const values=new Map(),service={store:{setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v)}};
 const task={...topicTask({...input,topicId:id}),feishuRoot:{rootName:'研究',folderToken:'Root'},feishuApp:{appId:'app'}};
 rememberTopic(service,task,{status:'publishing',reportFolderToken:'Topic',url:'https://example.feishu.cn/docx/First'});
 assert.equal(values.get(topicDocumentKey(task)).url,'https://example.feishu.cn/docx/First');
 assert.throws(()=>rememberTopic(service,task,{status:'published',reportFolderToken:'Other'}));
 assert.throws(()=>rememberTopic(service,task,{status:'published',reportFolderToken:'Topic',url:'https://example.feishu.cn/docx/Duplicate'}));
 assert.throws(()=>rememberTopic(service,task,{status:'published'}));
 assert.notEqual(topicScope(task.feishuRoot,{ownerOpenId:'a'}),topicScope(task.feishuRoot,{ownerOpenId:'b'}));
 assert.equal(values.get(topicFolderKey(task)).folderToken,'Topic');
});
test('FR05 每专题独立官方日报、幂等、重启补发及目录切换隔离',async()=>{
 const values=new Map(),requests=new Map(),created=[],records=new Map();let root={rootName:'研究',folderToken:'Root'};
 const service={store:{setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v),request:k=>requests.get(k),runtimeLog(){}},feishuSettings:()=>root,binding:{applicationSnapshot:()=>({appId:'app'}),requireBound:async()=>({})},nativeSessions:{createHostSession:async()=>({sessionId:'session'}),bindSession:async()=>{}},briefingSchedules:{endpointFile:'/tmp/endpoint'},createAuthorized:async(t,key)=>{const task={...t,id:String(created.length)};created.push(task);requests.set(key,{task_id:task.id});return task;},require:id=>created.find(t=>t.id===id)};
 const host={sessionController:{resolveAgent:async()=>({agent:{session:{}}})},permissionPresets:{set(){}},schedule:{create:async(s,v)=>{const r={id:String(records.size),...v};records.set(r.id,r);return r;},delete:async({id})=>records.delete(id)}};
 const schedules=new TopicSchedules(service,host);
 await schedules.save(id,{time:'09:00',enabled:true,research:{...input,prompt:'调研 {{时间范围}} 内的最新进展'}});
 assert.equal([...records.values()][0].daily.time_zone,'Asia/Shanghai');assert.match([...records.values()][0].prompt,/scope/);
 const scope=schedules.scope();const plan=values.get('topic-schedules')[scope+':'+id];plan.activatedAt='2026-11-13T00:00:00Z';
 await schedules.catchUpMissed(Date.parse('2026-11-15T02:00:00Z'));await schedules.catchUpMissed(Date.parse('2026-11-15T02:00:00Z'));
 assert.equal(created.length,1);assert.match(created[0].prompt,/2026-11-14/);assert.equal(created[0].topic.topicId,id);
 const other='22222222-2222-4222-8222-222222222222';await schedules.save(other,{time:'10:00',enabled:true,research:{...input,question:'另一个专题'}});
 assert.equal(schedules.get(id).time,'09:00');assert.equal(schedules.get(other).time,'10:00');
 root={rootName:'其他目录',folderToken:'Other'};assert.equal(schedules.get(id).enabled,false);await assert.rejects(schedules.trigger(id,{scope}),/切换/);
});
test('FR05 API 缓存隔离、历史导入与提交请求幂等',async()=>{
 const dir=mkdtempSync(resolve(tmpdir(),'topic-api-')),host=mockHost();
 const runtime=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding:{requireBound:async()=>({openId:'ou_test'}),applicationSnapshot:()=>({}),close(){}},publicationRun:async(command,args)=>({stdout:JSON.stringify({ok:true,data:{files:args.includes('Root')?[{type:'folder',name:'专题调研库',token:'Topics'}]:[{type:'docx',name:'历史专题',url:'https://example.feishu.cn/docx/History',modified_time:'1794700000'}],has_more:false}})})});
 try{
  runtime.service.setFeishuSettings({folderUrl:'https://example.feishu.cn/drive/folder/Root'});
  const r=await fetch(runtime.url+'/api/topics?refresh=true');assert.equal(r.status,200);const list=await r.json();assert.equal(list.items[0].topic.question,'历史专题');assert.match(list.items[0].topic.topicId,/^[a-f0-9]{8}-0000-4000-8000-[a-f0-9]{12}$/);
  const request=()=>fetch(runtime.url+'/api/topics',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'topic-test'},body:JSON.stringify(input)});
  const first=await (await request()).json(),second=await (await request()).json();assert.equal(first.id,second.id);assert.ok(first.topic);
  runtime.service.setFeishuSettings({folderUrl:'https://example.feishu.cn/drive/folder/Else'});assert.equal((await (await fetch(runtime.url+'/api/topics')).json()).items.length,0);
 }finally{await runtime.close();rmSync(dir,{recursive:true,force:true});}
});
test('FR05 专题日报消息包含问题，通知幂等且失败保留报告',async()=>{
 const {BriefingNotifications}=await import('../server/briefing-notifications.mjs');
 const task={id,status:'ready',topic:{question:input.question,window:{display:'昨天'}},feishuApp:{appId:'cli_test',ownerOpenId:'ou_test'},notificationRecipient:'ou_test',publication:{status:'published',url:'https://example.feishu.cn/docx/Topic',noUpdates:true}};
 const sends=[];const service={require:()=>task,save(){},store:{runtimeLog(){}},binding:{applicationSnapshot:()=>({...task.feishuApp}),json:async(args)=>{
 if(args[0]==='auth')return {appId:'cli_test',identities:{user:{available:true,verified:true,openId:'ou_test'},bot:{available:true,verified:true}}};sends.push(args);return {ok:true};}}};
 const notifications=new BriefingNotifications(service);await Promise.all([notifications.send(id),notifications.send(id)]);await notifications.send(id);
 assert.equal(sends.length,1);assert.equal(task.notification.status,'sent');assert.match(sends[0][sends[0].indexOf('--text')+1],/中国推理芯片.*\n本日无更新/);
});
