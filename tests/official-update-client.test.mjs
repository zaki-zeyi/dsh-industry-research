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
