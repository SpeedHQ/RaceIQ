import type { LapMeta } from "@shared/types";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { type TuningLapMetric, type TuningTest, useDeleteVersion, useSetHead, useSetTestNote } from "../../hooks/queries";
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
  /** Opens the post-test review dashboard scoped to this node's laps/testId. */
  onOpenReview?: (test: TuningTest) => void;
}

const byVersionDesc = (a: TuningTest, b: TuningTest) => b.version - a.version;

/** Generic free-text per-node editor. Seeds from the node's stored value,
 *  saves via the supplied mutation, and only enables Save when the text
 *  actually changed. Backs both the driver comment and the engineer notes. */
function NodeTextEditor({
  label,
  value,
  placeholder,
  pending,
  error,
  onSave,
  rows = 2,
}: {
  label: string;
  value: string | null;
  placeholder: string;
  pending: boolean;
  error: unknown;
  onSave: (next: string | null, done: () => void) => void;
  rows?: number;
}) {
  const [draft, setDraft] = useState(value ?? "");
  // Re-seed when the server value changes (e.g. after undo) unless the user is
  // mid-edit with unsaved changes.
  const [dirty, setDirty] = useState(false);
  const current = value ?? "";
  const trimmed = draft.trim();
  const changed = trimmed !== current;

  return (
    <div className="px-3 py-2 border-b border-app-border/40 space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-app-text-muted">{label}</div>
      <textarea
        value={dirty ? draft : current}
        onChange={(e) => {
          setDirty(true);
          setDraft(e.target.value);
        }}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-app-border bg-app-surface/60 px-2 py-1 text-[11px] text-app-text placeholder:text-app-text-dim focus:border-app-text-dim focus:outline-none"
      />
      {dirty && changed && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onSave(trimmed === "" ? null : trimmed, () => setDirty(false))}
            disabled={pending}
            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-app-accent text-app-accent bg-app-accent/10 hover:bg-app-accent/20 disabled:opacity-50 disabled:pointer-events-none"
          >
            {pending ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => {
              setDirty(false);
              setDraft(current);
            }}
            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-app-border text-app-text-muted hover:text-app-text"
          >
            Cancel
          </button>
          {error != null && <span className="text-[10px] text-red-400">{(error as Error).message}</span>}
        </div>
      )}
    </div>
  );
}

/** Driver's subjective feel comment for this version. */
function DriverCommentEditor({ sessionId, testId, note, rows }: { sessionId: number; testId: number; note: string | null; rows?: number }) {
  const setNote = useSetTestNote();
  return (
    <NodeTextEditor
      label="Driver comment"
      value={note}
      placeholder="How did the car feel on this version?"
      pending={setNote.isPending}
      error={setNote.error}
      rows={rows}
      onSave={(next, done) => setNote.mutate({ sessionId, testId, driverComment: next }, { onSuccess: done })}
    />
  );
}

/** Engineer/AI note — reasoning on this version, written by the setup engineer
 *  and persisted across chat compaction. READ-ONLY in the UI: only the setup
 *  engineer agent edits it, so the driver can't accidentally clobber it. */
function EngineerNotesView({ notes }: { notes: string | null }) {
  return (
    <div className="px-3 py-2 space-y-1">
      <div className="text-[10px] uppercase tracking-wider text-app-text-muted">Engineer notes</div>
      {notes ? (
        <p className="text-[11px] text-app-text whitespace-pre-wrap max-h-64 overflow-y-auto">{notes}</p>
      ) : (
        <p className="text-[11px] text-app-text-dim italic">No engineer notes yet — the setup engineer adds these.</p>
      )}
    </div>
  );
}

/** Modal wrapping both per-node comment editors, opened from a node's "Notes"
 *  button. Closes on backdrop click, the × button, or Escape. */
function NotesModal({ sessionId, test, onClose }: { sessionId: number; test: TuningTest; onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[820px] max-w-[94vw] max-h-[90vh] overflow-y-auto flex flex-col p-5"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold text-app-text">
            <span className="font-mono">{test.label}</span> — notes
          </p>
          <button type="button" onClick={onClose} className="text-app-text-dim hover:text-app-text text-xl leading-none">
            ×
          </button>
        </div>
        <div className="grid grid-cols-2 divide-x divide-app-border/60 border border-app-border/60 rounded-md overflow-hidden bg-app-surface/40">
          <DriverCommentEditor sessionId={sessionId} testId={test.id} note={test.driverComment} rows={8} />
          <EngineerNotesView notes={test.notes} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Row-level stat with an always-visible label so a placeholder "—" (no laps
 *  yet) still reads as a defined column, not blank space. */
function RowStat({ label, value, width = "w-[8ch]" }: { label: string; value: string; width?: string }) {
  return (
    <span className={`flex flex-col items-end leading-tight shrink-0 ${width}`}>
      <span className="text-[8px] uppercase tracking-wider text-app-text-muted/70 whitespace-nowrap">{label}</span>
      <span className="font-mono text-app-text-dim whitespace-nowrap">{value}</span>
    </span>
  );
}

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

export function VersionGraph({ sessionId, tests, headTestId, lapsByTest, metricsById, onOpenReview }: VersionGraphProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [notesForId, setNotesForId] = useState<number | null>(null);
  const setHead = useSetHead();
  const deleteVersion = useDeleteVersion();
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
    const worstT = validLaps.length ? Math.max(...validLaps.map((l) => l.lapTime)) : null;
    const avgT = validLaps.length ? validLaps.reduce((s, l) => s + l.lapTime, 0) / validLaps.length : null;
    const fuelVals = laps.map((l) => metricsById.get(l.id)?.fuelPerLap).filter((v): v is number => v != null);
    const avgFuel = fuelVals.length ? fuelVals.reduce((s, v) => s + v, 0) / fuelVals.length : null;
    // Per-lap worst-tyre value (max across corners, computed server-side),
    // averaged across the test's laps.
    const tyreVals = laps.map((l) => metricsById.get(l.id)?.tyreWear).filter((v): v is number => v != null);
    const avgWorstWear = tyreVals.length ? tyreVals.reduce((s, v) => s + v, 0) / tyreVals.length : null;
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
              <span className="font-mono text-xs text-app-text truncate">{t.label}</span>
              {isHead && <span className="text-[9px] uppercase tracking-wider text-purple-400 border border-purple-400/40 rounded px-1 py-px shrink-0">HEAD</span>}
              {!isHead && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHead.mutate({ sessionId, testId: t.id });
                  }}
                  disabled={setHead.isPending}
                  className="normal-case tracking-normal font-sans text-[10px] px-1.5 py-0.5 rounded border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-dim disabled:opacity-50 disabled:pointer-events-none shrink-0"
                >
                  Checkout
                </button>
              )}
              {onOpenReview && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenReview(t);
                  }}
                  className="normal-case tracking-normal font-sans text-[10px] px-1.5 py-0.5 rounded border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-dim disabled:opacity-50 disabled:pointer-events-none shrink-0"
                >
                  Review
                </button>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setNotesForId(t.id);
                }}
                title={t.driverComment || t.notes ? "View / edit notes" : "Add notes"}
                className="normal-case tracking-normal font-sans text-[10px] px-1.5 py-0.5 rounded border border-app-border text-app-text-muted hover:text-app-text hover:border-app-text-dim shrink-0 inline-flex items-center gap-1"
              >
                Notes
                {(t.driverComment || t.notes) && <span className="size-1.5 rounded-full bg-app-accent" />}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const extra = hasChildren ? " and its whole branch" : "";
                  if (!window.confirm(`Delete "${t.label}"${extra}? This can be restored from the trash.`)) return;
                  deleteVersion.mutate({ sessionId, testId: t.id });
                }}
                disabled={deleteVersion.isPending}
                title={hasChildren ? "Trash this version and its whole branch (reversible)" : "Trash this version (reversible)"}
                className="normal-case tracking-normal font-sans text-[10px] px-1.5 py-0.5 rounded border border-app-border text-app-text-muted hover:text-red-400 hover:border-red-400/40 disabled:opacity-50 disabled:pointer-events-none shrink-0"
              >
                Delete branch
              </button>
              <span className="ml-auto flex items-center gap-3 shrink-0 text-[11px] tabular-nums">
                <RowStat label="laps" value={String(laps.length)} width="w-[3ch]" />
                <RowStat label="avg" value={avgT != null ? formatLapTime(avgT) : "-:--.---"} />
                <RowStat label="best" value={bestT != null ? formatLapTime(bestT) : "-:--.---"} />
                <RowStat label="worst" value={worstT != null ? formatLapTime(worstT) : "-:--.---"} />
                <RowStat label="fuel/lap" value={avgFuel != null ? `${avgFuel.toFixed(2)}L` : "—"} width="w-[7ch]" />
                <RowStat label="worst wear" value={avgWorstWear != null ? `${avgWorstWear.toFixed(0)}%` : "—"} width="w-[10ch]" />
              </span>
            </button>
            {isOpen && (
              <div className="ml-3 border border-app-border/60 rounded-md overflow-hidden bg-app-surface/40">
                <AppliedChangesList json={t.appliedChanges} />
                <LapBreakdown laps={laps} bestT={bestT} metricsById={metricsById} tuningSessionId={sessionId} />
              </div>
            )}
          </div>
        </div>
        {children.map((c, i) => renderNode(c, depth + 1, i === children.length - 1))}
      </div>
    );
  };

  const actionError = setHead.error ?? deleteVersion.error;

  const notesTest = notesForId != null ? (tests.find((t) => t.id === notesForId) ?? null) : null;

  return (
    <div className="py-1">
      {notesTest && <NotesModal sessionId={sessionId} test={notesTest} onClose={() => setNotesForId(null)} />}
      {actionError && <div className="mx-2 mb-1 rounded-md border border-red-400/40 bg-red-400/10 px-2 py-1 text-[11px] text-red-300">{(actionError as Error).message}</div>}
      {roots.map((t, i) => renderNode(t, 0, i === roots.length - 1))}
    </div>
  );
}
