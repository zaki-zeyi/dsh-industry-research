import React, { useEffect, useState } from 'react';
import { AlertCircle, ArrowUpRight, FileText, LoaderCircle, RefreshCw } from 'lucide-react';

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

function sourceDisplay(task) {
  const label = task.internal.sourceLabel ?? '';
  if (task.internal.sourceType === 'url' && /^[A-Za-z0-9_-]{20,}$/.test(label)) return '网络资料';
  return label || (task.internal.sourceType === 'url' ? '网络资料' : '本地资料');
}

function sourceHost(task) {
  if (task.internal.sourceType !== 'url') return '';
  try { return new URL(task.internal.source).hostname; } catch { return ''; }
}

export function InternalMaterials({ config, onCreate, onOpen, onRetry }) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const value = await api('');
      setItems(value.items);
      setError('');
    } catch (cause) {
      setError(cause.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let live = true;
    const run = async () => {
      try {
        const value = await api('');
        if (live) setItems(value.items);
      } catch (cause) {
        if (live) setError(cause.message);
      } finally {
        if (live) setLoading(false);
      }
    };
    run();
    const timer = setInterval(run, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

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
      <span>存储位置</span>
      <strong>飞书云盘 / {config?.feishuRoot?.rootName ?? '行研工作台'} / {config?.internalDirectoryName ?? '内部资料'}</strong>
      <small>下设原始资料、逐字稿和会议纪要 · 本地文件上传上限 100 MB</small>
    </div></div>
    <div className="industry-toolbar">
      <label className="industry-search"><input aria-label="搜索内部资料" placeholder="搜索内部资料" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <button className="secondary" onClick={load}><RefreshCw size={15}/>刷新</button>
    </div>
    {error && <div className="industry-error" role="alert"><AlertCircle size={17}/>{error}</div>}
    {loading && <div className="industry-empty"><LoaderCircle className="spin"/>正在读取内部资料…</div>}
    {!loading && visible.length > 0 && <div className="industry-cards">{visible.map(task => <article className="industry-company" key={task.id}>
      <div className="company-top"><span className="company-monogram"><FileText size={18}/></span><span className={'task-status ' + task.status}>{statusLabel(task)}</span></div>
      <h2>{sourceDisplay(task)}</h2>
      <p>{task.internal.sourceType === 'local' ? '本地文件' : `网络资料${sourceHost(task) ? ` · ${sourceHost(task)}` : ''}`}{task.internal.fileSize != null ? ` · ${(task.internal.fileSize / 1024 / 1024).toFixed(1)} MB` : ''}</p>
      <div className="company-dimensions"><span>{task.internal.uploadEligible ? '原始资料可上传' : task.internal.sourceType === 'local' ? '原始材料超过上传上限' : '保留原始链接'}</span></div>
      {task.error && <div className="industry-error" role="alert">{task.error}</div>}
      {task.publication?.url && <a className="company-title" href={task.publication.url} target="_blank" rel="noreferrer">逐字稿<ArrowUpRight size={18}/></a>}
      {task.publication?.minutesUrl && <a href={task.publication.minutesUrl} target="_blank" rel="noreferrer">会议纪要</a>}
      <p>目录：{task.internal.directoryName ?? "内部解析资料（历史）"}</p>
      {task.publication?.sourceMaterialUrl && <a href={task.publication.sourceMaterialUrl} target="_blank" rel="noreferrer">原始资料</a>}
      {task.notification?.status === 'sent' && <p>飞书机器人已通知</p>}
      {task.notification?.status === 'failed' && <p role="alert">{task.notification.error}<button className="secondary" onClick={async () => {
        try {
          await api(`/${task.id}/notify`, { method: 'POST', body: '{}' });
          await load();
        } catch (cause) {
          setError(cause.message);
        }
      }}>重试通知</button></p>}
      <footer>
        <button onClick={() => onOpen(task)}>AI 会话详情 ↗</button>
        {['failed', 'interrupted'].includes(task.status) && <button onClick={() => onRetry(task)}>重试</button>}
      </footer>
    </article>)}</div>}
    {!loading && visible.length === 0 && <div className="industry-empty">
      <FileText size={32}/><h2>{query ? '没有匹配的内部资料' : '从第一份录音或内部文档开始'}</h2>
      <p>支持本地文件路径或网络链接；解析完成后保存飞书逐字稿及会议纪要。</p>
    </div>}
  </section>;
}
