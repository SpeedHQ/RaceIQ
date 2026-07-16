import type { LapMeta } from "@shared/types";
import { useMemo, useState } from "react";
import { type TuningLapMetric, type TuningTest, useSetHead } from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";
import { AppliedChangesList, LapBreakdown } from "./tune-version-shared";

/**
 * Commit-graph-style view of a tuning session's setup versions (plan §1/§task-11).
 * Each tuning_test row is a "commit": version + label, laps recorded against it,
 * and (if any) the tweaks applied to reach it (reused from the row this replaces
 * via the shared AppliedChangesList/LapBreakdown so both views share one source
 * of truth for change/lap rendering).
 *
 * This is a *real* parent/child tree, not a flat version-sorted list: nodes are
 * linked via `parentTestId` and rendered recursively with each generation
 * indented under its parent, mirroring `git log --graph` branch structure
 * (a test's descendants — e.g. re-tuned branches off an older base — nest
 * under it rather than being interleaved by version number).
 *
 * "Checkout" is a real action: each non-HEAD node gets a button that calls
 * `useSetHead().mutate({ sessionId, testId })`, which hits
 * `POST /api/tuning-sessions/:id/head` and invalidates the session/tests/chat
 * queries on success. The HEAD node shows a badge instead of a button.
 */
export interface VersionGraphProps {
  sessionId: number;
  tests: TuningTest[];
  headTestId: number | null;
  lapsByTest: Map<number, LapMeta[]>;
  metricsById: Map<number, TuningLapMetric>;
}

const byVersionDesc = (a: TuningTest, b: TuningTest) => b.version - a.version;

/**
 * Group tests into a parent/child forest via `parentTestId`. Roots are tests
 * with no parent (or whose parent isn't in this test list — e.g. filtered
 * out). Guards against corrupt/cyclic data (a test whose ancestor chain loops
 * back on itself) by promoting anything unreachable from the initial roots to
 * its own root, so a bad `parentTestId` can never make a version silently
 * disappear from the view.
 */
function buildForest(tests: TuningTest[]): { roots: TuningTest[]; childrenOf: Map<number, TuningTest[]> } {
  const byId = new Map(tests.map((t) => [t.id, t]));
  const childrenOf = new Map<number, TuningTest[]>();
  const hasParent = new Set<number>();

  for (const t of tests) {
    const parent = t.parentTestId != null ? byId.get(t.parentTestId) : undefined;
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
    for (const c of childrenOf.get(t.id) ?? []) stack.push(c);
  }
  const orphanedCycle = tests.filter((t) => !reachable.has(t.id)).sort(byVersionDesc);

  return { roots: [...roots, ...orphanedCycle], childrenOf };
}

export function VersionGraph({ sessionId, tests, headTestId, lapsByTest, metricsById }: VersionGraphProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const setHead = useSetHead();
  const { roots, childrenOf } = useMemo(() => buildForest(tests), [tests]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (tests.length === 0) {
    return <div className="px-3 py-4 text-center text-xs text-app-text-dim">No setup versions yet. Create the session from a base setup to seed v1, or run Save &amp; recommend.</div>;
  }

  // Shared across the whole recursive render (not per-branch) so a corrupt
  // cyclic parentTestId (A's parent is B, B's parent is A) can't recurse
  // forever: once a node has been rendered once, it's never visited again.
  const rendered = new Set<number>();

  const renderNode = (t: TuningTest, depth: number, isLastSibling: boolean): React.ReactNode => {
    if (rendered.has(t.id)) return null;
    rendered.add(t.id);

    const isHead = t.id === headTestId;
    const isOpen = expanded.has(t.id);
    const laps = lapsByTest.get(t.id) ?? [];
    const validLaps = laps.filter((l) => l.isValid && l.lapTime > 0);
    const bestT = validLaps.length ? Math.min(...validLaps.map((l) => l.lapTime)) : null;
    const children = (childrenOf.get(t.id) ?? []).filter((c) => !rendered.has(c.id));
    const hasChildren = children.length > 0;

    return (
      <div key={t.id}>
        <div className="relative flex">
          {/* Graph rail: node dot + connecting line down to the next sibling/child. */}
          <div className="relative w-6 shrink-0 flex flex-col items-center">
            {(!isLastSibling || hasChildren) && <div className="absolute top-3 bottom-0 w-px bg-app-border" />}
            <div className={`z-10 mt-[10px] size-2.5 rounded-full border-2 ${isHead ? "bg-purple-400 border-purple-400" : "bg-app-surface border-app-text-dim"}`} title={isHead ? "HEAD" : undefined} />
          </div>

          <div className="flex-1 min-w-0 pb-2">
            <button type="button" onClick={() => toggle(t.id)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left hover:bg-app-surface-alt/40">
              <span className="text-app-text-dim text-xs w-3">{isOpen ? "▾" : "▸"}</span>
              <span className="font-mono text-xs text-app-text">v{t.version}</span>
              <span className="text-xs text-app-text truncate">{t.label}</span>
              {isHead && <span className="text-[9px] uppercase tracking-wider text-purple-400 border border-purple-400/40 rounded px-1 py-px shrink-0">HEAD</span>}
              <span className="ml-auto flex items-center gap-3 shrink-0 text-[11px] tabular-nums">
                <span className="text-app-text-dim">
                  {laps.length} lap{laps.length === 1 ? "" : "s"}
                </span>
                <span className="font-mono text-app-text-dim">{bestT != null ? formatLapTime(bestT) : "—"}</span>
                {!isHead && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setHead.mutate({ sessionId, testId: t.id });
                    }}
                    disabled={setHead.isPending}
                    className="normal-case tracking-normal font-sans text-[10px] px-1.5 py-0.5 rounded border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-dim disabled:opacity-50 disabled:pointer-events-none"
                  >
                    Checkout
                  </button>
                )}
              </span>
            </button>
            {isOpen && (
              <div className="ml-3 border border-app-border/60 rounded-md overflow-hidden bg-app-surface/40">
                <AppliedChangesList json={t.appliedChanges} comment={t.driverComment} />
                <LapBreakdown laps={laps} bestT={bestT} metricsById={metricsById} />
              </div>
            )}
          </div>
        </div>
        {children.map((c, i) => renderNode(c, depth + 1, i === children.length - 1))}
      </div>
    );
  };

  return <div className="py-1">{roots.map((t, i) => renderNode(t, 0, i === roots.length - 1))}</div>;
}
