// ── TTL cache: evicts entries after CACHE_TTL_MS of inactivity ──────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface CacheEntry<T> { data: T; timer: ReturnType<typeof setTimeout>; }

/**
 * Schedule the eviction of `key`, unref'd so a pending eviction never keeps a
 * process alive. Without this, any server/test that performs a single track
 * lookup arms a ref'd 5-minute timer and `bun test` idles that long after the
 * suite finishes. `unref?.()` is optional-call because this module is also
 * bundled for the browser, where `setTimeout` returns a number.
 */
function armEviction<V>(map: Map<string, V>, key: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => map.delete(key), CACHE_TTL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

export function ttlCache<T>() {
  const map = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const entry = map.get(key);
      if (!entry) return undefined;
      clearTimeout(entry.timer);
      entry.timer = armEviction(map, key);
      return entry.data;
    },
    set(key: string, data: T) {
      const existing = map.get(key);
      if (existing) clearTimeout(existing.timer);
      map.set(key, { data, timer: armEviction(map, key) });
    },
    has(key: string) { return map.has(key); },
    delete(key: string) { const e = map.get(key); if (e) clearTimeout(e.timer); map.delete(key); },
  };
}
