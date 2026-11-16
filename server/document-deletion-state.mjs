import { ServiceError } from './service-error.mjs';

export const documentScope=(root={},app={})=>JSON.stringify([app?.profile??'default',app?.appId??'',app?.ownerOpenId??'',root.folderToken??root.folderUrl??root.rootName]);
export function canonicalDocumentUrl(value){try{const url=new URL(value);url.search='';url.hash='';return url.href.replace(/\/$/,'');}catch{return value;}}
export const documentResourceKey=(root,app,url)=>'document-deletion-resource:'+documentScope(root,app)+':'+canonicalDocumentUrl(url);
export const documentOperationKey=(scope,kind,target)=>'document-deletion:'+scope+':'+kind+':'+target;
export function documentDeletionState(store,root,app,url){
  if(!url)return null;const key=store.setting(documentResourceKey(root,app,url));return key?store.setting(key):null;
}
export const documentRemoved=(store,root,app,url)=>documentDeletionState(store,root,app,url)?.status==='deleted';
export function assertDocumentAvailable(service,task){
  if(!task?.internal)return;
  const key=documentOperationKey(documentScope(task.feishuRoot,task.feishuApp),'internal',task.id);
  if(service.store.setting(key)||documentDeletionState(service.store,task.feishuRoot,task.feishuApp,task.publication?.url))throw new ServiceError(409,'该内部资料已删除或正在删除，请返回资料列表');
}
export function assertCompanyWriteTargets(service,task){
  const research=task.industry??task.briefing??task.internal?.research;
  for(const company of task.industryLibrary?.companies??[])if(research?.companies?.includes(company.name)&&documentDeletionState(service.store,task.feishuRoot,task.feishuApp,company.url))throw new ServiceError(409,'关联公司资料正在删除，请重新核对后再保存');
}
