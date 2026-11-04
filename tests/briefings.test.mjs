import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {reportWindow,briefingTask,BriefingSchedules,scheduleTiming} from '../server/briefings.mjs';
import {startRuntime} from '../server/runtime.mjs';
import {mockHost} from './fixtures/fake-native-host.mjs';
import {until} from './helpers.mjs';
const input={kind:'daily',companies:['后摩智能'],dimensions:['融资'],sources:['公司官网'],requirements:''};
test('FR02 北京时间完整自然日：跨年、闰月、UTC日界、前七个完整自然日',()=>{
 assert.deepEqual(reportWindow('daily',new Date('2026-12-31T16:00:00Z')).start,'2026-12-30T16:00:00.000Z');
 assert.equal(reportWindow('weekly',new Date('2026-11-03T01:00:00Z')).start,'2026-10-26T16:00:00.000Z');
 assert.equal(reportWindow('daily',new Date('2024-03-01T01:00:00Z')).display,'2024-02-29 00:00 至 2024-02-29 23:59（北京时间）');
 assert.equal(reportWindow('weekly',new Date('2026-11-08T15:59:59Z')).end,'2026-11-07T16:00:00.000Z');
 assert.equal(reportWindow('weekly',new Date('2027-01-01T01:00:00Z')).display,'2026-12-25 00:00 至 2026-12-31 23:59（北京时间）');
 assert.equal(reportWindow('weekly',new Date('2026-11-06T01:00:00Z')).display,'2026-10-30 00:00 至 2026-11-05 23:59（北京时间）');
 assert.throws(()=>briefingTask({...input,kind:'research'}));assert.throws(()=>briefingTask({...input,companies:[]}));
});
test('FR02 定时任务显示下一次执行；当天时间已过时不补跑',()=>{
 const before=Date.parse('2026-11-04T00:30:00Z'),after=Date.parse('2026-11-04T01:30:00Z');
 assert.deepEqual(scheduleTiming({kind:'daily',time:'09:00',weekday:5},before),{nextRunAt:'2026-11-04T01:00:00.000Z',todayTimePassed:false});
 assert.deepEqual(scheduleTiming({kind:'daily',time:'09:00',weekday:5},after),{nextRunAt:'2026-11-05T01:00:00.000Z',todayTimePassed:true});
 assert.deepEqual(scheduleTiming({kind:'weekly',time:'09:00',weekday:5},Date.parse('2026-11-06T01:30:00Z')),{nextRunAt:'2026-11-13T01:00:00.000Z',todayTimePassed:true});
});
async function setup(updated=false,receiptExtras={}){
 const dir=mkdtempSync(resolve(tmpdir(),'briefings-')),host=mockHost();const records=new Map();
 host.schedule={async create(sessionId,v){const r={...v,id:'schedule-'+records.size};records.set(r.id,{sessionId,...r});return r;},async delete({id}){records.delete(id);return {deleted:true};}};
 const messages=[];let failNotice=false;
  const f=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding:{requireBound:async()=>({openId:'ou_fixture',appId:'cli_fixture'}),json:async(args,app)=>{if(args[0]==='auth')return{appId:'cli_fixture',identities:{bot:{status:'ready',available:true,verified:true},user:{openId:'ou_fixture',available:true}}};if(failNotice)throw new Error('fixture denied');messages.push({args,app});return{ok:true,data:{message_id:'om_fixture'}};},applicationSnapshot:()=>({mode:'default'}),close(){}}});
 host.sessionController.prompt=async r=>{host.emit(r.sessionId,'turn/start');const p=readFileSync(/请读取 (.+)，按照/.exec(r.content[0].text)[1],'utf8');assert.match(p,/披露日未知/);assert.match(p,/本日无更新|本周无更新/);assert.match(p,/冲突/);writeFileSync(/原子更新 (.+)，本次 requestId/.exec(p)[1],JSON.stringify({requestId:/本次 requestId 固定为 ([a-f0-9-]+)/.exec(p)[1],status:'published',folderToken:'Root123',reportFolderToken:p.includes('【日报】')?'Daily123':'Weekly123',url:'https://example.feishu.cn/docx/Report123',noUpdates:!updated,partial:false,...(updated?{libraryFolderToken:'Library123',manifestUrl:'https://example.feishu.cn/docx/Manifest123',companies:[{name:'后摩智能',url:'https://example.feishu.cn/docx/Company123',dimensions:['融资'],added:1,conflicts:0}]}:{}),...receiptExtras}));host.emit(r.sessionId,'turn/end',{kind:'completed'});};
 return {...f,host,records,messages,failNotice:v=>{failNotice=v;},async close(){await f.close();rmSync(dir,{recursive:true,force:true});}};
}
test('FR02 API 原生会话交付、独立历史、无更新回执、报告链接与续聊',async()=>{
 const f=await setup();try{
 const post=()=>fetch(f.url+'/api/briefings',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'once'},body:JSON.stringify(input)});
 const t=await(await post()).json();await until(()=>f.service.require(t.id).status==='ready');assert.equal((await(await post()).json()).id,t.id);assert.equal(f.host.created,1);
 const done=f.service.require(t.id);assert.equal(done.publication.noUpdates,true);assert.ok(done.nativeSessionId);assert.equal(done.report,null);
 const list=await(await fetch(f.url+'/api/briefings?kind=daily')).json();assert.equal(list.items.length,1);assert.equal((await(await fetch(f.url+'/api/briefings?kind=weekly')).json()).items.length,0);
 assert.equal((await fetch(f.url+`/api/tasks/${t.id}/session`)).status,200);
 }finally{await f.close();}
});
test('FR02 官方 Schedule 默认时间、修改与停用、重复触发幂等',async()=>{
 const f=await setup();try{
 const s=f.service.briefingSchedules;assert.equal(s.get().daily,'09:00');assert.equal(s.get().weekday,5);
 const v={daily:'09:01',weekly:'09:30',weekday:5,enabled:true,research:{...input}};delete v.research.kind;
 await s.save(v);assert.equal(f.records.size,2);const daily=[...f.records.values()][0];assert.equal(daily.daily.time_zone,'Asia/Shanghai');assert.equal(daily.daily.time,'09:01:00');assert.match(daily.prompt,/briefing-endpoint.json/);
 const a=await s.trigger('daily'),b=await s.trigger('daily');assert.equal(a.id,b.id);await until(()=>f.service.require(a.id).status==='ready');
 await s.save({...v,enabled:false});assert.equal(f.records.size,0);await assert.rejects(()=>s.trigger('daily'),/未启用/);
 }finally{await f.close();}
});

test('PRD512 日报自动增量同步全量信息库，重复调研复用公司链接，FR01历史保持独立',async()=>{
 const f=await setup(true);try{
 const a=await f.service.createAuthorized(briefingTask(input));await until(()=>f.service.require(a.id).status==='ready');
 const lib=await(await fetch(f.url+'/api/industry/library')).json();assert.equal(lib.companies.length,1);assert.equal(lib.companies[0].name,'后摩智能');assert.equal(lib.companies[0].taskId,a.id);
 const b=await f.service.createAuthorized(briefingTask({...input,kind:'weekly'}));await until(()=>f.service.require(b.id).status==='ready');assert.equal((await(await fetch(f.url+'/api/industry/library')).json()).companies.length,1);
 assert.equal(f.service.require(b.id).industryLibrary.companies[0].url,lib.companies[0].url);assert.equal(f.service.require(a.id).industry,undefined);
 assert.throws(()=>f.service.rememberBriefing(f.service.require(a.id),{status:'published',reportFolderToken:'Daily123',noUpdates:false,partial:false}),/增量同步/);
 assert.throws(()=>f.service.rememberBriefing(f.service.require(a.id),{status:'published',reportFolderToken:'Daily123',noUpdates:true,partial:true}),/缺口/);
 }finally{await f.close();}
});

test('最新PRD 日报/周报定时配置分别保存，启停互不影响，自定义Prompt按当期解析',async()=>{
 const f=await setup();try{const schedules=f.service.briefingSchedules;
 await schedules.save({kind:'daily',time:'09:15',enabled:true,research:{companies:['后摩智能'],dimensions:['融资'],sources:['公司官网'],requirements:'日报要求',prompt:'统计 {{时间范围}} 动态并更新全量信息库。'}});
 const dailyId=schedules.get().records.daily.id;
 await schedules.save({kind:'weekly',time:'10:30',weekday:5,enabled:true,research:{companies:['光羽芯辰'],dimensions:['技术'],sources:['芯东西'],requirements:'周报要求'}});
 assert.equal(schedules.get().records.daily.id,dailyId);assert.equal(schedules.get('daily').research.requirements,'日报要求');assert.equal(schedules.get('weekly').research.companies[0],'光羽芯辰');
 await schedules.save({kind:'weekly',time:'10:30',weekday:5,enabled:false,research:schedules.get('weekly').research});
 assert.equal(schedules.get('daily').enabled,true);assert.equal(f.records.size,1);
 const t=await schedules.trigger('daily');assert.ok(!t.prompt.includes('{{时间范围}}'));await until(()=>f.service.require(t.id).status==='ready');
 }finally{await f.close();}
});
test('最新PRD 机器人按任务绑定身份通知，无更新/报告链接，失败独立重试且不重复调研',async()=>{
 const f=await setup();try{
 f.failNotice(true);const t=await f.service.createAuthorized(briefingTask(input));await until(()=>f.service.require(t.id).notification?.status==='failed');
 assert.equal(f.service.require(t.id).status,'ready');f.failNotice(false);await Promise.all([f.service.notifications.send(t.id),f.service.notifications.send(t.id)]);
 assert.equal(f.messages.length,1);const m=f.messages[0];assert.ok(m.args.includes('bot'));assert.ok(m.args.includes('ou_fixture'));assert.ok(m.args.some(a=>a.includes('本日无更新')));assert.equal(m.app.appId,'cli_fixture');
  assert.equal(f.service.require(t.id).notification.messageId,'om_fixture');
 await f.service.notifications.send(t.id);assert.equal(f.messages.length,1);assert.equal(f.service.require(t.id).runs.length,1);
 }finally{await f.close();}
 const f2=await setup(true);try{const t=await f2.service.createAuthorized(briefingTask(input));await until(()=>f2.service.require(t.id).notification?.status==='sent');assert.ok(f2.messages[0].args.some(a=>a.includes('https://example.feishu.cn/docx/Report123')));}finally{await f2.close();}
});

test('通知拒绝在绑定账号切换后发送，不回退其他用户',async()=>{const f=await setup();try{f.service.binding.json=async()=>({appId:'cli_other',identities:{user:{available:true,openId:'ou_other'}}});const t=await f.service.createAuthorized(briefingTask(input));await until(()=>f.service.require(t.id).notification?.status==='failed');assert.equal(f.messages.length,0);assert.equal(f.service.require(t.id).status,'ready');}finally{await f.close();}});

test('通知拒绝在机器人身份不可用时发送，并给出重新绑定指引',async()=>{const f=await setup();try{f.service.binding.json=async()=>({appId:'cli_fixture',identities:{bot:{status:'missing',available:false,verified:false},user:{available:true,openId:'ou_fixture'}}});const t=await f.service.createAuthorized(briefingTask(input));await until(()=>f.service.require(t.id).notification?.status==='failed');assert.equal(f.messages.length,0);assert.match(f.service.require(t.id).notification.error,/im:message:send_as_bot/);}finally{await f.close();}});

test('不合法的已发布回执不能绕过缺口校验并发送无更新通知',async()=>{const f=await setup(false,{noUpdates:true,partial:true});try{const t=await f.service.createAuthorized(briefingTask(input));await until(()=>f.service.require(t.id).status==='failed');assert.equal(f.messages.length,0);assert.match(f.service.require(t.id).error,/缺口/);}finally{await f.close();}});
