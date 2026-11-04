import { internalNotificationText } from './internal-materials.mjs';
import { notificationApplicationMatches, notificationFailure } from './notification-errors.mjs';

export class InternalMaterialNotifications {
  constructor(service) {
    this.service = service;
    this.active = new Map();
  }

  send(id) {
    if (this.active.has(id)) return this.active.get(id);
    const job = this.deliver(id).finally(() => this.active.delete(id));
    this.active.set(id, job);
    return job;
  }

  async deliver(id) {
    const service = this.service;
    const task = service.require(id);
    if (!task.internal || task.status !== 'ready' || task.publication.status !== 'published' || task.notification?.status === 'sent') return task;
    try {
      const recipient = task.notificationRecipient;
      const expected = task.notificationApp ?? task.feishuApp;
      const current = service.binding.applicationSnapshot?.();
      const application = { ...expected, ...current, appId: current?.appId ?? expected?.appId };
      if (!/^ou_[A-Za-z0-9]+$/.test(recipient ?? '')) throw new Error('missing recipient');
      if (!notificationApplicationMatches(expected, current)) throw new Error('current binding application changed');
      const identity = await service.binding.json(['auth', 'status', '--json', '--verify'], application);
      if (identity.identities?.user?.openId !== recipient
        || identity.identities.user.available !== true
        || (application.appId && identity.appId !== application.appId)) throw new Error('identity changed');
      if (identity.identities?.bot?.available !== true || identity.identities?.bot?.verified !== true) throw new Error('bot unavailable');
      task.notification = { status: 'sending', recipient, attemptedAt: new Date().toISOString() };
      service.save(task);
      const response = await service.binding.json([
        'im', '+messages-send', '--as', 'bot', '--user-id', recipient,
        '--text', internalNotificationText(task), '--idempotency-key', task.id,
      ], application);
      if (response.ok !== true) throw Object.assign(new Error('unconfirmed notification'), { stderr: JSON.stringify(response) });
      const messageId = response.data?.message_id ?? response.message_id;
      task.notification = { ...task.notification, status: 'sent', sentAt: new Date().toISOString(), ...(messageId ? { messageId: String(messageId) } : {}) };
      service.save(task);
    } catch (error) {
      const failure = notificationFailure(error);
      task.notification = {
        ...task.notification,
        status: 'failed',
        error: failure.message,
        diagnostic: failure.diagnostic,
      };
      service.save(task);
    }
    return task;
  }

  async close() {
    await Promise.allSettled(this.active.values());
  }
}
