import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==','base64');
test('PRD1951 重新绑定API严格校验、旧二维码失效、来源限制与账号更新',async()=>{
 const f=fixture();let name='账号A',openId='ou_account_a',serial=0;
 f.store.saveSetting('feishu-application',{mode:'custom',appId:'cli_rebind123',profile:'research-rebind',ownerOpenId:openId});
 const binding=new FeishuBinding({store:f.store,run:async args=>{
  const command=args[0]==='--profile'?args.slice(2):args;
  if(command[1]==='status')return {appId:'cli_rebind123',identities:{bot:{status:'ready',available:true,verified:true},user:{openId,available:true,verified:true,userName:name,scope:requiredScopes.join(' ')}}};
  if(command[1]==='qrcode'){writeFileSync(args.at(-1),png);return '';}
  if(args.includes('--device-code')){name='账号B';openId='ou_account_b';return {success:true};}
  return {device_code:'private-'+(++serial),verification_url:'https://accounts.feishu.cn/device?code='+serial,expires_in:600};
 }});f.service.binding=binding;const server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
 const post=(body,headers={})=>fetch(base+'/api/feishu-binding',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  assert.equal((await(await post({})).json()).bound,true);
  assert.equal((await post({rebind:'true'})).status,400);assert.equal((await post({rebind:true,device_code:'injection'})).status,400);assert.equal((await post({rebind:true},{Origin:'https://evil.example'})).status,403);assert.equal(serial,0);
  const first=await(await post({rebind:true})).json();assert.equal((await fetch(base+'/api/feishu-binding/qr/'+first.flowId)).status,200);
  const second=await(await post({rebind:true})).json();assert.notEqual(first.flowId,second.flowId);assert.equal((await fetch(base+'/api/feishu-binding/qr/'+first.flowId)).status,404);
  assert.equal((await(await fetch(base+'/api/feishu-binding')).json()).userName,'账号A');
  const complete=await fetch(base+'/api/feishu-binding/complete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({flowId:second.flowId})});assert.equal((await complete.json()).userName,'账号B');assert.equal(f.store.setting('feishu-application').ownerOpenId,'ou_account_b');assert.equal(f.store.setting('feishu-account').openId,'ou_account_b');assert.equal(f.store.list().length,0);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));binding.close();await f.close();}
});
