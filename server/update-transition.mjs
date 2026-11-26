// This page must work without business assets: they can belong to either slot
// while the current document is reconnecting to the newly mounted service.
export function updateTransitionPage(checking) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>正在更新行研工作台</title>
<style>
body{margin:0;background:#f7f8f5;color:#20382c;font:16px/1.7 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:520px;margin:24px;padding:36px;background:white;border:1px solid #dce4da;border-radius:16px}
h1{font-size:24px;margin:0 0 12px}p{color:#66776c;margin:12px 0}
progress{width:100%;height:10px;accent-color:#355b44}button{font:inherit;color:#355b44;background:white;border:1px solid #bccdbf;border-radius:8px;padding:8px 18px;cursor:pointer}
</style></head><body><main aria-label="工作台更新过渡页">
<h1>正在应用工作台新版</h1><p id="message" role="status">${checking ? '正在进行健康检查，通过后会自动恢复工作台。' : '正在切换版本，完成后会自动恢复工作台。'}</p>
<progress aria-label="正在等待工作台就绪"></progress>
<p>请保留此页面，无需重启 DSH。</p><button id="retry" type="button" hidden>重新连接工作台</button>
</main><script>
(() => {
  let stopped = false, busy = false, timer;
  const started = Date.now(), message = document.getElementById('message'), retry = document.getElementById('retry');
  async function poll() {
    if (stopped || busy) return;
    clearTimeout(timer);
    busy = true;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch('/api/health', {cache:'no-store',signal:controller.signal});
      const health = await response.json();
      let ready = health.ready === true;
      if (response.ok && health.application === 'industry-research' && health.ready === undefined) {
        // Earlier local fallback slots expose no readiness field. Their update
        // endpoint remains blocked until activation has actually completed.
        const probe = await fetch('/api/plugin-update', {cache:'no-store',signal:controller.signal});
        if (probe.ok) ready = (await probe.json()).installedVersion === health.version;
      }
      if (response.ok && health.application === 'industry-research' && ready) {
        stopped = true; location.reload(); return;
      }
    } catch {}
    finally { clearTimeout(timeout); busy = false; }
    if (stopped) return;
    if (Date.now() - started > 60000) {
      message.textContent = '连接耗时较长，仍在自动尝试恢复。也可点击重新连接。'; retry.hidden = false;
    }
    timer = setTimeout(poll, 750);
  }
  retry.addEventListener('click', () => { if (!busy) void poll(); });
  addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  void poll();
})();
</script></body></html>`;
}

export function updateTransition(service, req, res) {
  if ((!service.activationPending && !service.updating) || req.path === '/api/health') return false;
  if (!service.activationPending && req.path === '/api/plugin-update' && ['GET', 'HEAD'].includes(req.method)) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', '1');
  const document = ['GET', 'HEAD'].includes(req.method) && !/^\/api(?:\/|$)/.test(req.path) &&
    (req.get('sec-fetch-dest') === 'document' || req.get('accept')?.includes('text/html'));
  res.status(503);
  if (document) res.type('html').send(updateTransitionPage(service.activationPending));
  else res.json({ code: 'WORKBENCH_UPDATING', retryable: true,
    error: service.activationPending ? '新版正在进行健康检查' : '工作台正在切换版本，请稍后重试' });
  return true;
}
