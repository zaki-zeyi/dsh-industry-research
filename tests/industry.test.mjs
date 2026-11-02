import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.mjs';
import { DEFAULT_COMPANIES, DEFAULT_DIMENSIONS, preferences, preferencesSchema, companyTaskInput, mergeCompanyDelivery, library, refreshLibrary } from '../server/industry.mjs';
import { startRuntime } from '../server/runtime.mjs';
import { mockHost } from './fixtures/fake-native-host.mjs';
import { until } from './helpers.mjs';
const url = name => 'https://example.feishu.cn/docx/' + name;
const company = name => ({ name, url: url(name === '后摩智能' ? 'HoumoDoc' : 'OtherDoc'), dimensions: ['技术路线'], added: 2, conflicts: 1 });
const input = { companies: ['后摩智能','光羽芯辰'], dimensions: ['技术路线'], sources: ['芯东西'], requirements: '' };
async function setup(deliver) {
 const dir = mkdtempSync(resolve(tmpdir(),'industry-ac-')), host = mockHost(); let bound = true;
 const binding = { requireBound: async () => { if (!bound) throw Object.assign(new Error('请先绑定飞书'),{status:428}); }, applicationSnapshot:()=>({mode:'default'}), close(){} };
 const runtime = await startRuntime({ port:0, dataDir:dir, env:{RESEARCH_MODE:'native'},host,binding });
 host.sessionController.prompt = async request => {
   host.emit(request.sessionId,'turn/start'); const path = /请读取 (.+)，按照/.exec(request.content[0].text)?.[1];
   if(path) { const prompt = readFileSync(path,'utf8'); const receipt = {requestId:/本次 requestId 固定为 ([a-f0-9-]+)/.exec(prompt)[1],status:'published',folderToken:'rootFolder',libraryFolderToken:'libraryFolder',manifestUrl:url('ManifestDoc'),url:url('HoumoDoc'),companies:input.companies.map(company)}; const value=await deliver?.(receipt,prompt,request);writeFileSync(/原子更新 (.+)，本次 requestId/.exec(prompt)[1],JSON.stringify(value??receipt)); }
   host.emit(request.sessionId,'turn/end',{kind:'completed'}); return {accepted:true};
 };
 return {...runtime,host,setBound:v=>bound=v, async close(){await runtime.close();rmSync(dir,{recursive:true,force:true});}};
}
test('AC-IND-01 默认17家公司/5维度，配置持久化，输入去重与空选校验',()=>{
 assert.equal(DEFAULT_COMPANIES.length,17);assert.equal(DEFAULT_DIMENSIONS.length,5);
 const dir=mkdtempSync(resolve(tmpdir(),'industry-prefs-'));let store=new Store(resolve(dir,'test.sqlite'));
 try {const p=preferences(store);p.sources.push('测试自定义信源');store.saveSetting('industry-preferences',preferencesSchema.parse(p));store.close();store=new Store(resolve(dir,'test.sqlite'));assert.ok(preferences(store).sources.includes('测试自定义信源'));assert.equal(companyTaskInput({...input,companies:['后摩智能','后摩智能']}).industry.companies.length,1);assert.throws(()=>companyTaskInput({...input,dimensions:[]}));assert.throws(()=>companyTaskInput({...input,sources:[]}));} finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('AC-IND-02 真实API拒绝未绑定，接受可编辑Prompt、幂等重放，不创建重复会话',async()=>{
 const f=await setup();try{f.setBound(false);const create=body=>fetch(f.url+'/api/industry/tasks',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'industry-once'},body:JSON.stringify(body)});
 assert.equal((await create(input)).status,428);assert.equal(f.host.created,0);f.setBound(true);const value={...input,prompt:'请按用户编辑的任务要求开展公司调研并保留来源。'};const a=await(await create(value)).json();await until(()=>f.service.require(a.id).status==='ready');const b=await(await create(value)).json();assert.equal(a.id,b.id);assert.equal(f.host.created,1);assert.equal(f.service.require(a.id).prompt,value.prompt);assert.equal((await create({...value,requirements:'改变要求'})).status,409);
 }finally{await f.close();}
});
test('AC-IND-03 每公司一文档，卡片可追溯，后续任务复用目录与原文档，所有会话共享工作区',async()=>{
 const prompts=[];const f=await setup((r,p)=>{prompts.push(p);return r;});try{
 const a=await f.service.createAuthorized(companyTaskInput(input));await until(()=>f.service.require(a.id).status==='ready');await until(()=>!f.service.active.size);
 let list=await(await fetch(f.url+'/api/industry/library')).json();assert.equal(list.companies.length,2);assert.equal(list.companies[0].conflicts,1);assert.equal(list.companies[0].taskId,a.id);assert.equal(f.service.require(a.id).report,null);
 const b=await f.service.createAuthorized(companyTaskInput(input));await until(()=>f.service.require(b.id).status==='ready');assert.equal(library(f.service.store,f.service.feishuSettings()).companies.length,2);assert.match(prompts[1],/HoumoDoc/);assert.match(prompts[1],/已有子文件夹 token：libraryFolder/);assert.match(prompts[1],/ManifestDoc/);assert.match(prompts[1],/docs \+update/);assert.match(prompts[1],/原图片链接/);assert.match(prompts[1],/信息冲突/);
 const calls=f.host.calls.filter(c=>c.kind==='create');assert.equal(calls[0].cwd,calls[1].cwd);assert.equal(calls[0].agentPreset,'standard');assert.equal(f.host.permissions[0].name,'danger-full-access');
 }finally{await f.close();}
});
test('AC-IND-04 部分失败保留已完成文档，重试同一会话并补齐公司',async()=>{
 let calls=0;const f=await setup(r=>++calls===1?{...r,status:'failed',error:'测试信源暂不可用',companies:[company('后摩智能')]}:r);try{
 const a=await f.service.createAuthorized(companyTaskInput(input));await until(()=>f.service.require(a.id).status==='failed');await until(()=>!f.service.active.size);assert.equal(library(f.service.store,f.service.feishuSettings()).companies.length,1);const session=f.service.require(a.id).nativeSessionId;
 f.service.retry(a.id,'research');await until(()=>f.service.require(a.id).status==='ready');assert.equal(f.service.require(a.id).nativeSessionId,session);assert.equal(f.host.created,1);assert.equal(library(f.service.store,f.service.feishuSettings()).companies.length,2);
 }finally{await f.close();}
});
test('AC-IND-05 假成功缺少公司时失败，保留已完成卡片',async()=>{
 const f=await setup(r=>({...r,companies:[company('后摩智能')]}));try{const a=await f.service.createAuthorized(companyTaskInput(input));await until(()=>f.service.require(a.id).status==='failed');assert.match(f.service.require(a.id).error,/部分公司未交付/);assert.equal(library(f.service.store,f.service.feishuSettings()).companies.length,1);}finally{await f.close();}
});
test('AC-IND-06 拒绝覆盖原公司链接、错目录和重复文档；根目录与账号隔离',async()=>{
 const f=await setup();try{const a=await f.service.createAuthorized(companyTaskInput(input));await until(()=>f.service.require(a.id).status==='ready');const t=f.service.require(a.id), c=company('后摩智能');
 assert.throws(()=>mergeCompanyDelivery(f.service.store,t,{libraryFolderToken:'other',companies:[c]}),/目录/);
 assert.throws(()=>mergeCompanyDelivery(f.service.store,t,{libraryFolderToken:'libraryFolder',manifestUrl:url('ChangedManifest'),companies:[c]}),/索引/);
 assert.throws(()=>mergeCompanyDelivery(f.service.store,t,{libraryFolderToken:'libraryFolder',companies:[{...c,url:url('ChangedDoc')}]}),/原文档/);
 assert.throws(()=>mergeCompanyDelivery(f.service.store,t,{libraryFolderToken:'libraryFolder',companies:[c,c]}),/重复/);
 assert.equal(library(f.service.store,{rootName:'other'}).companies.length,0);assert.equal(library(f.service.store,t.feishuRoot,{profile:'other'}).companies.length,0);
 }finally{await f.close();}
});
test('AC-IND-07 已知飞书索引读取，无目录列表权限，失败不丢本地记录',async()=>{
 const f=await setup();try{const a=await f.service.createAuthorized(companyTaskInput(input));await until(()=>f.service.require(a.id).status==='ready');const root=f.service.feishuSettings();let args;
 const fetched=await refreshLibrary(f.service.store,root,undefined,async(_command,a)=>{args=a;return{stdout:JSON.stringify({ok:true,data:{document:{content:JSON.stringify({companies:[{...company('后摩智能'),updatedAt:new Date().toISOString()}]})}}})};});assert.equal(fetched.companies.length,1);assert.ok(args.includes('+fetch'));assert.ok(!args.includes('list'));assert.equal(fetched.companies[0].taskId,a.id);
 await assert.rejects(refreshLibrary(f.service.store,root,undefined,async()=>{throw new Error('offline');}));assert.equal(library(f.service.store,root).companies.length,1);
 }finally{await f.close();}
});
