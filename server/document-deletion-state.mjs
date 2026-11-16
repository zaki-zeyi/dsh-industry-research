import { ServiceError } from './service-error.mjs';

export const documentScope=(root={},app={})=>JSON.stringify([app?.profile??'default',app?.appId??'',app?.ownerOpenId??'',root.folderToken??root.folderUrl??root.rootName]);
export function canonicalDocumentUrl(value){try{const url=new URL(value);url.search='';url.hash='';return url.href.replace(/\/$/,'');}catch{return value;}}
export const documentResourceKey=(root,app,url)=>'document-deletion-resource:'+documentScope(root,app)+':'+canonicalDocumentUrl(url);
export const documentOperationKey=(scope,kind,target)=>'document-deletion:'+scope+':'+kind+':'+target;
export function documentDeletionState(store,root,app,url){
  if(!url)return null;const key=store?.setting?.(documentResourceKey(root,app,url));return key?store.setting(key):null;
}
export const documentRemoved=(store,root,app,url)=>documentDeletionState(store,root,app,url)?.status==='deleted';
export const documentTaskKind=task=>task?.internal?'internal':task?.analysis?'analysis':task?.briefing?.kind;
export function taskDocumentDeletion(store,task){
  const kind=documentTaskKind(task);if(!kind)return null;
  const scope=documentScope(task.feishuRoot,task.feishuApp);
  return store?.setting?.(documentOperationKey(scope,kind,task.id))
    ??documentDeletionState(store,task.feishuRoot,task.feishuApp,task.analysisReport?.url)
    ??documentDeletionState(store,task.feishuRoot,task.feishuApp,task.publication?.url);
}
export const taskDocumentRemoved=(store,task)=>taskDocumentDeletion(store,task)?.status==='deleted';
export function assertDocumentAvailable(service,task){
  if(taskDocumentDeletion(service.store,task))throw new ServiceError(409,'该资料或报告已删除或正在删除，请返回列表');
}
export function assertCompanyWriteTargets(service,task){
  const research=task.industry??task.briefing??task.internal?.research;
  for(const company of task.industryLibrary?.companies??[])if(research?.companies?.includes(company.name)&&documentDeletionState(service.store,task.feishuRoot,task.feishuApp,company.url))throw new ServiceError(409,'关联公司资料正在删除，请重新核对后再保存');
}
