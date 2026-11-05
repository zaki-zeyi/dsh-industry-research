import test from 'node:test';
import assert from 'node:assert/strict';
import { BriefingNotifications } from '../server/briefing-notifications.mjs';
import { InternalMaterialNotifications } from '../server/internal-notifications.mjs';
import { fixture } from './helpers.mjs';
import { createApp } from '../server/app.mjs';

for(const [kind,Notifications] of [['daily',BriefingNotifications],['weekly',BriefingNotifications],['internal',InternalMaterialNotifications]]) {
  test(`${kind} 手动重试向当前应用的当前用户发送，成功才显示迁移提醒并避免重复发送`,async()=>{
    const original={mode:'custom',appId:'cli_old123',profile:'research-old',ownerOpenId:'ou_old'};
    const current={mode:'custom',appId:'cli_current123',profile:'research-current',ownerOpenId:'ou_current'};
    const task={id:'11111111-1111-4111-8111-111111111111',status:'ready',feishuApp:{...original},notificationApp:{...original},notificationRecipient:'ou_old',notification:{status:'failed'},publication:{status:'published',url:'https://example.feishu.cn/docx/Report'},...(kind==='internal'?{internal:{source:'https://example.com',sourceLabel:'资料'}}:{briefing:{kind,window:{display:'昨天'}}})};
    let fail=true;const sends=[],logs=[];
    const service={require:()=>task,save(){},store:{runtimeLog:(event,details)=>logs.push({event,...details})},binding:{applicationSnapshot:()=>current,json:async(args,app)=>{
      assert.equal(app.appId,current.appId);assert.equal(app.profile,current.profile);
      if(args[0]==='auth')return{appId:current.appId,identities:{user:{available:true,verified:true,openId:'ou_current'},bot:{available:true,verified:true}}};
      const key=args[args.indexOf('--idempotency-key')+1];sends.push({recipient:args[args.indexOf('--user-id')+1],key});
      if(fail)throw Error('temporary failure');return{ok:true,data:{message_id:'om_sent'}};
    }}};
    const notifications=new Notifications(service);
    await notifications.send(task.id,{currentUser:true});
    assert.equal(task.notification.status,'failed');assert.equal(task.notification.notice,undefined);
    assert.equal(task.notificationRecipient,'ou_old');assert.equal(task.notificationApp.appId,original.appId);
    fail=false;await Promise.all([notifications.send(task.id,{currentUser:true}),notifications.send(task.id,{currentUser:true})]);
    assert.equal(task.notification.status,'sent');assert.match(task.notification.notice,/已通过当前应用向当前用户发送/);
    assert.equal(task.notificationRecipient,'ou_current');assert.equal(task.notificationApp.appId,current.appId);
    assert.deepEqual(task.feishuApp,original);assert.equal(sends.length,2);assert.equal(sends[0].recipient,'ou_current');
    assert.notEqual(sends[0].key,task.id);assert.equal(sends[0].key,sends[1].key);
    await notifications.send(task.id,{currentUser:true});assert.equal(sends.length,2);
    assert.ok(logs.some(r=>r.event==='feishu.notification.redirected'));assert.ok(!JSON.stringify(logs).includes('ou_current'));
  });
}

test('同应用切换账号、历史任务缺收件人、默认配置均解析当前用户，不携带旧profile',async()=>{
  for(const current of [{mode:'default'},{mode:'custom',appId:'cli_same123',profile:'research-new',ownerOpenId:'ou_new'}]){
    const task={id:'task',status:'ready',briefing:{kind:'daily',window:{display:'昨天'}},feishuApp:{mode:'custom',appId:'cli_same123',profile:'research-old',ownerOpenId:'ou_old'},publication:{status:'published'}};
    const service={require:()=>task,save(){},binding:{applicationSnapshot:()=>current,json:async(args,app)=>{
      assert.equal(app.profile,current.profile);
      if(args[0]==='auth')return{appId:'cli_same123',identities:{user:{available:true,verified:true,openId:'ou_new'},bot:{available:true,verified:true}}};
      assert.equal(args[args.indexOf('--user-id')+1],'ou_new');return{ok:true};
    }}};
    await new BriefingNotifications(service).send(task.id,{currentUser:true});assert.equal(task.notification.status,'sent');assert.ok(task.notification.notice);
  }
});

test('当前用户未验证或当前应用身份不匹配时不发送、不显示已发送提醒',async()=>{
  for(const value of [{appId:'cli_current123',user:{available:true,verified:false,openId:'ou_new'}},{appId:'cli_wrong123',user:{available:true,verified:true,openId:'ou_new'}}]){
    const task={id:'task',status:'ready',briefing:{kind:'daily'},feishuApp:{mode:'custom',appId:'cli_old123'},publication:{status:'published'}};let sends=0;
    const service={require:()=>task,save(){},binding:{applicationSnapshot:()=>({mode:'custom',appId:'cli_current123',profile:'research-new'}),json:async args=>{
      if(args[0]==='auth')return{appId:value.appId,identities:{user:value.user,bot:{available:true,verified:true}}};sends++;return{ok:true};
    }}};
    await new BriefingNotifications(service).send(task.id,{currentUser:true});assert.equal(sends,0);assert.equal(task.notification.status,'failed');assert.equal(task.notification.notice,undefined);
  }
});

test('两个手动通知API明确选择当前用户，自动发送调用保持原默认选项',async()=>{
  const f=fixture(),calls=[];f.service.require=id=>({id,status:'ready',briefing:{},internal:{}});
  f.service.notifications={send:async(id,options)=>calls.push({id,...options})};f.service.internalNotifications=f.service.notifications;
  const server=createApp(f.service).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  try{for(const path of ['briefings','internal-materials']){const res=await fetch(`http://127.0.0.1:${server.address().port}/api/${path}/task/notify`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(res.status,200);}assert.deepEqual(calls,[{id:'task',currentUser:true},{id:'task',currentUser:true}]);}
  finally{server.closeAllConnections();await new Promise(r=>server.close(r));delete f.service.notifications;delete f.service.internalNotifications;await f.close();}
});
