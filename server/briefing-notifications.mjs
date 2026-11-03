export class BriefingNotifications {
  constructor(service) { this.service=service; this.active=new Map(); }
  send(id) {
    if(this.active.has(id))return this.active.get(id);
    const job=this.deliver(id).finally(()=>this.active.delete(id));this.active.set(id,job);return job;
  }
  async deliver(id) {
    const s=this.service,t=s.require(id);
    if(!t.briefing||t.status!=='ready'||t.publication.status!=='published'||t.notification?.status==='sent')return t;
    try {
      const recipient=t.notificationRecipient,application=t.notificationApp??t.feishuApp;
      if(!/^ou_[A-Za-z0-9]+$/.test(recipient??''))throw new Error('未取得本任务绑定用户，请重新绑定飞书后重试通知');
      const identity=await s.binding.json(['auth','status','--json'],application);
      if(identity.identities?.user?.openId!==recipient||identity.identities.user.available!==true||(application.appId&&identity.appId!==application.appId))throw new Error('绑定身份已改变');
      if(identity.identities?.bot?.available!==true||identity.identities?.bot?.verified!==true)throw new Error('机器人身份不可用');
      t.notification={status:'sending',recipient,attemptedAt:new Date().toISOString()};s.save(t);
      const name=t.briefing.kind==='daily'?'日报':'周报';
      const text=t.publication.noUpdates?`本${t.briefing.kind==='daily'?'日':'周'}无更新\n${t.briefing.window.display}`:`${name}已完成${t.publication.partial?'（部分资料缺失，详见报告）':''}\n${t.briefing.window.display}\n${t.publication.url}`;
      const response=await s.binding.json(['im','+messages-send','--as','bot','--user-id',recipient,'--text',text,'--idempotency-key',t.id],application);
      if(response.ok!==true)throw new Error('飞书机器人未确认消息发送成功，请检查机器人权限及可用范围');
      const messageId=response.data?.message_id??response.message_id;
      t.notification={...t.notification,status:'sent',sentAt:new Date().toISOString(),...(messageId?{messageId:String(messageId)}:{})};s.save(t);
    } catch {
      t.notification={...t.notification,status:'failed',error:'飞书机器人未发送成功。请重新绑定应用并确认已开通“发送消息”权限（im:message:send_as_bot），且机器人可用范围包含当前绑定用户；报告和会话已保留，可重试通知。'};s.save(t);
    }
    return t;
  }
  async close(){await Promise.allSettled(this.active.values());}
}
