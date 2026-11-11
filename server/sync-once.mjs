// Share remote reads instead of repeating them.
//
// Every Feishu read costs a CLI start, network round trips and pagination, so
// two windows (or a double click) must not start two scans of the same scope.
// A cache younger than the TTL is reused as-is; a manual refresh passes
// `force` to bypass the TTL. Failures are never cached, so the next attempt
// still reaches Feishu.
export const SYNC_TTL_MS = 60_000;

export function createScopedSync({ ttlMs = SYNC_TTL_MS, now = () => Date.now() } = {}) {
  const running = new Map();

  async function run(key, { force = false } = {}, cached, load) {
    if (!force) {
      const value = await cached();
      const synced = Date.parse(value?.syncedAt ?? '');
      if (Number.isFinite(synced) && now() - synced < ttlMs) return value;
    }
    const pending = running.get(key);
    if (pending) return pending;
    const task = Promise.resolve().then(load);
    running.set(key, task);
    const settle = () => { if (running.get(key) === task) running.delete(key); };
    task.then(settle, settle);
    return task;
  }

  return { run, size: () => running.size };
}
