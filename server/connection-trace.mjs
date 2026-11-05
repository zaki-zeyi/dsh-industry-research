import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const storage = new AsyncLocalStorage(), contexts = new Map();
const instanceId = randomUUID();
let pluginVersion = 'unknown';
try { pluginVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version; } catch {}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const traceActions = ['bind','replace','rebind','repair','inspect'];
export function traceContext() { return storage.getStore(); }
export function traceFor(id, attempt = 1, action = 'inspect') {
  const traceId = uuid.test(id ?? '') ? id : randomUUID();
  const count = Number.isInteger(Number(attempt)) && Number(attempt) >= 1 && Number(attempt) <= 1000 ? Number(attempt) : 1;
  const key = `${traceId}:${count}`;
  let context = contexts.get(key);
  if (!context) {
    if (contexts.size >= 256) contexts.delete(contexts.keys().next().value);
    context = { traceId, attempt: count, action: traceActions.includes(action) ? action : 'inspect', step: 0 };
    contexts.set(key, context);
  }
  return context;
}
export const withTrace = (context, callback) => storage.run(context, callback);
export function recordTrace(store, event, details, level = 'info') { try { store?.runtimeLog(event, details, level); } catch {} }
export function nativeDiagnostic(value) {
  let data = value;
  for (const raw of [value?.stdout, value?.stderr]) { try { data = JSON.parse(raw); break; } catch {} }
  const code = data?.error?.code ?? data?.code, id = data?.request_id ?? data?.log_id ?? data?.error?.log_id;
  return { ...(typeof code === 'number' || typeof code === 'string' && /^(?:[A-Z][A-Z0-9_]{1,63}|[0-9]{1,20})$/.test(code) ? { nativeCode:code } : {}),
    ...(typeof id === 'string' && /^[a-f0-9-]{8,80}$/i.test(id) ? {requestId:id} : {}) };
}
export function logMetadata() {
  const context = traceContext();
  return { pluginVersion, instanceId, platform: process.platform, arch: process.arch,
    ...(context ? { traceId: context.traceId, attempt: context.attempt, operation: context.action, flowId: context.flowId, step: ++context.step } : {}) };
}
export function observeFlow(store, flow) {
  try {
    const context = traceContext(); if (context) context.flowId = flow.id;
    store?.runtimeLog('feishu.flow.created', { flowId: flow.id, status: 'waiting', phase: 'flow_creation' });
  } catch {}
}
export function recordRuntimeStart(store) {
  try {
    if (store.setting('monitor-runtime-state')?.status === 'running') recordTrace(store,'runtime.previous_unconfirmed',{status:'pending_confirmation'},'warn');
    store.saveSetting('monitor-runtime-state',{status:'running',instanceId});
  } catch {}
}
export function recordRuntimeStop(store) {
  try { recordTrace(store,'runtime.stopped',{status:'completed'}); store.saveSetting('monitor-runtime-state',{status:'stopped',instanceId}); } catch {}
}
export function traceMiddleware(store) {
  return (req, res, next) => {
    if (!/^\/api\/feishu-(binding|registration)(\/|$)/.test(req.path)) return next();
    const context = traceFor(req.headers['x-feishu-trace-id'], req.headers['x-feishu-attempt'], req.headers['x-feishu-action']);
    withTrace(context, () => {
      const started = Date.now(), mutation = !['GET','HEAD'].includes(req.method);
      res.setHeader('X-Feishu-Trace-Id', context.traceId);
      const log = (event, details, level) => { try { withTrace(context, () => store.runtimeLog(event, details, level)); } catch {} };
      if (mutation) log('feishu.http.received', { phase:'http_request', status:'started' });
      // Observation only: never terminates, retries or changes the operation.
      const timer = mutation ? setTimeout(() => log('feishu.http.pending', { phase:'http_request', status:'pending_confirmation', durationMs:Date.now()-started }, 'warn'), 20000) : null;
      timer?.unref?.();
      let finished = false;
      res.once('finish', () => {
        finished = true; clearTimeout(timer);
        if (mutation || res.statusCode >= 400) log('feishu.http.finished', { phase:'http_request', status:res.statusCode>=400?'failed':'completed', httpStatus:res.statusCode, durationMs:Date.now()-started },res.statusCode>=400?'warn':'info');
      });
      res.once('close', () => { clearTimeout(timer); if (!finished && mutation) log('feishu.http.disconnected',{phase:'http_request',status:'pending_confirmation',durationMs:Date.now()-started},'warn'); });
      next();
    });
  };
}
