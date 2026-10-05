import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import { useMemo } from "react";
import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import { formatDrivenTime } from "./Stats";
import { buildDashboardInsights } from "./dashboard-insights";

export interface DashboardInsightsProps {
  laps: LapMeta[];
  gameId: GameId | null;
  carNames: Record<string, string>;
  trackNames: Record<string, string>;
}

export function DashboardInsights({ laps, gameId, carNames, trackNames }: DashboardInsightsProps) {
  const insights = useMemo(() => buildDashboardInsights(laps, gameId), [laps, gameId]);
  const maxPractice = Math.max(1, ...insights.practice.days.map((day) => day.seconds));
  const pace = insights.pace;
  const carLabel = pace ? carNames[`${pace.latest.gameId}:${pace.latest.carOrdinal}`] || m.home_insights_unknown_car() : "";
  const trackLabel = pace ? trackNames[`${pace.latest.gameId}:${pace.latest.trackOrdinal}`] || m.home_insights_unknown_track() : "";

  return (
    <div className="grid grid-cols-1 gap-3 @3xl/workspace:grid-cols-3">
      <section aria-labelledby="insights-clean-title" className="min-w-0 rounded-lg bg-app-surface-alt/30 p-4">
        <h2 id="insights-clean-title" className="text-sm font-semibold text-app-text">{m.home_insights_clean_title()}</h2>
        {insights.clean.rate == null ? (
          <p className="mt-3 text-sm text-app-text-muted">{m.home_insights_clean_empty()}</p>
        ) : (
          <div className="mt-3">
            <p className="font-mono text-2xl font-bold tabular-nums text-app-text">{Math.round(insights.clean.rate * 100)}%</p>
            <p className="mt-1 text-sm text-app-text-muted">{m.home_insights_clean_rate()}: <span className="font-mono tabular-nums">{insights.clean.valid}/{insights.clean.total}</span></p>
            <progress className="mt-3 h-2 w-full accent-app-accent" value={insights.clean.rate * 100} max={100} aria-label={m.home_insights_clean_rate()} />
          </div>
        )}
      </section>

      <section aria-labelledby="insights-pace-title" className="min-w-0 rounded-lg bg-app-surface-alt/30 p-4">
        <h2 id="insights-pace-title" className="text-sm font-semibold text-app-text">{m.home_insights_pace_title()}</h2>
        {pace ? (
          <>
            <p className="mt-3 font-mono text-2xl font-bold tabular-nums text-app-text">{formatLapTime(pace.best)}</p>
            <p className="mt-1 text-xs text-app-text-muted">{m.home_insights_best_lap()}</p>
            {pace.delta == null ? (
              <p className="mt-1 text-sm text-app-text-muted">{m.home_insights_no_baseline()}</p>
            ) : (
              <p className={`mt-1 text-sm font-medium ${pace.delta < 0 ? "text-status-success" : pace.delta > 0 ? "text-status-danger" : "text-app-text-muted"}`}>
                {pace.delta < 0 ? m.home_insights_faster({ delta: Math.abs(pace.delta).toFixed(3) }) : pace.delta > 0 ? m.home_insights_slower({ delta: pace.delta.toFixed(3) }) : m.home_insights_same_pace()}
              </p>
            )}
            <p className="mt-3 truncate text-xs text-app-text-muted">{m.home_insights_pace_context({ game: pace.latest.gameId!, car: carLabel, track: trackLabel })}</p>
          </>
        ) : <p className="mt-3 text-sm text-app-text-muted">{m.home_insights_no_baseline()}</p>}
      </section>

      <section aria-labelledby="insights-practice-title" className="min-w-0 rounded-lg bg-app-surface-alt/30 p-4">
        <h2 id="insights-practice-title" className="text-sm font-semibold text-app-text">{m.home_insights_practice_title()}</h2>
        {insights.practice.totalSeconds === 0 ? (
          <p className="mt-3 text-sm text-app-text-muted">{m.home_insights_empty_practice()}</p>
        ) : (
          <>
            <div className="mt-3 flex items-end gap-1.5" role="list" aria-label={m.home_insights_practice_title()}>
              {insights.practice.days.map((day) => {
                const minutes = Math.round(day.seconds / 60);
                const date = new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" });
                return <div key={day.date} role="listitem" className="flex min-w-0 flex-1 flex-col items-center gap-1" title={m.home_insights_daily_activity({ date: day.date, minutes, laps: day.laps })}>
                  <span className="sr-only">{m.home_insights_daily_activity({ date: day.date, minutes, laps: day.laps })}</span>
                  <span aria-hidden="true" className="flex h-12 w-full items-end rounded-sm bg-app-surface">
                    <span className="w-full rounded-sm bg-app-accent" style={{ height: `${day.seconds === 0 ? 0 : Math.max(8, (day.seconds / maxPractice) * 100)}%` }} />
                  </span>
                  <span aria-hidden="true" className="text-app-caption text-app-text-muted">{date}</span>
                </div>;
              })}
            </div>
            <div className="mt-3 flex flex-wrap justify-between gap-x-3 gap-y-1 text-sm text-app-text-muted">
              <span>{m.home_insights_active_days({ count: insights.practice.activeDays })}</span>
              <span className="font-mono tabular-nums text-app-text">{formatDrivenTime(insights.practice.totalSeconds)}</span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
