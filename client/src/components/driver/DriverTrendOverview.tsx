import { Button } from "@/components/ui/button";
import type { DriverTrend, DriverTrendLap, DriverTrendWindow, TrendDirection } from "../../../../server/ai/driver-profile-aggregate";
import type { DriverProfileSummary } from "../../../../server/ai/schemas";
import type { DriverProfileState } from "../../hooks/queries";

interface DriverTrendOverviewProps {
  trend: DriverTrend;
  summary?: DriverProfileSummary | null;
  runState?: DriverProfileState;
  onRefresh?: () => void;
  runPending?: boolean;
}

function directionTone(direction: TrendDirection): string {
  if (direction === "improving") return "text-dynamics-green";
  if (direction === "declining") return "text-dynamics-red";
  if (direction === "steady") return "text-dynamics-yellow";
  return "text-app-text-dim";
}
function signed(value: number | null, digits = 1, suffix = ""): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}${suffix}`;
}

function percent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "Unavailable" : `${(value * 100).toFixed(0)}%`;
}

function paceMovement(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Unavailable";
  return `${Math.abs(value).toFixed(1)}% ${value < 0 ? "faster" : value > 0 ? "slower" : "unchanged"}`;
}

function lapLabel(lap: DriverTrendLap, position: number, total: number): string {
  const date = new Date(lap.createdAt);
  const when = Number.isNaN(date.valueOf()) ? lap.createdAt : date.toLocaleString();
  const pace = lap.relativePacePct !== null && Number.isFinite(lap.relativePacePct) ? `${lap.relativePacePct.toFixed(1)}% from benchmark` : "pace unavailable";
  return `lap ${position} of ${total}, ${when}, ${lap.isValid ? "valid" : "dirty"}, ${pace}`;
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
      <svg className="h-28 w-full" viewBox="0 0 580 112" preserveAspectRatio="none" role="img" aria-label="Previous and latest normalized pace trend">
        {[28, 56, 84].map((y) => (
          <line key={y} x1="0" y1={y} x2="580" y2={y} stroke="var(--color-app-border)" strokeWidth="1" />
        ))}
        {linePoints(previous) && <polyline points={linePoints(previous)} fill="none" stroke="var(--color-app-text-dim)" strokeWidth="2" strokeDasharray="5 5" />}
        {linePoints(recent) && <polyline points={linePoints(recent)} fill="none" stroke="var(--color-app-accent)" strokeWidth="2.5" />}
      </svg>
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-app-text-muted">
        <span>
          <i className="mr-1 inline-block size-2 rounded-full bg-app-text-dim" />
          previous {previous.total}
        </span>
        <span>
          <i className="mr-1 inline-block size-2 rounded-full bg-app-accent" />
          latest {recent.total}
        </span>
        <span>context-normalized</span>
      </div>
    </div>
  );
}

function movementText(kind: "pace" | "consistency" | "validity", direction: TrendDirection): string {
  if (direction === "unavailable") return "awaiting comparable laps";
  if (kind === "pace") return direction === "improving" ? "improving across contexts" : direction === "declining" ? "slower across contexts" : "holding across contexts";
  if (kind === "consistency") return direction === "improving" ? "improving with pace" : direction === "declining" ? "less repeatable" : "holding steady";
  return direction === "declining" ? "more dirty laps" : direction === "improving" ? "fewer dirty laps" : "holding steady";
}

function MovementRow({ label, direction, kind }: { label: string; direction: TrendDirection; kind: "pace" | "consistency" | "validity" }) {
  return (
    <div className="flex items-center gap-2 border-t border-app-border py-2.5 first:border-t-0">
      <i className={`size-1.5 shrink-0 rounded-full ${kind === "validity" ? "bg-dynamics-yellow" : "bg-app-accent"}`} />
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
            Latest {window.total} laps
          </h2>
          <p className="text-xs text-app-text-muted">Each bar = relative pace. Red × = dirty and still counted.</p>
        </div>
        <span className="text-xs text-app-text-muted">Oldest → newest</span>
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
              className={`relative min-w-0 flex-1 rounded-t-sm ${pace === null ? "border border-dashed border-app-text-dim" : lap.isValid ? "bg-app-accent" : "bg-dynamics-red"}`}
              style={{ height: `${height}%`, minWidth: "4px" }}
              aria-label={lapLabel(lap, index + 1, laps.length)}
            >
              {!lap.isValid && <b className="absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] text-dynamics-red">×</b>}
            </span>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-app-text-muted">
        <span>
          <i className="mr-1 inline-block size-2 rounded-sm bg-app-accent" />
          completed
        </span>
        <span>
          <i className="mr-1 inline-block size-2 rounded-sm bg-dynamics-red" />
          dirty
        </span>
        <span>
          <i className="mr-1 inline-block size-2 rounded-sm bg-dynamics-green" />
          best relative pace
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
      ? "Queued"
      : runState === "running"
        ? "Running"
        : runState === "failed"
          ? "Failed"
          : runState === "succeeded"
            ? "Current"
            : runState === "not-configured"
              ? "Provider not configured"
              : "Current";
  return (
    <>
      <div className="grid gap-3 lg:grid-cols-[1.15fr_1fr]">
        <article className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-app-text-muted">
            Latest {recent.total} laps vs previous {previous.total} · dirty laps count
          </div>
          <div className="mt-2 flex items-end justify-between gap-3">
            <div className="text-3xl font-bold tabular-nums text-app-text">
              {recent.consistency === null ? "—" : recent.consistency.toFixed(0)} <small className="text-xs font-normal text-app-text-muted">consistency</small>
            </div>
            <b className={`text-sm ${directionTone(trend.consistencyDirection)}`}>
              {signed(trend.consistencyDelta, 0)} {trend.consistencyDirection === "improving" ? "↑" : trend.consistencyDirection === "declining" ? "↓" : ""}
            </b>
          </div>
          <SummaryChart previous={previous} recent={recent} />
        </article>
        <article className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-app-text-muted">General movement</div>
          <div className="mt-2 grid gap-1.5 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
            <div className="rounded-lg border border-app-border bg-app-surface-alt/40 p-2">
              <span className="block text-[10px] text-app-text-muted">Relative pace</span>
              <b className="text-sm text-dynamics-green">{paceMovement(trend.paceDeltaPct)}</b>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface-alt/40 p-2">
              <span className="block text-[10px] text-app-text-muted">Spread</span>
              <b className="text-sm text-dynamics-green">{signed(trend.spreadDeltaPct, 1, " pts")}</b>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface-alt/40 p-2">
              <span className="block text-[10px] text-app-text-muted">Clean rate</span>
              <b className="text-sm text-app-text">
                {recent.valid} / {recent.total}
              </b>
              <small className="block text-[10px] text-dynamics-yellow">{percent(trend.cleanRateDelta)}</small>
            </div>
          </div>
          <div className="mt-2">
            <MovementRow label="Pace" kind="pace" direction={trend.paceDirection} />
            <MovementRow label="Consistency" kind="consistency" direction={trend.consistencyDirection} />
            <MovementRow label="Validity" kind="validity" direction={validityDirection} />
          </div>
        </article>
      </div>
      <TrendBars window={recent} />
      <p className="mt-3 border-l-2 border-app-accent px-3 py-2 text-xs text-app-text-muted">
        Global normalization never averages raw times from different tracks. Each car + track is reduced to relative pace and consistency first; latest {recent.total} global results are then compared
        with preceding {previous.total}.
      </p>
      <div className="mt-3 grid gap-3 lg:grid-cols-1 xl:grid-cols-2">
        <article className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-app-text-muted">Immediate measured advice</div>
          <div className="mt-2 space-y-3">
            {trend.advice.map((item) => (
              <div key={item.id} className="flex gap-2">
                <i
                  className={`grid size-5 shrink-0 place-items-center rounded-full text-xs ${item.tone === "positive" ? "bg-dynamics-green/20 text-dynamics-green" : "bg-dynamics-yellow/20 text-dynamics-yellow"}`}
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
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-app-accent">AI-enriched summary</div>
          {summary ? (
            <>
              <h2 className="mt-2 text-base font-semibold text-app-text">{summary.headline}</h2>
              <p className="mt-2 text-sm leading-6 text-app-text">{summary.summary}</p>
            </>
          ) : (
            <>
              <h2 className="mt-2 text-base font-semibold text-app-text">{stateLabel}</h2>
              <p className="mt-2 text-sm text-app-text-muted">Deterministic trend is ready. Refresh AI summary when you want a concise explanation of its evidence.</p>
            </>
          )}
          <p className="mt-3 text-[11px] text-app-text-muted">AI may explain measured direction. It cannot add lap, corner, car, track, or session-specific advice.</p>
          {onRefresh && (
            <Button className="mt-3" type="button" variant="outline" onClick={onRefresh} disabled={runPending}>
              {runPending ? "Refreshing…" : "Refresh AI summary"}
            </Button>
          )}
        </article>
      </div>
    </>
  );
}
