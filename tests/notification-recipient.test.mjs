import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { FeishuBinding } from '../server/feishu-binding.mjs';
import { applicationRunner, registrationRunner } from './fixtures/fake-feishu-application.mjs';
import { briefingTask } from '../server/briefings.mjs';
import { BriefingNotifications } from '../server/briefing-notifications.mjs';
import { InternalMaterialNotifications } from '../server/internal-notifications.mjs';

test('真实绑定状态返回openId，新日报创建时保存通知接收人', async () => {
  const f=fixture(),cli=applicationRunner(),binding=new FeishuBinding({store:f.store,run:cli.run});
  f.service.binding=binding;f.service.cloudOnly=true;f.service.closed=true;
  try {
    assert.equal((await binding.requireBound()).openId,'ou_scanned');
    const task=await f.service.createAuthorized(briefingTask({kind:'daily',companies:['测试公司'],dimensions:['融资'],sources:['公司官网'],requirements:''}));
    assert.equal(task.notificationRecipient,'ou_scanned');assert.equal(task.notificationApp.appId,'cli_default123');
    assert.equal(f.store.get(task.id).notificationRecipient,'ou_scanned');
  }finally{binding.close();await f.close();}
});

for(const [kind,Notifications] of [['daily',BriefingNotifications],['internal',InternalMaterialNotifications]]) {
  test(`${kind} 旧任务缺收件人时，只从已验证的原应用原账号快照恢复`,async()=>{
    const app={mode:'custom',appId:'cli_original123',profile:'research-original',ownerOpenId:'ou_original'};
    const task={id:'task',status:'ready',feishuApp:{...app},publication:{status:'published',url:'https://example.feishu.cn/docx/Report'},notification:{status:'failed'},...(kind==='daily'?{briefing:{kind:'daily',window:{display:'昨天'}}}:{internal:{source:'https://example.com',sourceLabel:'访谈'}})};
    let current={...app},user='ou_original',verified=true,sends=0;const rows=[];
    const service={require:()=>task,save(){},store:{runtimeLog:(event,details)=>rows.push({event,...details})},binding:{applicationSnapshot:()=>current,json:async args=>{
      if(args[0]==='auth')return{appId:current.appId,identities:{user:{openId:user,available:true,verified},bot:{available:true,verified:true}}};
      assert.equal(args[args.indexOf('--user-id')+1],'ou_original');sends++;return{ok:true,data:{message_id:'om_fixture'}};
    }}};
    const notifications=new Notifications(service);
    current={...app,appId:'cli_other123'};await notifications.send(task.id);assert.equal(sends,0);assert.equal(task.notification.diagnostic.code,'BINDING_CHANGED');assert.equal(task.notificationRecipient,undefined);
    current={...app};user='ou_other';await notifications.send(task.id);assert.equal(sends,0);assert.equal(task.notificationRecipient,undefined);
    user='ou_original';verified=false;await notifications.send(task.id);assert.equal(sends,0);assert.equal(task.notificationRecipient,undefined);
    verified=true;await notifications.send(task.id);assert.equal(sends,1);assert.equal(task.notification.status,'sent');assert.equal(task.notificationRecipient,'ou_original');
    assert.ok(rows.some(r=>r.event==='feishu.notification.recipient_restored'));assert.ok(!JSON.stringify(rows).includes('ou_original'));
  });
  test(`${kind} 无账号快照的历史任务明确报缺接收人，不能猜测当前用户`,async()=>{
    const app={mode:'custom',appId:'cli_test123',profile:'research-test'};
    const task={id:'task',status:'ready',feishuApp:app,publication:{status:'published'},...(kind==='daily'?{briefing:{kind:'daily'}}:{internal:{}})};
    let calls=0;const service={require:()=>task,save(){},binding:{applicationSnapshot:()=>app,json:async()=>{calls++;throw Error('should not call');}}};
    await new Notifications(service).send(task.id);assert.equal(calls,0);assert.equal(task.notification.diagnostic.code,'MISSING_RECIPIENT');assert.equal(task.notification.diagnostic.action,'check_recipient');
  });
}

test('严格CLI模拟拒绝绝对输出路径，应用扫码和个人授权都使用cwd内相对路径',async()=>{
  const f=fixture(),cli=applicationRunner(),sdk=registrationRunner();let qrCalls=0;
  const binding=new FeishuBinding({store:f.store,registerApp:sdk.registerApp,run:async(args,options)=>{
    const cmd=args[0]==='--profile'?args.slice(2):args;
    if(cmd[0]==='auth'&&cmd[1]==='qrcode'){assert.equal(cmd.at(-1),'./qrcode.png');assert.ok(options.cwd);qrCalls++;}
    return cli.run(args,options);
  }});
  try {
    const flow=binding.registration.start();sdk.approve('cli_qr12345');await binding.registration.work;
    assert.equal(binding.registration.snapshot().status,'completed');
    const personal=await binding.start();assert.ok(binding.qr(personal.flowId).length>0);assert.equal(qrCalls,2);
  }finally{binding.close();await f.close();}
});

test('修复机器人权限锁定当前应用，申请tenant消息权限，保留原个人身份且不重新登录',async()=>{
  const f=fixture(),cli=applicationRunner(),sdk=registrationRunner();
  const app={mode:'custom',appId:'cli_repair123',profile:'research-repair',ownerOpenId:'ou_original'};
  f.store.saveSetting('feishu-application',app);cli.profiles.set(app.profile,{appId:app.appId,bound:true,openId:'ou_original',userName:'原账号'});
  const binding=new FeishuBinding({store:f.store,run:cli.run,registerApp:sdk.registerApp});
  try {
    binding.registration.start({repairBot:true});
    assert.equal(sdk.pending[0].options.appId,app.appId);
    assert.deepEqual(sdk.pending[0].options.addons.scopes.tenant,['im:message:send_as_bot']);
    sdk.approve(app.appId,'ou_appmanager');await binding.registration.work;
    assert.equal(binding.registration.snapshot().status,'completed');
    assert.equal(binding.applicationSnapshot().ownerOpenId,'ou_original');
    assert.equal(binding.applicationSnapshot().profile,app.profile);
    assert.equal((await binding.requireBound()).openId,'ou_original');
    assert.ok(!cli.calls.some(c=>c.args.includes('login')));
    binding.registration.start({repairBot:true});sdk.approve('cli_unexpected123');await binding.registration.work;
    assert.equal(binding.registration.snapshot().status,'failed');assert.equal(binding.applicationSnapshot().appId,app.appId);
  }finally{binding.close();await f.close();}
});
