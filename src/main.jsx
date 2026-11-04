import { IndustryApp } from './IndustryApp.jsx';
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUpRight, ArrowLeft, ArrowRight, Plus, Search, Globe2, Library, FlaskConical, Check, ChevronDown, Clock3, FileText, X, LoaderCircle, RefreshCw, Square, ExternalLink, Sparkles, Command, BookOpen, Activity, AlertCircle } from 'lucide-react';
import './style.css';
import '../plugin/workbench-theme.css';
import { hostOrigin } from './host-origin.mjs';

async function api(path, options) {
  const r = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...options?.headers } });
  const body = await r.json();
  if (!r.ok) {
    const error = new Error(body.error ?? '请求失败');
    error.code = body.code;
    error.recovery = body.recovery;
    throw error;
  }
  return body;
}
function App() { return <IndustryApp BindingModal={FeishuBindingModal} RootModal={FeishuRootModal} Conversation={NativeConversation}/>; }

function NativeConversation({ task }) {
  const [status, setStatus] = useState(''), sent = useRef(null);
  const embedded = new URLSearchParams(location.search).get('embed') === 'dsh' && window.parent !== window;
  const open = () => {
    if (!embedded) { setStatus('请在 DeepSeek Harness 的“行研工作台”页签打开此原生会话。'); return; }
    const requestId = crypto.randomUUID(); sent.current = requestId; setStatus('正在连接原生会话…');
    const origin = hostOrigin(document.referrer, new URLSearchParams(location.search).get('hostOrigin')); if (!origin) { setStatus('无法确认宿主来源，请从 DSH 重新打开行研工作台。'); return; }
    window.parent.postMessage({ type: 'industry-research:embed-session', taskId: task.id, requestId }, origin);
  };
  useEffect(() => {
    const receive = event => {
      const origin = hostOrigin(document.referrer, new URLSearchParams(location.search).get('hostOrigin')); if (!origin) return;
      if (event.source !== window.parent || event.origin !== origin || event.data?.type !== 'industry-research:session-result' || event.data.requestId !== sent.current) return;
      setStatus(event.data.ok ? '已连接，在工作台内继续对话。' : event.data.error ?? '打开原生会话失败，请重试');
    };
    window.addEventListener('message', receive);
    if (task.nativeSessionId) open();
    return () => { window.removeEventListener('message', receive); if (embedded && sent.current) { try { window.parent.postMessage({ type: 'industry-research:hide-session', taskId: task.id, requestId: sent.current }, hostOrigin(document.referrer, new URLSearchParams(location.search).get('hostOrigin'))); } catch {} } };
  }, [task.id, task.nativeSessionId]);
  return <section className="native-conversation" aria-label="DSH 原生会话"><div className="pending-orb"><Sparkles size={28}/></div><h2>在工作台内继续调研</h2><p>正在载入 DSH 原生消息与输入框，支持追问与停止当前轮次。</p><button className="primary" onClick={open} disabled={!task.nativeSessionId}><ExternalLink size={16}/>重新连接对话</button><p role="status">{status || '正在创建宿主会话…'}</p></section>;
}


function FeishuRootModal({ current, onClose, onSaved }) {
  const [mode, setMode] = useState(current?.folderUrl ? 'link' : 'name');
  const [folderUrl, setFolderUrl] = useState(current?.folderUrl ?? '');
  const [rootName, setRootName] = useState(current?.rootName ?? '行研工作台'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef(null), lock = useRef(false);
  useEffect(() => { const previous = document.activeElement; input.current?.focus(); const key = e => { if (e.key === 'Escape' && !lock.current) onClose(); if (e.key === 'Tab') { const els = [...document.querySelectorAll('.modal button:not(:disabled), .modal input:not(:disabled)')]; const first = els[0], last = els.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } } }; document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus(); }; }, []);
  async function submit(e) { e.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { onSaved(await api('/feishu-settings', { method: 'PUT', body: JSON.stringify(mode === 'link' ? { folderUrl } : { rootName }) })); } catch(e) { setError(e.message); } finally { lock.current = false; setBusy(false); } }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="root-title">
    <div className="modal-heading"><Library size={24}/><button className="icon-button" aria-label="关闭飞书根目录设置" disabled={busy} onClick={onClose}><X size={20}/></button></div><h2 id="root-title">设置飞书根目录</h2><p className="modal-intro">选择一种方式设置报告保存位置。</p>
    <form onSubmit={submit}><fieldset className="root-mode-options"><legend>设置方式</legend>
      <label><input type="radio" name="root-mode" checked={mode === 'name'} disabled={busy} onChange={() => { setMode('name'); setError(''); }}/>按名字创建</label>
      <label><input type="radio" name="root-mode" checked={mode === 'link'} disabled={busy} onChange={() => { setMode('link'); setError(''); }}/>使用文件夹链接</label>
    </fieldset>
    {mode === 'name' ? <><label htmlFor="feishu-root">根目录名字</label><input ref={input} id="feishu-root" required maxLength={100} value={rootName} onChange={e => setRootName(e.target.value)} disabled={busy}/><p className="ai-config-hint">默认“行研工作台”。首次创建并记住目录，后续复用；已有文件夹请切换到“使用文件夹链接”。</p></> : <><label htmlFor="feishu-folder-url">飞书文件夹链接</label><input ref={input} id="feishu-folder-url" type="url" required maxLength={2000} placeholder="https://你的企业.feishu.cn/drive/folder/…" value={folderUrl} onChange={e => setFolderUrl(e.target.value)} disabled={busy}/><p className="ai-config-hint">只需提供文件夹链接，直接上传到该目录，不改动文件夹名字，也不读取目录列表。</p></>}
    {error && <div className="form-error" role="alert">{error}</div>}<div className="modal-footer"><span>历史调研保留原目录</span><button className="primary" disabled={busy || !(mode === 'link' ? folderUrl.trim() : rootName.trim())}>{busy ? '正在保存…' : '保存设置'}</button></div></form>
  </section></div>;
}


function FeishuBindingModal({ onClose, onBound, onStatus, repair = false, initialAction }) {
  const initialRegistrationMode = repair ? 'repair' : initialAction;
  const [applicationEditing, setApplicationEditing] = useState(false), [registering, setRegistering] = useState(Boolean(initialRegistrationMode));
  const [registrationMode, setRegistrationMode] = useState(initialRegistrationMode ?? 'initial');
  const [state, setState] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [qrError, setQrError] = useState(false), [now, setNow] = useState(Date.now());
  const lock = useRef(false), first = useRef(null), revision = useRef(0), editing = useRef(false), automaticRepair = useRef('');
  editing.current = applicationEditing || registering;
  useEffect(() => { first.current?.focus(); let live = true; api('/feishu-binding').then(value => { if (live && revision.current === 0) { setState(value); onStatus?.(value); } }).catch(e => { if (live) setError(e.message); }); const listener = e => { if (editing.current) return; if (e.key === 'Escape' && !lock.current) onClose(); if (e.key === 'Tab') { const els = [...document.querySelectorAll('.modal button:not(:disabled), .modal a')]; const first = els[0], last = els.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } } }; document.addEventListener('keydown', listener); const timer = setInterval(() => setNow(Date.now()), 1000); return () => { live = false; document.removeEventListener('keydown', listener); clearInterval(timer); }; }, []);
  useEffect(() => {
    const recovery = state?.recovery;
    if (!recovery?.automatic || registering || applicationEditing || automaticRepair.current === recovery.code) return;
    if (state?.flowId && Date.parse(state.expiresAt) > Date.now()) return;
    automaticRepair.current = recovery.code;
    if (recovery.action === 'authorize') void run(false, true);
    if (recovery.action === 'register_app') setRegistering(true);
  }, [state?.recovery?.code, registering, applicationEditing]);
  const shouldPoll = !state?.bound && Boolean(state?.flowId || state?.recovery);
  useEffect(() => {
    if (registering || applicationEditing || !shouldPoll) return;
    let polling = false;
    const timer = setInterval(async () => {
      if (polling || lock.current) return;
      polling = true;
      try {
        const value = await api('/feishu-binding');
        setState(value);
        onStatus?.(value);
        if (value.bound) onBound(value);
      } catch (e) {
        setError(e.message);
      } finally {
        polling = false;
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [registering, applicationEditing, shouldPoll]);
  const expired = state?.expiresAt && Date.parse(state.expiresAt) <= now;
  async function run(complete = false, rebind = false, compatibility = false) { if (lock.current) return; revision.current++; lock.current = true; setBusy(true); setError(''); setQrError(false); try { const body = complete ? { flowId: state.flowId } : { rebind, auto: true, ...(compatibility ? { compatibility: true } : {}) }; const value = await api(complete ? '/feishu-binding/complete' : '/feishu-binding', { method: 'POST', body: JSON.stringify(body) }); setState(value); if (value.bound) onBound(value); } catch(e) { setError(e.message); setState(current => ({ ...current, error: e.message, ...(e.recovery ? { recovery: e.recovery } : {}) })); } finally { lock.current = false; setBusy(false); } }
  function openRegistration(mode) { setRegistrationMode(mode); setRegistering(true); }
  async function applicationSaved() { revision.current++; let value; try { value = await api('/feishu-binding'); } catch { value = { bound: false, error: '应用已保存，请重新检查授权状态' }; } setState(value); onStatus?.(value); setApplicationEditing(false); setRegistering(false); setRegistrationMode('initial'); if (value.appId) await run(false); }
  if (registering) return <FeishuRegistrationModal mode={registrationMode} onClose={() => setRegistering(false)} onRegistered={applicationSaved}/>;
  if (applicationEditing) return <FeishuApplicationModal onClose={() => setApplicationEditing(false)} onSaved={applicationSaved}/>;
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="binding-title">
    <div className="modal-heading"><Library size={24}/><button ref={first} className="icon-button" aria-label="关闭飞书绑定" disabled={busy} onClick={onClose}><X size={20}/></button></div><h2 id="binding-title">{state?.rebind ? '恢复飞书授权' : state?.bound ? '飞书绑定' : '绑定飞书'}</h2><p className="modal-intro">{state?.rebind ? '当前应用的登录密钥或授权需要重新确认，请扫码完成恢复。' : state?.bound ? '当前飞书账号和应用已绑定。更换应用不会切换账号；重新绑定会登录另一个飞书账号。' : '先扫码登录飞书，在飞书页面选择已有应用或创建新应用，再完成个人文档授权。'}</p>
    <section className="binding-application" aria-label="授权应用"><div><strong>当前应用</strong><p>{state?.appName || state?.appId || '尚未绑定应用'}</p>{state?.appName && state?.appId && <small>{state.appId}</small>}</div>{state?.bound && <button className="secondary" disabled={busy} onClick={() => openRegistration('replace')}>更换应用</button>}</section>
    {state?.bound ? <><p role="status">已绑定飞书：{state.userName}</p>{state.notificationReady === false && <div className="card-alert" role="status"><AlertCircle size={15}/><span>机器人通知尚未就绪，请开通发送消息权限并发布应用。</span><div className="card-alert-actions"><button onClick={() => openRegistration('repair')}>修复机器人权限</button></div></div>}</> : state?.authorizationUrl && !expired ? <div className="binding-qr"><a className="doc-link" href={state.authorizationUrl} target="_blank" rel="noreferrer">打开飞书授权页</a>{!qrError ? <img src={`/api/feishu-binding/qr/${state.flowId}`} alt="绑定飞书授权二维码" onError={() => setQrError(true)}/> : <p>二维码加载失败，可打开授权链接或重新获取。</p>}<p>{state.autoCompleting ? '扫码后会自动完成授权并关闭窗口，无需再次点击。' : '请使用要绑定的飞书账号完成个人授权。'}</p><button className="secondary" disabled={busy} onClick={() => openRegistration('rebind')}>换一个账号重新扫码</button></div> : <><p>{busy ? '正在自动检查并获取授权二维码…' : expired ? '个人授权二维码已过期，请重新获取。' : state?.error ?? '检查飞书授权中…'}</p>{state?.recovery?.message && state.recovery.message !== state.error && <p className="ai-config-hint" role="status">{state.recovery.message}</p>}</>}
    {!state?.bound && state?.appId && (state?.recovery?.code === 'LARK_DPOP_KEY_UNAVAILABLE' || expired) && <div className="card-alert" role="status"><AlertCircle size={15}/><span>如果重新扫码后仍无法访问 Windows 密钥，可仅对当前插件 profile 使用 Bearer 兼容登录；不会修改 Codex 或其他飞书 profile。</span><div className="card-alert-actions"><button disabled={busy} onClick={() => run(false, true, true)}>使用兼容登录修复</button></div></div>}
    <p className="ai-config-hint">“重新绑定”会重新登录飞书账号，并选择或创建该账号可管理的应用；“更换应用”保持当前账号不变。报告和个人云盘始终归属于当前绑定账号。</p>{error && <div className="form-error" role="alert">{error}</div>}
    <div className="modal-footer"><span>个人身份 · 报告仅存飞书</span>{state?.bound ? <><button className="secondary" disabled={busy} onClick={() => openRegistration('rebind')}>重新绑定</button><button className="primary" disabled={busy} onClick={() => onBound(state)}>完成</button></> : <><button className="primary" disabled={busy || !state || ['install_cli', 'repair_cli'].includes(state.recovery?.action)} onClick={() => state?.appId && state?.recovery?.action !== 'register_app' ? run(false) : openRegistration('initial')}>{state?.recovery?.action === 'register_app' || !state?.appId ? '扫码登录并选择应用' : '授权当前应用'}</button>{state?.flowId && !expired && <button className="primary" disabled={busy} onClick={() => run(true)}>{state.autoCompleting ? '检查授权结果' : '我已授权'}</button>}</>}</div>
    {!state?.bound && state?.appId && <button className="text-button" disabled={busy} onClick={() => run(false, Boolean(state?.authorizationUrl))}>{state?.authorizationUrl ? '重新获取个人授权二维码' : '仅补充当前应用授权'}</button>}
    <button className="text-button" disabled={busy || !state} onClick={() => setApplicationEditing(true)}>手动配置已有应用</button>
  </section></div>;
}


function FeishuRegistrationModal({ onClose, onRegistered, mode = 'initial' }) {
  const [state, setState] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [qrError, setQrError] = useState(false), [attempt, setAttempt] = useState(0);
  const live = useRef(true), finish = useRef(false), lock = useRef(false), first = useRef(null);
  async function receive(value) { if (!live.current) return; setError(''); setState(value); if (value.status === 'completed' && !finish.current) { finish.current = true; try { await onRegistered(); } catch(e) { finish.current = false; setError(e.message); } } }
  async function start(refresh = false) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); setQrError(false); try { await receive(await api('/feishu-registration', { method: 'POST', body: JSON.stringify({ refresh, replaceApp: mode !== 'repair', accountRebind: mode === 'rebind' }) })); } catch(e) { if (live.current) setError(/Unrecognized keys.*replaceApp|Unrecognized keys.*accountRebind/.test(e.message) ? '当前插件后端仍是旧版本。请完全退出并重新打开 DeepSeek Harness 后再试。' : e.message); } finally { lock.current = false; if (live.current) setBusy(false); } }
  async function close() { if (lock.current) return; lock.current = true; setBusy(true); try { await api('/feishu-registration', { method: 'DELETE' }); onClose(); } catch(e) { setError(e.message); } finally { lock.current = false; setBusy(false); } }
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => { live.current = true; first.current?.focus(); void start(); let polling = false; const timer = setInterval(async () => { if (polling || finish.current) return; polling = true; try { await receive(await api('/feishu-registration')); } catch(e) { if (live.current) setError(e.message); } finally { polling = false; } }, 1000); const key = e => { if (e.key === 'Escape') void closeRef.current(); if (e.key === 'Tab') { const els = [...document.querySelectorAll('.modal button:not(:disabled), .modal a')]; if (e.shiftKey && document.activeElement === els[0]) { e.preventDefault(); els.at(-1)?.focus(); } else if (!e.shiftKey && document.activeElement === els.at(-1)) { e.preventDefault(); els[0]?.focus(); } } }; document.addEventListener('keydown', key); return () => { live.current = false; clearInterval(timer); document.removeEventListener('keydown', key); }; }, []);
  useEffect(() => { if (!qrError || attempt >= 5) return; const timer = setTimeout(() => { setQrError(false); setAttempt(v => v + 1); }, 1000); return () => clearTimeout(timer); }, [qrError, attempt]);
  const waiting = state?.status === 'awaiting_scan', updatingApp = state?.updatingApp === true, replacingApp = mode === 'replace', rebindingAccount = mode === 'rebind';
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="registration-title"><div className="modal-heading"><Library size={24}/><button ref={first} className="icon-button" aria-label="关闭扫码绑定应用" disabled={busy || state?.status === 'saving'} onClick={close}><X size={20}/></button></div><h2 id="registration-title">{updatingApp ? '确认应用权限更新' : rebindingAccount ? '重新绑定飞书账号并应用' : replacingApp ? '更换飞书应用' : '扫码登录并绑定应用'}</h2><p className="modal-intro">{updatingApp ? <>当前应用：{state.appId}<br/>扫码登录管理账号，在飞书页面确认机器人消息权限差异并发布。</> : <>{rebindingAccount ? '必须使用不同于当前绑定的飞书账号。' : replacingApp ? '必须使用当前绑定的飞书账号。' : ''}<br/>1. 扫码绑定要使用的飞书账号。<br/>2. 在飞书页面绑定已有应用，或创建并发布新应用。<br/>3. 返回工作台，完成个人文档授权。</>}</p>
    {waiting && <div className="binding-qr"><a className="doc-link" href={state.authorizationUrl} target="_blank" rel="noreferrer">{updatingApp ? '打开飞书应用权限确认页' : rebindingAccount ? '打开飞书重新绑定页面' : replacingApp ? '打开飞书更换应用页面' : '打开飞书应用绑定页'}</a>{!qrError ? <img key={`${state.flowId}-${attempt}`} src={`/api/feishu-registration/qr/${state.flowId}?attempt=${attempt}`} alt={updatingApp ? '飞书应用权限更新二维码' : rebindingAccount ? '飞书重新绑定与应用绑定二维码' : replacingApp ? '飞书更换应用二维码' : '飞书账号登录与应用绑定二维码'} onError={() => setQrError(true)}/> : <p>二维码暂不可用，可打开绑定链接或重新获取。</p>}<p>{updatingApp ? '登录当前应用的管理账号，确认权限差异并发布。' : rebindingAccount ? '登录另一个飞书账号，并选择或创建该账号可管理的应用。' : replacingApp ? '登录当前飞书账号，在飞书页面选择或创建新的应用；个人账号保持不变。' : '先确认飞书页面登录的是新账号，再选择或创建应用。完成后将自动继续。'}</p></div>}
    {(!state || state.status === 'initializing') && <p role="status">正在生成扫码登录与应用绑定二维码…</p>}{state?.status === 'saving' && <p role="status">应用已确认，正在安全保存配置…</p>}{state?.status === 'completed' && <p role="status">应用已绑定，正在继续个人授权…</p>}
    <p className="ai-config-hint">无需填写 App ID 或密钥。选择已有应用需具备相应管理权限；企业审批限制仍由飞书控制。取消待扫码流程会保留原绑定。</p>{state?.recovery?.message && state.recovery.message !== state.error && <p className="ai-config-hint" role="status">{state.recovery.message}</p>}{(error || state?.error) && <div className="form-error" role="alert">{error || state.error}</div>}<div className="modal-footer"><button className="secondary" disabled={busy || state?.status === 'saving'} onClick={close}>取消</button><button className="primary" disabled={busy || !state || ['initializing', 'saving', 'completed'].includes(state.status)} onClick={() => { setAttempt(0); start(true); }}>重新获取应用绑定二维码</button></div>
  </section></div>;
}


function FeishuApplicationModal({ onClose, onSaved }) {
  const [info, setInfo] = useState(null), [mode, setMode] = useState('custom'), [appId, setAppId] = useState(''), [secret, setSecret] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const first = useRef(null), lock = useRef(false);
  useEffect(() => { let live = true; api('/feishu-application').then(value => { if (live) { setInfo(value); if (value.mode === 'custom') setAppId(value.appId); } }).catch(e => { if (live) setError(e.message); }); first.current?.focus(); return () => { live = false; }; }, []);
  useEffect(() => { const key = e => { if (e.key === 'Escape' && !lock.current) onClose(); if (e.key === 'Tab') { const controls = [...document.querySelectorAll('.modal button:not(:disabled), .modal input:not(:disabled), .modal select:not(:disabled)')]; if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); } else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); } } }; document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key); }, []);
  const keepSecret = info?.mode === 'custom' && info?.appId === appId.trim() && info?.hasSecret;
  async function submit(e) { e.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await api('/feishu-application', { method: 'PUT', body: JSON.stringify(mode === 'default' ? { mode } : { mode, appId, ...(secret ? { appSecret: secret } : {}) }) }); setSecret(''); await onSaved(); } catch(e) { setError(e.message); } finally { lock.current = false; setBusy(false); } }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="application-title"><div className="modal-heading"><Library size={24}/><button ref={first} className="icon-button" aria-label="关闭飞书应用配置" disabled={busy} onClick={onClose}><X size={20}/></button></div><h2 id="application-title">配置自己的飞书应用</h2><p className="modal-intro">使用你所在企业的应用，再扫码授权自己的飞书账号。</p><form onSubmit={submit}>
    <label htmlFor="application-mode">应用来源</label><select id="application-mode" value={mode} disabled={busy} onChange={e => setMode(e.target.value)}><option value="custom">使用自己的飞书应用</option><option value="default">使用本机默认应用</option></select>
    {mode === 'custom' ? <><label htmlFor="application-id">App ID</label><input id="application-id" required maxLength={104} placeholder="cli_…" value={appId} disabled={busy} onChange={e => setAppId(e.target.value)}/><label htmlFor="application-secret">App Secret</label><input id="application-secret" type="password" autoComplete="new-password" required={!keepSecret} maxLength={512} placeholder={keepSecret ? '留空保留已保存的凭据' : '输入应用密钥'} value={secret} disabled={busy} onChange={e => setSecret(e.target.value)}/><p className="ai-config-hint">在飞书开放平台创建或选择你有使用权限的应用，开通文档创建、编辑及文件夹创建权限。密钥由本机 Lark CLI 保存，工作台不回显，也不覆盖 CLI 默认应用。</p></> : <p className="ai-config-hint">恢复使用本机 Lark CLI 当前默认应用，不删除自定义应用或历史会话。</p>}
    {info?.appId && <p className="ai-config-hint">已选应用：{info.appName || info.appId}</p>}{error && <div className="form-error" role="alert">{error}</div>}<div className="modal-footer"><button className="secondary" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !info || mode === 'custom' && (!appId.trim() || !keepSecret && !secret.trim())}>{busy ? '正在保存…' : '保存应用配置'}</button></div>
  </form></section></div>;
}

createRoot(document.getElementById('root')).render(<App/>);
