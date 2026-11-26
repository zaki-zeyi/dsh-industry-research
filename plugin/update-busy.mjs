export function updateBusy(service) {
  const tasks = service.store.list();
  const terminalIds = new Set(tasks.map(task => task.terminalId).filter(Boolean));
  return Boolean(service.active?.size || service.queue?.length || service.inFlightWrites || service.inFlightRequests ||
    tasks.some(task => ['running', 'queued'].includes(task.status) || task.publication?.status === 'publishing') ||
    service.queuedSaves && service.store.saveJobs?.().length || service.store.terminalList?.().some(row => terminalIds.has(row.id) && row.activity === 'working') ||
    service.queuedSaves?.running.size || service.queuedSaves?.submissions.size ||
    [service.notifications, service.internalNotifications, service.topicDeletions, service.internalReconciliation,
      service.documentDeletions].some(worker => worker?.active?.size || worker?.busy?.size));
}

export function pauseForUpdate(service) {
  if (updateBusy(service)) throw Object.assign(new Error('工作台仍有任务或写入正在执行，稍后自动重试'), { code: 'WORKBENCH_BUSY' });
  service.updating = true;
  if (service.nativeSessions) service.nativeSessions.paused = true;
  return () => {
    service.updating = false;
    if (service.nativeSessions) service.nativeSessions.paused = false;
  };
}
