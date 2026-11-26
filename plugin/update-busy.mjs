export function updateBusy(service) {
  const tasks = service.store.list();
  const terminals = service.store.terminalList?.() ?? [];
  const terminalIds = new Set(tasks.map(task => task.terminalId).filter(Boolean));
  return Boolean(service.active?.size || service.queue?.length || service.inFlightWrites || service.inFlightRequests || service.topicDigest?.active ||
    tasks.some(task => ['running', 'queued'].includes(task.status) || task.publication?.status === 'publishing') ||
    service.queuedSaves && service.store.saveJobs?.().length || terminals.some(row => terminalIds.has(row.id) && row.activity === 'working') ||
    service.queuedSaves?.running.size || service.queuedSaves?.submissions.size ||
    [service.notifications, service.internalNotifications, service.topicDeletions, service.internalReconciliation,
      service.documentDeletions].some(worker => worker?.active?.size || worker?.busy?.size) || legacyWritesPending(service, tasks, terminals));
}

function legacyWritesPending(service, tasks, terminals) {
  const writes = service.cloudWrites;
  if (!writes) return false;
  if ([...(writes.locks?.values() ?? [])].some(lock => lock.owner || lock.preparing || lock.waiters?.length)) return true;
  const keys = new Set(terminals.map(row => service.store.setting?.('cloud-write-operation-key:' + row.id)).filter(key => typeof key === 'string'));
  for (const task of tasks) if (task.feishuRoot && writes.operationKey) keys.add(writes.operationKey(task));
  for (const key of keys) if (writes.completedOperations?.(null, key).length) return true;
  return false;
}

export function pauseForUpdate(service) {
  if (updateBusy(service)) throw Object.assign(new Error('工作台仍有任务或写入正在执行，稍后自动重试'), { code: 'WORKBENCH_BUSY' });
  service.updating = true;
  if (service.nativeSessions) service.nativeSessions.paused = true;
  return () => {
    service.updating = false;
    if (service.nativeSessions) service.nativeSessions.paused = false;
    service.drain?.();
    service.queuedSaves?.wake?.();
  };
}
