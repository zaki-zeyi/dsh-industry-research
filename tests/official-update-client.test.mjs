import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('detail update controls recheck after disable/enable and discard the previous context response', async () => {
  let loaded, oldResponse;
  const effects = [], registrations = [], disposers = [], calls = [];
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (subscribe, read) => { subscribe(() => {}); return read(); },
    useEffect: callback => effects.push(callback),
  };
  const state = { installedVersion: '1.0.0', runningVersion: '1.0.0', eligible: true, actionToken: 'context-token' };
  const fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET' });
    if (calls.length === 1) return new Promise(resolve => { oldResponse = () => resolve({ ok: true, json: async () => state }); });
    return { ok: true, json: async () => state };
  };
  runInNewContext(readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { loaded = value; } } }, fetch, setTimeout: () => 1, clearTimeout() {},
  });
  const plugin = loaded.factory(() => React);
  const ctx = { effect: callback => disposers.push(callback()), slots: {
    inject: (_name, callback) => callback(), register: (options, component) => registrations.push({ options, component }),
  } };
  function mount() {
    plugin.apply(ctx);
    const slot = registrations.find(row => row.options.name === 'plugins.detail.actions');
    assert.equal(slot.component({ subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }), null);
    const node = slot.component({ subject: { kind: 'bundle', pkg: { name: 'dsh-industry-research' } } });
    node.type(node.props); effects.splice(0).forEach(callback => callback());
  }
  mount(); assert.equal(calls.length, 1);
  disposers.splice(0).forEach(dispose => dispose());
  mount(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'Re-enabled context performs a fresh check');
  oldResponse(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.filter(call => call.method === 'POST').length, 1, 'Disposed context cannot submit its late request');
  disposers.splice(0).forEach(dispose => dispose());
});

test('workbench bridge accepts only its subscribed frame and keeps the host token private', async () => {
  let loaded, receive;
  const effects = [], slots = new Map(), requests = [], replies = [];
  const frameOrigin = 'http://127.0.0.1:4099';
  const frame = { postMessage: (message, origin) => replies.push({ message, origin }) };
  const state = { runningVersion: '0.13.28', installedVersion: '0.13.28', candidateVersion: '0.13.29', eligible: true, actionToken: 'host-only' };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: value => [value?.state === 'starting' ? { state: 'ready', url: frameOrigin } : value],
    useRef: value => ({ current: value }),
    useEffect: callback => effects.push(callback),
  };
  runInNewContext(readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { loaded = value; } }, location: { origin: 'dsh-app://app', protocol: 'dsh-app:' },
      addEventListener: (_event, callback) => { receive = callback; }, removeEventListener() {} },
    setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options = {}) => {
      if (options.method === 'POST') requests.push([url, options.headers['X-DSH-Update-Token']]);
      return { ok: true, json: async () => state };
    },
  });
  loaded.factory(() => React).apply({ slots: {
    inject: (_name, callback) => callback(), register: (options, component) => slots.set(options.name, component),
  } });
  const panel = slots.get('main')({});
  panel.children.find(node => node?.type === 'iframe').props.ref.current = { contentWindow: frame };
  const cleanup = effects[1]();
  const id = '12345678-1234-4234-8234-123456789abc';
  const send = (action, version, overrides) => receive({ origin: frameOrigin, source: frame,
    data: { type: 'industry-research:official-update', requestId: id, action, version }, ...overrides });
  await send('watch', null, { source: {} });
  await send('watch', null, { origin: 'http://127.0.0.1:1234' });
  await send('install', '0.13.29');
  assert.equal(replies.length, 0);
  await send('watch');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, [['/industry-research/official-update?action=check', 'host-only']]);
  assert.equal(replies.at(-1).message.state.label, '更新到 0.13.29');
  assert.equal(replies.at(-1).origin, frameOrigin);
  assert.ok(replies.every(({ message }) => !('actionToken' in message.state)));
  await send('install', '0.13.30');
  assert.equal(requests.length, 1, 'a stale target is not installed');
  await send('install', '0.13.29');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests.at(-1), ['/industry-research/official-update?action=install&version=0.13.29', 'host-only']);
  await send('unwatch');
  await send('install', '0.13.29');
  assert.equal(requests.length, 2);
  cleanup();
});

test('detail actions explain ineligible updates and keep install errors through status polling', async () => {
  let loaded;
  const effects = [], slots = new Map(), timers = [], actions = [];
  const wait = () => new Promise(resolve => setImmediate(resolve));
  const status = { candidateVersion: '0.13.21', eligible: false, actionToken: 'context-token', unavailableReason: '请从 DSH「插件 → 发现」安装固定 Git 提交的版本' };
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useSyncExternalStore: (subscribe, read) => { subscribe(() => {}); return read(); },
    useEffect: callback => effects.push(callback),
  };
  runInNewContext(readFileSync(new URL('../plugin/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load: value => { loaded = value; } } },
    setTimeout: poll => timers.push(poll), clearTimeout() {},
    fetch: async (url, options = {}) => {
      const action = new URL(url, 'http://localhost').searchParams.get('action');
      if (options.method === 'POST') actions.push(action);
      return action === 'install' ? { ok: false, json: async () => ({ error: '另一个更新正在执行' }) } :
        { ok: true, json: async () => ({ ...status }) };
    },
  });
  loaded.factory(() => React).apply({ slots: {
    inject: (_name, callback) => callback(), register: (options, component) => slots.set(options.name, component),
  } });
  const subject = { kind: 'bundle', pkg: { name: 'dsh-industry-research' } };
  const render = slot => { const node = slots.get(`plugins.detail.${slot}`)({ subject }); return node.type(node.props); };
  const detail = () => render('actions').children.filter(Boolean);
  const mount = () => effects.splice(0).forEach(callback => callback());
  detail(); mount(); await wait();
  assert.equal(detail()[0].children[0], '检查更新');
  assert.ok(detail().some(node => node.props.role === 'status' && node.children[0] === status.unavailableReason));
  assert.equal(render('badge'), null);
  await detail()[0].props.onClick();
  assert.deepEqual(actions, ['check', 'check']);

  status.eligible = true; status.unavailableReason = null;
  await timers.shift()();
  assert.equal(render('badge').children[0], '可更新');
  assert.equal(detail()[0].children[0], '更新到 0.13.21');
  await detail()[0].props.onClick();
  assert.equal(actions.at(-1), 'install');
  await timers.shift()();
  assert.ok(detail().some(node => node.props.role === 'alert' && node.children[0] === '另一个更新正在执行'));
  await detail()[1].props.onClick();
  assert.equal(actions.at(-1), 'check');
  assert.equal(detail().some(node => node.props.role === 'alert'), false);
});
