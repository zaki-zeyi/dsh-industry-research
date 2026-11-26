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
