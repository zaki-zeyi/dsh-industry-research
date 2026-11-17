import { assertDocumentAvailable, assertCompanyWriteTargets } from './document-deletion-state.mjs';
import { assertTopicAvailable, topicFolderKey, topicDocumentKey, topicDailyDocumentKey, legacyTopicFolderKey } from './topics.mjs';
import { internalFolderKey } from './internal-materials.mjs';
import {library,libraryNamespaceKey} from './industry.mjs';
import {briefingKey} from './briefings.mjs';
import {randomUUID} from 'node:crypto';

// Serialize remote mutations, not research sessions. Locks live only as long as
// their owning run. Unconfirmed cancellation remains blocked until the host
// confirms the old writing turn has ended, including after a service restart.
export class CloudWrites {
  constructor(service){this.service=service;this.locks=new Map();}
  writer(t){
    const s=this.service,active=s.active.get(t.id);if(active)return ['running','queued'].includes(t.status)?active:null;
    const meta=t.terminalId&&s.store.terminal(t.terminalId),run=t.runs?.at(-1);
    // Host Retry continues the same binding without service.retry(). Only a
    // fresh turn of a failed native run may regain permission; never cancellation.
    if(t.nativeSession&&t.status==='failed'&&run?.status==='failed'&&run.terminalId===t.terminalId&&meta?.activity==='working'&&meta.agent==='dsh-native'&&meta.taskId===t.id&&meta.sessionId===run.sessionId&&Number(meta.turnSequence)>Number(run.failedTurnSequence??0)&&Date.parse(meta.lastTurnStartedAt)>=Date.parse(run.endedAt))return {controller:new AbortController()};
    return null;
  }
  operationKey(t){return 'cloud-write-operations:'+libraryNamespaceKey(t.feishuRoot,t.feishuApp);}
  operation(id,{requestId,terminalId,action,operationId}){
    const s=this.service,t=s.require(id),key=this.operationKey(t),operations=s.store.setting(key)??[];
    if(action==='finish'){
      const operation=operations.find(v=>v.operationId===operationId&&v.taskId===id&&v.terminalId===terminalId&&v.requestId===requestId);
      if(!operation)throw Object.assign(new Error('写入操作不属于当前轮次'),{status:409});
      s.store.saveSetting(key,operations.filter(v=>v!==operation));
      if(!this.writer(t)||t.status==='ready')this.release(id);
      return {ok:true};
    }
    const meta=s.store.terminal(terminalId),active=this.writer(t),lock=this.locks.get(libraryNamespaceKey(t.feishuRoot,t.feishuApp));
    if(!active||active.controller.signal.aborted||t.terminalId!==terminalId||meta?.deliveryRequestId!==requestId||lock?.owner!==id||lock.terminalId!==terminalId)throw Object.assign(new Error('保存权限已失效，请从工作台重试'),{status:409});
    if(operations.length)throw Object.assign(new Error('已有飞书写入正在执行，请等待结束后继续'),{status:409});
    assertDocumentAvailable(s,t);assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    const operation={operationId:operationId??randomUUID(),taskId:id,terminalId,requestId,startedAt:new Date().toISOString()};
    s.store.saveSetting(key,[...operations,operation]);return {operationId:operation.operationId};
  }
  async acquire(id,requestId){
    const s=this.service,t=s.require(id),active=this.writer(t),terminalId=t.terminalId;
    assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    assertDocumentAvailable(s,t);
    const meta=t.terminalId&&s.store.terminal(t.terminalId);
    if(!active||active.controller.signal.aborted||meta?.deliveryRequestId!==requestId)throw Object.assign(new Error('任务轮次已失效'),{status:409});
    const key=libraryNamespaceKey(t.feishuRoot,t.feishuApp);
    const existingLock=this.locks.get(key);
    if((s.store.setting(this.operationKey(t))??[]).some(v=>(v.taskId!==id||v.terminalId!==t.terminalId)&&!(existingLock?.owner===v.taskId&&existingLock.terminalId===v.terminalId&&this.writer(s.require(v.taskId)))))throw Object.assign(new Error('前一轮写入操作尚未结束，请核对保存状态后重试'),{status:409});
    const uncertain=s.store.setting('cloud-write-pending:'+key);
    const supersededTurn=uncertain?.owner===id&&uncertain.terminalId===t.terminalId&&Number(meta?.turnSequence)>Number(uncertain.turnSequence??t.runs?.at(-1)?.failedTurnSequence??0)&&Date.parse(meta?.lastTurnStartedAt)>=Date.parse(t.runs?.at(-1)?.endedAt);
    if(uncertain&&s.store.terminal(uncertain.terminalId)?.activity==='working'&&!supersededTurn)throw Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409});
    if(uncertain)s.store.saveSetting('cloud-write-pending:'+key,null);
    let lock=this.locks.get(key);
    if(lock?.owner){
      const ownerTask=s.require(lock.owner),ownerMeta=s.store.terminal(lock.terminalId??ownerTask.terminalId);
      const replaced=lock.owner===id&&lock.terminalId&&lock.terminalId!==t.terminalId;
      if(replaced&&ownerMeta?.activity==='working')throw Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409});
      if(ownerMeta?.activity!=='working'&&(!s.active.has(lock.owner)||replaced)){this.release(lock.owner);lock=this.locks.get(key);}
    }
    if(!lock){lock={owner:null,waiters:[]};this.locks.set(key,lock);}
    if(lock.owner===id){try{return await this.snapshot(t);}catch(e){this.release(id,terminalId);throw e;}}
    if(lock.owner){
      t.stage='waiting_save';s.save(t);
      await new Promise((resolve,reject)=>{
        const waiter={id,terminalId:t.terminalId,reject:e=>{active.controller.signal.removeEventListener('abort',abort);reject(e);},resolve:()=>{active.controller.signal.removeEventListener('abort',abort);resolve();}};
        const abort=()=>{lock.waiters=lock.waiters.filter(w=>w!==waiter);reject(Object.assign(new Error('任务已取消'),{status:409}));};
        lock.waiters.push(waiter);active.controller.signal.addEventListener('abort',abort,{once:true});
      });
    }else {lock.owner=id;lock.terminalId=t.terminalId;}
    try{if(active.controller.signal.aborted||s.require(id).terminalId!==terminalId||!this.writer(s.require(id)))throw Object.assign(new Error('任务轮次已失效'),{status:409});return await this.snapshot(s.require(id));}catch(e){this.release(id,terminalId);throw e;}
  }
  async snapshot(t){
    const s=this.service;
    assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    assertDocumentAvailable(s,t);
    if(s.directories)await s.directories.prepare(t,s.active.get(t.id)?.controller.signal);
    else s.prepareCloudRoot(t);
    if(s.require(t.id).terminalId!==t.terminalId||!this.writer(s.require(t.id)))throw Object.assign(new Error('任务轮次已失效'),{status:409});
    this.assertOwner(t);
    assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    assertDocumentAvailable(s,t);
    t.industryLibrary=library(s.store,t.feishuRoot,t.feishuApp);
    assertCompanyWriteTargets(s,t);
    if(t.briefing)t.briefingLibrary=s.store.setting(briefingKey(t))??{};
    if(t.internal)t.internalFolders=s.store.setting(internalFolderKey(t))??{};
    if(t.topic){t.topicLibrary=s.store.setting(t.topic.workflowVersion===468?topicFolderKey(t):legacyTopicFolderKey(t))??{};t.topicDocument=s.store.setting(topicDocumentKey(t))??{};if(t.topic.window)t.topicDailyDocument=s.store.setting(topicDailyDocumentKey(t))??{};}
    t.stage='research';s.save(t);
    return {topicDailyDocument:t.topicDailyDocument,topicLibrary:t.topicLibrary,topicDocument:t.topicDocument,feishuRoot:t.feishuRoot,industryLibrary:t.industryLibrary,briefingLibrary:t.briefingLibrary,internalFolders:t.internalFolders,analysisIndex:t.analysisIndex};
  }
  assertOwner(t){const lock=this.locks.get(libraryNamespaceKey(t.feishuRoot,t.feishuApp));if(this.service.directories&&lock?.owner!==t.id||lock?.owner&&(lock.owner!==t.id||lock.terminalId!==t.terminalId))throw new Error('请先获取本轮保存锁与已确认的唯一目录，再回传交付结果');}
  release(id,expectedTerminalId){for(const [key,lock] of this.locks){
    if(lock.owner!==id||expectedTerminalId&&lock.terminalId!==expectedTerminalId)continue;
    const t=this.service.require(id),terminalId=lock.terminalId??t.terminalId,meta=terminalId&&this.service.store.terminal(terminalId);
    if((this.service.store.setting(this.operationKey(t))??[]).some(v=>v.taskId===id&&v.terminalId===terminalId))return;
    if(t.status!=='ready'&&meta?.activity==='working'){
      this.service.store.saveSetting('cloud-write-pending:'+key,{owner:id,terminalId,turnSequence:meta.turnSequence??0});
      for(const waiter of lock.waiters)waiter.reject(Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409}));lock.waiters=[];continue;
    }
    this.service.store.saveSetting('cloud-write-pending:'+key,null);
    const next=lock.waiters.shift();if(next){lock.owner=next.id;lock.terminalId=next.terminalId;next.resolve();}else this.locks.delete(key);
  }}
}
