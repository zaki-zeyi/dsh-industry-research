import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.mjs';
import { FeishuBinding } from '../server/feishu-binding.mjs';
import { applicationRunner, registrationRunner } from './fixtures/fake-feishu-application.mjs';

function setup(transform = run => run) {
  const f = fixture(), cli = applicationRunner(), sdk = registrationRunner();
  const binding = new FeishuBinding({ store: f.store, run: transform(cli.run), registerApp: sdk.registerApp });
  return { ...f, cli, sdk, binding, async close() { binding.close(); await f.close(); } };
}

test('相同应用重新扫码直接更新原profile的新凭据，不重复添加、不修改默认选择', async () => {
  const f = setup();
  try {
    f.cli.profiles.set('research-existing', { appId: 'cli_existing123', secret: 'old-secret', bound: false });
    f.store.saveSetting('feishu-application', { mode: 'custom', appId: 'cli_existing123', profile: 'research-existing' });
    f.binding.registration.start(); f.sdk.approve('cli_existing123'); await f.binding.registration.work;
    assert.equal(f.binding.registration.snapshot().status, 'completed');
    const update = f.cli.calls.find(c => c.args[0] === 'config');
    assert.deepEqual(update.args.slice(0, 4), ['config', 'init', '--name', 'research-existing']);
    assert.equal(update.options.input, 'fixture-secret\n');
    assert.equal(f.cli.profiles.get('research-existing').secret, 'fixture-secret');
    assert.equal(f.cli.calls.some(c => c.args[0] === 'profile' && c.args[1] === 'add'), false);
    assert.ok(!update.args.includes('--use')); assert.ok(!update.args.includes('fixture-secret'));
    const flow = await f.binding.start(); assert.equal((await f.binding.complete(flow.flowId)).bound, true);
    assert.equal((await f.binding.status({ mode: 'default' })).appId, 'cli_default123');
    assert.ok(!JSON.stringify(f.store.runtimeLogs()).includes('fixture-secret'));
    assert.ok(!JSON.stringify(f.binding.applicationSnapshot()).includes('fixture-secret'));
  } finally { await f.close(); }
});

test('选中遗留且旧凭据失效的应用，重复创建转为更新已有profile并继续个人授权', async () => {
  const f = setup();
  try {
    f.cli.profiles.set('research-orphan', { appId: 'cli_orphan123', secret: 'invalid-old-secret', bound: false });
    f.binding.registration.start(); f.sdk.approve('cli_orphan123'); await f.binding.registration.work;
    assert.equal(f.binding.registration.snapshot().status, 'completed');
    assert.equal(f.binding.applicationSnapshot().profile, 'research-orphan');
    assert.equal(f.cli.profiles.size, 1); assert.equal(f.cli.profiles.get('research-orphan').secret, 'fixture-secret');
    assert.equal(f.cli.calls.filter(c => c.args[0] === 'config').length, 1);
    const flow = await f.binding.start(); assert.equal((await f.binding.complete(flow.flowId)).bound, true);
    assert.equal((await f.binding.status({mode:'default'})).appId, 'cli_default123');
  } finally { await f.close(); }
});

test('更新已有profile保存失败，不提交所选应用、不清理旧profile，日志记录存储故障', async () => {
  const f = setup(run => async (args, options) => {
    if (args[0] === 'config') throw Object.assign(new Error('access denied SECRET'), { code: 'EACCES' });
    return run(args, options);
  });
  try {
    f.cli.profiles.set('research-orphan', { appId: 'cli_orphan123', secret: 'old-secret', bound: false });
    const before = f.binding.applicationSnapshot();
    f.binding.registration.start(); f.sdk.approve('cli_orphan123'); await f.binding.registration.work;
    assert.equal(f.binding.registration.snapshot().status, 'failed');
    assert.deepEqual(f.binding.applicationSnapshot(), before);
    assert.equal(f.cli.profiles.get('research-orphan').secret, 'old-secret');
    assert.ok(f.store.runtimeLogs().some(r => r.details.phase === 'credential_storage' && r.details.code === 'LOCAL_STORAGE_DENIED'));
    assert.ok(!JSON.stringify(f.store.runtimeLogs()).includes('SECRET'));
  } finally { await f.close(); }
});

test('非重复错误不尝试覆盖已有配置，重复冲突也拒绝无效profile名称', async () => {
  for (const conflict of [false, true]) {
    const f = setup(run => async (args, options) => {
      if (args[0] === 'profile' && args[1] === 'add') throw new Error(conflict ? 'unique app-id' : 'network unavailable');
      if (args[0] === 'profile' && args[1] === 'list') return [{ name: '../invalid', appId: 'cli_orphan123' }];
      if (args[0] === 'config') assert.fail('must not update unrelated or invalid profile');
      return run(args, options);
    });
    try {
      f.binding.registration.start(); f.sdk.approve('cli_orphan123'); await f.binding.registration.work;
      assert.equal(f.binding.registration.snapshot().status, 'failed');
      assert.deepEqual(f.binding.applicationSnapshot(), {mode:'default'});
    } finally { await f.close(); }
  }
});

test('手动输入同一应用的新密钥也更新原profile，不再走重复创建路径', async () => {
  const f = setup();
  try {
    await f.binding.configureApplication({ mode:'custom', appId:'cli_manual123', appSecret:'first-secret' });
    const first = f.binding.applicationSnapshot();
    await f.binding.configureApplication({ mode:'custom', appId:'cli_manual123', appSecret:'new-secret' });
    assert.equal(f.binding.applicationSnapshot().profile, first.profile);
    assert.equal(f.cli.profiles.get(first.profile).secret, 'new-secret');
    assert.equal(f.cli.calls.filter(c => c.args[0] === 'profile' && c.args[1] === 'add').length, 1);
    assert.equal(f.cli.profiles.size, 1);
  } finally { await f.close(); }
});
