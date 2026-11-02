import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==','base64');
const status = (bound, scope = requiredScopes.join(' ')) => ({ identities: { user: { available: bound, verified: bound, userName: '验收用户', scope } } });

test('PRD1907 绑定只认服务端验证的用户授权和所需scope，缺CLI失败关闭且不泄露凭据', async () => {
  for (const raw of [status(false), status(true, ''), { verified: true, identities: { bot: { available: true, verified: true } } }]) {
    const binding = new FeishuBinding({ run: async () => raw }); assert.equal((await binding.status()).bound, false); await assert.rejects(binding.requireBound(), e => e.status === 428);
  }
  const binding = new FeishuBinding({ run: async () => { throw new Error('device-secret token-secret'); } });
  const state = await binding.status(); assert.equal(state.bound, false); assert.ok(!JSON.stringify(state).includes('secret')); await assert.rejects(binding.start(), e => !e.message.includes('secret'));
});
test('PRD1907 二维码split flow、并发幂等、服务端完成与敏感字段隔离', async () => {
  let bound = false, logins = 0; const calls = [];
  const binding = new FeishuBinding({ run: async args => {
    calls.push(args);
    if (args[1] === 'status') return status(bound);
    if (args[1] === 'qrcode') { writeFileSync(args.at(-1), png); return ''; }
    if (args.includes('--no-wait')) { logins++; return { device_code: 'private-device-code', verification_url: 'https://accounts.feishu.cn/device?code=fixture', expires_in: 600 }; }
    if (args.includes('--device-code')) { bound = true; return { success: true }; }
  } });
  try {
    const [a,b] = await Promise.all([binding.start(), binding.start()]); assert.deepEqual(a,b); assert.equal(logins,1); assert.ok(!JSON.stringify(a).includes('private-device-code')); assert.equal(binding.qr(a.flowId).length,png.length);
    assert.equal((await binding.start()).flowId,a.flowId); assert.equal(calls.filter(a=>a.includes('--device-code')).length,0);
    await assert.rejects(binding.complete('wrong-flow'), /过期/); assert.equal((await binding.complete(a.flowId)).bound,true); assert.throws(()=>binding.qr(a.flowId),/失效/);
    assert.equal((await binding.start()).bound,true); assert.equal(logins,1);
  } finally { binding.close(); }
});
test('PRD1907 过期授权需重新发起，不接受非官方URL与假二维码', async () => {
  let serial=0;
  const binding = new FeishuBinding({ run: async args => {
    if(args[1]==='status') return status(false);
    if(args[1]==='qrcode') { writeFileSync(args.at(-1),'not png'); return ''; }
    return { device_code: 'secret-'+serial++, verification_url: 'https://accounts.feishu.cn/device?code='+serial, expires_in:600 };
  }});
  try { const first=await binding.start(); assert.throws(()=>binding.qr(first.flowId),/格式/); binding.flow.expires=Date.now()-1; await assert.rejects(binding.complete(first.flowId),/过期/); const second=await binding.start(); assert.notEqual(first.flowId,second.flowId); }
  finally { binding.close(); }
  const bad=new FeishuBinding({run:async args=>args[1]==='status'?status(false):{device_code:'secret',verification_url:'https://evil.example/authorize'}}); await assert.rejects(bad.start(),/无法发起/);
});

test('PRD1915 缺少目录读取/搜索权限仍可绑定，授权请求不申请这两项', async () => {
  const writeScopes = 'docx:document:create docx:document:write_only docx:document:readonly docs:document:import drive:drive.metadata:readonly space:folder:create offline_access';
  assert.ok(!requiredScopes.includes('space:document:retrieve')); assert.ok(!requiredScopes.includes('search:docs:read'));
  const loggedIn = new FeishuBinding({ run: async () => status(true, writeScopes) });
  assert.equal((await loggedIn.requireBound()).bound, true); assert.equal((await loggedIn.start()).bound, true);
  let grant;
  const binding = new FeishuBinding({ run: async args => {
    if (args[1] === 'status') return status(false);
    if (args[1] === 'qrcode') { writeFileSync(args.at(-1), png); return ''; }
    grant = args[args.indexOf('--scope') + 1]; return { device_code: 'private', verification_url: 'https://accounts.feishu.cn/device?code=write-only', expires_in: 600 };
  } });
  try { await binding.start(); assert.ok(!grant.includes('space:document:retrieve')); assert.ok(!grant.includes('search:docs:read')); }
  finally { binding.close(); }
});

test('回归：macOS临时二维码路径通过指定CLI工作目录落在允许根内', async () => {
  let qrOptions, qrPath;
  const binding = new FeishuBinding({ run: async (args, options) => {
    if (args[1] === 'status') return status(false);
    if (args[1] === 'qrcode') { qrOptions = options; qrPath = args.at(-1); assert.equal(dirname(qrPath), options.cwd); writeFileSync(qrPath, png); return ''; }
    return { device_code: 'private', verification_url: 'https://accounts.feishu.cn/device?code=path-test', expires_in: 600 };
  } });
  try { const flow = await binding.start(); assert.ok(qrOptions.cwd); assert.equal(binding.qr(flow.flowId).length, png.length); }
  finally { binding.close(); }
});

test('PRD1951 已绑定也可并发幂等重新绑定，新二维码替换旧流程，确认后切换账号', async () => {
  let userName='原账号', issued=0;const calls=[];
  const binding=new FeishuBinding({run:async args=>{
    calls.push(args);
    if(args[1]==='status')return {identities:{user:{...status(true).identities.user,userName}}};
    if(args[1]==='qrcode'){writeFileSync(args.at(-1),png);return '';}
    if(args.includes('--device-code')){assert.equal(args[args.indexOf('--device-code')+1],'private-2');userName='新账号';return {success:true};}
    issued++;return {device_code:'private-'+issued,verification_url:'https://accounts.feishu.cn/device?code=rebind-'+issued,expires_in:600};
  }});
  try{
    assert.equal((await binding.start()).bound,true);assert.equal(issued,0);
    const [first,duplicate]=await Promise.all([binding.start({rebind:true}),binding.start({rebind:true})]);assert.deepEqual(first,duplicate);assert.equal(issued,1);assert.equal(first.rebind,true);assert.equal((await binding.status()).userName,'原账号');
    const fresh=await binding.start({rebind:true});assert.notEqual(first.flowId,fresh.flowId);assert.notEqual(first.authorizationUrl,fresh.authorizationUrl);assert.throws(()=>binding.qr(first.flowId),/失效/);await assert.rejects(binding.complete(first.flowId),/过期/);
    assert.ok(!JSON.stringify(fresh).includes('private-'));assert.equal((await binding.complete(fresh.flowId)).userName,'新账号');assert.equal((await binding.status()).userName,'新账号');assert.ok(!calls.some(a=>a.includes('logout')));
  }finally{binding.close();}
});
test('PRD1951 重新绑定生成失败不会注销原账号，确认中不允许替换流程',async()=>{
 let fail=true,finish;const binding=new FeishuBinding({run:async args=>{
  if(args[1]==='status')return status(true);
  if(args[1]==='qrcode'){if(fail)throw new Error('private-error');writeFileSync(args.at(-1),png);return '';}
  if(args.includes('--device-code')){await new Promise(resolve=>{finish=resolve;});return {success:true};}
  return {device_code:'private-code',verification_url:'https://accounts.feishu.cn/device?code=locking',expires_in:600};
 }});
 try{
  await assert.rejects(binding.start({rebind:true}),e=>e.status===503&&!e.message.includes('private'));assert.equal((await binding.status()).bound,true);
  fail=false;const flow=await binding.start({rebind:true});const completed=binding.complete(flow.flowId);await assert.rejects(binding.start({rebind:true}),e=>e.status===409);assert.equal(binding.flow.id,flow.flowId);finish();assert.equal((await completed).bound,true);
 }finally{binding.close();}
});

test('PRD1990 二维码显示授权应用，确认固定使用发起时的profile且不创建应用', async () => {
 let selected={mode:'custom',appId:'cli_personal123',profile:'research-fixture'},bound=false;const calls=[];
 const binding=new FeishuBinding({store:{setting:()=>selected},run:async args=>{
  calls.push(args);assert.deepEqual(args.slice(0,2),['--profile','research-fixture']);const cmd=args.slice(2);
  if(cmd[1]==='status')return {...status(bound),appId:'cli_personal123',identities:{...status(bound).identities,bot:{appName:'个人授权应用'}}};
  if(cmd[1]==='qrcode'){writeFileSync(cmd.at(-1),png);return '';}
  if(cmd.includes('--device-code')){bound=true;return {success:true};}
  return {device_code:'private-code',verification_url:'https://accounts.feishu.cn/device?code=personal',expires_in:600};
 }});
 try{const flow=await binding.start();assert.equal(flow.appId,'cli_personal123');assert.equal(flow.appName,'个人授权应用');selected={mode:'default'};assert.equal((await binding.complete(flow.flowId)).bound,true);assert.ok(calls.every(args=>!args.includes('config')&&!args.includes('init')));}
 finally{binding.close();}
});

test('PRD1990 默认应用在授权途中变更时不误报绑定成功',async()=>{
 let changed=false;const binding=new FeishuBinding({run:async args=>{
  if(args[1]==='status')return {...status(changed),appId:changed?'cli_changed123':'cli_original123'};
  if(args[1]==='qrcode'){writeFileSync(args.at(-1),png);return '';}
  if(args.includes('--device-code')){changed=true;return {success:true};}
  return {device_code:'private-code',verification_url:'https://accounts.feishu.cn/device?code=changed',expires_in:600};
 }});
 try{const flow=await binding.start();await assert.rejects(binding.complete(flow.flowId),e=>e.status===409&&/应用已发生变化/.test(e.message));}finally{binding.close();}
});
