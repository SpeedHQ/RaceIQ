import { selectEvaluationLaps } from "@shared/racing/laps/review-selection";
import { flipPoints, needsTrackFlip } from "@shared/racing/tracks/coords";
import { useMeasuredWidth } from "./use-measured-width";
import { useCallback, useMemo, useState } from "react";
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
import { useAlignedTelemetry } from "../../../hooks/aligned-telemetry";
import { type SemanticTuneSample } from "../semantic-tune";
import { type LapTrace } from "../../../lib/stint-traces";
import { m } from "../../../paraglide/messages";
import { extractEdges, type Pt, type SectorTimesLite } from "../track-map-geometry";
import { Button } from "../../ui/button";
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

function alignedToLapTrace(t: AlignedLapTrace): LapTrace {
  const averages = (value: WheelAverages | null) => value ? { FL: value.FL, FR: value.FR, RL: value.RL, RR: value.RR } : null;
  return {
    lapId: t.lapId, lapNumber: t.lapNumber, isValid: t.isValid, n: t.speedMps.length, frac: t.frac,
    throttle: t.throttle, brake: t.brake, steer: t.steer, speedKmh: Float32Array.from(t.speedMps, (v) => v * 3.6), timeS: t.elapsedTimeS,
    posX: t.positionX, posZ: t.positionZ,
    tire: averages(t.tireAverages), pressure: averages(t.pressureAverages), tireTempTrace: t.tireTemp, pressureTrace: t.tirePressure,
    balance: t.balanceDeg, latG: t.latG, longG: t.longG, suspTravel: t.suspTravel, combinedSlip: t.combinedSlip,
    brakeTemp: averages(t.brakeTempAverages), brakeTempTrace: t.brakeTemp,
  };
}
function alignedToSemantic(t: AlignedLapTrace, gameId: GameId, trackOrdinal: number | undefined, span: number): SemanticTuneSample[] {
  return Array.from({ length: t.speedMps.length }, (_, i) => ({
    gameId,
    trackOrdinal,
    distanceM: t.frac[i] * span,
    speedMps: t.speedMps[i],
    positionM: Number.isFinite(t.positionX[i]) && Number.isFinite(t.positionZ[i]) ? { x: t.positionX[i], z: t.positionZ[i] } : undefined,
    fuel: t.fuel[i],
    fuelUnit: "litre" as const,
    tireWearFraction: t.tireWear ? { fl: t.tireWear[i], fr: t.tireWear[i], rl: t.tireWear[i], rr: t.tireWear[i] } : undefined,
    tireTemperatureC: t.tireTemp ? { fl: t.tireTemp.FL[i], fr: t.tireTemp.FR[i], rl: t.tireTemp.RL[i], rr: t.tireTemp.RR[i] } : undefined,
    tirePressurePsi: t.tirePressure ? { fl: t.tirePressure.FL[i], fr: t.tirePressure.FR[i], rl: t.tirePressure.RL[i], rr: t.tirePressure.RR[i] } : undefined,
    brakeTemperatureC: t.brakeTemp ? { fl: t.brakeTemp.FL[i], fr: t.brakeTemp.FR[i], rl: t.brakeTemp.RL[i], rr: t.brakeTemp.RR[i] } : undefined,
  }));
}

interface TrackFocusViewProps {
  gameId: GameId;
  laps: LapMeta[];
  trackOrdinal?: number;
  /** Controlled focus lap (null = "All" — falls back to the best lap for map/telemetry). Omit for internal state. */
  focusLapId?: number | null;
  onFocusLap?: (lapId: number) => void;
  /** Experiment id, when this view is hosted inside an experiment
   *  review (drives the /line-spread racing-line consistency query). Omit to
   *  hide the line-spread lane + map overlay (e.g. Storybook, non-tuning contexts). */
  experimentId?: number | null;
  lineSpreadOverride?: LineSpreadTrace | null;
  activeTab?: Tab;
  onActiveTabChange?: (tab: Tab) => void;
}

const TABS = ["consistency", "tires", "balance", "suspension"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { consistency: "Consistency", tires: "Tires & grip", balance: "Balance", suspension: "Suspension" };

/** Data-fetching wrapper: resolves the stint's laps into downsampled traces,
 *  the focus lap's raw telemetry, issues, and track corners, then hands
 *  everything to the presentational `TrackFocusViewInner`. */
export function TrackFocusView({ gameId, laps, trackOrdinal, focusLapId: controlledFocusId, onFocusLap: controlledOnFocusLap, experimentId, lineSpreadOverride, activeTab, onActiveTabChange }: TrackFocusViewProps) {
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
  const reviewLapIds = useMemo(() => reviewLaps.map((lap) => lap.id), [reviewLaps]);
  const { data: alignedSet } = useAlignedTelemetry(reviewLapIds, { step: 1 });
  const zoom = useAlignedTelemetryZoom(reviewLapIds, alignedSet);
  const traces = useMemo(() => (zoom.data ?? alignedSet)?.laps.map(alignedToLapTrace) ?? [], [alignedSet, zoom.data]);
  const visibleLaneRange = useMemo(() => {
    if (!zoom.visibleRange || !alignedSet || alignedSet.nominalSpanMeters <= 0) return null;
    return {
      start: zoom.visibleRange.start / alignedSet.nominalSpanMeters,
      end: zoom.visibleRange.end / alignedSet.nominalSpanMeters,
    };
  }, [alignedSet, zoom.visibleRange]);
  const selectLaneRange = useCallback((startFrac: number, endFrac: number) => {
    if (!alignedSet) return;
    zoom.selectRangeMeters(startFrac * alignedSet.nominalSpanMeters, endFrac * alignedSet.nominalSpanMeters);
  }, [alignedSet, zoom.selectRangeMeters]);
  const { data: fetchedLineSpread } = useLineSpread(experimentId);
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
    const activeSet = zoom.data ?? alignedSet;
    const lap = activeSet?.laps.find((candidate) => candidate.lapId === effectiveFocusId) ?? activeSet?.laps[0];
    return lap ? alignedToSemantic(lap, gameId, trackOrdinal, activeSet?.nominalSpanMeters ?? 0) : null;
  }, [alignedSet, effectiveFocusId, gameId, trackOrdinal, zoom.data]);
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


  return (
    <TrackFocusViewInner
      laps={stintLaps}
      traces={traces}
      bestLapId={bestLapId}
      focusLapId={effectiveFocusId}
      onFocusLap={setFocusLapId}
      focusSectorTimes={null}
      edges={edges}
      corners={corners ?? []}
      focusTelemetry={focusTelemetry}
      issues={issues ?? []}
      lineSpread={lineSpread ?? null}
      metaSectors={metaSectors}
      shownLapCount={reviewLaps.length}
      totalLapCount={stintLaps.length}
      activeTab={activeTab}
      onActiveTabChange={onActiveTabChange}
      visibleLaneRange={visibleLaneRange}
      selectLaneRange={selectLaneRange}
      onZoomOut={zoom.zoomOut}
    />
  );
}

export interface TrackFocusViewInnerProps {
  laps: LapMeta[];
  traces: (LapTrace | undefined)[];
  bestLapId: number | null;
  focusLapId: number | null;
  onFocusLap: (lapId: number) => void;
  focusTelemetry: SemanticTuneSample[] | null;
  focusSectorTimes: SectorTimesLite | null;
  edges: { left: Pt[]; right: Pt[] } | null;
  corners: TrackCorner[];
  issues: TuneIssue[];
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
  activeTab?: Tab;
  onActiveTabChange?: (tab: Tab) => void;
  visibleLaneRange?: { start: number; end: number } | null;
  selectLaneRange?: (startFrac: number, endFrac: number) => void;
  onZoomOut?: () => void;
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
  lineSpread,
  metaSectors,
  shownLapCount,
  totalLapCount,
  activeTab: controlledActiveTab,
  onActiveTabChange,
  visibleLaneRange = null,
  selectLaneRange,
  onZoomOut,
}: TrackFocusViewInnerProps) {
  const [cursorFrac, setCursorFrac] = useState<number | null>(null);
  const [hoverPoints, setHoverPoints] = useState<{ brake: number[]; throttle: number[] } | null>(null);
  const [hoverRange, setHoverRange] = useState<{ startFrac: number; endFrac: number } | null>(null);
  const [localActiveTab, setLocalActiveTab] = useState<Tab>("consistency");
  const activeTab = controlledActiveTab ?? localActiveTab;
  const setActiveTab = (tab: Tab) => {
    setLocalActiveTab(tab);
    onActiveTabChange?.(tab);
  };
  const [zoomActive, setZoomActive] = useState(false);

  const resolvedTraces = useMemo(() => traces.filter((t): t is LapTrace => !!t), [traces]);
  const zoomLines = useMemo(() => resolvedTraces.map((trace) => ({ lapId: trace.lapId, x: [...(trace.posX ?? [])], z: [...(trace.posZ ?? [])], brake: [...trace.brake], throttle: [...trace.throttle], frac: [...trace.frac] })), [resolvedTraces]);

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
        <p className="flex-none text-xs text-muted-foreground -mt-2">
          {m.trackfocus_stats_subset({ shown: String(shownLapCount), total: String(totalLapCount) })}
        </p>
      )}

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-4 @5xl/workspace:grid-cols-[460px_minmax(0,1fr)]">
        {/* Left column: track map (static) + issues list (own scroll). */}
        <div className="flex flex-col gap-3 min-h-0 min-w-0">
          <div className="mx-auto w-full max-w-[28rem] flex-none">
            {zoomActive && zoomLines.length > 0 && cursorFrac != null ? (
              <TrackFocusZoom lapLines={zoomLines} bestLapId={bestLapId} cursorFrac={cursorFrac} edges={edges} />
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
                  onHoverRange={setHoverRange}
                />
              </>
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
              />
            )}
            {activeTab === "suspension" && <SuspensionLanes traces={traces} bestLapId={bestLapId} cornerFracs={cornerFracs} annotationMarkers={issueMarkers} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />}
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
