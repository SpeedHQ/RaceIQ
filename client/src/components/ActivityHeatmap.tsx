import { EmptyStateOverlay } from "@/components/ui/empty-state-overlay";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import type { DashboardCalendarBucket } from "@raceiq/shared/racing/sessions/dashboard";

const CELL = 14;
const GAP = 5;
const DAYS = 7;
const LABEL_WIDTH = 44;

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

  const monthFormatter = new Intl.DateTimeFormat(locale, { month: "short" });
  const rangeFormatter = new Intl.DateTimeFormat(locale, { month: "long", day: "numeric", year: "numeric" });
  const monthDescription = `${rangeFormatter.format(cells.days[0].date)} – ${rangeFormatter.format(now)}`;
  const columnStep = CELL + GAP;
  const width = LABEL_WIDTH + cells.weeks * columnStep - GAP;
  const height = DAYS * (CELL + GAP) - GAP;

  return (
    <section className="w-full max-w-[406px] rounded-lg border border-app-border p-4" aria-label={`${m.heatmap_title()} — ${monthDescription}`} aria-busy={loading}>
      {showTitle && <h2 className="mb-4 text-app-heading font-semibold text-app-text">{m.heatmap_title()}</h2>}
      <div className="relative">
      <div className="overflow-x-auto">
      <div style={{ width }}>
        <div className="relative mb-2 h-4 text-app-compact text-app-text-secondary">
          {cells.days
            .filter(({ date }, index) => index === 0 || date.getDate() === 1)
            .map(({ date, key, week }) => (
              <span key={key} className="absolute" style={{ left: LABEL_WIDTH + week * columnStep }}>
                {monthFormatter.format(date)}
              </span>
            ))}
        </div>
        <div className="relative">
        <Skeleton loading={loading} shape="chart" className="h-[128px] w-full">
        <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="block max-w-none" role="img" aria-label={`${m.heatmap_title()} — ${monthDescription}`}>
          {dayLabels.map((label, weekday) => (
            <text key={label} x={0} y={weekday * (CELL + GAP) + CELL / 2} dominantBaseline="middle" className="fill-app-text-secondary text-app-caption">
              {label}
            </text>
          ))}
          {cells.days.map(({ date, key, seconds, week, weekday }) => {
            const level = intensity(seconds, max);
            return (
              // oxlint-disable-next-line a11y/noStaticElementInteractions: hover supplements the native SVG date tooltip
              <rect
                key={key}
                data-date={key}
                x={LABEL_WIDTH + week * columnStep}
                y={weekday * (CELL + GAP)}
                width={CELL}
                height={CELL}
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
