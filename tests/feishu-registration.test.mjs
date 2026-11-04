import {test} from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './helpers.mjs';
import { FeishuBinding } from '../server/feishu-binding.mjs';
import { registrationUrl } from '../server/feishu-registration.mjs';
import { applicationRunner, registrationRunner } from './fixtures/fake-feishu-application.mjs';
import { createApp } from '../server/app.mjs';
function setup(){const f=fixture(),cli=applicationRunner(),sdk=registrationRunner(),binding=new FeishuBinding({store:f.store,run:cli.run,registerApp:sdk.registerApp});f.service.binding=binding;return {...f,cli,sdk,binding,reg:binding.registration,async close(){binding.close();await f.close();}};}
test('PRD2036 官方扫码选择/创建应用，凭据仅stdin，不修改默认配置，继续同账号个人授权',async()=>{
 const f=setup();try{
  const flow=f.reg.start();assert.equal(flow.status,'awaiting_scan');assert.deepEqual(f.reg.start(),flow);assert.equal(f.sdk.pending.length,1);await until(()=>{try{return f.reg.qr(flow.flowId).length>0;}catch{return false;}});
  const opts=f.sdk.pending[0].options;assert.equal(opts.appId,undefined);assert.notEqual(opts.createOnly,true);assert.equal(opts.addons.preset,false);assert.ok(!opts.addons.scopes.user.includes('space:document:retrieve'));assert.ok(!opts.addons.scopes.user.includes('search:docs:read'));assert.ok(!opts.addons.scopes.user.includes('offline_access'));for(const scope of ['docs:document.media:upload','docs:document.media:download','drive:file:upload','drive:file:download'])assert.ok(opts.addons.scopes.user.includes(scope));assert.deepEqual(opts.addons.scopes.tenant,['im:message:send_as_bot']);
  assert.equal((await f.binding.status()).userName,'默认用户');await assert.rejects(f.binding.requireBound(),e=>e.status===428);await assert.rejects(f.binding.configureApplication({mode:'default'}),e=>e.status===409);
  f.sdk.approve();await until(()=>f.reg.snapshot().status==='completed');const info=f.reg.snapshot();assert.equal(info.appId,'cli_scanned123');assert.ok(!JSON.stringify(info).includes('fixture-secret'));const call=f.cli.calls.find(c=>c.args[0]==='profile');assert.equal(call.options.input,'fixture-secret\n');assert.ok(!call.args.join(' ').includes('fixture-secret'));assert.ok(!call.args.includes('--use'));assert.ok(!JSON.stringify(f.store.setting('feishu-application')).includes('fixture-secret'));assert.equal(f.binding.applicationSnapshot().ownerOpenId,undefined);assert.equal((await f.binding.status()).bound,false);
  assert.equal(f.store.setting('feishu-account'),null);assert.equal(f.binding.pendingApplicationOperation().mode,'any');
  const auth=await f.binding.start();assert.equal((await f.binding.complete(auth.flowId)).bound,true);assert.equal(f.store.setting('feishu-account').openId,'ou_scanned');assert.equal(f.store.setting('feishu-account').unionId,'on_scanned');assert.equal(f.binding.applicationSnapshot().ownerOpenId,'ou_scanned');assert.equal(f.binding.pendingApplicationOperation(),null);
 }finally{await f.close();}
});
test('FR02 更新已有自定义应用时直接携带 appId，进入权限差异确认而非通用选择页',async()=>{
 const f=setup();try{
  const app={mode:'custom',appId:'cli_existing123',profile:'research-existing',ownerOpenId:'ou_scanned'};
  f.store.saveSetting('feishu-application',app);
  const flow=f.reg.start();assert.equal(flow.updatingApp,true);assert.equal(flow.appId,'cli_existing123');
  const pending=f.sdk.pending.at(-1);assert.equal(pending.options.appId,'cli_existing123');assert.equal(new URL(flow.authorizationUrl).searchParams.get('clientID'),'cli_existing123');
  pending.options.onStatusChange({status:'polling'});assert.equal(f.reg.snapshot().remoteStatus,'polling');
  f.reg.cancel();
  const replaceFlow=f.reg.start({replaceApp:true});assert.equal(replaceFlow.updatingApp,false);assert.equal(replaceFlow.appId,undefined);
  assert.equal(f.sdk.pending.at(-1).options.appId,undefined);
  f.reg.cancel();
 }finally{await f.close();}
});
test('FR02 更换应用允许应用管理账号不同，个人授权完成后仍严格保持原账号',async()=>{
 const f=setup();try{
  f.store.saveSetting('feishu-application',{mode:'custom',appId:'cli_existing123',profile:'research-existing',ownerOpenId:'ou_personal_old_app'});
  f.store.saveSetting('feishu-account',{openId:'ou_personal_old_app',appId:'cli_existing123',unionId:'on_personal',userName:'原账号'});
  f.cli.profiles.set('research-existing',{appId:'cli_existing123',bound:true,userName:'原账号',openId:'ou_personal_old_app',unionId:'on_personal',logins:[]});
  f.reg.start({replaceApp:true});
  f.sdk.approve('cli_next123','ou_app_admin');
  await until(()=>f.reg.snapshot().status==='completed');
  const app=f.store.setting('feishu-application');
  assert.equal(app.registeredByOpenId,'ou_app_admin');
  assert.equal(app.ownerOpenId,undefined);
  assert.equal(f.binding.pendingApplicationOperation().mode,'same');
  f.cli.profiles.get(app.profile).logins.push({openId:'ou_personal_new_app',unionId:'on_personal'});
  const flow=await f.binding.start();const state=await f.binding.complete(flow.flowId);
  assert.equal(state.openId,'ou_personal_new_app');
  assert.equal(f.store.setting('feishu-account').openId,'ou_personal_new_app');
  assert.equal(f.store.setting('feishu-account').unionId,'on_personal');
  assert.equal(f.store.setting('feishu-application').ownerOpenId,'ou_personal_new_app');
  assert.equal(f.binding.pendingApplicationOperation(),null);
 }finally{await f.close();}
});
test('FR02 更换应用授权成另一账号时回滚原应用，更换账号同账号时回滚原账号',async()=>{
 const f=setup();try{
  const original={mode:'custom',appId:'cli_existing123',profile:'research-existing',ownerOpenId:'ou_personal_old_app'};
  const account={openId:'ou_personal_old_app',appId:'cli_existing123',unionId:'on_personal',userName:'原账号'};
  f.store.saveSetting('feishu-application',original);f.store.saveSetting('feishu-account',account);
  f.cli.profiles.set('research-existing',{appId:'cli_existing123',bound:true,userName:'原账号',openId:'ou_personal_old_app',unionId:'on_personal',logins:[]});

  f.reg.start({replaceApp:true});f.sdk.approve('cli_next123','ou_admin');
  await until(()=>f.reg.snapshot().status==='completed');
  const replaceApp=f.store.setting('feishu-application');
  f.cli.profiles.get(replaceApp.profile).logins.push({openId:'ou_other_new_app',unionId:'on_other'});
  const replaceFlow=await f.binding.start();
  await assert.rejects(f.binding.complete(replaceFlow.flowId),e=>e.status===409&&e.code==='LARK_REPLACE_APP_ACCOUNT_CHANGED');
  assert.deepEqual(f.store.setting('feishu-application'),original);
  assert.deepEqual(f.store.setting('feishu-account'),account);
  assert.equal(f.binding.pendingApplicationOperation(),null);

  f.reg.start({replaceApp:true,accountRebind:true});f.sdk.approve('cli_rebind123','ou_admin');
  await until(()=>f.reg.snapshot().status==='completed');
  const rebindApp=f.store.setting('feishu-application');
  f.cli.profiles.get(rebindApp.profile).logins.push({openId:'ou_personal_new_app',unionId:'on_personal'});
  const rebindFlow=await f.binding.start();
  await assert.rejects(f.binding.complete(rebindFlow.flowId),e=>e.status===409&&e.code==='LARK_REBIND_SAME_ACCOUNT');
  assert.deepEqual(f.store.setting('feishu-application'),original);
  assert.deepEqual(f.store.setting('feishu-account'),account);
  assert.equal(f.binding.pendingApplicationOperation(),null);
 }finally{await f.close();}
});
test('FR02 更换账号授权成新账号后切换应用与个人身份',async()=>{
 const f=setup();try{
  f.store.saveSetting('feishu-application',{mode:'custom',appId:'cli_existing123',profile:'research-existing',ownerOpenId:'ou_personal_old_app'});
  f.store.saveSetting('feishu-account',{openId:'ou_personal_old_app',appId:'cli_existing123',unionId:'on_personal',userName:'原账号'});
  f.cli.profiles.set('research-existing',{appId:'cli_existing123',bound:true,userName:'原账号',openId:'ou_personal_old_app',unionId:'on_personal',logins:[]});
  f.reg.start({replaceApp:true,accountRebind:true});f.sdk.approve('cli_rebind123','ou_admin');
  await until(()=>f.reg.snapshot().status==='completed');
  const app=f.store.setting('feishu-application');
  f.cli.profiles.get(app.profile).logins.push({openId:'ou_new_person_new_app',unionId:'on_new_person'});
  const flow=await f.binding.start();const state=await f.binding.complete(flow.flowId);
  assert.equal(state.openId,'ou_new_person_new_app');
  assert.equal(f.store.setting('feishu-account').openId,'ou_new_person_new_app');
  assert.equal(f.store.setting('feishu-account').unionId,'on_new_person');
  assert.equal(f.store.setting('feishu-application').ownerOpenId,'ou_new_person_new_app');
  assert.equal(f.binding.pendingApplicationOperation(),null);
 }finally{await f.close();}
});
test('PRD1917 登记失败不能用旧个人授权冒充权限更新成功',async()=>{
 const f=setup();try{
  const app={mode:'custom',appId:'cli_existing123',profile:'research-existing',ownerOpenId:'ou_scanned'};
  f.store.saveSetting('feishu-application',app);
  f.cli.profiles.set('research-existing',{appId:'cli_existing123',bound:true,userName:'已有用户'});
  f.reg.start();const pending=f.sdk.pending.at(-1);
  pending.options.onStatusChange({status:'polling'});
  pending.reject(Object.assign(new Error('registration response interrupted'),{code:'ERR_NETWORK'}));
  await until(()=>f.reg.snapshot().status==='failed');
  const done=f.reg.snapshot();
  assert.equal(done.failureCode,'ERR_NETWORK');
  assert.equal(f.store.setting('feishu-application').permissionUpdatedAt,undefined);
  assert.equal(f.store.setting('feishu-application').profile,'research-existing');
  assert.equal(f.cli.calls.filter(c=>c.args[0]==='profile').length,0);
 }finally{await f.close();}
});
test('PRD2036 取消和刷新失效旧二维码，迟到结果不改变原应用，失败信息不泄露凭据',async()=>{
 const f=setup();try{
  const first=f.reg.start();const old=f.sdk.pending[0];const second=f.reg.start({refresh:true});assert.notEqual(first.flowId,second.flowId);assert.throws(()=>f.reg.qr(first.flowId),/失效/);old.resolve({client_id:'cli_old123',client_secret:'secret-old',user_info:{open_id:'ou_old',tenant_brand:'feishu'}});await Promise.resolve();assert.equal(f.binding.applicationSnapshot().mode,'default');
  f.reg.cancel();f.sdk.approve();await Promise.resolve();assert.equal(f.reg.snapshot().status,'idle');assert.equal(f.binding.applicationSnapshot().mode,'default');
  f.reg.start();f.sdk.pending.at(-1).reject(Object.assign(new Error('fixture-secret'),{code:'access_denied'}));await until(()=>f.reg.snapshot().status==='failed');assert.match(f.reg.snapshot().error,/取消/);assert.ok(!JSON.stringify(f.reg.snapshot()).includes('fixture-secret'));
 }finally{await f.close();}
});
test('PRD2036 超时、非法URL、非法结果与本机保存失败不切换应用',async()=>{
 assert.equal(registrationUrl('https://open.feishu.cn/page/cli?user_code=abc'),true);assert.equal(registrationUrl('https://open.feishu.cn/page/launcher?user_code=abc'),true);
 for(const url of ['http://open.feishu.cn/page/cli?user_code=x','https://open.feishu.cn.evil.com/page/cli?user_code=x','https://user@open.feishu.cn/page/cli?user_code=x','https://open.feishu.cn/page/cli','https://open.feishu.cn:44/page/cli?user_code=x'])assert.equal(registrationUrl(url),false);
 const f=setup();try{
  const flow=f.reg.start();f.reg.flow.expires=Date.now()-1;assert.equal(f.reg.snapshot().status,'expired');assert.throws(()=>f.reg.qr(flow.flowId),/失效/);assert.equal(f.binding.applicationSnapshot().mode,'default');
  f.reg.start();f.cli.setFail(true);f.sdk.approve();await until(()=>f.reg.snapshot().status==='failed');assert.equal(f.binding.applicationSnapshot().mode,'default');assert.ok(!JSON.stringify(f.reg.snapshot()).includes('fixture-secret'));
  f.reg.start();f.sdk.pending.at(-1).resolve({client_id:'invalid',client_secret:'secret'});await until(()=>f.reg.snapshot().status==='failed');assert.equal(f.binding.applicationSnapshot().mode,'default');
 }finally{await f.close();}
});
test('PRD2036 个人授权与扫码应用登录账号不一致时拒绝绑定',async()=>{
 const f=setup();try{
   f.reg.start();f.sdk.approve();await until(()=>f.reg.snapshot().status==='completed');f.binding.clearPendingApplicationOperation();f.store.saveSetting('feishu-application',{...f.binding.applicationSnapshot(),ownerOpenId:'ou_different'});const flow=await f.binding.start();await assert.rejects(f.binding.complete(flow.flowId),e=>e.status===428&&/账号不一致/.test(e.message));assert.equal((await f.binding.status()).bound,false);
 }finally{await f.close();}
});
test('PRD2036 应用绑定API校验、跨站限制、运行中保护、二维码与取消',async()=>{
 const f=setup(),server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}/api/feishu-registration`;
 const post=(body={},headers={})=>fetch(base,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  assert.equal((await post({},{Origin:'https://evil.example'})).status,403);assert.equal((await post({appSecret:'inject'})).status,400);f.service.active.set('busy',{});assert.equal((await post()).status,409);f.service.active.clear();
  const response=await post();assert.equal(response.headers.get('cache-control'),'no-store');const flow=await response.json();await until(()=>{try{return f.reg.qr(flow.flowId);}catch{return false;}});assert.equal((await fetch(base+'/qr/'+flow.flowId)).status,200);assert.equal((await fetch(base,{method:'DELETE',headers:{Origin:'https://evil.example'}})).status,403);assert.equal((await fetch(base,{method:'DELETE'})).status,200);assert.equal((await fetch(base+'/qr/'+flow.flowId)).status,404);assert.equal((await(await fetch(base)).json()).status,'idle');
 }finally{f.service.active.clear();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}
});

test('PRD2036 保存凭据期间拒绝取消和刷新，关闭后迟到保存不切换应用',async()=>{
 const f=setup();let release;
 const prior=f.binding.run;f.binding.run=async(args,options)=>{if(args[0]==='profile')await new Promise(r=>{release=r;});return prior(args,options);};
 try{f.reg.start();f.sdk.approve();await until(()=>f.reg.snapshot().status==='saving');assert.throws(()=>f.reg.cancel(),e=>e.status===409);assert.throws(()=>f.reg.start({refresh:true}),e=>e.status===409);await assert.rejects(f.binding.configureApplication({mode:'default'}),e=>e.status===409);f.reg.close();release();await f.reg.work;assert.equal(f.binding.applicationSnapshot().mode,'default');}finally{await f.close();}
});
