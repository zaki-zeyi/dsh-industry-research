import { ServiceError } from './service-error.mjs';

export function bindingBlockers(service) {
  const stored=new Map(service.store.list().map(task=>[task.id,task]));
  const ids=new Set([...service.active.keys(),...service.queue.map(job=>job.id),...[...stored.values()].filter(t=>['queued','running'].includes(t.status)||t.publication?.status==='publishing').map(t=>t.id)]);
  return [...ids].map(id=>{
    const t=stored.get(id), active=service.active.has(id);
    return {id,title:String(t?.direction??'执行中的任务').slice(0,200),
      kind:t?.briefing?.kind??(t?.internal?'internal':t?.analysis?'analysis':'industry'),
      reason:t?.publication?.status==='publishing'?(active?'uploading':'upload_pending'):t?.status==='queued'?'queued':t?.stage==='waiting_save'?'waiting_save':active&&t?.status!=='running'?'finishing':'researching',
      canOpenSession:Boolean(t?.nativeSession&&t.nativeSessionId)};
  });
}

export function requireIdleBinding(service, action='重新绑定') {
  const blockers=bindingBlockers(service);
  if(!blockers.length)return;
  const error=new ServiceError(409,`有调研或上传正在执行，请完成/停止后再${action}`);
  error.code='FEISHU_TASKS_BUSY';error.blockers=blockers;throw error;
}
