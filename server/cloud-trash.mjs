import { ServiceError } from './service-error.mjs';

// Drive forbids concurrent deletion calls. Share a queue across all card kinds.
export function serializeTrash(service,work){const job=(service.trashChain??Promise.resolve()).then(work);service.trashChain=job.catch(()=>{});return job;}
export async function trashTarget(service,app,target,persist){
  if(target.done)return true;
  const querying=Boolean(target.taskId);
  let response;
  try{response=await service.binding.json(querying
    ?['drive','+task_result','--scenario','task_check','--task-id',target.taskId,'--as','user','--json']
    :['drive','+delete','--file-token',target.token,'--type',target.type,'--yes','--as','user','--json'],app);
  }catch{throw new ServiceError(503,'飞书删除结果未确认，请检查当前应用的删除权限、登录和网络后重新核对');}
  if(response?.ok===false||response?.code&&Number(response.code)!==0)throw new ServiceError(503,'飞书未确认删除成功，请核对当前账号和删除权限');
  const result=response?.data??response;
  if(typeof result?.task_id==='string'&&result.task_id)target.taskId=result.task_id;
  persist();
  if(result?.failed||['failed','fail','failure'].includes(result?.status))throw new ServiceError(503,'飞书删除失败，请核对云端结果后重试');
  if(result?.deleted===true||querying&&result?.ready===true&&result?.status==='success')target.done=true;
  else if(!target.taskId)throw new ServiceError(503,'飞书尚未确认删除结果，请稍后继续核对');
  persist();return Boolean(target.done);
}
