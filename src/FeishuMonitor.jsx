import React, { useEffect, useRef, useState } from 'react';
import { Activity, Download, RefreshCw, X } from 'lucide-react';
import './feishu-monitor.css';

const phases = { binding_validation: '绑定结果校验', app_registration: '应用扫码登记', credential_storage: '本机凭据保存', qr_generation: '二维码生成', identity_check: '身份及服务验证', authorization_start: '发起个人授权', authorization_confirm: '确认个人授权', bot_message: '机器人消息', cli_request: '飞书 CLI 调用', application: '应用配置', local_key: '本机登录密钥', user_authorization: '个人授权', document_permissions: '文档及云盘权限', account: '账号一致性', bot_identity: '机器人身份' };
const codes = {
  OK: ['正常', ''], PROFILE_CONFLICT: ['应用配置重复', '本机已有相同 App ID 的 profile。系统会尝试更新已有配置，请结合后续凭据保存日志确认恢复结果。'],
  LOCAL_KEY_UNAVAILABLE: ['本机密钥不可用', '检查当前 Windows 用户的凭据存储与登录密钥，再重新授权。'],
  CLI_NOT_FOUND: ['未找到飞书 CLI', '确认运行插件的环境能够访问 lark-cli。'], LOCAL_STORAGE_DENIED: ['本机存储访问失败', '检查文件访问权限与系统凭据存储。'],
  PERMISSION_DENIED: ['权限不足', '核对当前应用已发布的权限和用户可用范围。'], TIMEOUT: ['调用超时', '检查网络及本机 CLI 是否阻塞后重试。'],
  NETWORK_ERROR: ['网络连接异常', '检查代理、DNS、证书及飞书服务连通性。'], REMOTE_SERVICE_ERROR: ['飞书服务返回异常', '稍后重试，并结合该阶段与时间定位服务故障。'],
  AUTH_EXPIRED: ['授权已失效', '重新完成当前应用的个人授权。'], CANCELLED: ['流程已取消', '可重新发起扫码。'],
  APP_MISMATCH_OR_MISSING: ['应用未配置或不匹配', '核对插件所选应用与 CLI 返回的 App ID。'], USER_AUTH_REQUIRED: ['个人授权未就绪', '完成个人扫码授权，再检查结果。'],
  SCOPE_MISSING: ['文档权限缺失', '补充下方列出的文档和云盘权限。'], ACCOUNT_MISMATCH: ['账号不一致', '使用扫码选择应用时的同一账号完成个人授权。'],
  BOT_NOT_READY: ['机器人身份未就绪', '检查应用机器人能力及凭据；身份正常不等于消息发送权限或接收范围已验证。'],
  CLI_CHECK_FAILED: ['连接检查失败', '查看同一时间的 CLI 调用日志，定位底层异常。'],
  UNKNOWN_ERROR: ['未分类异常', '结合阶段、时间和关联编号检查本机 CLI 或飞书服务。'],
};
const events = { 'feishu.connection.started': '开始', 'feishu.connection.finished': '结束', 'feishu.connection.failed': '失败', 'feishu.monitor.check': '检测', 'feishu.notification.failed': '消息发送失败', 'feishu.notification.sent': '消息已发送' };
const time = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value));
async function request(path, options) {
  const r = await fetch('/api/feishu-monitor/' + path, { ...options, signal: AbortSignal.timeout(20000) }), value = await r.json();
  if (!r.ok) throw new Error(value.error ?? '连接监测服务请求失败');
  return value;
}
export function FeishuMonitor({ onClose, embedded = false }) {
  const [items, setItems] = useState([]), [level, setLevel] = useState(''), [error, setError] = useState(''), [result, setResult] = useState(null);
  const [watching, setWatching] = useState(true), [checking, setChecking] = useState(false), [loading, setLoading] = useState(false), [more, setMore] = useState(true);
  const dialog = useRef(null), loadLock = useRef(false), checkLock = useRef(false), revision = useRef(0);
  const mounted = useRef(true), filter = useRef(level); filter.current = level;
  async function load(append = false, force = false) {
    if (loadLock.current && !force) return;
    const current = revision.current, selected = filter.current;
    loadLock.current = true; setLoading(true);
    try {
      const query = new URLSearchParams({ limit: '100', ...(selected ? { level: selected } : {}), ...(append && items.length ? { before: String(items.at(-1).seq) } : {}) });
      const value = await request('logs?' + query);
      if (!mounted.current || current !== revision.current) return;
      setItems(old => append ? [...old, ...value.items] : value.items); setMore(value.items.length === 100); setError('');
    } catch (e) { if (mounted.current) setError(e.message); }
    finally { loadLock.current = false; if (mounted.current) setLoading(false); }
  }
  async function check() {
    if (checkLock.current) return;
    checkLock.current = true; setChecking(true); setError('');
    try { const value = await request('check', { method: 'POST' }); if (mounted.current) { setResult(value); await load(); } }
    catch (e) { if (mounted.current) setError(e.message); }
    finally { checkLock.current = false; if (mounted.current) setChecking(false); }
  }
  useEffect(() => {
    mounted.current = true; const previous = document.activeElement; if (!embedded) dialog.current?.querySelector('button')?.focus();
    const escape = e => { if (!embedded && e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', escape);
    return () => { mounted.current = false; revision.current++; document.removeEventListener('keydown', escape); previous?.focus(); };
  }, []);
  useEffect(() => { revision.current++; setItems([]); void load(false, true); }, [level]);
  useEffect(() => { if (!watching) return; const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000); return () => clearInterval(timer); }, [watching, level]);
  function exportLogs() {
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), result, items }, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'feishu-connection-logs.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function keyDown(e) {
    if (embedded || e.key !== 'Tab') return;
    const controls = [...dialog.current.querySelectorAll('button:not(:disabled), select, input')];
    if (e.shiftKey && document.activeElement === controls[0]) { e.preventDefault(); controls.at(-1)?.focus(); }
    else if (!e.shiftKey && document.activeElement === controls.at(-1)) { e.preventDefault(); controls[0]?.focus(); }
  }
  return <div className={embedded ? 'platform-feishu-monitor' : 'industry-modal-backdrop'}><section ref={dialog} className="feishu-monitor" role={embedded ? 'region' : 'dialog'} aria-modal={embedded ? undefined : 'true'} aria-labelledby="feishu-monitor-title" onKeyDown={keyDown}>
    <header><div><Activity size={20}/><h2 id="feishu-monitor-title">飞书连接监测</h2></div>{!embedded && <button className="industry-icon" aria-label="关闭飞书连接监测" onClick={onClose}><X size={20}/></button>}</header>
    <p>按阶段追踪飞书连接。最近 1000 条平台日志共用保留额度；不记录密钥、令牌、二维码链接或消息正文。</p>
    <div className="feishu-monitor-actions"><button className="primary" disabled={checking} onClick={check}><Activity size={16}/>{checking ? '检测中…' : '立即检测连接'}</button><button className="secondary" disabled={loading} onClick={() => load()}><RefreshCw size={16}/>刷新日志</button><button className="secondary" disabled={!items.length && !result} onClick={exportLogs}><Download size={16}/>导出当前记录</button></div>
    <p className="feishu-monitor-note">检测会验证当前应用、个人授权及机器人身份，不发送测试消息，不自动重新绑定。消息发送权限和接收范围以实际发送日志为准。</p>
    {error && <div className="industry-error" role="alert">监测服务异常：{error}</div>}
    {result && <section className="feishu-monitor-result" aria-label="连接检测结果"><strong>{result.status === 'ok' ? '连接检查通过' : '发现连接异常'}</strong><small>{time(result.checkedAt)} · {result.durationMs} ms{result.appId && ` · ${result.appId}`}</small><div>{result.checks.map(c => <article key={c.phase} data-status={c.status}><span>{phases[c.phase] ?? c.phase}</span><strong>{codes[c.code]?.[0] ?? c.code}</strong>{codes[c.code]?.[1] && <p>{codes[c.code][1]}</p>}</article>)}</div>{result.missingScopes?.length > 0 && <p>缺少权限：{result.missingScopes.join('、')}</p>}</section>}
    <div className="feishu-monitor-filters"><label>日志级别 <select aria-label="日志级别" value={level} onChange={e => setLevel(e.target.value)}><option value="">全部</option><option value="error">错误</option><option value="warn">提醒</option><option value="info">信息</option></select></label><label><input type="checkbox" checked={watching} onChange={e => setWatching(e.target.checked)}/>每 5 秒刷新日志</label></div>
    <div className="feishu-monitor-logs" aria-live="polite">{items.map(row => <article key={row.seq} className="feishu-monitor-log" data-level={row.level}><div><time>{time(row.at)}</time><span>{row.level === 'error' ? '错误' : row.level === 'warn' ? '提醒' : '信息'}</span><strong>{phases[row.details.phase] ?? row.event} · {events[row.event] ?? row.event}</strong>{row.details.durationMs !== undefined && <small>{row.details.durationMs} ms</small>}</div>{row.details.code && <p>{codes[row.details.code]?.[0] ?? row.details.code} {codes[row.details.code]?.[1]}</p>}<details><summary>查看诊断字段</summary><pre>{JSON.stringify(row.details, null, 2)}</pre></details></article>)}</div>
    {!loading && !items.length && <p>暂无匹配的飞书日志。可以立即检测，或在绑定操作后查看。</p>}{more && items.length > 0 && <button className="secondary" disabled={loading || watching} onClick={() => load(true)}>加载更早记录（需暂停自动刷新）</button>}
  </section></div>;
}
