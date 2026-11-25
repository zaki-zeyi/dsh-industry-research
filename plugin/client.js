window.__ModuleLoader__.load({
  id: 'dsh-industry-research',
  factory: (require) => {
    const React = require('react'), h = React.createElement;
    let hostContext, lastTask = '';
    function Panel({ SessionProvider, renderSlot }) {
      const frame = React.useRef(null), reference = React.useRef(null), revision = React.useRef(0), frameSource = React.useRef(null), pending = React.useRef(null);
      const [status, setStatus] = React.useState({ state: 'starting' }), [conversation, setConversation] = React.useState(null), [startupAttempt, setStartupAttempt] = React.useState(0);
      const disposeLease = lease => { if (lease && !lease.released) { lease.released = true; lease.value?.release(); } };
      const release = () => { disposeLease(reference.current); reference.current = null; };
      const discardPending = () => { disposeLease(pending.current); pending.current = null; };
      const showWorkbench = (taskId, publish = false) => {
        revision.current++; discardPending(); release(); setConversation(null); lastTask = taskId ?? '';
        frame.current?.contentWindow.postMessage({ type: 'industry-research:show-report', taskId: taskId ?? '', publish }, status.url);
      };
      React.useEffect(() => {
        let stopped = false, timer, controller, requestTimer;
        const deadline = Date.now() + 20000;
        setStatus({ state: 'starting' });
        async function poll() {
          controller = new AbortController();
          try {
            // Race the request as well as abort it: a stalled browser transport must not leave the panel spinning forever.
            const next = await Promise.race([
              (async () => {
                const response = await fetch('/industry-research/status', { signal: controller.signal, cache: 'no-store', credentials: 'same-origin' });
                if (response.status === 401 || response.status === 403) throw new Error('宿主访问授权已失效，请使用服务启动时生成的完整链接重新打开');
                if (!response.ok) throw new Error('无法连接调研插件，请检查宿主服务后重试');
                return response.json();
              })(),
              new Promise((_, reject) => { requestTimer = setTimeout(() => { controller.abort(); reject(new Error('连接宿主超时，请重试；若其他宿主功能也未加载，请刷新页面或使用启动时生成的完整链接重新打开')); }, Math.min(8000, Math.max(1, deadline - Date.now()))); }),
            ]);
            if (stopped) return;
            if (!next || !['ready', 'starting', 'error'].includes(next.state)) throw new Error('宿主返回的启动状态无效，请重试');
            if (next.state === 'starting' && Date.now() >= deadline) throw new Error('调研服务启动超时，请检查宿主服务后重试');
            setStatus(next); if (next.state === 'starting') timer = setTimeout(poll, 500);
          } catch (error) { if (!stopped) setStatus({ state: 'error', message: error.message }); }
          finally { clearTimeout(requestTimer); }
        }
        poll(); return () => { stopped = true; clearTimeout(timer); clearTimeout(requestTimer); controller?.abort(); };
      }, [startupAttempt]);
      React.useEffect(() => {
        if (status.state !== 'ready') return;
        let disposed = false;
        const filePickers = new Map();
        const receive = async event => {
          if (event.origin !== status.url || event.source !== frame.current?.contentWindow) return;
          const message = event.data;
          if (['industry-research:pick-file','industry-research:cancel-file-picker'].includes(message?.type)) {
            if (typeof message.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(message.requestId)) return;
            if (message.type === 'industry-research:cancel-file-picker') { filePickers.get(message.requestId)?.({cancelled:true}); return; }
            const replyFile = value => { if (!disposed) event.source.postMessage({type:'industry-research:file-result',requestId:message.requestId,...value},status.url); };
            if (filePickers.size) { replyFile({error:'文件选择器已打开，请先完成选择。'}); return; }
            const bridge = window.__DSH_HOST_PATHS__;
            if (typeof bridge?.pathFor !== 'function') { replyFile({error:'当前网页版无法获取原始本地路径，请使用 DSH 桌面版或网络链接。'}); return; }
            const input = window.document.createElement('input'); input.type = 'file'; input.style.display = 'none';
            const finish = value => { if (!filePickers.has(message.requestId)) return; filePickers.delete(message.requestId); input.remove(); replyFile(value); };
            filePickers.set(message.requestId,finish);
            input.addEventListener('cancel',() => finish({cancelled:true}),{once:true});
            input.addEventListener('change',() => {
              const file = input.files?.[0]; if (!file) { finish({cancelled:true}); return; }
              try {
                const path = bridge.pathFor(file);
                if (typeof path !== 'string' || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/)/.test(path) || /^[A-Za-z]:[\\/]fakepath[\\/]/i.test(path) || /[\x00-\x1f]/.test(path) || path.length > 4000) throw new Error('invalid path');
                finish({path,size:file.size});
              } catch { finish({error:'无法获取所选文件的原始完整路径，请重新选择文件。'}); }
            },{once:true});
            window.document.body.append(input);
            try { input.click(); } catch { finish({error:'无法打开宿主文件选择器，请重试。'}); }
            return;
          }

          if (message?.type === 'industry-research:hide-session') {
            if (reference.current?.taskId === message.taskId && reference.current?.requestId === message.requestId || pending.current?.taskId === message.taskId && pending.current?.requestId === message.requestId) { revision.current++; discardPending(); release(); setConversation(null); }
            return;
          }
          if (message?.type !== 'industry-research:embed-session' || !/^[a-f0-9-]{36}$/.test(message.taskId ?? '') || typeof message.requestId !== 'string' || message.requestId.length > 100) return;
          const turn = ++revision.current; discardPending(); const lease = { taskId: message.taskId, requestId: message.requestId, value: null, released: false }; pending.current = lease;
          const reply = value => event.source.postMessage({ type: 'industry-research:session-result', requestId: message.requestId, ...value }, status.url);
          let acquired;
          try {
            const response = await fetch(`/industry-research/session?taskId=${encodeURIComponent(message.taskId)}`), binding = await response.json();
            if (!response.ok || binding.taskId !== message.taskId || !binding.sessionId) throw new Error(binding.error ?? '会话绑定无效');
            if (disposed || turn !== revision.current) return;
            acquired = hostContext.sessions.retain(binding.sessionId, { source: 'industry-research' }); lease.value = acquired; await acquired.ready;
            if (disposed || turn !== revision.current) { disposeLease(lease); return; }
            release(); pending.current = null; reference.current = lease;
            lastTask = message.taskId; setConversation({ ...binding, reference: acquired }); reply({ ok: true });
          } catch (error) { disposeLease(lease); if (!disposed && turn === revision.current) { pending.current = null; reply({ ok: false, error: error.message }); } }
        };
        window.addEventListener('message', receive);
        return () => { disposed = true; for (const finish of [...filePickers.values()]) finish({cancelled:true}); revision.current++; discardPending(); release(); window.removeEventListener('message', receive); };
      }, [status.state, status.url]);
      React.useEffect(() => {
        if (!conversation) return;
        let disposed = false;
        const timer = setInterval(async () => {
          try { const r = await fetch(`/industry-research/session?taskId=${conversation.taskId}`), next = await r.json(); if (!disposed && r.ok) setConversation(current => current?.taskId === next.taskId ? { ...current, reportReady: next.reportReady, publicationStatus: next.publicationStatus, publicationUrl: next.publicationUrl, status: next.status } : current); } catch {}
        }, 2000);
        return () => { disposed = true; clearInterval(timer); };
      }, [conversation?.taskId]);
      if (status.state !== 'ready') return h('div', { style: { padding: 32 }, role: status.state === 'error' ? 'alert' : 'status' }, h('p', null, status.state === 'error' ? `调研服务连接失败：${status.message}` : '正在启动行研工作台…'), status.state === 'error' && h('button', { onClick: () => { frameSource.current = null; setStartupAttempt(value => value + 1); } }, '重新连接工作台'));
      if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(status.url)) return h('div', null, '调研服务地址无效');
      if (!frameSource.current) frameSource.current = `${status.url}/?embed=dsh&hostOrigin=${encodeURIComponent(window.location.protocol === 'dsh-app:' ? 'dsh-app://app' : window.location.origin)}${lastTask ? `#${lastTask}` : ''}`;
      const button = (label, onClick, selected, disabled = false) => h('button', { onClick, disabled, 'aria-current': selected ? 'page' : undefined }, label);
      const stateLabel = conversation?.publicationStatus === 'awaiting_authorization' ? '待飞书授权' : conversation?.publicationStatus === 'published' ? '已保存飞书' : conversation?.publicationStatus === 'publishing' ? '正在保存飞书' : conversation?.publicationStatus === 'failed' ? '飞书保存待处理' : conversation?.reportReady ? '报告已生成' : conversation?.status === 'failed' ? '调研失败' : conversation?.status === 'interrupted' ? '已中断' : '调研中';
      const created = conversation?.createdAt ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Shanghai', hour12: false }).format(new Date(conversation.createdAt)) : '';
      return h('div', { style: { display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0, overflow: 'hidden' } },
        h('iframe', { title: '行研工作台', ref: frame, src: frameSource.current, style: { width: '100%', height: '100%', minHeight: 400, border: 0, display: conversation ? 'none' : 'block', flex: 1 }, allow: 'clipboard-write' }),
        conversation && h('section', { className: 'rw-workspace', 'aria-label': '行研工作台原生对话', style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'auto' } },
          h('header', { className: 'rw-topbar' }, h('div', { className: 'rw-breadcrumb' }, '工作空间', h('span', null, '/'), h('strong', null, '行研工作台'), h('span', null, '/'), h('span', null, '调研详情')), h('span', { className: 'rw-host-label' }, 'DSH 原生会话')),
          h('div', { className: 'rw-detail', style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
            h('header', null,
              h('button', { className: 'rw-back', onClick: () => showWorkbench('') }, h('span', { 'aria-hidden': true }, '←'), '返回'),
              h('div', { className: 'rw-heading-row' }, h('div', { className: 'rw-title' }, h('h1', null, conversation.direction ?? '调研详情'), h('small', { className: 'rw-badge', role: 'status' }, stateLabel)),
                conversation.cloudOnly ? (conversation.publicationUrl ? h('a', { className: 'rw-secondary', href: conversation.publicationUrl, target: '_blank', rel: 'noreferrer' }, '打开飞书报告') : h('button', { className: 'rw-secondary', onClick: () => showWorkbench('') }, '返回工作台')) : h('button', { className: 'rw-secondary', onClick: () => showWorkbench(conversation.taskId, !['awaiting_authorization', 'published', 'publishing'].includes(conversation.publicationStatus)), disabled: !conversation.reportReady }, conversation.publicationStatus === 'awaiting_authorization' ? '查看授权二维码' : conversation.publicationStatus === 'published' ? '查看飞书报告' : conversation.publicationStatus === 'publishing' ? '查看保存进度' : '上传飞书')),
              h('div', { className: 'rw-meta' }, h('span', null, created), h('span', null, conversation.sources === 'web' ? '全网' : conversation.sources ?? ''), h('span', null, `${conversation.runCount ?? 1} 次执行`))),
            !conversation.cloudOnly && h('nav', { className: 'rw-tabs', 'aria-label': '调研详情视图' }, button('调研报告', () => showWorkbench(conversation.taskId)), button('AI对话', () => {}, true)),
            h('div', { className: 'rw-chat-card' }, h(SessionProvider, { session: conversation.reference }, renderSlot('industry-research.session', {}))))),
        h('link', { rel: 'stylesheet', href: '/industry-research/theme.css' })
      );
    }
    return {
      inject: ['slots', 'layout', 'sessions', 'uiSession'],
      apply(ctx) {
        hostContext = ctx;
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-industry-research', children: { 'industry-research.session': { kind: 'single', scope: 'session' } } }, Panel));
        ctx.slots.inject('industry-research.session', () => ctx.slots.register({ name: 'industry-research.session' }, ({ renderFactorySlot }) => renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false })));
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: 'dsh-industry-research', label: '行研工作台', order: 50 }, ({ size = 20 }) => h('span', { style: { fontSize: size }, 'aria-hidden': true }, '▤')));
      },
    };
  },
});
