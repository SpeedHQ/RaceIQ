import type { TelemetryPacket } from "@shared/types";
import { useMemo } from "react";
import { buildLiveRanges, CornerBars, METRICS } from "./SectorRangeBreakdown";

/**
 * CurrentLapTireStrip — compact horizontal row of the same per-corner range
 * bars LiveTireBars renders, tighter spacing, for the live dashboard's bottom
 * strip. Live dashboard replacement for the sector-by-sector breakdown, which
 * reviews a completed lap rather than what the car is doing right now.
 */
export function CurrentLapTireStrip({ telemetry }: { telemetry: TelemetryPacket[] }) {
  const models = useMemo(() => METRICS.map((metric) => ({ metric, model: buildLiveRanges(telemetry, metric) })), [telemetry]);

  // Fuel: min→avg→max over the trace, on a padded domain — same math/visual as a
  // single tyre corner bar so it aligns in the row.
  const fuel = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let sum = 0;
    let n = 0;
    for (const p of telemetry) {
      if (p.Fuel == null || !Number.isFinite(p.Fuel) || p.Fuel <= 0) continue;
      if (p.Fuel < min) min = p.Fuel;
      if (p.Fuel > max) max = p.Fuel;
      sum += p.Fuel;
      n++;
    }
    if (n === 0) return null;
    const avg = sum / n;
    const pad = Math.max(1, (max - min) * 0.15);
    return { min, avg, max, domain: [Math.floor(min - pad), Math.ceil(max + pad)] as [number, number] };
  }, [telemetry]);

  return (
    <div className="flex gap-4 p-2">
      {models.map(({ metric, model }) => (
        <div key={metric.key} className="flex-1 min-w-0">
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
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-app-text-muted">Fuel</span>
          <span className="text-[9px] text-app-text-dim">L</span>
        </div>
        {fuel ? <FuelCell min={fuel.min} avg={fuel.avg} max={fuel.max} domain={fuel.domain} /> : <div className="h-[64px] flex items-center justify-center text-[10px] text-app-text-dim">—</div>}
      </div>
    </div>
  );
}

/** Single fuel bar mirroring one CornerBars cell (min→max fill, avg tick), so it
 * lines up with the tyre bars in the same row. */
function FuelCell({ min, avg, max, domain }: { min: number; avg: number; max: number; domain: [number, number] }) {
  const [lo, hi] = domain;
  const span = hi - lo || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));
  const color = "#22d3ee";
  return (
    <div className="flex items-end justify-between gap-1">
      <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
        <div className="relative w-full max-w-[15px] rounded bg-app-panel border border-app-border" style={{ height: 64 }}>
          <div className="absolute left-0 right-0 rounded opacity-30" style={{ background: color, bottom: `${pct(min)}%`, top: `${100 - pct(max)}%` }} />
          <div className="absolute left-[-2px] right-[-2px] h-[2px]" style={{ background: color, bottom: `${pct(avg)}%` }} />
        </div>
        <span className="text-[10px] font-mono tabular-nums" style={{ color }}>
          {Math.round(avg)}
        </span>
        <span className="text-[9px] text-app-text-dim uppercase">L</span>
      </div>
    </div>
  );
}
