import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { FeishuBinding, requiredScopes } from '../server/feishu-binding.mjs';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==','base64');
const status = (bound, scope = requiredScopes.join(' ')) => ({ identities: { bot: { status: 'ready', available: true, verified: true, appName: '行研工作台助手' }, user: { available: bound, verified: bound, userName: '验收用户', scope } } });

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

test('PRD1872 申请平台所需全部生态权限，但不申请目录读取/搜索权限', async () => {
  const writeScopes = 'auth:user.id:read contact:user.basic_profile:readonly docx:document:create docx:document:write_only docx:document:readonly docs:document:import docs:document.media:upload docs:document.media:download drive:drive.metadata:readonly drive:file:upload drive:file:download space:folder:create offline_access';
  assert.ok(!requiredScopes.includes('space:document:retrieve')); assert.ok(!requiredScopes.includes('search:docs:read'));
  for (const scope of ['docs:document.media:upload','docs:document.media:download','drive:file:upload','drive:file:download']) assert.ok(requiredScopes.includes(scope));
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

test('FR02 机器人身份不可用时保留文档绑定但明确标记通知未就绪', async () => {
  const binding = new FeishuBinding({ run: async () => ({
    appId: 'cli_fixture',
    identities: {
      bot: { status: 'missing', available: false, verified: false },
      user: { available: true, verified: true, openId: 'ou_fixture', scope: requiredScopes.join(' ') },
    },
  }) });
  try {
    const state = await binding.status();
    assert.equal(state.bound, true);
    assert.equal(state.notificationReady, false);
  } finally { binding.close(); }
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
test('PRD1951 重新绑定生成失败不会注销原账号，确认中重复请求恢复同一流程',async()=>{
 let fail=true,finish;const binding=new FeishuBinding({run:async args=>{
  if(args[1]==='status')return status(true);
  if(args[1]==='qrcode'){if(fail)throw new Error('private-error');writeFileSync(args.at(-1),png);return '';}
  if(args.includes('--device-code')){await new Promise(resolve=>{finish=resolve;});return {success:true};}
  return {device_code:'private-code',verification_url:'https://accounts.feishu.cn/device?code=locking',expires_in:600};
 }});
 try{
  await assert.rejects(binding.start({rebind:true}),e=>e.status===503&&!e.message.includes('private'));assert.equal((await binding.status()).bound,true);
  fail=false;const flow=await binding.start({rebind:true});const completed=binding.complete(flow.flowId);const duplicate=await binding.start({rebind:true});assert.equal(duplicate.flowId,flow.flowId);assert.equal(duplicate.autoCompleting,false);assert.equal(binding.flow.id,flow.flowId);finish();assert.equal((await completed).bound,true);
 }finally{binding.close();}
});

test('PRD1990 二维码显示授权应用，确认固定使用发起时的profile且不创建应用', async () => {
 let selected={mode:'custom',appId:'cli_personal123',profile:'research-fixture'},bound=false;const calls=[];
 const binding=new FeishuBinding({store:{setting:key=>key==='feishu-application'?selected:null},run:async args=>{
  calls.push(args);assert.deepEqual(args.slice(0,2),['--profile','research-fixture']);const cmd=args.slice(2);
  if(cmd[1]==='status')return {...status(bound),appId:'cli_personal123',identities:{...status(bound).identities,bot:{appName:'个人授权应用'}}};
  if(cmd[0]==='contact')return {ok:true,data:{user:{union_id:'on_fixture'}}};
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

test('本机DPoP或用户授权失效时返回可自动执行的恢复动作',async()=>{
 let result={
  appId:'cli_default123',
  dpopKeyStatus:'missing',
  identities:{
   bot:{status:'ready',available:true},
   user:{status:'missing',available:false,tokenStatus:'needs_refresh',message:'DPoP key unavailable or inconsistent',scope:requiredScopes.join(' ')},
  },
 };
 const binding=new FeishuBinding({run:async()=>result});
 try{
  let state=await binding.status();
  assert.equal(state.bound,false);
  assert.deepEqual(state.recovery,{
   code:'LARK_DPOP_KEY_UNAVAILABLE',
   action:'authorize',
   automatic:true,
   message:'本机飞书登录密钥不可用，将自动重新发起扫码授权；完成扫码后会自动恢复。',
  });
  result={...result,dpopKeyStatus:'available',identities:{...result.identities,user:{...result.identities.user,available:true,verified:true,tokenStatus:'valid'}}};
  state=await binding.status();assert.equal(state.bound,true);
 }finally{binding.close();}
});

test('PRD1872 插件专用profile可切换Bearer兼容登录，不传全局dpop参数',async()=>{
 const calls=[];const selected={mode:'custom',appId:'cli_compat123',profile:'research-compat'};
 const binding=new FeishuBinding({store:{setting:key=>key==='feishu-application'?selected:null},run:async args=>{
  calls.push(args);const cmd=args.slice(2);
  if(cmd[0]==='config')return {ok:true};
  if(cmd[0]==='auth'&&cmd[1]==='logout')return {ok:true,loggedOut:true};
  if(cmd[0]==='auth'&&cmd[1]==='status')return {appId:'cli_compat123',dpopKeyStatus:'missing',identities:{bot:{status:'ready',available:true,verified:true},user:{available:false,verified:false,tokenStatus:'needs_refresh'}}};
  if(cmd[0]==='auth'&&cmd[1]==='qrcode'){writeFileSync(cmd.at(-1),png);return '';}
  return {device_code:'private-compatible',verification_url:'https://accounts.feishu.cn/device?code=compatible',expires_in:600};
 }});
 try{
  const flow=await binding.start({rebind:true,compatibility:true});
  assert.equal(flow.compatibilityMode,true);
  const config=calls.find(args=>args.slice(2,5).join(' ')==='config set dpop');
  assert.deepEqual(config.slice(0,2),['--profile','research-compat']);
  assert.equal(config[5],'disabled');
  assert.ok(calls.some(args=>args.slice(2,5).join(' ')==='auth logout --json'));
 }finally{binding.close();}
});

test('扫码仍在等待时不阻塞页面，后台完成授权并自动切回已绑定状态',async()=>{
 let bound=false,finish;const binding=new FeishuBinding({run:async args=>{
  if(args[1]==='status')return {appId:'cli_default123',dpopKeyStatus:bound?'available':'missing',identities:{bot:{status:'ready'},user:{...status(bound).identities.user,tokenStatus:bound?'valid':'needs_refresh'}}};
  if(args[1]==='qrcode'){writeFileSync(args.at(-1),png);return '';}
  if(args.includes('--device-code'))return new Promise(resolve=>{finish=()=>{bound=true;resolve({ok:true});};});
  return {device_code:'private-auto',verification_url:'https://accounts.feishu.cn/device?code=auto',expires_in:600};
 }});
 try{
  const flow=await binding.start();
  const completed=binding.autoComplete(flow.flowId);
  while(!finish)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(binding.flow.autoCompleting,true);
  const duplicate=await binding.start({rebind:true});
  assert.equal(duplicate.flowId,flow.flowId);
  assert.equal(duplicate.autoCompleting,true);
  const polling=await binding.status();
  assert.equal(polling.flowId,flow.flowId);
  assert.equal(polling.autoCompleting,true);
  finish();
  assert.equal((await completed).bound,true);
  assert.equal((await binding.status()).bound,true);
 }finally{binding.close();}
});
