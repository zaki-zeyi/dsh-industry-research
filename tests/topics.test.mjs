import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { topicDailyPrompt, withTopicTotalMerge } from '../server/topic-defaults.mjs';
import { topicTask, topicPrompt, rememberTopic, topicScope, topicDocumentKey, topicFolderKey, topicDailyDocumentKey, topicCards } from '../server/topics.mjs';
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
 assert.match(topicPrompt(input),/专题调研/);assert.match(topicPrompt(input),/调研依据/);
 assert.throws(()=>createSchema.parse({...t,industry:{companies:['A'],dimensions:['产品'],sources:['官网']}}));
 const p=cloudPrompt({...t,feishuApp:{},publication:{}},{deliveryPath:'/tmp/receipt',deliveryRequestId:id,writeClientPath:'/tmp/lock',writeConfigPath:'/tmp/config'});
 assert.match(p,/保存锁/);assert.match(p,/资料不足/);assert.match(p,/每期日报一个独立文档/);assert.match(p,/每日日报信息去重增量保存到【本专题调研】的总报/);assert.match(p,/禁止整篇替换/);assert.match(p,/两份文档都读回/);assert.equal(t.topic.totalMergeRequired,true);assert.match(p,/不存本地正文/);
});
test('FR05 专题交付保护目录和已有文档，保留部分成果',()=>{
 const values=new Map(),service={store:{setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v)}};
 const task={...topicTask({...input,topicId:id}),feishuRoot:{rootName:'研究',folderToken:'Root'},feishuApp:{appId:'app'}};
 rememberTopic(service,task,{status:'publishing',topicRootFolderToken:'Topics',topicFolderToken:'Topic',reportFolderToken:'Topic',url:'https://example.feishu.cn/docx/First'});
 assert.equal(values.get(topicDocumentKey(task)).url,'https://example.feishu.cn/docx/First');
 assert.throws(()=>rememberTopic(service,task,{status:'published',reportFolderToken:'Other'}));
 assert.throws(()=>rememberTopic(service,task,{status:'published',topicRootFolderToken:'Topics',topicFolderToken:'Topic',reportFolderToken:'Topic',url:'https://example.feishu.cn/docx/Duplicate'}));
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
test('PRD468 总报与两期日报分别保存，重试复用本期且拒绝覆盖',()=>{
 const values=new Map(),tasks=[],service={store:{setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v),list:()=>tasks}};
 const base={feishuRoot:{rootName:'研究',folderToken:'Root'},feishuApp:{appId:'App'}},receipt={status:'published',folderToken:'Root',topicRootFolderToken:'Topics',topicFolderToken:'Topic',topicDailyFolderToken:'Daily',topicTotalUrl:'https://example.feishu.cn/docx/Total'};
 const total={...topicTask({...input,topicId:id}),...base,id:'total',publication:{url:'https://example.feishu.cn/docx/Total'}};
 rememberTopic(service,total,{...receipt,reportFolderToken:'Topic',url:total.publication.url});tasks.push(total);
 const day1={...topicTask({...input,topicId:id},new Date('2026-11-15T01:00:00Z')),...base,id:'day1',publication:{url:'https://example.feishu.cn/docx/Day1'}};
 const day2={...topicTask({...input,topicId:id},new Date('2026-11-16T01:00:00Z')),...base,id:'day2',publication:{url:'https://example.feishu.cn/docx/Day2'}};
 rememberTopic(service,day1,{...receipt,reportFolderToken:'Daily',url:day1.publication.url});tasks.push(day1);
 rememberTopic(service,day2,{...receipt,reportFolderToken:'Daily',url:day2.publication.url});tasks.push(day2);
 assert.equal(values.get(topicDocumentKey(total)).url,total.publication.url);assert.equal(values.get(topicDailyDocumentKey(day1)).url,day1.publication.url);
 assert.throws(()=>rememberTopic(service,day2,{...receipt,reportFolderToken:'Daily',url:total.publication.url}));
 assert.throws(()=>rememberTopic(service,day2,{...receipt,reportFolderToken:'Topic',url:day2.publication.url}));
 rememberTopic(service,day2,{...receipt,reportFolderToken:'Daily',url:day2.publication.url});
 service.feishuSettings=()=>base.feishuRoot;service.binding={applicationSnapshot:()=>base.feishuApp};for(const t of tasks)t.createdAt='2026-11-15T00:00:00Z';
 const cards=topicCards(service,[]);assert.equal(cards.length,1);assert.equal(cards[0].totalReport.id,'total');assert.deepEqual(cards[0].dailyReports.map(t=>t.id),['day2','day1']);
});
test('PRD468 读取层级目录导入总报与所有日报，不将日报覆盖总报链接',async()=>{
 const {cloudPublications}=await import('../server/cloud-publications.mjs');
 const values=new Map(),files={Root:[{type:'folder',name:'专题调研',token:'Topics'}],Topics:[{type:'folder',name:'测试专题',token:'Topic'}],Topic:[{type:'docx',name:'总报',url:'https://example.feishu.cn/docx/Total'},{type:'folder',name:'日报',token:'Daily'}],Daily:[{type:'docx',name:'专题日报 · 测试专题 · 2026-11-14',url:'https://example.feishu.cn/docx/Day1'},{type:'docx',name:'专题日报 · 测试专题 · 2026-11-15',url:'https://example.feishu.cn/docx/Day2'}]};
 const service={cloudOnly:true,feishuSettings:()=>({rootName:'研究',folderToken:'Root'}),binding:{applicationSnapshot:()=>({})},store:{list:()=>[],setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v)}};
 const result=await cloudPublications(service,'topic',{refresh:true,run:async(c,args)=>({stdout:JSON.stringify({ok:true,data:{files:files[args[args.indexOf('--folder-token')+1]]??[],has_more:false}})})});
 const groups=topicCards(service,result.items);assert.equal(groups.length,1);assert.equal(groups[0].totalReport.publication.url,'https://example.feishu.cn/docx/Total');assert.equal(groups[0].dailyReports.length,2);
 assert.equal(groups[0].dailyReports[0].publication.url,'https://example.feishu.cn/docx/Day2');
 assert.equal(values.get(topicDocumentKey({...groups[0],feishuRoot:service.feishuSettings(),feishuApp:{}})).url,'https://example.feishu.cn/docx/Total');
});
test('PRD468 旧版日报作为总报保留，新总报可复用其链接',()=>{
 const old={id:'old',topic:{topicId:id,window:{start:'2026-11-01T16:00:00.000Z'}},feishuRoot:{rootName:'研究',folderToken:'Root'},feishuApp:{},publication:{url:'https://example.feishu.cn/docx/Legacy'}};
 const values=new Map(),service={store:{list:()=>[old],setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v)}};
 const current={...topicTask({...input,topicId:id}),id:'new',feishuRoot:old.feishuRoot,feishuApp:{}};
 values.set(topicDocumentKey(current),{url:old.publication.url});
 assert.doesNotThrow(()=>rememberTopic(service,current,{status:'published',reportFolderToken:'Topic',topicFolderToken:'Topic',topicRootFolderToken:'Topics',url:old.publication.url}));
});
test('专题日报使用新版官方 Schedule 请求，更新失败保留原任务且不再返回500',async()=>{
 const values=new Map(),records=new Map(),calls=[];let rejectSave=false;
 const service={store:{setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v),runtimeLog(){}},feishuSettings:()=>({rootName:'研究',folderToken:'Root'}),binding:{applicationSnapshot:()=>({}),requireBound:async()=>({})},nativeSessions:{createHostSession:async()=>({sessionId:'session-real'}),bindSession:async()=>{}},briefingSchedules:{endpointFile:'/tmp/endpoint'}};
 const host={sessionController:{resolveAgent:async()=>({agent:{session:{}}})},permissionPresets:{set(){}},schedule:{
  async create(request,actor){assert.equal(typeof request,'object');assert.equal(actor,'session-real');assert.deepEqual(request.target,{kind:'session',sessionId:'session-real'});assert.deepEqual(request.timing,{kind:'daily',daily:{time:'10:10:00',time_zone:'Asia/Shanghai'}});assert.ok(request.title.length<=120);const record={id:'official-task',...request};records.set(record.id,record);calls.push('create');return record;},
  async edit(request,actor){assert.equal(actor,'session-real');calls.push(request.action);if(rejectSave)throw new TypeError('host private details');const record={id:request.id,...request.patch};records.set(record.id,record);return record;}
 }};
 const plans=new TopicSchedules(service,host);
 const first=await plans.save(id,{time:'10:10',research:{...input,question:'很长的专题'.repeat(35)}});
 assert.equal(first.enabled,true);assert.equal(first.time,'10:10');assert.deepEqual(calls,['create']);
 rejectSave=true;await assert.rejects(plans.save(id,{time:'11:00',research:input}),e=>e.status===503&&!e.message.includes('private'));
 assert.equal(plans.get(id).time,'10:10');assert.equal(plans.get(id).enabled,true);assert.equal(plans.get(id).record.id,'official-task');
 rejectSave=false;await plans.save(id,{time:'11:00',research:input});assert.deepEqual(calls,['create','update','update']);assert.equal(plans.get(id).time,'11:00');assert.equal(records.size,1);
});

test('PRD497 日报必须确认总报合并，拒绝漏合并、换总报和总报日报同链，失败保留链接',()=>{
 const values=new Map(),tasks=[],service={store:{list:()=>tasks,setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v)},feishuSettings:()=>({rootName:'研究',folderToken:'Root'}),binding:{applicationSnapshot:()=>({})}};
 const task={...topicTask({...input,topicId:id},'2026-11-16T01:00:00Z'),id:'daily-first',createdAt:'2026-11-16T01:00:00Z',status:'ready',nativeSessionId:'session-daily',feishuRoot:service.feishuSettings(),feishuApp:{}};
 const receipt={status:'published',topicRootFolderToken:'Topics',topicFolderToken:'Topic',topicDailyFolderToken:'Daily',reportFolderToken:'Daily',url:'https://example.feishu.cn/docx/Day'};
 assert.throws(()=>rememberTopic(service,task,receipt),/尚未确认/);assert.equal(values.has(topicDailyDocumentKey(task)),false);
 assert.throws(()=>rememberTopic(service,task,{...receipt,topicTotalUrl:receipt.url}),/分别保存/);
 const totalUrl='https://example.feishu.cn/docx/Total';
 rememberTopic(service,task,{...receipt,status:'publishing',topicTotalUrl:totalUrl});
 assert.equal(values.get(topicDocumentKey(task)).url,totalUrl);assert.equal(values.get(topicDailyDocumentKey(task)).url,receipt.url);
 rememberTopic(service,task,{...receipt,status:'failed',topicTotalUrl:totalUrl,error:'总报读回失败'});
 assert.equal(values.get(topicDocumentKey(task)).url,totalUrl);
 assert.throws(()=>rememberTopic(service,task,{...receipt,topicTotalUrl:'https://example.feishu.cn/docx/NewTotal'}),/复用已有/);
 assert.equal(values.get(topicDocumentKey(task)).url,totalUrl);
 rememberTopic(service,task,{...receipt,topicTotalUrl:totalUrl});task.publication={...receipt,topicTotalUrl:totalUrl};tasks.push(task);
 const card=topicCards(service,[])[0];assert.equal(card.totalReport.publication.url,totalUrl);assert.equal(card.totalReport.nativeSessionId,'session-daily');assert.equal(card.totalReport.topic.window,undefined);assert.equal(card.dailyReports.length,1);assert.notEqual(card.dailyReports[0].publication.url,card.totalReport.publication.url);
 const next={...task,...topicTask({...input,topicId:id},'2026-11-17T01:00:00Z'),id:'daily-next'};
 assert.throws(()=>rememberTopic(service,next,{...receipt,url:totalUrl,topicTotalUrl:totalUrl}),/分别保存/);
});
test('PRD497 旧版自定义日报提示自动补充增量合并，不重复追加，不改手动总报',()=>{
 const custom='自定义研究要求：关注融资；不覆盖总报或其他日期的日报。';
 const upgraded=withTopicTotalMerge(custom);assert.match(upgraded,/自定义研究要求：关注融资/);assert.doesNotMatch(upgraded,/不覆盖总报/);assert.equal(withTopicTotalMerge(upgraded),upgraded);
 assert.match(topicDailyPrompt(input),/每日日报信息去重增量保存到【本专题调研】的总报/);
 const task=topicTask({...input,prompt:custom},'2026-11-16T01:00:00Z');
 const prompt=cloudPrompt({...task,feishuApp:{},publication:{}},{deliveryPath:'/tmp/receipt',deliveryRequestId:id});
 assert.match(prompt,/自定义研究要求：关注融资/);assert.doesNotMatch(prompt,/不覆盖总报或/);assert.match(prompt,/topicTotalUrl/);
 const manual=topicTask({...input,prompt:custom});assert.equal(manual.prompt,custom);assert.equal(manual.topic.totalMergeRequired,undefined);
 // Runs created before this update keep their original receipt contract on restart.
 delete task.topic.totalMergeRequired;
 const values=new Map(),service={store:{setting:k=>values.get(k),saveSetting:(k,v)=>values.set(k,v)}};
 assert.doesNotThrow(()=>rememberTopic(service,{...task,feishuRoot:{rootName:'研究',folderToken:'Root'},feishuApp:{}},{status:'published',topicRootFolderToken:'Topics',topicFolderToken:'Topic',topicDailyFolderToken:'Daily',reportFolderToken:'Daily',url:'https://example.feishu.cn/docx/OldDay'}));
});
