import type { LapMeta } from "@shared/types";
import { useEffect, useMemo, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

const CELL = 11;
const GAP = 3;
const WEEKS = 53;
const DAYS = 7;

function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function intensity(v: number, max: number): number {
  if (v <= 0 || max <= 0) return 0;
  const pct = v / max;
  if (pct <= 0.25) return 1;
  if (pct <= 0.5) return 2;
  if (pct <= 0.75) return 3;
  return 4;
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return "0m";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

const activityFill = (level: number) => (level === 0 ? "var(--app-surface-alt)" : "var(--activity-fill)");
const activityOpacity = (level: number) => (level === 0 ? 1 : level / 4);

export function ActivityHeatmap({ laps, showTitle = true }: { laps: LapMeta[]; showTitle?: boolean }) {
  const [hover, setHover] = useState<{ date: string; seconds: number; x: number; y: number } | null>(null);

  // Localized weekday abbreviations for the Mon/Wed/Fri rows (Nov 2021 starts
  // on a Monday). Recomputed on locale remount.
  const dayLabels = useMemo(() => {
    const f = new Intl.DateTimeFormat(getLocale(), { weekday: "short" });
    const d = (n: number) => f.format(new Date(2021, 10, n));
    return ["", d(1), "", d(3), "", d(5), ""];
  }, []);

  const { cells, max, totalDays, totalSeconds, monthMarkers, longestStreak, bestDaySeconds, bestDayKey } = useMemo(() => {
    // Localized month abbreviation (Jan/Jän/…); re-evaluated on locale remount.
    const monthFmt = new Intl.DateTimeFormat(getLocale(), { month: "short" });
    const secs = new Map<string, number>();
    for (const lap of laps) {
      if (lap.lapTime <= 0) continue;
      const key = dayKey(new Date(lap.createdAt));
      secs.set(key, (secs.get(key) ?? 0) + lap.lapTime);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const endDow = today.getDay();
    const start = new Date(today);
    start.setDate(today.getDate() - ((WEEKS - 1) * 7 + endDow));

    const grid: { date: Date; key: string; seconds: number }[][] = [];
    const months: { week: number; label: string }[] = [];
    let lastMonth = -1;
    let maxSec = 0;
    let maxSecKey: string | null = null;
    let daysActive = 0;
    let totalSec = 0;
    let currentStreak = 0;
    let bestStreak = 0;

    for (let w = 0; w < WEEKS; w++) {
      const col: { date: Date; key: string; seconds: number }[] = [];
      for (let d = 0; d < DAYS; d++) {
        const date = new Date(start);
        date.setDate(start.getDate() + w * 7 + d);
        const key = dayKey(date);
        const seconds = secs.get(key) ?? 0;
        col.push({ date, key, seconds });
        if (date > today) continue;
        if (seconds > maxSec) {
          maxSec = seconds;
          maxSecKey = key;
        }
        if (seconds > 0) {
          daysActive++;
          totalSec += seconds;
          currentStreak++;
          if (currentStreak > bestStreak) bestStreak = currentStreak;
        } else {
          currentStreak = 0;
        }
        if (d === 0 && date.getMonth() !== lastMonth) {
          months.push({ week: w, label: monthFmt.format(date) });
          lastMonth = date.getMonth();
        }
      }
      grid.push(col);
    }

    return {
      cells: grid,
      max: maxSec,
      totalDays: daysActive,
      totalSeconds: totalSec,
      monthMarkers: months,
      longestStreak: bestStreak,
      bestDaySeconds: maxSec,
      bestDayKey: maxSecKey,
    };
  }, [laps]);

  const width = WEEKS * (CELL + GAP);
  const height = DAYS * (CELL + GAP);
  const todayKey = dayKey(new Date());
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
  }, [cells]);

  return (
    <div>
      {showTitle && (
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">{m.heatmap_title()}</h2>
          <div className="text-app-compact text-app-text-dim">
            {fmtDuration(totalSeconds)} · {totalDays} {m.heatmap_active_days()} · {m.heatmap_longest_streak()} {longestStreak} {m.heatmap_days_word()} · {m.heatmap_longest_day()}{" "}
            {fmtDuration(bestDaySeconds)}
          </div>
        </div>
      )}
      <div ref={scrollRef} className="rounded-lg p-4 overflow-x-auto relative">
        <div className="flex gap-2 w-max mx-auto">
          <div className="flex flex-col justify-between py-[14px] pr-1 text-app-micro text-app-text-dim leading-none select-none">
            {dayLabels.map((l, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static ordered weekday labels, never reordered
              <div key={i} style={{ height: CELL }}>
                {l}
              </div>
            ))}
          </div>
          <div>
            <div className="relative" style={{ height: 14, width }}>
              {monthMarkers.map((m) => (
                <div key={`${m.label}-${m.week}`} className="absolute text-app-micro text-app-text-dim uppercase tracking-wider" style={{ left: m.week * (CELL + GAP) }}>
                  {m.label}
                </div>
              ))}
            </div>
            <svg width={width} height={height} className="block">
              {cells.map((col, w) =>
                col.map(({ date, key, seconds }, d) => {
                  const future = date > new Date();
                  const lvl = intensity(seconds, max);
                  const isToday = key === todayKey;
                  const isBestDay = key === bestDayKey;
                  const stroke = isBestDay ? "var(--app-accent)" : isToday ? "var(--activity-fill)" : "var(--app-text)";
                  const strokeOpacity = isBestDay ? 1 : isToday ? 0.9 : 0.04;
                  const strokeWidth = isBestDay ? 1.5 : isToday ? 1 : 0.5;
                  return (
                    // biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip on decorative SVG cell; data available in legend/stats
                    <rect
                      key={key}
                      x={w * (CELL + GAP)}
                      y={d * (CELL + GAP)}
                      width={CELL}
                      height={CELL}
                      rx={2}
                      fill={future ? "transparent" : activityFill(lvl)}
                      fillOpacity={future ? 1 : activityOpacity(lvl)}
                      stroke={stroke}
                      strokeOpacity={strokeOpacity}
                      strokeWidth={strokeWidth}
                      onMouseEnter={(e) => {
                        if (future) return;
                        const rect = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                        setHover({
                          date: date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
                          seconds,
                          x: w * (CELL + GAP) + rect.left + CELL / 2,
                          y: d * (CELL + GAP) + rect.top,
                        });
                      }}
                      onMouseLeave={() => setHover(null)}
                    />
                  );
                }),
              )}
            </svg>
          </div>
        </div>
        <div className="sticky left-0 right-0 flex flex-wrap items-center justify-end gap-3 mt-2 px-1 text-app-caption text-app-text-dim">
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block rounded-sm"
              style={{
                width: CELL,
                height: CELL,
                background: activityFill(4),
                border: "1.5px solid var(--app-accent)",
              }}
            />
            {m.heatmap_longest_day()}
          </span>
          <div className="flex items-center gap-1.5">
            <span>{m.heatmap_less()}</span>
            {Array.from({ length: 5 }, (_, level) => (
              <span
                key={level}
                className="inline-block rounded-sm border border-app-text/5"
                style={{
                  width: CELL,
                  height: CELL,
                  background: activityFill(level),
                  opacity: activityOpacity(level),
                }}
              />
            ))}
            <span>{m.heatmap_more()}</span>
          </div>
        </div>
        {hover && (
          <div
            className="fixed z-50 pointer-events-none px-2 py-1 rounded bg-app-surface border border-app-border text-app-compact text-app-text shadow-lg"
            style={{ left: hover.x, top: hover.y - 8, transform: "translate(-50%, -100%)" }}
          >
            <div className="font-mono font-bold">{hover.seconds > 0 ? fmtDuration(hover.seconds) : m.heatmap_no_activity()}</div>
            <div className="text-app-text-dim">{hover.date}</div>
          </div>
        )}
      </div>
    </div>
  );
}
