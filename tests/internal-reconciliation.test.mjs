import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {startRuntime} from '../server/runtime.mjs';
import {mockHost} from './fixtures/fake-native-host.mjs';
import {prepareInternalMaterial} from '../server/internal-materials.mjs';
import {libraryKey} from '../server/industry.mjs';
import {until} from './helpers.mjs';
const root='Root',folder='Library',transcript='https://example.feishu.cn/docx/Transcript',minutes='https://example.feishu.cn/docx/Minutes',company='https://example.feishu.cn/docx/Company',manifest='https://example.feishu.cn/docx/Manifest';
async function fixture(){
 const dir=mkdtempSync(resolve(tmpdir(),'internal-reconcile-')),host=mockHost(),reads=[];let calls=0,mentions=true;
 let runtime;
 const binding={requireBound:async()=>({bound:true,openId:'ou_test'}),applicationSnapshot:()=>({mode:'default'}),close(){},async json(args){assert.equal(args[0],'docs');assert.ok(args.includes('+fetch'));const url=args[args.indexOf('--doc')+1];reads.push(url);return {ok:true,data:{document:{content:url===transcript?'完整逐字稿':mentions?'已核对来源 '+transcript:'没有本次资料的引用'}}};}};
 runtime=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding});const s=runtime.service;
 s.setFeishuSettings({folderUrl:'https://example.feishu.cn/drive/folder/'+root});
 s.store.saveSetting(libraryKey(s.feishuSettings(),{}),{rootFolderToken:root,folderToken:folder,manifestUrl:manifest,companies:[{name:'后摩智能',url:company,dimensions:['技术路线'],updatedAt:'2026-11-10T01:00:00Z'}]});
 host.sessionController.prompt=async request=>{
  calls++;host.emit(request.sessionId,'turn/start');const task=s.store.list().find(t=>t.nativeSessionId===request.sessionId),meta=s.nativeSessions.get(task.terminalId);
  await s.cloudWrites.acquire(task.id,meta.deliveryRequestId);
  writeFileSync(meta.deliveryPath,JSON.stringify({requestId:meta.deliveryRequestId,status:'published',folderToken:root,materialFolderToken:'Material',reportFolderToken:'TranscriptFolder',sourceFolderToken:'Source',minutesFolderToken:'MinutesFolder',url:transcript,minutesUrl:minutes,sourceMaterialUrl:'https://example.feishu.cn/docx/Original',companies:[{name:'后摩智能',url:company,dimensions:['技术路线'],added:6,conflicts:0}]}));
  host.emit(request.sessionId,'turn/end',{kind:'completed'});
 };
 const t=await s.createAuthorized(prepareInternalMaterial({sourceType:'url',source:'https://example.feishu.cn/docx/Original'}));await until(()=>!s.active.has(t.id)&&s.require(t.id).status!=='queued'&&s.require(t.id).status!=='running');
 const makeLegacy=()=>{const task=s.require(t.id);task.status='failed';task.error='内部资料尚未完成信息库增量同步';task.publication.status='publishing';delete task.publication.libraryFolderToken;delete task.publication.manifestUrl;task.runs.at(-1).status='failed';s.store.save(task);const meta=s.store.terminal(task.terminalId);meta.activity='waiting_input';meta.lastTurnReason='error';s.store.saveTerminal(meta);};
 return {runtime,s,id:t.id,reads,makeLegacy,get calls(){return calls;},set mentions(v){mentions=v;},async close(){await runtime.close();rmSync(dir,{recursive:true,force:true});}};
}
test('内部资料完成回执省略目录索引字段时，复用已确认保存锁元信息，不误判增量失败',async()=>{
 const f=await fixture();try{const task=f.s.require(f.id);assert.equal(task.status,'ready');assert.equal(task.publication.libraryFolderToken,folder);assert.equal(task.publication.manifestUrl,manifest);assert.equal(task.error,null);assert.equal(f.calls,1);}finally{await f.close();}
});
test('只读核对旧失败卡片后恢复完成，无新Agent、云端写入或通知，重复核对幂等',async()=>{
 const f=await fixture();try{
  const key=libraryKey(f.s.feishuSettings(),{}),index=f.s.store.setting(key);index.companies[0]={...index.companies[0],taskId:'newer-task',added:99,updatedAt:'2099-01-01T00:00:00Z'};f.s.store.saveSetting(key,index);
  f.makeLegacy();let notices=0;f.s.internalNotifications={send:async()=>{notices++;},close:async()=>{}};
  const beforeCalls=f.calls;const [a,b]=await Promise.all([f.s.internalReconciliation.reconcile(f.id),f.s.internalReconciliation.reconcile(f.id)]);
  assert.equal(a.status,'ready');assert.equal(a.error,null);assert.equal(a.publication.status,'published');assert.equal(a.runs.at(-1).status,'completed');assert.equal(a.reconciliation.status,'verified');assert.equal(b.id,a.id);
  assert.deepEqual(f.reads,[transcript,minutes,company]);assert.equal(f.calls,beforeCalls);assert.equal(notices,0);assert.equal(f.s.store.setting(key).companies[0].taskId,'newer-task');assert.equal(f.s.store.setting(key).companies[0].added,99);
  await f.s.internalReconciliation.reconcile(f.id);assert.equal(f.reads.length,3);
  const list=await(await fetch(f.runtime.url+'/api/internal-materials')).json();assert.equal(list.items.find(t=>t.id===f.id).status,'ready');
 }finally{await f.close();}
});
for(const scenario of ['missing-evidence','wrong-request','cancelled','different-error','running','unknown-company'])test('核对结果不误恢复：'+scenario,async()=>{
 const f=await fixture();try{
  f.makeLegacy();const task=f.s.require(f.id),meta=f.s.store.terminal(task.terminalId);
  if(scenario==='missing-evidence')f.mentions=false;
  if(scenario==='wrong-request'||scenario==='unknown-company'){const value=JSON.parse(readFileSync(meta.deliveryPath));if(scenario==='wrong-request')value.requestId='11111111-1111-4111-8111-111111111111';else value.companies[0].url='https://example.feishu.cn/docx/NewCompany';writeFileSync(meta.deliveryPath,JSON.stringify(value));}
  if(scenario==='cancelled')task.status='interrupted';if(scenario==='different-error')task.error='模型执行失败';if(scenario==='running'){meta.activity='working';f.s.store.saveTerminal(meta);}f.s.store.save(task);
  await assert.rejects(f.s.internalReconciliation.reconcile(f.id));assert.notEqual(f.s.require(f.id).status,'ready');assert.equal(f.calls,1);
 }finally{await f.close();}
});
