import { notificationFailure } from './notification-errors.mjs';
import { notificationContext } from './notification-context.mjs';
import { recordTrace } from './connection-trace.mjs';

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
      const {recipient,application}=await notificationContext(s,t);
      t.notification={status:'sending',recipient,attemptedAt:new Date().toISOString()};s.save(t);
      const name=t.briefing.kind==='daily'?'日报':'周报';
      const text=t.publication.noUpdates?`本${t.briefing.kind==='daily'?'日':'周'}无更新\n${t.briefing.window.display}`:`${name}已完成${t.publication.partial?'（部分资料缺失，详见报告）':''}\n${t.briefing.window.display}\n${t.publication.url}`;
      const response=await s.binding.json(['im','+messages-send','--as','bot','--user-id',recipient,'--text',text,'--idempotency-key',t.id],application);
      if(response.ok!==true)throw Object.assign(new Error('unconfirmed notification'), { stderr: JSON.stringify(response) });
      const messageId=response.data?.message_id??response.message_id;
      t.notification={...t.notification,status:'sent',sentAt:new Date().toISOString(),...(messageId?{messageId:String(messageId)}:{})};s.save(t);
      recordTrace(s.store,'feishu.notification.sent',{taskId:t.id,appId:application.appId,phase:'bot_message',status:'completed'});
    } catch (error) {
      const failure = notificationFailure(error);
      recordTrace(s.store,'feishu.notification.failed',{taskId:t.id,appId:(t.notificationApp??t.feishuApp)?.appId,code:failure.diagnostic.code??'UNKNOWN_ERROR',phase:t.notification?.status==='sending'?'bot_message':'notification_preflight'},'error');
      t.notification={...t.notification,status:'failed',error:failure.message,diagnostic:failure.diagnostic};s.save(t);
    }
    return t;
  }
  async close(){await Promise.allSettled(this.active.values());}
}
