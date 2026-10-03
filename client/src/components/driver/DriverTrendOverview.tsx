import * as m from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import type { DriverProfileSummary } from "@raceiq/backend-core/ai/schemas";
import type { DriverTrend, DriverTrendLap, DriverTrendWindow, TrendDirection } from "@raceiq/backend-core/driver-profile/trend";
import type { DriverProfileState } from "../../hooks/driver-profile";
import { getLocale } from "@/paraglide/runtime";
import { parseUtcTimestamp } from "../../lib/utc-date";

interface DriverTrendOverviewProps {
  trend: DriverTrend;
  summary?: DriverProfileSummary | null;
  runState?: DriverProfileState;
  onRefresh?: () => void;
  runPending?: boolean;
}

function directionTone(direction: TrendDirection): string {
  if (direction === "improving") return "text-severity-nominal";
  if (direction === "declining") return "text-severity-critical";
  if (direction === "steady") return "text-severity-caution";
  return "text-app-text-dim";
}
function signed(value: number | null, digits = 1, suffix = ""): string {
  if (value === null || !Number.isFinite(value)) return m.driver_unavailable();
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? m.driver_unavailable() : `${(value * 100).toFixed(0)}%`;
}

function paceMovement(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return m.driver_unavailable();
  return `${Math.abs(value).toFixed(1)}% ${value < 0 ? m.driver_faster() : value > 0 ? m.driver_slower() : m.driver_unchanged()}`;
}

function lapLabel(lap: DriverTrendLap, position: number, total: number): string {
  const date = parseUtcTimestamp(lap.createdAt);
  const when = Number.isNaN(date.valueOf()) ? lap.createdAt : date.toLocaleString(getLocale());
  const pace = lap.relativePacePct !== null && Number.isFinite(lap.relativePacePct) ? m.driver_pace_from_benchmark({ pace: `${lap.relativePacePct.toFixed(1)}%` }) : m.driver_pace_unavailable();
  return m.driver_lap_aria_label({ position: String(position), total: String(total), when, validity: lap.isValid ? m.driver_valid() : m.driver_dirty(), pace });
}

function linePoints(window: DriverTrendWindow, width = 580, height = 112): string {
  const values = window.laps.map((lap) => lap.relativePacePct).filter((value): value is number => value !== null && Number.isFinite(value));
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.01);
  return window.laps
    .map((lap, index) => {
      if (lap.relativePacePct === null || !Number.isFinite(lap.relativePacePct)) return null;
      const x = (index / Math.max(window.laps.length - 1, 1)) * width;
      const y = 92 - ((max - lap.relativePacePct) / range) * 68;
      return `${x.toFixed(1)},${Math.max(12, Math.min(height - 8, y)).toFixed(1)}`;
    })
    .filter(Boolean)
    .join(" ");
}

function SummaryChart({ previous, recent }: { previous: DriverTrendWindow; recent: DriverTrendWindow }) {
  return (
    <div className="mt-4">
      <svg className="h-28 w-full" viewBox="0 0 580 112" preserveAspectRatio="none" role="img" aria-label={m.driver_pace_trend_aria_label()}>
        {[28, 56, 84].map((y) => (
          <line key={y} x1="0" y1={y} x2="580" y2={y} stroke="var(--app-border)" strokeWidth="1" />
        ))}
        {linePoints(previous) && <polyline points={linePoints(previous)} fill="none" stroke="var(--app-text-dim)" strokeWidth="2" strokeDasharray="5 5" />}
        {linePoints(recent) && <polyline points={linePoints(recent)} fill="none" stroke="var(--app-accent)" strokeWidth="2.5" />}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-app-caption text-app-text-muted">
        <span>
          <i className="mr-1 inline-block size-2 rounded-full bg-app-text-dim" />
          {m.driver_previous_count({ count: String(previous.total) })}
        </span>
        <span>
          <i className="mr-1 inline-block size-2 rounded-full bg-app-accent" />
          {m.driver_latest_count({ count: String(recent.total) })}
        </span>
        <span>{m.driver_context_normalized()}</span>
      </div>
    </div>
  );
}

function movementText(kind: "pace" | "consistency" | "validity", direction: TrendDirection): string {
  if (direction === "unavailable") return m.driver_awaiting_comparable_laps();
  if (kind === "pace") return direction === "improving" ? m.driver_improving_across_contexts() : direction === "declining" ? m.driver_slower_across_contexts() : m.driver_holding_across_contexts();
  if (kind === "consistency") return direction === "improving" ? m.driver_improving_with_pace() : direction === "declining" ? m.driver_less_repeatable() : m.driver_holding_steady();
  return direction === "declining" ? m.driver_more_dirty_laps() : direction === "improving" ? m.driver_fewer_dirty_laps() : m.driver_holding_steady();
}

function MovementRow({ label, direction, kind }: { label: string; direction: TrendDirection; kind: "pace" | "consistency" | "validity" }) {
  return (
    <div className="flex items-center gap-2 border-t border-app-border py-2.5 first:border-t-0">
      <i className={`size-1.5 shrink-0 rounded-full ${kind === "validity" ? "bg-severity-caution" : "bg-app-accent"}`} />
      <div className="min-w-0 flex-1">
        <b className="text-sm text-app-text">{label}</b>
        <div className="text-xs text-app-text-muted">{movementText(kind, direction)}</div>
      </div>
      <span className={`text-sm font-semibold ${directionTone(direction)}`}>{direction === "improving" ? "↑" : direction === "declining" ? "↓" : direction === "steady" ? "→" : "·"}</span>
    </div>
  );
}

function TrendBars({ window }: { window: DriverTrendWindow }) {
  const laps = window.laps.slice(-30);
  const values = laps.flatMap((lap) => (lap.relativePacePct !== null && Number.isFinite(lap.relativePacePct) ? [lap.relativePacePct] : []));
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const range = Math.max(max - min, 0.01);
  return (
    <section className="mt-3 rounded-xl border border-app-border bg-app-surface p-4" aria-labelledby="driver-trend-bars-title">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 id="driver-trend-bars-title" className="text-sm font-semibold text-app-text">
            {m.driver_latest_laps({ count: String(window.total) })}
          </h2>
          <p className="text-xs text-app-text-muted">{m.driver_trend_bar_explanation()}</p>
        </div>
        <span className="text-xs text-app-text-muted">{m.driver_oldest_to_newest()}</span>
      </div>
      <div className="mt-4 flex h-24 items-end gap-1 border-b border-app-border px-1">
        {laps.map((lap, index) => {
          const pace = lap.relativePacePct !== null && Number.isFinite(lap.relativePacePct) ? lap.relativePacePct : null;
          const height = pace === null ? 8 : 20 + ((max - pace) / range) * 68;
          return (
            <span
              key={lap.id}
              role="img"
              title={lapLabel(lap, index + 1, laps.length)}
              className={`relative min-w-0 flex-1 rounded-t-sm ${pace === null ? "border border-dashed border-app-text-dim" : lap.isValid ? "bg-app-accent" : "bg-status-danger"}`}
              style={{ height: `${height}%`, minWidth: "4px" }}
              aria-label={lapLabel(lap, index + 1, laps.length)}
            >
              {!lap.isValid && <b className="absolute -top-4 left-1/2 -translate-x-1/2 text-app-caption text-status-danger">×</b>}
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-app-caption text-app-text-muted">
        <span>
          <i className="mr-1 inline-block size-2 rounded-sm bg-app-accent" />
          {m.driver_completed()}
        </span>
        <span>
          <i className="mr-1 inline-block size-2 rounded-sm bg-status-danger" />
          {m.driver_dirty()}
        </span>
        <span>
          <i className="mr-1 inline-block size-2 rounded-sm bg-severity-nominal" />
          {m.driver_best_relative_pace()}
        </span>
      </div>
    </section>
  );
}

export function DriverTrendOverview({ trend, summary = null, runState, onRefresh, runPending = false }: DriverTrendOverviewProps) {
  const recent = trend.recent;
  const previous = trend.previous;
  const validityDirection = trend.validityDirection;
  const stateLabel =
    runState === "queued"
      ? m.driver_status_queued()
      : runState === "running"
        ? m.driver_status_running()
        : runState === "failed"
          ? m.driver_status_failed()
          : runState === "not-configured"
            ? m.driver_provider_not_configured()
            : m.driver_status_current();
  return (
    <>
      <div className="grid gap-3 @5xl/workspace:grid-cols-[1.15fr_1fr]">
        <article className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="text-app-caption font-medium uppercase tracking-app-label text-app-text-muted">
            {m.driver_recent_vs_previous_dirty_count({ recent: String(recent.total), previous: String(previous.total) })}
          </div>
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="text-3xl font-bold tabular-nums text-app-text">
              {recent.consistency === null ? "—" : recent.consistency.toFixed(0)} <small className="text-xs font-normal text-app-text-muted">{m.driver_consistency()}</small>
            </div>
            <b className={`text-sm ${directionTone(trend.consistencyDirection)}`}>
              {signed(trend.consistencyDelta, 0)} {trend.consistencyDirection === "improving" ? "↑" : trend.consistencyDirection === "declining" ? "↓" : ""}
            </b>
          </div>
          <SummaryChart previous={previous} recent={recent} />
        </article>
        <article className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="text-app-caption font-medium uppercase tracking-app-label text-app-text-muted">{m.driver_general_movement()}</div>
          <div className="mt-2 grid gap-1.5 @3xl/workspace:grid-cols-3 @5xl/workspace:grid-cols-1 @7xl/workspace:grid-cols-3">
            <div className="rounded-lg border border-app-border bg-app-surface-alt/40 p-2">
              <span className="block text-app-caption text-app-text-muted">{m.driver_relative_pace()}</span>
              <b className={`text-sm ${directionTone(trend.paceDirection)}`}>{paceMovement(trend.paceDeltaPct)}</b>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface-alt/40 p-2">
              <span className="block text-app-caption text-app-text-muted">{m.driver_spread()}</span>
              <b className={`text-sm ${directionTone(trend.consistencyDirection)}`}>{signed(trend.spreadDeltaPct, 1, " pts")}</b>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface-alt/40 p-2">
              <span className="block text-app-caption text-app-text-muted">{m.driver_clean_rate()}</span>
              <b className="text-sm text-app-text">
                {recent.valid} / {recent.total}
              </b>
              <small className={`block text-app-caption ${directionTone(validityDirection)}`}>{percent(trend.cleanRateDelta)}</small>
            </div>
          </div>
          <div className="mt-2">
            <MovementRow label={m.driver_pace()} kind="pace" direction={trend.paceDirection} />
            <MovementRow label={m.driver_consistency()} kind="consistency" direction={trend.consistencyDirection} />
            <MovementRow label={m.driver_validity()} kind="validity" direction={validityDirection} />
          </div>
        </article>
      </div>
      <TrendBars window={recent} />
      <p className="mt-3 border-l-2 border-app-accent px-3 py-2 text-xs text-app-text-muted">
        {m.driver_global_normalization_explanation({ recent: String(recent.total), previous: String(previous.total) })}
      </p>
      <div className="mt-3 grid gap-3 @5xl/workspace:grid-cols-1 @7xl/workspace:grid-cols-2">
        <article className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="text-app-caption font-medium uppercase tracking-app-label text-app-text-muted">{m.driver_immediate_measured_advice()}</div>
          <div className="mt-2 space-y-3">
            {trend.advice.map((item) => (
              <div key={item.id} className="flex gap-2">
                <i
                  className={`grid size-5 shrink-0 place-items-center rounded-full text-xs ${item.tone === "positive" ? "bg-severity-nominal/20 text-severity-nominal" : "bg-severity-caution/20 text-severity-caution"}`}
                >
                  {item.tone === "positive" ? "✓" : "!"}
                </i>
                <div>
                  <b className="text-sm text-app-text">{item.title}</b>
                  <span className="mt-0.5 block text-xs text-app-text-muted">{item.detail}</span>
                </div>
              </div>
            ))}
          </div>
        </article>
        <article className="rounded-xl border border-app-accent/50 bg-app-accent/5 p-4">
          <div className="text-app-caption font-medium uppercase tracking-app-label text-app-accent">{m.driver_ai_enriched_summary()}</div>
          {summary ? (
            <>
              <h2 className="mt-2 text-base font-semibold text-app-text">{summary.headline}</h2>
              <p className="mt-2 text-sm leading-6 text-app-text">{summary.summary}</p>
            </>
          ) : (
            <>
              <h2 className="mt-2 text-base font-semibold text-app-text">{stateLabel}</h2>
              <p className="mt-2 text-sm text-app-text-muted">{m.driver_deterministic_trend_ready()}</p>
            </>
          )}
          <p className="mt-3 text-app-compact text-app-text-muted">{m.driver_ai_explanation_limit()}</p>
          {onRefresh && (
            <Button className="mt-3" variant="outline" onClick={onRefresh} disabled={runPending}>
              {runPending ? m.driver_refreshing() : m.driver_refresh_ai_summary()}
            </Button>
          )}
        </article>
      </div>
    </>
  );
}
