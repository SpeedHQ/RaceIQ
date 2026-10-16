import { EmptyStateOverlay } from "@/components/ui/empty-state-overlay";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import type { DashboardCalendarBucket } from "@raceiq/shared/racing/sessions/dashboard";

const DAYS = 7;

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${month}-${day}`;
}

function intensity(seconds: number, max: number): number {
  if (seconds <= 0 || max <= 0) return 0;
  return Math.min(4, Math.ceil((seconds / max) * 4));
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return "0m";
  const h = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${s}s`;
  return `${s}s`;
}

export function ActivityHeatmap({ buckets, periodStart, showTitle = true, loading = false, error = false }: { buckets: DashboardCalendarBucket[]; periodStart: number; showTitle?: boolean; loading?: boolean; error?: boolean }) {
  const [now, setNow] = useState(() => new Date());
  const [hover, setHover] = useState<{ date: string; duration: string; x: number; y: number } | null>(null);
  const year = now.getFullYear();
  const month = now.getMonth();
  const todayKey = dayKey(now);
  const locale = getLocale();
  useEffect(() => {
    const current = new Date();
    const midnight = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1);
    const timer = window.setTimeout(() => setNow(new Date()), midnight.getTime() - current.getTime() + 100);
    return () => window.clearTimeout(timer);
  }, [todayKey]);
  const dayLabels = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(locale, { weekday: "short" });
    return Array.from({ length: DAYS }, (_, day) => formatter.format(new Date(2021, 10, day + 1)));
  }, [locale]);

  const { cells, max } = useMemo(() => {
    const today = new Date(`${todayKey}T00:00:00`);
    const firstDay = new Date(periodStart);
    firstDay.setHours(0, 0, 0, 0);
    const secondsByDay = new Map<string, number>();
    for (const bucket of buckets) {
      const seconds = bucket.drivenSeconds;
      const key = bucket.day;
      if (key < dayKey(firstDay) || key > todayKey) continue;
      secondsByDay.set(key, seconds);
    }
    const daysInRange = (Date.UTC(year, month, today.getDate()) - Date.UTC(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate())) / 86_400_000 + 1;
    const offset = (firstDay.getDay() + 6) % DAYS;
    const weeks = Math.ceil((offset + daysInRange) / DAYS);
    const grid: { date: Date; key: string; seconds: number; week: number; weekday: number }[] = [];
    let maxSeconds = 0;
    for (let day = 1; day <= daysInRange; day++) {
      const date = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() + day - 1);
      const key = dayKey(date);
      const seconds = secondsByDay.get(key) ?? 0;
      const index = offset + day - 1;
      grid.push({ date, key, seconds, week: Math.floor(index / DAYS), weekday: index % DAYS });
      maxSeconds = Math.max(maxSeconds, seconds);
    }
    return { cells: { days: grid, weeks }, max: maxSeconds };
  }, [buckets, year, month, todayKey, periodStart]);

  const rangeFormatter = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric" });
  const monthDescription = `${rangeFormatter.format(cells.days[0].date)} – ${rangeFormatter.format(now)}`;
  const columnStep = 52;
  const width = DAYS * columnStep;
  const height = 24 + cells.weeks * 38;
  const shortRange = cells.days.length <= 8;
  const singleDay = cells.days.length === 1;
  const months = useMemo(() => {
    const byMonth = new Map<string, { date: Date; key: string; seconds: number }>();
    for (const day of cells.days) {
      const key = day.key.slice(0, 7);
      const entry = byMonth.get(key);
      if (entry) entry.seconds += day.seconds;
      else byMonth.set(key, { date: day.date, key, seconds: day.seconds });
    }
    return [...byMonth.values()];
  }, [cells.days]);

  if (shortRange) {
    return (
      <section className="w-full min-w-0 rounded-lg border border-app-border p-4" aria-label={`${m.heatmap_title()} — ${monthDescription}`} aria-busy={loading}>
        {showTitle && <h2 className="mb-4 text-app-heading font-semibold text-app-text">{m.heatmap_title()}</h2>}
        {error ? (
          <p className="text-app-detail text-status-danger" role="alert">{m.home_insights_analytics_error()}</p>
        ) : (
          <Skeleton loading={loading} shape="chart" className="w-full">
            {singleDay ? (
              <div className="flex min-h-16 items-center justify-between gap-4">
                <time dateTime={todayKey} className="text-app-detail text-app-text-secondary">
                  {now.toLocaleDateString(locale, { weekday: "long", month: "short", day: "numeric" })}
                </time>
                <span className="font-mono text-app-heading tabular-nums text-app-text">
                  {max > 0 ? fmtDuration(max) : m.heatmap_no_activity()}
                </span>
              </div>
            ) : (
              <>
                <ul className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${cells.days.length}, minmax(0, 1fr))` }}>
                  {cells.days.map(({ date, key, seconds }) => (
                    <li key={key} data-date={key} className="min-w-0 text-center" aria-label={`${rangeFormatter.format(date)}: ${seconds > 0 ? fmtDuration(seconds) : m.heatmap_no_activity()}`}>
                      <div className="flex h-28 flex-col justify-end gap-1">
                        <span className="font-mono text-app-caption tabular-nums text-app-text-secondary" aria-hidden="true">{fmtDuration(seconds)}</span>
                        <div
                          className="mx-auto w-full max-w-6 rounded-t-sm bg-app-accent"
                          style={{ height: seconds > 0 ? `${Math.max(2, (seconds / max) * 80)}px` : 0 }}
                        />
                      </div>
                      <div className={`border-t pt-2 text-app-compact ${key === todayKey ? "border-app-accent text-app-text" : "border-app-border text-app-text-secondary"}`} aria-hidden="true">
                        <div>{dayLabels[(date.getDay() + 6) % DAYS]}</div>
                        <div className="tabular-nums text-app-text-secondary">{date.getDate()}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                {max <= 0 && <p className="mt-3 text-app-compact text-app-text-secondary">{m.heatmap_no_activity()}</p>}
              </>
            )}
          </Skeleton>
        )}
      </section>
    );
  }

  if (cells.days.length > 31) {
    const maxMonth = Math.max(...months.map(({ seconds }) => seconds));
    return (
      <section className="w-full min-w-0 rounded-lg border border-app-border p-4" aria-label={`${m.heatmap_title()} — ${monthDescription}`} aria-busy={loading}>
        {showTitle && <h2 className="mb-4 text-app-heading font-semibold text-app-text">{m.heatmap_title()}</h2>}
        <p className="mb-3 text-app-compact text-app-text-secondary">{monthDescription}</p>
        {error ? (
          <p className="text-app-detail text-status-danger" role="alert">{m.home_insights_analytics_error()}</p>
        ) : (
          <Skeleton loading={loading} shape="chart" className="w-full">
            <ul className="grid grid-cols-3 gap-2">
              {months.map(({ date, key, seconds }) => {
                const level = intensity(seconds, maxMonth);
                const label = date.toLocaleDateString(locale, { month: "long", year: "numeric" });
                return (
                  <li
                    key={key}
                    data-month={key}
                    aria-label={`${label}: ${seconds > 0 ? fmtDuration(seconds) : m.heatmap_no_activity()}`}
                    className={`relative min-w-0 overflow-hidden rounded border p-2 ${key === todayKey.slice(0, 7) ? "border-app-accent" : "border-app-border"}`}
                  >
                    <span aria-hidden="true" className="absolute inset-0" style={{ background: level === 0 ? "var(--app-surface-alt)" : "var(--app-accent)", opacity: level === 0 ? 1 : level / 4 }} />
                    <div className={`relative ${level >= 3 ? "text-app-on-filled" : "text-app-text"}`}>
                      <div className="text-app-compact">{date.toLocaleDateString(locale, { month: "short", year: "2-digit" })}</div>
                      <div className="mt-1 font-mono text-app-detail tabular-nums">{fmtDuration(seconds)}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
            {maxMonth <= 0 && <p className="mt-3 text-app-compact text-app-text-secondary">{m.heatmap_no_activity()}</p>}
          </Skeleton>
        )}
      </section>
    );
  }

  return (
    <section className="w-full min-w-0 rounded-lg border border-app-border p-4" aria-label={`${m.heatmap_title()} — ${monthDescription}`} aria-busy={loading}>
      {showTitle && <h2 className="mb-4 text-app-heading font-semibold text-app-text">{m.heatmap_title()}</h2>}
      <div className="relative">
      <div className="overflow-x-auto">
      <div className="w-full">
        <div className="mb-2 text-app-compact text-app-text-secondary">
          {cells.days[0].date.toLocaleDateString(locale, { month: "short", day: "numeric" })} – {now.toLocaleDateString(locale, { month: "short", day: "numeric" })}
        </div>
        <div className="relative">
        <Skeleton loading={loading} shape="chart" className="w-full">
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" className="block w-full" role="img" aria-label={`${m.heatmap_title()} — ${monthDescription}`}>
          {dayLabels.map((label, weekday) => (
            <text key={label} x={weekday * columnStep + columnStep / 2} y={7} textAnchor="middle" dominantBaseline="middle" className="fill-app-text-secondary text-app-caption">
              {label}
            </text>
          ))}
          {cells.days.map(({ date, key, seconds, week, weekday }) => {
            const level = intensity(seconds, max);
            return (
              <g key={key}>
              {/* oxlint-disable-next-line a11y/noStaticElementInteractions: hover supplements the native SVG date tooltip */}
              <rect
                data-date={key}
                x={weekday * columnStep + 4}
                y={24 + week * 38}
                width={44}
                height={32}
                rx={2}
                fill={level === 0 ? "var(--app-surface-alt)" : "var(--app-accent)"}
                fillOpacity={level === 0 ? 1 : level / 4}
                stroke={key === todayKey ? "var(--app-accent)" : "var(--app-border)"}
                strokeWidth={0.5}
                onMouseEnter={(event) => {
                  const bounds = event.currentTarget.getBoundingClientRect();
                  setHover({
                    date: date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
                    duration: seconds > 0 ? fmtDuration(seconds) : m.heatmap_no_activity(),
                    x: bounds.left + bounds.width / 2,
                    y: bounds.top,
                  });
                }}
                onMouseLeave={() => setHover(null)}
              >
                <title>
                  {date.toLocaleDateString(locale, { weekday: "long", month: "short", day: "numeric", year: "numeric" })}: {seconds > 0 ? fmtDuration(seconds) : m.heatmap_no_activity()}
                </title>
              </rect>
                <text
                  x={weekday * columnStep + columnStep / 2}
                  y={40 + week * 38}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  className={`pointer-events-none text-app-compact tabular-nums ${level >= 3 ? "fill-app-on-filled" : "fill-app-text"}`}
                  aria-hidden="true"
                >
                  {date.getDate()}
                </text>
              </g>
            );
          })}
        </svg>
        </Skeleton>
        </div>
      </div>

      </div>
      {error ? <p className="absolute inset-0 grid place-items-center bg-app-surface/90 px-3 text-center text-app-detail text-status-danger" role="alert">{m.home_insights_analytics_error()}</p> : max <= 0 && !loading ? <EmptyStateOverlay className="top-6" /> : null}
      </div>
      <div className="mt-3 flex items-center justify-end gap-1.5 text-app-caption text-app-text-secondary" aria-hidden="true">
        <span>{m.heatmap_less()}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span
            key={level}
            className="inline-block h-3 w-3 rounded-[2px] border border-app-border"
            style={{ background: level === 0 ? "var(--app-surface-alt)" : "var(--app-accent)", opacity: level === 0 ? 1 : level / 4 }}
          />
        ))}
        <span>{m.heatmap_more()}</span>
      </div>
      {hover && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 rounded border border-app-border bg-app-surface px-2 py-1 text-app-compact text-app-text"
          style={{ left: hover.x, top: hover.y - 8, transform: "translate(-50%, -100%)" }}
        >
          <div>{hover.date}</div>
          <div className="text-app-text-secondary">{hover.duration}</div>
        </div>
      )}
    </section>
  );
}
