import { selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import { flipPoints, needsTrackFlip } from "@shared/racing/tracks/coords";
import { useMemo, useState } from "react";
import type { LapMeta } from "../../../../../shared/racing/sessions/types";
import type { TuneIssue } from "../../../../../shared/racing/tuning/issues";
import type { SemanticAnalysisFrame } from "../../analyse/track-map/types";
import type { TelemetryPacket } from "../../../../../shared/telemetry/types";
import type { LineSpreadTrace } from "../../../hooks/experiments";
import { useLineSpread } from "../../../hooks/experiments";
import type { TrackCorner } from "../../../hooks/track-queries";
import { useTrackBoundaries, useTrackCorners, useTrackSectorBoundaries } from "../../../hooks/track-queries";
import { useLapIssues } from "../../../hooks/tunes";
import { useLapSemanticTelemetry } from "../../../hooks/laps";
import { useStintTraces } from "../../../hooks/useStintTraces";
import { type LapTrace, stintStats } from "../../../lib/stint-traces";
import { Button } from "../../ui/button";
import { extractEdges, type Pt, type SectorTimesLite } from "../track-map-geometry";
import { BalanceLanes } from "./BalanceLanes";
import { ConsistencyLanes } from "./ConsistencyLanes";
import { CornerLedger } from "./CornerLedger";
import { detectCorners } from "./detect-corners";
import { GripPanel } from "./GripPanel";
import { IssuesList } from "./IssuesList";
import { SectorLedger } from "./SectorLedger";
import { SuspensionLanes } from "./SuspensionLanes";
import { TiresPanel } from "./TiresPanel";
import { TrackFocusMap } from "./TrackFocusMap";
import { TrackFocusZoom } from "./TrackFocusZoom";

interface TrackFocusViewProps {
  gameId: "acc" | "ac-evo" | "fm-2023" | "f1-2025";
  laps: LapMeta[];
  trackOrdinal?: number;
  /** Controlled focus lap (null = "All" — falls back to the best lap for map/telemetry). Omit for internal state. */
  focusLapId?: number | null;
  onFocusLap?: (lapId: number) => void;
  /** Experiment id, when this view is hosted inside an experiment
   *  review (drives the /line-spread racing-line consistency query). Omit to
   *  hide the line-spread lane + map overlay (e.g. Storybook, non-tuning contexts). */
  experimentId?: number | null;
}

const TABS = ["consistency", "tires", "balance", "suspension"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { consistency: "Consistency", tires: "Tires & grip", balance: "Balance", suspension: "Suspension" };

/** Data-fetching wrapper: resolves the stint's laps into downsampled traces,
 *  the focus lap's raw telemetry, issues, and track corners, then hands
 *  everything to the presentational `TrackFocusViewInner`. */
export function TrackFocusView({ gameId, laps, trackOrdinal, focusLapId: controlledFocusId, onFocusLap: controlledOnFocusLap, experimentId }: TrackFocusViewProps) {
  // Invalid laps are excluded from the whole Track Focus view —
  // traces, stats, best-lap, ledgers and tyres all read `stintLaps`.
  const stintLaps = useMemo(() => laps.filter((l) => l.isValid).sort((a, b) => a.lapNumber - b.lapNumber), [laps]);
  // Per-frame telemetry (traces, consistency lanes, tyres) runs on the fastest
  // N clean laps — bounds decode + payload on long tracks. Header stats read
  // the same pool. Matches the server /line-spread pool.
  // Fastest valid, non-excluded laps — matches the server /line-spread clean
  // pool. Routed through the shared selector so the traces rendered here are
  // exactly the laps the UI badges as "Eval" (see shared/racing/laps/review-selection.ts);
  // the old local fastestLaps() trim could disagree when auto-exclude had
  // never run for the scope. Filter from `laps`, not `stintLaps`: the selector
  // applies the valid/legacy/pit rules itself and reports why each lap fell out.
  const reviewLaps = useMemo(() => selectEvaluationLaps(laps).chosen, [laps]);
  const { traces } = useStintTraces(reviewLaps);
  const { data: lineSpread } = useLineSpread(experimentId);

  const bestLapId = useMemo(() => {
    let best: LapMeta | null = null;
    for (const l of stintLaps) {
      if (!l.isValid || l.experimentExcluded) continue;
      if (best == null || l.lapTime < best.lapTime) best = l;
    }
    return best?.id ?? null;
  }, [stintLaps]);

  const [localFocusId, setLocalFocusId] = useState<number | null>(null);
  const focusLapId = controlledFocusId !== undefined ? controlledFocusId : localFocusId;
  const setFocusLapId = controlledOnFocusLap ?? setLocalFocusId;
  const effectiveFocusId = focusLapId ?? bestLapId ?? stintLaps[stintLaps.length - 1]?.id ?? null;

  const { data: focusTel } = useLapSemanticTelemetry(effectiveFocusId);
  const { data: issues } = useLapIssues(effectiveFocusId);
  const { data: bounds } = useTrackBoundaries(trackOrdinal, gameId);
  const { data: corners } = useTrackCorners(trackOrdinal, gameId);
  const { data: sectorBoundaries } = useTrackSectorBoundaries(trackOrdinal, gameId);
  // Boundary/outline data is stored in raw game coords; standard-xyz games
  // (ACC, AC Evo) have their telemetry PositionX negated by the pipeline, so
  // flip the edges to match — same convention AnalyseTrackMap uses. Without
  // this the driven line (negated telemetry) and the track edges (raw) are
  // X-mirror images of each other and don't overlay.
  const edges = useMemo(() => {
    const e = extractEdges(bounds);
    if (!e || !needsTrackFlip(gameId)) return e;
    return { left: flipPoints(e.left), right: flipPoints(e.right) };
  }, [bounds, gameId]);

  const metaSectors = useMemo(() => {
    const s1End = sectorBoundaries?.s1End;
    const s2End = sectorBoundaries?.s2End;
    if (typeof s1End !== "number" || typeof s2End !== "number") return null;
    if (!(s1End > 0 && s1End < s2End && s2End < 1)) return null;
    return { s1End, s2End };
  }, [sectorBoundaries?.s1End, sectorBoundaries?.s2End]);

  // Stats read the same eval-lap pool as the traces/lanes/ledgers below. Using
  // the full stintLaps here made the header disagree with everything under it
  // (out-laps and scrappy laps dragged the averages/degradation around while
  // the line + consistency views only ever showed the chosen laps).
  const stats = useMemo(() => stintStats(reviewLaps, { dropOutLap: false }), [reviewLaps]);

  return (
    <TrackFocusViewInner
      laps={stintLaps}
      traces={traces}
      bestLapId={bestLapId}
      focusLapId={effectiveFocusId}
      onFocusLap={setFocusLapId}
      focusTelemetry={focusTel?.envelopes.map((e) => ({ values: Object.fromEntries(e.values.map((v) => [v.semanticId, v.value])), states: {}, freshness: {} })) ?? null}
      focusSectorTimes={focusTel?.sectorTimes ? { times: focusTel.sectorTimes, boundaryIndices: focusTel.sectorStarts ?? [] } : null}
      edges={edges}
      corners={corners ?? []}
      issues={issues ?? []}
      stats={stats}
      lineSpread={lineSpread ?? null}
      metaSectors={metaSectors}
      shownLapCount={reviewLaps.length}
      totalLapCount={stintLaps.length}
    />
  );
}

export interface TrackFocusViewInnerProps {
  laps: LapMeta[];
  traces: (LapTrace | undefined)[];
  bestLapId: number | null;
  focusLapId: number | null;
  onFocusLap: (lapId: number) => void;
  focusTelemetry: SemanticAnalysisFrame[] | null;
  focusSectorTimes: SectorTimesLite | null;
  edges: { left: Pt[]; right: Pt[] } | null;
  corners: TrackCorner[];
  issues: TuneIssue[];
  stats: ReturnType<typeof stintStats>;
  /** Trimmed racing-line spread trace (null while loading, no session, or too
   *  few clean laps — lane + map overlay render their empty state). */
  lineSpread: LineSpreadTrace | null;
  /** Authoritative sector boundary fractions from track meta, when available.
   *  Falls back to the focus lap's per-lap sector-index split. */
  metaSectors?: { s1End: number; s2End: number } | null;
  /** Laps actually analysed in the per-frame views (fastest N). */
  shownLapCount?: number;
  /** Total eligible laps in the stint (for the "showing N of M" caption). */
  totalLapCount?: number;
}

/** Presentational Track Focus view — no data fetching, so it can be driven
 *  entirely from Storybook fixtures. Owns the local `cursorFrac` (synced
 *  across the map + all lanes) and `activeTab` state; everything else is
 *  passed in already resolved. */
export function TrackFocusViewInner({
  traces,
  bestLapId,
  focusTelemetry,
  focusSectorTimes,
  edges,
  corners,
  issues,
  stats,
  lineSpread,
  metaSectors,
  shownLapCount,
  totalLapCount,
}: TrackFocusViewInnerProps) {
  const [cursorFrac, setCursorFrac] = useState<number | null>(null);
  const [hoverPoints, setHoverPoints] = useState<{ brake: number[]; throttle: number[] } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("consistency");
  const [zoomActive, setZoomActive] = useState(false);

  const resolvedTraces = useMemo(() => traces.filter((t): t is LapTrace => !!t), [traces]);

  // Corners are now returned as lap fractions (0..1) by the server — either
  // from curated track meta or meters-converted-to-fraction DB corners. No
  // per-lap odometer rebasing needed. When a corner has no apexDistance
  // (curated meta doesn't know the apex), find the min-speed point within
  // its [distanceStart, distanceEnd] span on the best available trace.
  const cornerFracs = useMemo(() => {
    if (corners.length === 0) return [];
    const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
    const bestTrace = resolvedTraces.find((t) => t.lapId === bestLapId) ?? resolvedTraces[0];

    return corners.map((c) => {
      if (c.apexDistance != null) return clamp01(c.apexDistance);
      const start = c.distanceStart;
      const end = c.distanceEnd;
      if (!bestTrace) return clamp01((start + end) / 2);

      const { frac, speedKmh } = bestTrace;
      let apexFrac: number | null = null;
      let minSpeed = Infinity;
      for (let i = 0; i < frac.length; i++) {
        const f = frac[i];
        if (f < start || f > end) continue;
        if (speedKmh[i] < minSpeed) {
          minSpeed = speedKmh[i];
          apexFrac = f;
        }
      }
      return clamp01(apexFrac ?? (start + end) / 2);
    });
  }, [corners, resolvedTraces, bestLapId]);

  // Sector boundary fractions: prefer authoritative track meta, else fall
  // back to the focus lap's source-defined sector split indices so the sector ledger's rows line up
  // with what the map shows.
  const sectorBoundaryFracs = useMemo(() => {
    if (metaSectors) return [metaSectors.s1End, metaSectors.s2End];
    if (!focusTelemetry || focusTelemetry.length < 2 || !focusSectorTimes) return [];
    const last = focusTelemetry.length - 1;
    return focusSectorTimes.boundaryIndices.map((index) => index / last);
  }, [metaSectors, focusTelemetry, focusSectorTimes]);

  // Corners + apex fractions shared by the track map and the corner ledger:
  // real metadata when available, else the same telemetry-based apex
  // detection the ledger falls back to, so both surfaces agree.
  const effectiveCorners = useMemo(() => {
    if (corners.length > 0) return { corners, fracs: cornerFracs };
    const bestTrace = resolvedTraces.find((t) => t.lapId === bestLapId) ?? resolvedTraces[0];
    if (!bestTrace) return { corners: [], fracs: [] };
    return detectCorners(bestTrace);
  }, [corners, cornerFracs, resolvedTraces, bestLapId]);

  return (
    <div className="flex flex-col h-full min-h-0 p-4 gap-4">
      {/* Stat strip */}
      <div className="grid flex-none grid-cols-2 gap-2 @3xl/workspace:grid-cols-3 @5xl/workspace:grid-cols-6">
        <StatCell label="Consistency" value={stats.consistency != null ? stats.consistency.toFixed(0) : "—"} unit={stats.consistency != null ? "%" : undefined} />
        <StatCell label="Std dev" value={stats.sdS != null ? stats.sdS.toFixed(3) : "—"} unit={stats.sdS != null ? "s" : undefined} />
        <StatCell label="Best" value={stats.bestS != null ? stats.bestS.toFixed(3) : "—"} unit={stats.bestS != null ? "s" : undefined} />
        <StatCell label="Mean" value={stats.meanS != null ? stats.meanS.toFixed(3) : "—"} unit={stats.meanS != null ? "s" : undefined} />
        <StatCell
          label="Degradation"
          value={stats.degSlopeSPerLap != null ? `${stats.degSlopeSPerLap >= 0 ? "+" : ""}${stats.degSlopeSPerLap.toFixed(3)}` : "—"}
          unit={stats.degSlopeSPerLap != null ? "s/lap" : undefined}
        />
        <StatCell label="Issues" value={String(issues.length)} />
      </div>

      {shownLapCount != null && totalLapCount != null && totalLapCount > shownLapCount && (
        <p className="flex-none text-xs text-muted-foreground -mt-2">
          Stats, line + consistency views all use the {shownLapCount} fastest of {totalLapCount} laps.
        </p>
      )}

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 @5xl/workspace:grid-cols-[460px_minmax(0,1fr)]">
        {/* Left column: track map (static) + issues list (own scroll). */}
        <div className="flex flex-col gap-3 min-h-0 min-w-0">
          <div className="flex-none">
            {zoomActive && lineSpread?.lapLines?.length && cursorFrac != null ? (
              <TrackFocusZoom lapLines={lineSpread.lapLines} bestLapId={bestLapId} cursorFrac={cursorFrac} edges={edges} />
            ) : (
              <TrackFocusMap
                telemetry={focusTelemetry as unknown as TelemetryPacket[]}
                sectorTimes={focusSectorTimes as unknown as SectorTimesLite}
                edges={edges}
                corners={effectiveCorners.corners}
                cornerFracs={effectiveCorners.fracs}
                issues={issues}
                cursorFrac={cursorFrac}
                onCursorFrac={setCursorFrac}
                overlayPoints={hoverPoints}
                lineSpread={activeTab === "consistency" ? lineSpread : null}
              />
            )}
          </div>
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="flex-none text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Issues</div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <IssuesList issues={issues} onIssueClick={setCursorFrac} />
            </div>
          </div>
        </div>

        {/* Right pane: tabbed lanes — header static, lane content scrolls. */}
        <div className="flex flex-col gap-3 min-h-0 min-w-0">
          <div className="flex-none flex gap-1 flex-wrap">
            {TABS.map((t) => (
              <Button
                key={t}
                variant="app-ghost"
                size="app-sm"
                onClick={() => setActiveTab(t)}
                className={`!border text-xs ${activeTab === t ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
              >
                {TAB_LABELS[t]}
              </Button>
            ))}
          </div>

          {/* Lane content owns its own scroll. */}
          <div className="flex-1 min-h-0 overflow-y-auto space-y-3">
            {activeTab === "consistency" && (
              <>
                <ConsistencyLanes
                  traces={resolvedTraces}
                  bestLapId={bestLapId}
                  cornerFracs={effectiveCorners.fracs}
                  corners={effectiveCorners.corners}
                  issues={issues}
                  cursorFrac={cursorFrac}
                  onCursorFrac={setCursorFrac}
                  lineSpread={lineSpread}
                  onZoomHover={setZoomActive}
                />
                <SectorLedger traces={resolvedTraces} bestLapId={bestLapId} sectorBoundaryFracs={sectorBoundaryFracs} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />
                <CornerLedger
                  traces={resolvedTraces}
                  bestLapId={bestLapId}
                  cornerFracs={cornerFracs}
                  corners={corners}
                  cursorFrac={cursorFrac}
                  onCursorFrac={setCursorFrac}
                  onHoverPoints={setHoverPoints}
                />
              </>
            )}
            {activeTab === "tires" && (
              <>
                <TiresPanel traces={traces} bestLapId={bestLapId} cornerFracs={cornerFracs} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />
                <div className="pt-3 mt-1 border-t border-app-border">
                  <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-2">Grip</div>
                  <GripPanel
                    traces={resolvedTraces}
                    bestLapId={bestLapId}
                    cornerFracs={effectiveCorners.fracs}
                    corners={effectiveCorners.corners}
                    cursorFrac={cursorFrac}
                    onCursorFrac={setCursorFrac}
                  />
                </div>
              </>
            )}
            {activeTab === "balance" && (
              <BalanceLanes
                traces={resolvedTraces}
                bestLapId={bestLapId}
                cornerFracs={effectiveCorners.fracs}
                corners={effectiveCorners.corners}
                cursorFrac={cursorFrac}
                onCursorFrac={setCursorFrac}
              />
            )}
            {activeTab === "suspension" && <SuspensionLanes traces={traces} bestLapId={bestLapId} cornerFracs={cornerFracs} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded bg-app-surface border border-app-border px-3 py-2">
      <div className="text-app-caption uppercase tracking-wider text-app-text-dim">{label}</div>
      <div className="text-base font-mono tabular-nums text-app-text">
        {value}
        {unit && <span className="text-app-caption text-app-text-dim ml-1">{unit}</span>}
      </div>
    </div>
  );
}
