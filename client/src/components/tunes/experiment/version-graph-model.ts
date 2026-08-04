import type { ExperimentVersion } from "@/hooks/experiments";

export const byVersionDesc = (a: ExperimentVersion, b: ExperimentVersion) => b.version - a.version;

/** Build parent/child forest while recovering orphaned cycles as roots. */
export function buildForest(tests: ExperimentVersion[]): { roots: ExperimentVersion[]; childrenOf: Map<number, ExperimentVersion[]> } {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const childrenOf = new Map<number, ExperimentVersion[]>();
  const hasParent = new Set<number>();
  for (const t of tests) {
    const parent = t.parentVersionId != null ? byId.get(t.parentVersionId) : undefined;
    if (!parent) continue;
    hasParent.add(t.id);
    const arr = childrenOf.get(parent.id) ?? [];
    arr.push(t);
    childrenOf.set(parent.id, arr);
  }
  for (const arr of childrenOf.values()) arr.sort(byVersionDesc);
  const roots = tests.filter((t) => !hasParent.has(t.id)).sort(byVersionDesc);
  const reachable = new Set<number>();
  const stack = [...roots];
  while (stack.length) {
    const t = stack.pop()!;
    if (reachable.has(t.id)) continue;
    reachable.add(t.id);
    for (const child of childrenOf.get(t.id) ?? []) stack.push(child);
  }
  const orphanedCycle = tests.filter((t) => !reachable.has(t.id)).sort(byVersionDesc);
  return { roots: [...roots, ...orphanedCycle], childrenOf };
}
