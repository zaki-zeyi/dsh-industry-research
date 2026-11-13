// Per-scope tab data with cache-first reads.
//
// A scope key identifies one tab for the current application, account and
// Feishu root (the caller builds it from `config.publicationScope`). Entries
// live for the lifetime of the page, so returning to a tab shows that tab's
// own content immediately and never reuses another tab's items.
//
// Reading is split in two steps:
//   1. cached(): local/server cache, must never touch the network or CLI.
//   2. sync():   remote refresh, only started when the cache is stale, merged
//                while one is already running, and never applied when it fails.

export const FRESH_MS = 60_000;
const RETRY_MS = 15_000;

function blank(key) {
  return Object.freeze({
    key,
    items: [],
    syncedAt: null,
    syncError: '',
    error: '',
    status: 'idle', // idle → loading → ready
    epoch: 0,
    opening: null,
    syncing: null,
    lastAttemptAt: 0,
  });
}

export function createTabStore({ freshMs = FRESH_MS, retryMs = RETRY_MS, now = () => Date.now() } = {}) {
  const entries = new Map();
  const listeners = new Set();

  function read(key) {
    let current = entries.get(key);
    if (!current) { current = blank(key); entries.set(key, current); }
    return current;
  }
  function write(key, patch) {
    const next = Object.freeze({ ...read(key), ...patch });
    entries.set(key, next);
    for (const listener of [...listeners]) listener(next.key);
    return next;
  }

  function isStale(entry, at = now()) {
    if (!entry.syncedAt) return true;
    const synced = Date.parse(entry.syncedAt);
    return !Number.isFinite(synced) || at - synced >= freshMs;
  }

  function applyCached(key, epoch, value) {
    const current = read(key);
    if (current.epoch !== epoch) return false; // a newer request owns this scope
    write(key, {
      items: Array.isArray(value?.items) ? value.items : [],
      syncedAt: value?.syncedAt ?? current.syncedAt ?? null,
      status: 'ready',
      error: '',
    });
    return true;
  }

  async function readCache(key, epoch, loaders) {
    try {
      const value = await loaders.cached();
      applyCached(key, epoch, value);
    } catch (cause) {
      if (read(key).epoch === epoch) write(key, { error: cause?.message ?? '读取失败', status: 'ready' });
    }
  }

  async function sync(key, loaders, { force = false } = {}) {
    const current = read(key);
    if (current.syncing) return current.syncing; // one remote refresh per scope
    if (!force) {
      const at = now();
      if (!isStale(current, at)) return null;
      if (current.lastAttemptAt && at - current.lastAttemptAt < retryMs) return null;
    }
    const epoch = current.epoch + 1;
    write(key, { epoch, lastAttemptAt: now(), error: '' });
    const task = (async () => {
      try {
        const value = await loaders.sync({ force });
        if (read(key).epoch !== epoch) return; // superseded by a newer request
        // A failed sync keeps the visible cache and only reports the reason.
        if (value?.syncError) write(key, { syncError: value.syncError, status: 'ready' });
        else if (Array.isArray(value?.items)) write(key, {
          items: value.items,
          syncedAt: value.syncedAt ?? read(key).syncedAt ?? null,
          syncError: '',
          status: 'ready',
          error: '',
        });
        else write(key, { syncError: '', status: 'ready', error: '' });
      } catch (cause) {
        if (read(key).epoch === epoch) write(key, { syncError: cause?.message ?? '同步失败', status: 'ready' });
      }
    })();
    write(key, { syncing: task });
    task.then(() => { if (read(key).syncing === task) write(key, { syncing: null }); });
    return task;
  }

  async function open(key, loaders) {
    const current = read(key);
    if (current.opening) return current.opening;
    const task = (async () => {
      // Never invalidate a remote refresh that is already running: its result
      // is newer than anything the local cache can return.
      if (!current.syncing) {
        const epoch = current.epoch + 1;
        write(key, { epoch, error: '', status: current.status === 'ready' ? 'ready' : 'loading' });
        await readCache(key, epoch, loaders);
      }
      await sync(key, loaders);
    })();
    write(key, { opening: task });
    task.then(() => { if (read(key).opening === task) write(key, { opening: null }); });
    return task;
  }

  // Re-read the local cache only; used by polling so a visible refresh is never
  // duplicated and so no CLI call can be started from a timer.
  async function reload(key, loaders) {
    const current = read(key);
    if (current.opening || current.syncing) return null;
    const epoch = current.epoch + 1;
    write(key, { epoch });
    await readCache(key, epoch, loaders);
  }

  // Merge one updated card (for example after a notification retry) without
  // waiting for the next poll.
  function replaceItem(key, id, value) {
    const current = read(key);
    if (!value?.id) return;
    write(key, { items: current.items.map(item => item.id === id ? { ...item, ...value } : item) });
  }

  function get(key) { return read(key); }
  function subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  function isFresh(key, at = now()) { return !isStale(read(key), at); }
  function reset() { entries.clear(); for (const listener of [...listeners]) listener(''); }

  return { get, subscribe, open, reload, refresh: (key, loaders) => sync(key, loaders, { force: true }), replaceItem, isFresh, reset };
}
