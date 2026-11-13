import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { WebSocket } from 'ws';
import { TerminalManager, attachTerminalWebSocket } from '../server/terminal.mjs';
import { CodexTerminalResearcher } from '../server/providers/codex-terminal.mjs';
import { AgentPublisher } from '../server/agent-delivery.mjs';
import { createApp } from '../server/app.mjs';
import { fixture, until } from './helpers.mjs';

async function setup() {
  const f = fixture();
  const manager = new TerminalManager(f.store, { command: process.execPath, prefixArgs: [resolve('tests/fixtures/fake-terminal.mjs')], workRoot: resolve(f.dir, 'pty'), settleMs: 180, pollMs: 20 });
  f.service.terminals = manager; f.service.mode = 'codex'; f.service.researcher = new CodexTerminalResearcher(manager); f.service.publisher = new AgentPublisher(f.store, manager); manager.onDelivery = (taskId, terminalId, delivery) => f.service.recordAgentDelivery(taskId, terminalId, delivery); manager.onSessionExit = (taskId, terminalId) => f.service.agentTerminalExited(taskId, terminalId);
  const server = createApp(f.service).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); const sockets = attachTerminalWebSocket(server, manager);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { ...f, manager, base, async close() { sockets.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); await f.service.close(); await manager.close(); await f.close(); } };
}
async function connect(f, id) {
  const frames = [], snapshots = [];
  const socket = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/terminals/${id}/ws`, { origin: f.base });
  socket.on('message', raw => { const m = JSON.parse(raw); if (m.type === 'snapshot') { snapshots.push(m); socket.send(JSON.stringify({ type: 'ready' })); } if (m.type === 'frame') frames.push(m.frame); });
  await until(() => snapshots.length); return { socket, frames, snapshots, send(data) { socket.send(JSON.stringify(data)); } };
}
test('AC-PTY-01 真实 PTY 原始 ANSI、键盘输入、尺寸同步、断线重连', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '原生终端双向验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const first = await connect(f, id); await until(() => first.frames.some(x => x.data?.includes('PTY_READY')));
    assert.ok(first.frames.some(x => x.data?.includes('\x1b[32m'))); first.send({ type: 'input', data: 'hello\r' }); await until(() => first.frames.some(x => x.data?.includes('INPUT:hello')));
    first.send({ type: 'resize', cols: 120, rows: 38 }); await until(() => f.manager.get(id).cols === 120); assert.equal(f.manager.get(id).rows, 38);
    first.socket.close(); await new Promise(r => first.socket.once('close', r)); assert.ok(f.manager.live.has(id));
    const second = await connect(f, id); assert.ok(second.snapshots[0].frames.some(x => x.data?.includes('INPUT:hello'))); assert.equal(f.manager.live.size, 1); second.socket.close();
  } finally { await f.close(); }
});
test('AC-PTY-02 报告文件交付完成后，原生终端仍接受继续输入', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '原生终端报告验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const client = await connect(f, id); await until(() => client.frames.some(x => x.data?.includes('PTY_READY'))); client.send({ type: 'input', data: 'REPORT\r' });
    await until(() => f.store.get(t.id).publication.status === 'not_requested'); assert.equal(f.store.get(t.id).report.title, '原生终端验收报告'); assert.ok(f.manager.live.has(id));
    await until(() => f.manager.get(id).activity === 'waiting_input');
    await delay(250); assert.ok(!client.frames.some(x => x.data?.includes('TURN_INTERRUPTED')));
    client.send({ type: 'input', data: 'continue\r' }); await until(() => client.frames.some(x => x.data?.includes('INPUT:continue')));
    await until(() => f.manager.get(id).activity === 'waiting_input'); assert.equal(f.manager.get(id).status, 'running'); client.socket.close();
  } finally { await f.close(); }
});
test('AC-PTY-03 跨站 WebSocket 被拒绝，禁止跨站控制本机 CLI', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '终端来源校验' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const status = await new Promise((resolve, reject) => { const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}/api/terminals/${id}/ws`, { origin: 'https://evil.example' }); ws.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode); }); ws.on('error', reject); });
    assert.equal(status, 403); assert.equal(f.manager.live.size, 0);
  } finally { await f.close(); }
});
test('AC-PTY-04 终端中断后重试使用新的报告文件，保留旧终端记录', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '终端重试报告验收' }); await until(() => f.store.get(t.id).terminalId); const old = f.store.get(t.id).terminalId;
    const first = await connect(f, old); await until(() => first.frames.some(x => x.data?.includes('PTY_READY'))); f.service.cancel(t.id); await until(() => !f.service.active.size && !f.manager.live.has(old)); first.socket.close();
    f.service.retry(t.id, 'research'); await until(() => f.store.get(t.id).terminalId !== old); const current = f.store.get(t.id).terminalId;
    assert.notEqual(f.manager.get(old).reportPath, f.manager.get(current).reportPath);
    const second = await connect(f, current); await until(() => second.frames.some(x => x.data?.includes('PTY_READY'))); second.send({ type: 'input', data: 'REPORT\r' });
    await until(() => f.store.get(t.id).publication.status === 'not_requested'); assert.equal(f.store.get(t.id).runs.length, 2); assert.ok(f.store.terminalFrames(old).some(x => x.data?.includes('PTY_READY'))); second.socket.close();
  } finally { await f.close(); }
});

test('AC-PTY-05 报告后仍重复工作时仅中断本轮，保留连接并可继续新要求', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '重复调研收尾验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const client = await connect(f, id); await until(() => client.frames.some(x => x.data?.includes('PTY_READY')));
    client.send({ type: 'input', data: 'REPEAT_REPORT\r' });
    await until(() => client.frames.some(x => x.data?.includes('TURN_INTERRUPTED')));
    assert.ok(f.store.get(t.id).report); assert.equal(f.manager.get(id).status, 'running'); assert.equal(f.manager.get(id).activity, 'waiting_input');
    const count = () => client.frames.map(x => x.data ?? '').join('').split('AUTO_RESEARCH').length;
    const stopped = count(); await delay(250); assert.equal(count(), stopped);
    client.socket.close(); await new Promise(r => client.socket.once('close', r));
    const resumed = await connect(f, id); assert.equal(resumed.snapshots[0].meta.activity, 'waiting_input'); assert.equal(f.manager.live.size, 1);
    resumed.send({ type: 'input', data: 'continue\r' }); await until(() => resumed.frames.some(x => x.data?.includes('INPUT:continue')));
    await until(() => f.manager.get(id).activity === 'waiting_input'); assert.equal(f.store.get(t.id).runs.length, 1);
    assert.equal(f.store.terminalFrames(id).filter(x => x.data?.includes('TURN_INTERRUPTED')).length, 1); resumed.socket.close();
  } finally { await f.close(); }
});
test('AC-PTY-06 用户新输入取消收尾计时，旧轮次回调不能覆盖新任务状态', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '收尾竞态验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const client = await connect(f, id); await until(() => client.frames.some(x => x.data?.includes('PTY_READY')));
    f.manager.finishResearch(id); assert.equal(f.manager.get(id).activity, 'finishing');
    f.manager.input(id, '\x1b[1;1R'); assert.ok(f.manager.finishTimers.has(id), '设备响应不能取消收尾');
    f.manager.input(id, 'new request\r'); assert.equal(f.manager.get(id).activity, 'working');
    writeFileSync(f.manager.get(id).completionPath, JSON.stringify({ type: 'turn-complete', turnId: 'old', at: new Date(Date.now() - 1000).toISOString() }));
    await delay(300); assert.equal(f.manager.get(id).activity, 'working'); assert.equal(f.manager.get(id).status, 'running');
    assert.ok(!client.frames.some(x => x.data?.includes('TURN_INTERRUPTED'))); client.socket.close();
  } finally { await f.close(); }
});

test('AC-PTY-07 报告只生成不上传，点击后转交原终端，重复请求不重复发送', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '延迟上传验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const initial = readFileSync(f.manager.get(id).promptPath, 'utf8'); assert.match(initial, /只生成报告/); assert.ok(!initial.includes('auth login'));
    const c = await connect(f, id); await until(() => c.frames.some(x => x.data?.includes('PTY_READY'))); c.send({ type: 'input', data: 'REPORT\r' });
    await until(() => !f.service.active.size && f.store.get(t.id).report && f.manager.get(id).activity === 'waiting_input');
    const before = f.store.get(t.id); assert.equal(before.publication.status, 'not_requested');
    const cwd = f.manager.get(id).cwd; assert.ok(!f.store.terminalFrames(id).some(x => x.data?.includes('UPLOAD_PROMPT_RECEIVED')));
    const first = f.service.publishToFeishu(t.id); const again = f.service.publishToFeishu(t.id); assert.equal(first.publication.requestId, again.publication.requestId);
    await until(() => c.frames.some(x => x.data?.includes('UPLOAD_PROMPT_RECEIVED'))); assert.equal(JSON.parse(readFileSync(resolve(cwd, 'upload-count.json'))), 1);
    const meta = f.manager.get(id); const prompt = readFileSync(resolve(cwd, `upload-prompt-${first.publication.requestId}.txt`), 'utf8');
    assert.match(prompt, /只保存已经完成的报告/); assert.match(prompt, /lark-cli auth qrcode/); assert.match(prompt, /--parent-token/);
    writeFileSync(meta.deliveryPath, JSON.stringify({ status: 'published', url: 'https://example.feishu.cn/docx/old', requestId: '12345678-1234-4234-8234-123456789abc' }));
    await delay(100); assert.equal(f.store.get(t.id).publication.status, 'publishing');
    c.send({ type: 'input', data: 'UPLOAD\r' }); await until(() => f.store.get(t.id).publication.status === 'published');
    const after = f.store.get(t.id); assert.deepEqual(after.report, before.report); assert.equal(after.runs.length, 1); assert.equal(after.terminalId, id);
    assert.ok(f.manager.live.has(id)); c.socket.close();
  } finally { await f.close(); }
});
test('AC-PTY-08 点击上传后 Agent 回传二维码，授权后仅保存现有报告', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: 'Agent 扫码授权回执' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const c = await connect(f, id); await until(() => c.frames.some(x => x.data?.includes('PTY_READY'))); c.send({ type: 'input', data: 'REPORT\r' });
    await until(() => !f.service.active.size && f.store.get(t.id).report && f.manager.get(id).activity === 'waiting_input');
    f.service.publishToFeishu(t.id); await until(() => f.store.get(t.id).publication.status === 'awaiting_authorization'); const before = f.store.get(t.id);
    const qr = await fetch(`${f.base}/api/tasks/${t.id}/agent-qr`); assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type'), /image\/png/); assert.equal(qr.headers.get('cache-control'), 'no-store');
    c.socket.close(); await new Promise(r => c.socket.once('close', r)); const resumed = await connect(f, id);
    resumed.send({ type: 'input', data: 'AUTHORIZED\r' }); await until(() => f.store.get(t.id).publication.status === 'published');
    assert.deepEqual(f.store.get(t.id).report, before.report); assert.equal(f.store.get(t.id).runs.length, 1); assert.ok(f.manager.live.has(id));
    assert.equal((await fetch(`${f.base}/api/tasks/${t.id}/agent-qr`)).status, 404); resumed.socket.close();
  } finally { await f.close(); }
});
test('AC-PTY-09 上传中终端退出显示失败，重试恢复原 Session 并保留报告', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '延迟交付中断恢复' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const c = await connect(f, id); await until(() => c.frames.some(x => x.data?.includes('PTY_READY'))); c.send({ type: 'input', data: 'REPORT\r' });
    await until(() => !f.service.active.size && f.store.get(t.id).report && f.manager.get(id).activity === 'waiting_input'); const report = f.store.get(t.id).report;
    f.service.publishToFeishu(t.id); await until(() => c.frames.some(x => x.data?.includes('UPLOAD_PROMPT_RECEIVED')));
    c.send({ type: 'input', data: '\x03' }); await until(() => f.store.get(t.id).publication.status === 'failed'); c.socket.close();
    const previous = f.manager.get(id); previous.sessionId = '12345678-1234-4234-8234-123456789abc'; f.store.saveTerminal(previous);
    const queued = f.service.publishToFeishu(t.id); assert.notEqual(queued.terminalId, id); const next = await connect(f, queued.terminalId);
    await until(() => next.frames.some(x => x.data?.includes('UPLOAD_PROMPT_RECEIVED')));
    const meta = f.manager.get(queued.terminalId); const args = JSON.parse(readFileSync(resolve(meta.cwd, 'spawn-args.json')));
    assert.equal(args[args.indexOf('resume') + 1], previous.sessionId); assert.ok(args.at(-1).includes('用户上传要求'));
    assert.equal(next.frames.find(x => x.type === 'status' && x.status === 'running').activity, 'working');
    next.send({ type: 'input', data: 'UPLOAD\r' }); await until(() => f.store.get(t.id).publication.status === 'published');
    assert.deepEqual(f.store.get(t.id).report, report); assert.equal(f.store.get(t.id).runs.length, 1); next.socket.close();
  } finally { await f.close(); }
});

test('AC-PTY-10 新建 Codex 会话默认完整访问，实际启动参数与前端回传一致', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '默认完整权限验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const c = await connect(f, id); await until(() => c.frames.some(x => x.data?.includes('PTY_READY')));
    const meta = f.manager.get(id); const args = JSON.parse(readFileSync(resolve(meta.cwd, 'spawn-args.json'), 'utf8'));
    assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access'); assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'on-request');
    assert.deepEqual(meta.permissions, { sandbox: 'danger-full-access', approval: 'on-request' });
    assert.deepEqual(c.frames.find(x => x.type === 'status' && x.status === 'running').permissions, meta.permissions);
    const config = await (await fetch(`${f.base}/api/config`)).json(); assert.deepEqual(config.terminalPermissions, meta.permissions);
    assert.ok(args.includes('--search')); assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    const pid = f.manager.live.get(id).pid; c.socket.close(); await new Promise(r => c.socket.once('close', r));
    const next = await connect(f, id); assert.deepEqual(next.snapshots[0].meta.permissions, meta.permissions); assert.equal(f.manager.live.get(id).pid, pid); next.socket.close();
  } finally { await f.close(); }
});
test('AC-PTY-11 恢复历史会话的新进程也采用完整访问，保留会话 ID 且不重发调研 Prompt', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '恢复完整权限验收' }); await until(() => f.store.get(t.id).terminalId); const oldId = f.store.get(t.id).terminalId;
    const first = await connect(f, oldId); await until(() => first.frames.some(x => x.data?.includes('PTY_READY')));
    f.service.cancel(t.id); await until(() => !f.service.active.size && !f.manager.live.has(oldId)); first.socket.close();
    const sessionId = '12345678-1234-4234-8234-123456789abc'; const previous = f.manager.get(oldId); previous.sessionId = sessionId; previous.permissions = { sandbox: 'workspace-write', approval: 'on-request' }; f.store.saveTerminal(previous);
    const r = await fetch(`${f.base}/api/tasks/${t.id}/terminal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 200);
    const { terminal: meta } = await r.json(); const current = await connect(f, meta.id); await until(() => current.frames.some(x => x.data?.includes('PTY_READY')));
    const args = JSON.parse(readFileSync(resolve(meta.cwd, 'spawn-args.json'), 'utf8'));
    assert.equal(args[args.indexOf('resume') + 1], sessionId); assert.equal(args[args.indexOf('--sandbox') + 1], 'danger-full-access');
    assert.ok(!args.some(x => x.startsWith('请读取 '))); assert.equal(f.store.get(t.id).runs.length, 1); assert.equal(f.manager.get(oldId).permissions.sandbox, 'workspace-write');
    current.socket.close();
  } finally { await f.close(); }
});

test('AC-PTY-12 无报告或终端忙碌时拒绝上传，未点击前不接受伪造上传回执', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '上传操作边界验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    assert.throws(() => f.service.publishToFeishu(t.id), /报告尚未生成/);
    const c = await connect(f, id); await until(() => c.frames.some(x => x.data?.includes('PTY_READY'))); c.send({ type: 'input', data: 'REPORT\r' });
    await until(() => !f.service.active.size && f.store.get(t.id).report && f.manager.get(id).activity === 'waiting_input');
    writeFileSync(f.manager.get(id).deliveryPath, JSON.stringify({ status: 'published', url: 'https://example.feishu.cn/docx/unrequested' }));
    await delay(80); assert.equal(f.store.get(t.id).publication.status, 'not_requested');
    c.send({ type: 'input', data: 'new work\r' }); await until(() => f.manager.get(id).activity === 'working');
    assert.throws(() => f.service.publishToFeishu(t.id), /处理其他要求/); assert.equal(f.store.get(t.id).publication.status, 'not_requested'); assert.equal(f.store.get(t.id).runs.length, 1); c.socket.close();
  } finally { await f.close(); }
});
test('AC-PTY-13 恢复上传时 Codex 启动失败可见，报告仍可重试交付', async () => {
  const f = await setup(); try {
    const t = f.service.create({ direction: '上传进程启动失败验收' }); await until(() => f.store.get(t.id).terminalId); const id = f.store.get(t.id).terminalId;
    const c = await connect(f, id); await until(() => c.frames.some(x => x.data?.includes('PTY_READY'))); c.send({ type: 'input', data: 'REPORT\r' });
    await until(() => !f.service.active.size && f.store.get(t.id).report && f.manager.get(id).activity === 'waiting_input'); const report = f.store.get(t.id).report;
    f.manager.stop(id); await until(() => !f.manager.live.has(id)); c.socket.close();
    f.manager.config.command = '/does-not-exist/codex-test'; const queued = f.service.publishToFeishu(t.id);
    const next = await connect(f, queued.terminalId); await until(() => f.store.get(t.id).publication.status === 'failed');
    assert.ok(['failed', 'exited'].includes(f.manager.get(queued.terminalId).status)); assert.deepEqual(f.store.get(t.id).report, report); assert.equal(f.store.get(t.id).runs.length, 1); next.socket.close();
  } finally { await f.close(); }
});
