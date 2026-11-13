import { cloudPublications, mergePublicationCards, publicationCacheKey } from './cloud-publications.mjs';
import { createScopedSync } from './sync-once.mjs';
import { briefingTask } from './briefings.mjs';
import { libraryReadError } from './library-errors.mjs';
import { refreshLibrary, importLibrary, preferences, preferencesSchema, library, companyTaskInput, libraryKey } from './industry.mjs';
import { refreshAnalysisLibrary, analysisLibrary, analysisKey, analysisTaskInput, analysisTaskCards } from './analysis.mjs';
import { createRequire } from 'node:module';
const express = createRequire(import.meta.url)('express');
import { resolve, dirname } from 'node:path';
import { existsSync, realpathSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { ServiceError } from './service.mjs';
import { prepareInternalMaterial, internalDirectorySchema } from './internal-materials.mjs';
import { traceMiddleware, traceFor, withTrace, traceActions } from './connection-trace.mjs';
import { requireIdleBinding } from './binding-blockers.mjs';
import { inspectLarkCli } from './lark-setup.mjs';

export function createApp(service, { dist = resolve('dist'), health = {}, libraryRun, libraryImportRun, analysisRun, publicationRun, cliRun } = {}) {
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: '只允许通过本机地址访问' });
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin) {
      const allowed = new Set([`http://${req.headers.host}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
      if (!allowed.has(req.headers.origin)) return res.status(403).json({ error: '不允许此来源修改任务' });
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.use(traceMiddleware(service.store));
  app.get('/api/feishu-cli', async (_req, res, next) => { try {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await inspectLarkCli(service.binding?.command, { run: cliRun }));
  } catch (error) { next(error); } });
  const telemetryBudget = new Map();
  app.post('/api/feishu-monitor/events', (req, res, next) => { try {
    const data = z.object({ traceId:z.string().uuid(), attempt:z.number().int().min(1).max(1000), action:z.enum(traceActions), event:z.enum(['clicked','response','request_failed','rendered','script_error','qr_error']), phase:z.enum(['binding','registration','ui_sync','frontend']), flowId:z.string().uuid().optional(), appId:z.string().regex(/^cli_[A-Za-z0-9]{5,100}$/).optional(), status:z.enum(['started','waiting','completed','failed','bound','unbound','cancelled','expired']).optional() }).strict().parse(req.body);
    const key=data.traceId, now=Date.now();
    if(!telemetryBudget.has(key)&&telemetryBudget.size>=256)telemetryBudget.delete(telemetryBudget.keys().next().value);
    let budget=telemetryBudget.get(key); if(!budget||now-budget.since>=60000){budget={since:now,count:0};telemetryBudget.set(key,budget);}
    if(budget.count>=60)return res.sendStatus(204); budget.count++;
    try { withTrace(traceFor(data.traceId,data.attempt,data.action),()=>service.store.runtimeLog('feishu.ui.'+data.event,{phase:data.phase,flowId:data.flowId,appId:data.appId,status:data.status},['request_failed','script_error','qr_error'].includes(data.event)?'warn':'info')); } catch {}
    res.setHeader('Cache-Control','no-store'); res.sendStatus(204);
  } catch(e) { next(e); } });
  app.get('/api/runtime-logs', (req, res, next) => { try { const query = z.object({limit:z.coerce.number().int().min(1).max(200).optional(),before:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).parse(req.query); res.setHeader('Cache-Control','no-store'); res.json({items:service.store.runtimeLogs(query)}); } catch(e) { next(e); } });
  app.get('/api/industry/preferences', (_req, res) => res.json(preferences(service.store)));
  app.put('/api/industry/preferences', (req, res, next) => { try { res.json(service.store.saveSetting('industry-preferences', preferencesSchema.parse(req.body))); } catch (e) { next(e); } });
  app.get('/api/industry/library', async (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); const root = service.feishuSettings(), app = service.binding?.applicationSnapshot?.(); res.json(req.query.refresh === 'true' ? await indexSync.run(libraryKey(root,app),{},()=>library(service.store,root,app),()=>refreshLibrary(service.store, root, app, libraryRun, { command: service.binding?.command })) : library(service.store, root, app)); } catch (e) { const safe = libraryReadError(e); service.store.runtimeLog('feishu.index.failed', { code: safe.code, phase: 'cloud_read', operation: 'library' }, 'error'); next(safe); } });
  app.post('/api/industry/tasks', async (req, res, next) => { try { const key = req.headers['idempotency-key']; if (key) z.string().min(1).max(100).parse(key); res.status(202).json(await service.createAuthorized(companyTaskInput(req.body), key)); } catch (e) { next(e); } });
  const publicationSync = createScopedSync();
  const indexSync = createScopedSync({ ttlMs: 0 });
  const internalDirectory = () => service.store.setting('internal-directory-name') ?? '内部资料';
  // One remote read per scope: a running scan is shared, and a result cached
  // less than 60s ago is reused unless the caller forces a refresh.
  async function syncPublications(kind, { force = false } = {}) {
    const key = publicationCacheKey(service.feishuSettings(), service.binding?.applicationSnapshot?.(), kind, internalDirectory());
    return publicationSync.run(key, { force }, () => cloudPublications(service, kind), () => cloudPublications(service, kind, { refresh: true, run: publicationRun }));
  }
  async function readPublications(kind, { refresh = false, force = false } = {}) {
    try { return refresh ? await syncPublications(kind, { force }) : await cloudPublications(service, kind); }
    catch(error) {
      const safe=libraryReadError(error);
      service.store.runtimeLog('feishu.publications.read',{phase:'cloud_read',code:safe.code,status:'failed'},'warn');
      const cached=await cloudPublications(service,kind); return {...cached,syncError:safe.message};
    }
  }
  app.get('/api/briefings', async (req,res,next) => { try { const kind = z.enum(['daily','weekly']).optional().parse(req.query.kind); const kinds = kind ? [kind] : ['daily','weekly']; const results=await Promise.all(kinds.map(k => readPublications(k,{refresh:req.query.refresh === 'true',force:req.query.force === 'true'}))); const remote=results.flatMap(v=>v.items); const local=service.store.list().filter(t => t.briefing && (!kind || t.briefing.kind === kind)).map(t => ({id:t.id,direction:t.direction,status:t.status,createdAt:t.createdAt,briefing:t.briefing,stage:t.stage,publication:t.publication,notification:t.notification})); res.json({items:mergePublicationCards(local,remote),syncError:results.find(v=>v.syncError)?.syncError,syncedAt:results.map(v=>v.syncedAt).filter(Boolean).sort().at(-1) ?? null}); } catch(error) { next(libraryReadError(error)); } });
  app.post('/api/briefings', async(req,res,next)=>{try {res.status(202).json(await service.createAuthorized(briefingTask(req.body),req.headers['idempotency-key']));}catch(e){next(e);}});
  app.post('/api/briefings/:id/notify',async(req,res,next)=>{try{const t=service.require(req.params.id);if(!t.briefing||t.status!=='ready')throw new ServiceError(409,'报告尚未完成');await service.notifications.send(t.id,{currentUser:true});res.json(service.require(t.id));}catch(e){next(e);}});
  app.get('/api/internal-materials', async (req, res, next) => { try {
    const remote=await readPublications('internal',{refresh:req.query.refresh === 'true',force:req.query.force === 'true'});
    res.json({items: mergePublicationCards(service.store.list().filter(task => task.internal).map(task => ({
      id: task.id,
      direction: task.direction,
      status: task.status,
      stage: task.stage,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      internal: task.internal,
      publication: task.publication,
      notification: task.notification,
      error: task.error,
    })), remote.items), syncError:remote.syncError, syncedAt:remote.syncedAt ?? null});
  } catch(error) { next(libraryReadError(error)); } });
  app.put('/api/internal-materials/settings', (req, res, next) => {
    try {
      const { directoryName } = z.object({ directoryName: internalDirectorySchema }).strict().parse(req.body);
      service.store.saveSetting('internal-directory-name', directoryName);
      res.json({ directoryName });
    } catch (error) { next(error); }
  });
  app.post('/api/internal-materials', async (req, res, next) => {
    try {
      const key = req.headers['idempotency-key'];
      if (key) z.string().min(1).max(100).parse(key);
      const input = prepareInternalMaterial({ directoryName: service.store.setting('internal-directory-name') ?? '内部资料', ...req.body });
      const task = await service.createAuthorized(input, key);
      service.store.saveSetting('internal-directory-name', input.internal.directoryName);
      res.status(202).json(task);
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/internal-materials/:id/notify', async (req, res, next) => {
    try {
      const task = service.require(req.params.id);
      if (!task.internal || task.status !== 'ready') throw new ServiceError(409, '内部资料解析尚未完成');
      await service.internalNotifications.send(task.id,{currentUser:true});
      res.json(service.require(task.id));
    } catch (error) {
      next(error);
    }
  });
  app.get('/api/briefings/schedule',(req,res,next)=>{try{const kind=req.query.kind?z.enum(['daily','weekly']).parse(req.query.kind):undefined;res.json(service.briefingSchedules?.get(kind)??{available:false});}catch(e){next(e);}});
  app.put('/api/briefings/schedule',async(req,res,next)=>{try{res.json(await service.briefingSchedules.save(req.body));}catch(e){next(e);}});
  app.post('/api/briefings/trigger/:kind',async(req,res,next)=>{try{const kind=z.enum(['daily','weekly']).parse(req.params.kind);res.status(202).json(await service.briefingSchedules.trigger(kind));}catch(e){next(e);}});
  app.get('/api/analysis/reports', async (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); const root = service.feishuSettings(), app = service.binding?.applicationSnapshot?.(); const library = req.query.refresh === 'true' ? await indexSync.run(analysisKey(root,app),{},()=>analysisLibrary(service.store,root,app),()=>refreshAnalysisLibrary(service.store, root, app, analysisRun, { command: service.binding?.command })) : analysisLibrary(service.store, root, app); res.json(analysisTaskCards(service.store, library, root, app)); } catch (e) { const safe = libraryReadError(e); service.store.runtimeLog('feishu.index.failed', { code: safe.code, phase: 'cloud_read', operation: 'analysis' }, 'error'); next(safe); } });
  app.post('/api/analysis/tasks', async (req, res, next) => { try { const key = req.headers['idempotency-key']; if (key) z.string().min(1).max(100).parse(key); res.status(202).json(await service.createAuthorized(analysisTaskInput(req.body), key)); } catch (e) { next(e); } });
  app.get('/api/ai-settings', (_req, res) => { if (!service.aiSettings) return res.status(503).json({ error: 'AI 配置尚未启用' }); res.setHeader('Cache-Control', 'no-store'); res.json(service.aiSettings.get()); });
  app.put('/api/ai-settings', (req, res) => { if (!service.aiSettings) return res.status(503).json({ error: 'AI 配置尚未启用' }); try { const input = z.object({ agent: z.enum(['codex', 'dsh']) }).strict().parse(req.body); res.json(service.aiSettings.save(input)); } catch (error) { res.status(400).json({ error: error instanceof z.ZodError ? 'AI 配置字段无效' : error.message }); } });
  app.get('/api/feishu-monitor/logs', (req, res, next) => { try {
    const query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), level: z.enum(['info','warn','error']).optional(), traceId:z.string().uuid().optional() }).strict().parse(req.query);
    res.setHeader('Cache-Control', 'no-store'); res.json({ items: service.store.runtimeLogs({ ...query, feishu: true }) });
  } catch (e) { next(e); } });
  app.post('/api/feishu-monitor/check', async (_req, res, next) => { try {
    if (!service.binding?.connectionMonitor) throw new ServiceError(503, '当前连接服务不支持检测，请重新加载插件服务');
    res.setHeader('Cache-Control', 'no-store'); res.json(await service.binding.connectionMonitor.check());
  } catch (e) { next(e); } });
  app.get('/api/feishu-application', async (_req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json(await service.binding.applicationInfo()); } catch(e) { next(e); } });
  app.put('/api/feishu-application', async (req, res, next) => { try { requireIdleBinding(service,'切换飞书应用'); res.setHeader('Cache-Control', 'no-store'); res.json(await service.binding.configureApplication(req.body)); } catch(e) { next(e); } });
  app.get('/api/feishu-registration', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(service.binding.registration.snapshot()); });
  app.post('/api/feishu-registration', async (req, res, next) => { try { const input = z.object({ refresh: z.boolean().optional(), repairBot: z.boolean().optional() }).strict().parse(req.body ?? {}); requireIdleBinding(service);
    const cli = await service.binding.inspectCLI?.();
    if (cli && cli.status !== 'ready') throw Object.assign(new ServiceError(503, cli.message), { code: cli.code });
    // Recheck after the asynchronous probe, since another operation may have
    // begun while it was running. This cannot bypass the existing idle guard.
    requireIdleBinding(service); res.setHeader('Cache-Control', 'no-store'); res.json(service.binding.registration.start(input));
  } catch(e) { next(e); } });
  app.delete('/api/feishu-registration', (_req, res, next) => { try { service.binding.registration.cancel(); res.json({ status: 'idle' }); } catch(e) { next(e); } });
  app.get('/api/feishu-registration/qr/:id', (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.type('png').send(service.binding.registration.qr(req.params.id)); } catch(e) { next(e); } });
  app.get('/api/feishu-binding', async (_req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.json(await service.binding.status()); } catch(e) { next(e); } });
  app.post('/api/feishu-binding', async (req, res, next) => { try { const input = z.object({ rebind: z.boolean().optional() }).strict().parse(req.body ?? {}); if (input.rebind) requireIdleBinding(service); res.setHeader('Cache-Control', 'no-store'); const flow = await service.binding.start({ rebind: input.rebind }); res.json(flow); } catch(e) { next(e); } });
  app.post('/api/feishu-binding/complete', async (req, res, next) => { try { const { flowId } = z.object({ flowId: z.string().uuid() }).strict().parse(req.body); res.json(await service.binding.complete(flowId)); } catch(e) { next(e); } });
  app.get('/api/feishu-binding/qr/:id', (req, res, next) => { try { res.setHeader('Cache-Control', 'no-store'); res.type('png').send(service.binding.qr(req.params.id)); } catch(e) { next(e); } });
  app.get('/api/feishu-settings', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(service.feishuSettings()); });
  app.put('/api/feishu-settings', (req, res, next) => { try { res.json(service.setFeishuSettings(req.body)); } catch (e) { next(e); } });
  app.post('/api/feishu-settings/import', async (req, res, next) => {
    let settings;
    try { settings = service.setFeishuSettings(req.body); }
    catch (error) { next(error); return; }
    const application = service.binding?.applicationSnapshot?.();
    const targetChanged=()=>libraryKey(service.feishuSettings(),service.binding?.applicationSnapshot?.())!==libraryKey(settings,application);
    res.setHeader('Cache-Control', 'no-store');
    try {
      const summary = await importLibrary(service.store, settings, application, libraryImportRun, { command: service.binding?.command });
      if(targetChanged())return res.status(409).json({error:'同步期间飞书根目录或应用已改变，旧目录结果已保留，请刷新当前目录'});
      res.json({ settings, import: summary, library: library(service.store, settings, application) });
    } catch (error) {
      if(targetChanged())return res.status(409).json({error:'同步期间飞书根目录或应用已改变，请刷新当前目录'});
      const safe = libraryReadError(error);
      const current = library(service.store, settings, application);
      res.json({
        settings,
        import: { status: 'failed', code: safe.code, imported: 0, total: current.companies.length, libraryFolderFound: false, indexFound: false, message: `设置已保存，但读取飞书目录失败：${safe.message}` },
        library: current,
      });
    }
  });
  app.get('/api/config', (_req, res) => res.json({ mode: service.mode, nativeWorkspace: service.nativeSessions?.workspaceState?.() ?? null, cloudOnly: Boolean(service.cloudOnly), analysisAvailable: Boolean(service.cloudOnly), terminalAvailable: Boolean(service.terminals), nativeSessionAvailable: Boolean(service.nativeSessions), transport: service.researcher.transport ?? 'json', terminalPermissions: service.terminals?.permissions ?? null, publicationTarget: service.publisher.kind ?? 'demo', publicationOwner: 'agent', singleUser: true, feishuTarget: service.feishuSettings().folderUrl ? '飞书云盘 / 指定文件夹' : `飞书云盘 / ${service.feishuSettings().rootName}`, feishuRoot: service.feishuSettings(), internalDirectoryName: service.store.setting("internal-directory-name") ?? "内部资料", publicationScope: libraryKey(service.feishuSettings(), service.binding?.applicationSnapshot?.())+':'+(service.feishuSettings().folderToken??'') }));
  app.get('/api/tasks/:id/agent-qr', (req, res, next) => { try {
    const t = service.require(req.params.id);
    if (t.publication.status !== 'awaiting_authorization' || !t.terminalId || !service.terminals) throw new ServiceError(404, '当前没有待扫描的授权二维码');
    const meta = service.terminals.get(t.terminalId);
    const path = realpathSync(meta.qrPath);
    if (dirname(path) !== realpathSync(meta.cwd) || statSync(path).size > 1024 * 1024) throw new Error('Invalid QR file');
    if (!readFileSync(path).subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('Invalid PNG');
    res.setHeader('Cache-Control', 'no-store'); res.type('png').sendFile(path);
  } catch(e) { next(e instanceof ServiceError ? e : new ServiceError(404, 'Agent 尚未生成可显示的二维码，请在终端查看授权指引')); } });
  app.get('/api/health', (_req, res) => res.json({ ok: true, ...health }));
  app.get('/api/tasks', (req, res, next) => { try {
    const limit = z.coerce.number().int().min(1).max(100).default(30).parse(req.query.limit);
    let tasks = service.store.list();
    if (req.query.cursor) { const index = tasks.findIndex(t => t.id === req.query.cursor); if (index < 0) throw new ServiceError(400, '分页游标无效'); tasks = tasks.slice(index + 1); }
    const page = tasks.slice(0, limit);
    res.json({ items: page.map(({ id, direction, sources, status, stage, createdAt, updatedAt, publication, report, mode, ai, briefing, internal }) => ({ id, ai, briefing, internal, direction, sources, status, stage, createdAt, updatedAt, publication, mode, summary: service.cloudOnly ? null : report?.summary ?? null })), nextCursor: tasks.length > limit ? page.at(-1).id : null });
  } catch(e) { next(e); } });
  app.post('/api/tasks', async (req, res, next) => { try { const key = req.headers['idempotency-key']; if (key) z.string().min(1).max(100).parse(key); res.status(202).json(await service.createAuthorized(req.body, key)); } catch(e) { next(e); } });
  app.get('/api/tasks/:id', (req, res, next) => { try { const t = service.require(req.params.id); res.json(service.cloudOnly ? { task: { ...t, report: null, reports: [], draft: '', localPublication: undefined }, events: [] } : { task: t, events: service.store.events(req.params.id) }); } catch(e) { next(e); } });
  app.post('/api/tasks/:id/write-lock',async(req,res,next)=>{try{const {requestId}=z.object({requestId:z.string().uuid()}).strict().parse(req.body);res.json(await service.cloudWrites.acquire(req.params.id,requestId));}catch(e){next(e);}});
  app.post('/api/tasks/:id/retry', async (req, res, next) => { try { const stage = z.enum(['research', 'publish']).parse(req.body.stage); if (service.cloudOnly) await service.binding.requireBound(); res.status(202).json(service.retry(req.params.id, stage)); } catch(e) { next(e); } });
  app.post('/api/tasks/:id/publish', (req, res, next) => { try { res.status(202).json(service.publishToFeishu(req.params.id)); } catch(e) { next(e); } });
  app.post('/api/tasks/:id/cancel', (req, res, next) => { try { res.json(service.cancel(req.params.id)); } catch(e) { next(e); } });
  app.get('/api/tasks/:id/session', (req, res, next) => { try { const task = service.require(req.params.id); if (!task.nativeSession || !task.nativeSessionId) throw new ServiceError(409, '任务尚未绑定宿主原生会话'); res.json({ taskId: task.id, sessionId: task.nativeSessionId }); } catch(e) { next(e); } });
  app.post('/api/tasks/:id/terminal', (req, res, next) => { try {
    const t = service.require(req.params.id); if (t.nativeSession) throw new ServiceError(409, '请打开宿主 DSH 原生会话'); if (!service.terminals) throw new ServiceError(503, '当前服务未启用原生终端');
    const existing = t.terminalId ? service.terminals.get(t.terminalId) : null;
    if (existing && ['created', 'running'].includes(existing.status)) return res.json({ task: t, terminal: existing });
    if (service.active.has(t.id) || t.status === 'queued') throw new ServiceError(409, '调研正在执行，请先停止当前任务再打开原生终端');
    const sessionId = existing?.sessionId ?? t.runs.at(-1)?.sessionId;
    const validId = existing?.agent === 'dsh' || t.ai?.agent === 'dsh' ? /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,159}$/ : /^[a-f0-9-]{36}$/;
    const resumeId = validId.test(sessionId ?? '') ? sessionId : undefined;
    const meta = service.terminals.create(t, { resumeId, resumeLast: Boolean(existing) });
    t.terminalId = meta.id; t.terminalMode = true; service.save(t); res.json({ task: t, terminal: meta });
  } catch(e) { next(e); } });
  app.post('/api/tasks/:id/terminal/stop', (req, res, next) => { try {
    const t = service.require(req.params.id); if (!t.terminalId || !service.terminals) throw new ServiceError(404, '任务没有终端');
    if (service.active.has(t.id)) service.cancel(t.id); if (t.nativeSession) service.nativeSessions?.cancel(t.terminalId); else service.terminals.stop(t.terminalId); res.json({ ok: true });
  } catch(e) { next(e); } });
  app.get('/api/tasks/:id/events', (req, res, next) => { try {
    service.require(req.params.id);
    const after = z.coerce.number().int().min(0).default(0).parse(req.headers['last-event-id'] ?? req.query.after);
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
    const write = event => { if (service.cloudOnly && !['state', 'session-state'].includes(event.type)) return; return res.write(`id: ${event.seq}\nevent: update\ndata: ${JSON.stringify(event)}\n\n`); };
    service.store.events(req.params.id, after).forEach(write);
    service.bus.on(req.params.id, write);
    const timer = setInterval(() => res.write(': heartbeat\n\n'), 15000);
    req.on('close', () => { clearInterval(timer); service.bus.off(req.params.id, write); });
  } catch(e) { next(e); } });
  app.get(['/api/demo/documents/:id', '/api/local/documents/:id'], (req, res) => {
    if (service.cloudOnly) return res.status(410).json({ error: '报告仅通过飞书云文档查看' });
    const doc = service.store.document(req.params.id); if (!doc) return res.status(404).json({ error: '演示文档不存在' });
    const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const label = req.path.startsWith('/api/local/') ? '本地调研报告 · 未发布到飞书' : '本地演示文档 · 此页面不是飞书文档';
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${escape(doc.title)}</title><style>body{max-width:800px;margin:60px auto;padding:24px;font:16px/1.8 system-ui;white-space:pre-wrap}aside{color:#87651e;background:#fff7da;padding:16px}</style><aside>${label}</aside><h1>${escape(doc.title)}</h1>${escape(doc.markdown)}<h2>数据来源</h2>${escape(doc.sources.map(s => `${s.id} ${s.title}\n${s.url}\n${s.excerpt}`).join('\n\n'))}</html>`);
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在' }));
  if (existsSync(dist)) { app.use(express.static(dist)); app.get('*', (_req, res) => res.sendFile(resolve(dist, 'index.html'))); }
  app.use((err, _req, res, _next) => {
    const status = err instanceof z.ZodError ? 400 : err.status ?? 500;
    res.status(status).json({
      ...((typeof err.code==='string'&&/^(?:LIBRARY_|LARK_|FEISHU_)/.test(err.code)) ? { code: err.code } : {}),
      ...(err.recovery ? { recovery: err.recovery } : {}),
      ...(err.code==='FEISHU_TASKS_BUSY' ? {blockers:err.blockers} : {}),
      error: err instanceof z.ZodError ? err.issues.map(i => i.message).join('；') : status === 500 ? '服务内部异常，请稍后重试' : err.message,
    });
  });
  return app;
}
