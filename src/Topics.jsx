import { ChoiceGroup } from './ChoiceGroup.jsx';
import React, { useEffect, useRef, useState } from 'react';
import { FileText, FolderOpen, ArrowUpRight, Settings2, Trash2 } from 'lucide-react';
import { topicPrompt, topicDailyPrompt, withTopicTotalMerge, normalizeTopicPrompt, isFailedTopicDaily } from '../server/topic-defaults.mjs';
import { topicRangeError, wholeDayTopicRange } from '../server/topic-window.mjs';
import { createTabStore } from './tab-store.mjs';
import { useTabEntry, useTabPolling } from './use-tab-store.js';
import { NotificationRetry } from './NotificationRetry.jsx';
const store=createTabStore({ selectExtra: value => ({
  digest: value?.digest ?? null,
  digestDate: value?.digestDate ?? null,
  generation: value?.digestGeneration ?? null,
  digestArchivedTaskId: value?.digestArchivedTaskId ?? null,
  digestPrompt: typeof value?.digestPrompt === 'string' ? value.digestPrompt : null,
  digestRetryable: value?.digestRetryable === true,
  digestCanCreate: value?.digestCanCreate === true,
}) });
const digestIsActive = generation => ['preparing', 'start_failed', 'queued', 'running', 'waiting', 'retrying'].includes(generation?.status);
async function api(path,options={}){const r=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json',...options.headers}});const v=await r.json();if(!r.ok){const error=new Error(v.error??'请求失败');error.code=v.code;throw error;}return v;}
const selectedTopics=new Map();
const taskStatus=t=>t.status==='running'&&t.stage==='waiting_save'?'等待保存':t.status==='running'&&t.stage==='saving'?'正在保存':({ready:'已完成',queued:'排队中',running:'调研中',failed:'失败',interrupted:'已中断'})[t.status]??t.status;
export function Topics({config,onOpen,onRetry,onFixNotification,onRebind}){
 const key='topics:'+(config?.topicScope??config?.publicationScope);
 const selectionKey=config?.topicSelectionScope??key;
 const [query,setQuery]=useState(''),[modal,setModal]=useState(null),[deleting,setDeleting]=useState(null),[error,setError]=useState(''),[selected,setSelected]=useState(()=>selectedTopics.get(selectionKey)??null);
 const [batchRetry, setBatchRetry] = useState(null);
 const batchInFlight = useRef(false), currentKey = useRef(key);
 useEffect(() => {
   currentKey.current = key;
   return () => { currentKey.current = null; };
 }, [key]);
 useEffect(()=>{setSelected(selectedTopics.get(selectionKey)??null);setQuery('');},[selectionKey]);
 const loaders={cached:()=>api('/topics'),sync:({force})=>api('/topics?refresh=true'+(force?'&force=true':''))};
 const state=useTabEntry(store,key,loaders),items=state.items;
 const active=items.some(t=>[t.totalReport,...(t.dailyReports??[])].some(r=>r&&['queued','running'].includes(r.status)));
 const generation = state.extra?.generation;
 useTabPolling(store,key,loaders,active || digestIsActive(generation) ? 4000 : 30000);
 const topic=items.find(t=>t.topic.topicId===selected);
 const select=id=>{selectedTopics.set(selectionKey,id);setSelected(id);setQuery('');};
 async function begin(){try{if(config?.cloudOnly){const b=await api('/feishu-binding');if(!b.bound)throw new Error('请先通过上方“绑定飞书”完成授权');}setModal({});}catch(e){setError(e.message);}}
 const refresh=()=>store.refresh(key,loaders);
 const total=topic?.totalReport;
 const hasFailedDaily = items.some(group => !group.deletion && group.dailyReports?.some(isFailedTopicDaily));
 const digestRetryable = state.extra?.digestRetryable;
 const canRetry = Boolean(config?.topicScope && (hasFailedDaily || digestRetryable));
 const batch = batchRetry?.key === key ? batchRetry : null;

 async function retryFailedDailies() {
   if (batchInFlight.current || !canRetry) return;
   batchInFlight.current = true;
   setBatchRetry({key, pending:true});
   try {
     const result = await api('/topics/retry-failed-dailies', {
       method:'POST', body:JSON.stringify({scope:config.topicScope}),
     });
     if (currentKey.current === key) {
       await store.reload(key, loaders, {supersede:true});
     }
     setBatchRetry({key, ...result});
   } catch (error) {
     setBatchRetry({key, error:error.message});
   } finally {
     batchInFlight.current = false;
   }
 }
 return <section className="industry-content"><p className="industry-eyebrow">INDUSTRY INTELLIGENCE / 05</p>{selected&&<button className="secondary" onClick={()=>select(null)}>← 返回专题列表</button>}<div className="industry-heading"><div><h1>{selected?topic?.topic.question??'正在读取专题…':'专题调研'}</h1><p>{selected?'专题总报与每期日报，分别保留研究成果和对应会话。':'选择一个专题，查看总报与全部专题日报。'}</p></div>{selected&&topic?<button className="primary" onClick={()=>setModal({task:{...topic,topic:{...topic.topic,prompt:undefined}},scheduled:true})}>设置日报</button>:<div>
   <button type="button" className="secondary" disabled={Boolean(batch?.pending)||!canRetry} onClick={retryFailedDailies}>
     {batch?.pending?'正在提交重试…':'日报一键重试'}
   </button>
   <button className="primary" onClick={begin}>启动专题调研</button>
 </div>}</div>{!selected && <TopicDigestCard key={key} digest={state.extra?.digest} digestDate={state.extra?.digestDate}
    generation={generation} archivedTaskId={state.extra?.digestArchivedTaskId} digestPrompt={state.extra?.digestPrompt}
    digestRetryable={digestRetryable} digestCanCreate={state.extra?.digestCanCreate} scope={config?.topicScope}
    onOpen={onOpen} onChanged={() => {
      if (currentKey.current === key) return store.reload(key, loaders, { supersede:true });
    }}/> }<div className="topic-storage"><span className="topic-storage-icon" aria-hidden="true"><FolderOpen size={21}/></span><div className="topic-storage-location"><span>存储位置</span><strong>飞书云盘 / {config?.feishuRoot?.rootName??'行研工作台'} / 专题调研{topic?' / '+topic.topic.question:''}</strong><small>{topic?'总报与每期日报按专题归档':'按调研方向归档'}</small></div><div className="topic-storage-sync"><span>上次同步</span><time dateTime={state.syncedAt??undefined}>{state.syncedAt?new Date(state.syncedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'等待同步'}</time></div></div><div className="industry-toolbar">{!selected&&<label className="industry-search"><input aria-label="搜索专题" placeholder="搜索专题" value={query} onChange={e=>setQuery(e.target.value)}/></label>}<button disabled={Boolean(state.syncing)} onClick={refresh}>{state.syncing?'同步中…':'刷新'}</button></div>{(error||state.error||state.syncError)&&<div role="alert" className="industry-error">{error||state.error||state.syncError}<button onClick={refresh}>重试同步</button></div>}
 {!selected&&batch?.error&&<p role="alert" className="industry-error">{batch.error}</p>}
 {!selected&&batch?.accepted!==undefined&&<TopicBatchResult result={batch}/>}
 {!selected?<><div className="industry-cards">{items.filter(t=>t.topic.question.includes(query)).map(t=><TopicCard key={t.topic.topicId} task={t} onSelect={()=>select(t.topic.topicId)} onDelete={()=>setDeleting(t)}/>)}</div>{!items.length&&<div className="industry-empty"><h2>{state.status!=='ready'||state.syncing?'正在读取专题调研…':'暂无调研专题'}</h2><p>启动调研后，将按专题分别展示总报与每日动态。</p></div>}</>:topic?<><h2 className="topic-section-heading">专题总报</h2><div className="industry-cards">{total?<TopicReportCard task={total} title="总报" onOpen={onOpen} onRetry={onRetry} onFixNotification={onFixNotification} onUpdated={()=>store.reload(key,loaders)}/>:<div className="industry-empty"><h3>暂无专题总报</h3><button className="secondary" onClick={()=>setModal({task:topic,scheduled:false})}>生成专题总报</button></div>}</div>{topic.schedule?.enabled&&<p className="card-meta">专题日报 · 每天 {topic.schedule.time}（北京时间）</p>}<h2 className="topic-section-heading">专题日报 <small>{topic.dailyReports.length} 份</small></h2><p className="card-meta">存储位置：专题调研 / {topic.topic.question} / 日报</p><div className="industry-cards">{topic.dailyReports.map(t=><TopicReportCard key={t.id} task={t} title={t.topic.window?.display??t.direction} daily onOpen={onOpen} onRetry={onRetry} onFixNotification={onFixNotification} onUpdated={()=>store.reload(key,loaders)}/>)}</div>{!topic.dailyReports.length&&<div className="industry-empty"><h3>暂无专题日报</h3><p>设置专题日报后，每期报告都会独立保留在这里。</p></div>}</>:<div className="industry-empty">{state.status==='ready'?'当前目录没有此专题，请返回专题列表。':'正在读取专题…'}</div>}
 {deleting&&<TopicDeleteModal task={deleting} scope={config?.topicScope} onRebind={()=>{setDeleting(null);onRebind?.();}} onClose={()=>setDeleting(null)} onDeleted={async()=>{setDeleting(null);store.removeItem(key,deleting.id);await store.reload(key,loaders);}}/>}
 {modal&&<TopicModal task={modal.task} scheduled={modal.scheduled} onClose={()=>setModal(null)} onSaved={t=>{setModal(null);store.reload(key,loaders);if(t){select(t.topic.topicId);onOpen(t);}}}/>}</section>;
}
function TopicBatchResult({result:{accepted, rejected, digestRetry}}) {
  const dailyResult = accepted > 0 ? `已提交 ${accepted} 份专题日报重试。`
    : rejected.length ? '本次未提交任何专题日报。' : '';
  const digestResult = digestRetry === 'submitted' ? '已提交日报汇总重试。'
    : digestRetry === 'waiting' ? '日报汇总正在等待日报补齐，全部恢复后将自动重试。' : '';
  return <div className="topic-batch-result">
    <p role="status">{[dailyResult, rejected.length ? `${rejected.length} 份未能提交。` : '', digestResult]
      .filter(Boolean).join(' ') || '当前没有可重试的专题日报或汇总。'}</p>
    {rejected.length > 0 && <details><summary>查看未提交原因</summary><ul>{rejected.map(report=><li key={report.id}>{report.title}：{report.error}</li>)}</ul></details>}
  </div>;
}

const digestStates = {
  preparing: ['正在准备 AI 会话', '', 'active'],
  start_failed: ['会话尚未创建', '', 'failed'],
  queued: ['排队中', '汇总任务等待处理。', 'active'],
  running: ['生成中', '完成后会发送飞书通知。', 'active'],
  waiting: ['等待日报', '专题日报尚未全部生成，补齐后会继续汇总。', 'waiting'],
  retrying: ['重试中', '汇总或飞书通知暂未完成，系统会继续重试。', 'waiting'],
  failed: ['失败', '汇总生成失败。', 'failed'],
  interrupted: ['已中断', '汇总任务已中断。', 'failed'],
  sent: ['已完成', '汇总已生成并发送飞书通知。', 'done'],
  archived: ['已完成', '可打开已存档的飞书文档。', 'done'],
  idle: ['未生成', '本期尚无汇总任务。', 'idle'],
};

function DigestStatus({label, date, status, retryable, startIssue}) {
  const [text, detail, tone] = digestStates[status] ?? [status, '', 'idle'];
  const note = [status === 'start_failed' ? startIssue : detail,
    tone === 'failed' && retryable && '可通过上方“日报一键重试”提交。'].filter(Boolean).join(' ');
  return <p className="topic-digest-status">
    <span>{label}{date && <> · <time dateTime={date}>{date}</time></>}</span>
    <strong className={'topic-digest-badge '+tone}>{text}</strong>
    {note && <span>{note}</span>}
  </p>;
}

function TopicDigestCard({digest, digestDate, generation, archivedTaskId, digestPrompt, digestRetryable, digestCanCreate, scope, onOpen, onChanged}) {
  const [initialPrompt, setInitialPrompt] = useState(null);
  const [currentPrompt, setCurrentPrompt] = useState(digestPrompt);
  const [saved, setSaved] = useState(false);
  const [conversation, setConversation] = useState(null);
  const [startPending, setStartPending] = useState(false), [startError, setStartError] = useState('');
  const opening = useRef(false), starting = useRef(false), live = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => { setCurrentPrompt(digestPrompt); }, [digestPrompt]);

  // The document link is the latest archive, not necessarily the output of
  // the task shown here, even when the dates match.
  const sameDayArchive = Boolean(digest?.url && digest.date === digestDate);
  const historicalGeneration = generation?.date && digestDate && generation.date !== digestDate ? generation : null;
  const currentGeneration = historicalGeneration ? null : generation;
  const currentStatus = currentGeneration?.status ?? (sameDayArchive ? 'archived' : 'idle');
  const canCreate = Boolean(scope && digestCanCreate && !sameDayArchive);
  // A preflight state has no conversation. Keep the previous document link,
  // but do not present the archived conversation as this attempt's session.
  const preSession = ['preparing', 'start_failed'].includes(generation?.status);
  const taskId = preSession ? null : generation?.taskId ?? archivedTaskId;
  const archiveConversation = taskId && !generation?.taskId && digest?.date
    ? `打开 ${digest.date} 已存档汇总的 AI 会话` : undefined;
  const request = conversation?.taskId === taskId ? conversation : null;

  async function startDigest() {
    if (!canCreate || starting.current) return;
    starting.current = true;
    setStartPending(true);
    setStartError('');
    try {
      const {task} = await api('/topics/digest/start', { method:'POST', body:JSON.stringify({scope}) });
      if (!task?.id) throw new Error('未能取得汇总会话，请刷新专题列表后再试');
      if (live.current) onOpen(task);
    } catch (error) {
      if (live.current) setStartError(error.message);
    } finally {
      await onChanged();
      starting.current = false;
      if (live.current) setStartPending(false);
    }
  }

  async function openConversation() {
    if (!taskId || opening.current) return;
    opening.current = true;
    setConversation({ taskId, pending:true });
    try {
      const {task} = await api('/tasks/'+encodeURIComponent(taskId));
      if (live.current) onOpen(task);
    } catch (error) {
      if (live.current) setConversation({ taskId, error:error.message });
    } finally {
      opening.current = false;
    }
  }

  const content = <>
    <span className="topic-storage-icon" aria-hidden="true"><FileText size={21}/></span>
    <div className="topic-digest-label">
      <h2>日报汇总</h2>
      {digest?.url ? <span>已存档文档 · <time dateTime={digest.date}>{digest.date}</time></span> : <span>全部专题日报生成后，汇总会显示在这里。</span>}
    </div>
    {digest?.url && <ArrowUpRight size={16} aria-hidden="true"/>}
  </>;
  return <div className="topic-digest-card">
    {digest?.url ? <a href={digest.url} target="_blank" rel="noreferrer" className="topic-digest-main" aria-label="打开最新日报汇总">{content}</a>
      : <div className="topic-digest-main">{content}</div>}
    <div className="topic-digest-actions">
      <button type="button" className="secondary topic-digest-settings" disabled={!scope || currentPrompt == null} onClick={()=>{setSaved(false);setInitialPrompt(currentPrompt);}}>
        <Settings2 size={16} aria-hidden="true"/>设置汇总 Prompt
      </button>
      {taskId && <button type="button" className="secondary" title={archiveConversation} disabled={request?.pending} onClick={openConversation}>
        {request?.pending ? '正在打开会话…' : 'AI 会话详情'}
      </button>}
      {(canCreate || startPending) && <button type="button" className="primary" disabled={startPending} onClick={startDigest}>
        {startPending ? '正在提交…' : '生成汇总'}
      </button>}
    </div>
    {(digestDate || generation) && <div className="topic-digest-state" role="status">
      {(digestDate || currentGeneration) && <DigestStatus label="本期任务" date={digestDate ?? currentGeneration?.date} status={currentStatus}
        retryable={digestRetryable} startIssue={currentGeneration?.startIssue}/>}
      {historicalGeneration && <DigestStatus label="最近任务" date={historicalGeneration.date} status={historicalGeneration.status}
        retryable={digestRetryable} startIssue={historicalGeneration.startIssue}/>}
    </div>}
    {saved && <p className="topic-digest-feedback" role="status">汇总 Prompt 已保存。</p>}
    {startError && <p className="topic-digest-feedback topic-digest-error" role="alert">{startError}</p>}
    {request?.error && <p className="topic-digest-feedback topic-digest-error" role="alert">{request.error}</p>}
    {initialPrompt !== null && <TopicDigestModal scope={scope} initialPrompt={initialPrompt} onClose={()=>setInitialPrompt(null)}
      onSaved={prompt=>{setCurrentPrompt(prompt);setSaved(true);setInitialPrompt(null);onChanged();}}/>}
  </div>;
}

function TopicDigestModal({scope, initialPrompt, onClose, onSaved}) {
  const [prompt, setPrompt] = useState(initialPrompt), [pending, setPending] = useState(false), [error, setError] = useState('');
  const dialog = useRef(null), promptField = useRef(null), inFlight = useRef(false), live = useRef(false);
  useEffect(() => {
    live.current = true;
    const previous = document.activeElement;
    promptField.current?.focus();
    function keyDown(event) {
      if (event.key === 'Escape' && !inFlight.current) onClose();
      const section = dialog.current;
      if (event.key !== 'Tab' || !section) return;
      const focusable = [...section.querySelectorAll('button:not(:disabled), textarea:not(:disabled)')];
      const first = focusable[0], last = focusable.at(-1);
      if (!section.contains(document.activeElement) || document.activeElement === (event.shiftKey ? first : last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
    document.addEventListener('keydown', keyDown);
    return () => {
      live.current = false;
      document.removeEventListener('keydown', keyDown);
      previous?.focus();
    };
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || !scope || !prompt.trim()) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api('/topics/digest/settings', { method:'PUT', body:JSON.stringify({scope,prompt}) });
      if (live.current) onSaved(result.prompt);
    } catch (error) {
      if (live.current) setError(error.message);
    } finally {
      inFlight.current = false;
      if (live.current) setPending(false);
    }
  }

  return <div className="industry-modal-backdrop"><section ref={dialog} className="industry-modal topic-digest-modal" role="dialog" aria-modal="true" aria-labelledby="topic-digest-title" aria-describedby="topic-digest-settings-help">
    <header><span>日报汇总</span><button type="button" disabled={pending} aria-label="关闭汇总配置" onClick={onClose}>×</button></header>
    <h2 id="topic-digest-title">设置汇总 Prompt</h2>
    <p id="topic-digest-settings-help">用于今后新建的汇总任务。保存不会启动汇总，现有任务重试时仍使用原 Prompt。</p>
    <form onSubmit={submit}>
      <label className="industry-field">默认汇总 Prompt
        <textarea ref={promptField} className="industry-prompt" required maxLength={14000} readOnly={pending} value={prompt} onChange={event=>setPrompt(event.target.value)}/>
      </label>
      {error && <p className="industry-error" role="alert">{error}</p>}
      <footer><button type="button" className="secondary" disabled={pending} onClick={onClose}>取消</button>
        <button type="submit" className="primary" disabled={pending || !scope || !prompt.trim()}>{pending ? '保存中…' : '保存'}</button>
      </footer>
    </form>
  </section></div>;
}

function TopicCard({task, onSelect, onDelete}) {
  const {question} = task.topic;
  const dailyReports = task.dailyReports ?? [];
  const totalUrl = task.totalReport?.publication?.url;
  // The API orders daily reports by reporting period, newest first.
  const dailyUrl = dailyReports.find(report => report.publication?.status === 'published' && report.publication.url)?.publication.url;
  const shortcuts = [{label: '总报', url: totalUrl}, {label: '日报', url: dailyUrl}];

  return <article className="industry-company topic-card-wrap">
    <button type="button" className="topic-card" id={'task-card-'+task.id} aria-label={'查看专题：'+question} onClick={onSelect}>
      <span className="company-top"><span className="company-monogram">专</span><span className={'task-status '+task.status}>{taskStatus(task)}</span></span>
      <span className="topic-card-title" role="heading" aria-level={2}>{question}</span>
      <span className="topic-card-meta">{totalUrl?'已保存专题总报':'总报待生成'} · {dailyReports.length} 份日报</span>
      {task.schedule?.enabled&&<span className="topic-card-meta">专题日报 · 每天 {task.schedule.time}（北京时间）</span>}
    </button>
    {task.deletion&&<span className="topic-deletion-note">删除未完成，请继续核对</span>}
    <footer className="topic-card-footer">
      {shortcuts.map(({label,url}) => url
        ? <a key={label} className="topic-report-shortcut" href={url} target="_blank" rel="noreferrer"
            aria-label={question+' · '+(label==='日报'?'打开最新日报':'打开总报')}>
            {label}<ArrowUpRight size={14} aria-hidden="true"/>
          </a>
        : <span key={label} className="topic-report-unavailable">暂无{label}</span>)}
      <button type="button" className="topic-delete" aria-label={'删除专题：'+question} title={task.deletion?'继续核对删除':'删除专题'} onClick={onDelete}>
        <Trash2 size={15} aria-hidden="true"/>
      </button>
    </footer>
  </article>;
}
function TopicReportCard({task:t,title,daily,onOpen,onRetry,onFixNotification,onUpdated}){
 return <article className="industry-company topic-report-card" id={'task-card-'+t.id+(daily?'-daily':'')} tabIndex={-1}><div className="company-top"><span className="company-monogram">{daily?'日':'总'}</span><span className={'task-status '+t.status}>{taskStatus(t)}</span></div><h3>{title}</h3>{t.publication?.url&&<a className="company-title" href={t.publication.url} target="_blank" rel="noreferrer">{daily?'打开专题日报':'打开总报'} ↗</a>}{t.error&&<p role="alert">{t.error}</p>}{t.publication?.noUpdates&&<p>本日无更新</p>}{t.publication?.partial&&<p>部分资料缺失，详见报告</p>}{t.notification?.status==='sent'&&<p>飞书机器人已通知</p>}{t.notification?.status==='failed'&&<div role="alert">{t.notification.error}<NotificationRetry task={t} base="topics" onRepair={onFixNotification} onUpdated={onUpdated}/></div>}<footer><button disabled={t.remoteOnly||!t.nativeSessionId} onClick={()=>onOpen(t)}>AI 会话详情 ↗</button>{['failed','interrupted'].includes(t.status)&&<button onClick={()=>onRetry(t)}>重试</button>}</footer></article>;
}
function TopicModal({task,scheduled=false,onClose,onSaved}){
 const [prefs,setPrefs]=useState(null),[question,setQuestion]=useState(task?.topic.question??''),[sources,setSources]=useState(task?.topic.sources??[]),[requirements,setRequirements]=useState(task?.topic.requirements??''),[prompt,setPrompt]=useState(task?.topic.prompt?normalizeTopicPrompt(task.topic.prompt):null),[time,setTime]=useState('09:00'),[range,setRange]=useState(wholeDayTopicRange),[available,setAvailable]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const lock=useRef(false),id=useRef(crypto.randomUUID()),dialog=useRef(null);
 useEffect(()=>{let live=true;Promise.all([api('/industry/preferences'),scheduled?api('/topics/'+task.topic.topicId+'/schedule'):null]).then(([p,plan])=>{if(!live)return;setPrefs(p);if(!task?.topic.sources?.length)setSources(p.sources);if(plan?.research){setQuestion(plan.research.question);setSources(plan.research.sources);setRequirements(plan.research.requirements);setPrompt(plan.research.prompt?withTopicTotalMerge(plan.research.prompt):null);}if(plan){setTime(plan.time);setRange(plan.range??wholeDayTopicRange(plan.lookbackDays));setAvailable(plan.available);}}).catch(e=>{if(live)setError(e.message);});const previous=document.activeElement;dialog.current?.querySelector('button')?.focus();const key=e=>{if(e.key==='Escape'&&!lock.current)onClose();if(e.key==='Tab'){const els=[...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)')],first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',key);return()=>{live=false;document.removeEventListener('keydown',key);previous?.focus();};},[]);
 const generated=(scheduled?topicDailyPrompt:topicPrompt)({question,sources,requirements});
 const change=setter=>v=>{setter(v);setPrompt(null);};
 async function addSource(value){try{const saved=await api('/industry/preferences',{method:'PUT',body:JSON.stringify({...prefs,sources:[...new Set([...prefs.sources,value])]})});setPrefs(saved);change(setSources)([...new Set([...sources,value])]);return true;}catch(e){setError(e.message);return false;}}
 async function submit(e){e.preventDefault();if(lock.current)return;
  const windowError=scheduled?topicRangeError(range,time):'';
  if(windowError){setError(windowError);return;}
  lock.current=true;setBusy(true);setError('');try{const research={question,sources,requirements,prompt:prompt??generated};const t=await api(scheduled?'/topics/'+task.topic.topicId+'/schedule':'/topics',{method:scheduled?'PUT':'POST',headers:{'Idempotency-Key':id.current},body:JSON.stringify(scheduled?{time,range,enabled:true,research}:task?{...research,topicId:task.topic.topicId}:research)});onSaved(scheduled?null:t);}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);}}
 return <div className="industry-modal-backdrop"><section ref={dialog} className="industry-modal" role="dialog" aria-modal="true" aria-labelledby="topic-modal-title"><header><span>专题研究</span><button disabled={busy} aria-label="关闭专题配置" onClick={onClose}>×</button></header><h2 id="topic-modal-title">{scheduled?'设置专题调研日报':'启动专题调研'}</h2><p>报告内容围绕调研方向与其他要求展开。超过 30 分钟未完成标记失败，保留已完成内容。</p><form onSubmit={submit}><fieldset disabled={busy||!prefs} className="industry-form-fields"><label className="industry-field">调研方向<textarea aria-label="调研方向" required minLength={2} maxLength={200} value={question} onChange={e=>change(setQuestion)(e.target.value)}/></label>{prefs&&<ChoiceGroup title="数据源" values={[...new Set([...prefs.sources,'全网查询',...sources])]} selected={sources} onChange={change(setSources)} onAdd={addSource}/>}<label className="industry-field">其他要求<textarea aria-label="其他要求" maxLength={2000} value={requirements} onChange={e=>change(setRequirements)(e.target.value)}/></label>{scheduled&&<><label className="industry-field">发送时间（北京时间）<input type="time" required value={time} onChange={e=>setTime(e.target.value)}/></label><TopicRangeFields range={range} onChange={setRange}/>{!available&&<p role="alert">当前宿主未启用官方 Schedule 服务，请启用后设置专题日报。</p>}</>}<label className="industry-field">任务 Prompt（可直接编辑）<textarea className="industry-prompt" required minLength={10} maxLength={14000} value={prompt??generated} onChange={e=>setPrompt(e.target.value)}/></label></fieldset>{error&&<p className="industry-error" role="alert">{error}</p>}<footer><span>{sources.length} 个数据源</span><button className="primary" disabled={busy||!prefs||!sources.length||(scheduled&&!available)}>{busy?'保存中…':scheduled?'完成':'启动'}</button></footer></form></section></div>;
}

function TopicRangeFields({range,onChange}){
  const change = (field,value) => onChange({...range,[field]:value});
  return <fieldset className="topic-range-fields">
    <legend>调研时间范围（北京时间）</legend>
    <p className="card-meta">日期以发送日为基准，0 天表示发送当天。结束时间不计入调研范围。</p>
    <div className="topic-range-inputs">
      <label className="industry-field">开始日期（发送日前几天）
        <input type="number" min="0" step="1" required value={range.startDaysAgo}
          onChange={e=>change('startDaysAgo',e.target.value===''?'':e.target.valueAsNumber)}/>
      </label>
      <label className="industry-field">开始时间
        <input type="time" step="60" required value={range.startTime} onChange={e=>change('startTime',e.target.value)}/>
      </label>
      <label className="industry-field">结束日期（发送日前几天）
        <input type="number" min="0" step="1" required value={range.endDaysAgo}
          onChange={e=>change('endDaysAgo',e.target.value===''?'':e.target.valueAsNumber)}/>
      </label>
      <label className="industry-field">结束时间
        <input type="time" step="60" required value={range.endTime} onChange={e=>change('endTime',e.target.value)}/>
      </label>
    </div>
    <p className="card-meta">任务 Prompt 的 {'{{时间范围}}'} 会在每次执行时替换。</p>
  </fieldset>;
}

function TopicDeleteModal({task,scope,onClose,onDeleted,onRebind}){
 const [plan,setPlan]=useState(null),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''),[needsAuthorization,setNeedsAuthorization]=useState(false);
 const dialog=useRef(null),locked=useRef(false),live=useRef(true);
 async function read(){setLoading(true);setError('');setNeedsAuthorization(false);try{const p=await api('/topics/'+task.topic.topicId+'/deletion?scope='+encodeURIComponent(scope));if(live.current)setPlan(p);}catch(e){if(live.current){setError(e.message);setNeedsAuthorization(e.code==='FEISHU_DELETE_SCOPE_REQUIRED');}}finally{if(live.current)setLoading(false);}}
 useEffect(()=>{live.current=true;read();const previous=document.activeElement;dialog.current?.querySelector('button')?.focus();const key=e=>{if(e.key==='Escape'&&!locked.current)onClose();if(e.key==='Tab'){const els=[...dialog.current.querySelectorAll('button:not(:disabled)')],first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}};document.addEventListener('keydown',key);return()=>{live.current=false;document.removeEventListener('keydown',key);previous?.focus();};},[]);
 async function remove(){if(locked.current||!plan)return;locked.current=true;setBusy(true);setError('');setMessage('');try{
   const result=await api('/topics/'+task.topic.topicId,{method:'DELETE',body:JSON.stringify({scope:plan.scope,confirmation:plan.confirmation,confirmed:true})});
   if(result.status==='deleted'){await onDeleted();return;}
   if(live.current){setMessage(result.message??'飞书正在处理删除，请稍后继续核对。');setPlan({...plan,status:'pending'});}
 }catch(e){if(live.current){setError(e.message);setNeedsAuthorization(e.code==='FEISHU_DELETE_SCOPE_REQUIRED');setPlan(null);}}finally{locked.current=false;if(live.current)setBusy(false);}}
 return <div className="industry-modal-backdrop"><section ref={dialog} className="industry-modal topic-delete-modal" role="dialog" aria-modal="true" aria-labelledby="topic-delete-title"><header><span>专题管理</span><button aria-label="关闭删除确认" disabled={busy} onClick={onClose}>×</button></header><h2 id="topic-delete-title">删除专题？</h2><p className="topic-delete-name">{task.topic.question}</p><p>将停止该专题的日报，并把本专题目录及其中全部内容（包括总报和日报）移入飞书回收站。</p>{loading?<p role="status">正在核对删除范围…</p>:plan&&<p className="topic-delete-summary">已保存总报 {plan.totalCount} 份 · 日报 {plan.dailyCount} 份</p>}{message&&<p role="status">{message}</p>}{error&&<p role="alert" className="industry-error">{error}</p>}<footer><button type="button" className="secondary" disabled={busy} onClick={onClose}>取消</button><div>{needsAuthorization&&<button type="button" className="secondary" disabled={busy} onClick={onRebind}>补充删除授权</button>}{error&&!needsAuthorization&&<button type="button" className="secondary" disabled={busy||loading} onClick={read}>重新核对</button>}<button type="button" className="topic-confirm-delete" disabled={busy||loading||!plan} onClick={remove}>{busy?'处理中…':plan?.status==='pending'?'继续核对':'确认删除'}</button></div></footer></section></div>;
}
