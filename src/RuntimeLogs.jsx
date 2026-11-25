import React, { useEffect, useState } from 'react';
import { FeishuMonitor } from './FeishuMonitor.jsx';

export function PlatformLogs({ embedded = false }) {
  const [tab, setTab] = useState('all');
  return <section className={embedded ? 'settings-logs' : 'industry-content'}><div className="industry-heading"><div>{embedded ? <h2>平台日志</h2> : <h1>平台日志</h1>}<p>查看平台运行记录，按子栏目定位服务及飞书连接异常。</p></div></div>
    <div className="industry-library-tabs" role="tablist" aria-label="平台日志栏目" onKeyDown={e => {
      if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      e.preventDefault(); const values=['all','feishu','update'], index=values.indexOf(tab);
      const next=e.key==='Home'?'all':e.key==='End'?'update':values[(index+(e.key==='ArrowRight'?1:values.length-1))%values.length];
      setTab(next); e.currentTarget.querySelector('#platform-logs-' + next)?.focus();
    }}>{[['all','运行日志'],['feishu','飞书连接监测'],['update','更新日志']].map(([value,label]) => <button key={value} id={'platform-logs-' + value} role="tab" aria-selected={tab === value} aria-controls="platform-logs-panel" tabIndex={tab === value ? 0 : -1} onClick={() => setTab(value)}>{label}</button>)}</div>
    <div id="platform-logs-panel" role="tabpanel" aria-labelledby={'platform-logs-' + tab}>{tab === 'feishu' ? <FeishuMonitor embedded/> : <RuntimeLogs key={tab} embedded updateOnly={tab==='update'}/>}</div>
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
  'feishu.notification.redirected':'历史任务已通过当前绑定发送通知',
  'feishu.notification.failed':'机器人消息发送失败',
  'feishu.notification.recipient_restored':'已核验并补齐任务原接收账号',
  'feishu.notification.binding_mismatch':'任务原应用与当前绑定应用不一致',
  'runtime.started':'工作台服务已启动',
  'runtime.stopped':'工作台服务已关闭',
  'runtime.start_failed':'工作台服务启动失败',
  'runtime.previous_unconfirmed':'上次运行未记录正常关闭，原因待确认',
  'feishu.http.received':'已接收连接请求',
  'feishu.http.finished':'连接请求已返回',
  'feishu.http.pending':'连接请求长时间未结束，等待确认',
  'feishu.http.disconnected':'请求连接断开，业务结果待确认',
  'feishu.flow.created':'已创建授权流程',
  'feishu.credentials.saved':'应用凭据保存完成',
  'feishu.application.selected':'已提交所选应用',
  'feishu.authorization.confirmed':'个人授权已确认',
  'feishu.ui.clicked':'用户发起连接操作',
  'feishu.ui.response':'界面已收到连接结果',
  'feishu.ui.rendered':'界面绑定状态已更新',
  'feishu.ui.request_failed':'界面请求失败',
  'feishu.ui.script_error':'连接界面发生脚本异常',
  'update.check.current':'已是最新版本',
  'update.check.available':'发现正式版本',
  'update.check.started':'开始检查正式发布',
  'update.check.failed':'检查更新失败',
  'update.release.verified':'发布清单与安装包校验通过',
  'update.download.started':'开始下载更新包',
  'update.download.progress':'更新包下载进度',
  'update.download.completed':'更新包下载并校验完成',
  'update.download.failed':'下载或校验失败',
  'update.install.started':'开始准备本地更新',
  'update.install.deferred':'工作台忙碌，安装稍后重试',
  'update.install.failed':'本地更新失败',
  'update.slot.prepared':'新版已写入本地备用槽位',
  'update.health.waiting':'等待重启验证新版',
  'update.health.passed':'新版启动健康检查通过',
  'update.health.failed':'新版健康检查失败，已回到旧版',
  'update.rollback.completed':'旧版恢复完成',
  'update.retry.requested':'已请求重新尝试',
  'update.settings.changed':'自动更新设置已更改',
  'update.completed':'更新完成',
};
const phaseLabels = { check:'版本检查', download:'下载', health:'健康检查', update:'版本切换', rollback:'回退' };
const failureLabels = { RELEASE_MUTABLE:'发布未启用不可变保护', INTEGRITY_FAILED:'发布或安装包校验失败',
  TIMEOUT:'请求超时', HTTP_FAILED:'更新服务返回错误', WORKBENCH_BUSY:'仍有任务或写入在执行',
  HEALTH_CHECK_FAILED:'新版启动健康检查失败', UPDATE_FAILED:'更新步骤失败' };
function bytes(value) { return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : value >= 1024 ? `${(value / 1024).toFixed(1)} KB` : `${value} B`; }
function UpdateLogDetails({ details }) {
  const fields = [
    ['阶段', phaseLabels[details.phase]],
    ['目标版本', details.candidateVersion ?? details.failedVersion ?? details.version],
    ['运行版本', details.installedVersion],
    ['下载进度', Number.isFinite(details.percent) ? `${details.percent}%` : null],
    ['已下载', Number.isFinite(details.bytesReceived) ? bytes(details.bytesReceived) : null],
    ['安装包大小', Number.isFinite(details.bytesTotal) ? bytes(details.bytesTotal) : null],
    ['耗时', Number.isFinite(details.durationMs) ? `${(details.durationMs / 1000).toFixed(1)} 秒` : null],
    ['回退耗时', Number.isFinite(details.rollbackDurationMs) ? `${(details.rollbackDurationMs / 1000).toFixed(1)} 秒` : null],
    ['本地缓存', typeof details.cached === 'boolean' ? details.cached ? '已复用' : '重新下载' : null],
    ['自动更新', typeof details.automatic === 'boolean' ? details.automatic ? '已开启' : '已关闭' : null],
    ['原因', failureLabels[details.code] ?? details.code],
    ['HTTP 状态', details.httpStatus],
    ['更新编号', details.operationId],
  ].filter(([, value]) => value !== undefined && value !== null && value !== '');
  return <div className="update-log-details">{fields.map(([label, value]) => <span key={label}><small>{label}</small><strong>{value}</strong></span>)}</div>;
}
export function RuntimeLogs({ embedded = false, updateOnly = false }) {
  const [items,setItems]=useState([]), [error,setError]=useState(''), [busy,setBusy]=useState(false);
  async function load(more=false) {
    setBusy(true); setError('');
    try {
      const before=more && items.length ? '&before='+items.at(-1).seq : '';
      const r=await fetch('/api/runtime-logs?limit=100'+(updateOnly?'&kind=update':'')+before), body=await r.json();
      if(!r.ok)throw new Error(body.error || '日志读取失败');
      setItems(old=>more?[...old,...body.items]:body.items);
    }catch(e){setError(e.message);}finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[]);
  return <section className={embedded ? 'platform-runtime-logs' : 'industry-content'}><div className="industry-heading"><div>{!embedded && <h1>平台日志</h1>}<p>{updateOnly?'查看版本检查、下载校验、健康检查和本地切换记录。':'查看应用切换、授权和通知的运行记录。'}保留最近 1000 条，不记录密钥或令牌。</p></div><button className="secondary" disabled={busy} onClick={()=>load()}>刷新日志</button></div>
    {error&&<div className="industry-error" role="alert">{error}</div>}
    <div className="runtime-log-list">{items.map(row=><article className="runtime-log-row" key={row.seq}><div><time>{new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',dateStyle:'short',timeStyle:'medium'}).format(new Date(row.at))}</time><span>{row.level==='error'?'错误':row.level==='warn'?'提醒':'信息'}</span><strong>{labels[row.event] || row.event}</strong></div>{updateOnly?<UpdateLogDetails details={row.details}/>:<pre>{JSON.stringify(row.details,null,2)}</pre>}</article>)}</div>
    {!busy&&!items.length&&<p>{updateOnly?'暂无更新日志。检查更新后会记录在这里。':'暂无运行日志。后续操作会记录在这里。'}</p>}
    {items.length>0&&<button className="secondary" disabled={busy} onClick={()=>load(true)}>加载更早日志</button>}
  </section>;
}
