import React, { useEffect, useState } from 'react';
import { FeishuMonitor } from './FeishuMonitor.jsx';

export function PlatformLogs() {
  const [tab, setTab] = useState('all');
  return <section className="industry-content"><div className="industry-heading"><div><h1>平台日志</h1><p>查看平台运行记录，按子栏目定位服务及飞书连接异常。</p></div></div>
    <div className="industry-library-tabs" role="tablist" aria-label="平台日志栏目" onKeyDown={e => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault(); const next = e.key === 'Home' ? 'all' : e.key === 'End' ? 'feishu' : tab === 'all' ? 'feishu' : 'all';
      setTab(next); e.currentTarget.querySelector('#platform-logs-' + next)?.focus();
    }}>{[['all','运行日志'],['feishu','飞书连接监测']].map(([value,label]) => <button key={value} id={'platform-logs-' + value} role="tab" aria-selected={tab === value} aria-controls="platform-logs-panel" tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div id="platform-logs-panel" role="tabpanel" aria-labelledby={'platform-logs-' + tab}>{tab === 'feishu' ? <FeishuMonitor embedded/> : <RuntimeLogs embedded/>}</div>
  </section>;
}
const labels = {
  'feishu.application.staged':'已收到所选应用，等待个人账号校验',
  'feishu.application.committed':'应用切换已提交',
  'feishu.application.validation_failed':'所选应用已保留，账号校验未完成',
  'feishu.identity.unavailable':'个人稳定身份读取失败',
  'feishu.registration.started':'已开始应用扫码登记',
  'feishu.registration.completed':'飞书应用登记完成',
  'feishu.registration.failed':'飞书应用登记或保存失败',
  'feishu.notification.sent':'机器人消息已发送',
  'feishu.notification.failed':'机器人消息发送失败',
  'runtime.started':'工作台服务已启动',
};
export function RuntimeLogs({ embedded = false }) {
  const [items,setItems]=useState([]), [error,setError]=useState(''), [busy,setBusy]=useState(false);
  async function load(more=false) {
    setBusy(true); setError('');
    try {
      const before=more && items.length ? '&before='+items.at(-1).seq : '';
      const r=await fetch('/api/runtime-logs?limit=100'+before), body=await r.json();
      if(!r.ok)throw new Error(body.error || '日志读取失败');
      setItems(old=>more?[...old,...body.items]:body.items);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[]);
  return <section className={embedded ? 'platform-runtime-logs' : 'industry-content'}><div className="industry-heading"><div>{!embedded && <h1>平台日志</h1>}<p>查看应用切换、授权和通知的运行记录。保留最近 1000 条，不记录密钥或令牌。</p></div><button className="secondary" disabled={busy} onClick={()=>load()}>刷新日志</button></div>
    {error&&<div className="industry-error" role="alert">{error}</div>}
    <div className="runtime-log-list">{items.map(row=><article className="runtime-log-row" key={row.seq}><div><time>{new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date(row.at))}</time><span>{row.level==='error'?'错误':row.level==='warn'?'提醒':'信息'}</span><strong>{labels[row.event] || row.event}</strong></div><pre>{JSON.stringify(row.details,null,2)}</pre></article>)}</div>
    {!busy&&!items.length&&<p>暂无运行日志。后续操作会记录在这里。</p>}
    {items.length>0&&<button className="secondary" disabled={busy} onClick={()=>load(true)}>加载更早日志</button>}
  </section>;
}
