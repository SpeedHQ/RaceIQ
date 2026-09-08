import { useMemo, useState } from "react";
import type { GameId } from "@shared/games/ids";
import { formatLapTime } from "@/lib/format";
import { SECTOR_COLOR_VARS } from "@/lib/colors";
import type { TuneIssue } from "../../../../shared/racing/tuning/issues";
import { IssuePill } from "./review/ReviewIssues";
import { SectorMap } from "./SectorMap";
import { bandColor, buildSectorRanges, CORNERS, CornerBars, type CornerKey, METRICS, type MetricDef, tuneMetricValue } from "./SectorRangeBreakdown";
import type { SemanticTuneSample } from "./semantic-tune";

interface SectorTimes {
  times: number[];
  boundaryIndices: number[];
}

interface SectorDetailViewProps {
  gameId?: GameId;
  telemetry: SemanticTuneSample[];
  sectorTimes: SectorTimes | null;
  sectorIndex: number;
  trackOrdinal?: number;
  issues: TuneIssue[];
}


/**
 * SectorDetailView — deep dive on a single sector: a large hover-scrubbable map
 * of the lap with this sector lit, every metric's per-corner range for the
 * sector (temps, brakes, pressure, wear), and the issues located here. Hovering
 * the map scrubs a cursor line across all the metric bars at once.
 */
export function SectorDetailView({ telemetry, sectorTimes, sectorIndex, trackOrdinal, gameId, issues }: SectorDetailViewProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [markFrac, setMarkFrac] = useState<number | null>(null);
  const issueMarkers = useMemo(() => {
    const seen = new Set<number>();
    return issues.flatMap((issue) => {
      const fraction = issue.distanceFrac;
      if (fraction == null || !Number.isFinite(fraction) || seen.has(fraction)) return [];
      seen.add(fraction);
      const color = issue.severity === "critical" ? "var(--status-danger)" : issue.severity === "warn" ? "var(--status-warning)" : "var(--status-info)";
      return [{ fraction, color }];
    });
  }, [issues]);
  const cursorFrame = hoverIdx != null ? telemetry[hoverIdx] : null;

  const readout = (frame: SemanticTuneSample) =>
    CORNERS.map((corner, index) => {
      const value = tuneMetricValue(frame, METRICS[0], index);
      return {
        label: corner,
        value: value === undefined ? "—" : `${value.toFixed(1)} °C`,
        color: value === undefined ? undefined : bandColor(value),
      };
    });

  const cursorFor = (metric: MetricDef): Partial<Record<CornerKey, number>> | undefined => {
    if (!cursorFrame) return undefined;
    const values: Partial<Record<CornerKey, number>> = {};
    for (let index = 0; index < CORNERS.length; index++) {
      const value = tuneMetricValue(cursorFrame, metric, index);
      if (value !== undefined) values[CORNERS[index]] = value;
    }
    return values;
  };

  const sectorTime = sectorTimes && sectorTimes.times[sectorIndex] > 0 ? formatLapTime(sectorTimes.times[sectorIndex]) : "—";

  return (
    <div className="grid grid-cols-1 @3xl/workspace:grid-cols-2">
      {/* Map + issues */}
      <div className="border-app-border @3xl/workspace:border-r">
        <div className="flex items-center justify-between px-4 py-2 border-b border-app-border">
          <div className="flex items-center gap-2">
            <span className="w-6 h-1 rounded" style={{ background: SECTOR_COLOR_VARS[sectorIndex % SECTOR_COLOR_VARS.length] }} />
            <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Sector {sectorIndex + 1}</span>
          </div>
          <span className="text-lg font-mono tabular-nums text-app-text">{sectorTime}</span>
        </div>
        {telemetry.length > 0 ? (
          <div className="aspect-square">
            <SectorMap
              gameId={gameId}
              telemetry={telemetry}
              sectorTimes={sectorTimes}
              highlight={sectorIndex}
              showTimes={false}
              trackOrdinal={trackOrdinal}
              issueMarkers={issueMarkers}
              readout={readout}
              onHover={setHoverIdx}
              markFraction={markFrac}
            />
          </div>
        ) : (
          <div className="aspect-square p-4 text-xs text-app-text-dim">No telemetry</div>
        )}
        <div className="px-4 py-3 border-t border-app-border">
          <div className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider mb-2">Issues in this sector</div>
          {issues.length === 0 ? (
            <div className="text-xs text-app-text-dim">No issues located in this sector.</div>
          ) : (
            <div className="flex flex-col gap-1">
              {issues.map((it) => (
                <IssuePill key={`${it.kind}-${it.corner ?? ""}-${it.detail}`} issue={it} onHover={(frac) => setMarkFrac(frac)} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Every metric's range for this sector; hovering the map scrubs all of them */}
      <div className="divide-y divide-app-border">
        {METRICS.map((m) => {
          const model = buildSectorRanges(telemetry, sectorTimes, m);
          if (!model) return null;
          return (
            <div key={m.key} className="p-3">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">{m.label}</span>
                <span className="text-app-caption text-app-text-dim tabular-nums">
                  {Math.round(model.domain[0])}–{Math.round(model.domain[1])} {m.unit}
                </span>
              </div>
              <CornerBars ranges={model.sectors[sectorIndex]} domain={model.domain} metric={m} cursor={cursorFor(m)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
