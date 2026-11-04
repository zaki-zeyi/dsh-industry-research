import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';
import { createApp } from '../server/app.mjs';
import { cloudPrompt } from '../server/cloud-research.mjs';
import { folderCacheKey } from '../server/feishu-folder.mjs';
import { applicationRunner } from './fixtures/fake-feishu-application.mjs';
test('PRD1956 自定义应用独立配置、密钥仅stdin、绑定全程指定profile且不覆盖默认',async()=>{
 const f=fixture(),runner=applicationRunner(),binding=new FeishuBinding({store:f.store,run:runner.run});f.service.binding=binding;
 try{
  const defaultStatus=await binding.status();assert.equal(defaultStatus.bound,true);
  const info=await binding.configureApplication({mode:'custom',appId:'cli_custom123',appSecret:'credential-secret'});assert.deepEqual(info,{mode:'custom',appId:'cli_custom123',hasSecret:true});
  const create=runner.calls.find(c=>c.args[0]==='profile');assert.equal(create.options.input,'credential-secret\n');assert.ok(!create.args.includes('credential-secret'));assert.ok(!create.args.includes('--use'));
  assert.ok(!JSON.stringify(f.store.setting('feishu-application')).includes('credential-secret'));assert.ok(!JSON.stringify(await binding.applicationInfo()).includes('credential-secret'));
  const app=binding.applicationSnapshot();assert.equal((await binding.status()).bound,false);const flow=await binding.start();assert.equal((await binding.complete(flow.flowId)).userName,'自定义用户');
  const selected=runner.calls.filter(c=>c.args[0]==='--profile');assert.ok(selected.length>=4);assert.ok(selected.every(c=>c.args[1]===app.profile));assert.equal((await binding.status({mode:'default'})).userName,'默认用户');
  const task=f.service.create({direction:'lark-cli 应用快照验收'});const prompt=cloudPrompt(task,{deliveryPath:'/tmp/delivery.json',deliveryRequestId:'123'});assert.ok(prompt.startsWith(task.prompt+'\n\n'));assert.ok(prompt.includes('lark-cli --profile '+app.profile));assert.ok(!prompt.includes('credential-secret'));assert.equal(task.feishuApp.profile,app.profile);
  await binding.configureApplication({mode:'default'});assert.equal((await binding.status()).userName,'默认用户');assert.equal(f.store.get(task.id).feishuApp.profile,app.profile);assert.equal(runner.profiles.size,1);
 }finally{binding.close();await f.close();}
});
test('PRD1956 保留已有密钥、失败不切换、拒绝错误应用fallback和权限越界',async()=>{
 const f=fixture(),r=applicationRunner(),b=new FeishuBinding({store:f.store,run:r.run});
 try{
  await assert.rejects(b.configureApplication({mode:'custom',appId:'cli_custom123'}),e=>e.status===400);
  await b.configureApplication({mode:'custom',appId:'cli_custom123',appSecret:'credential-secret'});const prior=b.applicationSnapshot(),count=r.calls.length;
  await b.configureApplication({mode:'custom',appId:'cli_custom123'});assert.equal(r.calls.length,count);assert.equal(b.applicationSnapshot().profile,prior.profile);
  r.setFail(true);await assert.rejects(b.configureApplication({mode:'custom',appId:'cli_other123',appSecret:'another-secret'}),e=>e.status===503&&!e.message.includes('secret'));assert.deepEqual(b.applicationSnapshot(),prior);
  r.setMismatch(true);assert.equal((await b.status()).bound,false);assert.match((await b.status()).error,/不一致/);
  for(const bad of [{mode:'custom',appId:'bad',appSecret:'s'},{mode:'custom',appId:'cli_custom123',appSecret:'a\nb'},{mode:'default',appSecret:'not-accepted'}])await assert.rejects(b.configureApplication(bad));
 }finally{b.close();await f.close();}
});
test('PRD1956 自动目录缓存按应用隔离，恢复默认配置仍复用原目录',async()=>{
 const f=fixture(),r=applicationRunner(),b=new FeishuBinding({store:f.store,run:r.run});f.service.binding=b;
 try{
  f.store.saveSetting(folderCacheKey({rootName:'行研工作台'}),{folderToken:'defaultFolder'});assert.equal(f.service.feishuSettings().folderToken,'defaultFolder');
  await b.configureApplication({mode:'custom',appId:'cli_custom123',appSecret:'credential-secret'});const root=f.service.feishuSettings();assert.equal(root.folderToken,undefined);assert.equal(root.applicationProfile,b.applicationSnapshot().profile);
  f.store.saveSetting(folderCacheKey(root),{folderToken:'customFolder'});assert.equal(f.service.feishuSettings().folderToken,'customFolder');assert.equal(f.service.feishuSettings({mode:'default'}).folderToken,'defaultFolder');
  assert.notEqual(folderCacheKey({rootName:'行研工作台',applicationProfile:'research-custom',applicationOwnerOpenId:'ou_old'}),folderCacheKey({rootName:'行研工作台',applicationProfile:'research-custom',applicationOwnerOpenId:'ou_new'}));
  await b.configureApplication({mode:'default'});assert.equal(f.service.feishuSettings().folderToken,'defaultFolder');
 }finally{b.close();await f.close();}
});
test('PRD1956 应用配置API不回显密钥，拒绝跨站与运行中切换',async()=>{
 const f=fixture(),r=applicationRunner(),b=new FeishuBinding({store:f.store,run:r.run});f.service.binding=b;const server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${server.address().port}`;
 const put=(body,headers={})=>fetch(base+'/api/feishu-application',{method:'PUT',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});const data={mode:'custom',appId:'cli_custom123',appSecret:'credential-secret'};
 try{
  assert.equal((await put(data,{Origin:'https://evil.example'})).status,403);f.service.active.set('busy',{controller:new AbortController(),promise:Promise.resolve()});assert.equal((await put(data)).status,409);f.service.active.clear();assert.equal(r.profiles.size,0);
  const saved=await put(data);assert.equal(saved.status,200);assert.ok(!(await saved.text()).includes('credential-secret'));assert.ok(!(await(await fetch(base+'/api/feishu-application')).text()).includes('credential-secret'));assert.ok(!JSON.stringify(f.store.setting('feishu-application')).includes('credential-secret'));
 }finally{f.service.active.clear();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));b.close();await f.close();}
});

test('PRD1956 失败任务重试使用当前新应用，保留原会话与旧执行的应用快照',async()=>{
 const f=fixture(),r=applicationRunner(),b=new FeishuBinding({store:f.store,run:r.run});f.service.binding=b;f.service.cloudOnly=true;f.service.closed=true;f.service.nativeSessions={};
 try{
  const t=await f.service.createAuthorized({direction:'新应用恢复交付'});t.status='failed';t.nativeSession=true;t.nativeSessionId='same-session';t.runs=[{id:'previous-run',status:'failed'}];f.store.save(t);
  await b.configureApplication({mode:'custom',appId:'cli_newApp123',appSecret:'fake-secret'});const flow=await b.start();await b.complete(flow.flowId);
  f.service.retry(t.id,'research');const next=f.store.get(t.id);assert.equal(next.feishuApp.appId,'cli_newApp123');assert.equal(next.nativeSessionId,'same-session');assert.equal(next.runs[0].feishuApp.mode,'default');assert.equal(next.feishuRoot.applicationProfile,next.feishuApp.profile);
 }finally{b.close();await f.close();}
});
