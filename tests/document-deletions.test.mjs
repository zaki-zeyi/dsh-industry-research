import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {startRuntime} from '../server/runtime.mjs';
import {mockHost} from './fixtures/fake-native-host.mjs';
import {library,libraryKey,refreshLibrary,mergeCompanyDelivery} from '../server/industry.mjs';
import {documentScope,documentRemoved,documentOperationKey} from '../server/document-deletion-state.mjs';
import {analysisKey,analysisLibrary,refreshAnalysisLibrary,mergeAnalysisDelivery} from '../server/analysis.mjs';
const folder=(name,token)=>({name,token,type:'folder'}),doc=(name,token)=>({name,token,type:'docx',url:'https://example.feishu.cn/docx/'+token});
const companyUrl='https://example.feishu.cn/docx/Company',transcriptUrl='https://example.feishu.cn/docx/Transcript',minutesUrl='https://example.feishu.cn/docx/Minutes',originalUrl='https://example.feishu.cn/docx/Original';
async function fixture(){
 const dir=mkdtempSync(resolve(tmpdir(),'document-delete-')),calls=[],host=mockHost(),files={Root:[folder('全量信息库','Library'),folder('内部资料','Materials')],Library:[doc('公司索引','Manifest'),doc('后摩智能','Company'),doc('光羽芯辰','OtherCompany')],Materials:[folder('逐字稿','Transcripts'),folder('会议纪要','MinutesFolder'),folder('原始资料','Sources')],Transcripts:[doc('访谈记录','Transcript'),doc('其他访谈','OtherTranscript')],MinutesFolder:[doc('会议纪要','Minutes')],Sources:[{name:'interview.mp4',type:'file',token:'Upload',url:'https://example.feishu.cn/file/Upload'}]};
 const state={pending:false,reject:false};
 const trash=token=>{for(const name of Object.keys(files))files[name]=files[name].filter(f=>f.token!==token);};
 const binding={applicationSnapshot:()=>({mode:'default'}),requireBound:async()=>({bound:true,deletionReady:true,openId:'ou_test'}),close(){},async json(args){
  calls.push(args);if(args.includes('+delete')){if(state.reject)throw new Error('private details');const token=args[args.indexOf('--file-token')+1];assert.ok(args.includes('--yes'));assert.ok(!['Original','OtherTranscript','OtherCompany','Library','Materials'].includes(token));if(state.pending)return {ok:true,data:{ready:false,task_id:'job-'+token}};trash(token);return {ok:true,data:{deleted:true}};}
  if(args.includes('+task_result')){trash(args[args.indexOf('--task-id')+1].slice(4));return {ok:true,data:{ready:true,status:'success'}};}throw new Error('unexpected command');
 }};
 const companies=[{name:'后摩智能',url:companyUrl,dimensions:['技术路线'],updatedAt:'2026-11-10T01:00:00Z',conflicts:0,added:1},{name:'光羽芯辰',url:'https://example.feishu.cn/docx/OtherCompany',dimensions:['技术路线'],updatedAt:'2026-11-10T01:00:00Z',conflicts:0,added:1}];
 const run=async(_command,args)=>({stdout:JSON.stringify({ok:true,data:args.includes('+fetch')?{document:{content:JSON.stringify({companies})}}:{files:files[args[args.indexOf('--folder-token')+1]]??[],has_more:false}})});
 const runtime=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding,publicationRun:run,libraryRun:run});const s=runtime.service;
 s.setFeishuSettings({folderUrl:'https://example.feishu.cn/drive/folder/Root'});const root=s.feishuSettings(),app={mode:'default'},scope=documentScope(root,app);
 s.store.saveSetting(libraryKey(root,app),{rootFolderToken:'Root',folderToken:'Library',manifestUrl:'https://example.feishu.cn/docx/Manifest',companies});
 const task={id:'11111111-1111-4111-8111-111111111111',status:'ready',direction:'内部资料解析 · 访谈记录',createdAt:'2026-11-10T01:00:00Z',feishuRoot:root,feishuApp:app,runs:[],internal:{workflowVersion:1534,directoryName:'内部资料',sourceType:'url',source:originalUrl,sourceLabel:'访谈记录'},publication:{status:'published',url:transcriptUrl,minutesUrl,sourceMaterialUrl:originalUrl,reportFolderToken:'Transcripts',materialFolderToken:'Materials',sourceFolderToken:'Sources',minutesFolderToken:'MinutesFolder'}};
 s.store.save(task);
 files.Root.push(folder('友商分析','Analysis'),folder('日报','Daily'),folder('周报','Weekly'));
 files.Analysis=[doc('分析报告索引','AnalysisManifest'),doc('友商分析 · 后摩智能×光羽芯辰','AnalysisReport'),doc('其他分析','OtherAnalysis')];
 files.Daily=[doc('日报 · 测试','DailyReport'),doc('日报 · 其他','OtherDaily')];files.Weekly=[doc('周报 · 测试','WeeklyReport')];
 const preview=(kind='internal',target=task.id)=>s.documentDeletions.preview(kind,target,scope);
 const body=p=>({target:p.target,scope:p.scope,confirmation:p.confirmation,confirmed:true});
 return {runtime,s,task,root,app,scope,files,calls,state,run,preview,body,async close(){await runtime.close();rmSync(dir,{recursive:true,force:true});}};
}
test('PRD580 公司删除只回收原公司文档，旧索引和旧回执不能恢复卡片',async()=>{
 const f=await fixture();try{
  const plan=await f.preview('company',companyUrl);assert.equal(plan.documents.length,1);assert.equal(plan.documents[0].token,'Company');
  assert.equal((await f.s.documentDeletions.remove('company',f.body(plan))).status,'deleted');assert.equal(f.calls.length,1);
  assert.deepEqual(library(f.s.store,f.root,f.app).companies.map(c=>c.name),['光羽芯辰']);
  const refreshed=await refreshLibrary(f.s.store,f.root,f.app,f.run);assert.deepEqual(refreshed.companies.map(c=>c.name),['光羽芯辰']);
  assert.throws(()=>mergeCompanyDelivery(f.s.store,{feishuRoot:f.root,feishuApp:f.app,industry:{companies:['后摩智能']}},{libraryFolderToken:'Library',companies:[{name:'后摩智能',url:companyUrl,dimensions:[]}]}),/已删除/);
  await f.s.documentDeletions.remove('company',f.body(plan));assert.equal(f.calls.length,1);assert.ok(f.files.Library.some(f=>f.token==='Manifest'));
 }finally{await f.close();}
});

function reportTask(f,kind){
 const id=kind==='analysis'?'33333333-3333-4333-8333-333333333333':kind==='daily'?'44444444-4444-4444-8444-444444444444':'55555555-5555-4555-8555-555555555555';
 const token=kind==='analysis'?'AnalysisReport':kind==='daily'?'DailyReport':'WeeklyReport';
 const url='https://example.feishu.cn/docx/'+token;
 const task={id,direction:kind+' · 测试报告',status:'ready',stage:'done',createdAt:'2026-11-16T01:00:00Z',feishuRoot:f.root,feishuApp:f.app,runs:[],publication:{status:'published',url,reportFolderToken:kind==='daily'?'Daily':'Weekly'}};
 if(kind==='analysis'){
  task.analysis={companies:['后摩智能','光羽芯辰'],dimensions:['技术路线']};task.analysisReport={title:'友商分析 · 后摩智能×光羽芯辰',url,companies:task.analysis.companies,dimensions:['技术路线'],updatedAt:task.createdAt,insufficient:[],taskId:id};
  f.s.store.saveSetting(analysisKey(f.root,f.app),{folderToken:'Analysis',manifestUrl:'https://example.feishu.cn/docx/AnalysisManifest',reports:[task.analysisReport]});
 }else task.briefing={kind,window:{display:'测试区间'}};
 f.s.store.save(task);return task;
}
test('PRD4896 删除友商分析只回收报告，旧索引与原任务不能重新生成卡片',async()=>{
 const f=await fixture();try{
  const task=reportTask(f,'analysis'),report=task.analysisReport;
  const plan=await f.preview('analysis',report.url+'?from=card#position');assert.deepEqual(plan.documents.map(d=>d.token),['AnalysisReport']);assert.equal(f.calls.length,0);
  const r=await fetch(f.runtime.url+'/api/document-deletions/analysis',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.body(plan))});assert.equal(r.status,200);
  assert.equal(analysisLibrary(f.s.store,f.root,f.app).reports.length,0);assert.equal(library(f.s.store,f.root,f.app).companies.length,2);
  assert.ok(f.files.Analysis.some(d=>d.token==='AnalysisManifest'));assert.ok(f.files.Analysis.some(d=>d.token==='OtherAnalysis'));
  const run=async()=>({stdout:JSON.stringify({ok:true,data:{document:{content:JSON.stringify({reports:[report]})}}})});
  assert.equal((await refreshAnalysisLibrary(f.s.store,f.root,f.app,run)).reports.length,0);
  const cards=await(await fetch(f.runtime.url+'/api/analysis/reports')).json();assert.deepEqual(cards.reports,[]);assert.deepEqual(cards.tasks,[]);
  assert.throws(()=>f.s.retry(task.id,'research'),/已删除/);
  assert.throws(()=>mergeAnalysisDelivery(f.s.store,task,{analysisFolderToken:'Analysis',analysisManifestUrl:'https://example.feishu.cn/docx/AnalysisManifest',report}),/已删除/);
  await f.s.documentDeletions.remove('analysis',f.body(plan));assert.equal(f.calls.filter(a=>a.includes('+delete')).length,1);
 }finally{await f.close();}
});
for(const kind of ['daily','weekly'])test('PRD4896 删除'+kind+'不影响公司资料和定时计划，缓存、刷新及通知均不恢复报告',async()=>{
 const f=await fixture();try{
  const task=reportTask(f,kind),schedule={plans:{[kind]:{enabled:true,time:'10:10'}}};f.s.store.saveSetting('briefing-schedule',schedule);
  const plan=await f.preview(kind,task.id);assert.equal(plan.documents.length,1);
  await f.s.documentDeletions.remove(kind,f.body(plan));
  assert.deepEqual(f.s.store.setting('briefing-schedule'),schedule);assert.equal(library(f.s.store,f.root,f.app).companies.length,2);
  for(const suffix of ['', '&refresh=true&force=true']){
   const list=await(await fetch(f.runtime.url+'/api/briefings?kind='+kind+suffix)).json();assert.ok(!list.items.some(t=>t.id===task.id||t.publication?.url===task.publication.url));
  }
  assert.throws(()=>f.s.retry(task.id,'research'),/已删除/);assert.throws(()=>f.s.rememberBriefing(task,{status:'published'}),/已删除/);
  const notify=await fetch(f.runtime.url+'/api/briefings/'+task.id+'/notify',{method:'POST'});assert.equal(notify.status,409);assert.equal(f.calls.some(a=>a[0]==='im'),false);
  assert.ok(f.files.Root.some(d=>d.token===(kind==='daily'?'Daily':'Weekly')));assert.ok(f.files.Daily.some(d=>d.token==='OtherDaily'));
 }finally{await f.close();}
});
test('PRD4896 飞书导入日报可删除；无云端文档的失败分析仅移除卡片',async()=>{
 const f=await fixture();try{
  const list=await(await fetch(f.runtime.url+'/api/briefings?kind=daily&refresh=true&force=true')).json();const remote=list.items.find(t=>t.publication.url.endsWith('/DailyReport'));assert.equal(remote.remoteOnly,true);
  const p=await f.preview('daily',remote.id);await f.s.documentDeletions.remove('daily',f.body(p));assert.equal(f.calls.length,1);
  const task=reportTask(f,'analysis');task.status='failed';task.publication={status:'failed'};delete task.analysisReport;f.s.store.save(task);f.s.store.saveSetting(analysisKey(f.root,f.app),{reports:[]});
  const empty=await f.preview('analysis',task.id);assert.deepEqual(empty.documents,[]);await f.s.documentDeletions.remove('analysis',f.body(empty));assert.equal(f.calls.length,1);
  const cards=await(await fetch(f.runtime.url+'/api/analysis/reports')).json();assert.deepEqual(cards.tasks,[]);assert.throws(()=>f.s.retry(task.id,'research'),/已删除/);
 }finally{await f.close();}
});
test('PRD4896 分析报告异步删除可重启续查，失败不冒充成功',async()=>{
 const f=await fixture();try{
  const task=reportTask(f,'analysis'),p=await f.preview('analysis',task.analysisReport.url);f.state.reject=true;
  await assert.rejects(f.s.documentDeletions.remove('analysis',f.body(p)),e=>e.status===503);assert.equal(analysisLibrary(f.s.store,f.root,f.app).reports.length,1);
  f.state.reject=false;f.state.pending=true;const pending=await f.preview('analysis',task.analysisReport.url);assert.equal((await f.s.documentDeletions.remove('analysis',f.body(pending))).status,'pending');
  const {DocumentDeletions}=await import('../server/document-deletions.mjs');f.s.documentDeletions=new DocumentDeletions(f.s,{publicationRun:f.run});
  const saved=await f.preview('analysis',task.analysisReport.url);assert.equal(saved.status,'pending');assert.equal((await f.s.documentDeletions.remove('analysis',f.body(saved))).status,'deleted');
  assert.equal(f.calls.filter(a=>a.includes('+task_result')).length,1);assert.equal(analysisLibrary(f.s.store,f.root,f.app).reports.length,0);
 }finally{await f.close();}
});
test('PRD4896 报告删除保护运行中任务、共享索引、目录与账号范围',async()=>{
 const f=await fixture();try{
  const task=reportTask(f,'analysis');f.s.active.set(task.id,{});await assert.rejects(f.preview('analysis',task.analysisReport.url),/仍在/);f.s.active.clear();
  task.publication.url='https://example.feishu.cn/docx/AnalysisManifest';task.analysisReport.url=task.publication.url;f.s.store.save(task);f.s.store.saveSetting(analysisKey(f.root,f.app),{folderToken:'Analysis',manifestUrl:task.publication.url,reports:[task.analysisReport]});
  await assert.rejects(f.preview('analysis',task.publication.url),/共享索引/);
  const day=reportTask(f,'daily');const p=await f.preview('daily',day.id);f.s.setFeishuSettings({folderUrl:'https://example.feishu.cn/drive/folder/OtherRoot'});
  await assert.rejects(f.s.documentDeletions.remove('daily',f.body(p)),/已变化/);assert.equal(f.calls.length,0);
 }finally{await f.close();}
});

test('PRD4896 报告仅在索引关联任务时，仍阻止运行中删除和旧任务恢复',async()=>{
 const f=await fixture();try{
  const task=reportTask(f,'analysis'),url=task.analysisReport.url;delete task.analysisReport;task.publication={status:'failed'};f.s.store.save(task);
  f.s.active.set(task.id,{});await assert.rejects(f.preview('analysis',url),/仍在/);f.s.active.clear();
  const plan=await f.preview('analysis',url);await f.s.documentDeletions.remove('analysis',f.body(plan));
  const cards=await(await fetch(f.runtime.url+'/api/analysis/reports')).json();assert.deepEqual(cards.tasks,[]);assert.throws(()=>f.s.retry(task.id,'research'),/已删除/);
 }finally{await f.close();}
});
test('PRD580 内部资料回收逐字稿及纪要，保留网络来源、公司增量和其他卡片',async()=>{
 const f=await fixture();try{
  const plan=await f.preview();assert.deepEqual(plan.documents.map(d=>d.token).sort(),['Minutes','Transcript']);assert.equal(f.calls.length,0);
  const r=await fetch(f.runtime.url+'/api/document-deletions/internal',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(f.body(plan))});assert.equal(r.status,200);
  assert.deepEqual(f.calls.map(a=>a[a.indexOf('--file-token')+1]).sort(),['Minutes','Transcript']);
  const list=await(await fetch(f.runtime.url+'/api/internal-materials?refresh=true&force=true')).json();assert.equal(list.items.some(t=>t.publication.url===transcriptUrl),false);assert.ok(list.items.some(t=>t.publication.url.endsWith('/OtherTranscript')));
  assert.equal(library(f.s.store,f.root,f.app).companies.length,2);assert.ok(f.files.Sources.some(f=>f.token==='Upload'));assert.throws(()=>f.s.retry(f.task.id,'research'),/已删除/);
 }finally{await f.close();}
});
test('PRD580 本地上传副本纳入回收，共用纪要保留，任务执行时不可删',async()=>{
 const f=await fixture();try{
  const task={...f.task,internal:{...f.task.internal,sourceType:'local',source:'/test/interview.mp4'},publication:{...f.task.publication,sourceMaterialUrl:'https://example.feishu.cn/file/Upload'}};f.s.store.save(task);
  f.s.store.save({...f.task,id:'22222222-2222-4222-8222-222222222222',publication:{...f.task.publication,url:'https://example.feishu.cn/docx/OtherTranscript'}});
  const plan=await f.preview();assert.equal(plan.protectedShared,true);assert.deepEqual(plan.documents.map(d=>d.token).sort(),['Transcript','Upload']);
  f.s.active.set(task.id,{});await assert.rejects(f.s.documentDeletions.remove('internal',f.body(plan)),/仍在/);f.s.active.clear();assert.equal(f.calls.length,0);
  await f.s.documentDeletions.remove('internal',f.body(plan));assert.ok(f.files.MinutesFolder.some(d=>d.token==='Minutes'));assert.equal(f.files.Sources.length,0);
 }finally{await f.close();}
});
test('PRD580 异步删除保存任务ID，重启可续查，未确认前保留卡片',async()=>{
 const f=await fixture();try{
  f.state.pending=true;const plan=await f.preview('company',companyUrl);assert.equal((await f.s.documentDeletions.remove('company',f.body(plan))).status,'pending');assert.equal(library(f.s.store,f.root,f.app).companies.length,2);
  const {DocumentDeletions}=await import('../server/document-deletions.mjs');f.s.documentDeletions=new DocumentDeletions(f.s,{publicationRun:f.run});
  const saved=await f.preview('company',companyUrl);assert.equal(saved.status,'pending');assert.equal(f.s.store.setting(documentOperationKey(f.scope,'company',companyUrl)).documents[0].taskId,'job-Company');
  assert.equal((await f.s.documentDeletions.remove('company',f.body(saved))).status,'deleted');assert.equal(f.calls.filter(a=>a.includes('+delete')).length,1);assert.equal(f.calls.filter(a=>a.includes('+task_result')).length,1);
 }finally{await f.close();}
});
test('PRD580 拒绝确认范围变化、账号目录切换和权限失败，不伪装成功',async()=>{
 const f=await fixture();try{
  const plan=await f.preview();await assert.rejects(f.s.documentDeletions.remove('internal',{...f.body(plan),scope:'other'}),/已变化/);
  f.files.MinutesFolder=[];await assert.rejects(f.s.documentDeletions.remove('internal',f.body(plan)),/范围已变化/);assert.equal(f.calls.length,0);
  const fresh=await f.preview();f.state.reject=true;await assert.rejects(f.s.documentDeletions.remove('internal',f.body(fresh)),e=>e.status===503&&!e.message.includes('private'));
  assert.equal(documentRemoved(f.s.store,f.root,f.app,transcriptUrl),false);assert.equal(f.s.require(f.task.id).status,'ready');
 }finally{await f.close();}
});
