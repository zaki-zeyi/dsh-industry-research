import {BriefingNotifications} from './briefing-notifications.mjs';
import { InternalMaterialNotifications } from './internal-notifications.mjs';
import { BriefingSchedules } from './briefings.mjs';
import { resolve } from 'node:path';
import { FeishuBinding } from './feishu-binding.mjs';
import { AISettings } from './ai-settings.mjs';
import { NativeSessions, NativeResearcher } from './native-sessions.mjs';
import { Store } from './store.mjs';
import { ResearchService } from './service.mjs';
import { createApp } from './app.mjs';
import { DemoResearcher } from './providers/demo.mjs';
import { HarnessResearcher } from './providers/harness.mjs';
import { CodexTerminalResearcher } from './providers/codex-terminal.mjs';
import { TerminalManager, attachTerminalWebSocket } from './terminal.mjs';
import { DemoPublisher } from './providers/publisher.mjs';
import { AgentPublisher } from './agent-delivery.mjs';
import { createServer } from 'node:http';
import { mkdirSync, openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export function dataIdentity(path) { return createHash('sha256').update(resolve(path)).digest('hex'); }
export async function startRuntime({ env = process.env, port = Number(env.PORT ?? 3088), dataDir = resolve(env.DATA_DIR ?? './data'), dist = fileURLToPath(new URL('../dist', import.meta.url)), host, binding, libraryRun } = {}) {
  dataDir = resolve(dataDir);
  mkdirSync(dataDir, { recursive: true });
  const lock = resolve(dataDir, '.runtime.lock');
  let fd;
  try { fd = openSync(lock, 'wx'); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(readFileSync(lock, 'utf8'));
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { unlinkSync(lock); fd = openSync(lock, 'wx'); } else throw e; }
    if (fd === undefined) throw new Error('调研数据库已由其他服务使用，请连接原服务');
  }
  writeFileSync(fd, String(process.pid)); closeSync(fd);
  const server = createServer();
  let store, terminals, service, terminalSockets, nativeSessions;
  const release = () => { try { unlinkSync(lock); } catch {} };
  try {
    await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
    const mode = env.RESEARCH_MODE ?? 'codex';
    if (!['demo', 'live', 'codex', 'native'].includes(mode)) throw new Error('RESEARCH_MODE 只能是 demo、live、codex 或 native');
    store = new Store(resolve(dataDir, 'research.sqlite'));
    const aiSettings = new AISettings(dataDir);
    terminals = new TerminalManager(store, { aiSettings, dshCommand: env.DSH_COMMAND, command: env.CODEX_COMMAND, workRoot: env.CODEX_WORK_ROOT ?? resolve(dataDir, 'codex'), model: env.CODEX_MODEL });
    if (mode === 'native') { if (!host?.sessionController || !host?.permissionPresets) throw new Error('原生会话模式需要在宿主 DSH 插件中运行'); nativeSessions = new NativeSessions(store, host, { workRoot: resolve(dataDir, 'sessions') }); }
    const researcher = mode === 'native' ? new NativeResearcher(nativeSessions, { legacy: new CodexTerminalResearcher(terminals) }) : mode === 'codex' ? new CodexTerminalResearcher(terminals, { timeoutMs: Number(env.CODEX_TIMEOUT_MS ?? 600000) }) : mode === 'demo' ? new DemoResearcher() : new HarnessResearcher({ command: env.HARNESS_COMMAND, args: env.HARNESS_ARGS ? JSON.parse(env.HARNESS_ARGS) : undefined, home: env.HARNESS_HOME, provider: env.HARNESS_PROVIDER, model: env.HARNESS_MODEL, timeoutMs: Number(env.HARNESS_TIMEOUT_MS ?? 600000) });
    const publisher = mode === 'demo' ? new DemoPublisher(store) : new AgentPublisher(store, terminals);
    service = new ResearchService(store, researcher, publisher, { mode });
    service.cloudOnly = mode === 'native'; service.binding = binding ?? new FeishuBinding({ command: env.LARK_CLI_COMMAND, store });
    terminals.onDelivery = (id, terminalId, receipt) => service.recordAgentDelivery(id, terminalId, receipt);
    terminals.onSessionExit = (id, terminalId) => service.agentTerminalExited(id, terminalId);
    service.terminals = terminals; service.aiSettings = aiSettings; service.nativeSessions = nativeSessions;
    if (nativeSessions) { nativeSessions.onDelivery = (id, binding, receipt) => service.recordAgentDelivery(id, binding, receipt); nativeSessions.onActivity = id => { if(!service.active.has(id))service.cloudWrites.release(id); if (store.get(id)) service.event(id, 'session-state', { sessionId: service.require(id).nativeSessionId }); }; }
    service.briefingSchedules = new BriefingSchedules(service, host, `http://127.0.0.1:${server.address().port}`);
    service.notifications = new BriefingNotifications(service);
    service.internalNotifications = new InternalMaterialNotifications(service);
    if (nativeSessions) await nativeSessions.reconcileWorkspace();
    store.runtimeLog('runtime.started',{status:'ready',phase:service.mode});
    service.recover();
    if (service.briefingSchedules) void service.briefingSchedules.catchUpMissed().catch(() => {});

    server.on('request', createApp(service, { dist, libraryRun, health: { application: 'industry-research', dataIdentity: dataIdentity(dataDir), transport: researcher.transport ?? 'json' } }));
    terminalSockets = attachTerminalWebSocket(server, terminals);
  } catch (error) {
    server.close(); await service?.close(); service?.binding?.close(); await terminals?.close(); nativeSessions?.close(); store?.close(); release(); throw error;
  }
  let closing;
  return { server, service, url: `http://127.0.0.1:${server.address().port}`, close() {
    return closing ??= (async () => { terminalSockets.close(); server.close(); server.closeAllConnections(); await service.close(); service.binding?.close(); await terminals.close(); nativeSessions?.close(); store.close(); release(); })();
  } };
}
