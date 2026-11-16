import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {startRuntime} from '../server/runtime.mjs';
import {mockHost} from './fixtures/fake-native-host.mjs';
import {library,libraryKey,refreshLibrary,mergeCompanyDelivery} from '../server/industry.mjs';
import {documentScope,documentRemoved,documentOperationKey} from '../server/document-deletion-state.mjs';
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
