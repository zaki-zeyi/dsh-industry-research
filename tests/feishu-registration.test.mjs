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
  const opts=f.sdk.pending[0].options;assert.equal(opts.appId,undefined);assert.notEqual(opts.createOnly,true);assert.equal(opts.addons.preset,false);assert.ok(!opts.addons.scopes.user.includes('space:document:retrieve'));assert.ok(!opts.addons.scopes.user.includes('search:docs:read'));assert.ok(!opts.addons.scopes.user.includes('offline_access'));assert.deepEqual(opts.addons.scopes.tenant,['im:message:send_as_bot']);
  assert.equal((await f.binding.status()).userName,'默认用户');await assert.rejects(f.binding.requireBound(),e=>e.status===428);await assert.rejects(f.binding.configureApplication({mode:'default'}),e=>e.status===409);
  f.sdk.approve();await until(()=>f.reg.snapshot().status==='completed');const info=f.reg.snapshot();assert.equal(info.appId,'cli_scanned123');assert.ok(!JSON.stringify(info).includes('fixture-secret'));const call=f.cli.calls.find(c=>c.args[0]==='profile');assert.equal(call.options.input,'fixture-secret\n');assert.ok(!call.args.join(' ').includes('fixture-secret'));assert.ok(!call.args.includes('--use'));assert.ok(!JSON.stringify(f.store.setting('feishu-application')).includes('fixture-secret'));assert.equal(f.binding.applicationSnapshot().ownerOpenId,'ou_scanned');assert.equal((await f.binding.status()).bound,false);
  const auth=await f.binding.start();assert.equal((await f.binding.complete(auth.flowId)).bound,true);assert.equal((await f.binding.status({mode:'default'})).userName,'默认用户');
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
 const prior=f.binding.run;f.binding.run=async(args,options)=>{if(args[0]==='profile')await new Promise(r=>{release=r;});return prior(args,options);};
 try{f.reg.start();f.sdk.approve();await until(()=>f.reg.snapshot().status==='saving');assert.throws(()=>f.reg.cancel(),e=>e.status===409);assert.throws(()=>f.reg.start({refresh:true}),e=>e.status===409);await assert.rejects(f.binding.configureApplication({mode:'default'}),e=>e.status===409);f.reg.close();release();await f.reg.work;assert.equal(f.binding.applicationSnapshot().mode,'default');}finally{await f.close();}
});
