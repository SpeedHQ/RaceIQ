type Listener = () => void;
const listeners = new Set<Listener>();
let scheduled = false;

/** Coalesce readiness and account-state changes without performing network work. */
export function notifyOnlineSync(): void {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    scheduled = false;
    for (const listener of listeners) listener();
  });
}

export function subscribeOnlineSync(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
