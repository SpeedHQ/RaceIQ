import { useMemo } from "react";
import type { SemanticTuneSample } from "./semantic-tune";
import { buildLiveRanges, CornerBars, METRICS } from "./SectorRangeBreakdown";

/**
 * CurrentLapTireStrip — compact horizontal row of per-corner range bars,
 * with tighter spacing, for live dashboard's bottom strip. Live dashboard
 * replacement for sector-by-sector breakdown, which reviews completed lap
 * rather than what car is doing right now.
 */
export function CurrentLapTireStrip({ telemetry }: { telemetry: SemanticTuneSample[] }) {
  const models = useMemo(() => METRICS.map((metric) => ({ metric, model: buildLiveRanges(telemetry, metric) })), [telemetry]);

  // Fuel: min→avg→max over the trace, on a padded domain — same math/visual as a
  // single tyre corner bar so it aligns in the row.
  const fuel = useMemo(() => {
    const fuelUnit = telemetry.find((sample) => sample.fuel !== undefined)?.fuelUnit;
    const values = telemetry
      .map((sample) => (sample.fuel === undefined ? undefined : sample.fuelUnit === "fraction" ? sample.fuel * 100 : sample.fuel))
      .filter((value): value is number => value !== undefined && Number.isFinite(value));
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const pad = Math.max(fuelUnit === "litre" ? 1 : 5, (max - min) * 0.15);
    return {
      min,
      avg,
      max,
      domain: [Math.floor(min - pad), Math.ceil(max + pad)] as [number, number],
      unit: fuelUnit === "litre" ? "L" : "%",
    };
  }, [telemetry]);

  return (
    <div className="flex gap-4 p-2">
      {models.map(({ metric, model }) => (
        <div key={metric.key} className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between mb-1">
            <span className="text-app-caption font-semibold uppercase tracking-wider text-app-text-muted">{metric.label}</span>
            <span className="text-app-micro text-app-text-dim">{metric.unit}</span>
          </div>
          {model ? (
            <CornerBars ranges={model.ranges} domain={model.domain} metric={metric} height={64} />
          ) : (
            <div className="h-[64px] flex items-center justify-center text-app-caption text-app-text-dim">—</div>
          )}
        </div>
      ))}
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-app-caption font-semibold uppercase tracking-wider text-app-text-muted">Fuel</span>
          <span className="text-app-micro text-app-text-dim">{fuel?.unit ?? "—"}</span>
        </div>
        {fuel ? (
          <FuelCell min={fuel.min} avg={fuel.avg} max={fuel.max} domain={fuel.domain} unit={fuel.unit} />
        ) : (
          <div className="h-[64px] flex items-center justify-center text-app-caption text-app-text-dim">—</div>
        )}
      </div>
    </div>
  );
}

/** Single fuel bar mirroring one CornerBars cell (min→max fill, avg tick), so it
 * lines up with the tyre bars in the same row. */
function FuelCell({ min, avg, max, domain, unit }: { min: number; avg: number; max: number; domain: [number, number]; unit: string }) {
  const [lo, hi] = domain;
  const span = hi - lo || 1;
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - lo) / span) * 100));
  const color = "var(--app-accent)";
  return (
    <div className="flex items-end justify-between gap-1">
      <div className="flex flex-col items-center gap-1 flex-1 min-w-0">
        <div className="relative w-full max-w-[15px] rounded bg-app-progress-track border border-app-border" style={{ height: 64 }}>
          <div className="absolute left-0 right-0 rounded opacity-30" style={{ background: color, bottom: `${pct(min)}%`, top: `${100 - pct(max)}%` }} />
          <div className="absolute left-[-2px] right-[-2px] h-[2px]" style={{ background: color, bottom: `${pct(avg)}%` }} />
        </div>
        <span className="text-app-caption font-mono tabular-nums" style={{ color }}>
          {Math.round(avg)}
        </span>
        <span className="text-app-micro text-app-text-dim uppercase">{unit}</span>
      </div>
    </div>
  );
}
