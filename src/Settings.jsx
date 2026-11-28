import React, { useEffect, useState } from 'react';
import { RefreshCw, Download, ShieldCheck } from 'lucide-react';
import { PlatformLogs } from './RuntimeLogs.jsx';
import { hostOrigin } from './host-origin.mjs';

function VersionSettings() {
  const [update, setUpdate] = useState(null);
  const [runningVersion, setRunningVersion] = useState(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const [timedOut, setTimedOut] = useState(false);
  const params = new URLSearchParams(location.search);
  const origin = params.get('embed') === 'dsh' && window.parent !== window
    ? hostOrigin(document.referrer, params.get('hostOrigin')) : null;
  const send = (action, version) => window.parent.postMessage({ type: 'industry-research:official-update', requestId, action, version }, origin);
  useEffect(() => {
    if (!origin) {
      const controller = new AbortController();
      fetch('/api/health', { cache: 'no-store', signal: controller.signal }).then(response => response.json())
        .then(value => setRunningVersion(value.version)).catch(() => {});
      return () => controller.abort();
    }
    const receive = event => {
      if (event.source !== window.parent || event.origin !== origin || event.data?.type !== 'industry-research:official-update-state' || event.data.requestId !== requestId) return;
      clearInterval(retry);
      clearTimeout(timeout);
      setTimedOut(false);
      setUpdate(event.data.state);
    };
    window.addEventListener('message', receive);
    const retry = setInterval(() => send('watch'), 500);
    const timeout = setTimeout(() => { clearInterval(retry); setTimedOut(true); }, 5000);
    send('watch');
    return () => {
      clearInterval(retry);
      clearTimeout(timeout);
      window.removeEventListener('message', receive);
      send('unwatch');
    };
  }, [origin, requestId]);
  return <div className="settings-version">
    <section className="settings-card" aria-label="版本信息">
      <div className="settings-card-heading"><div><h2>版本信息</h2><p>当前运行的行研工作台版本</p></div><ShieldCheck size={22}/></div>
      <div className="settings-version-number">{update?.runningVersion ?? runningVersion ?? '—'}</div>
      {update?.installedVersion && <p>DSH 安装版本：{update.installedVersion}</p>}
      {update?.checkedAt && <p>上次检查：{new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(update.checkedAt))}</p>}
    </section>
    <section className="settings-card" aria-label="行研工作台官方 Git 更新">
      <div className="settings-card-heading"><div><h2>DSH 官方更新</h2><p>与插件详情页使用同一更新方式，在线安装完整插件。</p></div><Download size={22}/></div>
      {update ? <>
        <div className="settings-actions"><button className="primary" disabled={update.busy || !update.runningVersion} onClick={() => send(update.version ? 'install' : 'check', update.version)}><RefreshCw size={16}/>{update.label}</button>
          {update.version && <button className="secondary" disabled={update.busy} onClick={() => send('check')}>重新检查</button>}</div>
        {update.unavailableReason && <p className="settings-note" role="status">{update.unavailableReason}</p>}
        {update.operation && <p role="status">{update.operation}</p>}
        {!update.version && !update.busy && !update.error && !update.unavailableReason && update.checkedAt && <p role="status">当前没有可用更新</p>}
        {update.error && <p className="settings-error" role="alert">{update.error}</p>}
      </> : <p role="status">{!origin ? '请在 DSH 中打开行研工作台以更新插件。' : timedOut ? '无法连接宿主更新服务，请重新打开设置，或在 DSH 插件详情页检查更新。' : '正在连接宿主更新服务…'}</p>}
    </section>
  </div>;
}

export function Settings() {
  const [tab, setTab] = useState('version');
  const tabs = [['version', '版本与更新'], ['logs', '平台日志']];
  return <section className="industry-content settings-page">
    <div className="industry-library-tabs" role="tablist" aria-label="工作台设置" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 'version' : event.key === 'End' ? 'logs' : tab === 'version' ? 'logs' : 'version';
      setTab(next); event.currentTarget.querySelector('#settings-' + next)?.focus();
    }}>{tabs.map(([value, label]) => <button key={value} id={'settings-' + value} role="tab" aria-selected={tab === value} aria-controls="settings-panel" tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div id="settings-panel" role="tabpanel" aria-labelledby={'settings-' + tab}>{tab === 'version' ? <VersionSettings/> : <PlatformLogs embedded/>}</div>
  </section>;
}
