import {test} from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture, until } from './helpers.mjs';
import { FeishuBinding } from '../server/feishu-binding.mjs';
import { registrationUrl } from '../server/feishu-registration.mjs';
import { applicationRunner, registrationRunner } from './fixtures/fake-feishu-application.mjs';
import { createApp } from '../server/app.mjs';
function setup(){const f=fixture(),cli=applicationRunner(),sdk=registrationRunner(),binding=new FeishuBinding({store:f.store,run:cli.run,registerApp:sdk.registerApp});f.service.binding=binding;return {...f,cli,sdk,binding,reg:binding.registration,async close(){binding.close();await f.close();}};}

test('重复App ID冲突后更新原profile，保留默认选择和唯一配置',async()=>{
 const f=setup();try{
  const existing={appId:'cli_reused123',bound:true,openId:'ou_scanned',unionId:'on_scanned',logins:[]};
  f.cli.profiles.set('research-reused',existing);
  f.reg.start({replaceApp:true});f.sdk.approve(existing.appId);
  await until(()=>['completed','failed'].includes(f.reg.snapshot().status));
  assert.equal(f.reg.snapshot().status,'completed');
  assert.equal(f.store.setting('feishu-application').profile,'research-reused');
  assert.equal(f.cli.calls.filter(c=>c.args[0]==='profile'&&c.args[1]==='add').length,1);
  assert.equal(f.cli.calls.filter(c=>c.args[0]==='config'&&c.args[1]==='init').length,1);
  assert.equal(f.cli.profiles.get('research-reused').secret,'fixture-secret');
  assert.ok(f.cli.calls.every(c=>!c.args.includes('--use')));
  assert.equal((await f.binding.status({mode:'default'})).appId,'cli_default123');
  assert.equal(f.cli.profiles.get('research-reused'),existing);
  assert.equal(f.cli.profiles.size,1);
 }finally{await f.close();}
});

test('重复App ID更新后CLI返回错误应用时拒绝绑定和调研，不回退默认应用',async()=>{
 const f=setup();try{
  f.cli.profiles.set('research-reused',{appId:'cli_reused123',bound:true,openId:'ou_scanned'});
  f.cli.setMismatch(true);f.reg.start();f.sdk.approve('cli_reused123');await f.reg.work;
  assert.equal(f.reg.snapshot().status,'completed');
  assert.equal(f.binding.applicationSnapshot().profile,'research-reused');
  assert.equal(f.cli.profiles.size,1);
  const state=await f.binding.status();assert.equal(state.bound,false);assert.match(state.error,/应用.*不一致/);
  await assert.rejects(f.binding.requireBound(),e=>e.status===428);
 }finally{await f.close();}
});

test('扫码应用登记与个人授权分阶段，凭据仅stdin，不修改默认应用',async()=>{
 const f=setup();try{
  const flow=f.reg.start();assert.equal(flow.status,'awaiting_scan');assert.deepEqual(f.reg.start(),flow);assert.equal(f.sdk.pending.length,1);
  await until(()=>{try{return f.reg.qr(flow.flowId).length>0;}catch{return false;}});
  const opts=f.sdk.pending[0].options;
  assert.equal(opts.appId,undefined);assert.equal(opts.addons.preset,false);
  for(const scope of ['space:document:retrieve','docs:document.media:upload','docs:document.media:download','drive:file:upload','drive:file:download'])assert.ok(opts.addons.scopes.user.includes(scope));
  assert.ok(!opts.addons.scopes.user.includes('search:docs:read'));assert.ok(!opts.addons.scopes.user.includes('offline_access'));
  assert.deepEqual(opts.addons.scopes.tenant,['im:message:send_as_bot']);
  // An unused registration QR does not revoke an already verified user token.
  assert.equal((await f.binding.requireBound()).bound,true);
  await assert.rejects(f.binding.configureApplication({mode:'default'}),e=>e.status===409);
  f.sdk.approve();await f.reg.work;assert.equal(f.reg.snapshot().status,'completed');
  assert.equal(f.binding.applicationSnapshot().appId,'cli_scanned123');assert.equal((await f.binding.status()).bound,false);
  const call=f.cli.calls.find(c=>c.args[0]==='profile'&&c.args[1]==='add');
  assert.equal(call.options.input,'fixture-secret\n');assert.ok(!call.args.join(' ').includes('fixture-secret'));assert.ok(!call.args.includes('--use'));
  assert.ok(!JSON.stringify(f.store.setting('feishu-application')).includes('fixture-secret'));
  const auth=await f.binding.start();assert.equal((await f.binding.complete(auth.flowId)).bound,true);
  assert.equal((await f.binding.status({mode:'default'})).userName,'默认用户');
 }finally{await f.close();}
});

test('修复机器人权限固定当前appId，普通绑定允许重新选择应用',async()=>{
 const f=setup();try{f.store.saveSetting('feishu-application',{mode:'custom',appId:'cli_existing123',profile:'research-existing',ownerOpenId:'ou_scanned'});const repair=f.reg.start({repairBot:true});assert.equal(repair.updatingApp,true);assert.equal(f.sdk.pending.at(-1).options.appId,'cli_existing123');f.reg.cancel();f.reg.start();assert.equal(f.sdk.pending.at(-1).options.appId,undefined);}finally{await f.close();}
});

test('重新选择当前应用时更新原profile凭据且不新增配置',async()=>{
 const f=setup();try{const app={mode:'custom',appId:'cli_existing123',profile:'research-existing'};f.store.saveSetting('feishu-application',app);f.cli.profiles.set(app.profile,{appId:app.appId,bound:false,openId:'ou_scanned'});f.reg.start();f.sdk.approve(app.appId);await f.reg.work;assert.equal(f.reg.snapshot().status,'completed');assert.equal(f.binding.applicationSnapshot().profile,app.profile);assert.equal(f.cli.profiles.size,1);assert.equal(f.cli.calls.filter(c=>c.args[0]==='config').length,1);assert.ok(!f.cli.calls.some(c=>c.args[0]==='profile'&&c.args[1]==='add'));}finally{await f.close();}
});

test('选择其他已存在应用只更新对应profile，保留无关应用凭据',async()=>{
 const f=setup();try{f.cli.profiles.set('research-orphan',{appId:'cli_orphan123',bound:false});f.cli.profiles.set('research-other',{appId:'cli_other123',secret:'untouched'});f.reg.start();f.sdk.approve('cli_orphan123');await f.reg.work;assert.equal(f.reg.snapshot().status,'completed');assert.equal(f.binding.applicationSnapshot().profile,'research-orphan');assert.equal(f.cli.profiles.size,2);assert.equal(f.cli.profiles.get('research-other').secret,'untouched');assert.equal(f.cli.profiles.get('research-orphan').secret,'fixture-secret');}finally{await f.close();}
});

test('个人授权必须与本次应用登记账号一致，授权成功也不能绕过账号校验',async()=>{
 const f=setup();try{f.reg.start();f.sdk.approve('cli_next123','ou_app_admin');await f.reg.work;const app=f.binding.applicationSnapshot();assert.equal(app.ownerOpenId,'ou_app_admin');const flow=await f.binding.start();await assert.rejects(f.binding.complete(flow.flowId),e=>e.status===428&&/账号不一致/.test(e.message));assert.equal((await f.binding.status()).bound,false);assert.equal(f.binding.applicationSnapshot().appId,'cli_next123');}finally{await f.close();}
});

test('账号校验失败保留所选应用，使用登记账号重新授权后恢复',async()=>{
 const f=setup();try{f.reg.start();f.sdk.approve('cli_next123','ou_expected');await f.reg.work;const app=f.binding.applicationSnapshot();const first=await f.binding.start();await assert.rejects(f.binding.complete(first.flowId),e=>e.status===428);f.cli.profiles.get(app.profile).logins.push('ou_expected');const retry=await f.binding.start({rebind:true});assert.equal((await f.binding.complete(retry.flowId)).openId,'ou_expected');assert.equal(f.binding.applicationSnapshot().appId,'cli_next123');}finally{await f.close();}
});

test('更换账号通过新应用登记与个人授权完成，不沿用旧应用账号限制',async()=>{
 const f=setup();try{f.store.saveSetting('feishu-application',{mode:'custom',appId:'cli_old123',profile:'research-old',ownerOpenId:'ou_old'});f.reg.start();f.sdk.approve('cli_new123','ou_new');await f.reg.work;const app=f.binding.applicationSnapshot();f.cli.profiles.get(app.profile).logins.push('ou_new');const flow=await f.binding.start();assert.equal((await f.binding.complete(flow.flowId)).openId,'ou_new');assert.equal(app.ownerOpenId,'ou_new');assert.equal(app.appId,'cli_new123');}finally{await f.close();}
});

test('应用登记失败不提交新应用，原配置保留且记录失败阶段',async()=>{
 const f=setup();try{const original={mode:'custom',appId:'cli_old123',profile:'research-old',ownerOpenId:'ou_old'};f.store.saveSetting('feishu-application',original);f.reg.start();f.sdk.pending.at(-1).reject(Object.assign(new Error('network interrupted'),{code:'ECONNRESET'}));await f.reg.work;assert.equal(f.reg.snapshot().status,'failed');assert.deepEqual(f.binding.applicationSnapshot(),original);assert.ok(f.store.runtimeLogs().some(r=>r.details.phase==='app_registration'&&r.details.code==='NETWORK_ERROR'));}finally{await f.close();}
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
   f.reg.start();f.sdk.approve();await until(()=>f.reg.snapshot().status==='completed');f.store.saveSetting('feishu-application',{...f.binding.applicationSnapshot(),ownerOpenId:'ou_different'});const flow=await f.binding.start();await assert.rejects(f.binding.complete(flow.flowId),e=>e.status===428&&/账号不一致/.test(e.message));assert.equal((await f.binding.status()).bound,false);
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
 const prior=f.binding.run;f.binding.run=async(args,options)=>{if(args[0]==='profile'&&args[1]==='add')await new Promise(r=>{release=r;});return prior(args,options);};
 try{f.reg.start();f.sdk.approve();await until(()=>f.reg.snapshot().status==='saving');assert.throws(()=>f.reg.cancel(),e=>e.status===409);assert.throws(()=>f.reg.start({refresh:true}),e=>e.status===409);await assert.rejects(f.binding.configureApplication({mode:'default'}),e=>e.status===409);f.reg.close();release();await f.reg.work;assert.equal(f.binding.applicationSnapshot().mode,'default');}finally{await f.close();}
});


test('凭据保存失败明确失败并保留原配置，恢复后重新扫码可完成',async()=>{
 const f=setup();try{const original=f.binding.applicationSnapshot();f.cli.setFail(true);f.reg.start();f.sdk.approve();await f.reg.work;assert.equal(f.reg.snapshot().status,'failed');assert.deepEqual(f.binding.applicationSnapshot(),original);assert.ok(!JSON.stringify(f.reg.snapshot()).includes('fixture-secret'));f.cli.setFail(false);f.reg.start({refresh:true});f.sdk.approve();await f.reg.work;assert.equal(f.reg.snapshot().status,'completed');assert.equal(f.sdk.pending.length,2);}finally{await f.close();}
});

test('失败后刷新产生新二维码，取消和过期流程的迟到凭据不提交',async()=>{
 const f=setup();try{const first=f.reg.start();const old=f.sdk.pending.at(-1);f.reg.flow.expires=Date.now()-1;assert.equal(f.reg.snapshot().status,'expired');const next=f.reg.start({refresh:true});assert.notEqual(next.flowId,first.flowId);old.resolve({client_id:'cli_late123',client_secret:'fixture-secret',user_info:{open_id:'ou_scanned'}});f.reg.cancel();await f.reg.work;assert.equal(f.binding.applicationSnapshot().mode,'default');assert.equal(f.reg.snapshot().status,'idle');}finally{await f.close();}
});

test('凭据保存返回超时时不误报成功，重新登记复用已落盘profile',async()=>{
 const f=setup();try{const prior=f.binding.run;let timeout=true;f.binding.run=async(args,options)=>{const result=await prior(args,options);if(timeout&&args[0]==='profile'&&args[1]==='add')throw Object.assign(new Error('private storage failure'),{code:'ETIMEDOUT'});return result;};f.reg.start();f.sdk.approve('cli_timeout123');await f.reg.work;assert.equal(f.reg.snapshot().status,'failed');assert.equal(f.binding.applicationSnapshot().mode,'default');assert.ok(!JSON.stringify(f.reg.snapshot()).includes('private storage failure'));timeout=false;f.reg.start({refresh:true});f.sdk.approve('cli_timeout123');await f.reg.work;assert.equal(f.reg.snapshot().status,'completed');assert.equal(f.cli.profiles.size,1);assert.equal(f.binding.applicationSnapshot().appId,'cli_timeout123');}finally{await f.close();}
});

test('注册二维码始终写入临时工作目录内的相对路径',async()=>{
 const f=setup();try{
  const flow=f.reg.start();await until(()=>{try{return f.reg.qr(flow.flowId).length>0;}catch{return false;}});
  const qrCall=f.cli.calls.find(call=>call.args[1]==='qrcode');
  assert.ok(qrCall);assert.equal(qrCall.args.at(-1),'./qrcode.png');assert.ok(qrCall.options.cwd);
  assert.equal(f.reg.flow.qrPath,resolve(qrCall.options.cwd,'qrcode.png'));
 }finally{await f.close();}
});

test('注册二维码生成失败时给出明确错误而不是误报网页已完成配置',async()=>{
 const f=setup();try{
  f.cli.setQrFailure(true);f.reg.start();await until(()=>f.reg.snapshot().status==='failed');
  const state=f.reg.snapshot();assert.equal(state.failureCode,'LARK_QRCODE_GENERATION_FAILED');
  assert.match(state.error,/二维码生成失败/);assert.doesNotMatch(state.error,/网页可能已完成配置/);
  assert.ok(f.store.runtimeLogs().some(row=>row.event==='feishu.registration.failed'&&row.details.phase==='qr_generation'&&row.details.code==='LARK_QRCODE_GENERATION_FAILED'));
  assert.equal(f.store.setting('feishu-application'),null);
 }finally{await f.close();}
});
