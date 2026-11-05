import { internalNotificationText } from './internal-materials.mjs';
import { notificationFailure } from './notification-errors.mjs';
import { notificationContext } from './notification-context.mjs';
import { recordTrace } from './connection-trace.mjs';

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
      const {recipient,application} = await notificationContext(service,task);
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
      recordTrace(service.store,'feishu.notification.sent',{taskId:task.id,appId:application.appId,phase:'bot_message',status:'completed'});
    } catch (error) {
      const failure = notificationFailure(error);
      recordTrace(service.store,'feishu.notification.failed',{taskId:task.id,appId:(task.notificationApp??task.feishuApp)?.appId,code:failure.diagnostic.code??'UNKNOWN_ERROR',phase:task.notification?.status==='sending'?'bot_message':'notification_preflight'},'error');
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
