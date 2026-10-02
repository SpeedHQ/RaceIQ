export function mergeNameCache(cache: Record<number, string>, resolved: Record<string, string>): Record<number, string> {
  let changed = false;
  const next = { ...cache };

  for (const [ordinal, name] of Object.entries(resolved)) {
    const key = Number(ordinal);
    if (next[key] !== name) {
      next[key] = name;
      changed = true;
    }
  }

  return changed ? next : cache;
}
