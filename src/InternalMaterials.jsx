import { NotificationRetry } from './NotificationRetry.jsx';
import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowUpRight, FileText, LoaderCircle, RefreshCw } from 'lucide-react';
import { createTabStore } from './tab-store.mjs';
import { useTabEntry, useTabPolling } from './use-tab-store.js';

async function api(path, options = {}) {
  const response = await fetch('/api/internal-materials' + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? '请求失败');
  return body;
}

const statusLabel = task => task.stage === 'waiting_save'
  ? '等待保存（其他任务正在写入）'
  : ({ ready: '已完成', failed: '失败', interrupted: '已中断', running: '解析中', queued: '排队中' })[task.status] ?? task.status;

const syncedAtLabel = value => value ? new Intl.DateTimeFormat('zh-CN', { timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value)) : '';

function sourceDisplay(task) {
  const deliveredTitle = task.publication?.sourceTitle?.trim();
  if (deliveredTitle) return deliveredTitle;
  const label = task.internal.sourceLabel ?? '';
  if (task.internal.sourceType === 'url' && /^[A-Za-z0-9_-]{20,}$/.test(label)) return '网络资料';
  return label || (task.internal.sourceType === 'url' ? '网络资料' : '本地资料');
}

function sourceHost(task) {
  if (task.internal.sourceType !== 'url') return '';
  try { return new URL(task.internal.source).hostname; } catch { return ''; }
}

// One shared store keyed by application, account, root and materials folder.
export const internalMaterialsStore = createTabStore();
const scopeKey = config => 'internal:' + (config?.publicationScope ?? '') + ':' + (config?.internalDirectoryName ?? '内部资料');
const loaders = {
  cached: () => api(''),
  sync: ({ force }) => api('?refresh=true' + (force ? '&force=true' : '')),
};

export function InternalMaterials({ config, onConfigChanged, onCreate, onOpen, onRetry, onFixNotification, notificationRevision, focusRequest }) {
  const [query, setQuery] = useState('');
  const [editingDirectory, setEditingDirectory] = useState(false);
  const [directoryName, setDirectoryName] = useState('');
  const [savingDirectory, setSavingDirectory] = useState(false);
  const [error, setError] = useState('');
  const key = scopeKey(config);
  const state = useTabEntry(internalMaterialsStore, key, loaders);
  const items = state.items.filter(task => task.internal);
  const active = items.some(task => ['running', 'queued'].includes(task.status));
  useTabPolling(internalMaterialsStore, key, loaders, active ? 4000 : 30000);
  useEffect(() => { if (notificationRevision) internalMaterialsStore.reload(key, loaders); }, [notificationRevision]);
  useEffect(() => { if (focusRequest) setQuery(''); }, [focusRequest]);

  async function saveDirectory(event) {
    event.preventDefault();
    if (savingDirectory) return;
    setSavingDirectory(true);
    try {
      const value = await api('/settings', { method: 'PUT', body: JSON.stringify({ directoryName }) });
      onConfigChanged?.(value.directoryName); setEditingDirectory(false);
    } catch (cause) { setError(cause.message); }
    finally { setSavingDirectory(false); }
  }
  const banner = error || state.syncError || state.error;
  const refresh = () => { setError(''); return internalMaterialsStore.refresh(key, loaders); };
  // No cache yet but a remote refresh is running: keep the placeholder so the
  // empty state never claims "nothing here" while the directory scan is in flight.
  const pending = !items.length && (state.status !== 'ready' || Boolean(state.syncing));
  const visible = items.filter(task =>
    task.direction.toLowerCase().includes(query.toLowerCase())
    || sourceDisplay(task).toLowerCase().includes(query.toLowerCase())
    || task.internal.source.toLowerCase().includes(query.toLowerCase()));

  return <section className="industry-content">
    <p className="industry-eyebrow">INTERNAL INTELLIGENCE / 04</p>
    <div className="industry-heading">
      <div><h1>内部资料</h1><p>生成可核验逐字稿和会议纪要，自动更新公司信息库。</p></div>
      <button className="primary" onClick={onCreate}><FileText size={17}/>解析内部资料</button>
    </div>
    <div className="industry-overview briefing-overview"><div className="industry-storage briefing-storage">
      <span>存储位置 <button className="secondary" onClick={() => { setDirectoryName(config?.internalDirectoryName ?? '内部资料'); setEditingDirectory(true); }}>设置目录</button></span>
      <strong>飞书云盘 / {config?.feishuRoot?.rootName ?? '行研工作台'} / {config?.internalDirectoryName ?? '内部资料'}</strong>
      <small>下设原始资料、逐字稿和会议纪要 · 本地文件上传上限 100 MB{state.syncedAt ? <> · 上次同步 {syncedAtLabel(state.syncedAt)}</> : null}</small>
      {editingDirectory && <form className="material-directory-settings" onSubmit={saveDirectory}>
        <label>内部资料目录名称<input required maxLength={120} value={directoryName} onChange={event => setDirectoryName(event.target.value)} disabled={savingDirectory}/></label>
        <small>新任务使用此目录；历史任务保留原目录和文档。</small>
        <div><button className="primary" disabled={savingDirectory}>{savingDirectory ? '保存中…' : '保存目录'}</button> <button type="button" className="secondary" disabled={savingDirectory} onClick={() => setEditingDirectory(false)}>取消</button></div>
      </form>}
    </div></div>
    <div className="industry-toolbar">
      <label className="industry-search"><input aria-label="搜索内部资料" placeholder="搜索内部资料" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button className="secondary" onClick={refresh} disabled={Boolean(state.syncing)} aria-busy={Boolean(state.syncing)}><RefreshCw size={15} className={state.syncing ? 'spin' : ''}/>刷新</button>
    </div>
    {banner && <div className="industry-error" role="alert"><AlertCircle size={17}/>{banner}<button onClick={refresh}>重试同步</button></div>}
    {pending && <div className="industry-empty"><LoaderCircle className="spin"/>正在读取内部资料…</div>}
    {items.length > 0 && <div className="industry-cards">{visible.map(task => <article className="industry-company" key={task.id} id={'task-card-'+task.id} tabIndex={-1}>
      <div className="company-top"><span className="company-monogram"><FileText size={18}/></span><span className={'task-status ' + task.status}>{statusLabel(task)}</span></div>
      <h2 title={sourceDisplay(task)}>{sourceDisplay(task)}</h2>
      <p className="card-meta">{task.remoteOnly ? '飞书历史逐字稿' : task.internal.sourceType === 'local' ? '本地文件' : `网络资料${sourceHost(task) ? ` · ${sourceHost(task)}` : ''}`}{task.internal.fileSize != null ? ` · ${(task.internal.fileSize / 1024 / 1024).toFixed(1)} MB` : ''}</p>
      <div className="company-dimensions"><span>{task.remoteOnly ? '云端文档' : task.internal.uploadEligible ? '原始资料可上传' : task.internal.sourceType === 'local' ? '原始材料超过上传上限' : '保留原始链接'}</span></div>
      {task.error && <div className="industry-error" role="alert">{task.error}</div>}
      <p className="card-caption">目录：{task.internal.directoryName ?? "内部解析资料（历史）"}</p>
      {(task.publication?.url || task.publication?.minutesUrl || task.publication?.sourceMaterialUrl) && <div className="material-actions">
        {task.publication?.url && <a className="material-action material-action-primary" href={task.publication.url} target="_blank" rel="noreferrer">逐字稿<ArrowUpRight size={15}/></a>}
        {task.publication?.minutesUrl && <a className="material-action" href={task.publication.minutesUrl} target="_blank" rel="noreferrer">会议纪要<ArrowUpRight size={15}/></a>}
        {task.publication?.sourceMaterialUrl && <a className="material-action" href={task.publication.sourceMaterialUrl} target="_blank" rel="noreferrer">原始资料<ArrowUpRight size={15}/></a>}
      </div>}
      {task.notification?.status === 'sent' && <><p className="card-caption">飞书机器人已通知</p>{task.notification.notice && <p className="card-caption notification-redirect-notice" role="status">{task.notification.notice}</p>}</>}
      {task.notification?.status === 'failed' && <div className="card-alert" role="alert"><AlertCircle size={15}/><span>{task.notification.error}</span><div className="card-alert-actions"><NotificationRetry task={task} base="internal-materials" onRepair={onFixNotification} onUpdated={value => internalMaterialsStore.replaceItem(key, value.id, value)}/></div></div>}
      <footer>
        <button disabled={task.remoteOnly} title={task.remoteOnly ? '此资料没有本机 AI 会话记录' : undefined} onClick={() => onOpen(task)}>AI 会话详情 ↗</button>
        {['failed', 'interrupted'].includes(task.status) && <button onClick={() => onRetry(task)}>重试</button>}
      </footer>
    </article>)}</div>}
    {!pending && items.length === 0 && <div className="industry-empty">
      <FileText size={32}/><h2>{query ? '没有匹配的内部资料' : '从第一份录音或内部文档开始'}</h2>
      <p>支持本地文件路径或网络链接；解析完成后保存飞书逐字稿及会议纪要。</p>
    </div>}
  </section>;
}
