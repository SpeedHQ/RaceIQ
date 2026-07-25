export interface ChartTooltipRow {
  lapNumber: number;
  color: string;
  isBest?: boolean;
  isInvalid?: boolean;
  speedKmh?: number | null;
  throttlePct?: number | null;
  brakePct?: number | null;
  steerPct?: number | null;
  deltaS?: number | null;
}

interface ChartTooltipProps {
  /** Lap-distance fraction (0..1) currently hovered. */
  frac: number;
  /** Nearest corner label (e.g. "T4"), when the cursor is within the apex zone. */
  cornerLabel?: string | null;
  rows: ChartTooltipRow[];
}

/**
 * Shared hover tooltip content for the Track Focus right-side charts (input
 * lanes, consistency lanes, speed/delta lanes, tyre lanes). Callers position
 * it (see `Lane`'s absolute wrapper) — this only renders the content: lap
 * fraction + nearest corner header, then one color-swatched row per visible
 * lap with whichever fields it was given.
 */
export function ChartTooltip({ frac, cornerLabel, rows }: ChartTooltipProps) {
  return (
    <div className="font-mono tabular-nums space-y-1 min-w-[135px]">
      <div className="text-app-text-dim whitespace-nowrap">
        {cornerLabel ? `${cornerLabel} · ` : ""}
        {(frac * 100).toFixed(1)}% lap
      </div>
      {rows.map((r) => (
        <div key={r.lapNumber} className="flex items-center gap-1.5 whitespace-nowrap">
          <span className="w-2 h-2 rounded-full inline-block shrink-0" style={{ background: r.isInvalid ? "var(--color-dynamics-red, #ef4444)" : r.color }} />
          <span className={r.isBest ? "text-app-accent" : "text-app-text"}>
            L{r.lapNumber}
            {r.isBest ? "*" : ""}
          </span>
          {r.speedKmh != null && <span className="text-app-text-muted">{r.speedKmh.toFixed(0)}km/h</span>}
          {r.throttlePct != null && <span className="text-emerald-400">{r.throttlePct.toFixed(0)}%T</span>}
          {r.brakePct != null && <span className="text-red-400">{r.brakePct.toFixed(0)}%B</span>}
          {r.steerPct != null && <span className="text-cyan-400">{r.steerPct.toFixed(0)}%S</span>}
          {r.deltaS != null && (
            <span className={r.deltaS >= 0 ? "text-amber-400" : "text-emerald-400"}>
              {r.deltaS >= 0 ? "+" : ""}
              {r.deltaS.toFixed(3)}s
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
