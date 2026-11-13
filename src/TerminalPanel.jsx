import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Command, Maximize2, Minimize2, Square, RefreshCw } from 'lucide-react';
import '@xterm/xterm/css/xterm.css';

export function TerminalPanel({ task, onRefresh }) {
  const name = task.ai?.agent === 'dsh' ? 'dsh tui' : 'Codex';
  const host = useRef(null), fitRef = useRef(null), [status, setStatus] = useState('connecting'), [error, setError] = useState(''), [expanded, setExpanded] = useState(false);
  const [activity, setActivity] = useState('researching');
  const [permissions, setPermissions] = useState(null);
  useEffect(() => {
    if (!task.terminalId) return;
    const terminal = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, Monaco, Consolas, monospace', lineHeight: 1.25, scrollback: 15000, allowTransparency: false, theme: { background: '#15201b', foreground: '#dce6dd', cursor: '#b8d6a0', selectionBackground: '#57705b88', black: '#15201b', brightBlack: '#7b9384', green: '#a9ce8d', brightGreen: '#c1e4a6' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current); fitRef.current = fit;
    let socket, disposed = false, timer, acceptingInput = false, seq = 0, queue = Promise.resolve();
    const send = data => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
    const resize = () => { if (!host.current?.clientWidth || !host.current?.clientHeight) return; fit.fit(); if (acceptingInput) send({ type: 'resize', cols: terminal.cols, rows: terminal.rows }); };
    const apply = async frame => {
      if (frame.seq <= seq) return; seq = frame.seq;
      if (frame.type === 'output') await new Promise(resolve => terminal.write(frame.data, resolve));
      else if (frame.type === 'activity') setActivity(frame.activity);
      else if (frame.type === 'resize') terminal.resize(frame.cols, frame.rows);
      else if (frame.type === 'status') { setStatus(frame.status); if (frame.activity) setActivity(frame.activity); if (frame.permissions) setPermissions(frame.permissions); terminal.options.disableStdin = !['created', 'running'].includes(frame.status); if (frame.error) setError(frame.error); }
    };
    const connect = () => {
      if (disposed) return;
      acceptingInput = false; setStatus('connecting');
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminals/${task.terminalId}/ws`);
      socket.onmessage = event => {
        let message; try { message = JSON.parse(event.data); } catch { return; }
        queue = queue.then(async () => {
          if (disposed) return;
          if (message.type === 'snapshot') {
            terminal.reset(); seq = 0; terminal.resize(100, 30);
            // Replay adjacent output together: thousands of tiny PTY frames otherwise
            // take one renderer tick each before the saved idle state can appear.
            let pending = null;
            const flush = async () => { if (pending) { await apply(pending); pending = null; } };
            for (const frame of message.frames) {
              if (frame.type === 'output') {
                if (pending && pending.data.length + frame.data.length > 65536) await flush();
                pending = { ...frame, data: (pending?.data ?? '') + frame.data };
              } else { await flush(); await apply(frame); }
            }
            await flush();
            if (disposed) return;
            setStatus(message.meta.status); setPermissions(message.meta.permissions ?? null); setActivity(message.meta.activity ?? (task.report ? 'waiting_input' : 'researching')); terminal.options.disableStdin = !['created', 'running'].includes(message.meta.status);
            acceptingInput = true; send({ type: 'ready' }); resize();
          } else if (message.type === 'frame') await apply(message.frame);
          else if (message.type === 'error') setError(message.error);
        }).catch(e => { if (!disposed) setError(e.message); });
      };
      socket.onclose = () => { if (disposed) return; acceptingInput = false; setStatus('reconnecting'); timer = setTimeout(connect, 1200); };
      socket.onerror = () => { if (!disposed) setStatus('reconnecting'); };
    };
    const input = terminal.onData(data => { if (acceptingInput) send({ type: 'input', data }); });
    const observer = new ResizeObserver(resize); observer.observe(host.current); connect();
    return () => { disposed = true; acceptingInput = false; clearTimeout(timer); socket?.close(); observer.disconnect(); input.dispose(); terminal.dispose(); fitRef.current = null; };
  }, [task.terminalId]);
  async function reopen() { try { setError(''); const res = await fetch(`/api/tasks/${task.id}/terminal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const d = await res.json(); if (!res.ok) throw new Error(d.error); await onRefresh(); } catch(e) { setError(e.message); } }
  async function stop() { try { const res = await fetch(`/api/tasks/${task.id}/terminal/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); const d = await res.json(); if (!res.ok) throw new Error(d.error); } catch(e) { setError(e.message); } }
  return <section className={`native-terminal ${expanded ? 'terminal-expanded' : ''}`} aria-label={`${name} 原生终端`}>
    <div className="terminal-toolbar"><div><span className="terminal-lights"><i/><i/><i/></span><Command size={15}/><strong>{name} 终端</strong><span className="terminal-state" role="status">{status === 'running' ? ({ researching: '调研中', finishing: '本轮收尾中', working: '处理新要求', waiting_input: '等待新要求' })[activity] ?? '终端已连接' : ({ created: '等待启动', running: '运行中', exited: '已退出', interrupted: '已中断', failed: '启动失败', connecting: '连接中', reconnecting: '重连中' })[status]}</span></div><div>{['exited', 'interrupted', 'failed'].includes(status) ? <button onClick={reopen}><RefreshCw size={14}/>重新连接会话</button> : <button onClick={stop} disabled={!task.terminalId}><Square size={12}/>结束终端</button>}<button aria-label={expanded ? '退出全屏' : '全屏终端'} onClick={() => setExpanded(!expanded)}>{expanded ? <Minimize2 size={15}/> : <Maximize2 size={15}/>}</button></div></div>
    {error && <div className="terminal-error" role="alert">{error}</div>}
    {permissions && <div className="terminal-permissions" aria-label="Codex 会话权限">{permissions.sandbox === 'danger-full-access' ? '完整访问 · 当前用户的文件系统和网络' : permissions.sandbox === 'workspace-write' ? '工作区访问 · 旧会话' : '只读访问'}{permissions.approval === 'on-request' && ' · 操作按需确认'}</div>}
    {!task.terminalId && <div className="terminal-wait">正在创建终端会话…</div>}
    <div className="terminal-host" ref={host}/>
    <footer><span>{status === 'running' && activity === 'waiting_input' ? '本轮已结束，终端保持连接，可直接输入新要求' : '直接操作真实 {name} CLI · 支持输入、粘贴、滚动及快捷键'}</span><span>断开页面不会停止进程</span></footer>
  </section>;
}
