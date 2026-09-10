import { flipPoints, needsTrackFlip } from "@shared/racing/tracks/coords";
import { useMeasuredWidth } from "./use-measured-width";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Settings2 } from "lucide-react";
import { useLocalStorage } from "../../../hooks/useLocalStorage";
import type { GameId } from "../../../../../shared/games/ids";
import type { AlignedLapSet, AlignedLapTrace, WheelAverages } from "@shared/racing/laps/alignment/types";
import type { TuneIssue } from "../../../../../shared/racing/tuning/issues";
import type { LineSpreadTrace } from "../../../hooks/experiments";
import { useLineSpread } from "../../../hooks/experiments";
import type { TrackCorner } from "../../../hooks/track-queries";
import { useTrackBoundaries, useTrackCorners, useTrackSectorBoundaries } from "../../../hooks/track-queries";
import { useLapIssues } from "../../../hooks/tunes";
import { useAlignedTelemetryZoom } from "../../../hooks/useAlignedTelemetryZoom";
import { semanticTuneSamplesFromAlignedTrace, type SemanticTuneSample } from "../semantic-tune";
import type { TuneReviewTrackTab } from "../../../lib/game-routes";
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
import { FuelPanel, TiresPanel } from "./TiresPanel";
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


const TABS = ["consistency", "braking", "throttle", "dynamics", "fuel", "suspension"] as const;
const TAB_LABELS: Record<TuneReviewTrackTab, string> = {
  consistency: "Consistency",
  braking: "Braking",
  throttle: "Throttle & exit",
  dynamics: "Dynamics",
  fuel: "Fuel",
  suspension: "Suspension",
};
/** Data-fetching wrapper: resolves the stint's laps into downsampled traces,
 *  the focus lap's raw telemetry, issues, and track corners, then hands
 *  everything to the presentational `TrackFocusViewInner`. */
export function TrackFocusView({
  gameId,
  alignedSet,
  lapIds,
  trackOrdinal,
  primaryLapId,
  experimentId,
  lineSpreadOverride,
  activeTab,
  onActiveTabChange,
}: TrackFocusViewProps) {
  const zoom = useAlignedTelemetryZoom(lapIds, alignedSet);
  useEffect(() => {
    zoom.zoomOut();
  }, [zoom.zoomOut]);
  const traces = useMemo(() => (zoom.data ?? alignedSet)?.laps.filter((lap) => lap.isValid || lap.lapId === primaryLapId).map(alignedToLapTrace) ?? [], [alignedSet, primaryLapId, zoom.data]);
  const baseTraces = useMemo(() => alignedSet?.laps.filter((lap) => lap.isValid || lap.lapId === primaryLapId).map(alignedToLapTrace) ?? [], [alignedSet, primaryLapId]);
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
  const focusTelemetry = useMemo(() => {
    const lap = alignedSet?.laps.find((candidate) => candidate.lapId === primaryLapId);
    return lap ? semanticTuneSamplesFromAlignedTrace(lap, gameId, trackOrdinal, alignedSet?.nominalSpanMeters ?? 0) : null;
  }, [alignedSet, gameId, primaryLapId, trackOrdinal]);
  const { data: issues } = useLapIssues(primaryLapId);
  const { data: bounds } = useTrackBoundaries(trackOrdinal, gameId);
  const { data: corners } = useTrackCorners(trackOrdinal, gameId);
  const { data: sectorBoundaries } = useTrackSectorBoundaries(trackOrdinal, gameId);
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
    const trace = alignedSet?.laps.find((candidate) => candidate.lapId === primaryLapId);
    if (!trace?.sectorTimes || trace.sectorTimes.length < 2 || !trace.sectorStarts) return null;
    const starts = trace.sectorStarts.filter((start) => Number.isFinite(start) && start > 0 && start < 1).slice(0, trace.sectorTimes.length - 1);
    if (starts.length !== trace.sectorTimes.length - 1) return null;
    return { times: trace.sectorTimes, boundaryIndices: starts.map((start) => Math.round(start * Math.max(0, trace.speedMps.length - 1))) };
  }, [alignedSet, primaryLapId]);
  return (
    <TrackFocusViewInner
      traces={traces}
      primaryLapId={primaryLapId}
      focusSectorTimes={focusSectorTimes}
      edges={edges}
      corners={corners ?? []}
      focusTelemetry={focusTelemetry}
      issues={issues ?? []}
      lineSpread={lineSpread ?? null}
      metaSectors={metaSectors}
      gameId={gameId}
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

export interface TrackFocusViewProps {
  gameId: GameId;
  alignedSet: AlignedLapSet | undefined;
  lapIds: readonly number[];
  trackOrdinal?: number;
  primaryLapId: number;
  experimentId?: number | null;
  lineSpreadOverride?: LineSpreadTrace | null;
  activeTab?: TuneReviewTrackTab;
  onActiveTabChange?: (tab: TuneReviewTrackTab) => void;
}

/** Presentational Track Focus view — no data fetching, so it can be driven
 *  entirely from Storybook fixtures. Owns the local `cursorFrac` (synced
 *  across the map + all lanes) and `activeTab` state; everything else is
 *  passed in already resolved. */
export interface TrackFocusViewInnerProps {
  gameId: GameId;
  baseTraces: TrackFocusTrace[];
  traces: (TrackFocusTrace | undefined)[];
  primaryLapId: number | null;
  focusTelemetry: SemanticTuneSample[] | null;
  focusSectorTimes: SectorTimesLite | null;
  edges: { left: Pt[]; right: Pt[] } | null;
  corners: TrackCorner[];
  issues: TuneIssue[];
  lineSpread: LineSpreadTrace | null;
  metaSectors?: { s1End: number; s2End: number } | null;
  nominalSpanMeters: number;
  activeTab?: TuneReviewTrackTab;
  onActiveTabChange?: (tab: TuneReviewTrackTab) => void;
  visibleLaneRange?: { start: number; end: number } | null;
  selectLaneRange?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
}
export function TrackFocusViewInner({
  gameId,
  traces,
  baseTraces,
  primaryLapId,
  focusTelemetry,
  focusSectorTimes,
  edges,
  corners,
  issues,
  lineSpread,
  metaSectors,
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
  useEffect(() => {
    setZoomActive(false);
  }, [activeTab]);
  useEffect(() => {
    if (cursorFrac == null) setZoomActive(false);
  }, [cursorFrac]);
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
  const setChartCursor = useCallback((frac: number | null) => {
    setZoomActive(frac != null);
    setCursorFrac(frac);
  }, []);
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
    const bestTrace = resolvedTraces.find((t) => t.lapId === primaryLapId) ?? resolvedTraces[0];

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
  }, [corners, resolvedTraces, primaryLapId]);

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
    const bestTrace = resolvedTraces.find((t) => t.lapId === primaryLapId) ?? resolvedTraces[0];
    if (!bestTrace) return { corners: [], fracs: [] };
    return detectCorners(bestTrace);
  }, [corners, cornerFracs, resolvedTraces, primaryLapId]);
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
    <div className="flex min-h-full flex-col gap-4 px-4 pb-4" onPointerMove={(event) => {
      if (!(event.target as Element).closest("[data-track-telemetry-lane]")) setZoomActive(false);
    }}>

      <div className="grid min-w-0 grid-cols-1 gap-4 @5xl/workspace:grid-cols-[460px_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3 @5xl/workspace:sticky @5xl/workspace:top-[2.8125rem] @5xl/workspace:h-[calc(100dvh-3.8125rem)] @5xl/workspace:min-h-0" onMouseEnter={() => setZoomActive(false)} onPointerMove={() => setZoomActive(false)}>
          <div className="relative w-full flex-none bg-app-bg pt-4">
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
            (visibleLaneRange != null || (cursorFrac != null && zoomActive)) ? (
              <TrackFocusZoom
                lapLines={zoomBehavior === "zoomed" || zoomActive ? zoomLines : scopeZoomLines}
                issues={issues}
                corners={effectiveCorners.corners}
                cornerFracs={effectiveCorners.fracs}
                primaryLapId={primaryLapId}
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
                onCursorFrac={(frac) => {
                  if (frac != null) setZoomActive(false);
                  setCursorFrac(frac);
                }}
                overlayPoints={hoverPoints}
                highlightRange={hoverRange}
                lineSpread={activeTab === "consistency" ? lineSpread : null}
                visibleRange={visibleLaneRange}
              />
            )}
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="mb-1 flex-none text-app-compact font-semibold uppercase tracking-wider text-app-text-muted">Issues</div>
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <IssuesList issues={issues} onIssueClick={setCursorFrac} />
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col">
          <div className="flex flex-none flex-wrap gap-1 bg-app-bg pt-4 @5xl/workspace:sticky @5xl/workspace:top-[2.8125rem] @5xl/workspace:z-20">
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

          {/* Lane content participates in the page scroll. */}
          <div className="min-w-0" onMouseLeave={() => setZoomActive(false)}>
            <div className="bg-app-bg/95 @5xl/workspace:sticky @5xl/workspace:top-[5.1875rem] @5xl/workspace:z-10">
              <TrackZoomHint />
              <TurnMarkers corners={effectiveCorners.corners} cornerFracs={effectiveCorners.fracs} cursorFrac={cursorFrac} nominalSpanMeters={nominalSpanMeters} />
              <IssueMarkers issues={issues} onCursorFrac={setCursorFrac} />
            </div>
            {activeTab === "consistency" && (
              <>
                <ConsistencyLanes
                  traces={resolvedTraces}
                  primaryLapId={primaryLapId}
                  cornerFracs={effectiveCorners.fracs}
                  corners={effectiveCorners.corners}
                  issues={issues}
                  cursorFrac={cursorFrac}
                  onCursorFrac={setChartCursor}
                  lineSpread={lineSpread}
                  onZoomHover={setZoomActive}
                  visibleRange={visibleLaneRange}
                  onRangeSelect={selectLaneRange}
                  onZoomOut={onZoomOut}
                />
                <SpeedRangeLegend />
                <SectorLedger traces={resolvedTraces} primaryLapId={primaryLapId} sectorBoundaryFracs={sectorBoundaryFracs} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />
                <SegmentLedger
                  traces={resolvedTraces}
                  primaryLapId={primaryLapId}
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
                cornerFracs={effectiveCorners.fracs}
                primaryLapId={primaryLapId}
                corners={effectiveCorners.corners}
                nominalSpanMeters={nominalSpanMeters}
                issues={issues}
                cursorFrac={cursorFrac}
                onCursorFrac={setChartCursor}
                visibleRange={visibleLaneRange}
                onRangeSelect={selectLaneRange}
                onZoomOut={onZoomOut}
              />
            )}
            {activeTab === "throttle" && (
              <ThrottleExitPanel
                traces={resolvedTraces}
                primaryLapId={primaryLapId}
                metricTraces={baseTraces}
                corners={effectiveCorners.corners}
                cornerFracs={effectiveCorners.fracs}
                nominalSpanMeters={nominalSpanMeters}
                cursorFrac={cursorFrac}
                onCursorFrac={setChartCursor}
                visibleRange={visibleLaneRange}
                onRangeSelect={selectLaneRange}
                onZoomOut={onZoomOut}
              />
            )}
            {activeTab === "dynamics" && (
              <>
                <TiresPanel
                  traces={traces}
                  cornerFracs={cornerFracs}
                  annotationMarkers={issueMarkers}
                  cursorFrac={cursorFrac}
                  onCursorFrac={setChartCursor}
                  visibleRange={visibleLaneRange}
                  onRangeSelect={selectLaneRange}
                  onZoomOut={onZoomOut}
                  tireWearContinuous={tireWearContinuous}
                />
                <div className="pt-3 mt-1 border-t border-app-border">
                  <BalanceLanes
                    traces={resolvedTraces}
                    cornerFracs={effectiveCorners.fracs}
                    primaryLapId={primaryLapId}
                    annotationMarkers={issueMarkers}
                    corners={effectiveCorners.corners}
                    cursorFrac={cursorFrac}
                    onCursorFrac={setChartCursor}
                    visibleRange={visibleLaneRange}
                    onRangeSelect={selectLaneRange}
                    onZoomOut={onZoomOut}
                  />
                </div>
                <div className="pt-3 mt-1 border-t border-app-border">
                  <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-2">Grip</div>
                  <GripPanel
                    primaryLapId={primaryLapId}
                    traces={resolvedTraces}
                    cornerFracs={effectiveCorners.fracs}
                    annotationMarkers={issueMarkers}
                    corners={effectiveCorners.corners}
                    cursorFrac={cursorFrac}
                    onCursorFrac={setChartCursor}
                    visibleRange={visibleLaneRange}
                    onRangeSelect={selectLaneRange}
                    onZoomOut={onZoomOut}
                  />
                </div>
              </>
            )}
            {activeTab === "fuel" && (
              <FuelPanel
                traces={traces}
                primaryLapId={primaryLapId}
                cursorFrac={cursorFrac}
                onCursorFrac={setChartCursor}
                visibleRange={visibleLaneRange}
                onRangeSelect={selectLaneRange}
                onZoomOut={onZoomOut}
                fuelUnit={fuelUnit}
              />
            )}
            {activeTab === "suspension" && (
              <SuspensionLanes
                traces={resolvedTraces}
                cornerFracs={cornerFracs}
                annotationMarkers={issueMarkers}
                cursorFrac={cursorFrac}
                onCursorFrac={setChartCursor}
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

function TurnMarkers({ corners, cornerFracs, cursorFrac, nominalSpanMeters }: { corners: TrackCorner[]; cornerFracs: number[]; cursorFrac: number | null; nominalSpanMeters: number }) {
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
      <div className="relative h-5 border-t border-app-border/50" aria-label="Track position">
        {cursorFrac != null && (
          <span
            className="absolute top-0 text-app-caption text-app-accent font-mono tabular-nums whitespace-nowrap"
            style={{
              left: `clamp(44px, ${cursorFrac * 100}%, calc(100% - 44px))`,
              transform: "translateX(-50%)",
            }}
          >
            {`${(cursorFrac * 100).toFixed(1)}% ${(cursorFrac * nominalSpanMeters).toFixed(0)}m`}
          </span>
        )}
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
