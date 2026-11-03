import {library,libraryKey} from './industry.mjs';
import {briefingKey} from './briefings.mjs';

// Serialize remote mutations, not research sessions. Locks live only as long as
// their owning run. Unconfirmed cancellation remains blocked until the host
// confirms the old writing turn has ended, including after a service restart.
export class CloudWrites {
  constructor(service){this.service=service;this.locks=new Map();}
  async acquire(id,requestId){
    const s=this.service,t=s.require(id),active=s.active.get(id);
    const meta=t.terminalId&&s.store.terminal(t.terminalId);
    if(!active||active.controller.signal.aborted||meta?.deliveryRequestId!==requestId)throw Object.assign(new Error('任务轮次已失效'),{status:409});
    const key=libraryKey(t.feishuRoot,t.feishuApp);
    const uncertain=s.store.setting('cloud-write-pending:'+key);
    if(uncertain&&s.store.terminal(uncertain.terminalId)?.activity==='working')throw Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409});
    let lock=this.locks.get(key);if(!lock){lock={owner:null,waiters:[]};this.locks.set(key,lock);}
    if(lock.owner===id)return this.snapshot(t);
    if(lock.owner){
      t.stage='waiting_save';s.save(t);
      await new Promise((resolve,reject)=>{
        const waiter={id,reject:e=>{active.controller.signal.removeEventListener('abort',abort);reject(e);},resolve:()=>{active.controller.signal.removeEventListener('abort',abort);resolve();}};
        const abort=()=>{lock.waiters=lock.waiters.filter(w=>w!==waiter);reject(Object.assign(new Error('任务已取消'),{status:409}));};
        lock.waiters.push(waiter);active.controller.signal.addEventListener('abort',abort,{once:true});
      });
    }else lock.owner=id;
    try{if(active.controller.signal.aborted)throw Object.assign(new Error('任务已取消'),{status:409});return this.snapshot(s.require(id));}catch(e){this.release(id);throw e;}
  }
  snapshot(t){
    const s=this.service;s.prepareCloudRoot(t);
    t.industryLibrary=library(s.store,t.feishuRoot,t.feishuApp);
    if(t.briefing)t.briefingLibrary=s.store.setting(briefingKey(t))??{};
    t.stage='research';s.save(t);
    return {feishuRoot:t.feishuRoot,industryLibrary:t.industryLibrary,briefingLibrary:t.briefingLibrary};
  }
  assertOwner(t){const lock=this.locks.get(libraryKey(t.feishuRoot,t.feishuApp));if(lock?.owner&&lock.owner!==t.id)throw new Error('其他任务正在写入信息库，请先获取本轮写入锁');}
  release(id){for(const [key,lock] of this.locks){
    if(lock.owner!==id)continue;
    const t=this.service.require(id),meta=t.terminalId&&this.service.store.terminal(t.terminalId);
    if(t.status!=='ready'&&meta?.activity==='working'){
      this.service.store.saveSetting('cloud-write-pending:'+key,{owner:id,terminalId:t.terminalId});
      for(const waiter of lock.waiters)waiter.reject(Object.assign(new Error('前一保存会话尚未确认结束，请核对原会话后重试'),{status:409}));lock.waiters=[];continue;
    }
    this.service.store.saveSetting('cloud-write-pending:'+key,null);
    const next=lock.waiters.shift();if(next){lock.owner=next.id;next.resolve();}else this.locks.delete(key);
  }}
}
