import test from 'node:test';
import assert from 'node:assert/strict';
import { FeishuBinding } from '../server/feishu-binding.mjs';

function operation(mode, sameApp, oldIdentity) {
  const b = Object.create(FeishuBinding.prototype);
  let committed = false, restored = false;
  b.pendingApplicationOperation = () => ({ mode, previousApplication: { appId: 'cli_old' }, ...oldIdentity });
  b.applicationSnapshot = () => ({ appId: sameApp ? 'cli_old' : 'cli_new' });
  b.restorePendingApplicationOperation = () => { restored = true; };
  b.rememberVerifiedAccount = () => { committed = true; };
  b.clearPendingApplicationOperation = () => {};
  return { b, committed: () => committed, restored: () => restored };
}

test('PRD1917 同应用同账号缺失unionId时不误判换号', () => {
  const f = operation('same', true, { previousOpenId: 'ou_person', previousUnionId: 'on_person' });
  f.b.commitPendingApplicationOperation({ openId: 'ou_person' });
  assert.equal(f.committed(), true);
});
test('PRD1917 跨应用身份字段缺失应报告无法确认身份，不能判成不同账号', () => {
  for (const mode of ['same', 'different']) {
    const f = operation(mode, false, { previousOpenId: 'ou_old', previousUnionId: 'on_person' });
    assert.throws(() => f.b.commitPendingApplicationOperation({ openId: 'ou_new' }), e => e.code === 'LARK_STABLE_IDENTITY_REQUIRED');
    assert.equal(f.restored(), true);
    assert.equal(f.committed(), false);
  }
});
test('PRD1917 跨应用使用双方unionId比较，允许同账号换应用', () => {
  const f = operation('same', false, { previousOpenId: 'ou_old', previousUnionId: 'on_person' });
  f.b.commitPendingApplicationOperation({ openId: 'ou_new', unionId: 'on_person' });
  assert.equal(f.committed(), true);
});
test('PRD1917 个人登录就绪但未提交绑定时状态接口不能提前成功', async () => {
  const f = operation('same', true, { previousOpenId: 'ou_person' });
  f.b.inspectStatus = async () => ({ bound: true, openId: 'ou_person' });
  assert.equal((await f.b.status()).bound, false);
  assert.equal(f.committed(), false);
});
