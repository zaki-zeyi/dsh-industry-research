import { pickHostFile } from './host-file-picker.mjs';
import { internalMaterialPrompt } from '../server/internal-material-prompt.mjs';
import { Briefings } from './Briefings.jsx';
import { InternalMaterials } from './InternalMaterials.jsx';
import { briefingPrompt, reportWindow } from './briefing-prompt.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { Library, History, Plus, Search, ArrowUpRight, RefreshCw, X, Sparkles, LoaderCircle, Folder, Building2, Check, AlertCircle, FileText } from 'lucide-react';
import { DEFAULT_COMPANIES } from '../server/industry-defaults.mjs';
import { hostOrigin } from './host-origin.mjs';
import './industry.css';
async function api(path, options = {}) { const r = await fetch('/api' + path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } }); const value = await r.json(); if (!r.ok) throw new Error(value.error ?? '请求失败'); return value; }
const time = value => new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value));
const status = t => t.stage==='waiting_save'?'等待保存（其他任务正在写入）':({ ready: '已完成', failed: '失败', interrupted: '已中断', running: '调研中', queued: '排队中' })[t.status] ?? t.status;
export function IndustryApp({ BindingModal, RootModal, Conversation }) {
  const [config, setConfig] = useState(null), [binding, setBinding] = useState(null), [tab, setTab] = useState('library');
  const [companies, setCompanies] = useState([]), [tasks, setTasks] = useState([]), [cursor, setCursor] = useState(null), [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [modal, setModal] = useState(''), [selected, setSelected] = useState(null), [resumeModal, setResumeModal] = useState('');
  const [filter, setFilter] = useState('all');
  const [refreshing, setRefreshing] = useState(false), [syncError, setSyncError] = useState(''), [syncedAt, setSyncedAt] = useState(null);
  const syncLock = useRef(false), libraryRevision = useRef(0), hasLibraryResult = useRef(false);
  async function load() {
    const revision = libraryRevision.current;
    try {
      const [c, l, t] = await Promise.all([api('/config'), api('/industry/library'), api('/tasks?limit=100')]);
      setConfig(c);
      if ((!syncLock.current && revision === libraryRevision.current) || !hasLibraryResult.current) { hasLibraryResult.current = true; setCompanies(l.companies); setSyncedAt(l.syncedAt ?? null); }
      setTasks(old => [...t.items, ...old.filter(v => !t.items.some(n => n.id === v.id))]); setCursor(old => old ?? t.nextCursor);
    } catch (e) { setError(e.message); } finally { setLoading(false); }
  }
  async function refreshCompanies() {
    if (syncLock.current) return;
    syncLock.current = true; libraryRevision.current++; setRefreshing(true); setSyncError('');
    try { const l = await api('/industry/library?refresh=true'); hasLibraryResult.current = true; setCompanies(l.companies); setSyncedAt(l.syncedAt ?? null); }
    catch (e) { setSyncError(e.message); }
    finally { syncLock.current = false; setRefreshing(false); }
  }
  async function refreshBinding() { try { const b = await api('/feishu-binding'); setBinding(b); return b; } catch (e) { setError(e.message); return null; } }
  useEffect(() => { load(); refreshCompanies(); refreshBinding(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, []);
  useEffect(() => { let live = true; const sync = () => { const id = location.hash.slice(1).split('/')[0]; if (/^[a-f0-9-]{36}$/.test(id)) api('/tasks/' + id).then(v => { if (live && location.hash.slice(1).split('/')[0] === id) setSelected(v.task); }).catch(e => setError(e.message)); else setSelected(null); }; sync(); window.addEventListener('hashchange', sync); const timer = setInterval(sync, 2000); return () => { live = false; clearInterval(timer); window.removeEventListener('hashchange', sync); }; }, []);
  useEffect(() => { const receive = e => { const origin = hostOrigin(document.referrer, new URLSearchParams(location.search).get('hostOrigin')); if (origin && e.origin === origin && e.source === window.parent && e.data?.type === 'industry-research:show-report' && (e.data.taskId === '' || /^[a-f0-9-]{36}$/.test(e.data.taskId ?? ''))) location.hash = e.data.taskId; }; window.addEventListener('message', receive); return () => window.removeEventListener('message', receive); }, []);
  const open = t => { setSelected(t); location.hash = t.id; };
  const back = () => { setSelected(null); location.hash = ''; load(); };
  async function begin() { if (config?.cloudOnly) { const b = await refreshBinding(); if (!b) return; if (!b.bound) { setResumeModal('research'); setModal('binding'); return; } } setModal('research'); }
  async function schedule() { if (config?.cloudOnly) { const b = await refreshBinding(); if (!b) return; if (!b.bound) { setResumeModal('schedule'); setModal('binding'); return; } } setModal('schedule'); }
  async function beginInternal() { if (config?.cloudOnly) { const b = await refreshBinding(); if (!b) return; if (!b.bound) { setResumeModal('internal-research'); setModal('binding'); return; } } setModal('internal-research'); }
  async function retry(t) { try { const value = await api(`/tasks/${t.id}/retry`, { method: 'POST', body: JSON.stringify({ stage: 'research' }) }); open(value); load(); } catch (e) { setError(e.message); } }
  const visible = companies.filter(c => c.name.toLowerCase().includes(query.toLowerCase()));
  const history = tasks.filter(t => !t.briefing && !t.internal && t.direction.includes(query) && (filter === 'all' || t.status === filter));
  return <div className="industry-shell">
    <aside className="industry-sidebar"><a className="industry-brand" href="#" onClick={back}><span>研</span>行研工作台</a><div className="side-caption">研究空间</div><button className={['library','history'].includes(tab) && !selected ? 'active' : ''} onClick={() => { back(); setTab('library'); setQuery(''); refreshCompanies(); }}><Library size={18}/>全量信息库<span>{companies.length}</span></button>{['daily','weekly'].map(k=><button key={k} className={tab===k&&!selected?'active':''} onClick={()=>{back();setTab(k);setQuery('');}}><History size={18}/>{k==='daily'?'日报':'周报'}</button>)}<button className={tab === 'internal' && !selected ? 'active' : ''} onClick={() => { back(); setTab('internal'); setQuery(''); }}><FileText size={18}/>内部资料</button><div className="industry-side-bottom"><span className="live-dot"/>一个公司，一份持续生长的研究<small>DSH · Industry Research</small></div></aside>
    <main className="industry-main"><header className="industry-top"><span>行研工作台 <i>/</i> {selected ? 'AI 会话' : tab === 'daily' ? '日报' : tab === 'weekly' ? '周报' : tab === 'internal' ? '内部资料' : tab === 'library' ? '全量信息库' : '全量信息库 / 历史 AI 任务'}</span><div><button onClick={() => setModal('binding')}>{binding?.bound ? '重新绑定飞书' : '绑定飞书'}</button><button onClick={() => setModal('root')}><Folder size={14}/>设置飞书根目录</button></div></header>
    {(syncError || error) && <div className="industry-error" role="alert"><AlertCircle size={17}/>{syncError || error}<button aria-label="关闭错误" onClick={() => { setError(''); setSyncError(''); }}><X size={16}/></button></div>}
    {selected ? <section className="industry-content"><button className="secondary" onClick={back}>← 返回工作台</button><div className="industry-heading"><div><p className="industry-eyebrow">RESEARCH SESSION</p><h1>{selected.direction}</h1><p>{status(selected)} · {time(selected.createdAt)}</p></div>{['failed', 'interrupted'].includes(selected.status) && <button className="primary" onClick={() => retry(selected)}>重试任务</button>}</div>{selected.error && <div role="alert" className="industry-error">{selected.error}</div>}{selected.nativeSession ? <Conversation task={selected}/> : <div className="industry-empty"><Sparkles/><h2>{config?.mode === 'demo' ? '离线流程演示' : '请从 DSH 打开原生会话'}</h2><p>当前任务状态：{status(selected)}。演示不会检索真实资料或上传飞书。</p></div>}</section> : ['daily','weekly'].includes(tab) ? <Briefings kind={tab} config={config} onGenerate={begin} onSchedule={schedule} onOpen={open} onRetry={retry}/> : tab === 'internal' ? <InternalMaterials config={config} onCreate={beginInternal} onOpen={open} onRetry={retry}/> : <section className="industry-content"><p className="industry-eyebrow">INDUSTRY INTELLIGENCE / 01</p><div className="industry-heading"><div><h1>全量信息库</h1><p>{tab === 'library' ? '让分散的信息，成为持续积累的洞察。' : '每一次调研都有迹可循，随时回到原生会话继续探索。'}</p></div><button className="primary" onClick={begin}><Plus size={17}/>更新全量信息库</button></div>
    <div role="tablist" aria-label="全量信息库视图" className="industry-library-tabs" onKeyDown={event => {
      const keys = ['ArrowLeft','ArrowRight','Home','End']; if (!keys.includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 'library' : event.key === 'End' ? 'history' : tab === 'library' ? 'history' : 'library';
      setTab(next); setQuery(''); event.currentTarget.querySelector('#library-tab-' + next)?.focus();
    }}>{[['library','公司档案'],['history','历史 AI 任务']].map(([value,label]) => <button key={value} id={'library-tab-' + value} role="tab" aria-selected={tab === value} aria-controls="library-panel" tabIndex={tab === value ? 0 : -1} onClick={() => {setTab(value);setQuery('');}}>{label}</button>)}</div>
    <div id="library-panel" role="tabpanel" aria-labelledby={'library-tab-' + tab}>
    {config?.mode === 'demo' && <div className="industry-demo">离线演示 · 不执行真实检索或飞书上传；实际调研请在 DSH 中安装本插件。</div>}
    {tab === 'library' && <div className="industry-overview"><div><span>已收录公司</span><strong>{companies.length}<small>家</small></strong></div><div><span>默认关注公司</span><strong>17<small>家</small></strong></div><div className="industry-storage"><span><Folder size={14}/>存储位置</span><strong>{config?.feishuRoot?.folderUrl ? <a href={config.feishuRoot.folderUrl} target="_blank" rel="noreferrer">指定飞书文件夹 <ArrowUpRight size={14}/></a> : `飞书云盘 / ${config?.feishuRoot?.rootName ?? '行研工作台'}`} / 全量信息库</strong><small>一个公司一份文档 · 按维度归档 · 来源可追溯{syncedAt && <> · 上次同步 {time(syncedAt)}</>}</small></div></div>}
    <div className="industry-toolbar"><h2>{tab === 'library' ? '公司档案' : '任务记录'} <span>{tab === 'library' ? companies.length : tasks.length}</span></h2><div><label className="industry-search"><Search size={16}/><input aria-label="搜索" placeholder={tab === 'library' ? '搜索公司名称' : '搜索任务'} value={query} onChange={e => setQuery(e.target.value)}/></label><button className="industry-icon" aria-label="刷新列表" disabled={refreshing} aria-busy={refreshing} onClick={() => tab === 'library' ? refreshCompanies() : load()}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/></button></div></div>
    {tab === 'history' && <div className="industry-filters">{[['all','全部'],['running','调研中'],['ready','已完成'],['failed','失败'],['interrupted','已中断']].map(([v,l]) => <button className={v === filter ? 'current' : ''} key={v} onClick={() => setFilter(v)}>{l}</button>)}</div>}
    {loading ? <div className="industry-empty"><LoaderCircle className="spin"/>正在读取工作台…</div> : tab === 'library' ? visible.length ? <div className="industry-cards">{visible.map((c,i) => <article className="industry-company" key={c.name}><div className="company-top"><span className={'company-monogram color-' + i % 4}>{c.name.slice(0,1)}</span><span className="company-state">已收录</span></div><a className="company-title" href={c.url} target="_blank" rel="noreferrer">{c.name}<ArrowUpRight size={18}/></a><p>{c.dimensions.length} 个研究维度 · 本次新增 {c.added} 条</p><div className="company-dimensions">{c.dimensions.slice(0,3).map(d => <span key={d}>{d}</span>)}{c.dimensions.length > 3 && <span>+{c.dimensions.length - 3}</span>}</div>{c.conflicts > 0 && <div className="company-conflict"><AlertCircle size={14}/>{c.conflicts} 处信息冲突，请在文档中核对来源</div>}<footer><span>{time(c.updatedAt)}</span><button disabled={!c.taskId} onClick={() => { if(c.taskId) location.hash=c.taskId; }}>AI 会话 ↗</button></footer></article>)}</div> : <div className="industry-empty"><Building2 size={32}/><h2>{query ? '没有匹配的公司' : '从第一轮调研开始积累'}</h2><p>{query ? '试试其他公司名称。' : '已准备 17 家关注公司与 5 个研究维度。启动调研后，已完成的公司文档将出现在这里。'}</p>{!query && <button className="secondary" onClick={begin}><Plus size={16}/>更新全量信息库</button>}</div> : history.length ? <div className="industry-history">{history.map(t => <article key={t.id}><span className={'task-status ' + t.status}>{status(t)}</span><div><button onClick={() => open(t)}>{t.direction}</button><p>{time(t.createdAt)} · {t.sources === 'web' ? '全网查询' : t.sources}</p></div>{['failed','interrupted'].includes(t.status) && <button className="secondary" onClick={() => retry(t)}>重试</button>}<button className="secondary" onClick={() => open(t)}>继续会话 <ArrowUpRight size={14}/></button></article>)}{cursor && <button className="secondary" onClick={async () => { try { const page = await api('/tasks?limit=100&cursor=' + cursor); setTasks(v => [...v, ...page.items]); setCursor(page.nextCursor); } catch (e) { setError(e.message); } }}>加载更多</button>}</div> : <div className="industry-empty"><History size={30}/><h2>暂无{filter === 'all' ? '' : '匹配的'}任务记录</h2><p>启动调研后，进度与原生会话会保存在这里。</p></div>}
    <footer className="industry-foot">每一条信息，都有来源。<span>INDUSTRY RESEARCH WORKSPACE</span></footer></div></section>}
    </main>{modal === 'binding' && <BindingModal onClose={() => { setResumeModal(''); setModal(''); }} onStatus={setBinding} onBound={s => { const next = resumeModal; setBinding(s); setResumeModal(''); setModal(next); }}/>} {modal === 'root' && <RootModal current={config?.feishuRoot} onClose={() => setModal('')} onSaved={() => { setModal(''); load(); }}/>} {['schedule','research'].includes(modal) && <ResearchModal scheduled={modal==='schedule'} kind={['daily','weekly'].includes(tab)?tab:null} onClose={() => setModal('')} onCreated={t => { setModal(''); open(t); load(); }}/>} {modal === 'internal-research' && <InternalMaterialModal directoryName={config?.internalDirectoryName} onClose={() => setModal('')} onCreated={t => { setModal(''); open(t); load(); }}/>}</div>;
}
function ChoiceGroup({ title, values, selected, onChange, onAdd }) {
 const [custom, setCustom] = useState('');
 return <fieldset className="industry-choices"><legend>{title}<button type="button" onClick={() => onChange(selected.length === values.length ? [] : values)}>{selected.length === values.length ? '清空' : '全选'}</button></legend><div>{values.map(v => <label key={v}><input type="checkbox" checked={selected.includes(v)} onChange={e => onChange(e.target.checked ? [...selected,v] : selected.filter(x => x !== v))}/>{v}</label>)}</div><div className="industry-add"><input aria-label={'自定义' + title} maxLength={120} placeholder={'添加自定义' + title} value={custom} onChange={e => setCustom(e.target.value)}/><button type="button" disabled={!custom.trim()} onClick={async () => { if (await onAdd(custom.trim())) setCustom(''); }}>＋ 添加</button></div></fieldset>;
}
function ResearchModal({ onClose, onCreated, kind, scheduled=false }) {
 const [prefs, setPrefs] = useState(null), [companyOptions,setCompanyOptions] = useState(DEFAULT_COMPANIES), [companies,setCompanies] = useState(DEFAULT_COMPANIES), [dimensions,setDimensions] = useState([]), [sources,setSources] = useState([]), [requirements,setRequirements] = useState(''), [prompt,setPrompt] = useState(null), [error,setError] = useState(''), [busy,setBusy] = useState(false), [savedPlan,setSavedPlan] = useState(null), [scheduleSaved,setScheduleSaved] = useState(false);
 const [time,setTime]=useState('09:00'),[weekday,setWeekday]=useState(5),[enabled,setEnabled]=useState(true),[available,setAvailable]=useState(true);
 const key = useRef(crypto.randomUUID()), lock = useRef(false), dialog = useRef(null);
 useEffect(() => { let live = true; Promise.all([api('/industry/preferences'),scheduled?api('/briefings/schedule?kind='+kind):Promise.resolve(null)]).then(([v,plan]) => { if (live) {setPrefs({...v,dimensions:[...new Set([...v.dimensions,...(plan?.research.dimensions??[])])],sources:[...new Set([...v.sources,...(plan?.research.sources??[])])]});setDimensions(plan?.research.dimensions??v.dimensions);setSources(plan?.research.sources??v.sources);if(plan){setCompanies(plan.research.companies);setCompanyOptions([...new Set([...DEFAULT_COMPANIES,...plan.research.companies])]);setRequirements(plan.research.requirements);setPrompt(plan.research.prompt??null);setTime(plan.time);setWeekday(plan.weekday);setEnabled(plan.enabled);setAvailable(plan.available);setSavedPlan(plan);}} }).catch(e => setError(e.message)); const previous = document.activeElement; dialog.current?.querySelector('button')?.focus(); const listener = e => { if (e.key === 'Escape' && !lock.current) onClose(); if (e.key === 'Tab') { const els = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)')], first=els[0],last=els.at(-1); if(e.shiftKey && document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first.focus();} } }; document.addEventListener('keydown',listener); return () => { live=false;document.removeEventListener('keydown',listener);previous?.focus(); }; },[]);
 const generated = kind ? briefingPrompt({kind,companies,dimensions,sources,requirements},scheduled?{display:'{{时间范围}}'}:reportWindow(kind)) : `帮我对【${companies.join('、')}】在【${sources.join('、')}】进行【${dimensions.join('、')}】的调研${requirements ? `，并满足【${requirements}】` : ''}，自动去重增量保存到飞书云盘【全量信息库】中。并呈现本次更新摘要。`;
 const change = setter => value => { setter(value); setPrompt(null); };
 async function addPreference(kind,value) { try { const next = {...prefs,[kind]:[...new Set([...prefs[kind],value])]}; const saved=await api('/industry/preferences',{method:'PUT',body:JSON.stringify(next)});setPrefs(saved); (kind==='dimensions'?setDimensions:setSources)(old=>[...new Set([...old,value])]);setPrompt(null);return true; }catch(e){setError(e.message);return false;} }
 async function submit(e) { e.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');try{if(scheduled){const saved=await api('/briefings/schedule',{method:'PUT',body:JSON.stringify({kind,time,weekday,enabled,research:{companies,dimensions,sources,requirements,prompt:prompt??generated}})});setSavedPlan(saved);setScheduleSaved(true);setTime(saved.time);setWeekday(saved.weekday);setEnabled(saved.enabled);return;}const t=await api(kind?'/briefings':'/industry/tasks',{method:'POST',headers:{'Idempotency-Key':key.current},body:JSON.stringify({...(kind?{kind}:{}),companies,dimensions,sources,requirements,prompt:prompt??generated})});onCreated(t);}catch(e){setError(e.message);}finally{lock.current=false;setBusy(false);} }
 return <div className="industry-modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget&&!busy)onClose();}}><section ref={dialog} className="industry-modal" role="dialog" aria-modal="true" aria-labelledby="research-modal-title"><header><span><Sparkles size={18}/> 新一轮调研</span><button disabled={busy} aria-label="关闭调研配置" onClick={onClose}><X size={20}/></button></header><h2 id="research-modal-title">{kind ? `${scheduled?'定时':'手动'}生成${kind==='daily'?'日报':'周报'}` : '更新全量信息库'}</h2><p>选择研究范围，已有资料将自动去重、增量更新。单次调研超过 30 分钟未完成时标记失败，已完成文档保留。</p><form onSubmit={submit}><fieldset disabled={busy || !prefs} className="industry-form-fields">{scheduled&&<><label className="industry-field">发送时间（北京时间）<input type="time" required value={time} onChange={e=>{setTime(e.target.value);setSavedPlan(null);setScheduleSaved(false);}}/></label>{kind==='weekly'&&<label className="industry-field">每周<select value={weekday} onChange={e=>{setWeekday(Number(e.target.value));setSavedPlan(null);setScheduleSaved(false);}}>{['一','二','三','四','五','六','日'].map((v,i)=><option key={v} value={i+1}>周{v}</option>)}</select></label>}<label><input type="checkbox" checked={enabled} onChange={e=>{setEnabled(e.target.checked);setSavedPlan(null);setScheduleSaved(false);}}/>启用此定时任务</label><p>日报和周报分别保存调研配置。Prompt 中的 {'{{时间范围}}'} 会在每次执行时替换为当期范围。</p>{enabled&&savedPlan?.nextRunAt&&<p role="status">下次执行：{savedPlan.nextRunAt && new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(savedPlan.nextRunAt))}（北京时间）</p>}{savedPlan?.todayTimePassed&&<p role="status">今天的发送时间已过。若服务在发送时间正常运行，本日不会补跑；若 DSH 在发送时间关闭，重启后会自动补发。需要立即生成时请使用“手动生成日报”。</p>}{!available&&<p role="alert">当前宿主未启用官方 Schedule 服务。</p>}</>}<ChoiceGroup title="调研公司" values={companyOptions} selected={companies} onChange={change(setCompanies)} onAdd={async value=>{setCompanyOptions(v=>[...new Set([...v,value])]);setCompanies(v=>[...new Set([...v,value])]);setPrompt(null);return true;}}/>{prefs && <><ChoiceGroup title="调研维度" values={prefs.dimensions} selected={dimensions} onChange={change(setDimensions)} onAdd={v=>addPreference('dimensions',v)}/><ChoiceGroup title="数据源" values={[...prefs.sources,'全网查询'].filter((v,i,a)=>a.indexOf(v)===i)} selected={sources} onChange={change(setSources)} onAdd={v=>addPreference('sources',v)}/></>}<label className="industry-field">其他要求<textarea maxLength={2000} placeholder="例如：优先补充最近一年的融资和产品发布信息" value={requirements} onChange={e=>change(setRequirements)(e.target.value)}/></label><label className="industry-field">任务 Prompt <small>可直接编辑</small><textarea className="industry-prompt" required minLength={10} maxLength={14000} value={prompt??generated} onChange={e=>setPrompt(e.target.value)}/></label></fieldset>{error&&<p role="alert" className="industry-error">{error}</p>}<footer><span>{companies.length} 家公司 · {dimensions.length} 个维度 · {sources.length} 个信源</span><button type={scheduleSaved?'button':'submit'} className="primary" onClick={scheduleSaved?onClose:undefined} disabled={busy||!prefs||(scheduled&&!available)||!companies.length||!dimensions.length||!sources.length}>{busy?<LoaderCircle className="spin" size={16}/>:<Sparkles size={16}/>}{scheduleSaved?'关闭':scheduled?'完成':'启动'}</button></footer></form></section></div>;
}

function InternalMaterialModal({ directoryName: initialDirectoryName, onClose, onCreated }) {
  const directoryName = initialDirectoryName ?? '内部资料';
  const [sourceType, setSourceType] = useState('local');
  const [source, setSource] = useState('');
  const [picking, setPicking] = useState(false);
  const pickerController = useRef(null);
  const [requirements, setRequirements] = useState('');
  const [prompt, setPrompt] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const lock = useRef(false);
  const dialog = useRef(null);
  useEffect(() => () => pickerController.current?.abort(), []);
  const generated = internalMaterialPrompt({source: source.trim(), requirements: requirements.trim(), directoryName});

  useEffect(() => {
    const previous = document.activeElement;
    dialog.current?.querySelector('button')?.focus();
    const listener = event => {
      if (event.key === 'Escape' && !lock.current) onClose();
      if (event.key === 'Tab') {
        const elements = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),textarea:not(:disabled)')];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener('keydown', listener);
    return () => {
      document.removeEventListener('keydown', listener);
      previous?.focus();
    };
  }, []);

  function changeSourceType(value) {
    setSourceType(value);
    pickerController.current?.abort();
    setSource('');
    setPrompt(null);
    setError('');
  }

  async function submit(event) {
    event.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    try {
      const task = await api('/internal-materials', {
        method: 'POST',
        headers: { 'Idempotency-Key': key.current },
        body: JSON.stringify({ directoryName, sourceType, source: source.trim(), requirements, prompt: prompt ?? generated }),
      });
      onCreated(task);
    } catch (cause) {
      setError(cause.message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  return <div className="industry-modal-backdrop" onMouseDown={event => {
    if (event.target === event.currentTarget && !busy) onClose();
  }}><section ref={dialog} className="industry-modal" role="dialog" aria-modal="true" aria-labelledby="internal-material-title">
    <header><span><FileText size={18}/> 内部资料解析</span><button disabled={busy} aria-label="关闭内部资料解析" onClick={onClose}><X size={20}/></button></header>
    <h2 id="internal-material-title">内部资料</h2>
    <p>支持录音、视频和内部文档。选择本地文件或填写网络链接，由本次 DSH 会话解析。</p>
    <form onSubmit={submit}><fieldset disabled={busy} className="industry-form-fields">
      <fieldset className="industry-choices"><legend>资料来源</legend><div>
        <label><input type="radio" name="source-type" checked={sourceType === 'local'} onChange={() => changeSourceType('local')}/>本地文件路径</label>
        <label><input type="radio" name="source-type" checked={sourceType === 'url'} onChange={() => changeSourceType('url')}/>网络链接</label>
      </div></fieldset>
      {sourceType === 'local' ? <div className="industry-field">
        <label htmlFor="internal-source-path">本地文件完整路径</label>
        <output id="internal-source-path" style={{overflowWrap:'anywhere',whiteSpace:'pre-wrap',display:'block'}}>{source || '点击选择文件获取完整路径'}</output>
        <button type="button" className="secondary" disabled={picking || busy} onClick={async () => {
          if (picking) return; setPicking(true); setError(''); pickerController.current = new AbortController();
          try { const file = await pickHostFile({signal:pickerController.current.signal}); if (file) {setSource(file.path);setPrompt(null);} }
          catch (cause) { if (!pickerController.current.signal.aborted) setError(cause.message); }
          finally {setPicking(false);}
        }}>{picking ? '正在选择…' : '选择本地文件'}</button>
        <small>单个文件不超过 100 MB，使用原始路径，不复制本地文件。</small>
      </div> : <label className="industry-field">网络资料链接
        <input required maxLength={4000} type="url" placeholder="https://…" value={source} onChange={event => { setSource(event.target.value); setPrompt(null); }}/>
      </label>}
      <label className="industry-field">其他要求
        <textarea maxLength={2000} placeholder="例如：重点核对产品发布时间、融资金额和说话人身份" value={requirements} onChange={event => { setRequirements(event.target.value); setPrompt(null); }}/>
      </label>
      <label className="industry-field">任务 Prompt <small>可直接编辑</small>
        <textarea className="industry-prompt" required minLength={10} maxLength={14000} value={prompt ?? generated} onChange={event => setPrompt(event.target.value)}/>
      </label>
      <p className="ai-config-hint">保存原始资料、逐字稿和会议纪要；提及调研公司时自动去重更新全量信息库。</p>
      {error && <p className="industry-error" role="alert">{error}</p>}
    </fieldset><footer><span>{sourceType === 'local' ? '本地文件' : '网络资料'} · 结果仅存飞书</span><button className="primary" disabled={busy || picking || !source.trim()}>{busy ? <LoaderCircle className="spin" size={16}/> : <FileText size={16}/>}启动</button></footer></form>
  </section></div>;
}
