import React, { useRef, useState } from 'react';

export function NotificationRetry({ task, base, onUpdated, onRepair }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false);
  async function retry() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/${base}/${task.id}/notify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? '重试通知失败');
      onUpdated(value);
      if (value.notification?.status === 'failed') {
        if (value.notification.diagnostic?.action === 'repair_bot') onRepair?.(value);
        else setError(value.notification.error || '通知仍未发送，请稍后重试');
      }
    } catch (cause) { setError(cause.message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <><button disabled={busy} aria-busy={busy} onClick={retry}>{busy ? '正在重试通知…' : '重试通知'}</button>{error && <span role="status">{error}</span>}</>;
}
