import React, { useEffect, useRef, useState } from 'react';
import { Library, X } from 'lucide-react';
import { newConnectionTrace, connectionEvent, tracedConnectionRequest } from './connection-trace.mjs';

// Adapter for the manual device-flow API in release@59371f1.
export function ReleaseFeishuBinding({ onClose, onBound, onStatus, onRepaired, repair, initialAction, onLocateTask, onOpenTask }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [registering, setRegistering] = useState(Boolean(repair || initialAction));
  const lock = useRef(false), revision = useRef(0);
  const trace = useRef(null);
  if (!trace.current) trace.current = newConnectionTrace(repair?'repair':initialAction==='initial'?'bind':initialAction??'inspect');
  const api = (path,body,method='POST') => tracedConnectionRequest(path,body,method,trace.current);
  function openRegistration(action) { trace.current=newConnectionTrace(action); connectionEvent(trace.current,'clicked','registration',{status:'started'}); setRegistering(true); }
  useEffect(() => {
    connectionEvent(trace.current,'clicked','binding',{status:'started'});
    const failed=()=>connectionEvent(trace.current,'script_error','frontend',{status:'failed'});
    window.addEventListener('error',failed);window.addEventListener('unhandledrejection',failed);
    return()=>{window.removeEventListener('error',failed);window.removeEventListener('unhandledrejection',failed);};
  },[]);
  useEffect(()=>{if(state)connectionEvent(trace.current,'rendered','ui_sync',{...state,status:state.bound?'bound':state.flowId?'waiting':'unbound'});},[state?.bound,state?.flowId,state?.appId]);
  useEffect(() => {
    let live = true;
    api('/feishu-binding').then(value => { if (live && revision.current === 0) { setState(value); onStatus?.(value); } }).catch(e => { if (live) setError(e); });
    return () => { live = false; };
  }, []);
  async function authorize(complete = false) {
    if (lock.current) return;
    revision.current++; lock.current = true; setBusy(true); setError('');
    try {
      const value = await api(complete ? '/feishu-binding/complete' : '/feishu-binding', complete ? { flowId: state.flowId } : { rebind: true });
      connectionEvent(trace.current,'response','binding',{...value,status:value.bound?'bound':'waiting'});
      setState(value); onStatus?.(value);
      if (value.bound && onRepaired) await onRepaired();
    } catch (e) { setError(e); }
    finally { lock.current = false; setBusy(false); }
  }
  if (registering) return <Registration onLocateTask={onLocateTask} onOpenTask={onOpenTask} trace={trace.current} repairBot={Boolean(repair)} onClose={() => setRegistering(false)} onSaved={async () => {
    setRegistering(false);
    if(repair){const value=await api('/feishu-binding');setState(value);onStatus?.(value);if(value.bound&&onRepaired)await onRepaired();}
    else await authorize();
  }}/>;
  return <Dialog title={state?.bound ? '飞书绑定' : '绑定飞书'} onClose={onClose} busy={busy}>
    <p className="modal-intro">先扫码选择或创建飞书应用，再完成个人文档授权。</p>
    <section className="binding-application" aria-label="授权应用"><div><strong>当前应用</strong><p>{state?.appName || state?.appId || '尚未绑定应用'}</p>{state?.appName && state?.appId && <small>{state.appId}</small>}</div><button className="secondary" disabled={busy || !state} onClick={() => openRegistration('replace')}>更换应用</button></section>
    {state?.bound ? <p role="status">已绑定飞书：{state.userName}</p> : state?.authorizationUrl ? <div className="binding-qr"><a className="doc-link" href={state.authorizationUrl} target="_blank" rel="noreferrer">打开飞书授权页</a><img src={`/api/feishu-binding/qr/${state.flowId}`} alt="绑定飞书授权二维码" onError={()=>connectionEvent(trace.current,'qr_error','binding',{status:'failed'})}/><p>扫码完成个人授权后，点击“我已授权”检查结果。</p></div> : <p>{state?.error ?? '正在检查飞书授权…'}</p>}
    {error && <BindingError error={error} onLocateTask={onLocateTask} onOpenTask={onOpenTask}/>}
    <div className="modal-footer"><span>个人身份 · 报告仅存飞书</span>{state?.bound ? <><button className="secondary" disabled={busy} onClick={() => openRegistration('rebind')}>重新绑定</button><button className="primary" disabled={busy} onClick={() => onBound(state)}>完成</button></> : <><button className="primary" disabled={busy || !state} onClick={() => state?.appId ? authorize() : openRegistration('bind')}>{state?.appId ? '重新获取个人授权二维码' : '扫码登录并选择应用'}</button>{state?.flowId && <button className="primary" disabled={busy} onClick={() => authorize(true)}>我已授权</button>}</>}</div>
  </Dialog>;
}

function Registration({ onClose, onSaved, trace, repairBot = false, onLocateTask, onOpenTask }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false), done = useRef(false), live = useRef(true);
  const lastStatus=useRef('');
  const api=(path,body,method='POST')=>tracedConnectionRequest(path,body,method,trace);
  async function receive(value) {
    if (!live.current) return;
    setState(value);
    if(lastStatus.current!==value.status){lastStatus.current=value.status;connectionEvent(trace,'response','registration',{...value,status:value.status==='awaiting_scan'?'waiting':value.status});}
    if (value.status === 'completed' && !done.current) { done.current = true; await onSaved(); }
  }
  async function start(refresh = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    if(refresh)trace.attempt++;
    connectionEvent(trace,'clicked','registration',{status:'started'});
    try { await receive(await api('/feishu-registration', { refresh, ...(repairBot ? {repairBot:true} : {}) })); }
    catch (e) { if (live.current) setError(e); }
    finally { lock.current = false; if (live.current) setBusy(false); }
  }
  async function close() {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await api('/feishu-registration', {}, 'DELETE'); connectionEvent(trace,'response','registration',{status:'cancelled'}); onClose(); }
    catch (e) { setError(e); }
    finally { lock.current = false; setBusy(false); }
  }
  useEffect(() => {
    live.current = true; void start(); let polling = false;
    const timer = setInterval(async () => {
      if (polling || lock.current || done.current) return;
      polling = true;
      try { await receive(await api('/feishu-registration')); } catch (e) { if (live.current) setError(e); }
      finally { polling = false; }
    }, 1000);
    return () => { live.current = false; clearInterval(timer); };
  }, []);
  return <Dialog title={repairBot ? '确认应用权限更新' : '扫码登录并绑定应用'} onClose={close} busy={busy || state?.status === 'saving'}>
    {repairBot && <p className="modal-intro">在飞书确认当前应用的机器人发送消息权限并发布。此操作不更换应用或个人账号。</p>}
    {!repairBot && <p className="modal-intro">1. 扫码登录要使用的飞书账号。<br/>2. 在飞书页面选择已有应用或创建新应用并确认。<br/>3. 返回工作台，继续个人文档授权。</p>}
    {state?.status === 'awaiting_scan' && <div className="binding-qr"><a className="doc-link" href={state.authorizationUrl} target="_blank" rel="noreferrer">打开飞书应用绑定页</a><img src={`/api/feishu-registration/qr/${state.flowId}`} alt="飞书账号登录与应用绑定二维码" onError={()=>connectionEvent(trace,'qr_error','registration',{status:'failed'})}/></div>}
    {!error && (!state || state.status === 'initializing') && <p role="status">正在生成应用绑定二维码…</p>}{state?.status === 'saving' && <p role="status">正在保存应用配置…</p>}
    {(error || state?.error) && <BindingError error={error || state.error} onLocateTask={onLocateTask} onOpenTask={onOpenTask}/>}
    <div className="modal-footer"><button className="secondary" disabled={busy || state?.status === 'saving'} onClick={close}>取消</button><button className="primary" disabled={busy || (error?.code!=='FEISHU_TASKS_BUSY' && (!state || ['initializing', 'saving', 'completed'].includes(state.status)))} onClick={() => start(true)}>重新获取应用绑定二维码</button></div>
  </Dialog>;
}

function BindingError({error,onLocateTask,onOpenTask}) {
  const reasons={queued:'排队中',researching:'调研中',waiting_save:'等待保存',uploading:'上传中',upload_pending:'上传待确认',finishing:'正在收尾'};
  const blockers=error?.code==='FEISHU_TASKS_BUSY' ? error.blockers??[] : [];
  return <div className="form-error binding-task-error" role="alert"><p>{typeof error==='string'?error:error.message}</p>
    {blockers.length>0 && <ul aria-label="阻塞绑定的任务">{blockers.map(item=><li key={item.id}><div><strong>{item.title}</strong><span>{reasons[item.reason]??'执行中'}</span></div><div className="binding-task-actions">
      {onLocateTask && <button className="secondary" onClick={()=>onLocateTask(item)}>定位卡片</button>}
      {item.canOpenSession && onOpenTask && <button className="secondary" onClick={()=>onOpenTask(item)}>打开会话</button>}
    </div></li>)}</ul>}
  </div>;
}

function Dialog({ title, children, onClose, busy }) {
  const container = useRef(null), first = useRef(null);
  useEffect(() => { first.current?.focus(); }, []);
  function keyDown(e) {
    if (e.key === 'Escape' && !busy) onClose();
    if (e.key !== 'Tab') return;
    const els = [...container.current.querySelectorAll('button:not(:disabled), a')];
    if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0]?.focus(); }
  }
  return <div className="modal-backdrop"><section ref={container} className="modal" role="dialog" aria-modal="true" aria-label={title} onKeyDown={keyDown}><div className="modal-heading"><Library size={24}/><button ref={first} className="icon-button" aria-label="关闭飞书绑定" disabled={busy} onClick={onClose}><X size={20}/></button></div><h2>{title}</h2>{children}</section></div>;
}
