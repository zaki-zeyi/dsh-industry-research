import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { FeishuBinding } from '../server/feishu-binding.mjs';
import { applicationRunner, registrationRunner } from './fixtures/fake-feishu-application.mjs';
import { createApp } from '../server/app.mjs';

function setup() {
  const f = fixture(), cli = applicationRunner(), sdk = registrationRunner();
  const binding = new FeishuBinding({ store: f.store, run: cli.run, registerApp: sdk.registerApp });
  f.service.binding = binding;
  return { ...f, cli, sdk, binding, async close() { binding.close(); await f.close(); } };
}

test('release 基线：扫码保存新应用后，只有完成个人授权才允许启动调研', async () => {
  const f = setup();
  try {
    f.binding.registration.start(); f.sdk.approve('cli_release123');
    await f.binding.registration.work;
    assert.equal(f.binding.registration.snapshot().status, 'completed');
    const application = f.binding.applicationSnapshot();
    assert.equal(application.appId, 'cli_release123');
    await assert.rejects(f.binding.requireBound(), e => e.status === 428);
    const flow = await f.binding.start();
    assert.ok(flow.authorizationUrl);
    assert.equal((await f.binding.complete(flow.flowId)).bound, true);
    assert.equal((await f.binding.requireBound()).bound, true);
    const write = f.cli.calls.find(c => c.args[0] === 'profile' && c.args[1] === 'add');
    assert.equal(write.options.input, 'fixture-secret\n');
    assert.ok(!JSON.stringify(application).includes('fixture-secret'));
    assert.equal((await f.binding.status({ mode: 'default' })).userName, '默认用户');
  } finally { await f.close(); }
});

test('release 修复：取消未完成扫码不修改原应用；重复 App ID 更新已有profile', async () => {
  const f = setup();
  try {
    await f.binding.configureApplication({ mode: 'custom', appId: 'cli_existing123', appSecret: 'fixture-secret' });
    const before = f.binding.applicationSnapshot();
    f.binding.registration.start(); f.binding.registration.cancel();
    await f.binding.registration.work;
    assert.deepEqual(f.binding.applicationSnapshot(), before);
    f.binding.registration.start(); f.sdk.approve('cli_existing123');
    await f.binding.registration.work;
    assert.equal(f.binding.registration.snapshot().status, 'completed');
    assert.equal(f.binding.applicationSnapshot().profile, before.profile);
    assert.equal(f.cli.profiles.get(before.profile).secret, 'fixture-secret');
    assert.equal(f.cli.profiles.size, 1);
  } finally { await f.close(); }
});

test('release 基线：个人授权账号与应用扫码账号不一致时拒绝完成绑定', async () => {
  const f = setup();
  try {
    f.binding.registration.start(); f.sdk.approve('cli_release123');
    await f.binding.registration.work;
    f.cli.profiles.get(f.binding.applicationSnapshot().profile).logins.push('ou_other');
    const flow = await f.binding.start();
    await assert.rejects(f.binding.complete(flow.flowId), e => e.status === 428 && /账号不一致/.test(e.message));
    assert.equal((await f.binding.status()).bound, false);
  } finally { await f.close(); }
});

test('release 基线 API：应用扫码、个人授权确认和运行中保护保持可用', async () => {
  const f = setup(), server = createApp(f.service).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/feishu-registration', { refresh: false })).status, 200);
    f.sdk.approve('cli_release123'); await f.binding.registration.work;
    const response = await post('/feishu-binding', { rebind: true });
    assert.equal(response.status, 200);
    const flow = await response.json();
    const completed = await post('/feishu-binding/complete', { flowId: flow.flowId });
    assert.equal(completed.status, 200); assert.equal((await completed.json()).bound, true);
    f.service.active.set('busy', { controller: new AbortController(), promise: Promise.resolve() });
    assert.equal((await post('/feishu-registration', { refresh: true })).status, 409);
  } finally {
    f.service.active.clear(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await f.close();
  }
});
