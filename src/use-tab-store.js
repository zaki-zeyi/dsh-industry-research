import { useEffect, useRef, useSyncExternalStore } from 'react';

// Subscribe a component to one tab scope and prime it on mount (cache first,
// then a remote sync only when that scope's cache is stale).
export function useTabEntry(store, key, loaders) {
  const latest = useRef(loaders);
  latest.current = loaders;
  const state = useSyncExternalStore(store.subscribe, () => store.get(key), () => store.get(key));
  useEffect(() => { store.open(key, latest.current); }, [store, key]);
  return state;
}

// Poll the local cache while the tab is visible. `delay` should be short only
// while the tab actually has work in flight.
export function useTabPolling(store, key, loaders, delay) {
  const latest = useRef(loaders);
  latest.current = loaders;
  useEffect(() => {
    let timer = null;
    let live = true;
    const tick = () => {
      if (!live) return;
      if (!document.hidden) store.reload(key, latest.current);
      timer = setTimeout(tick, delay);
    };
    timer = setTimeout(tick, delay);
    const visible = () => { if (!document.hidden && live) store.reload(key, latest.current); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [store, key, delay]);
}
