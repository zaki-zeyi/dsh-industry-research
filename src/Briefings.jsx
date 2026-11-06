import { NotificationRetry } from './NotificationRetry.jsx';
import React, {useEffect,useState} from 'react';
import {AlertCircle,ArrowUpRight,CalendarDays} from 'lucide-react';
async function api(path,options={}) { const r=await fetch('/api/briefings'+path,{...options,headers:{'Content-Type':'application/json'}});const v=await r.json();if(!r.ok)throw new Error(v.error);return v; }
const statusLabel = task => task.stage==='waiting_save' ? '等待保存（其他任务正在写入）' : ({ready:'已完成',failed:'失败',interrupted:'已中断',queued:'排队中',running:'调研中'})[task.status] ?? task.status;
export function Briefings({kind,config,onGenerate,onSchedule,onOpen,onRetry,onFixNotification,notificationRevision}) {
 const [items,setItems]=useState([]),[error,setError]=useState(''),[query,setQuery]=useState('');
 async function load(){try{setItems((await api('?kind='+kind)).items);setError('');}catch(e){setError(e.message);}}
 useEffect(()=>{let live=true;const run=async()=>{try{const v=await api('?kind='+kind);if(live)setItems(v.items);}catch(e){if(live)setError(e.message);}};run();const t=setInterval(run,4000);return()=>{live=false;clearInterval(t);};},[kind,notificationRevision]);
 const name=kind==='daily'?'日报':'周报';
 return <section className="industry-content"><p className="industry-eyebrow">INDUSTRY INTELLIGENCE / 02</p><div className="industry-heading"><div><h1>{name}</h1><p>按公司和维度掌握动态，随时回到原生会话继续研究。</p></div><div><button className="secondary" onClick={onSchedule}>定时生成{name}</button> <button className="primary" onClick={onGenerate}>手动生成{name}</button></div></div><div className="industry-overview briefing-overview"><div className="industry-storage briefing-storage"><span>存储位置</span><strong>飞书云盘 / {config?.feishuRoot?.rootName??'行研工作台'} / {name}</strong><small>北京时间 · {kind==='daily'?'前一个完整自然日':'前七个完整自然日'} · 按披露日归档</small></div></div><div className="industry-toolbar"><label className="industry-search"><input aria-label="搜索报告" placeholder="搜索报告" value={query} onChange={e=>setQuery(e.target.value)}/></label><button onClick={load}>刷新</button></div>{error&&<div className="industry-error" role="alert"><AlertCircle size={17}/>{error}</div>}<div className="industry-cards">{items.filter(t=>t.direction.includes(query)).map(t=><article key={t.id} className="industry-company briefing-card">
  <div className="company-top"><span className="company-monogram"><CalendarDays size={18}/></span><span className={'task-status '+t.status}>{statusLabel(t)}</span></div>
  <h2 title={t.direction}>{t.direction}</h2>
  <p className="card-meta">{t.briefing.window.display}</p>
  {(t.publication.partial||t.publication.noUpdates)&&<div className="company-dimensions briefing-signals">{t.publication.partial&&<span>部分资料获取成功，缺口见文档</span>}{t.publication.noUpdates&&<span>本{kind==='daily'?'日':'周'}无更新</span>}</div>}
  {t.publication.status==='published'&&<a className="briefing-action" href={t.publication.url} target="_blank" rel="noreferrer">打开飞书{name}<ArrowUpRight size={16}/></a>}
  {t.notification?.status==='sent'&&<><p className="card-caption">飞书机器人已通知</p>{t.notification.notice&&<p className="card-caption notification-redirect-notice" role="status">{t.notification.notice}</p>}</>}
  {t.notification?.status==='failed'&&<div className="card-alert" role="alert"><AlertCircle size={15}/><span>{t.notification.error}</span><div className="card-alert-actions"><NotificationRetry task={t} base="briefings" onRepair={onFixNotification} onUpdated={value=>setItems(old=>old.map(item=>item.id===value.id?value:item))}/></div></div>}
  <footer><button onClick={()=>onOpen(t)}>AI 会话详情 ↗</button>{['failed','interrupted'].includes(t.status)&&<button onClick={()=>onRetry(t)}>重试</button>}</footer>
</article>)}</div>{!items.length&&<div className="industry-empty"><h2>暂无{name}记录</h2><p>生成报告后，每份报告和对应 AI 会话都会保存在这里。</p></div>}</section>;
}
