import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta, SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { useMemo } from "react";
import { m } from "@/paraglide/messages";
import { buildDashboardInsights } from "./dashboard-insights";

export interface DashboardInsightsProps {
  laps: LapMeta[];
  sessions: SessionMeta[];
  gameId: GameId | null;
  sessionsLoading?: boolean;
  sessionsError?: boolean;
}

export function DashboardInsights({ laps, sessions, gameId, sessionsLoading = false, sessionsError = false }: DashboardInsightsProps) {
  const insights = useMemo(() => buildDashboardInsights(laps, sessions, gameId), [laps, sessions, gameId]);
  const placements = [
    { label: m.home_insights_podiums_first(), count: insights.podiums.first },
    { label: m.home_insights_podiums_second(), count: insights.podiums.second },
    { label: m.home_insights_podiums_third(), count: insights.podiums.third },
  ];

  return (
    <div className="grid grid-cols-1 gap-3 @min-[640px]/workspace:grid-cols-2">
      <section aria-labelledby="insights-clean-title" className="min-w-0 rounded-lg bg-app-surface-alt/30 p-3">
        <h2 id="insights-clean-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_clean_title()}</h2>
        {insights.clean.rate == null ? (
          <p className="mt-2 font-mono text-app-heading text-app-text-muted" title={m.home_insights_clean_empty()} aria-label={m.home_insights_clean_empty()}>—</p>
        ) : (
          <div className="mt-2">
            <div className="flex items-baseline justify-between gap-2">
              <p className="font-mono text-app-heading font-semibold tabular-nums text-app-text">{Math.round(insights.clean.rate * 100)}%</p>
              <p className="font-mono text-app-detail tabular-nums text-app-text-muted" title={m.home_insights_clean_rate()}><span className="sr-only">{m.home_insights_clean_rate()}: </span>{insights.clean.valid}/{insights.clean.total}</p>
            </div>
            <progress className="mt-2 block h-1 w-full accent-app-accent" value={insights.clean.rate * 100} max={100} aria-label={m.home_insights_clean_rate()} />
          </div>
        )}
      </section>

      <section aria-labelledby="insights-podiums-title" className="min-w-0 rounded-lg bg-app-surface-alt/30 p-3">
        <h2 id="insights-podiums-title" className="text-app-subtext font-semibold text-app-text">{m.home_insights_podiums_title()}</h2>
        {sessionsLoading ? (
          <p className="mt-2 text-app-detail text-app-text-muted" role="status">{m.home_insights_podiums_loading()}</p>
        ) : sessionsError ? (
          <p className="mt-2 text-app-detail text-status-danger" role="alert">{m.home_insights_podiums_error()}</p>
        ) : !insights.podiums.available ? (
          <p className="mt-2 text-app-detail text-app-text-muted">{m.home_insights_podiums_unavailable()}</p>
        ) : (
          <div className="mt-2">
            <p className="font-mono text-app-heading font-semibold tabular-nums text-app-text" aria-label={`${m.home_insights_podiums_title()}: ${insights.podiums.total}`}>{insights.podiums.total}</p>
            <p className="sr-only">{m.home_insights_podiums_description()}</p>
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-app-detail text-app-text-muted" aria-label={m.home_insights_podiums_description()}>
              {placements.map(({ label, count }) => (
                <li key={label} className="flex items-baseline gap-1">
                  <span>{label}</span>
                  <span className="font-mono tabular-nums text-app-text">{count}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
