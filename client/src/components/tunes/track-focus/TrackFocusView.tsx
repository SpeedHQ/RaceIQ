import { flipPoints, needsTrackFlip } from "@shared/racing/tracks/coords";
import { useMeasuredWidth } from "./use-measured-width";
import { useCallback, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import type { GameId } from "../../../../../shared/games/ids";
import type { LapMeta } from "../../../../../shared/racing/sessions/types";
import type { AlignedLapTrace, WheelAverages } from "@shared/racing/laps/alignment/types";
import type { TuneIssue } from "../../../../../shared/racing/tuning/issues";
import type { LineSpreadTrace } from "../../../hooks/experiments";
import { useLineSpread } from "../../../hooks/experiments";
import type { TrackCorner } from "../../../hooks/track-queries";
import { useTrackBoundaries, useTrackCorners, useTrackSectorBoundaries } from "../../../hooks/track-queries";
import { useLapIssues } from "../../../hooks/tunes";
import { useAlignedTelemetryZoom } from "../../../hooks/useAlignedTelemetryZoom";
import { semanticTuneSamplesFromAlignedTrace, type SemanticTuneSample } from "../semantic-tune";
import type { TuneReviewTrackTab } from "../../../lib/game-routes";
import { m } from "../../../paraglide/messages";
import { extractEdges, type Pt, type SectorTimesLite } from "../track-map-geometry";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { BalanceLanes } from "./BalanceLanes";
import { ConsistencyLanes } from "./ConsistencyLanes";
import { SegmentLedger } from "./SegmentLedger";
import { detectCorners } from "./detect-corners";
import { GripPanel } from "./GripPanel";
import { IssuesList } from "./IssuesList";
import { BrakingPanel } from "./BrakingPanel";
import { ThrottleExitPanel } from "./ThrottleExitPanel";
import { SectorLedger } from "./SectorLedger";
import { SpeedRangeLegend } from "./SpeedRangeLegend";
import { TrackZoomHint } from "./TrackZoomHint";
import { SuspensionLanes } from "./SuspensionLanes";
import { TiresPanel } from "./TiresPanel";
import { TrackFocusMap } from "./TrackFocusMap";
import { tryGetGame } from "@shared/games/registry";
import type { TrackFocusTrace } from "./types";
import { TrackFocusZoom } from "./TrackFocusZoom";
function alignedToLapTrace(t: AlignedLapTrace): TrackFocusTrace {
  const averages = (value: WheelAverages | null) => (value ? { FL: value.FL, FR: value.FR, RL: value.RL, RR: value.RR } : null);
  return {
    lapId: t.lapId,
    lapNumber: t.lapNumber,
    isValid: t.isValid,
    n: t.speedMps.length,
    frac: t.frac,
    throttle: t.throttle,
    brake: t.brake,
    steer: t.steer,
    speedKmh: Float32Array.from(t.speedMps, (v) => v * 3.6),
    timeS: t.elapsedTimeS,
    posX: t.positionX,
    posZ: t.positionZ,
    fuel: t.fuel,
    tireWearTrace: t.tireWear,
    tire: averages(t.tireAverages),
    pressure: averages(t.pressureAverages),
    tireTempTrace: t.tireTemp,
    pressureTrace: t.tirePressure,
    balance: t.balanceDeg,
    latG: t.latG,
    longG: t.longG,
    suspTravel: t.suspTravel,
    combinedSlip: t.combinedSlip,
    brakeTemp: averages(t.brakeTempAverages),
    brakeTempTrace: t.brakeTemp,
  };
}

interface TrackFocusViewProps {
  gameId: GameId;
  laps: LapMeta[];
  alignedSet: import("@shared/racing/laps/alignment/types").AlignedLapSet | undefined;
  evaluationLapIds: readonly number[];
  trackOrdinal?: number;
  focusLapId?: number | null;
  onFocusLap?: (lapId: number) => void;
  experimentId?: number | null;
  lineSpreadOverride?: LineSpreadTrace | null;
  activeTab?: TuneReviewTrackTab;
  onActiveTabChange?: (tab: TuneReviewTrackTab) => void;
}

const TABS = ["consistency", "braking", "throttle", "tires", "balance", "suspension"] as const;
const TAB_LABELS: Record<TuneReviewTrackTab, string> = {
  consistency: "Consistency",
  braking: "Braking",
  throttle: "Throttle & exit",
  tires: "Tires & fuel",
  balance: "Balance",
  suspension: "Suspension",
};
/** Data-fetching wrapper: resolves the stint's laps into downsampled traces,
 *  the focus lap's raw telemetry, issues, and track corners, then hands
 *  everything to the presentational `TrackFocusViewInner`. */
export function TrackFocusView({
  gameId,
  laps,
  alignedSet,
  evaluationLapIds,
  trackOrdinal,
  focusLapId: controlledFocusId,
  onFocusLap: controlledOnFocusLap,
  experimentId,
  lineSpreadOverride,
  activeTab,
  onActiveTabChange,
}: TrackFocusViewProps) {
  // Invalid laps are excluded from the whole Track Focus view —
  // traces, stats, best-lap, ledgers and tyres all read `stintLaps`.
  const stintLaps = useMemo(() => laps.filter((l) => l.isValid).sort((a, b) => a.lapNumber - b.lapNumber), [laps]);
  const reviewLaps = laps;
  const zoom = useAlignedTelemetryZoom(evaluationLapIds, alignedSet);
  // Per-frame telemetry (traces, consistency lanes, tyres) runs on the fastest
  // N clean laps — bounds decode + payload on long tracks. Header stats read
  // the same pool. Matches the server /line-spread pool.
  // Fastest valid, non-excluded laps — matches the server /line-spread clean
  // pool. Routed through the shared selector so the traces rendered here are
  // exactly the laps the UI badges as "Eval" (see shared/racing/laps/review-selection.ts);
  // the old local fastestLaps() trim could disagree when auto-exclude had
  // never run for the scope. Filter from `laps`, not `stintLaps`: the selector
  // applies the valid/legacy/pit rules itself and reports why each lap fell out.
  const traces = useMemo(() => (zoom.data ?? alignedSet)?.laps.map(alignedToLapTrace) ?? [], [alignedSet, zoom.data]);
  const baseTraces = useMemo(() => alignedSet?.laps.map(alignedToLapTrace) ?? [], [alignedSet]);
  const visibleLaneRange = useMemo(() => {
    if (!zoom.visibleRange || !alignedSet || alignedSet.nominalSpanMeters <= 0) return null;
    return {
      start: zoom.visibleRange.start / alignedSet.nominalSpanMeters,
      end: zoom.visibleRange.end / alignedSet.nominalSpanMeters,
    };
  }, [alignedSet, zoom.visibleRange]);
  const selectLaneRange = useCallback(
    (startFrac: number, endFrac: number) => {
      if (!alignedSet) return;
      zoom.selectRangeMeters(startFrac * alignedSet.nominalSpanMeters, endFrac * alignedSet.nominalSpanMeters);
    },
    [alignedSet, zoom.selectRangeMeters],
  );
  const { data: fetchedLineSpread } = useLineSpread(activeTab === "consistency" && !lineSpreadOverride ? experimentId : null);
  const lineSpread = lineSpreadOverride ?? fetchedLineSpread ?? null;

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
  const focusTelemetry = useMemo(() => {
    const lap = alignedSet?.laps.find((candidate) => candidate.lapId === effectiveFocusId) ?? alignedSet?.laps[0];
    return lap ? semanticTuneSamplesFromAlignedTrace(lap, gameId, trackOrdinal, alignedSet?.nominalSpanMeters ?? 0) : null;
  }, [alignedSet, effectiveFocusId, gameId, trackOrdinal]);
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
  const focusSectorTimes = useMemo<SectorTimesLite | null>(() => {
    const trace = alignedSet?.laps.find((candidate) => candidate.lapId === effectiveFocusId) ?? alignedSet?.laps[0];
    if (!trace?.sectorTimes || trace.sectorTimes.length < 2 || !trace.sectorStarts) return null;
    const starts = trace.sectorStarts.filter((start) => Number.isFinite(start) && start > 0 && start < 1).slice(0, trace.sectorTimes.length - 1);
    if (starts.length !== trace.sectorTimes.length - 1) return null;
    return { times: trace.sectorTimes, boundaryIndices: starts.map((start) => Math.round(start * Math.max(0, trace.speedMps.length - 1))) };
  }, [alignedSet, effectiveFocusId]);

  return (
    <TrackFocusViewInner
      laps={stintLaps}
      traces={traces}
      bestLapId={bestLapId}
      focusLapId={effectiveFocusId}
      onFocusLap={setFocusLapId}
      focusSectorTimes={focusSectorTimes}
      edges={edges}
      corners={corners ?? []}
      focusTelemetry={focusTelemetry}
      issues={issues ?? []}
      lineSpread={lineSpread ?? null}
      metaSectors={metaSectors}
      gameId={gameId}
      shownLapCount={reviewLaps.length}
      totalLapCount={stintLaps.length}
      activeTab={activeTab}
      onActiveTabChange={onActiveTabChange}
      baseTraces={baseTraces}
      nominalSpanMeters={alignedSet?.nominalSpanMeters ?? 0}
      visibleLaneRange={visibleLaneRange}
      selectLaneRange={selectLaneRange}
      onZoomOut={zoom.zoomOut}
    />
  );
}

export interface TrackFocusViewInnerProps {
  gameId: GameId;
  laps: LapMeta[];
  baseTraces: TrackFocusTrace[];
  traces: (TrackFocusTrace | undefined)[];
  bestLapId: number | null;
  focusLapId: number | null;
  onFocusLap: (lapId: number) => void;
  focusTelemetry: SemanticTuneSample[] | null;
  focusSectorTimes: SectorTimesLite | null;
  edges: { left: Pt[]; right: Pt[] } | null;
  corners: TrackCorner[];
  issues: TuneIssue[];
  lineSpread: LineSpreadTrace | null;
  metaSectors?: { s1End: number; s2End: number } | null;
  nominalSpanMeters: number;
  shownLapCount?: number;
  totalLapCount?: number;
  activeTab?: TuneReviewTrackTab;
  onActiveTabChange?: (tab: TuneReviewTrackTab) => void;
  visibleLaneRange?: { start: number; end: number } | null;
  selectLaneRange?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}

/** Presentational Track Focus view — no data fetching, so it can be driven
 *  entirely from Storybook fixtures. Owns the local `cursorFrac` (synced
 *  across the map + all lanes) and `activeTab` state; everything else is
 *  passed in already resolved. */
export function TrackFocusViewInner({
  gameId,
  traces,
  baseTraces,
  bestLapId,
  focusTelemetry,
  focusSectorTimes,
  edges,
  corners,
  issues,
  lineSpread,
  metaSectors,
  shownLapCount,
  totalLapCount,
  activeTab: controlledActiveTab,
  onActiveTabChange,
  visibleLaneRange = null,
  nominalSpanMeters,
  selectLaneRange,
  onZoomOut,
}: TrackFocusViewInnerProps) {
  const [cursorFrac, setCursorFrac] = useState<number | null>(null);
  const [hoverPoints, setHoverPoints] = useState<{ brake: number[]; throttle: number[] } | null>(null);
  const [hoverRange, setHoverRange] = useState<{ startFrac: number; endFrac: number } | null>(null);
  const [localActiveTab, setLocalActiveTab] = useState<TuneReviewTrackTab>("consistency");
  const activeTab = controlledActiveTab ?? localActiveTab;
  const setActiveTab = (tab: TuneReviewTrackTab) => {
    setLocalActiveTab(tab);
    onActiveTabChange?.(tab);
  };

  const game = tryGetGame(gameId);
  const tireHealth = game?.telemetry.analysis?.tireHealth;
  const fuelUnit = game?.telemetry.fuel.packetUnit;
  const tireWearContinuous = tireHealth?.source === "direct" && tireHealth.freshness === "continuous";
  const [zoomActive, setZoomActive] = useState(false);
  const [zoomBehavior, setZoomBehavior] = useLocalStorage<"default" | "zoomed" | "disabled">("analyse-hoverZoom", "default");
  const [zoomSettingsOpen, setZoomSettingsOpen] = useState(false);
  const zoomBehaviorLabels = { default: "Default", zoomed: "Always", disabled: "Never" } as const;
  const resolvedTraces = useMemo(() => traces.filter((t): t is TrackFocusTrace => !!t), [traces]);
  const zoomLines = useMemo(
    () =>
      resolvedTraces.map((trace) => ({ lapId: trace.lapId, x: [...(trace.posX ?? [])], z: [...(trace.posZ ?? [])], brake: [...trace.brake], throttle: [...trace.throttle], frac: [...trace.frac] })),
    [resolvedTraces],
  );
  // Scope zoom uses the cached 1 m base, not the merged 0.1 m detail trace.
  // Hover windows are fixed at ±30 m; rendering an entire high-fidelity range
  // would create an unnecessarily large SVG DOM.
  const scopeZoomLines = useMemo(
    () => baseTraces.map((trace) => ({ lapId: trace.lapId, x: [...(trace.posX ?? [])], z: [...(trace.posZ ?? [])], brake: [...trace.brake], throttle: [...trace.throttle], frac: [...trace.frac] })),
    [baseTraces],
  );

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
  const issueMarkers = useMemo(() => {
    const seen = new Set<number>();
    return issues.flatMap((issue) => {
      if (issue.distanceFrac == null || seen.has(issue.distanceFrac)) return [];
      seen.add(issue.distanceFrac);
      const color = issue.severity === "critical" ? "var(--status-danger)" : issue.severity === "warn" ? "var(--status-warning)" : "var(--status-info)";
      return [{ frac: issue.distanceFrac, color }];
    });
  }, [issues]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 p-4">
      {shownLapCount != null && totalLapCount != null && totalLapCount > shownLapCount && (
        <p className="flex-none text-xs text-muted-foreground -mt-2">{m.trackfocus_stats_subset({ shown: String(shownLapCount), total: String(totalLapCount) })}</p>
      )}

      <div className="grid min-h-0 min-w-0 flex-1 overflow-y-auto grid-cols-1 gap-4 @5xl/workspace:grid-cols-[460px_minmax(0,1fr)]">
        {/* Track map and issues scroll away with lane content. */}
        <div className="flex flex-col gap-3 min-h-0 min-w-0">
          <div className="relative mx-auto w-full max-w-[28rem] flex-none">
            <Button
              type="button"
              variant="app-outline"
              size="icon-sm"
              aria-label="Track display settings"
              title="Track display settings"
              onClick={() => setZoomSettingsOpen(true)}
              className="absolute top-2 right-2 z-10"
            >
              <Settings2 className="size-4" />
            </Button>
            <Dialog open={zoomSettingsOpen} onOpenChange={setZoomSettingsOpen}>
              <DialogContent size="sm">
                <DialogHeader>
                  <DialogTitle className="text-app-heading font-semibold">Track display settings</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                  <p className="text-app-detail text-app-text-muted">Hover zoom</p>
                  {(["default", "zoomed", "disabled"] as const).map((behavior) => (
                    <Button
                      key={behavior}
                      type="button"
                      variant={zoomBehavior === behavior ? "selected-toggle" : "app-outline"}
                      className="justify-start"
                      onClick={() => {
                        setZoomBehavior(behavior);
                        setZoomSettingsOpen(false);
                      }}
                    >
                      {zoomBehaviorLabels[behavior]}
                    </Button>
                  ))}
                </div>
              </DialogContent>
            </Dialog>
            {(zoomBehavior === "zoomed" ? zoomLines : zoomBehavior === "default" ? (zoomActive ? zoomLines : scopeZoomLines) : []).length > 0 &&
            zoomBehavior !== "disabled" &&
            (zoomBehavior === "zoomed" || zoomActive || visibleLaneRange) &&
            (cursorFrac != null || visibleLaneRange != null) ? (
              <TrackFocusZoom
                lapLines={zoomBehavior === "zoomed" || zoomActive ? zoomLines : scopeZoomLines}
                issues={issues}
                corners={effectiveCorners.corners}
                cornerFracs={effectiveCorners.fracs}
                bestLapId={bestLapId}
                cursorFrac={cursorFrac ?? ((visibleLaneRange?.start ?? 0) + (visibleLaneRange?.end ?? 1)) / 2}
                radiusM={zoomBehavior === "zoomed" || zoomActive ? undefined : visibleLaneRange ? Math.max(2, ((visibleLaneRange.end - visibleLaneRange.start) * nominalSpanMeters) / 2) : undefined}
                edges={edges}
              />
            ) : (
              <TrackFocusMap
                telemetry={focusTelemetry}
                sectorTimes={focusSectorTimes}
                edges={edges}
                corners={effectiveCorners.corners}
                cornerFracs={effectiveCorners.fracs}
                issues={issues}
                cursorFrac={cursorFrac}
                onCursorFrac={setCursorFrac}
                overlayPoints={hoverPoints}
                highlightRange={hoverRange}
                lineSpread={activeTab === "consistency" ? lineSpread : null}
                visibleRange={visibleLaneRange}
              />
            )}
          </div>
          <div className="flex min-h-0 flex-1 flex-col @5xl/workspace:flex-none @5xl/workspace:overflow-y-auto">
            <div className="flex-none text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-1">Issues</div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <IssuesList issues={issues} onIssueClick={setCursorFrac} />
            </div>
          </div>
        </div>
        <div className="flex min-h-0 min-w-0 flex-col">
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

          {/* Lane content owns its own scroll on wide layouts. */}
          <div className="min-w-0 min-h-0 flex-1 overflow-y-auto">
            <div className="sticky top-0 z-20 bg-app-bg/95">
              <TrackZoomHint />
              <TurnMarkers corners={effectiveCorners.corners} cornerFracs={effectiveCorners.fracs} />
              <IssueMarkers issues={issues} onCursorFrac={setCursorFrac} />
            </div>
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
                  visibleRange={visibleLaneRange}
                  onRangeSelect={selectLaneRange}
                  onZoomOut={onZoomOut}
                />
                <SpeedRangeLegend />
                <SectorLedger traces={resolvedTraces} bestLapId={bestLapId} sectorBoundaryFracs={sectorBoundaryFracs} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />
                <SegmentLedger
                  traces={resolvedTraces}
                  bestLapId={bestLapId}
                  cornerFracs={effectiveCorners.fracs}
                  corners={effectiveCorners.corners}
                  cursorFrac={cursorFrac}
                  onCursorFrac={setCursorFrac}
                  onHoverPoints={setHoverPoints}
                  onHoverRange={setHoverRange}
                />
              </>
            )}
            {activeTab === "braking" && (
              <BrakingPanel
                traces={resolvedTraces}
                metricTraces={baseTraces}
                bestLapId={bestLapId}
                corners={effectiveCorners.corners}
                cornerFracs={effectiveCorners.fracs}
                nominalSpanMeters={nominalSpanMeters}
                issues={issues}
                cursorFrac={cursorFrac}
                onCursorFrac={setCursorFrac}
                visibleRange={visibleLaneRange}
                onRangeSelect={selectLaneRange}
                onZoomOut={onZoomOut}
              />
            )}
            {activeTab === "throttle" && (
              <ThrottleExitPanel
                traces={resolvedTraces}
                metricTraces={baseTraces}
                bestLapId={bestLapId}
                corners={effectiveCorners.corners}
                cornerFracs={effectiveCorners.fracs}
                nominalSpanMeters={nominalSpanMeters}
                cursorFrac={cursorFrac}
                onCursorFrac={setCursorFrac}
                visibleRange={visibleLaneRange}
                onRangeSelect={selectLaneRange}
                onZoomOut={onZoomOut}
              />
            )}
            {activeTab === "tires" && (
              <>
                <TiresPanel
                  traces={traces}
                  bestLapId={bestLapId}
                  cornerFracs={cornerFracs}
                  annotationMarkers={issueMarkers}
                  cursorFrac={cursorFrac}
                  onCursorFrac={setCursorFrac}
                  visibleRange={visibleLaneRange}
                  onRangeSelect={selectLaneRange}
                  onZoomOut={onZoomOut}
                  fuelUnit={fuelUnit}
                  tireWearContinuous={tireWearContinuous}
                />
                <div className="pt-3 mt-1 border-t border-app-border">
                  <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-2">Grip</div>
                  <GripPanel
                    traces={resolvedTraces}
                    bestLapId={bestLapId}
                    cornerFracs={effectiveCorners.fracs}
                    annotationMarkers={issueMarkers}
                    corners={effectiveCorners.corners}
                    cursorFrac={cursorFrac}
                    onCursorFrac={setCursorFrac}
                    visibleRange={visibleLaneRange}
                    onRangeSelect={selectLaneRange}
                    onZoomOut={onZoomOut}
                  />
                </div>
              </>
            )}
            {activeTab === "balance" && (
              <BalanceLanes
                traces={resolvedTraces}
                bestLapId={bestLapId}
                cornerFracs={effectiveCorners.fracs}
                annotationMarkers={issueMarkers}
                corners={effectiveCorners.corners}
                cursorFrac={cursorFrac}
                onCursorFrac={setCursorFrac}
                visibleRange={visibleLaneRange}
                onRangeSelect={selectLaneRange}
                onZoomOut={onZoomOut}
              />
            )}
            {activeTab === "suspension" && (
              <SuspensionLanes
                traces={resolvedTraces}
                bestLapId={bestLapId}
                cornerFracs={cornerFracs}
                annotationMarkers={issueMarkers}
                cursorFrac={cursorFrac}
                onCursorFrac={setCursorFrac}
                visibleRange={visibleLaneRange}
                onRangeSelect={selectLaneRange}
                onZoomOut={onZoomOut}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TurnMarkers({ corners, cornerFracs }: { corners: TrackCorner[]; cornerFracs: number[] }) {
  const { ref, width } = useMeasuredWidth<HTMLDivElement>();
  const markers = useMemo(() => {
    const labels = cornerFracs.map((frac, index) => ({ frac, label: corners[index]?.label ?? `T${index + 1}` }));
    if (labels.length < 2 || width === 0) return labels;

    const groups: Array<{ start: number; end: number }> = [];
    for (let index = 0; index < labels.length; index += 1) {
      const previous = groups.at(-1);
      if (previous && (labels[index].frac - labels[previous.end].frac) * width < 34) previous.end = index;
      else groups.push({ start: index, end: index });
    }
    return groups.map(({ start, end }) => ({
      frac: (labels[start].frac + labels[end].frac) / 2,
      label: start === end ? labels[start].label : `${labels[start].label}–${labels[end].label.replace(/^T/, "")}`,
    }));
  }, [corners, cornerFracs, width]);

  return (
    <div ref={ref} className="px-1" aria-label="Track turns">
      <div className="relative h-5">
        {markers.map((marker) => (
          <span
            key={`${marker.label}-${marker.frac}`}
            className="absolute top-0 -translate-x-1/2 text-app-caption text-app-text-muted"
            style={{ left: `calc(6px + ${marker.frac * 100}% - ${marker.frac * 12}px)` }}
          >
            {marker.label}
          </span>
        ))}
      </div>
    </div>
  );
}
function IssueMarkers({ issues, onCursorFrac }: { issues: TuneIssue[]; onCursorFrac: (frac: number) => void }) {
  const annotations = useMemo(() => {
    const seen = new Set<number>();
    return issues.filter((issue) => {
      if (issue.distanceFrac == null || seen.has(issue.distanceFrac)) return false;
      seen.add(issue.distanceFrac);
      return true;
    });
  }, [issues]);

  if (annotations.length === 0) return null;
  return (
    <div className="px-1" aria-label="Issue annotations">
      <div className="relative h-5">
        {annotations.map((issue) => {
          const color = issue.severity === "critical" ? "var(--status-danger)" : issue.severity === "warn" ? "var(--status-warning)" : "var(--status-info)";
          return (
            <button
              key={`${issue.kind}-${issue.corner ?? ""}-${issue.detail}`}
              type="button"
              className="absolute top-0 flex -translate-x-1/2 items-center text-app-caption text-app-text-muted"
              style={{ left: `calc(6px + ${issue.distanceFrac! * 100}% - ${issue.distanceFrac! * 12}px)` }}
              title={issue.detail}
              onClick={() => onCursorFrac(issue.distanceFrac!)}
            >
              <span className="h-2.5 w-2.5 rounded-full border border-app-bg" style={{ background: color }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
