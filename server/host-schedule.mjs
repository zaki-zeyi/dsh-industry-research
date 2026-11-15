import { ServiceError } from './service-error.mjs';

// The current official service accepts a request object and explicit target;
// older hosts accept (sessionId, selectors). Select before any mutation.
const modern = schedule => typeof schedule.edit === 'function';
export async function removeHostSchedule(schedule,sessionId,id){
  const result=modern(schedule)?await schedule.edit({id,action:'delete'},sessionId):await schedule.delete({sessionId,id});
  if(result?.code&&result.code!=='schedule_not_found')throw new ServiceError(409,'定时任务已在宿主中发生变化，请刷新后重试');
  return result;
}
export async function saveHostSchedule(schedule,sessionId,input,previous){
  const title=input.title.trim().slice(0,120);
  if(modern(schedule)){
    const kind=input.weekly?'weekly':'daily';
    const patch={title,prompt:input.prompt,timing:{kind,[kind]:input[kind]},target:{kind:'session',sessionId},active:true};
    const result=previous?.id?await schedule.edit({id:previous.id,action:'update',patch},sessionId):await schedule.create({title,prompt:input.prompt,timing:patch.timing,target:patch.target},sessionId);
    if(result?.code)throw new ServiceError(409,'定时任务已被修改或删除，请刷新宿主自动化任务后重试');
    if(!result?.id)throw new ServiceError(503,'宿主未确认定时任务保存成功，请检查自动化任务后重试');
    return result;
  }
  const result=await schedule.create(sessionId,{...input,title});
  if(!result?.id)throw new ServiceError(503,'宿主未确认定时任务保存成功，请检查自动化任务后重试');
  if(previous?.id){try{await removeHostSchedule(schedule,sessionId,previous.id);}catch(error){await removeHostSchedule(schedule,sessionId,result.id).catch(()=>{});throw error;}}
  return result;
}
export function scheduleFailure(error){
  if(error instanceof ServiceError)return error;
  return new ServiceError(503,'保存定时任务失败，请检查宿主自动化服务是否正常，然后重试；原有定时配置已保留');
}
