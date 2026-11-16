import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ServiceError } from './service-error.mjs';
import { library, libraryKey, listDriveFolder } from './industry.mjs';
import { cloudPublications } from './cloud-publications.mjs';
import { analysisLibrary, analysisKey, ANALYSIS_FOLDER_NAME } from './analysis.mjs';
import { matchingFolders } from './folder-identity.mjs';
import { canonicalDocumentUrl, documentScope, documentOperationKey, documentResourceKey, documentTaskKind } from './document-deletion-state.mjs';
import { serializeTrash, trashTarget } from './cloud-trash.mjs';

export const documentKind=z.enum(['company','internal','analysis','daily','weekly']);
export const documentDeletionInput=z.object({target:z.string().min(1).max(4000),scope:z.string().min(1).max(4000),confirmation:z.string().regex(/^[a-f0-9]{64}$/),confirmed:z.literal(true)}).strict();
function resource(url){
  let parsed;try{parsed=new URL(url);}catch{throw new ServiceError(409,'文档链接无法验证，未执行删除');}
  const match=/^\/(docx|docs|file)\/([A-Za-z0-9_-]{1,200})\/?$/.exec(parsed.pathname);
  if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.port||!/(^|\.)(feishu\.cn|larksuite\.com)$/.test(parsed.hostname)||!match)throw new ServiceError(409,'只支持回收已确认的飞书文档或上传副本');
  return {url:canonicalDocumentUrl(url),type:match[1]==='docs'?'doc':match[1],token:match[2]};
}
const sameFile=(file,target)=>file.type===target.type&&(file.token===target.token||canonicalDocumentUrl(file.url)===target.url);
export class DocumentDeletions {
  constructor(service,{publicationRun}={}){this.service=service;this.run=publicationRun;this.busy=new Map();}
  scope(){return documentScope(this.service.feishuSettings(),this.service.binding?.applicationSnapshot?.());}
  context(kind,target,scope){
    documentKind.parse(kind);z.string().min(1).max(4000).parse(target);
    if(scope!==this.scope())throw new ServiceError(409,'飞书账号或存储位置已变化，请重新打开删除确认');
    const s=this.service,root={...s.feishuSettings()},app={...s.binding?.applicationSnapshot?.()};
    if(!root.folderToken)throw new ServiceError(409,'请先确认飞书根目录，再核对要删除的文档');
    const normalized=canonicalDocumentUrl(target);
    return {kind,target:normalized,scope,root,app,key:documentOperationKey(scope,kind,normalized)};
  }
  async authorize(c){
    const bound=await this.service.binding.requireBound(c.app);this.context(c.kind,c.target,c.scope);
    if(bound?.deletionReady===false){const e=new ServiceError(428,'当前应用尚未获得删除云文档的授权，请补充删除授权后重试');e.code='FEISHU_DELETE_SCOPE_REQUIRED';throw e;}
  }
  async list(c,parent){
    const result=await listDriveFolder(this.run,c.app,parent,{command:this.service.binding.command});this.context(c.kind,c.target,c.scope);
    if(result.truncated)throw new ServiceError(409,'目录尚未读取完整，不能确认删除范围，请稍后重试');return result.files;
  }
  related(task,c,plan){
    if(!task.feishuRoot||documentScope(task.feishuRoot,task.feishuApp)!==c.scope)return false;
    if(c.kind!=='company')return documentTaskKind(task)===c.kind&&(task.id===c.target||task.id===plan?.taskId||[task.publication?.url,task.analysisReport?.url].some(url=>url&&plan?.aliases?.includes(canonicalDocumentUrl(url))));
    return Boolean(plan?.companyName&&[task.industry,task.briefing,task.internal?.research,task.analysis].some(v=>v?.companies?.includes(plan.companyName)));
  }
  idle(c,plan){
    const s=this.service;
    if(s.store.list().filter(t=>this.related(t,c,plan)).some(t=>s.active.has(t.id)||s.queue.some(j=>j.id===t.id)||['queued','running'].includes(t.status)||t.publication?.status==='publishing'||t.terminalId&&s.store.terminal(t.terminalId)?.activity==='working'||s.notifications?.active?.has(t.id)||s.internalNotifications?.active?.has(t.id)||s.internalReconciliation?.active.has(t.id)))throw new ServiceError(409,'关联资料仍在调研、保存或核对，请完成或停止任务后再删除');
  }
  async preview(kind,target,scope){
    const c=this.context(kind,target,scope),s=this.service,old=s.store.setting(c.key);if(old)return {...old,documents:old.documents.map(d=>({...d,taskId:undefined}))};
    await this.authorize(c);
    let plan;
    if(kind==='company'){
      const index=library(s.store,c.root,c.app),company=index.companies.find(v=>canonicalDocumentUrl(v.url)===c.target);
      if(!company)throw new ServiceError(404,'当前信息库中没有此公司资料');
      plan={companyName:company.name,title:company.name,aliases:[c.target],documents:[]};this.idle(c,plan);
      const roots=await this.list(c,c.root.folderToken);
      if(!index.folderToken||!matchingFolders(roots,'全量信息库').some(f=>f.token===index.folderToken))throw new ServiceError(409,'全量信息库目录未确认，未执行删除');
      const wanted={...resource(company.url),label:'公司资料 · '+company.name,parent:index.folderToken};
      if((await this.list(c,index.folderToken)).some(f=>sameFile(f,wanted)))plan.documents.push(wanted);
    }else if(kind==='internal'){
      const local=s.store.list().find(t=>t.internal&&t.id===target&&documentScope(t.feishuRoot,t.feishuApp)===scope);
      const remote=await cloudPublications(s,'internal',{refresh:true,run:this.run});this.context(kind,target,scope);
      const task=local??remote.items.find(t=>t.id===target);
      if(!task)throw new ServiceError(404,'当前目录中没有此内部资料');
      plan={taskId:local?.id,title:task.publication?.sourceTitle??task.internal.sourceLabel??task.direction,aliases:task.publication?.url?[canonicalDocumentUrl(task.publication.url)]:[],documents:[],protectedShared:false};this.idle(c,plan);
      const roots=await this.list(c,c.root.folderToken),directory=task.internal.directoryName??'内部资料';
      const proven=task.internalFolders?.materialFolderToken??task.publication?.materialFolderToken;
      const materials=proven?roots.filter(f=>f.type==='folder'&&f.token===proven):matchingFolders(roots,directory);
      const roleParents={transcript:[],minutes:[],source:[]};
      for(const material of materials){const children=await this.list(c,material.token);for(const [role,name] of [['transcript','逐字稿'],['minutes','会议纪要'],['source','原始资料']])roleParents[role].push(...matchingFolders(children,name).map(f=>f.token));}
      // Older receipts used a direct root child for the transcript directory.
      const legacy=task.publication?.reportFolderToken;
      if(legacy&&roots.some(f=>f.type==='folder'&&f.token===legacy))roleParents.transcript.push(legacy);
      const candidates=[['transcript','逐字稿',task.publication?.url],['minutes','会议纪要',task.publication?.minutesUrl],...(task.internal.sourceType==='local'?[['source','已上传的原始副本',task.publication?.sourceMaterialUrl]]:[])];
      const others=s.store.list().filter(t=>t.internal&&t.id!==task.id&&documentScope(t.feishuRoot,t.feishuApp)===scope&&canonicalDocumentUrl(t.publication?.url)!==canonicalDocumentUrl(task.publication?.url));
      for(const [role,label,url] of candidates){
        if(!url)continue;
        if(!task.remoteOnly&&task.internal.sourceType==='url'&&canonicalDocumentUrl(url)===canonicalDocumentUrl(task.internal.source))continue;
        const wanted={...resource(url),label};
        if(role!=='transcript'&&others.some(t=>[t.publication?.url,t.publication?.minutesUrl,t.publication?.sourceMaterialUrl].some(v=>v&&canonicalDocumentUrl(v)===wanted.url))){plan.protectedShared=true;continue;}
        for(const parent of [...new Set(roleParents[role])])if((await this.list(c,parent)).some(f=>sameFile(f,wanted))){if(!plan.documents.some(d=>d.url===wanted.url))plan.documents.push({...wanted,parent});break;}
      }
    }else{
      let local=s.store.list().find(t=>documentTaskKind(t)===kind&&documentScope(t.feishuRoot,t.feishuApp)===scope&&(t.id===c.target||[t.publication?.url,t.analysisReport?.url].some(url=>url&&canonicalDocumentUrl(url)===c.target)));
      const index=kind==='analysis'?analysisLibrary(s.store,c.root,c.app):null;
      const remote=index?null:await cloudPublications(s,kind,{refresh:true,run:this.run});this.context(kind,target,scope);
      const report=index?.reports.find(r=>canonicalDocumentUrl(r.url)===c.target||r.taskId===c.target);
      if(!local&&report?.taskId)local=s.store.list().find(t=>t.id===report.taskId&&documentTaskKind(t)===kind&&documentScope(t.feishuRoot,t.feishuApp)===scope);
      const task=local??remote?.items.find(t=>t.id===c.target||canonicalDocumentUrl(t.publication?.url)===c.target);
      if(!task&&!report)throw new ServiceError(404,'当前目录中没有此报告');
      const url=report?.url??task?.analysisReport?.url??task?.publication?.url;
      plan={taskId:local?.id,title:report?.title??task.direction,aliases:url?[canonicalDocumentUrl(url)]:[],documents:[]};this.idle(c,plan);
      const label=kind==='analysis'?'友商分析':kind==='daily'?'日报':'周报';
      if(url){
        if(index?.manifestUrl&&canonicalDocumentUrl(index.manifestUrl)===canonicalDocumentUrl(url))throw new ServiceError(409,'报告不能使用共享索引文档，未执行删除');
        const roots=await this.list(c,c.root.folderToken),parents=matchingFolders(roots,kind==='analysis'?ANALYSIS_FOLDER_NAME:label);
        const proven=index?.folderToken??task?.publication?.reportFolderToken;
        if(proven&&!parents.some(f=>f.token===proven))throw new ServiceError(409,'报告目录与当前根目录不一致，未执行删除');
        const wanted={...resource(url),label};
        for(const parent of parents.filter(f=>!proven||f.token===proven))if((await this.list(c,parent.token)).some(f=>sameFile(f,wanted))){plan.documents.push({...wanted,parent:parent.token});break;}
      }
    }
    plan.documents.sort((a,b)=>a.url.localeCompare(b.url));
    const confirmation=createHash('sha256').update(JSON.stringify({kind,target:c.target,scope,documents:plan.documents,aliases:plan.aliases})).digest('hex');
    return {...plan,kind,target:c.target,scope,status:'ready',confirmation};
  }
  remove(kind,input){const data=documentDeletionInput.parse(input);return serializeTrash(this.service,()=>this.commit(kind,data));}
  async commit(kind,data){
    const c=this.context(kind,data.target,data.scope),s=this.service;await this.authorize(c);
    let plan=s.store.setting(c.key);if(plan?.status==='deleted')return {status:'deleted'};
    if(!plan){plan=await this.preview(kind,data.target,data.scope);if(plan.confirmation!==data.confirmation)throw new ServiceError(409,'文档范围已变化，请重新核对后确认');plan={...plan,status:'pending',documents:plan.documents.map(d=>({...d,done:false}))};}
    else if(plan.confirmation!==data.confirmation)throw new ServiceError(409,'删除确认已变化，请重新打开确认窗口');
    this.idle(c,plan);
    const persist=()=>{s.store.saveSetting(c.key,plan);if(plan.taskId)s.store.saveSetting(documentOperationKey(c.scope,kind,plan.taskId),plan);for(const url of plan.aliases)s.store.saveSetting(documentResourceKey(c.root,c.app,url),c.key);};
    persist();this.busy.set(c.key,{id:plan.taskId??'document-deletion',title:'删除资料 · '+plan.title,kind,reason:'uploading',canOpenSession:false});
    try{
      for(const doc of plan.documents){
        this.context(kind,data.target,data.scope);this.idle(c,plan);
        if(!(await this.list(c,doc.parent)).some(f=>sameFile(f,doc))){doc.done=true;persist();continue;}
        if(!await trashTarget(s,c.app,doc,persist))return {status:'pending',message:'飞书正在处理删除，请稍后继续核对。'};
      }
      for(const doc of plan.documents)if((await this.list(c,doc.parent)).some(f=>sameFile(f,doc)))return {status:'pending',message:'正在等待飞书目录确认删除，请稍后继续核对。'};
      this.context(kind,data.target,data.scope);plan.status='deleted';plan.deletedAt=new Date().toISOString();
      s.store.transaction(()=>{persist();if(kind==='company'){const current=library(s.store,c.root,c.app);s.store.saveSetting(libraryKey(c.root,c.app),{...current,companies:current.companies.filter(v=>canonicalDocumentUrl(v.url)!==c.target)});}if(kind==='analysis'){const current=analysisLibrary(s.store,c.root,c.app);s.store.saveSetting(analysisKey(c.root,c.app),{...current,reports:current.reports.filter(v=>!plan.aliases.includes(canonicalDocumentUrl(v.url)))});}});
      s.store.runtimeLog('document.deleted',{phase:'cloud_write',status:'completed'});return {status:'deleted'};
    }finally{this.busy.delete(c.key);}
  }
  blockers(){return [...this.busy.values()];}
  async close(){await this.service.trashChain;}
}
