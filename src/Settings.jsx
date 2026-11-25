import React, { useEffect, useState } from 'react';
import { RefreshCw, Download, ShieldCheck } from 'lucide-react';
import { PlatformLogs } from './RuntimeLogs.jsx';

async function updateRequest(action, token, enabled) {
  const response = await fetch('/api/plugin-update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Update-Token': token },
    body: JSON.stringify({ action, ...(enabled === undefined ? {} : { enabled }) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? '更新操作失败');
  return value;
}

function VersionSettings() {
  const [update, setUpdate] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const refresh = async () => {
      try {
        const response = await fetch('/api/plugin-update', { cache: 'no-store' });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error ?? '无法读取更新状态');
        if (live) setUpdate(value);
      } catch (cause) { if (live) setError(cause.message); }
    };
    void refresh();
    const timer = setInterval(refresh, 15000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  async function act(action, enabled) {
    if (!update?.actionToken || busy) return;
    if (action === 'automatic') setUpdate(current => ({ ...current, automatic: enabled }));
    setBusy(true); setError('');
    try { setUpdate(await updateRequest(action, update.actionToken, enabled)); }
    catch (cause) { if (action === 'automatic') setUpdate(current => ({ ...current, automatic: !enabled })); setError(cause.message); }
    finally { setBusy(false); }
  }
  const status = update?.state === 'restart-required' ? '新版已就绪，重启 DSH 后验证并切换'
    : update?.state === 'downloading' ? '正在下载并校验安装包'
      : update?.packageReady ? '新版安装包已下载并校验'
        : update?.candidateVersion ? '发现可用版本' : '当前没有待安装的新版本';
  return <div className="settings-version">
    <section className="settings-card" aria-label="版本信息">
      <div className="settings-card-heading"><div><h2>版本信息</h2><p>当前运行的行研工作台版本</p></div><ShieldCheck size={22}/></div>
      <div className="settings-version-number">{update?.installedVersion ?? '读取中…'}</div>
      {update?.candidateVersion && <p>最新版本：<strong>{update.candidateVersion}</strong></p>}
      {update?.checkedAt && <p>上次检查：{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(update.checkedAt))}</p>}
      <p role="status">{update ? status : '正在读取版本信息…'}</p>
    </section>
    <section className="settings-card" aria-label="更新配置">
      <div className="settings-card-heading"><div><h2>更新配置</h2><p>安装包先下载并校验，切换版本时会验证服务健康状态。</p></div><Download size={22}/></div>
      <label className="settings-auto"><span><strong>空闲时自动更新</strong><small>没有正在执行的任务时安装已校验的正式版本</small></span><input type="checkbox" checked={Boolean(update?.automatic)} disabled={!update || busy || update.eligible !== true && !update.automatic} onChange={event => act('automatic', event.target.checked)}/></label>
      <div className="settings-actions"><button className="secondary" disabled={!update || busy || update.state === 'checking' || update.state === 'installing'} onClick={() => act('check')}><RefreshCw size={16}/>检查更新</button>
        {update?.candidateVersion && <button className="primary" disabled={busy || !update.supported || update.eligible !== true || update.state === 'installing'} onClick={() => act('install')}>安装已校验版本</button>}</div>
      {update?.eligible === false && <p className="settings-note">当前安装来源不支持插件内更新，请通过 DSH 插件管理器安装正式版。</p>}
      {error || update?.error ? <p className="settings-error" role="alert">{error || update.error}</p> : null}
    </section>
  </div>;
}

export function Settings() {
  const [tab, setTab] = useState('version');
  const tabs = [['version', '版本与更新'], ['logs', '平台日志']];
  return <section className="industry-content settings-page"><div className="industry-heading"><div><p className="industry-eyebrow">INDUSTRY INTELLIGENCE / SETTINGS</p><h1>设置</h1><p>管理工作台版本并查看平台运行记录。</p></div></div>
    <div className="industry-library-tabs" role="tablist" aria-label="工作台设置" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'version' : event.key === 'End' ? 'logs' : tab === 'version' ? 'logs' : 'version';
      setTab(next); event.currentTarget.querySelector('#settings-' + next)?.focus();
    }}>{tabs.map(([value, label]) => <button key={value} id={'settings-' + value} role="tab" aria-selected={tab === value} aria-controls="settings-panel" tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div id="settings-panel" role="tabpanel" aria-labelledby={'settings-' + tab}>{tab === 'version' ? <VersionSettings/> : <PlatformLogs embedded/>}</div>
  </section>;
}
