import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { startRuntime } from '../server/runtime.mjs';
import { connectRuntime, apply } from '../plugin/index.mjs';

function temp(t) { const dir = mkdtempSync(resolve(tmpdir(), 'dsh-research-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
test('dsh 插件启动服务、复用同库服务，借用者退出不关闭原服务', async t => {
  const dataDir = temp(t);
  const owner = await connectRuntime({ dataDir, port: 0, mode: 'demo' }); t.after(() => owner.close());
  assert.equal(owner.owned, true);
  const port = Number(new URL(owner.url).port);
  const borrowed = await connectRuntime({ dataDir, port });
  assert.equal(borrowed.owned, false); await borrowed.close();
  const health = await (await fetch(`${owner.url}/api/health`)).json();
  assert.equal(health.application, 'industry-research');
  await assert.rejects(connectRuntime({ dataDir: temp(t), port }), /其他服务或其他调研数据库/);
  await assert.rejects(startRuntime({ dataDir, port: 0, env: { RESEARCH_MODE: 'demo' } }), /数据库已由/);
  await owner.close();
  const restarted = await connectRuntime({ dataDir, port: 0, mode: 'demo' }); await restarted.close();
});
test('插件卸载注销路由并关闭自身服务，初始化期间卸载也不泄漏服务', async t => {
  for (const early of [false, true]) {
    const cleanups = []; let route;
    const ctx = { effect(fn) { cleanups.push(fn()); }, webServer: { register(value) { if (value.path === '/industry-research/status') route = value; return () => { if (route === value) route = null; }; } } };
    const dataDir = temp(t);
    apply(ctx, { dataDir, port: 0, mode: 'demo' });
    const status = () => { let body; route.handler({}, { setHeader() {}, end(value) { body = JSON.parse(value); } }); return body; };
    let url;
    if (!early) {
      for (let i = 0; i < 100 && status().state === 'starting'; i++) await new Promise(r => setTimeout(r, 10));
      assert.equal(status().state, 'ready'); url = status().url;
    }
    for (const cleanup of cleanups.reverse()) await cleanup();
    assert.equal(route, null);
    if (url) await assert.rejects(fetch(`${url}/api/health`));
    const next = await connectRuntime({ dataDir, port: 0, mode: 'demo' }); await next.close();
  }
});
test('浏览器插件使用真实 dsh 模块协议，侧栏入口与主面板 key 对应', () => {
  let loaded;
  runInNewContext(readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8'), { window: { __ModuleLoader__: { load(value) { loaded = value; } } } });
  assert.equal(loaded.id, 'dsh-industry-research');
  const client = loaded.factory(() => ({ createElement() {} }));
  const rows = []; client.apply({ slots: { inject(_name, fn) { fn(); }, register(options, component) { rows.push({ options, component }); } } });
  assert.equal(rows.find(r => r.options.name === 'main').options.key, rows.find(r => r.options.name === 'sidebar.panellist').options.id);
});


test('无端口配置安装后自动启动，不依赖开发项目目录或固定端口', async t => {
  const runtime = await connectRuntime({ dataDir: temp(t), mode: 'demo' });
  try {
    assert.ok(Number(new URL(runtime.url).port) > 0);
    const response = await fetch(`${runtime.url}/api/health`);
    assert.equal(response.status, 200);
  } finally { await runtime.close(); }
});

function embeddedClientFixture({ wait } = {}) {
  let loaded, receive, position = 0, fetches = 0; const hooks = [], effects = [], replies = [], retained = [], released = [];
  const taskId = 'b3490d6c-98ac-4774-9dcb-95ed0cc9e523', frameWindow = { postMessage(value, origin) { replies.push({ value, origin }); } };
  const React = {
    createElement(type, props, ...children) { return { type, props: props ?? {}, children }; },
    useState(initial) { const at = position++; if (!(at in hooks)) hooks[at] = initial?.state === 'starting' ? { state: 'ready', url: 'http://127.0.0.1:4000' } : initial; return [hooks[at], value => { hooks[at] = typeof value === 'function' ? value(hooks[at]) : value; }]; },
    useRef(value) { const at = position++; if (!(at in hooks)) hooks[at] = { current: value }; return hooks[at]; },
    useEffect(fn) { effects.push(fn); },
  };
  const window = { location: { origin: 'http://127.0.0.1:3090', protocol: 'http:' }, __ModuleLoader__: { load(value) { loaded = value; } }, addEventListener(name, fn) { if (name === 'message') receive = fn; }, removeEventListener() {} };
  runInNewContext(readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8'), { window, Intl, fetch: async path => { fetches++; assert.ok(path.startsWith('/industry-research/session?taskId=')); return { ok: true, json: async () => ({ taskId, sessionId: 'host-native-session', direction: '测试方向', reportReady: true }) }; }, AbortController });
  const rows = [], client = loaded.factory(() => React);
  client.apply({ sessions: { retain(id, options) { retained.push({ id, source: options.source }); return { sessionId: id, ready: wait ?? Promise.resolve(), release() { released.push(id); } }; } }, slots: { inject(_name, fn) { fn(); }, register(options, component) { rows.push({ options, component }); } } });
  const panel = rows.find(x => x.options.name === 'main').component;
  const render = () => { position = 0; effects.length = 0; return panel({ SessionProvider() {}, renderSlot() { return 'native-conversation-factory'; } }); };
  const tree = render(); tree.children[0].props.ref.current = { contentWindow: frameWindow }; const dispose = effects[1]();
  const send = (data, origin = 'http://127.0.0.1:4000', source = frameWindow) => receive({ origin, source, data });
  return { taskId, render, send, dispose, replies, retained, released, get fetches() { return fetches; } };
}

test('PRD1511 内嵌原生会话校验来源并保留工作台，切换报告释放引用而不关闭宿主会话', async () => {
  const f = embeddedClientFixture(), data = { type: 'industry-research:embed-session', taskId: f.taskId, requestId: 'embed-1' };
  await f.send(data, 'https://evil.example'); await f.send(data, undefined, {}); assert.equal(f.fetches, 0);
  await f.send(data); assert.equal(f.retained.length, 1); assert.equal(f.retained[0].id, 'host-native-session');
  const tree = f.render(); assert.equal(tree.children[0].props.style.display, 'none'); assert.equal(tree.children[1].props['aria-label'], '行研工作台原生对话');
  const buttons = []; const visit = node => { if (!node || typeof node !== 'object') return; if (node.type === 'button') buttons.push(node); for (const child of node.children ?? []) visit(child); }; visit(tree);
  buttons.find(x => x.children[0] === '调研报告').props.onClick();
  assert.equal(f.released.length, 1); assert.equal(f.render().children[0].props.style.display, 'block'); assert.equal(f.replies.at(-1).value.type, 'industry-research:show-report');
  f.dispose();
});

test('PRD1511 离开对话时使待加载引用失效，迟到的会话不得覆盖报告页', async () => {
  let ready; const wait = new Promise(r => { ready = r; }), f = embeddedClientFixture({ wait });
  const data = { type: 'industry-research:embed-session', taskId: f.taskId, requestId: 'embed-pending' }, opening = f.send(data);
  await new Promise(r => setTimeout(r, 0)); assert.equal(f.retained.length, 1);
  await f.send({ type: 'industry-research:hide-session', taskId: f.taskId, requestId: data.requestId }); assert.equal(f.released.length, 1, '加载中离开也要立即释放引用'); ready(); await opening;
  assert.equal(f.released.length, 1); assert.equal(f.render().children[0].props.style.display, 'block'); assert.equal(f.replies.some(x => x.value.ok === true), false); f.dispose();
});

test('PRD1511 插件卸载只释放客户端会话引用，不发起新的调研或取消宿主Agent', async () => {
  const f = embeddedClientFixture(); await f.send({ type: 'industry-research:embed-session', taskId: f.taskId, requestId: 'embed-dispose' });
  f.dispose(); assert.equal(f.released.length, 1); assert.equal(f.retained.length, 1);
});

test('PRD1567 对话页返回工作台首页并释放引用，保持iframe和宿主会话', async () => {
  const f = embeddedClientFixture(); await f.send({ type: 'industry-research:embed-session', taskId: f.taskId, requestId: 'back-dashboard' });
  const buttons = []; const visit = node => { if (!node || typeof node !== 'object') return; if (node.type === 'button') buttons.push(node); for (const child of node.children ?? []) visit(child); }; visit(f.render());
  const back = buttons.find(x => x.children.includes('返回')); assert.ok(back); back.props.onClick();
  assert.equal(f.replies.at(-1).value.taskId, ''); assert.equal(f.replies.at(-1).value.type, 'industry-research:show-report'); assert.equal(f.released.length, 1); assert.equal(f.render().children[0].props.style.display, 'block'); f.dispose();
});
