import { EXPERIMENT_FOCUS_LABELS, type ExperimentFocus } from "@shared/racing/experiments/focus";
import { REVIEW_LAP_CAP, selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import { useMemo, useState } from "react";
import {
  type ExperimentLapMetric,
  type ExperimentVersion,
  useDeletedExperimentVersions,
  useDeleteVersion,
  useExperimentArmComparison,
  useExperimentFocusHistory,
  useRestoreVersion,
  useSetHead,
  useSetTestNote,
} from "../../hooks/queries";
import { formatLapTime } from "../../lib/format";
import { F1SetupModal } from "../analyse/F1SetupModal";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { SetupContentModal } from "./SetupFilePicker";
import { AppliedChangesList, LapBreakdown, summarizeAppliedChanges } from "./tune-version-shared";

/**
 * Commit-graph-style view of an experiment's setup versions (plan §1/§task-11).
 * Each experiment_version row is a "commit": version + label, laps recorded against it,
 * and (if any) the tweaks applied to reach it (reused from the row this replaces
 * via the shared AppliedChangesList/LapBreakdown so both views share one source
 * of truth for change/lap rendering).
 *
 * This is a *real* parent/child tree, not a flat version-sorted list: nodes are
 * linked via `parentVersionId` and rendered recursively with each generation
 * indented under its parent, mirroring `git log --graph` branch structure
 * (a test's descendants — e.g. re-tuned branches off an older base — nest
 * under it rather than being interleaved by version number).
 *
 * "Checkout" is a real action: each non-HEAD node gets a button that calls
 * `useSetHead().mutate({ sessionId, versionId })`, which hits
 * `POST /api/experiments/:id/head` and invalidates the session/tests/chat
 * queries on success. The HEAD node shows a badge instead of a button.
 */
export interface VersionGraphProps {
  sessionId: number;
  gameId: "acc" | "ac-evo" | "f1-2025" | null;
  tests: ExperimentVersion[];
  headVersionId: number | null;
  lapsByTest: Map<number, LapMeta[]>;
  metricsById: Map<number, ExperimentLapMetric>;
  /** Opens the post-test review dashboard scoped to this node's laps/versionId. */
  onOpenReview?: (test: ExperimentVersion) => void;
}

const byVersionDesc = (a: ExperimentVersion, b: ExperimentVersion) => b.version - a.version;

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
      <div className="text-app-caption uppercase tracking-wider text-app-text-muted">{label}</div>
      <textarea
        value={dirty ? draft : current}
        onChange={(e) => {
          setDirty(true);
          setDraft(e.target.value);
        }}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-md border border-app-border bg-app-surface/60 px-2 py-1 text-app-compact text-app-text placeholder:text-app-text-dim focus:border-app-text-dim focus:outline-none"
      />
      {dirty && changed && (
        <div className="flex items-center gap-2">
          <Button variant="app-outline" size="app-sm" onClick={() => onSave(trimmed === "" ? null : trimmed, () => setDirty(false))} disabled={pending} className="normal-case tracking-wider">
            {pending ? "Saving…" : "Save"}
          </Button>
          <Button
            variant="app-ghost"
            size="app-sm"
            onClick={() => {
              setDirty(false);
              setDraft(current);
            }}
            className="normal-case tracking-wider text-app-text-muted hover:text-app-text"
          >
            Cancel
          </Button>
          {error != null && <span className="text-app-caption text-status-danger">{(error as Error).message}</span>}
        </div>
      )}
    </div>
  );
}

/** Driver's subjective feel comment for this version. */
function DriverCommentEditor({ sessionId, versionId, note, rows }: { sessionId: number; versionId: number; note: string | null; rows?: number }) {
  const setNote = useSetTestNote();
  return (
    <NodeTextEditor
      label="Driver comment"
      value={note}
      placeholder="How did the car feel on this version?"
      pending={setNote.isPending}
      error={setNote.error}
      rows={rows}
      onSave={(next, done) => setNote.mutate({ sessionId, versionId, driverComment: next }, { onSuccess: done })}
    />
  );
}

/** Engineer/AI note — reasoning on this version, written by the setup engineer
 *  and persisted across chat compaction. READ-ONLY in the UI: only the setup
 *  engineer agent edits it, so the driver can't accidentally clobber it. */
function EngineerNotesView({ notes }: { notes: string | null }) {
  return (
    <div className="px-3 py-2 space-y-1">
      <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Engineer notes</div>
      {notes ? (
        <p className="text-app-compact text-app-text whitespace-pre-wrap max-h-64 overflow-y-auto">{notes}</p>
      ) : (
        <p className="text-app-compact text-app-text-dim italic">No engineer notes yet — the setup engineer adds these.</p>
      )}
    </div>
  );
}

/** Modal wrapping both per-node comment editors, opened from a node's "Notes"
 *  button. Closes on backdrop click, the × button, or Escape. */
function NotesModal({ sessionId, test, onClose }: { sessionId: number; test: ExperimentVersion; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="wide" showCloseButton={false} overlayClassName="bg-app-bg/60" layout="scrollable">
        <DialogHeader>
          <DialogTitle className="text-sm font-semibold text-app-text">
            <span className="font-mono">{test.label}</span> — notes
          </DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-2 divide-x divide-app-border/60 border border-app-border/60 rounded-md overflow-hidden bg-app-surface/40">
          <DriverCommentEditor sessionId={sessionId} versionId={test.id} note={test.driverComment} rows={8} />
          <EngineerNotesView notes={test.notes} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Row-level stat with an always-visible label so a placeholder "—" (no laps
 *  yet) still reads as a defined column, not blank space. */
function RowStat({ label, value, width = "w-[8ch]" }: { label: string; value: string; width?: string }) {
  return (
    <span className={`flex flex-col items-end leading-tight shrink-0 ${width}`}>
      <span className="text-app-nano uppercase tracking-wider text-app-text-muted/70 whitespace-nowrap">{label}</span>
      <span className="font-mono text-app-text-dim whitespace-nowrap">{value}</span>
    </span>
  );
}

/**
 * Group tests into a parent/child forest via `parentVersionId`. Roots are tests
 * with no parent (or whose parent isn't in this test list — e.g. filtered
 * out). Guards against corrupt/cyclic data (a test whose ancestor chain loops
 * back on itself) by promoting anything unreachable from the initial roots to
 * its own root, so a bad `parentVersionId` can never make a version silently
 * disappear from the view.
 */
function buildForest(tests: ExperimentVersion[]): { roots: ExperimentVersion[]; childrenOf: Map<number, ExperimentVersion[]> } {
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
    for (const c of childrenOf.get(t.id) ?? []) stack.push(c);
  }
  const orphanedCycle = tests.filter((t) => !reachable.has(t.id)).sort(byVersionDesc);

  return { roots: [...roots, ...orphanedCycle], childrenOf };
}

export function VersionGraph({ sessionId, gameId, tests, headVersionId, lapsByTest, metricsById, onOpenReview }: VersionGraphProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [notesForId, setNotesForId] = useState<number | null>(null);
  const [setupForId, setSetupForId] = useState<number | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [compareFirstId, setCompareFirstId] = useState<number | null>(null);
  const [compareSecondId, setCompareSecondId] = useState<number | null>(null);
  const setupTest = setupForId != null ? (tests.find((t) => t.id === setupForId) ?? null) : null;
  // F1: setup lives as an F1CarSetup JSON snapshot on the node, not a file.
  const setupSnapshot = useMemo<F1CarSetup | null>(() => {
    if (!setupTest?.setupSnapshot) return null;
    try {
      const v = JSON.parse(setupTest.setupSnapshot);
      return typeof v === "object" && v !== null ? (v as F1CarSetup) : null;
    } catch {
      return null;
    }
  }, [setupTest]);
  const setHead = useSetHead();
  const deleteVersion = useDeleteVersion();
  const restoreVersion = useRestoreVersion();
  const { data: deletedTests = [], isLoading: loadingTrash, isError: trashError } = useDeletedExperimentVersions(sessionId, trashOpen);
  const comparison = useExperimentArmComparison(sessionId, compareFirstId, compareSecondId);
  const compareTest = (id: number) => {
    if (compareFirstId == null || compareFirstId === id) {
      setCompareFirstId(id);
      setCompareSecondId(null);
      return;
    }
    setCompareSecondId(id);
  };
  // Focus eras, keyed by the version the driver was sitting on when they
  // switched — this is why the ledger records fromVersionId at all. Marking the
  // node makes "v1-v3 were setup work, then I moved to my braking" visible in
  // the tree instead of only in the history modal.
  const { data: focusEvents = [] } = useExperimentFocusHistory(sessionId);
  const focusEraByVersionId = useMemo(() => {
    const m = new Map<number, ExperimentFocus>();
    // Skip the opening entry: it has no fromVersionId and marks nothing.
    for (const e of focusEvents) if (e.fromVersionId != null) m.set(e.fromVersionId, e.focus);
    return m;
  }, [focusEvents]);
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
  // cyclic parentVersionId (A's parent is B, B's parent is A) can't recurse
  // forever: once a node has been rendered once, it's never visited again.
  const rendered = new Set<number>();

  const renderNode = (t: ExperimentVersion, depth: number, isLastSibling: boolean): React.ReactNode => {
    if (rendered.has(t.id)) return null;
    rendered.add(t.id);

    const isHead = t.id === headVersionId;
    const isOpen = expanded.has(t.id);
    const laps = lapsByTest.get(t.id) ?? [];
    // Row stats describe the laps the *analysis* uses, not every lap stamped
    // against the version: same selector as the server auto-exclude pass,
    // /line-spread and the LapBreakdown badges, so the summary can't claim a
    // best/avg/fuel figure that came from a lap the review threw away
    // (out lap, pit cycle, manual exclude, slower than the fastest-N cap).
    const evalLaps = selectEvaluationLaps(laps).chosen;
    const bestT = evalLaps.length ? Math.min(...evalLaps.map((l) => l.lapTime)) : null;
    const worstT = evalLaps.length ? Math.max(...evalLaps.map((l) => l.lapTime)) : null;
    const avgT = evalLaps.length ? evalLaps.reduce((s, l) => s + l.lapTime, 0) / evalLaps.length : null;
    const fuelVals = evalLaps.map((l) => metricsById.get(l.id)?.fuelPerLap).filter((v): v is number => v != null);
    const avgFuel = fuelVals.length ? fuelVals.reduce((s, v) => s + v, 0) / fuelVals.length : null;
    // Per-lap worst-tyre value (max across corners, computed server-side),
    // averaged across the evaluated laps.
    const tyreVals = evalLaps.map((l) => metricsById.get(l.id)?.tyreWear).filter((v): v is number => v != null);
    const avgWorstWear = tyreVals.length ? tyreVals.reduce((s, v) => s + v, 0) / tyreVals.length : null;
    const children = (childrenOf.get(t.id) ?? []).filter((c) => !rendered.has(c.id));
    const hasChildren = children.length > 0;

    return (
      <div key={t.id}>
        <div className="relative flex">
          {/* Graph rail: node dot; branch lines are drawn by the children
              container's border-l plus this horizontal elbow tick back to it. */}
          <div className="relative w-6 shrink-0 flex flex-col items-center">
            {depth > 0 && <div className="absolute -left-3 top-[15px] w-[24px] h-px bg-app-border" />}
            {(!isLastSibling || hasChildren) && <div className="absolute top-3 bottom-0 w-px bg-app-border" />}
            <div className={`z-10 mt-[10px] size-2.5 rounded-full border-2 ${isHead ? "bg-app-accent border-app-accent" : "bg-app-surface border-app-text-dim"}`} title={isHead ? "HEAD" : undefined} />
          </div>

          <div className="flex-1 min-w-0 pb-2">
            {/* div (not button): the row contains nested buttons (Checkout/Setup/Notes/…), and <button> cannot nest <button> (hydration error) */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => toggle(t.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle(t.id);
                }
              }}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer hover:bg-app-surface-hover/40"
            >
              <span className="text-app-text-dim text-xs w-3">{isOpen ? "▾" : "▸"}</span>
              <span className="font-mono text-xs text-app-text shrink-0">{t.label}</span>
              {focusEraByVersionId.has(t.id) && (
                <Badge
                  variant="neutral"
                  size="compact"
                  title={`Focus switched to ${EXPERIMENT_FOCUS_LABELS[focusEraByVersionId.get(t.id)!]} here`}
                  className={`border bg-transparent text-app-micro uppercase tracking-wider rounded px-1 py-px shrink-0 ${
                    focusEraByVersionId.get(t.id) === "driver" ? "text-(--focus-driver) border-(--focus-driver)/40" : "text-(--focus-setup) border-(--focus-setup)/40"
                  }`}
                >
                  → {EXPERIMENT_FOCUS_LABELS[focusEraByVersionId.get(t.id)!]}
                </Badge>
              )}
              <span className="text-app-compact text-app-text-muted truncate min-w-0">
                {t.notes || (summarizeAppliedChanges(t.appliedChanges) ?? (t.parentVersionId == null ? (t.setupPath?.split(/[\\/]/).pop() ?? "Base setup") : "no changes recorded"))}
              </span>
              {isHead && (
                <Badge variant="success" size="compact">
                  HEAD
                </Badge>
              )}
              {!isHead && (
                <Button
                  variant="app-outline"
                  size="app-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setHead.mutate({ sessionId, versionId: t.id });
                  }}
                  disabled={setHead.isPending}
                  className="normal-case tracking-normal font-sans shrink-0"
                >
                  Checkout
                </Button>
              )}
              {gameId && (gameId === "f1-2025" ? t.setupSnapshot != null : t.setupPath != null) && (
                <Button
                  variant="app-outline"
                  size="app-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    setSetupForId(t.id);
                  }}
                  title="View this version's setup file contents"
                  className="normal-case tracking-normal font-sans"
                >
                  Setup
                </Button>
              )}
              {onOpenReview && (
                <Button
                  variant="app-outline"
                  size="app-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenReview(t);
                  }}
                  className="normal-case tracking-normal font-sans shrink-0"
                >
                  Review
                </Button>
              )}
              <Button
                variant={compareFirstId === t.id ? "app-primary" : "app-outline"}
                size="app-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  compareTest(t.id);
                }}
                className="normal-case tracking-normal font-sans shrink-0"
              >
                {compareFirstId === t.id ? "Compare selected" : "Compare"}
              </Button>
              <Button
                variant="app-outline"
                size="app-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setNotesForId(t.id);
                }}
                title={t.driverComment || t.notes ? "View / edit notes" : "Add notes"}
                className="normal-case tracking-normal font-sans shrink-0 inline-flex items-center gap-1"
              >
                Notes
                {(t.driverComment || t.notes) && <span className="size-1.5 rounded-full bg-app-accent" />}
              </Button>
              <Button
                variant="app-ghost"
                size="app-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  const extra = hasChildren ? " and its whole branch" : "";
                  if (!window.confirm(`Delete "${t.label}"${extra}? This can be restored from the trash.`)) return;
                  deleteVersion.mutate({ sessionId, versionId: t.id });
                }}
                disabled={deleteVersion.isPending}
                title={hasChildren ? "Trash this version and its whole branch (reversible)" : "Trash this version (reversible)"}
                className="normal-case tracking-normal font-sans text-status-danger hover:bg-status-danger/10 shrink-0"
              >
                Delete branch
              </Button>
              <span
                className="ml-auto flex items-center gap-3 shrink-0 text-app-compact tabular-nums"
                title={`Averages/best/worst over the ${evalLaps.length} evaluated lap${evalLaps.length === 1 ? "" : "s"} of ${laps.length} recorded — the same laps the review analyses. Excluded: invalid, pit/out laps, manually excluded, and laps slower than the fastest-${REVIEW_LAP_CAP} cap.`}
              >
                {/* The whole row is eval-only, not "all laps recorded against
                    this version" — say so once here rather than qualifying
                    every stat label. */}
                <span className="text-app-nano uppercase tracking-wider text-status-success/70 whitespace-nowrap self-end leading-tight">eval laps</span>
                {/* eval/total: every other stat on this row is eval-only, so
                    show both counts rather than a bare total that doesn't
                    match the numbers next to it. */}
                <RowStat label="eval/all" value={`${evalLaps.length}/${laps.length}`} width="w-[7ch]" />
                <RowStat label="avg" value={avgT != null ? formatLapTime(avgT) : "-:--.---"} />
                <RowStat label="best" value={bestT != null ? formatLapTime(bestT) : "-:--.---"} />
                <RowStat label="worst" value={worstT != null ? formatLapTime(worstT) : "-:--.---"} />
                <RowStat label="fuel/lap" value={avgFuel != null ? `${avgFuel.toFixed(2)}L` : "—"} width="w-[7ch]" />
                <RowStat label="worst wear" value={avgWorstWear != null ? `${avgWorstWear.toFixed(0)}%` : "—"} width="w-[10ch]" />
              </span>
            </div>
            {isOpen && (
              <div className="ml-3 border border-app-border/60 rounded-md overflow-hidden bg-app-surface/40">
                <AppliedChangesList json={t.appliedChanges} />
                <LapBreakdown laps={laps} bestT={bestT} metricsById={metricsById} experimentId={sessionId} />
              </div>
            )}
          </div>
        </div>
        {hasChildren && <div className="ml-3 pl-3 border-l border-app-border">{children.map((c, i) => renderNode(c, depth + 1, i === children.length - 1))}</div>}
      </div>
    );
  };

  const actionError = setHead.error ?? deleteVersion.error ?? restoreVersion.error;
  const notesTest = notesForId != null ? (tests.find((t) => t.id === notesForId) ?? null) : null;
  const compareA = compareFirstId != null ? tests.find((t) => t.id === compareFirstId) : null;
  const compareB = compareSecondId != null ? tests.find((t) => t.id === compareSecondId) : null;

  return (
    <div className="py-1">
      {notesTest && <NotesModal sessionId={sessionId} test={notesTest} onClose={() => setNotesForId(null)} />}
      {(gameId === "acc" || gameId === "ac-evo") && setupTest?.setupPath && (
        <SetupContentModal gameId={gameId} path={setupTest.setupPath} fileName={setupTest.setupPath.split(/[\\/]/).pop() ?? setupTest.label} onClose={() => setSetupForId(null)} />
      )}
      {gameId === "f1-2025" && setupSnapshot && <F1SetupModal setup={setupSnapshot} onClose={() => setSetupForId(null)} />}
      {actionError && <div className="mx-2 mb-1 rounded-md border border-status-danger/40 bg-status-danger/10 px-2 py-1 text-app-compact text-status-danger">{(actionError as Error).message}</div>}
      <div className="mx-2 mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-app-text-dim">
          {compareFirstId == null
            ? "Select two versions to compare."
            : compareSecondId == null
              ? "Select one more version to compare."
              : `Comparing ${compareA?.label ?? "version"} vs ${compareB?.label ?? "version"}.`}
        </span>
        <Button variant="app-outline" size="app-sm" onClick={() => setTrashOpen(true)}>
          Trash
        </Button>
      </div>
      {roots.map((t, i) => renderNode(t, 0, i === roots.length - 1))}
      {compareFirstId != null && compareSecondId != null && (
        <Dialog open onOpenChange={(open) => !open && (setCompareFirstId(null), setCompareSecondId(null))}>
          <DialogContent size="md" showCloseButton={false} layout="scrollable">
            <DialogHeader>
              <DialogTitle>Version comparison</DialogTitle>
            </DialogHeader>
            {comparison.isLoading && <div className="text-sm text-app-text-dim">Comparing versions…</div>}
            {comparison.isError && <div className="text-sm text-status-danger">{(comparison.error as Error).message}</div>}
            {comparison.data && (
              <div className="space-y-2 text-sm">
                <div className="font-medium text-app-text">
                  {comparison.data.a.label} vs {comparison.data.b.label}
                </div>
                <div className="text-app-text-dim">
                  {comparison.data.metricLabel}: {comparison.data.significance}
                </div>
                <div className="text-app-text-dim">
                  Samples: {comparison.data.a.n} vs {comparison.data.b.n}
                </div>
                <div className="text-app-text-dim">Mean delta: {comparison.data.deltaMean == null ? "—" : `${comparison.data.deltaMean.toFixed(3)} ${comparison.data.unit}`}</div>
                {comparison.data.reason && <div className="text-status-warning">{comparison.data.reason}</div>}
                {comparison.data.underpowered && <div className="text-status-warning">More laps needed for a reliable comparison.</div>}
              </div>
            )}
            <Button variant="app-outline" size="app-sm" onClick={() => (setCompareFirstId(null), setCompareSecondId(null))}>
              Close
            </Button>
          </DialogContent>
        </Dialog>
      )}
      {trashOpen && (
        <Dialog open onOpenChange={(open) => !open && setTrashOpen(false)}>
          <DialogContent size="md" showCloseButton={false} layout="scrollable">
            <DialogHeader>
              <DialogTitle>Deleted branches</DialogTitle>
            </DialogHeader>
            {loadingTrash && <div className="text-sm text-app-text-dim">Loading trash…</div>}
            {trashError && <div className="text-sm text-status-danger">Could not load deleted branches.</div>}
            {!loadingTrash && !trashError && deletedTests.length === 0 && <div className="text-sm text-app-text-dim">Trash is empty.</div>}
            <div className="space-y-2">
              {deletedTests
                .filter((t) => t.parentVersionId == null || !deletedTests.some((parent) => parent.id === t.parentVersionId))
                .map((t) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 rounded border border-app-border px-2 py-1.5">
                    <span className="text-sm text-app-text">{t.label}</span>
                    <Button variant="app-outline" size="app-sm" onClick={() => restoreVersion.mutate({ sessionId, versionId: t.id })} disabled={restoreVersion.isPending}>
                      Restore
                    </Button>
                  </div>
                ))}
            </div>
            <Button variant="app-outline" size="app-sm" onClick={() => setTrashOpen(false)}>
              Close
            </Button>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
