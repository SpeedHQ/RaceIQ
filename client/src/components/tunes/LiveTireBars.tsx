import type { TelemetryPacket } from "@shared/types";
import { useMemo } from "react";
import { buildLiveRanges, CornerBars, METRICS } from "./SectorRangeBreakdown";

/**
 * LiveTireBars — the "4 vertical bars per corner, min→max fill + avg tick"
 * readout from the Setup Engineer feature, live variant. Aggregates the
 * in-progress lap's trace (liveTrace) into per-corner ranges for each tyre
 * metric (temp / brake temp / pressure / wear) and renders them stacked. Same
 * CornerBars renderer the post-lap review dashboards use, so live and review
 * read identically.
 */
export function LiveTireBars({ telemetry }: { telemetry: TelemetryPacket[] }) {
  const models = useMemo(() => METRICS.map((metric) => ({ metric, model: buildLiveRanges(telemetry, metric) })), [telemetry]);

  return (
    <div className="grid grid-cols-2 gap-x-3 gap-y-2 p-3">
      {models.map(({ metric, model }) => (
        <div key={metric.key} className="min-w-0">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">{metric.label}</span>
            <span className="text-[9px] text-app-text-dim">{metric.unit}</span>
          </div>
          {model ? (
            <CornerBars ranges={model.ranges} domain={model.domain} metric={metric} height={64} />
          ) : (
            <div className="h-[64px] flex items-center justify-center text-[10px] text-app-text-dim">—</div>
          )}
        </div>
      ))}
    </div>
  );
}
