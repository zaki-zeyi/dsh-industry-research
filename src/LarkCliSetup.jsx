import React, { useEffect, useRef, useState } from 'react';
import './lark-cli-setup.css';

export function LarkCliSetup({ onReady }) {
  const [result, setResult] = useState(null), [checking, setChecking] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState(false);
  const live = useRef(true), locked = useRef(false);
  const [recovering, setRecovering] = useState(false), [recovery, setRecovery] = useState('');
  async function retryRead() {
    if (locked.current) return;
    locked.current = true; setRecovering(true); setRecovery('');
    try { const message = await onReady?.(); if (live.current) setRecovery(message ?? ''); }
    catch (error) { if (live.current) setRecovery(`读取仍未恢复：${error.message}`); }
    finally { locked.current = false; if (live.current) setRecovering(false); }
  }
  async function check() {
    if (locked.current) return;
    locked.current = true; setChecking(true); setError('');
    try {
      const response = await fetch('/api/feishu-cli', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? '无法检查飞书 CLI');
      if (live.current) setResult(value);
    } catch (error) { if (live.current) setError(error.message); }
    finally { locked.current = false; if (live.current) setChecking(false); }
  }
  useEffect(() => { live.current = true; void check(); return () => { live.current = false; }; }, []);
  const command = result?.platform === 'win32' ? result.install.windowsCommand : result?.install.unixCommand;
  return <section className="lark-cli-setup" aria-label="飞书 CLI 环境">
    <div className="lark-cli-setup-heading"><strong>飞书 CLI 环境</strong><button className="secondary" disabled={checking || recovering} onClick={check}>{checking ? '检测中…' : '重新检测 CLI'}</button></div>
    <p role="status">{result?.status === 'ready' ? `CLI 可用 · ${result.version}` : result?.message ?? '正在检查插件所在机器的 CLI…'}</p>
    {result?.status === 'ready' && <p>命令已可运行。飞书登录、应用权限和机器人接收范围需要分别检查，安装 CLI 不等于完成授权。</p>}
    {result?.status === 'ready' && onReady && <><p>CLI 检测完成不会自动修复索引读取。点击下方按钮重试，读取成功后才会清除对应横幅。</p><button className="secondary" disabled={checking || recovering} onClick={retryRead}>{recovering ? '正在重试读取…' : '重试失败的读取'}</button>{recovery && <p role="status">{recovery}</p>}</>}
    {error && <p role="alert">{error}</p>}
    {result && result.status !== 'ready' && <>
      <p>桌面版请在运行 DSH 的电脑安装；网页版请在服务所在机器安装。安装后点击“重新检测 CLI”，再重试原操作。</p>
      <ol><li>先安装 Node.js（包含 npm/npx）。</li><li>在系统终端运行下面的官方安装命令。</li><li>返回本页重新检测；如宿主尚未识别新安装路径，重新加载插件。</li></ol>
      <label>官方安装命令<input aria-label="官方安装命令" readOnly value={command ?? ''} onFocus={e => e.target.select()}/></label>
      <div className="lark-cli-setup-actions"><button className="secondary" onClick={async () => { try { await navigator.clipboard.writeText(command); setCopied(true); } catch { setError('请选中安装命令并手动复制'); } }}>{copied ? '已复制安装命令' : '复制安装命令'}</button><a href={result.install.documentationUrl} target="_blank" rel="noreferrer">官方安装说明 ↗</a><a href={result.install.nodeUrl} target="_blank" rel="noreferrer">下载 Node.js ↗</a></div>
      <p>已有安装时先检查路径；插件不会自动覆盖 CLI、清除凭据或更换飞书账号。</p>
    </>}
  </section>;
}
