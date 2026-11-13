import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
export const report = { title: '宿主原生会话报告', summary: '这是来自 DSH 宿主原生会话的完整调研报告摘要。', markdown: '本报告来自宿主原生会话，在相同会话中执行调研并输出结构化文件；正文包含可追溯的数据来源和对应引用，便于用户继续追问和保存。[S1]', sources: [{ id: 'S1', title: '测试来源', url: 'https://example.com/native', excerpt: '这是宿主会话验收所使用的模拟来源摘录。' }] };
export function mockHost({ failFirst = false, noReport = false, defaultPreset = 'cordis' } = {}) {
  const bus = new EventEmitter(), calls = [], permissions = [], modes = new Map(); let created = 0, prompts = 0;
  const workspaces = new Map(), sessionCwds = new Map();
  const host = {
    sessionCwds,
    workspaceRegistry: {
      async create(path,title) {
        const prior=[...workspaces.values()].find(w=>w.path===path);if(prior)return prior;
        const w={id:'workspace-'+(workspaces.size+1),path,title,sessionIds:[],async setTitle(value){this.title=value;},async attachSession(id){if(sessionCwds.get(id)!==path)throw new Error('cwd mismatch');if(!this.sessionIds.includes(id))this.sessionIds.push(id);}};workspaces.set(w.id,w);return w;
      },
      get(id){return workspaces.get(id);},list(){return [...workspaces.values()];},
    },
    calls, permissions, modes, defaultPreset, get created() { return created; },
    on(name, fn) { bus.on(name, fn); return () => bus.off(name, fn); },
    emit(id, type, reason) { bus.emit('session/event', { id }, { type, data: { reason } }); },
    permissionPresets: { set(session, name) { permissions.push({ sessionId: session.id, name }); } },
    sessionController: {
      async create({ cwd, workspaceId, agentPreset }) { const selected = agentPreset ?? defaultPreset, sessionId = `native-session-${++created}`; if(cwd!==undefined&&workspaceId!==undefined)throw new Error('workspaceId and cwd are exclusive');const workspace=workspaceId?workspaces.get(workspaceId):null;if(workspaceId&&!workspace)throw new Error('workspace not found');sessionCwds.set(sessionId,workspace?.path??cwd);if(workspace)await workspace.attachSession(sessionId);calls.push({ kind: 'create', cwd, workspaceId, agentPreset }); modes.set(sessionId, selected); return { sessionId, agentPreset: selected }; },
      async resolveAgent(id) { return { agent: { session: { id } } }; },
      async prompt(request) {
        calls.push({ kind: 'prompt', ...request }); prompts++; host.emit(request.sessionId, 'turn/start');
        const promptPath = /请读取 (.+)，按照/.exec(request.content[0].text)?.[1];
        const content = promptPath ? readFileSync(promptPath, 'utf8') : request.content[0].text;
        if (failFirst && prompts === 1) { host.emit(request.sessionId, 'turn/end', { kind: 'error', error: { code: 'INVALID_CREDENTIAL', message: 'secret must never propagate' } }); return { accepted: true }; }
        if(content.includes('并行调研与保存锁')&&promptPath&&existsSync(resolve(promptPath,'..','cloud-write-config.json')))await promisify(execFile)(process.execPath,[resolve(promptPath,'..','cloud-write-client.mjs'),resolve(promptPath,'..','cloud-write-config.json')]);
        if (content.includes('本次报告仅存储在飞书云文档')) {
          if (!noReport) { const path = /原子更新 (.+)，本次 requestId/.exec(content)[1], requestId = /本次 requestId 固定为 ([a-f0-9-]+)/.exec(content)[1]; writeFileSync(path, JSON.stringify({ requestId, status: 'published', folderToken: /目标文件夹 ID：([A-Za-z0-9_-]+)/.exec(content)?.[1] ?? 'autoFolder123', url: 'https://example.feishu.cn/docx/cloudReport123' })); }
        } else if (content.includes('本次只保存已经完成的报告')) {
          const path = /原子更新 (.+)，本次 requestId/.exec(content)[1], requestId = /本次 requestId 固定为 ([a-f0-9-]+)/.exec(content)[1];
          writeFileSync(path, JSON.stringify({ requestId, status: 'awaiting_authorization', authorizationUrl: 'https://accounts.feishu.cn/device?code=native-test', expiresAt: '2099-01-01T00:00:00+08:00' }));
          const meta = /相对 PNG 文件 ([^。]+)。/.exec(content); if (meta) writeFileSync(resolve(promptPath, '..', meta[1]), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGQAAAABJRU5ErkJggg==', 'base64'));
        } else if (!promptPath && content.includes('已授权')) {
          const previous = calls.filter(x => x.kind === 'prompt').at(-2), path = /请读取 (.+)，按照/.exec(previous.content[0].text)[1], upload = readFileSync(path, 'utf8');
          writeFileSync(/原子更新 (.+)，本次 requestId/.exec(upload)[1], JSON.stringify({ requestId: /本次 requestId 固定为 ([a-f0-9-]+)/.exec(upload)[1], status: 'published', url: 'https://example.feishu.cn/docx/nativeReport123' }));
        } else if (!noReport) { const path = /完整报告 JSON 保存到 (.+)。本轮/.exec(content)?.[1]; if (path) writeFileSync(path, JSON.stringify(report)); }
        host.emit(request.sessionId, 'turn/end', { kind: 'completed' }); return { accepted: true };
      },
      cancel({ sessionId }) { calls.push({ kind: 'cancel', sessionId }); host.emit(sessionId, 'turn/end', { kind: 'cancelled' }); return { accepted: true }; },
    },
  };
  return host;
}
