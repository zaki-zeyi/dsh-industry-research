import { saveHostSchedule, removeHostSchedule, scheduleFailure } from './host-schedule.mjs';
import { z } from 'zod';
import { topicInput, topicTask, topicScope } from './topics.mjs';
import { normalizeTopicPrompt } from './topic-defaults.mjs';
import { previousScheduleRun, scheduleTiming } from './briefings.mjs';
export const topicScheduleInput=z.object({time:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),enabled:z.boolean().default(true),research:topicInput}).strict();
export class TopicSchedules {
  constructor(service,host){this.service=service;this.host=host;this.chain=Promise.resolve();}
  get schedule(){return typeof this.host?.get==='function'?this.host.get('schedule'):this.host?.schedule;}
  scope(){return topicScope(this.service.feishuSettings(),this.service.binding?.applicationSnapshot?.());}
  all(){return this.service.store.setting('topic-schedules')??{};}
  get(id){const p=this.all()[this.scope()+':'+id]??{topicId:id,time:'09:00',enabled:false};return {...p,...(p.research?.prompt?{research:{...p.research,prompt:normalizeTopicPrompt(p.research.prompt)}}:{}),...(p.enabled?scheduleTiming({...p,kind:'daily'}):{nextRunAt:null}),available:Boolean(this.schedule)};}
  save(id,input){const scope=this.scope(),job=this.chain.then(()=>this.commit(id,input,scope));this.chain=job.catch(()=>{});return job;}
  async commit(id,input,scope){
    z.string().uuid().parse(id);const v=topicScheduleInput.parse(input);if(v.research.prompt)v.research.prompt=normalizeTopicPrompt(v.research.prompt);
    if(scope!==this.scope())throw Object.assign(new Error('飞书目录或账号已变化，请重新设置'),{status:409});
    if(!this.schedule)throw Object.assign(new Error('当前宿主未启用官方 Schedule 服务'),{status:503});
    if(v.enabled)await this.service.binding.requireBound();
    if(scope!==this.scope())throw Object.assign(new Error('飞书目录或账号已变化，请重新设置'),{status:409});
    const key=scope+':'+id,old=this.all()[key]??{};
    let sessionId=old.sessionId;
    if(v.enabled&&!sessionId){sessionId=(await this.service.nativeSessions.createHostSession()).sessionId;const r=await this.host.sessionController.resolveAgent(sessionId);this.host.permissionPresets.set(r.agent.session,'danger-full-access');}
    if(v.enabled)await this.service.nativeSessions.bindSession(sessionId);

    const plan={...v,topicId:id,scope,sessionId,enabled:false};
    const persist=()=>this.service.store.saveSetting('topic-schedules',{...this.all(),[key]:plan});
    if(v.enabled){
      const endpoint=this.service.briefingSchedules.endpointFile;
      const prompt=`使用 Node.js 读取 ${JSON.stringify(endpoint)} 的 url，向该 url 加 /api/topics/trigger/${id} 发起 POST，Content-Type application/json，body ${JSON.stringify({scope})}。不要自行调研，平台会创建独立会话并通知用户。`;
      try{plan.record=await saveHostSchedule(this.schedule,sessionId,{title:'专题日报 · '+v.research.question,prompt,daily:{time:v.time+':00',time_zone:'Asia/Shanghai'}},old.record);}
      catch(error){this.service.store.saveSetting('topic-schedules',{...this.all(),[key]:Object.keys(old).length?{...old,sessionId}:{...v,topicId:id,scope,sessionId,enabled:false}});this.service.store.runtimeLog('topic.schedule.failed',{phase:'schedule_save',code:typeof error.code==='string'?error.code:'SCHEDULE_SAVE_FAILED'},'error');throw scheduleFailure(error);}
    }
    if(!v.enabled&&old.record){try{await removeHostSchedule(this.schedule,sessionId,old.record.id);}catch(error){throw scheduleFailure(error);}}
    plan.enabled=v.enabled;plan.activatedAt=old.enabled&&old.time===v.time?old.activatedAt:new Date().toISOString();persist();return this.get(id);
  }
  async trigger(id,{scope=this.scope(),scheduledFor=Date.now()}={}){
    if(scope!==this.scope())throw Object.assign(new Error('专题日报绑定的账号或目录已切换'),{status:409});
    const p=this.get(id);if(!p.enabled)throw Object.assign(new Error('专题日报未启用'),{status:409});
    const date=new Date(scheduledFor),key='topic:'+scope+':'+id+':'+new Date(date.getTime()+28800000).toISOString().slice(0,10);
    const old=this.service.store.request(key);if(old)return this.service.require(old.task_id);
    const input=topicTask({...p.research,topicId:id},date);
    if(p.research.prompt)input.prompt=p.research.prompt.replaceAll('{{时间范围}}',input.topic.window.display);
    return this.service.createAuthorized(input,key,{scheduled:{kind:'topic',scheduledFor:date.toISOString()}});
  }
  async catchUpMissed(now=Date.now()){
    for(const p of Object.values(this.all())){if(!p.enabled||p.scope!==this.scope())continue;
      const slot=previousScheduleRun({...p,kind:'daily'},now);if(!p.activatedAt||Date.parse(p.activatedAt)>Date.parse(slot))continue;
      try{await this.trigger(p.topicId,{scope:p.scope,scheduledFor:Date.parse(slot)});}catch(error){this.service.store.runtimeLog('topic.catchup.failed',{code:error.code??'TOPIC_SCHEDULE_FAILED'},'warn');}
    }
  }
}
