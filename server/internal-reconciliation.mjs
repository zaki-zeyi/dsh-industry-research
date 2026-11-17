import { assertDocumentAvailable } from './document-deletion-state.mjs';
import { readFileSync } from 'node:fs';
import { agentPublication, parseAgentDelivery } from './agent-delivery.mjs';
import { normalizeInternalDelivery } from './internal-materials.mjs';
import { libraryKey, mergeCompanyDelivery } from './industry.mjs';
import { ServiceError } from './service-error.mjs';

export const canReconcileInternal=task=>Boolean(task.internal?.workflowVersion===1534&&task.status==='failed'&&task.error==='内部资料尚未完成信息库增量同步');
export class InternalReconciliation {
  constructor(service){this.service=service;this.active=new Map();}
  reconcile(id){
    if(this.active.has(id))return this.active.get(id);
    const job=this.check(id).finally(()=>this.active.delete(id));this.active.set(id,job);return job;
  }
  scope(task){const s=this.service;if(libraryKey(task.feishuRoot,task.feishuApp)!==libraryKey(s.feishuSettings(),s.binding?.applicationSnapshot?.()))throw new ServiceError(409,'请切回该任务的飞书账号和存储位置，再核对已完成结果');}
  async read(url,app){
    let result;try{result=await this.service.binding.json(['docs','+fetch','--doc',url,'--doc-format','markdown','--as','user'],app);}catch{throw new ServiceError(503,'云端结果暂时无法读回，请检查飞书连接后重试；未修改任务状态');}
    const content=result?.data?.document?.content;
    if(result.ok===false||typeof content!=='string'||!content.trim())throw new ServiceError(409,'云端文档未能验证，请在原会话核对；未修改任务状态');
    return content;
  }
  async check(id){
    const s=this.service,t=s.require(id);this.scope(t);assertDocumentAvailable(s,t);
    if(t.status==='ready'&&t.reconciliation?.status==='verified')return t;
    if(!canReconcileInternal(t))throw new ServiceError(409,'当前任务不属于回执元信息缺失，不能直接恢复完成状态');
    const meta=t.terminalId&&s.store.terminal(t.terminalId);
    if(s.active.has(id)||s.queue.some(j=>j.id===id)||meta?.activity==='working')throw new ServiceError(409,'原会话仍在执行，请结束当前轮次后再核对');
    let receipt;try{receipt=parseAgentDelivery(readFileSync(meta.deliveryPath,'utf8'));}catch{throw new ServiceError(409,'原任务交付回执不可验证，请在原会话核对');}
    if(receipt.status!=='published'||!meta?.deliveryRequestId||receipt.requestId!==meta.deliveryRequestId||meta.taskId!==id||meta.agent!=='dsh-native'||!t.runs?.some(r=>r.terminalId===meta.id&&r.sessionId===meta.sessionId)||receipt.folderToken!==t.feishuRoot.folderToken||receipt.url!==t.publication?.url||receipt.minutesUrl!==t.publication?.minutesUrl)throw new ServiceError(409,'回执轮次、文档或存储位置不一致，未修改任务状态');
    normalizeInternalDelivery(t,receipt);
    if(!receipt.libraryFolderToken||!receipt.manifestUrl||!receipt.companies?.length)throw new ServiceError(409,'没有可验证的信息库同步结果，请在原会话补齐');
    await s.binding.requireBound(t.feishuApp);
    await this.read(receipt.url,t.feishuApp);
    const minutes=await this.read(receipt.minutesUrl,t.feishuApp);
    if(!minutes.includes(receipt.url))throw new ServiceError(409,'会议纪要缺少对应逐字稿引用，未恢复任务状态');
    for(const company of receipt.companies){
      const content=await this.read(company.url,t.feishuApp);
      if(!content.includes(receipt.url))throw new ServiceError(409,'公司文档尚未查到本次逐字稿引用，请在原会话核对增量更新');
    }
    this.scope(t);assertDocumentAvailable(s,t);
    const latest=s.require(id);
    if(!canReconcileInternal(latest)||latest.terminalId!==t.terminalId||s.active.has(id)||s.store.terminal(meta.id)?.activity==='working')throw new ServiceError(409,'核对期间任务状态已变化，请刷新后重试');
    // Reconciliation changes only local metadata. It never starts an Agent,
    // edits a cloud document, or sends a duplicate notification.
    s.store.transaction(()=>{
      const completedAt=t.runs.at(-1)?.endedAt??t.updatedAt;
      for(const company of receipt.companies)company.updatedAt??=completedAt;
      s.rememberCloudFolder(t,receipt);s.rememberInternalMaterial(t,receipt);mergeCompanyDelivery(s.store,t,receipt,{preserveExisting:true});
      t.status='ready';t.stage='done';t.error=null;t.publication=agentPublication(receipt);
      const run=t.runs.at(-1);run.status='completed';run.reconciledAt=new Date().toISOString();
      t.reconciliation={status:'verified',verifiedAt:run.reconciledAt,documents:receipt.companies.length+2};
      s.store.save(t);
    });
    s.event(id,'system','已读回逐字稿、会议纪要及对应公司文档，确认增量更新成功，补齐原回执元信息并恢复完成状态；未重新解析或追加内容。');
    return s.require(id);
  }
  blockers(){return [...this.active.keys()].map(id=>({id,title:'核对内部资料结果',kind:'internal',reason:'uploading',canOpenSession:false}));}
  async close(){await Promise.allSettled(this.active.values());}
}
