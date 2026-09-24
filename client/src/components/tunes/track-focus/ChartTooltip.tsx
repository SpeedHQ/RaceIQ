export interface ChartTooltipRow {
  lapNumber: number;
  color: string;
  isPrimary?: boolean;
  isInvalid?: boolean;
  speedKmh?: number | null;
  throttlePct?: number | null;
  brakePct?: number | null;
  steerPct?: number | null;
  deltaS?: number | null;
}

export type TooltipDisplayMode = "per-lap" | "summary";

interface ChartTooltipProps {
  frac: number;
  cornerLabel?: string | null;
  rows: ChartTooltipRow[];
  displayMode?: TooltipDisplayMode;
}

export interface LapTooltipSample { id: number; label: string; value: number; }

export function orderedTooltipStats(samples: readonly { id: number; value: number }[], primaryId: number | null): Array<readonly [string, number | undefined]> {
  const sorted = samples.map(({ value }) => value).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
  const primary = samples.find(({ id }) => id === primaryId)?.value;
  const stats: Array<readonly [string, number | undefined]> = [["max", sorted.at(-1)], ["median", median], ["min", sorted[0]]];
  stats.splice(primary == null ? 1 : primary >= median ? 1 : 2, 0, ["primary", primary]);
  return stats;
}

export function LapTooltip({ samples, primaryId, mode, format }: { samples: readonly LapTooltipSample[]; primaryId: number | null; mode: TooltipDisplayMode; format: (value: number) => string }): React.ReactNode {
  if (mode === "per-lap") return <div className="space-y-0.5 font-mono tabular-nums">{[...samples].sort((a, b) => b.value - a.value).map((sample) => <div key={sample.id}><span className={sample.id === primaryId ? "text-app-accent" : "text-app-text-muted"}>{sample.label}</span>: {format(sample.value)}</div>)}</div>;
  const stats = orderedTooltipStats(samples, primaryId);
  return <div className="space-y-0.5 font-mono tabular-nums">{stats.map(([label, value]) => <div key={label} className={label === "primary" ? "text-app-accent" : "text-app-text-muted"}>{label}: <span className="text-app-text">{value == null ? "—" : format(value)}</span></div>)}</div>;
}

function rowValue(row: ChartTooltipRow): [string, number] | null {
  for (const [key, value] of [["speed", row.speedKmh], ["throttle", row.throttlePct], ["brake", row.brakePct], ["steer", row.steerPct], ["delta", row.deltaS]] as const) {
    if (value != null && Number.isFinite(value)) return [key, value];
  }
  return null;
}

function formatValue(kind: string, value: number): string {
  if (kind === "speed") return `${value.toFixed(0)}km/h`;
  if (kind === "delta") return `${value >= 0 ? "+" : ""}${value.toFixed(3)}s`;
  return `${value.toFixed(0)}%`;
}
export function ChartSpread({ values, format = (value: number) => value.toFixed(2) }: { values: readonly number[]; format?: (value: number) => string }) {
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return null;
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const deviation = Math.sqrt(finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length);
  return <div className="text-app-text-dim">spread: {format(min)}–{format(max)} · std dev: ±{format(deviation)}</div>;
}


export function ChartTooltip({ rows, displayMode = "per-lap" }: ChartTooltipProps) {
  const values = rows.map(rowValue).flatMap((metric) => metric ? [metric[1]] : []);
  const min = values.length ? Math.min(...values) : null;
  const max = values.length ? Math.max(...values) : null;
  const mean = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const deviation = mean == null ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  if (displayMode === "summary") {
    const entries = rows.flatMap((row) => { const metric = rowValue(row); return metric ? [{ row, kind: metric[0], value: metric[1] }] : []; });
    const primary = entries.find(({ row }) => row.isPrimary)?.value;
    const sorted = entries.map(({ value }) => value).sort((a, b) => a - b);
    if (sorted.length === 0) return null;
    const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
    const kind = entries.find(({ row }) => row.isPrimary)?.kind ?? entries[0].kind;
    const stats: Array<readonly [string, number]> = [["max", sorted.at(-1)!], ["median", median], ["min", sorted[0]]];
    stats.splice(primary == null ? 1 : primary >= median ? 1 : 2, 0, ["primary", primary!]);
    return <div className="font-mono tabular-nums space-y-0.5 min-w-[135px]">{stats.map(([label, value]) => <div key={label} className={label === "primary" ? "text-app-accent" : "text-app-text-muted"}>{label}: <span className="text-app-text">{formatValue(kind, value)}</span></div>)}</div>;
  }
  return <div className="font-mono tabular-nums space-y-1 min-w-[135px]">{min != null && max != null && <div className="text-app-text-dim">spread: {min.toFixed(2)}–{max.toFixed(2)} · std dev: ±{deviation?.toFixed(2)}</div>}{[...rows].sort((a, b) => (rowValue(b)?.[1] ?? Number.NEGATIVE_INFINITY) - (rowValue(a)?.[1] ?? Number.NEGATIVE_INFINITY)).map((r) => <div key={r.lapNumber} className="flex items-center gap-1.5 whitespace-nowrap"><span className={r.isPrimary ? "text-app-accent" : "text-app-text-muted"}>L{r.lapNumber}</span>{r.speedKmh != null && <span>{r.speedKmh.toFixed(0)}km/h</span>}{r.throttlePct != null && <span>{r.throttlePct.toFixed(0)}%T</span>}{r.brakePct != null && <span>{r.brakePct.toFixed(0)}%B</span>}{r.steerPct != null && <span>{r.steerPct.toFixed(0)}%S</span>}{r.deltaS != null && <span>{r.deltaS >= 0 ? "+" : ""}{r.deltaS.toFixed(3)}s</span>}</div>)}</div>;
}
