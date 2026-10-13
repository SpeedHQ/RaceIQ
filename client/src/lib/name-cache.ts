export function mergeNameCache(cache: Record<string, string>, resolved: Record<string, string>): Record<string, string> {
  let changed = false;
  const next = { ...cache };

  for (const [id, name] of Object.entries(resolved)) {
    if (next[id] !== name) {
      next[id] = name;
      changed = true;
    }
  }

  return changed ? next : cache;
}
