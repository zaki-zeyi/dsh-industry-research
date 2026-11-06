export function newConnectionTrace(action = 'bind') {
  return { traceId: crypto.randomUUID(), attempt: 1, action };
}
const counts = new Map();
export function connectionEvent(trace, event, phase, value = {}) {
  try {
    const key = `${Math.floor(Date.now()/60000)}:${trace.traceId}`;
    if (counts.size > 64) counts.clear();
    const count = counts.get(key) ?? 0; if (count >= 48) return; counts.set(key,count+1);
    const body = { traceId:trace.traceId, attempt:trace.attempt, action:trace.action, event, phase,
      ...(/^[a-f0-9-]{36}$/i.test(value.flowId ?? '') ? {flowId:value.flowId} : {}),
      ...(/^cli_[A-Za-z0-9]{5,100}$/.test(value.appId ?? '') ? {appId:value.appId} : {}),
      ...(['started','waiting','completed','failed','bound','unbound','cancelled','expired'].includes(value.status) ? {status:value.status} : {}) };
    void fetch('/api/feishu-monitor/events', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2000) }).catch(()=>{});
  } catch { /* Observability never blocks the UI. */ }
}
export async function tracedConnectionRequest(path, body, method, trace) {
  const phase = path.startsWith('/feishu-registration') ? 'registration' : 'binding';
  try {
    const response=await fetch(`/api${path}`,{ method:body===undefined?'GET':method,headers:{'Content-Type':'application/json','X-Feishu-Trace-Id':trace.traceId,'X-Feishu-Attempt':String(trace.attempt),'X-Feishu-Action':trace.action},...(body===undefined?{}:{body:JSON.stringify(body)}) });
    const value=await response.json();
    if(!response.ok)throw new Error(value.error??'请求失败');
    return value;
  } catch(error) { connectionEvent(trace,'request_failed',phase,{status:'failed'}); throw error; }
}
