import { notificationFailure } from './notification-errors.mjs';
import { notificationContext, notificationSent } from './notification-context.mjs';
import { recordTrace } from './connection-trace.mjs';

export class BriefingNotifications {
  constructor(service) { this.service=service; this.active=new Map(); }
  send(id, options = {}) {
    if(this.active.has(id))return this.active.get(id);
    const job=this.deliver(id, options).finally(()=>this.active.delete(id));this.active.set(id,job);return job;
  }
  async deliver(id, options) {
    const s=this.service,t=s.require(id);
    if(!t.briefing||t.status!=='ready'||t.publication.status!=='published'||t.notification?.status==='sent')return t;
    let attemptedAppId;
    try {
      const context=await notificationContext(s,t,options),{recipient,application,idempotencyKey}=context;
      attemptedAppId=application.appId;
      t.notification={status:'sending',recipient,appId:application.appId,idempotencyKey,attemptedAt:new Date().toISOString()};s.save(t);
      const name=t.briefing.kind==='daily'?'日报':'周报';
      const text=t.publication.noUpdates?`本${t.briefing.kind==='daily'?'日':'周'}无更新\n${t.briefing.window.display}`:`${name}已完成${t.publication.partial?'（部分资料缺失，详见报告）':''}\n${t.briefing.window.display}\n${t.publication.url}`;
      const response=await s.binding.json(['im','+messages-send','--as','bot','--user-id',recipient,'--text',text,'--idempotency-key',idempotencyKey],application);
      if(response.ok!==true)throw Object.assign(new Error('unconfirmed notification'), { stderr: JSON.stringify(response) });
      const messageId=response.data?.message_id??response.message_id;
      const notice=notificationSent(t,context);
      t.notification={...t.notification,status:'sent',sentAt:new Date().toISOString(),...(notice?{notice}:{}),...(messageId?{messageId:String(messageId)}:{})};s.save(t);
      if(context.changed)recordTrace(s.store,'feishu.notification.redirected',{taskId:t.id,previousAppId:context.previousAppId,appId:application.appId,status:'completed',phase:'bot_message'});
      recordTrace(s.store,'feishu.notification.sent',{taskId:t.id,appId:application.appId,phase:'bot_message',status:'completed'});
    } catch (error) {
      const failure = notificationFailure(error);
      recordTrace(s.store,'feishu.notification.failed',{taskId:t.id,appId:attemptedAppId,previousAppId:(t.notificationApp??t.feishuApp)?.appId,code:failure.diagnostic.code??'UNKNOWN_ERROR',phase:t.notification?.status==='sending'?'bot_message':'notification_preflight'},'error');
      t.notification={...t.notification,status:'failed',error:failure.message,diagnostic:failure.diagnostic};s.save(t);
    }
    return t;
  }
  async close(){await Promise.allSettled(this.active.values());}
}
