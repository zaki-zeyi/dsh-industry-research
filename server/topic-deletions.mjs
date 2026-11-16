import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './service-error.mjs';
import { topicCards, topicScope, topicFolderKey, topicDeletionKey, topicDeletionResourceKey } from './topics.mjs';
import { cloudPublications } from './cloud-publications.mjs';
import { forgetTopicDirectory } from './feishu-directories.mjs';

export const topicDeletionInput=z.object({scope:z.string().min(1).max(4000),confirmation:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)}).strict();
const tokenPattern=/^[A-Za-z0-9_-]{1,200}$/;
const sameTarget=(a,b)=>a.type===b.type&&a.token===b.token;

// User-confirmed, scoped deletion plans. Preserve asynchronous task IDs across
// retries/restarts and keep the card until Drive confirms every target is gone.
export class TopicDeletions {
  constructor(service,{publicationRun}={}){this.service=service;this.publicationRun=publicationRun;this.chain=Promise.resolve();this.busy=new Map();}
  scope(){const s=this.service;return topicScope(s.feishuSettings(),s.binding?.applicationSnapshot?.());}
  context(id,scope=this.scope()){
    z.string().uuid().parse(id);
    if(scope!==this.scope())throw new ServiceError(409,'飞书账号或存储位置已变化，请重新打开删除确认');
    const s=this.service,root={...s.feishuSettings()},app={...s.binding?.applicationSnapshot?.()};
    return {id,scope,root,app,key:topicDeletionKey(root,app,id)};
  }
  idle(c,targets=[]){
    const s=this.service;
    const folders=new Set(targets.filter(t=>t.type==='folder').map(t=>t.token));
    const tasks=s.store.list().filter(t=>t.topic&&topicScope(t.feishuRoot,t.feishuApp)===c.scope&&(t.topic.topicId===c.id||folders.has(t.topicLibrary?.folderToken??s.store.setting(topicFolderKey(t))?.folderToken)));
    if(tasks.some(t=>s.active.has(t.id)||s.queue.some(j=>j.id===t.id)||['queued','running'].includes(t.status)||t.publication?.status==='publishing'||t.terminalId&&s.store.terminal(t.terminalId)?.activity==='working'||s.notifications?.active?.has(t.id)))
      throw new ServiceError(409,'该专题有调研、保存或通知正在执行，请完成或停止任务后再删除');
  }
  async authorize(c){
    const bound=await this.service.binding.requireBound(c.app);this.context(c.id,c.scope);
    if(bound?.deletionReady===false){const error=new ServiceError(428,'当前应用尚未获得删除云文档的授权，请补充删除授权后重新核对；尚未停止日报或删除文件');error.code='FEISHU_DELETE_SCOPE_REQUIRED';throw error;}
  }
  async read(c){
    const result=await cloudPublications(this.service,'topic',{refresh:true,run:this.publicationRun});
    this.context(c.id,c.scope);return result;
  }
  async preview(id,scope=this.scope()){
    const c=this.context(id,scope),s=this.service,old=s.store.setting(c.key);
    if(old)return {...old,targets:undefined};
    this.idle(c);await this.authorize(c);
    const remote=await this.read(c),card=topicCards(s,remote.items).find(t=>t.topic.topicId===id);
    if(!card)throw new ServiceError(404,'当前存储位置中没有此专题');
    if(card.deletion)throw new ServiceError(409,'该专题已有删除操作，请从原专题卡片继续核对');
    if(!c.root.folderToken&&(card.totalReport?.publication?.url||card.dailyReports.length))throw new ServiceError(409,'请先确认飞书存储位置，再核对要删除的专题文件');
    const urls=new Set([card.totalReport,...card.dailyReports].map(t=>t?.publication?.url).filter(Boolean));
    const matched=remote.items.filter(t=>t.topic.topicId===id||card.topicFolderToken&&t.topicFolderToken===card.topicFolderToken||urls.has(t.publication?.url));
    const folders=new Set(matched.map(t=>t.topicFolderToken).filter(Boolean));
    const files=remote.items.filter(t=>matched.includes(t)||folders.has(t.topicFolderToken)),targets=[];
    for(const file of files){
      if(file.topicFolderToken){
        if(!tokenPattern.test(file.topicFolderToken)||[c.root.folderToken,file.topicRootFolderToken].includes(file.topicFolderToken))throw new ServiceError(409,'专题目录尚未唯一确认，未执行删除');
        const target={type:'folder',token:file.topicFolderToken,parent:file.topicRootFolderToken,name:file.topic.question};
        if(!targets.some(t=>sameTarget(t,target)))targets.push(target);
      }else if(file.publication?.url){
        const url=new URL(file.publication.url),match=/^\/(docx|docs)\/([A-Za-z0-9_-]{1,200})\/?$/.exec(url.pathname);
        if(!match||!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(url.hostname))throw new ServiceError(409,'旧版专题文档类型无法确认，请先在飞书核对');
        targets.push({type:match[1]==='docx'?'docx':'doc',token:match[2],url:file.publication.url});
      }
    }
    targets.sort((a,b)=>(a.type+':'+a.token).localeCompare(b.type+':'+b.token));
    const reports=[...new Set(files.map(t=>t.publication?.url).filter(Boolean))].sort();
    const confirmation=createHash('sha256').update(JSON.stringify({id,scope,targets,reports})).digest('hex');
    return {topicId:id,scope,question:card.topic.question,status:'ready',confirmation,totalCount:card.totalReport?.publication?.url?1:0,dailyCount:card.dailyReports.length,targets};
  }
  remove(id,input){
    const data=topicDeletionInput.parse(input),job=this.chain.then(()=>this.commit(id,data));this.chain=job.catch(()=>{});return job;
  }
  async json(c,args){
    let result;
    try{result=await this.service.binding.json(args,c.app);}catch{
      throw new ServiceError(503,'飞书删除结果未确认，请检查当前应用的删除权限、登录和网络后重试；已停止的日报不会重新启用');
    }
    if(result?.ok===false||result?.code&&Number(result.code)!==0)throw new ServiceError(503,'飞书未确认删除成功，请检查当前账号和应用的删除权限后重试');
    return result?.data??result;
  }
  async commit(id,data){
    const c=this.context(id,data.scope),s=this.service;
    this.idle(c);await this.authorize(c);
    let operation=s.store.setting(c.key);
    if(operation?.status==='deleted')return {status:'deleted',topicId:id};
    if(!operation){
      operation=await this.preview(id,c.scope);
      if(operation.confirmation!==data.confirmation)throw new ServiceError(409,'专题内容已变化，请重新核对删除范围后确认');
      this.idle(c,operation.targets);
      operation={...operation,status:'pending',targets:operation.targets.map(t=>({...t,done:false})),createdAt:new Date().toISOString()};
    }else if(operation.confirmation!==data.confirmation)throw new ServiceError(409,'删除确认已变化，请重新打开确认窗口');
    // Persist intent before yielding: new research, schedule edits and lock
    // acquisition must stop while this topic's deletion is pending.
    const persist=()=>{s.store.saveSetting(c.key,operation);for(const target of operation.targets)s.store.saveSetting(topicDeletionResourceKey(c.scope,target.type==='folder'?target.token:target.url),c.key);};
    persist();this.busy.set(c.key,{id:'topic-deletion-'+id,title:'删除专题 · '+operation.question,kind:'topic',reason:'uploading',canOpenSession:false});
    try{
      try{await s.topicSchedules.removeTopic(id,c.scope);}catch(error){if(!operation.scheduleStopped){s.store.deleteSetting(c.key);for(const target of operation.targets)s.store.deleteSetting(topicDeletionResourceKey(c.scope,target.type==='folder'?target.token:target.url));}throw error;}
      operation.scheduleStopped=true;persist();this.context(id,c.scope);this.idle(c,operation.targets);
      // Recheck after an uncertain previous request; never delete by name or
      // substitute a newly created folder for the confirmed immutable token.
      const remote=await this.read(c);
      const present=target=>remote.items.some(t=>target.type==='folder'?t.topicFolderToken===target.token:t.publication?.url===target.url);
      for(const target of operation.targets){
        if(target.done)continue;
        if(!present(target)){target.done=true;persist();continue;}
        this.context(id,c.scope);
        const querying=Boolean(target.taskId);
        const response=await this.json(c,querying
          ?['drive','+task_result','--scenario','task_check','--task-id',target.taskId,'--as','user','--json']
          :['drive','+delete','--file-token',target.token,'--type',target.type,'--yes','--as','user','--json']);
        if(typeof response?.task_id==='string'&&response.task_id)target.taskId=response.task_id;
        persist();
        if(response?.failed||['failed','fail','failure'].includes(response?.status))throw new ServiceError(503,'飞书删除失败，请在飞书核对任务后重试；专题日报已停止');
        if(response?.deleted===true||querying&&response?.ready===true&&response?.status==='success')target.done=true;
        else if(!target.taskId)throw new ServiceError(503,'飞书尚未确认删除结果，请稍后重新核对；专题日报已停止');
        persist();
        if(!target.done)return {status:'pending',topicId:id,message:'飞书正在处理删除，专题日报已停止。请稍后点击“继续核对”。'};
      }
      const verified=await this.read(c);
      if(operation.targets.some(target=>verified.items.some(t=>target.type==='folder'?t.topicFolderToken===target.token:t.publication?.url===target.url)))return {status:'pending',topicId:id,message:'正在等待飞书目录确认删除，请稍后继续核对。'};
      operation.status='deleted';operation.deletedAt=new Date().toISOString();
      s.store.transaction(()=>{persist();for(const target of operation.targets)if(target.type==='folder')forgetTopicDirectory(s.store,target.parent,target.name,target.token);});
      s.store.runtimeLog('topic.deleted',{phase:'cloud_write',status:'completed'});
      return {status:'deleted',topicId:id};
    }finally{this.busy.delete(c.key);}
  }
  blockers(){return [...this.busy.values()];}
  async close(){await this.chain;}
}
