import { TOPIC_FOLDER, topicDocumentKey, topicDailyDocumentKey, topicFolderKey, topicDeletionState } from './topics.mjs';
import { createHash } from 'node:crypto';
import { libraryKey, listDriveFolder } from './industry.mjs';
import { LibraryRefreshError } from './library-errors.mjs';
import { matchingFolders, driveToken } from './folder-identity.mjs';

const labels = { daily: '日报', weekly: '周报', topic: '专题调研库' };
const isDocument = file => ['docx', 'doc'].includes(file.type) && /^https:\/\//.test(file.url ?? '');
const idFor = url => 'cloud-' + createHash('sha256').update(url).digest('hex').slice(0, 24);
async function readFolders(tokens, read) {
  const results = [];
  for (let i = 0; i < tokens.length; i += 4) results.push(...await Promise.all(tokens.slice(i, i + 4).map(read)));
  return results.flat();
}
const timestamp = file => {
  const n = Number(file.modified_time ?? file.created_time);
  return Number.isFinite(n) && n > 0 ? new Date(n > 1e12 ? n : n * 1000).toISOString() : null;
};
export function publicationCacheKey(root, app, kind, directoryName = '内部资料') {
  return `cloud-publications:${libraryKey(root, app)}:${root.folderToken ?? ''}:${kind}:${kind === 'internal' ? directoryName : ''}${kind==='topic'?':v2:'+ (app?.ownerOpenId??''):''}`;
}

// Read only metadata, on tab entry/manual refresh. Polling serves the cache.
// Never re-create tasks or send notifications for a document found in Drive.
export async function cloudPublications(service, kind, { refresh = false, run } = {}) {
  const root = service.feishuSettings(), app = service.binding?.applicationSnapshot?.();
  const directoryName = service.store.setting('internal-directory-name') ?? '内部资料';
  const key = publicationCacheKey(root, app, kind, directoryName);
  const cached = service.store.setting(key) ?? { items: [] };
  if (!refresh || !service.cloudOnly || !root.folderToken) return cached;
  const list = async token => {
    const result = await listDriveFolder(run, app, token, { command: service.binding?.command });
    if (result.truncated) throw new LibraryRefreshError('LIBRARY_TOO_LARGE', '飞书目录过大，本地记录已保留；请缩小目录后刷新');
    return result.files;
  };
  const children = async (parents, name) => [...new Set(await readFolders(parents, async parent => matchingFolders(await list(parent), name).map(driveToken)))];
  if(kind==='topic')return readTopicPublications(service,{root,app,key,list,children});
  let folderTokens;
  if (kind === 'internal') {
    const materials = await children([root.folderToken], directoryName);
    folderTokens = await children(materials, '逐字稿');
  } else {
    folderTokens = await children([root.folderToken], labels[kind]);
  }
  const files = [...new Map((await readFolders(folderTokens, list)).map(file => [file.url ?? file.token, file])).values()];
  const items = files.filter(isDocument).map(file => {
    const title = String(file.name ?? '').trim() || (labels[kind] ?? '内部资料');
    const common = { id: idFor(file.url), remoteOnly: true, direction: title, status: 'ready', createdAt: timestamp(file), publication: { status: 'published', url: file.url } };
    return kind === 'topic' ? {...common,topic:{question:title,sources:[],requirements:'',topicId:idFor(file.url).slice(6,14)+'-0000-4000-8000-'+createHash('sha256').update(file.url).digest('hex').slice(8,20)}} : kind === 'internal'
      ? { ...common, internal: { directoryName, sourceType: 'url', source: file.url, sourceLabel: title }, publication: { ...common.publication, sourceTitle: title } }
      : { ...common, briefing: { kind, window: { display: '飞书历史报告 · 统计区间见文档' } } };
  });
  // Do not write a result fetched for an application/root that changed mid-request.
  if (publicationCacheKey(service.feishuSettings(), service.binding?.applicationSnapshot?.(), kind, service.store.setting('internal-directory-name') ?? '内部资料') !== key)
    throw new LibraryRefreshError('LIBRARY_CHANGED', '同步期间飞书应用或目录已变化，请重新刷新', 409);

  const result = { items, syncedAt: new Date().toISOString() };
  service.store.saveSetting(key, result);
  return result;
}

export function mergePublicationCards(local, remote) {
  const urls = new Set(local.map(t => t.publication?.url).filter(Boolean));
  return [...local, ...remote.filter(t => !urls.has(t.publication.url))];
}

async function readTopicPublications(service,{root,app,key,list,children}){
  const roots=await list(root.folderToken);
  const parents=[...new Set([TOPIC_FOLDER,'专题调研库'].flatMap(name=>matchingFolders(roots,name).map(driveToken)))];
  const items=[],known=service.store.list().filter(t=>t.topic),uuid=seed=>{
    const hash=createHash('sha256').update(seed).digest('hex');return hash.slice(0,8)+'-0000-4000-8000-'+hash.slice(8,20);
  };
  const record=(file,topic,extra={})=>({id:idFor(file.url),remoteOnly:true,direction:(topic.window?'专题日报 · ':'专题总报 · ')+topic.question,status:'ready',createdAt:timestamp(file),topic,...extra,publication:{status:'published',url:file.url}});
  for(const parent of parents){
    const files=await list(parent);
    // Keep old flat reports visible without moving documents during a read.
    for(const file of files.filter(isDocument)){
      const previous=known.find(t=>t.publication?.url===file.url);
      const topic={question:previous?.topic.question??(file.name||'历史专题').replace(/^(专题调研|专题总报) · /,''),sources:[],requirements:'',topicId:previous?.topic.topicId??uuid(file.url)};
      items.push(record(file,topic,{legacy:true}));
    }
    for(const folder of files.filter(f=>f.type==='folder')){
      const token=driveToken(folder),content=await list(token);
      const previous=known.find(t=>t.topicLibrary?.folderToken===token||service.store.setting(topicFolderKey(t))?.folderToken===token);
      const topic={question:folder.name,sources:[],requirements:'',topicId:previous?.topic.topicId??uuid(token),workflowVersion:468};
      const totalFiles=content.filter(isDocument);
      if(totalFiles.length>1)throw new LibraryRefreshError('TOPIC_TOTAL_AMBIGUOUS','专题目录存在多份总报，请核对文档后刷新；本地记录保留');
      const total=totalFiles[0];
      if(total)items.push(record(total,topic,{topicFolderToken:token,topicRootFolderToken:parent,dailyFolderToken:matchingFolders(content,'日报')[0]&&driveToken(matchingFolders(content,'日报')[0])}));
      else items.push({id:'folder-'+token,remoteOnly:true,direction:'专题总报 · '+topic.question,status:'ready',createdAt:timestamp(folder),topic,topicFolderToken:token,publication:{status:'pending'}});
      const dailyFolders=matchingFolders(content,'日报').map(driveToken);
      for(const daily of (await readFolders(dailyFolders,list)).filter(isDocument)){
        const date=/\d{4}-\d{2}-\d{2}/.exec(daily.name??'')?.[0];
        const parsed=date?Date.parse(date+'T00:00:00+08:00'):NaN;
        const start=Number.isFinite(parsed)?new Date(parsed).toISOString():'';
        const window={start,end:start?new Date(Date.parse(start)+86400000).toISOString():'',display:date??'历史日报 · 统计区间见文档'};
        items.push(record(daily,{...topic,window},{topicFolderToken:token,topicRootFolderToken:parent,dailyFolderToken:matchingFolders(content,'日报')[0]&&driveToken(matchingFolders(content,'日报')[0])}));
      }
    }
  }
  if(publicationCacheKey(service.feishuSettings(),service.binding?.applicationSnapshot?.(),'topic')!==key)throw new LibraryRefreshError('LIBRARY_CHANGED','同步期间专题目录或账号已变化，请刷新重试',409);
  for(const item of items){
    if(topicDeletionState(service.store,root,app,item.topic.topicId,item.topicFolderToken,item.publication?.url))continue;
    const task={...item,feishuRoot:root,feishuApp:app};
    if(!item.topic.window&&item.publication.url)service.store.saveSetting(topicDocumentKey(task),{url:item.publication.url});
    if(item.topicFolderToken){
      const prior=service.store.setting(topicFolderKey(task))??{};
      service.store.saveSetting(topicFolderKey(task),{...prior,rootFolderToken:root.folderToken,folderToken:item.topicFolderToken,topicsFolderToken:item.topicRootFolderToken,dailyFolderToken:item.dailyFolderToken,name:item.topic.question});
    }
    if(item.topic.window?.start&&item.publication.url)service.store.saveSetting(topicDailyDocumentKey(task),{url:item.publication.url});
  }
  const result={items,syncedAt:new Date().toISOString()};service.store.saveSetting(key,result);return result;
}
