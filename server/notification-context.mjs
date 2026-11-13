import { notificationApplicationMatches } from './notification-errors.mjs';
import { recordTrace } from './connection-trace.mjs';
import { createHash } from 'node:crypto';

const openId = value => /^ou_[A-Za-z0-9]+$/.test(value ?? '');
function reject(code, message) { throw Object.assign(new Error(message), { code }); }

export async function notificationContext(service, task, { currentUser = false } = {}) {
  if (currentUser) {
    const application = { ...service.binding.applicationSnapshot?.() };
    const identity = await service.binding.json(['auth','status','--json','--verify'], application);
    const user = identity.identities?.user;
    if(user?.available!==true || user.verified!==true || !openId(user.openId))reject('USER_AUTH_UNAVAILABLE','current user authorization unavailable');
    if(!identity.appId || (application.appId && application.appId!==identity.appId)
      || (application.ownerOpenId && application.ownerOpenId!==user.openId))reject('BINDING_CHANGED','current binding identity changed');
    if(identity.identities?.bot?.available!==true || identity.identities.bot.verified!==true)reject('BOT_UNAVAILABLE','bot unavailable');
    application.appId=identity.appId;
    const expected=task.notificationApp??task.feishuApp, previousRecipient=task.notificationRecipient??expected?.ownerOpenId;
    const changed=!notificationApplicationMatches(expected,application)
      || Boolean(expected?.appId && expected.appId!==identity.appId)
      || Boolean(previousRecipient && previousRecipient!==user.openId);
    // Keep the original key for the original recipient; isolate deduplication
    // when the user explicitly retries to a different application/account.
    const previousAttempt=task.notification;
    const originalKey=previousAttempt?.recipient===user.openId && previousAttempt?.appId===identity.appId ? previousAttempt.idempotencyKey : undefined;
    const hash=createHash('sha256').update(`${task.id}:${identity.appId}:${user.openId}`).digest('hex');
    const destinationKey=`${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-8${hash.slice(17,20)}-${hash.slice(20,32)}`;
    return { recipient:user.openId, application, changed, previousAppId:expected?.appId, idempotencyKey:originalKey??(changed||!previousRecipient?destinationKey:task.id), currentUser:true };
  }
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
  return { recipient, application, idempotencyKey:task.id };
}

export function notificationSent(task, context) {
  if(context.currentUser){
    task.notificationRecipient=context.recipient;
    task.notificationApp={...context.application};
  }
  return context.changed ? '当前绑定的飞书账号或应用已发生变化，已通过当前应用向当前用户发送通知。' : undefined;
}
