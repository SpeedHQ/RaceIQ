import type { LapMeta, TelemetryPacket, TuneIssue } from "@shared/types";
import { useMemo, useState } from "react";
import { type TrackCorner, useLapIssues, useLapTelemetry, useTrackBoundaries, useTrackCorners } from "../../../hooks/queries";
import { useStintTraces } from "../../../hooks/useStintTraces";
import { type LapTrace, stintStats } from "../../../lib/stint-traces";
import { extractEdges, type Pt, type SectorTimesLite } from "../track-map-geometry";
import { ConsistencyLanes } from "./ConsistencyLanes";
import { CornerLedger } from "./CornerLedger";
import { IssuesList } from "./IssuesList";
import { TiresPanel } from "./TiresPanel";
import { TrackFocusMap } from "./TrackFocusMap";

interface TrackFocusViewProps {
  gameId: "acc" | "ac-evo" | "fm-2023" | "f1-2025";
  laps: LapMeta[];
  trackOrdinal?: number;
  /** Controlled focus lap (null = "All" — falls back to the best lap for map/telemetry). Omit for internal state. */
  focusLapId?: number | null;
  onFocusLap?: (lapId: number) => void;
}

const TABS = ["consistency", "tires"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = { consistency: "Consistency", tires: "Tires" };

/** Data-fetching wrapper: resolves the stint's laps into downsampled traces,
 *  the focus lap's raw telemetry, issues, and track corners, then hands
 *  everything to the presentational `TrackFocusViewInner`. */
export function TrackFocusView({ gameId, laps, trackOrdinal, focusLapId: controlledFocusId, onFocusLap: controlledOnFocusLap }: TrackFocusViewProps) {
  const stintLaps = useMemo(() => [...laps].sort((a, b) => a.lapNumber - b.lapNumber), [laps]);
  const { traces } = useStintTraces(stintLaps);

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
  const edges = useMemo(() => extractEdges(bounds), [bounds]);

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
}

/** Presentational Track Focus view — no data fetching, so it can be driven
 *  entirely from Storybook fixtures. Owns the local `cursorFrac` (synced
 *  across the map + all lanes) and `activeTab` state; everything else is
 *  passed in already resolved. */
export function TrackFocusViewInner({ traces, bestLapId, focusTelemetry, focusSectorTimes, edges, corners, issues, stats }: TrackFocusViewInnerProps) {
  const [cursorFrac, setCursorFrac] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("consistency");

  const resolvedTraces = useMemo(() => traces.filter((t): t is LapTrace => !!t), [traces]);

  const cornerFracs = useMemo(() => {
    if (!focusTelemetry || focusTelemetry.length < 2 || corners.length === 0) return [];
    const total = focusTelemetry[focusTelemetry.length - 1].DistanceTraveled - focusTelemetry[0].DistanceTraveled;
    if (!(total > 0)) return [];
    return corners.map((c) => Math.max(0, Math.min(1, (c.distanceStart - focusTelemetry[0].DistanceTraveled) / total)));
  }, [focusTelemetry, corners]);

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
          <TrackFocusMap telemetry={focusTelemetry} sectorTimes={focusSectorTimes} edges={edges} corners={corners} issues={issues} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />
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

          {activeTab === "consistency" && (
            <>
              <ConsistencyLanes traces={resolvedTraces} bestLapId={bestLapId} cornerFracs={cornerFracs} issues={issues} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />
              <CornerLedger traces={resolvedTraces} bestLapId={bestLapId} cornerFracs={cornerFracs} corners={corners} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />
            </>
          )}
          {activeTab === "tires" && <TiresPanel traces={traces} bestLapId={bestLapId} cornerFracs={cornerFracs} cursorFrac={cursorFrac} onCursorFrac={setCursorFrac} />}
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
