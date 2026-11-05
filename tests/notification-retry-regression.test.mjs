import test from 'node:test';
import assert from 'node:assert/strict';
import { BriefingNotifications } from '../server/briefing-notifications.mjs';
import { InternalMaterialNotifications } from '../server/internal-notifications.mjs';

for (const [kind, Notifications] of [['daily', BriefingNotifications], ['internal', InternalMaterialNotifications]]) {
  test(`${kind} 重试验证机器人，复用同应用的新profile，并保留原收件人与幂等键`, async () => {
    const current = { mode: 'custom', appId: 'cli_same', profile: 'research-repaired' };
    const task = { id: 'task', status: 'ready', notificationRecipient: 'ou_person', notificationApp: { ...current, profile: 'research-old' }, notification: { status: 'failed' }, publication: { status: 'published', url: 'https://example.feishu.cn/docx/report' }, ...(kind === 'daily' ? { briefing: { kind: 'daily', window: { display: '昨天' } } } : { internal: { source: 'https://example.com', sourceLabel: '访谈' } }) };
    let sends = 0, recipient = 'ou_person';
    const service = { require: () => task, save() {}, binding: { applicationSnapshot: () => current, json: async (args, app) => {
      assert.equal(app.profile, 'research-repaired');
      if (args[0] === 'auth') {
        assert.ok(args.includes('--verify'), '未传verify不能要求CLI返回verified');
        return { appId: current.appId, identities: { user: { available: true, openId: recipient }, bot: { available: true, verified: args.includes('--verify') } } };
      }
      assert.equal(args[args.indexOf('--user-id') + 1], 'ou_person');
      assert.equal(args[args.indexOf('--idempotency-key') + 1], task.id);
      sends++; return { ok: true, data: { message_id: 'om_sent' } };
    } } };
    const notifications = new Notifications(service);
    await Promise.all([notifications.send(task.id), notifications.send(task.id)]);
    assert.equal(task.notification.status, 'sent'); assert.equal(sends, 1);
    task.notification.status = 'failed'; recipient = 'ou_another';
    await notifications.send(task.id);
    assert.equal(task.notification.status, 'failed'); assert.equal(sends, 1);
    assert.equal(task.notification.diagnostic.action, 'binding_changed');
    recipient = 'ou_person'; current.appId = 'cli_different';
    await notifications.send(task.id);
    assert.equal(sends, 1); assert.equal(task.notification.diagnostic.action, 'binding_changed');
  });
}
