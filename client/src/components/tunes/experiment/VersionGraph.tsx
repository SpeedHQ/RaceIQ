import { EXPERIMENT_FOCUS_LABELS, type ExperimentFocus } from "@shared/racing/experiments/focus";
import { REVIEW_LAP_CAP, selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import type { LapMeta } from "@shared/racing/sessions/types";
import type { F1CarSetup } from "@shared/telemetry/f1-2025";
import { Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { F1SetupModal } from "@/components/analyse/F1SetupModal";
import { SetupContentModal } from "@/components/tunes/SetupFilePicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type ExperimentLapMetric, type ExperimentVersion, useExperimentFocusHistory, useSetHead } from "@/hooks/experiments";
import { useDeleteVersion, useDeletedExperimentVersions, useRestoreVersion } from "@/hooks/experiment-history";
import { formatLapTime } from "@/lib/format";
import { AppliedChangesList } from "./AppliedChangesList";
import { summarizeAppliedChanges } from "./applied-changes";
import { LapBreakdown } from "./LapBreakdown";
import { NotesModal } from "./VersionGraphEditors";
import { RecursiveVersionRows } from "./VersionGraphRows";
import { buildForest } from "./version-graph-model";

function RowStat({ label, value, width }: { label: string; value: string; width?: string }) {
  return (
    <span className={`inline-flex flex-col text-right leading-tight ${width ?? "min-w-[5ch]"}`}>
      <span className="text-app-nano uppercase tracking-wider text-app-text-muted">{label}</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

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

export function VersionGraph({ sessionId, gameId, tests, headVersionId, lapsByTest, metricsById, onOpenReview }: VersionGraphProps) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [notesForId, setNotesForId] = useState<number | null>(null);
  const [setupForId, setSetupForId] = useState<number | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const deleteVersion = useDeleteVersion();
  const restoreVersion = useRestoreVersion();
  const setHead = useSetHead();
  const { data: deletedTests = [], isLoading: loadingTrash, isError: trashError } = useDeletedExperimentVersions(sessionId, trashOpen);
  const deletedRoots = useMemo(() => {
    const deletedParentIds = new Set(deletedTests.map((t) => t.id));
    return deletedTests.filter((t) => t.parentVersionId == null || !deletedParentIds.has(t.parentVersionId));
  }, [deletedTests]);
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



  const renderNode = (t: ExperimentVersion, depth: number, isLastSibling: boolean): React.ReactNode => {
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
    const children = childrenOf.get(t.id) ?? [];
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

          <details
            open={isOpen}
            onToggle={(event) => {
              if (event.currentTarget.open !== isOpen) toggle(t.id);
            }}
            className="flex-1 min-w-0 pb-2"
          >
            <summary className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left cursor-pointer hover:bg-app-surface-hover/40 list-none [&::-webkit-details-marker]:hidden">
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
                variant="app-outline"
                size="app-sm"
                onClick={(e) => {
                  e.stopPropagation();
                  const confirmMessage = children.length > 0 ? "Delete this branch and all its descendants?" : "Delete this version?";
                  if (!window.confirm(confirmMessage)) {
                    return;
                  }
                  deleteVersion.mutate({ sessionId, versionId: t.id });
                }}
                disabled={deleteVersion.isPending}
                aria-label={children.length > 0 ? "Delete branch" : "Delete version"}
                title={children.length > 0 ? "Delete branch" : "Delete version"}
                className="normal-case tracking-normal font-sans shrink-0 inline-flex items-center gap-1"
              >
                <Trash2 aria-hidden="true" />
                {children.length > 0 ? "Delete branch" : "Delete version"}
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
            </summary>
            {isOpen && (
              <div className="ml-3 border border-app-border/60 rounded-md overflow-hidden bg-app-surface/40">
                <AppliedChangesList json={t.appliedChanges} />
                <LapBreakdown laps={laps} bestT={bestT} metricsById={metricsById} experimentId={sessionId} />
              </div>
            )}
          </details>
        </div>
        {/* Recursive branch layout lives in experiment/VersionGraphRows. */}
      </div>
    );
  };

  const actionError = setHead.error ?? deleteVersion.error ?? restoreVersion.error;
  const notesTest = notesForId != null ? (tests.find((t) => t.id === notesForId) ?? null) : null;

  return (
    <div className="py-1">
      {notesTest && <NotesModal sessionId={sessionId} test={notesTest} onClose={() => setNotesForId(null)} />}
      {(gameId === "acc" || gameId === "ac-evo") && setupTest?.setupPath && (
        <SetupContentModal gameId={gameId} path={setupTest.setupPath} fileName={setupTest.setupPath.split(/[\\/]/).pop() ?? setupTest.label} onClose={() => setSetupForId(null)} />
      )}
      {gameId === "f1-2025" && setupSnapshot && <F1SetupModal setup={setupSnapshot} onClose={() => setSetupForId(null)} />}
      <div className="mx-2 mb-2 flex justify-end">
        <Button
          variant="app-outline"
          size="app-sm"
          onClick={() => setTrashOpen(true)}
          className="normal-case tracking-normal font-sans shrink-0 inline-flex items-center gap-1"
        >
          <Trash2 aria-hidden="true" />
          Trash
        </Button>
      </div>
      {actionError && <div className="mx-2 mb-1 rounded-md border border-status-danger/40 bg-status-danger/10 px-2 py-1 text-app-compact text-status-danger">{(actionError as Error).message}</div>}
      <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
        <DialogContent showCloseButton={false} layout="scrollable" overlayClassName="bg-app-bg/60">
          <DialogHeader>
            <DialogTitle>Deleted branches</DialogTitle>
          </DialogHeader>
          <div className="px-4 pb-4 text-sm">
            {loadingTrash && <p className="text-app-text">Loading trash…</p>}
            {!loadingTrash && trashError && <p className="text-status-danger">Could not load deleted branches.</p>}
            {!loadingTrash && !trashError && deletedRoots.length === 0 && <p className="text-app-text-muted">Trash is empty.</p>}
            {!loadingTrash && !trashError && deletedRoots.length > 0 && (
              <div className="space-y-2">
                {deletedRoots.map((t) => (
                  <div key={t.id} className="rounded-md border border-app-border bg-app-surface/40 px-2 py-1.5 text-app-text">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="font-mono text-xs">{t.label}</span>
                      <Button
                        variant="app-outline"
                        size="app-sm"
                        onClick={() => restoreVersion.mutate({ sessionId, versionId: t.id })}
                        disabled={restoreVersion.isPending}
                        aria-label="Restore version"
                      >
                        Restore
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="app-outline" size="app-sm" onClick={() => setTrashOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {tests.length === 0 ? (
        <div className="px-3 py-4 text-center text-xs text-app-text-dim">No setup versions yet. Create the session from a base setup to seed v1, or run Save &amp; recommend.</div>
      ) : (
        <RecursiveVersionRows roots={roots} childrenOf={childrenOf} renderNode={renderNode} />
      )}
    </div>
  );
}
