import { ReleaseFeishuBinding } from './ReleaseFeishuBinding.jsx';
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
function App() { return <IndustryApp BindingModal={ReleaseFeishuBinding} RootModal={FeishuRootModal} Conversation={NativeConversation}/>; }

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
  async function submit(e) { e.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { onSaved(await api('/feishu-settings/import', { method: 'POST', body: JSON.stringify(mode === 'link' ? { folderUrl } : { rootName }) })); } catch(e) { setError(e.message); } finally { lock.current = false; setBusy(false); } }
  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="root-title">
    <div className="modal-heading"><Library size={24}/><button className="icon-button" aria-label="关闭飞书根目录设置" disabled={busy} onClick={onClose}><X size={20}/></button></div><h2 id="root-title">设置飞书根目录</h2><p className="modal-intro">选择一种方式设置报告保存位置。</p>
    <form onSubmit={submit}><fieldset className="root-mode-options"><legend>设置方式</legend>
      <label><input type="radio" name="root-mode" checked={mode === 'name'} disabled={busy} onChange={() => { setMode('name'); setError(''); }}/>按名字创建</label>
      <label><input type="radio" name="root-mode" checked={mode === 'link'} disabled={busy} onChange={() => { setMode('link'); setError(''); }}/>使用文件夹链接</label>
    </fieldset>
    {mode === 'name' ? <><label htmlFor="feishu-root">根目录名字</label><input ref={input} id="feishu-root" required maxLength={100} value={rootName} onChange={e => setRootName(e.target.value)} disabled={busy}/><p className="ai-config-hint">默认“行研工作台”。目录尚未创建时先保存设置；首次调研创建目录后，可再次导入其中的公司。</p></> : <><label htmlFor="feishu-folder-url">飞书文件夹链接</label><input ref={input} id="feishu-folder-url" type="url" required maxLength={2000} placeholder="https://你的企业.feishu.cn/drive/folder/…" value={folderUrl} onChange={e => setFolderUrl(e.target.value)} disabled={busy}/><p className="ai-config-hint">保存后会读取该目录一次，导入「全量信息库」中已有的公司；之后通过公司索引增量更新。</p></>}
    {error && <div className="form-error" role="alert">{error}</div>}<div className="modal-footer"><span>历史调研保留原目录</span><button className="primary" disabled={busy || !(mode === 'link' ? folderUrl.trim() : rootName.trim())}>{busy ? '正在保存并导入…' : '保存设置并导入'}</button></div></form>
  </section></div>;
}


createRoot(document.getElementById('root')).render(<App/>);
