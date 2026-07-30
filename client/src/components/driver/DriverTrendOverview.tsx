import type { DriverProfileState, DriverProfileRun } from "../../hooks/queries";
import type { DriverProfileSummary } from "../../../../server/ai/schemas";
import type { DriverTrend, TrendDirection, DriverTrendLap, DriverTrendWindow } from "../../../../server/ai/driver-profile-aggregate";
import { Button } from "@/components/ui/button";

interface DriverTrendOverviewProps {
  trend: DriverTrend;
  summary?: DriverProfileSummary | null;
  runState?: DriverProfileState;
  latestRun?: DriverProfileRun | null;
  onRefresh?: () => void;
  runPending?: boolean;
}

function signed(value: number | null, digits = 1, suffix = ""): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "Unavailable" : `${(value * 100).toFixed(0)}%`;
}

function directionLabel(direction: TrendDirection): string {
  return direction === "unavailable" ? "Unavailable" : direction[0].toUpperCase() + direction.slice(1);
}

function directionTone(direction: TrendDirection): string {
  if (direction === "improving") return "text-dynamics-green";
  if (direction === "declining") return "text-dynamics-red";
  if (direction === "steady") return "text-dynamics-yellow";
  return "text-app-text-dim";
}

function metricTone(value: number | null, lowerIsBetter = false): string {
  if (value === null) return "text-app-text-dim";
  const positive = lowerIsBetter ? value < 0 : value > 0;
  const negative = lowerIsBetter ? value > 0 : value < 0;
  return positive ? "text-dynamics-green" : negative ? "text-dynamics-red" : "text-app-text";
}

function metricCard(label: string, value: string, detail: string, tone = "text-app-text") {
  return (
    <div className="min-w-0 rounded-md bg-app-surface-alt/60 p-3">
      <dt className="text-[11px] font-medium uppercase tracking-wide text-app-text-muted">{label}</dt>
      <dd className={`mt-1 text-lg font-semibold tabular-nums ${tone}`}>{value}</dd>
      <dd className="mt-0.5 text-xs text-app-text-muted">{detail}</dd>
    </div>
  );
}

function lapLabel(lap: DriverTrendLap, position: number, total: number): string {
  const date = new Date(lap.createdAt);
  const when = Number.isNaN(date.valueOf()) ? lap.createdAt : date.toLocaleString();
  const pace = lap.relativePacePct !== null && Number.isFinite(lap.relativePacePct) ? `${lap.relativePacePct.toFixed(1)}% from benchmark` : "pace unavailable";
  return `lap ${position} of ${total}, id ${lap.id}, ${when}, ${lap.isValid ? "valid" : "dirty"}, ${pace}`;
}

function TrendBars({ window }: { window: DriverTrendWindow }) {
  const laps = window.laps.slice(-30);
  const values = laps.flatMap((lap) => (lap.relativePacePct !== null && Number.isFinite(lap.relativePacePct) ? [lap.relativePacePct] : []));
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const range = max - min;
  const chartHeight = 128;
  const baseline = 148;
  const slot = 600 / Math.max(laps.length, 1);

  return (
    <figure className="mt-4 min-w-0" aria-labelledby="driver-trend-chart-title">
      <figcaption id="driver-trend-chart-title" className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-app-text-muted">
        <span>Recent laps, oldest → newest</span>
        <span className="flex flex-wrap gap-x-3 gap-y-1" aria-label="Chart legend">
          <span><i className="mr-1 inline-block size-2 rounded-sm bg-app-accent" />valid</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm bg-dynamics-red" />dirty</span>
          <span><i className="mr-1 inline-block size-2 rounded-sm border border-app-text-dim" />unavailable</span>
        </span>
      </figcaption>
      <div className="w-full min-w-0 overflow-hidden rounded-md bg-app-surface-alt/40 p-2">
        <svg className="block h-40 w-full" viewBox="0 0 600 180" preserveAspectRatio="none" role="img" aria-labelledby="driver-trend-chart-title driver-trend-chart-desc">
          <desc id="driver-trend-chart-desc">Bars show normalized pace relative to each lap context benchmark. Lower relative pace is taller; dirty laps use red bars; laps without comparable pace data use outlined markers.</desc>
          <line x1="0" y1={baseline} x2="600" y2={baseline} stroke="var(--color-app-border)" strokeWidth="1" />
          {laps.map((lap, index) => {
            const x = index * slot + slot * 0.16;
            const width = Math.max(2, slot * 0.68);
            const pace = lap.relativePacePct !== null && Number.isFinite(lap.relativePacePct) ? lap.relativePacePct : null;
            const height = pace === null ? 0 : range <= 0.01 ? chartHeight * 0.5 : Math.max(3, ((max - pace) / range) * chartHeight);
            const y = baseline - height;
            const fill = lap.isValid ? "var(--color-app-accent)" : "var(--color-dynamics-red)";
            return (
              <g key={`${lap.id}-${index}`}>
                <title>{lapLabel(lap, index + 1, laps.length)}</title>
                {pace === null ? (
                  <g stroke="var(--color-app-text-dim)" strokeWidth="2" opacity="0.9">
                    <line x1={x + width * 0.25} y1={baseline - 8} x2={x + width * 0.75} y2={baseline - 2} />
                    <line x1={x + width * 0.75} y1={baseline - 8} x2={x + width * 0.25} y2={baseline - 2} />
                  </g>
                ) : (
                  <rect x={x} y={y} width={width} height={height} rx="1" fill={fill} opacity={lap.isValid ? 0.85 : 0.95} />
                )}
                {!lap.isValid && <rect x={x} y={baseline + 3} width={width} height="3" rx="1" fill="var(--color-dynamics-red)" />}
              </g>
            );
          })}
        </svg>
      </div>
    </figure>
  );
}


export function DriverTrendOverview({ trend, summary = null, runState, latestRun, onRefresh, runPending = false }: DriverTrendOverviewProps) {
  const recent = trend.recent;
  const previous = trend.previous;
  const stateLabel = runState === "queued" ? "Queued" : runState === "running" ? "Running" : runState === "failed" ? "Failed" : runState === "succeeded" ? "Ready" : runState === "disabled" ? "Background disabled" : runState === "not-configured" ? "Provider not configured" : "Not run";

  return (
    <section className="min-w-0 rounded-lg bg-app-surface p-4 ring-1 ring-app-border" aria-labelledby="driver-trend-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-app-accent">Measured trend</p>
          <h2 id="driver-trend-heading" className="mt-1 text-base font-semibold text-app-text">{trend.advice[0]?.title ?? "Your recent driving trend"}</h2>
          <p className="mt-1 max-w-3xl text-sm text-app-text-muted">{trend.advice[0]?.detail ?? "Keep building comparable laps to make this trend more reliable."}</p>
        </div>
        <div className={`rounded-full bg-app-surface-alt px-2 py-1 text-xs font-medium ${directionTone(trend.paceDirection)}`}>
          Pace: {directionLabel(trend.paceDirection)}
        </div>
      </div>

      <dl className="mt-4 grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {metricCard("Consistency", recent.consistency === null ? "Unavailable" : `${recent.consistency.toFixed(0)} / 100`, `Previous ${previous.consistency === null ? "unavailable" : previous.consistency.toFixed(0)} · Δ ${signed(trend.consistencyDelta, 0)}`, metricTone(trend.consistencyDelta))}
        {metricCard("Normalized pace", recent.medianPacePct === null ? "Unavailable" : `${recent.medianPacePct.toFixed(1)}%`, `Median Δ ${signed(trend.paceDeltaPct, 1, "%")} · lower is faster`, metricTone(trend.paceDeltaPct, true))}
        {metricCard("Pace spread", recent.spreadPct === null ? "Unavailable" : `${recent.spreadPct.toFixed(1)}%`, `Median Δ ${signed(trend.spreadDeltaPct, 1, "%")} · lower is tighter`, metricTone(trend.spreadDeltaPct, true))}
        {metricCard("Clean laps", `${recent.valid} / ${recent.total}`, `Clean rate ${percent(recent.cleanRate)} · Δ ${percent(trend.cleanRateDelta)}`, metricTone(trend.cleanRateDelta))}
      </dl>
      <p className="mt-2 text-xs text-app-text-dim">Latest {recent.total} vs previous {previous.total} laps</p>

      <div className="mt-4 grid gap-2 sm:grid-cols-3" aria-label="Trend directions">
        {(["pace", "consistency", "validity"] as const).map((kind) => {
          const direction = kind === "pace" ? trend.paceDirection : kind === "consistency" ? trend.consistencyDirection : trend.validityDirection;
          return <div key={kind} className="rounded-md border border-app-border px-3 py-2 text-xs"><span className="text-app-text-muted">{kind[0].toUpperCase() + kind.slice(1)}</span><span className={`ml-2 font-semibold ${directionTone(direction)}`}>{directionLabel(direction)}</span></div>;
        })}
      </div>

      <TrendBars window={recent} />

      {trend.advice.length > 0 && (
        <div className="mt-4 border-t border-app-border pt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">Deterministic advice</h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {trend.advice.map((item) => (
              <li key={item.id} className="rounded-md bg-app-surface-alt/50 p-3 text-sm">
                <span className={`font-medium ${item.tone === "positive" ? "text-dynamics-green" : item.tone === "caution" ? "text-dynamics-yellow" : "text-app-text"}`}>{item.title}</span>
                <span className="mt-1 block text-xs text-app-text-muted">{item.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 border-t border-app-border pt-3" aria-live="polite">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-app-text-muted">AI summary</h3>
            <p className="mt-1 text-xs text-app-text-muted">{stateLabel}{latestRun?.completedAt ? ` · completed ${new Date(latestRun.completedAt).toLocaleString()}` : ""}</p>
          </div>
          {onRefresh && <Button type="button" variant="outline" onClick={onRefresh} disabled={runPending}>{runPending ? "Refreshing…" : "Refresh AI summary"}</Button>}
        </div>
        {summary ? (
          <div className="mt-3 rounded-md bg-app-surface-alt/50 p-3">
            <p className="text-sm font-medium text-app-text">{summary.headline}</p>
            <p className="mt-1 text-sm text-app-text-muted">{summary.summary}</p>
          </div>
        ) : (
          <p className="mt-3 text-sm text-app-text-muted">Deterministic trend is ready. Refresh AI summary when you want a concise explanation of its evidence.</p>
        )}
      </div>
    </section>
  );
}
