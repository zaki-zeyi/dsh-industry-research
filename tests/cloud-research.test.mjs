import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { startRuntime } from '../server/runtime.mjs';
import { ServiceError } from '../server/service.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { until } from './helpers.mjs';
async function setup(options={}) {
  const dir=mkdtempSync(resolve(tmpdir(),'cloud-research-')), host=mockHost(options); let bound=false;
  const binding={ async status(){return {bound};}, async requireBound(){if(!bound)throw new ServiceError(428,'请先绑定飞书');return {bound};},close(){} };
  const runtime=await startRuntime({port:0,dataDir:dir,env:{RESEARCH_MODE:'native'},host,binding});
  return {...runtime,dir,host,setBound(value){bound=value;},async close(){await runtime.close();rmSync(dir,{recursive:true,force:true});}};
}
test('PRD1907 API绑定前拒绝新调研，绑定后仅交付飞书链接且无本地报告',async()=>{
 const f=await setup();try{
  const create=()=>fetch(f.url+'/api/tasks',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({direction:'仅飞书报告验收'})});
  assert.equal((await create()).status,428);assert.equal(f.service.store.list().length,0); assert.equal(f.host.created,0);
  assert.throws(()=>f.service.create({direction:'绕过接口'}),/绑定飞书/);
  f.setBound(true);const response=await create();assert.equal(response.status,202);const task=await response.json();
  await until(()=>f.service.store.get(task.id).status==='ready');const done=f.service.store.get(task.id);
  assert.equal(done.report,null);assert.deepEqual(done.reports,[]);assert.equal(done.draft,'');assert.equal(done.localPublication,undefined);assert.equal(done.publication.url,'https://example.feishu.cn/docx/cloudReport123');assert.equal(done.runs.length,1);
  assert.equal(f.service.store.db.prepare('SELECT count(*) AS n FROM demo_documents').get().n,0);
  const meta=f.service.nativeSessions.get(done.terminalId),files=readdirSync(meta.cwd); assert.equal(meta.reportPath,undefined);assert.ok(files.every(n=>!/report.*\.(json|md)$/.test(n)));
  const prompt=readFileSync(meta.promptPath,'utf8');assert.match(prompt,/禁止 @本地报告文件/);assert.match(prompt,/stdin/);assert.match(prompt,/行研工作台/);
  const api=await(await fetch(f.url+'/api/tasks/'+task.id)).json();assert.equal(api.task.report,null);assert.deepEqual(api.events,[]);
  assert.equal((await fetch(f.url+'/api/local/documents/anything')).status,410);
  await f.service.nativeSessions.send(done.terminalId,'继续回答方法问题');assert.equal(f.host.created,1);
 }finally{await f.close();}
});
test('PRD1907 无交付与模型错误保留任务，重试复用原会话；授权失效不启动Agent',async()=>{
 const f=await setup({failFirst:true});try{
  f.setBound(true);const task=await f.service.createAuthorized({direction:'云端失败恢复'});await until(()=>f.service.store.get(task.id).status==='failed');await until(()=>!f.service.active.size);
  const before=f.service.store.get(task.id);f.service.retry(task.id,'research');await until(()=>f.service.store.get(task.id).status==='ready');assert.equal(f.service.store.get(task.id).nativeSessionId,before.nativeSessionId);assert.equal(f.host.created,1);const recovered=f.service.store.get(task.id);assert.match(readFileSync(f.service.nativeSessions.get(recovered.terminalId).promptPath,'utf8'),/优先复用原会话已完成的资料与报告内容/);
  f.setBound(false);await assert.rejects(f.service.createAuthorized({direction:'过期授权'}),/绑定飞书/);assert.equal(f.host.created,1);
 }finally{await f.close();}
 const no=await setup({noReport:true});try{no.setBound(true);const t=await no.service.createAuthorized({direction:'无文档交付'});await until(()=>no.service.store.get(t.id).status==='failed');assert.match(no.service.store.get(t.id).error,/未交付/);assert.equal(no.service.store.get(t.id).report,null);}finally{await no.close();}
});

test('PRD1915 指定文件夹直接上传，不读目录/不搜索/不新建，修改配置不改变已有任务', async () => {
 const f=await setup();try{
  f.setBound(true);f.service.setFeishuSettings({rootName:'现有目录',folderUrl:'https://tenant.feishu.cn/drive/folder/explicitFolder123'});
  const task=await f.service.createAuthorized({direction:'直接文件夹上传'});await until(()=>f.service.store.get(task.id).status==='ready');
  const t=f.service.store.get(task.id),meta=f.service.nativeSessions.get(t.terminalId),prompt=readFileSync(meta.promptPath,'utf8');
  assert.equal(t.feishuRoot.folderToken,'explicitFolder123');assert.equal(t.publication.folderToken,'explicitFolder123');assert.match(prompt,/目标文件夹 ID：explicitFolder123/);assert.match(prompt,/不新建目录/);assert.ok(!prompt.includes('分页列出根目录'));
  f.service.setFeishuSettings({rootName:'新目标',folderUrl:'https://tenant.feishu.cn/drive/folder/anotherFolder456'});assert.equal(f.service.store.get(task.id).feishuRoot.folderToken,'explicitFolder123');
 }finally{await f.close();}
});
test('PRD1915 默认目录首次创建回传ID，后续任务复用并持久化', async()=>{
 const f=await setup();try{
  f.setBound(true);const first=await f.service.createAuthorized({direction:'默认首次创建'});await until(()=>f.service.store.get(first.id).status==='ready');await until(()=>!f.service.active.size);
  assert.equal(f.service.feishuSettings().folderToken,'autoFolder123');
  const second=await f.service.createAuthorized({direction:'默认复用目录'});await until(()=>f.service.store.get(second.id).status==='ready');
  const t=f.service.store.get(second.id),prompt=readFileSync(f.service.nativeSessions.get(t.terminalId).promptPath,'utf8');assert.match(prompt,/目标文件夹 ID：autoFolder123/);assert.match(prompt,/不新建目录/);
  const {Store}=await import('../server/store.mjs'),{folderCacheKey}=await import('../server/feishu-folder.mjs');const reopened=new Store(resolve(f.dir,'research.sqlite'));try{assert.equal(reopened.setting(folderCacheKey({rootName:'行研工作台'})).folderToken,'autoFolder123');}finally{reopened.close();}
 }finally{await f.close();}
});
test('PRD1915 创建结果不确定时不由其他任务重复建目录，补链接后可重试',async()=>{
 const f=await setup({noReport:true});try{
  f.setBound(true);const a=await f.service.createAuthorized({direction:'创建未确认'});await until(()=>f.service.store.get(a.id).status==='failed');await until(()=>!f.service.active.size);
  const b=await f.service.createAuthorized({direction:'防止重复创建'});await until(()=>f.service.store.get(b.id).status==='failed');await until(()=>!f.service.active.size);
  assert.match(f.service.store.get(b.id).error,/提供已有文件夹链接/);assert.equal(f.host.created,1);
  f.service.setFeishuSettings({rootName:'行研工作台',folderUrl:'https://tenant.feishu.cn/drive/folder/recoveredFolder123'});
  f.service.retry(b.id,'research');await until(()=>f.service.store.get(b.id).runs.length===2&&f.service.store.get(b.id).status==='failed');
  const t=f.service.store.get(b.id),p=readFileSync(f.service.nativeSessions.get(t.terminalId).promptPath,'utf8');assert.match(p,/目标文件夹 ID：recoveredFolder123/);assert.equal(f.host.created,2);
 }finally{await f.close();}
});

test('PRD1915 目录创建成功但文档失败仍记住目录，重试不新建；错误目录回执不算成功',async()=>{
 const f=await setup();try{
  f.setBound(true);const normal=f.host.sessionController.prompt;
  f.host.sessionController.prompt=async request=>{
   f.host.emit(request.sessionId,'turn/start');
   const path=/请读取 (.+)，按照/.exec(request.content[0].text)[1],prompt=readFileSync(path,'utf8');
   const {writeFileSync}=await import('node:fs');writeFileSync(/原子更新 (.+)，本次 requestId/.exec(prompt)[1],JSON.stringify({requestId:/本次 requestId 固定为 ([a-f0-9-]+)/.exec(prompt)[1],status:'failed',folderToken:'createdBeforeFailure',error:'文档创建失败'}));
   f.host.emit(request.sessionId,'turn/end',{kind:'completed'});return {accepted:true};
  };
  const a=await f.service.createAuthorized({direction:'保存目录创建结果'});await until(()=>f.service.store.get(a.id).status==='failed');await until(()=>!f.service.active.size);
  assert.equal(f.service.feishuSettings().folderToken,'createdBeforeFailure');assert.equal(f.service.store.get(a.id).feishuRoot.folderToken,'createdBeforeFailure');
  f.host.sessionController.prompt=normal;f.service.retry(a.id,'research');await until(()=>f.service.store.get(a.id).status==='ready');
  assert.equal(f.service.store.get(a.id).publication.folderToken,'createdBeforeFailure');assert.equal(f.host.created,1);
 }finally{await f.close();}
 const wrong=await setup();try{
  wrong.setBound(true);wrong.service.setFeishuSettings({rootName:'固定目录',folderUrl:'https://tenant.feishu.cn/drive/folder/expectedFolder'});
  wrong.host.sessionController.prompt=async request=>{
   wrong.host.emit(request.sessionId,'turn/start');const path=/请读取 (.+)，按照/.exec(request.content[0].text)[1],p=readFileSync(path,'utf8');
   const {writeFileSync}=await import('node:fs');writeFileSync(/原子更新 (.+)，本次 requestId/.exec(p)[1],JSON.stringify({requestId:/本次 requestId 固定为 ([a-f0-9-]+)/.exec(p)[1],status:'published',folderToken:'wrongFolder',url:'https://example.feishu.cn/docx/wrongReport'}));wrong.host.emit(request.sessionId,'turn/end',{kind:'completed'});return {accepted:true};
  };
  const t=await wrong.service.createAuthorized({direction:'目录不匹配拒绝'});await until(()=>wrong.service.store.get(t.id).status==='failed');assert.match(wrong.service.store.get(t.id).error,/目录.*不一致/);assert.equal(wrong.service.feishuSettings().folderToken,'expectedFolder');
 }finally{await wrong.close();}
});
