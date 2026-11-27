import { TOPIC_FOLDER, TOPIC_DIGEST_FOLDER, topicDocumentKey, topicDailyDocumentKey, topicFolderKey, topicDeletionState } from './topics.mjs';
import { digestFileDate, digestTitleDate, ownsLegacyDigestTopic } from './topic-digest-archive.mjs';
import { createHash } from 'node:crypto';
import { libraryKey, listDriveFolder } from './industry.mjs';
import { LibraryRefreshError } from './library-errors.mjs';
import { matchingFolders, driveToken, folderName } from './folder-identity.mjs';
import { documentRemoved } from './document-deletion-state.mjs';
import { readTopicMinuteTitle } from './topic-window.mjs';

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
  return `cloud-publications:${libraryKey(root, app)}:${root.folderToken ?? ''}:${kind}:${kind === 'internal' ? directoryName : ''}${kind==='topic'?':v3:'+ (app?.ownerOpenId??''):''}`;
}

// Read only metadata, on tab entry/manual refresh. Polling serves the cache.
// Never re-create tasks or send notifications for a document found in Drive.
export async function cloudPublications(service, kind, { refresh = false, run } = {}) {
  const root = service.feishuSettings(), app = service.binding?.applicationSnapshot?.();
  const directoryName = service.store.setting('internal-directory-name') ?? '内部资料';
  const key = publicationCacheKey(root, app, kind, directoryName);
  const cached = service.store.setting(key) ?? { items: [] };
  if (!refresh || !service.cloudOnly || !root.folderToken) return {...cached,items:cached.items.filter(t=>!documentRemoved(service.store,root,app,t.publication?.url))};
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

  const result = { items:items.filter(t=>!documentRemoved(service.store,root,app,t.publication?.url)), syncedAt: new Date().toISOString() };
  service.store.saveSetting(key, result);
  return result;
}

export function mergePublicationCards(local, remote) {
  const urls = new Set(local.map(t => t.publication?.url).filter(Boolean));
  return [...local, ...remote.filter(t => !urls.has(t.publication.url))];
}

async function readTopicPublications(service,{root,app,key,list,children}){
  const roots=await list(root.folderToken);
  const modernParents = new Set(matchingFolders(roots, TOPIC_FOLDER).map(driveToken));
  const parents = new Set([...modernParents, ...matchingFolders(roots, '专题调研库').map(driveToken)]);
  const items=[],digests=new Map(),known=service.store.list().filter(t=>t.topic),uuid=seed=>{
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
    const reservedName = folder => modernParents.has(parent) && folderName(folder.name) === TOPIC_DIGEST_FOLDER;
    const folders = files.filter(file => file.type === 'folder' && !reservedName(file));
    if (modernParents.has(parent)) folders.push(...matchingFolders(files, TOPIC_DIGEST_FOLDER));
    for(const folder of folders){
      const token=driveToken(folder),content=await list(token);
      const previous=known.find(t=>t.topicLibrary?.folderToken===token||service.store.setting(topicFolderKey(t))?.folderToken===token);
      if (folderName(folder.name) === TOPIC_DIGEST_FOLDER && modernParents.has(parent)) {
        const legacy = ownsLegacyDigestTopic(service.store, root, app, token, content, known);
        let hasDigestTitles = false;
        for (const report of content) {
          const date = digestTitleDate(report);
          if (!date) continue;
          hasDigestTitles = true;
          if (!digests.has(date)) digests.set(date, new Set());
          digests.get(date).add(!legacy && digestFileDate(report) ? report.url : null);
        }
        // Treat loose files as archive extras, not a topic. Never expose a
        // mixed folder as deletable through a synthetic topic card.
        if (!legacy || hasDigestTitles) continue;
      }
      const topic={question:folder.name,sources:[],requirements:'',topicId:previous?.topic.topicId??uuid(token),workflowVersion:468};
      const totalFiles=content.filter(isDocument);
      if(totalFiles.length>1)throw new LibraryRefreshError('TOPIC_TOTAL_AMBIGUOUS','专题目录存在多份总报，请核对文档后刷新；本地记录保留');
      const total=totalFiles[0];
      if(total)items.push(record(total,topic,{topicFolderToken:token,topicRootFolderToken:parent,dailyFolderToken:matchingFolders(content,'日报')[0]&&driveToken(matchingFolders(content,'日报')[0])}));
      else items.push({id:'folder-'+token,remoteOnly:true,direction:'专题总报 · '+topic.question,status:'ready',createdAt:timestamp(folder),topic,topicFolderToken:token,publication:{status:'pending'}});
      const dailyFolders=matchingFolders(content,'日报').map(driveToken);
      for(const daily of (await readFolders(dailyFolders,list)).filter(isDocument)){
        const name=(daily.name??'').trim();
        const precise=readTopicMinuteTitle(name);
        const range=/(\d{4}-\d{2}-\d{2})(?: 至 (\d{4}-\d{2}-\d{2}))?$/.exec(name);
        const firstDay=range?.[1]??/\d{4}-\d{2}-\d{2}/.exec(name)?.[0];
        const lastDay=range?.[2]??firstDay;
        const start=Date.parse(firstDay+'T00:00:00+08:00'), last=Date.parse(lastDay+'T00:00:00+08:00');
        const window=precise??(Number.isFinite(start)&&last>=start
          ? {start:new Date(start).toISOString(),end:new Date(last+86400000).toISOString(),display:range?.[2]?firstDay+' 至 '+lastDay:firstDay}
          : {start:'',end:'',display:'历史日报 · 统计区间见文档'});
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
  const [date, urls] = [...digests].filter(([, urls]) => urls.size === 1 && !urls.has(null)).sort(([a], [b]) => b.localeCompare(a))[0] ?? [];
  const result={items,digest:urls ? { date, url: [...urls][0] } : null,syncedAt:new Date().toISOString()};
  service.store.saveSetting(key,result);return result;
}
