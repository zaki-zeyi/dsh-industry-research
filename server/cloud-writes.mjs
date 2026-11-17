import { assertDocumentAvailable, assertCompanyWriteTargets } from './document-deletion-state.mjs';
import { assertTopicAvailable, topicFolderKey, topicDocumentKey, topicDailyDocumentKey, legacyTopicFolderKey } from './topics.mjs';
import { internalFolderKey } from './internal-materials.mjs';
import {library,libraryNamespaceKey} from './industry.mjs';
import {briefingKey} from './briefings.mjs';
import {randomUUID} from 'node:crypto';
import {readFileSync,unlinkSync} from 'node:fs';
import {resolve} from 'node:path';

export const WRITE_IDLE_TIMEOUT_MS=5*60*1000;

// Serialize remote mutations, not research sessions. Locks live only as long as
// their owning run. Revoke failed/expired grants immediately, but never hand
// over a resource with an unconfirmed CLI mutation still in flight.
export class CloudWrites {
  constructor(service,{now=Date.now,idleTimeoutMs=WRITE_IDLE_TIMEOUT_MS}={}){this.service=service;this.locks=new Map();this.now=now;this.idleTimeoutMs=idleTimeoutMs;}
  start(){this.timer=setInterval(()=>{try{this.sweep();}catch{this.service.store.runtimeLog?.('cloud.lock.recovery_failed',{},'error');}},1000);this.timer.unref();}
  close(){clearInterval(this.timer);}
  guarded(meta){return Boolean(meta?.writeGuard?.leasePath);}
  revoked(meta){const fence=meta&&this.service.store.setting('cloud-write-revoked:'+meta.id);return fence&&fence.requestId===meta.deliveryRequestId&&Number(meta.turnSequence??0)<=fence.turnSequence;}
  writer(t){
    const s=this.service,meta=t.terminalId&&s.store.terminal(t.terminalId),run=t.runs?.at(-1);
    if(this.revoked(meta)||meta?.lastTurnReason==='error')return null;
    const active=s.active.get(t.id);if(active)return ['running','queued'].includes(t.status)&&!active.controller.signal.aborted?active:null;
    // Host Retry continues the same binding without service.retry(). Only a
    // fresh turn of a failed native run may regain permission; never cancellation.
    if(t.nativeSession&&t.status==='failed'&&run?.status==='failed'&&run.terminalId===t.terminalId&&meta?.activity==='working'&&meta.agent==='dsh-native'&&meta.taskId===t.id&&meta.sessionId===run.sessionId&&Number(meta.turnSequence)>Number(run.failedTurnSequence??0)&&Date.parse(meta.lastTurnStartedAt)>=Date.parse(run.endedAt))return {controller:new AbortController()};
    return null;
  }
  operationKey(t,terminalId=t.terminalId){return this.service.store.setting('cloud-write-operation-key:'+terminalId)??'cloud-write-operations:'+libraryNamespaceKey(t.feishuRoot,t.feishuApp);}
  completedOperations(t,key=this.operationKey(t)){
    const s=this.service,operations=s.store.setting(key)??[];
    const completed=operations.filter(v=>{if(!v.completionPath)return false;try{const receipt=JSON.parse(readFileSync(v.completionPath,'utf8'));return receipt.operationId===v.operationId&&receipt.terminalId===v.terminalId&&receipt.requestId===v.requestId;}catch{return false;}});
    if(completed.length){s.store.saveSetting(key,operations.filter(v=>!completed.includes(v)));for(const v of completed)try{unlinkSync(v.completionPath);}catch{}}
    return operations.filter(v=>!completed.includes(v));
  }
  sweep(){
    for(const [key,lock] of this.locks){
      if(!lock.owner)continue;
      const t=this.service.require(lock.owner),meta=this.service.store.terminal(lock.terminalId??t.terminalId);
      const operations=this.completedOperations(t,'cloud-write-operations:'+key);
      const expired=lock.expiresAt<=this.now()&&!operations.length&&!lock.preparing;
      if(lock.revoked||!this.writer(t)||lock.terminalId!==t.terminalId||lock.turnSequence!==undefined&&lock.turnSequence!==Number(meta?.turnSequence??0)||expired)this.release(lock.owner,lock.terminalId);
      else if(operations.length||lock.preparing)lock.expiresAt=this.now()+this.idleTimeoutMs;
    }
  }
  assign(lock,id,terminalId){
    const meta=this.service.store.terminal(terminalId);
    Object.assign(lock,{owner:id,terminalId,turnSequence:Number(meta?.turnSequence??0),leaseId:randomUUID(),expiresAt:this.now()+this.idleTimeoutMs,revoked:false});
  }
  operation(id,{requestId,terminalId,action,operationId,leaseId}){
    const s=this.service,t=s.require(id),key=this.operationKey(t,terminalId);
    if(action==='finish'){
      const operations=s.store.setting(key)??[];
      const operation=operations.find(v=>v.operationId===operationId&&v.taskId===id&&v.terminalId===terminalId&&v.requestId===requestId);
      if(!operation){
        if(operations.some(v=>v.operationId===operationId))throw Object.assign(new Error('写入操作不属于当前轮次'),{status:409});
        const directory=s.store.terminal(terminalId)?.writeGuard?.operationDirectory;
        if(directory&&operationId)try{unlinkSync(resolve(directory,operationId+'.json'));}catch{}
        return {ok:true};
      }
      s.store.saveSetting(key,operations.filter(v=>v!==operation));
      if(operation.completionPath)try{unlinkSync(operation.completionPath);}catch{}
      const lock=this.locks.get(key.slice('cloud-write-operations:'.length));
      if(!this.writer(t)||t.status==='ready'||lock?.revoked||t.terminalId!==terminalId)this.release(id,terminalId);
      else if(lock)lock.expiresAt=this.now()+this.idleTimeoutMs;
      return {ok:true};
    }
    this.sweep();
    const operations=s.store.setting(key)??[];
    const meta=s.store.terminal(terminalId),active=this.writer(t),lock=this.locks.get(libraryNamespaceKey(t.feishuRoot,t.feishuApp));
    if(!active||active.controller.signal.aborted||t.terminalId!==terminalId||meta?.deliveryRequestId!==requestId||lock?.owner!==id||lock.terminalId!==terminalId||lock.revoked||lock.turnSequence!==Number(meta?.turnSequence??0)||meta?.writeGuard?.leasePath&&leaseId!==lock.leaseId)throw Object.assign(new Error('保存权限已失效，请从工作台重试'),{status:409});
    if(operations.length)throw Object.assign(new Error('已有飞书写入正在执行，请等待结束后继续'),{status:409});
    assertDocumentAvailable(s,t);assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    const operation={operationId:operationId??randomUUID(),taskId:id,terminalId,requestId,startedAt:new Date().toISOString()};
    if(meta?.writeGuard?.operationDirectory)operation.completionPath=resolve(meta.writeGuard.operationDirectory,operation.operationId+'.json');
    lock.expiresAt=this.now()+this.idleTimeoutMs;
    s.store.saveSetting('cloud-write-operation-key:'+terminalId,key);
    s.store.saveSetting(key,[...operations,operation]);return {operationId:operation.operationId};
  }
  async acquire(id,requestId){
    this.sweep();
    const s=this.service,t=s.require(id),active=this.writer(t),terminalId=t.terminalId;
    this.completedOperations(t);
    assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    assertDocumentAvailable(s,t);
    const meta=t.terminalId&&s.store.terminal(t.terminalId);
    if(!active||active.controller.signal.aborted||meta?.deliveryRequestId!==requestId)throw Object.assign(new Error('任务轮次已失效'),{status:409});
    const key=libraryNamespaceKey(t.feishuRoot,t.feishuApp);
    const existingLock=this.locks.get(key);
    if((s.store.setting(this.operationKey(t))??[]).some(v=>{
      const owner=s.require(v.taskId),ownerMeta=s.store.terminal(v.terminalId);
      const currentOwner=existingLock?.owner===v.taskId&&existingLock.terminalId===v.terminalId&&!existingLock.revoked&&owner.terminalId===v.terminalId&&existingLock.turnSequence===Number(ownerMeta?.turnSequence??0)&&this.writer(owner);
      return v.taskId===id||!currentOwner;
    }))throw Object.assign(new Error('前一轮写入操作尚未结束，请核对保存状态后重试'),{status:409});
    const uncertain=s.store.setting('cloud-write-pending:'+key);
    const supersededTurn=uncertain?.owner===id&&uncertain.terminalId===t.terminalId&&Number(meta?.turnSequence)>Number(uncertain.turnSequence??t.runs?.at(-1)?.failedTurnSequence??0)&&Date.parse(meta?.lastTurnStartedAt)>=Date.parse(t.runs?.at(-1)?.endedAt);
    if(uncertain&&s.store.terminal(uncertain.terminalId)?.activity==='working'&&!this.guarded(s.store.terminal(uncertain.terminalId))&&!supersededTurn)throw Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409});
    if(uncertain)s.store.saveSetting('cloud-write-pending:'+key,null);
    let lock=this.locks.get(key);
    if(lock?.owner){
      const ownerTask=s.require(lock.owner),ownerMeta=s.store.terminal(lock.terminalId??ownerTask.terminalId);
      const replaced=lock.owner===id&&lock.terminalId&&lock.terminalId!==t.terminalId;
      if(replaced&&ownerMeta?.activity==='working'&&!this.guarded(ownerMeta))throw Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409});
      if(ownerMeta?.activity!=='working'&&(!s.active.has(lock.owner)||replaced)){this.release(lock.owner);lock=this.locks.get(key);}
    }
    if(!lock){lock={owner:null,waiters:[]};this.locks.set(key,lock);}
    if(lock.owner===id&&!lock.revoked&&lock.terminalId===terminalId){try{return await this.snapshot(t);}catch(e){this.release(id,terminalId);throw e;}}
    if(lock.owner){
      t.stage='waiting_save';s.save(t);
      await new Promise((resolve,reject)=>{
        const waiter={id,terminalId:t.terminalId,reject:e=>{active.controller.signal.removeEventListener('abort',abort);reject(e);},resolve:()=>{active.controller.signal.removeEventListener('abort',abort);resolve();}};
        const abort=()=>{lock.waiters=lock.waiters.filter(w=>w!==waiter);reject(Object.assign(new Error('任务已取消'),{status:409}));};
        lock.waiters.push(waiter);active.controller.signal.addEventListener('abort',abort,{once:true});
      });
    }else {this.assign(lock,id,t.terminalId);}
    try{if(active.controller.signal.aborted||s.require(id).terminalId!==terminalId||!this.writer(s.require(id)))throw Object.assign(new Error('任务轮次已失效'),{status:409});return await this.snapshot(s.require(id));}catch(e){this.release(id,terminalId);throw e;}
  }
  async snapshot(t){
    const s=this.service;
    assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    assertDocumentAvailable(s,t);
    const lock=this.locks.get(libraryNamespaceKey(t.feishuRoot,t.feishuApp));
    lock.preparing=(lock.preparing??0)+1;
    try{if(s.directories)await s.directories.prepare(t,s.active.get(t.id)?.controller.signal);else s.prepareCloudRoot(t);}
    finally{lock.preparing--;}
    if(s.require(t.id).terminalId!==t.terminalId||!this.writer(s.require(t.id)))throw Object.assign(new Error('任务轮次已失效'),{status:409});
    this.assertOwner(t);
    if(lock.revoked)throw Object.assign(new Error('任务轮次已失效'),{status:409});
    lock.expiresAt=this.now()+this.idleTimeoutMs;
    assertTopicAvailable(s,t.topic,t.feishuRoot,t.feishuApp);
    assertDocumentAvailable(s,t);
    t.industryLibrary=library(s.store,t.feishuRoot,t.feishuApp);
    assertCompanyWriteTargets(s,t);
    if(t.briefing)t.briefingLibrary=s.store.setting(briefingKey(t))??{};
    if(t.internal)t.internalFolders=s.store.setting(internalFolderKey(t))??{};
    if(t.topic){t.topicLibrary=s.store.setting(t.topic.workflowVersion===468?topicFolderKey(t):legacyTopicFolderKey(t))??{};t.topicDocument=s.store.setting(topicDocumentKey(t))??{};if(t.topic.window)t.topicDailyDocument=s.store.setting(topicDailyDocumentKey(t))??{};}
    t.stage='research';s.save(t);
    return {leaseId:lock.leaseId,topicDailyDocument:t.topicDailyDocument,topicLibrary:t.topicLibrary,topicDocument:t.topicDocument,feishuRoot:t.feishuRoot,industryLibrary:t.industryLibrary,briefingLibrary:t.briefingLibrary,internalFolders:t.internalFolders,analysisIndex:t.analysisIndex};
  }
  assertOwner(t){const lock=this.locks.get(libraryNamespaceKey(t.feishuRoot,t.feishuApp));if(this.service.directories&&lock?.owner!==t.id||lock?.owner&&(lock.owner!==t.id||lock.terminalId!==t.terminalId))throw new Error('请先获取本轮保存锁与已确认的唯一目录，再回传交付结果');}
  release(id,expectedTerminalId){for(const [key,lock] of this.locks){
    if(lock.owner!==id||expectedTerminalId&&lock.terminalId!==expectedTerminalId)continue;
    const t=this.service.require(id),terminalId=lock.terminalId??t.terminalId,meta=terminalId&&this.service.store.terminal(terminalId);
    // Revoke admission first. A late command cannot start after the lock is
    // handed over, even if a missed host event still says "working".
    lock.revoked=true;
    if(this.guarded(meta)){const fenceKey='cloud-write-revoked:'+terminalId,prior=this.service.store.setting(fenceKey);this.service.store.saveSetting(fenceKey,{requestId:meta.deliveryRequestId,turnSequence:Math.max(prior?.requestId===meta.deliveryRequestId?prior.turnSequence:0,lock.turnSequence??Number(meta.turnSequence??0))});}
    if(lock.preparing||this.completedOperations(t,'cloud-write-operations:'+key).some(v=>v.taskId===id&&v.terminalId===terminalId))continue;
    // Legacy sessions without a guarded CLI cannot be fenced by this service.
    const oldTurnEnded=lock.turnSequence!==undefined&&Number(meta?.turnSequence??0)>lock.turnSequence;
    if(t.status!=='ready'&&meta?.activity==='working'&&!this.guarded(meta)&&!oldTurnEnded){
      this.service.store.saveSetting('cloud-write-pending:'+key,{owner:id,terminalId,turnSequence:lock.turnSequence??meta.turnSequence??0});
      for(const waiter of lock.waiters)waiter.reject(Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409}));lock.waiters=[];continue;
    }
    this.service.store.saveSetting('cloud-write-pending:'+key,null);
    const next=lock.waiters.shift();if(next){this.assign(lock,next.id,next.terminalId);next.resolve();}else this.locks.delete(key);
  }}
}
