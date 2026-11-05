import { notificationApplicationMatches } from './notification-errors.mjs';
import { recordTrace } from './connection-trace.mjs';

const openId = value => /^ou_[A-Za-z0-9]+$/.test(value ?? '');
function reject(code, message) { throw Object.assign(new Error(message), { code }); }

export async function notificationContext(service, task) {
  const expected = task.notificationApp ?? task.feishuApp, current = service.binding.applicationSnapshot?.();
  if (!notificationApplicationMatches(expected, current)) {
    recordTrace(service.store,'feishu.notification.binding_mismatch',{phase:'notification_preflight',status:'failed',code:'BINDING_CHANGED',taskId:task.id,previousAppId:expected?.appId,targetAppId:current?.appId},'warn');
    reject('BINDING_CHANGED', 'current binding application changed');
  }
  const application = { ...expected, ...current, appId:current?.appId ?? expected?.appId };
  const recipient = task.notificationRecipient || expected?.ownerOpenId;
  if (!openId(recipient)) reject('MISSING_RECIPIENT', 'missing task notification recipient');
  const identity = await service.binding.json(['auth','status','--json','--verify'], application);
  const user = identity.identities?.user;
  if (user?.available !== true || user.verified === false) reject('USER_AUTH_UNAVAILABLE','user authorization unavailable');
  if (user.openId !== recipient
    || (application.appId && identity.appId !== application.appId)
    || (expected?.appId && identity.appId !== expected.appId)) reject('BINDING_CHANGED', 'identity changed');
  if (identity.identities?.bot?.available !== true || identity.identities?.bot?.verified !== true) reject('BOT_UNAVAILABLE', 'bot unavailable');
  if (!task.notificationRecipient) {
    // A legacy task may recover only its own snapshotted owner, never whichever
    // account happens to be logged in now. This runs only on notification retry.
    if (user.verified !== true) reject('RECIPIENT_UNVERIFIED', 'recipient verification required');
    task.notificationRecipient = recipient;
    task.notificationApp = { ...application };
    service.save(task);
    recordTrace(service.store,'feishu.notification.recipient_restored',{taskId:task.id,appId:application.appId,phase:'notification_preflight',status:'completed'});
  }
  return { recipient, application };
}
