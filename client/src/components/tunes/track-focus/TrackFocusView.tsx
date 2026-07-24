import type { LapMeta, TelemetryPacket, TuneIssue } from "@shared/types";
import { useMemo, useState } from "react";
import { type LineSpreadTrace, type TrackCorner, useLapIssues, useLapTelemetry, useLineSpread, useTrackBoundaries, useTrackCorners, useTrackSectorBoundaries } from "../../../hooks/queries";
import { useStintTraces } from "../../../hooks/useStintTraces";
import { type LapTrace, stintStats } from "../../../lib/stint-traces";
import { flipPoints, needsTrackFlip } from "../../../lib/track-coords";
import { extractEdges, type Pt, type SectorTimesLite } from "../track-map-geometry";
import { ConsistencyLanes } from "./ConsistencyLanes";
import { CornerLedger } from "./CornerLedger";
import { detectCorners } from "./detect-corners";
import { IssuesList } from "./IssuesList";
import { SectorLedger } from "./SectorLedger";
import { TiresPanel } from "./TiresPanel";
import { TrackFocusMap } from "./TrackFocusMap";

interface TrackFocusViewProps {
  gameId: "acc" | "ac-evo" | "fm-2023" | "f1-2025";
  laps: LapMeta[];
  trackOrdinal?: number;
  /** Controlled focus lap (null = "All" — falls back to the best lap for map/telemetry). Omit for internal state. */
  focusLapId?: number | null;
  onFocusLap?: (lapId: number) => void;
  /** Tuning session id, when this view is hosted inside a tuning session
   *  review (drives the /line-spread racing-line consistency query). Omit to
   *  hide the line-spread lane + map overlay (e.g. Storybook, non-tuning contexts). */
  tuningSessionId?: number | null;
}

const TABS = ["consistency", "tires"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { consistency: "Consistency", tires: "Tires" };

/** Data-fetching wrapper: resolves the stint's laps into downsampled traces,
 *  the focus lap's raw telemetry, issues, and track corners, then hands
 *  everything to the presentational `TrackFocusViewInner`. */
export function TrackFocusView({ gameId, laps, trackOrdinal, focusLapId: controlledFocusId, onFocusLap: controlledOnFocusLap, tuningSessionId }: TrackFocusViewProps) {
  // Invalid / legacy laps are excluded from the whole Track Focus view —
  // traces, stats, best-lap, ledgers and tyres all read `stintLaps`.
  const stintLaps = useMemo(() => laps.filter((l) => l.isValid && !l.isLegacy).sort((a, b) => a.lapNumber - b.lapNumber), [laps]);
  const { traces } = useStintTraces(stintLaps);
  const { data: lineSpread } = useLineSpread(tuningSessionId);

  const bestLapId = useMemo(() => {
    let best: LapMeta | null = null;
    for (const l of stintLaps) {
      if (!l.isValid || l.tuningExcluded || l.isLegacy) continue;
      if (best == null || l.lapTime < best.lapTime) best = l;
    }
    return best?.id ?? null;
  }, [stintLaps]);

  const [localFocusId, setLocalFocusId] = useState<number | null>(null);
  const focusLapId = controlledFocusId !== undefined ? controlledFocusId : localFocusId;
  const setFocusLapId = controlledOnFocusLap ?? setLocalFocusId;
  const effectiveFocusId = focusLapId ?? bestLapId ?? stintLaps[stintLaps.length - 1]?.id ?? null;

  const { data: focusTel } = useLapTelemetry(effectiveFocusId);
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

  const stats = useMemo(() => stintStats(stintLaps), [stintLaps]);

  return (
    <TrackFocusViewInner
      laps={stintLaps}
      traces={traces}
      bestLapId={bestLapId}
      focusLapId={effectiveFocusId}
      onFocusLap={setFocusLapId}
      focusTelemetry={focusTel?.telemetry ?? null}
      focusSectorTimes={focusTel?.sectorTimes ?? null}
      edges={edges}
      corners={corners ?? []}
      issues={issues ?? []}
      stats={stats}
      lineSpread={lineSpread ?? null}
      metaSectors={metaSectors}
    />
  );
}

export interface TrackFocusViewInnerProps {
  laps: LapMeta[];
  traces: (LapTrace | undefined)[];
  bestLapId: number | null;
  focusLapId: number | null;
  onFocusLap: (lapId: number) => void;
  focusTelemetry: TelemetryPacket[] | null;
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
}

/** Presentational Track Focus view — no data fetching, so it can be driven
 *  entirely from Storybook fixtures. Owns the local `cursorFrac` (synced
 *  across the map + all lanes) and `activeTab` state; everything else is
 *  passed in already resolved. */
export function TrackFocusViewInner({ traces, bestLapId, focusTelemetry, focusSectorTimes, edges, corners, issues, stats, lineSpread, metaSectors }: TrackFocusViewInnerProps) {
  const [cursorFrac, setCursorFrac] = useState<number | null>(null);
  const [hoverPoints, setHoverPoints] = useState<{ brake: number[]; throttle: number[] } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("consistency");

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
  // back to the focus lap's sector split indices (same source the track map
  // uses to color its S1/S2/S3 segments) so the sector ledger's rows line up
  // with what the map shows.
  const sectorBoundaryFracs = useMemo(() => {
    if (metaSectors) return [metaSectors.s1End, metaSectors.s2End];
    if (!focusTelemetry || focusTelemetry.length < 2 || !focusSectorTimes) return [];
    const last = focusTelemetry.length - 1;
    return [focusSectorTimes.s1Idx / last, focusSectorTimes.s2Idx / last];
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
    <div className="p-4 space-y-4">
      {/* Stat strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
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

      <div className="grid grid-cols-1 lg:grid-cols-[460px_1fr] gap-4">
        {/* Left column: track map + issues list */}
        <div className="space-y-3">
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
            lineSpread={activeTab === "consistency" ? lineSpread : null}
          />
          <div>
            <div className="text-[11px] font-semibold text-app-text-muted uppercase tracking-wider mb-1">Issues</div>
            <IssuesList issues={issues} onIssueClick={setCursorFrac} />
          </div>
        </div>

        {/* Right pane: tabbed lanes */}
        <div className="space-y-3">
          <div className="flex gap-1 flex-wrap">
            {TABS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setActiveTab(t)}
                className={`px-2.5 py-1 text-xs rounded border ${activeTab === t ? "border-app-accent text-app-accent bg-app-accent/10" : "border-app-border text-app-text-muted hover:text-app-text"}`}
              >
                {TAB_LABELS[t]}
              </button>
            ))}
          </div>

          {/* Tab bar above stays put; the active tab's content scrolls within
              this bounded region when it outgrows the viewport. */}
          <div className="space-y-3 overflow-y-auto max-h-[70vh] pr-1">
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
            {activeTab === "tires" && <TiresPanel traces={traces} bestLapId={bestLapId} cornerFracs={cornerFracs} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCell({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="rounded bg-app-surface border border-app-border px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-app-text-dim">{label}</div>
      <div className="text-base font-mono tabular-nums text-app-text">
        {value}
        {unit && <span className="text-[10px] text-app-text-dim ml-1">{unit}</span>}
      </div>
    </div>
  );
}
