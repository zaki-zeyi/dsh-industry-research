import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { startRuntime, dataIdentity } from '../server/runtime.mjs';
import { PluginUpdates } from './updates.mjs';
export const name = 'dsh-industry-research';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
// Retain the existing storage namespace and health protocol for upgrades.
export const inject = ['webServer', 'sessionController', 'permissionPresets', 'workspaceRegistry'];
export async function connectRuntime(config = {}, host) {
  const dataDir = resolve(config.dataDir ?? resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'industry-research'));
  const port = config.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('调研服务端口无效');
  if (port) {
    let health;
    try { const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) }); health = await response.json(); } catch {}
    if (health) {
      if (health.application !== 'industry-research' || health.dataIdentity !== dataIdentity(dataDir)) throw new Error(`端口 ${port} 已被其他服务或其他调研数据库占用`);
      if (health.version !== version) throw new Error(`端口 ${port} 正在运行工作台 ${health.version ?? '未知版本'}，请先停止旧服务`);
      if (host && config.mode !== 'demo' && health.transport !== 'dsh-native') throw new Error('已有调研服务不支持宿主原生会话，请停止旧服务后重新启用插件');
      return { url: `http://127.0.0.1:${port}`, dataDir, owned: false, close: async () => {} };
    }
  }
  const env = { ...process.env, RESEARCH_MODE: host && config.mode !== 'demo' ? 'native' : config.mode ?? 'codex', CODEX_MODEL: config.model ?? process.env.CODEX_MODEL, CODEX_COMMAND: config.command ?? process.env.CODEX_COMMAND };
  const runtime = await startRuntime({ env, port, dataDir, host });
  return { ...runtime, owned: true };
}
export function apply(ctx, config = {}) {
  let stopped = false, runtime;
  const updateToken = randomBytes(32).toString('hex');
  const updateResult = value => ({ ...value, actionToken: updateToken });
  const validUpdateToken = value => typeof value === 'string' && value.length === updateToken.length &&
    timingSafeEqual(Buffer.from(value), Buffer.from(updateToken));
  let status = { state: 'starting', version };
  const ready = connectRuntime(config, ctx).then(async result => {
    runtime = result;
    if (stopped) return result.close();
    status = { state: 'ready', url: result.url, owned: result.owned, version };
    config.onRuntime?.(result);
  }).catch(error => {
    status = { state: 'error', message: error.message, version };
    throw error;
  });
  let updates;
  const updateReady = ready.then(() => {
    if (stopped || !runtime?.service) return;
    updates = new PluginUpdates(runtime.service, () => ctx.get?.('pluginManager'), version,
      { cacheDir: resolve(runtime.dataDir, 'updates'), slotUpdater: config.slotUpdater });
    updates.start();
  });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/industry-research/status', handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(config.activationGate && !config.activationGate.approved ?
      { state: 'starting', version } : status));
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/industry-research/theme.css', handler(_req, res) { res.setHeader('Content-Type', 'text/css; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(readFileSync(new URL('./workbench-theme.css', import.meta.url), 'utf8')); } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/industry-research/session', handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    try {
      const id = new URL(req.url, 'http://localhost').searchParams.get('taskId');
      if (!/^[a-f0-9-]{36}$/.test(id ?? '')) throw new Error('任务标识无效');
      const task = runtime?.service?.require(id);
      if (!task?.nativeSession || !task.nativeSessionId) throw new Error('该任务没有宿主原生会话');
      res.end(JSON.stringify({ taskId: id, sessionId: task.nativeSessionId, direction: task.direction, cloudOnly: Boolean(runtime.service.cloudOnly), publicationUrl: task.publication.target === 'feishu' && task.publication.status === 'published' ? task.publication.url : null, reportReady: Boolean(task.report), publicationStatus: task.publication.status, status: task.status, createdAt: task.createdAt, sources: task.sources, runCount: task.runs.length }));
    } catch { res.statusCode = 409; res.end(JSON.stringify({ error: '无法打开任务的宿主原生会话，请在行研工作台检查状态' })); }
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/industry-research/update', async handler(req, res) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (config.activationGate && !config.activationGate.approved) throw new Error('更新槽位尚未确认');
      await updateReady;
      if (!updates) throw new Error('更新服务尚未就绪');
      if (req.method === 'GET') return res.end(JSON.stringify(updateResult(updates.snapshot())));
      // Electron can serialize the custom dsh-app origin as "null". A per-run token
      // obtained through the authenticated same-origin GET protects mutations without
      // depending on Chromium's Origin serialization.
      if (req.method !== 'POST' || !validUpdateToken(req.headers['x-dsh-update-token'])) {
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: '更新操作来源无效' }));
      }
      const action = new URL(req.url, 'http://localhost').searchParams;
      if (action.get('action') === 'check') return res.end(JSON.stringify(updateResult(await updates.check())));
      if (action.get('action') === 'automatic' && ['0', '1'].includes(action.get('enabled'))) {
        return res.end(JSON.stringify(updateResult(updates.setAutomatic(action.get('enabled') === '1'))));
      }
      if (action.get('action') === 'install') {
        void updates.install().catch(error => { updates.state = 'failed'; updates.error = error.message; });
        res.statusCode = 202;
        return res.end(JSON.stringify(updateResult(updates.snapshot())));
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: '更新操作无效' }));
    } catch (error) {
      res.statusCode = 503;
      res.end(JSON.stringify({ error: error.message }));
    }
  } }));
  ctx.effect(() => async () => { stopped = true; updates?.close(); await updateReady.catch(() => {}); await runtime?.close(); });
  return updateReady;
}
